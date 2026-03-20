import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode } from "@aztec/aztec.js/node";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import pino from "pino";
import type { Hex } from "viem";

const pinoLogger = pino();

const DEFAULT_ACCOUNT_INDEX = 0;
const HEX_32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export interface AutoClaimRequest {
  recipient: AztecAddress;
  amount: bigint;
  claimSecret: string;
  messageLeafIndex: bigint;
  messageHash: Hex;
  waitTimeoutSeconds: number;
}

export interface TopupAutoClaimer {
  claimerAddress: AztecAddress;
  claimerSource: "secret_key" | "test_account";
  paymentMode: "sponsored" | "fee_juice";
  sponsoredFpcAddress: AztecAddress | null;
  claim: (request: AutoClaimRequest) => Promise<string>;
}

type ClaimFeeOptions = { paymentMethod: SponsoredFeePaymentMethod } | undefined;
type FeeJuiceInstance = ReturnType<typeof FeeJuiceContract.at>;

function isSponsoredProofFailure(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes("Invalid tx: Invalid proof") ||
    message.includes("Circuit execution failed") ||
    message.includes("Missing return value for index") ||
    message.includes("Cannot enter the revertible phase twice")
  );
}

function parseOptionalSecretKey(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }
  const withPrefix = normalized.startsWith("0x") ? normalized : `0x${normalized}`;
  if (!HEX_32_PATTERN.test(withPrefix)) {
    throw new Error("Invalid auto-claim secret key. Expected 32-byte 0x-prefixed hex");
  }
  return withPrefix;
}

export function resolveAutoClaimSecretKeyFromEnv(env: NodeJS.ProcessEnv): string | null {
  return parseOptionalSecretKey(env.TOPUP_AUTOCLAIM_SECRET_KEY);
}

function parseOptionalAztecAddress(value: string | undefined): AztecAddress | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }
  try {
    return AztecAddress.fromString(normalized);
  } catch {
    throw new Error(
      `Invalid sponsored FPC address: "${normalized}". Expected 32-byte 0x-prefixed Aztec address`,
    );
  }
}

export function resolveAutoClaimSponsoredFpcFromEnv(env: NodeJS.ProcessEnv): AztecAddress | null {
  return parseOptionalAztecAddress(env.TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS);
}

async function registerSponsoredFpcContract(
  wallet: EmbeddedWallet,
  node: AztecNode,
  sponsoredFpcAddress: AztecAddress,
): Promise<void> {
  const sponsoredFpcInstance = await node.getContract(sponsoredFpcAddress);
  if (!sponsoredFpcInstance) {
    throw new Error(
      `Sponsored FPC contract instance not found on node at ${sponsoredFpcAddress.toString()}`,
    );
  }

  await wallet.registerContract(sponsoredFpcInstance, SponsoredFPCContractArtifact);
}

async function assertPublishedClaimerAccount(
  node: AztecNode,
  claimerAddress: AztecAddress,
  claimerSource: "secret_key" | "test_account",
  runtimeProfile: string,
): Promise<void> {
  const publishedAccount = await node.getContract(claimerAddress);
  if (publishedAccount) {
    return;
  }

  const message = `Auto-claim claimer ${claimerAddress.toString()} (source=${claimerSource}) is not publicly deployed on the connected Aztec node. Configure TOPUP_AUTOCLAIM_SECRET_KEY to a publicly deployed account (or deploy this account first).`;

  if (runtimeProfile === "production") {
    throw new Error(message);
  }

  pinoLogger.warn(message);
}

async function sendClaim(
  feeJuice: FeeJuiceInstance,
  claimerAddress: AztecAddress,
  request: AutoClaimRequest,
  fee: ClaimFeeOptions,
): Promise<string> {
  const { receipt } = await feeJuice.methods
    .claim(
      request.recipient,
      request.amount,
      Fr.fromString(request.claimSecret),
      new Fr(request.messageLeafIndex),
    )
    .send({
      from: claimerAddress,
      fee,
      wait: { timeout: request.waitTimeoutSeconds },
    });
  return receipt.txHash.toString();
}

function maybeDisableSponsoredMode(
  sponsoredError: unknown,
  sponsoredFpcAddress: AztecAddress | null,
  disableSponsoredMode: () => void,
): void {
  if (!isSponsoredProofFailure(sponsoredError)) {
    return;
  }

  disableSponsoredMode();
  pinoLogger.warn(
    { err: sponsoredError },
    `Disabling sponsored auto-claim for this process due to proving/runtime failure (sponsor=${sponsoredFpcAddress?.toString()}). Falling back to claimer Fee Juice payment.`,
  );
}

async function claimWithSponsoredFallback(params: {
  feeJuice: FeeJuiceInstance;
  claimerAddress: AztecAddress;
  request: AutoClaimRequest;
  sponsoredPaymentMethod: SponsoredFeePaymentMethod | null;
  sponsoredModeDisabled: boolean;
  sponsoredFpcAddress: AztecAddress | null;
  disableSponsoredMode: () => void;
}): Promise<string> {
  if (!params.sponsoredPaymentMethod || params.sponsoredModeDisabled) {
    return sendClaim(params.feeJuice, params.claimerAddress, params.request, undefined);
  }

  try {
    return await sendClaim(params.feeJuice, params.claimerAddress, params.request, {
      paymentMethod: params.sponsoredPaymentMethod,
    });
  } catch (sponsoredError) {
    maybeDisableSponsoredMode(
      sponsoredError,
      params.sponsoredFpcAddress,
      params.disableSponsoredMode,
    );
    pinoLogger.warn(
      { sponsoredErrorDetails: String(sponsoredError) },
      `Sponsored auto-claim failed for message_hash=${params.request.messageHash}; retrying with claimer Fee Juice payment (sponsor=${params.sponsoredFpcAddress?.toString()})`,
    );
    return sendClaim(params.feeJuice, params.claimerAddress, params.request, undefined);
  }
}

function buildAutoClaimFailureMessage(params: {
  error: unknown;
  request: AutoClaimRequest;
  sponsoredPaymentMethod: SponsoredFeePaymentMethod | null;
  sponsoredFpcAddress: AztecAddress | null;
  claimerAddress: AztecAddress;
}): string {
  const errorDetails = String(params.error);
  const insufficientBalanceHint = errorDetails.includes("Insufficient fee payer balance")
    ? params.sponsoredPaymentMethod
      ? ` Hint: sponsored auto-claim is enabled via ${params.sponsoredFpcAddress?.toString()} but fee sponsorship failed or the sponsor is not funded.`
      : ` Hint: claimer ${params.claimerAddress.toString()} has insufficient L2 Fee Juice to pay tx fees. Set TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS (recommended) or pre-fund this claimer.`
    : "";
  return `Auto-claim failed for message_hash=${params.request.messageHash}.${insufficientBalanceHint}`;
}

export async function createTopupAutoClaimer(
  node: AztecNode,
  runtimeProfile?: string,
): Promise<TopupAutoClaimer> {
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxeConfig: { proverEnabled: true },
  });
  const explicitSecretKey = resolveAutoClaimSecretKeyFromEnv(process.env);
  const sponsoredFpcAddress = resolveAutoClaimSponsoredFpcFromEnv(process.env);
  if (sponsoredFpcAddress) {
    try {
      await registerSponsoredFpcContract(wallet, node, sponsoredFpcAddress);
    } catch (error) {
      throw new Error(
        `Failed to register sponsored FPC contract ${sponsoredFpcAddress.toString()} in PXE. Ensure TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS points to a SponsoredFPC contract on the connected network.`,
        { cause: error },
      );
    }
  }
  const sponsoredPaymentMethod = sponsoredFpcAddress
    ? new SponsoredFeePaymentMethod(sponsoredFpcAddress)
    : null;

  let claimerAddress: AztecAddress;
  let claimerSource: "secret_key" | "test_account";

  if (explicitSecretKey) {
    const secret = Fr.fromHexString(explicitSecretKey);
    const signingKey = deriveSigningKey(secret);
    const account = await wallet.createSchnorrAccount(secret, Fr.ZERO, signingKey);
    claimerAddress = account.address;
    claimerSource = "secret_key";
  } else {
    if (runtimeProfile === "production") {
      throw new Error(
        "Auto-claim test account fallback is not allowed when runtime_profile=production. " +
          "Set TOPUP_AUTOCLAIM_SECRET_KEY.",
      );
    }
    const testAccounts = await getInitialTestAccountsData();

    if (DEFAULT_ACCOUNT_INDEX >= testAccounts.length) {
      throw new Error(
        `No test accounts available (need index ${DEFAULT_ACCOUNT_INDEX}, have ${testAccounts.length})`,
      );
    }

    const account = testAccounts[DEFAULT_ACCOUNT_INDEX];
    const created = await wallet.createSchnorrAccount(
      account.secret,
      account.salt,
      account.signingKey,
    );
    claimerAddress = created.address;
    claimerSource = "test_account";
  }

  await assertPublishedClaimerAccount(
    node,
    claimerAddress,
    claimerSource,
    runtimeProfile ?? "development",
  );

  const feeJuice = FeeJuiceContract.at(wallet);
  let sponsoredModeDisabled = false;

  return {
    claimerAddress,
    claimerSource,
    paymentMode: sponsoredPaymentMethod ? "sponsored" : "fee_juice",
    sponsoredFpcAddress,
    async claim(request: AutoClaimRequest): Promise<string> {
      try {
        return await claimWithSponsoredFallback({
          feeJuice,
          claimerAddress,
          request,
          sponsoredPaymentMethod,
          sponsoredModeDisabled,
          sponsoredFpcAddress,
          disableSponsoredMode: () => {
            sponsoredModeDisabled = true;
          },
        });
      } catch (error) {
        throw new Error(
          buildAutoClaimFailureMessage({
            error,
            request,
            sponsoredPaymentMethod,
            sponsoredFpcAddress,
            claimerAddress,
          }),
          { cause: error },
        );
      }
    },
  };
}

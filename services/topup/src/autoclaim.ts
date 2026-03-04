import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode } from "@aztec/aztec.js/node";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { Hex } from "viem";

const DEFAULT_ACCOUNT_INDEX = 0;
const HEX_32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);

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
  const withPrefix = normalized.startsWith("0x")
    ? normalized
    : `0x${normalized}`;
  if (!HEX_32_PATTERN.test(withPrefix)) {
    throw new Error(
      "Invalid auto-claim secret key. Expected 32-byte 0x-prefixed hex",
    );
  }
  return withPrefix;
}

export function resolveAutoClaimSecretKeyFromEnv(
  env: NodeJS.ProcessEnv,
): string | null {
  const explicitSecretKey = parseOptionalSecretKey(
    env.TOPUP_AUTOCLAIM_SECRET_KEY,
  );
  if (explicitSecretKey) {
    return explicitSecretKey;
  }
  if (env.TOPUP_AUTOCLAIM_USE_OPERATOR_SECRET_KEY === "1") {
    return parseOptionalSecretKey(env.OPERATOR_SECRET_KEY);
  }
  return null;
}

export function resolveAutoClaimRequirePublishedAccountFromEnv(
  env: NodeJS.ProcessEnv,
): boolean {
  const rawValue = env.TOPUP_AUTOCLAIM_REQUIRE_PUBLISHED_ACCOUNT;
  if (rawValue === undefined) {
    return true;
  }
  const normalized = rawValue.trim().toLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  if (TRUE_ENV_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_ENV_VALUES.has(normalized)) {
    return false;
  }
  throw new Error(
    "Invalid TOPUP_AUTOCLAIM_REQUIRE_PUBLISHED_ACCOUNT. Expected one of: 1/0, true/false, yes/no, on/off",
  );
}

function parseOptionalAztecAddress(
  value: string | undefined,
): AztecAddress | null {
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

export function resolveAutoClaimSponsoredFpcFromEnv(
  env: NodeJS.ProcessEnv,
): AztecAddress | null {
  return (
    parseOptionalAztecAddress(env.TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS) ??
    parseOptionalAztecAddress(env.FPC_DEVNET_SPONSORED_FPC_ADDRESS) ??
    parseOptionalAztecAddress(env.SPONSORED_FPC_ADDRESS)
  );
}

function parseAccountIndex(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_ACCOUNT_INDEX;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      "Invalid TOPUP_AUTOCLAIM_TEST_ACCOUNT_INDEX. Expected integer >= 0",
    );
  }
  return parsed;
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

  await wallet.registerContract(
    sponsoredFpcInstance,
    SponsoredFPCContractArtifact,
  );
}

async function assertPublishedClaimerAccount(
  node: AztecNode,
  claimerAddress: AztecAddress,
  claimerSource: "secret_key" | "test_account",
): Promise<void> {
  const publishedAccount = await node.getContract(claimerAddress);
  if (publishedAccount) {
    return;
  }

  throw new Error(
    `Auto-claim claimer ${claimerAddress.toString()} (source=${claimerSource}) is not publicly deployed on the connected Aztec node. Configure TOPUP_AUTOCLAIM_SECRET_KEY to a publicly deployed account (or deploy this account first).`,
  );
}

export async function createTopupAutoClaimer(
  node: AztecNode,
): Promise<TopupAutoClaimer> {
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true });
  const explicitSecretKey = resolveAutoClaimSecretKeyFromEnv(process.env);
  const requirePublishedClaimer =
    resolveAutoClaimRequirePublishedAccountFromEnv(process.env);
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
    const account = await wallet.createSchnorrAccount(
      secret,
      Fr.ZERO,
      signingKey,
    );
    claimerAddress = account.address;
    claimerSource = "secret_key";
  } else {
    const testAccounts = await getInitialTestAccountsData();
    const accountIndex = parseAccountIndex(
      process.env.TOPUP_AUTOCLAIM_TEST_ACCOUNT_INDEX,
    );

    if (accountIndex >= testAccounts.length) {
      throw new Error(
        `TOPUP_AUTOCLAIM_TEST_ACCOUNT_INDEX out of range. Available test accounts=${testAccounts.length}`,
      );
    }

    const account = testAccounts[accountIndex];
    const created = await wallet.createSchnorrAccount(
      account.secret,
      account.salt,
      account.signingKey,
    );
    claimerAddress = created.address;
    claimerSource = "test_account";
  }

  if (requirePublishedClaimer) {
    await assertPublishedClaimerAccount(node, claimerAddress, claimerSource);
  }

  const feeJuice = FeeJuiceContract.at(wallet);
  let sponsoredModeDisabled = false;

  return {
    claimerAddress,
    claimerSource,
    paymentMode: sponsoredPaymentMethod ? "sponsored" : "fee_juice",
    sponsoredFpcAddress,
    async claim(request: AutoClaimRequest): Promise<string> {
      const sendClaim = async (
        fee:
          | {
              paymentMethod: SponsoredFeePaymentMethod;
            }
          | undefined,
      ) => {
        const receipt = await feeJuice.methods
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
      };

      try {
        if (!sponsoredPaymentMethod || sponsoredModeDisabled) {
          return await sendClaim(undefined);
        }

        try {
          return await sendClaim({ paymentMethod: sponsoredPaymentMethod });
        } catch (sponsoredError) {
          if (isSponsoredProofFailure(sponsoredError)) {
            sponsoredModeDisabled = true;
            console.warn(
              `Disabling sponsored auto-claim for this process due to proving/runtime failure (sponsor=${sponsoredFpcAddress?.toString()}). Falling back to claimer Fee Juice payment.`,
              String(sponsoredError),
            );
          }
          const sponsoredErrorDetails = String(sponsoredError);
          console.warn(
            `Sponsored auto-claim failed for message_hash=${request.messageHash}; retrying with claimer Fee Juice payment (sponsor=${sponsoredFpcAddress?.toString()})`,
            sponsoredErrorDetails,
          );
          return await sendClaim(undefined);
        }
      } catch (error) {
        const errorDetails = String(error);
        const insufficientBalanceHint = errorDetails.includes(
          "Insufficient fee payer balance",
        )
          ? sponsoredPaymentMethod
            ? ` Hint: sponsored auto-claim is enabled via ${sponsoredFpcAddress?.toString()} but fee sponsorship failed or the sponsor is not funded.`
            : ` Hint: claimer ${claimerAddress.toString()} has insufficient L2 Fee Juice to pay tx fees. Set TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS (recommended) or pre-fund this claimer.`
          : "";
        throw new Error(
          `Auto-claim failed for message_hash=${request.messageHash}.${insufficientBalanceHint}`,
          { cause: error },
        );
      }
    },
  };
}

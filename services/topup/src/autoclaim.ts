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
  return parseOptionalSecretKey(env.OPERATOR_SECRET_KEY);
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

export async function createTopupAutoClaimer(
  node: AztecNode,
): Promise<TopupAutoClaimer> {
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true });
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

  const feeJuice = FeeJuiceContract.at(wallet);

  return {
    claimerAddress,
    claimerSource,
    paymentMode: sponsoredPaymentMethod ? "sponsored" : "fee_juice",
    sponsoredFpcAddress,
    async claim(request: AutoClaimRequest): Promise<string> {
      try {
        const feeOption = sponsoredPaymentMethod
          ? { paymentMethod: sponsoredPaymentMethod }
          : undefined;
        const receipt = await feeJuice.methods
          .claim(
            request.recipient,
            request.amount,
            Fr.fromString(request.claimSecret),
            new Fr(request.messageLeafIndex),
          )
          .send({
            from: claimerAddress,
            fee: feeOption,
            wait: { timeout: request.waitTimeoutSeconds },
          });
        return receipt.txHash.toString();
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

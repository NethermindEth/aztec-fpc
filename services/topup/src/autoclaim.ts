import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode } from "@aztec/aztec.js/node";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
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

export async function createTopupAutoClaimer(
  node: AztecNode,
): Promise<TopupAutoClaimer> {
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true });
  const explicitSecretKey = resolveAutoClaimSecretKeyFromEnv(process.env);

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
    async claim(request: AutoClaimRequest): Promise<string> {
      try {
        const receipt = await feeJuice.methods
          .claim(
            request.recipient,
            request.amount,
            Fr.fromString(request.claimSecret),
            new Fr(request.messageLeafIndex),
          )
          .send({
            from: claimerAddress,
            wait: { timeout: request.waitTimeoutSeconds },
          });
        return receipt.txHash.toString();
      } catch (error) {
        throw new Error(
          `Auto-claim failed for message_hash=${request.messageHash}`,
          { cause: error },
        );
      }
    },
  };
}

import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode } from "@aztec/aztec.js/node";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { Hex } from "viem";

const DEFAULT_ACCOUNT_INDEX = 0;

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
  claim: (request: AutoClaimRequest) => Promise<string>;
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
  const claimerAddress = (
    await wallet.createSchnorrAccount(
      account.secret,
      account.salt,
      account.signingKey,
    )
  ).address;
  const feeJuice = FeeJuiceContract.at(wallet);

  return {
    claimerAddress,
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

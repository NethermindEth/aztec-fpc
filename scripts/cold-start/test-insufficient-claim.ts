/**
 * Negative test: claim < fee → rejected by attestation server.
 *
 * Bridges a tiny amount (aaPaymentAmount - 1), then verifies the cold-start
 * quote request is correctly rejected because claim_amount < aa_payment_amount.
 */

import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { FpcClient } from "@aztec-fpc/sdk";
import pino from "pino";
import { deriveAccount } from "../common/script-credentials.ts";
import type { TestContext } from "./setup.ts";

const pinoLogger = pino();

export async function testInsufficientClaim(ctx: TestContext): Promise<void> {
  const {
    args,
    node,
    operator,
    fpcAddress,
    tokenAddress,
    bridgeAddress,
    l1WalletClient,
    l1Erc20,
    portalManager,
  } = ctx;

  pinoLogger.info("[cold-start-smoke] running negative test: claim < fee");

  // Create a fresh user for this test
  const user = (await deriveAccount(Fr.random(), ctx.wallet)).address;

  const { aaPaymentAmount } = args;
  const tinyClaimAmount = aaPaymentAmount - 1n;

  // 1. Mint tiny amount and bridge L1→L2
  const l1Account = l1WalletClient.account;
  const tinyMintHash = await l1Erc20.write.mint([l1Account.address, tinyClaimAmount]);
  await l1WalletClient.waitForTransactionReceipt({ hash: tinyMintHash });

  const tinyClaim = await portalManager.bridgeTokensPrivate(user, tinyClaimAmount, false);
  const tinyMsgHash = Fr.fromHexString(tinyClaim.messageHash as string);
  await waitForL1ToL2MessageReady(node, tinyMsgHash, {
    timeoutSeconds: args.messageTimeoutSeconds,
    forPublicConsumption: false,
  });

  // 2. Attempt cold-start via SDK — should fail at quote stage
  const fpcClient = new FpcClient({
    fpcAddress,
    operator,
    node,
    attestationBaseUrl: args.attestationUrl,
  });

  try {
    await fpcClient.executeColdStart({
      wallet: ctx.wallet,
      userAddress: user,
      tokenAddress,
      bridgeAddress,
      bridgeClaim: tinyClaim,
    });
    throw new Error("Negative test unexpectedly succeeded");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (
      msg.includes("claim_amount must be >= aa_payment_amount") ||
      msg.includes("claim insufficient to cover fee")
    ) {
      pinoLogger.info("[cold-start-smoke] PASS: negative test correctly rejected");
    } else if (msg === "Negative test unexpectedly succeeded") {
      throw error;
    } else {
      throw new Error(`Negative test failed with unexpected error: ${msg}`);
    }
  }
}

/**
 * Negative test: claim < fee → rejected with "claim insufficient to cover fee".
 *
 * Bridges a tiny amount (aaPaymentAmount - 1), then verifies the cold-start
 * entrypoint correctly rejects the transaction during proving.
 */

import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { DefaultEntrypoint } from "@aztec/entrypoints/default";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import { Gas, GasFees, GasSettings } from "@aztec/stdlib/gas";
import { ExecutionPayload } from "@aztec/stdlib/tx";
import pino from "pino";
import { computeColdStartQuoteHash } from "../../services/attestation/src/signer.ts";
import { deriveAccount } from "../common/script-credentials.ts";
import type { TestContext } from "./setup.ts";

const pinoLogger = pino();

export async function testInsufficientClaim(ctx: TestContext): Promise<void> {
  const {
    args,
    node,
    operator,
    operatorSigningKey,
    fpc,
    fpcAddress,
    tokenAddress,
    bridgeAddress,
    feePerDaGas,
    feePerL2Gas,
    fjFeeAmount,
    l1WalletClient,
    l1Erc20,
    portalManager,
    pxe,
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

  // 2. Build cold-start quote with tiny claim, sign
  const negLatestBlock = await node.getBlock("latest");
  if (!negLatestBlock) throw new Error("Could not read latest L2 block");
  const negValidUntil = negLatestBlock.timestamp + args.quoteTtlSeconds;

  const negQuoteHash = await computeColdStartQuoteHash({
    fpcAddress,
    acceptedAsset: tokenAddress,
    fjFeeAmount,
    aaPaymentAmount,
    validUntil: negValidUntil,
    userAddress: user,
    claimAmount: tinyClaimAmount,
    claimSecretHash: tinyClaim.claimSecretHash,
  });
  const schnorr = new Schnorr();
  const negQuoteSig = await schnorr.constructSignature(negQuoteHash.toBuffer(), operatorSigningKey);

  // 3. Attempt to build + prove tx — should fail
  try {
    const negCall = await fpc.methods
      .cold_start_entrypoint(
        user,
        tokenAddress,
        bridgeAddress,
        tinyClaimAmount,
        tinyClaim.claimSecret,
        tinyClaim.claimSecretHash,
        new Fr(tinyClaim.messageLeafIndex),
        fjFeeAmount,
        aaPaymentAmount,
        negValidUntil,
        Array.from(negQuoteSig.toBuffer()),
      )
      .getFunctionCall();

    const negPayload = new ExecutionPayload([negCall], [], [], [], fpcAddress);
    const negGasSettings = GasSettings.default({
      maxFeesPerGas: new GasFees(feePerDaGas, feePerL2Gas),
      gasLimits: new Gas(args.daGasLimit, args.l2GasLimit),
      teardownGasLimits: Gas.empty(),
    });
    const entrypoint = new DefaultEntrypoint();
    const chainInfo = await ctx.wallet.getChainInfo();
    const negTxRequest = await entrypoint.createTxExecutionRequest(
      negPayload,
      negGasSettings,
      chainInfo,
    );
    await pxe.proveTx(negTxRequest, [user, operator, fpcAddress]);
    throw new Error("Negative test unexpectedly succeeded");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("claim insufficient to cover fee")) {
      pinoLogger.info("[cold-start-smoke] PASS: negative test correctly rejected");
    } else if (msg === "Negative test unexpectedly succeeded") {
      throw error;
    } else {
      throw new Error(`Negative test failed with unexpected error: ${msg}`);
    }
  }
}

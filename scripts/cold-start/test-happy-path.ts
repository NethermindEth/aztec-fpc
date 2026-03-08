/**
 * Positive test: cold-start -> account deploy -> counter increment -> sponsored
 * transfer -> FPC transfer, all via FPC.
 *
 * Bridges tokens L1->L2 for the user, builds and proves the cold-start tx,
 * then deploys the user's account contract, increments a counter, transfers
 * tokens via sponsored FPC, and finally transfers tokens via our FPC
 * fee_entrypoint.
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { Contract } from "@aztec/aztec.js/contracts";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import type { AztecNode } from "@aztec/aztec.js/node";
import { ProtocolContractAddress } from "@aztec/aztec.js/protocol";
import { DefaultEntrypoint } from "@aztec/entrypoints/default";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import type { AuthWitness } from "@aztec/stdlib/auth-witness";
import { Gas, GasFees, GasSettings } from "@aztec/stdlib/gas";
import { ExecutionPayload, type TxHash, type TxReceipt } from "@aztec/stdlib/tx";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import pino from "pino";
import {
  type ColdStartQuoteParams,
  computeColdStartQuoteHash,
} from "../../services/attestation/src/signer.ts";
import { type AccountData, deriveAccount } from "../common/script-credentials.ts";
import type { TestContext } from "./setup.ts";

const pinoLogger = pino();

// ---------------------------------------------------------------------------
// Local helper: fetch quote from attestation server
// ---------------------------------------------------------------------------

type QuoteResponse = {
  accepted_asset: string;
  fj_amount: string;
  aa_payment_amount: string;
  valid_until: string;
  signature: string;
};

async function fetchQuote(
  attestationUrl: string,
  user: AztecAddress,
  acceptedAsset: AztecAddress,
  fjAmount: bigint,
): Promise<QuoteResponse> {
  const quoteUrl = new URL(attestationUrl);
  const normalizedPath = quoteUrl.pathname.replace(/\/+$/u, "");
  quoteUrl.pathname = normalizedPath.endsWith("/quote")
    ? normalizedPath
    : `${normalizedPath}/quote`;
  quoteUrl.searchParams.set("user", user.toString());
  quoteUrl.searchParams.set("accepted_asset", acceptedAsset.toString());
  quoteUrl.searchParams.set("fj_amount", fjAmount.toString());

  const response = await fetch(quoteUrl.toString());
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Quote request failed (${response.status}): ${body}`);
  }
  return (await response.json()) as QuoteResponse;
}

function decodeSignatureHex(signatureHex: string): number[] {
  const normalized = signatureHex.startsWith("0x") ? signatureHex.slice(2) : signatureHex;
  return Array.from(Buffer.from(normalized, "hex"));
}

// ---------------------------------------------------------------------------
// Local helper: build FPC fee_entrypoint payment method + authwit
// ---------------------------------------------------------------------------

async function buildFpcPaymentMethod(opts: {
  attestationUrl: string;
  wallet: EmbeddedWallet;
  user: AztecAddress;
  operator: AztecAddress;
  fpc: Contract;
  fpcAddress: AztecAddress;
  token: Contract;
  tokenAddress: AztecAddress;
  fjFeeAmount: bigint;
  feePerDaGas: bigint;
  feePerL2Gas: bigint;
  daGasLimit: number;
  l2GasLimit: number;
}) {
  // 1. Fetch quote from attestation server
  const quote = await fetchQuote(
    opts.attestationUrl,
    opts.user,
    opts.tokenAddress,
    opts.fjFeeAmount,
  );
  const aaPaymentAmount = BigInt(quote.aa_payment_amount);
  const validUntil = BigInt(quote.valid_until);
  const signatureBytes = decodeSignatureHex(quote.signature);

  // 2. Build transfer authwit: token.transfer_private_to_private(user, operator, aaPaymentAmount, nonce)
  const nonce = Fr.random();

  const transferCall = await opts.token.methods
    .transfer_private_to_private(opts.user, opts.operator, aaPaymentAmount, nonce)
    .getFunctionCall();

  // 3. Create authwit for FPC to call the transfer on user's behalf
  const transferAuthwit: AuthWitness = await opts.wallet.createAuthWit(opts.user, {
    caller: opts.fpcAddress,
    call: transferCall,
  });

  // 4. Build fee_entrypoint call
  const feeEntrypointCall = await opts.fpc.methods
    .fee_entrypoint(
      opts.tokenAddress,
      nonce,
      opts.fjFeeAmount,
      aaPaymentAmount,
      validUntil,
      signatureBytes,
    )
    .getFunctionCall();

  // 5. Build payment method and gas settings
  const paymentMethod = {
    getAsset: async () => ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new ExecutionPayload([feeEntrypointCall], [transferAuthwit], [], [], opts.fpcAddress),
    getFeePayer: async () => opts.fpcAddress,
    getGasSettings: () => undefined,
  };

  const gasSettings = {
    gasLimits: new Gas(opts.daGasLimit, opts.l2GasLimit),
    teardownGasLimits: new Gas(0, 0),
    maxFeesPerGas: new GasFees(opts.feePerDaGas, opts.feePerL2Gas),
  };

  return { paymentMethod, gasSettings, aaPaymentAmount };
}

// ---------------------------------------------------------------------------
// Local helper: wait for tx to be mined, then wait for PXE to sync
// ---------------------------------------------------------------------------

const TX_MINE_TIMEOUT_MS = 180_000;
const TX_MINE_POLL_MS = 2_000;

async function waitForTx(txHash: TxHash, node: AztecNode): Promise<void> {
  // 1. Poll until mined
  const mineDeadline = Date.now() + TX_MINE_TIMEOUT_MS;
  let receipt: TxReceipt | undefined;
  while (Date.now() < mineDeadline) {
    receipt = await node.getTxReceipt(txHash);
    if (receipt.isMined()) break;
    if (receipt.isDropped()) {
      throw new Error(`Tx dropped: error=${receipt.error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, TX_MINE_POLL_MS));
  }
  if (!receipt || !receipt.isMined()) {
    throw new Error("Tx timed out waiting for block inclusion");
  }
  if (receipt.hasExecutionReverted()) {
    throw new Error(
      `Tx reverted: executionResult=${receipt.executionResult} error=${receipt.error}`,
    );
  }

  pinoLogger.info(
    `[cold-start-smoke] tx confirmed status=${receipt.status} executionResult=${receipt.executionResult} fee=${receipt.transactionFee?.toString()}`,
  );
}

// ---------------------------------------------------------------------------
// Local helper: assert private token balance
// ---------------------------------------------------------------------------

async function expectPrivateBalance(
  token: Contract,
  address: AztecAddress,
  label: string,
  expected: bigint,
  mode: "exact" | "atLeast" = "exact",
): Promise<bigint> {
  const balance = BigInt(
    (await token.methods.balance_of_private(address).simulate({ from: address })).toString(),
  );
  const expectStr = mode === "atLeast" ? `>=${expected}` : `${expected}`;
  pinoLogger.info(`[cold-start-smoke] ${label}: balance=${balance} expected=${expectStr}`);
  if (mode === "exact" && balance !== expected) {
    throw new Error(`${label} balance mismatch: expected=${expected} got=${balance}`);
  }
  if (mode === "atLeast" && balance < expected) {
    throw new Error(`${label} balance too low: expected>=${expected} got=${balance}`);
  }
  return balance;
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

export async function testHappyPath(ctx: TestContext): Promise<void> {
  const {
    args,
    node,
    operator,
    operatorSigningKey,
    attestationUrl,
    fpc,
    token,
    counter,
    fpcAddress,
    tokenAddress,
    bridgeAddress,
    sponsoredFpcAddress,
    feePerDaGas,
    feePerL2Gas,
    fjFeeAmount,
    l1WalletClient,
    l1Erc20,
    portalManager,
    pxe,
  } = ctx;

  const { claimAmount, aaPaymentAmount } = args;

  // 0. Create a fresh user for this test
  const userData: AccountData = await deriveAccount(Fr.random(), ctx.wallet);
  const user = userData.address;

  // =========================================================================
  // Phase 1: Cold-start — claim bridged tokens + pay FPC fee in one tx
  // =========================================================================

  // 1. Bridge tokens L1->L2 for the user (private)
  pinoLogger.info("[cold-start-smoke] bridging tokens L1->L2 for user");

  const l1Account = l1WalletClient.account;
  const mintHash = await l1Erc20.write.mint([l1Account.address, claimAmount]);
  await l1WalletClient.waitForTransactionReceipt({ hash: mintHash });

  const bridgeClaim = await portalManager.bridgeTokensPrivate(user, claimAmount, false);
  const bridgeMsgHash = Fr.fromHexString(bridgeClaim.messageHash as string);
  await waitForL1ToL2MessageReady(node, bridgeMsgHash, {
    timeoutSeconds: args.messageTimeoutSeconds,
    forPublicConsumption: false,
  });

  pinoLogger.info(
    `[cold-start-smoke] tokens bridged. claim_amount=${claimAmount} message_hash=${bridgeClaim.messageHash}`,
  );

  // 2. Build cold-start transaction
  pinoLogger.info("[cold-start-smoke] building cold-start transaction");

  const latestBlock = await node.getBlock("latest");
  if (!latestBlock) throw new Error("Could not read latest L2 block");
  const validUntil = latestBlock.timestamp + args.quoteTtlSeconds;

  // Sign cold-start quote
  const quoteParams: ColdStartQuoteParams = {
    fpcAddress,
    acceptedAsset: tokenAddress,
    fjFeeAmount,
    aaPaymentAmount,
    validUntil,
    userAddress: user,
    claimAmount,
    claimSecretHash: bridgeClaim.claimSecretHash,
  };
  const quoteHash = await computeColdStartQuoteHash(quoteParams);
  const schnorr = new Schnorr();
  const quoteSig = await schnorr.constructSignature(quoteHash.toBuffer(), operatorSigningKey);

  const coldStartCall = await fpc.methods
    .cold_start_entrypoint(
      user,
      tokenAddress,
      bridgeAddress,
      claimAmount,
      bridgeClaim.claimSecret,
      bridgeClaim.claimSecretHash,
      new Fr(bridgeClaim.messageLeafIndex),
      fjFeeAmount,
      aaPaymentAmount,
      validUntil,
      Array.from(quoteSig.toBuffer()),
    )
    .getFunctionCall();

  const payload = new ExecutionPayload([coldStartCall], [], [], [], fpcAddress);

  const gasSettings = GasSettings.default({
    maxFeesPerGas: new GasFees(feePerDaGas, feePerL2Gas),
    gasLimits: new Gas(args.daGasLimit, args.l2GasLimit),
    teardownGasLimits: Gas.empty(),
  });

  const entrypoint = new DefaultEntrypoint();
  const chainInfo = await ctx.wallet.getChainInfo();
  const txRequest = await entrypoint.createTxExecutionRequest(payload, gasSettings, chainInfo);

  // 3. Prove and send
  pinoLogger.info("[cold-start-smoke] proving transaction");

  const provingResult = await pxe.proveTx(txRequest, [user, operator, fpcAddress]);
  const tx = await provingResult.toTx();

  pinoLogger.info(`[cold-start-smoke] sending transaction tx_hash=${tx.txHash.toString()}`);
  await node.sendTx(tx);

  // 4. Wait for receipt + PXE sync
  await waitForTx(tx.txHash, node);

  // 5. Verify balances after cold-start
  await expectPrivateBalance(token, user, "User", claimAmount - aaPaymentAmount);
  await expectPrivateBalance(token, operator, "Operator", aaPaymentAmount, "atLeast");
  pinoLogger.info("[cold-start-smoke] PASS: cold-start balance verification succeeded");

  // =========================================================================
  // Phase 2: Deploy user account contract via FPC fee_entrypoint
  // =========================================================================

  pinoLogger.info("[cold-start-smoke] deploying user account via FPC");

  const fpcPaymentOpts = {
    attestationUrl,
    wallet: ctx.wallet,
    user,
    operator,
    fpc,
    fpcAddress,
    token,
    tokenAddress,
    fjFeeAmount,
    feePerDaGas,
    feePerL2Gas,
    daGasLimit: args.daGasLimit,
    l2GasLimit: args.l2GasLimit,
  };

  // Track cumulative debits from FPC fee payments (operator receives these)
  let operatorReceived = aaPaymentAmount; // Phase 1 cold-start
  let userDebited = aaPaymentAmount; // Phase 1 cold-start

  const deployMethod = await userData.accountManager.getDeployMethod();
  const { aaPaymentAmount: deployPayment, ...deployFee } =
    await buildFpcPaymentMethod(fpcPaymentOpts);
  operatorReceived += deployPayment;
  userDebited += deployPayment;

  await deployMethod.send({
    from: AztecAddress.ZERO,
    fee: deployFee,
    skipClassPublication: true,
  });

  // Verify balances after deploy
  await expectPrivateBalance(token, user, "Post-deploy user", claimAmount - userDebited);
  await expectPrivateBalance(token, operator, "Post-deploy operator", operatorReceived, "atLeast");

  pinoLogger.info("[cold-start-smoke] PASS: user account deployed via FPC");

  // =========================================================================
  // Phase 3: Increment counter via FPC fee_entrypoint
  // =========================================================================

  pinoLogger.info("[cold-start-smoke] incrementing counter via FPC");

  const counterBefore = BigInt(
    (await counter.methods.get_counter(user).simulate({ from: user })).toString(),
  );

  const { aaPaymentAmount: incrementPayment, ...incrementFee } =
    await buildFpcPaymentMethod(fpcPaymentOpts);
  operatorReceived += incrementPayment;
  userDebited += incrementPayment;

  await counter.methods.increment(user).send({
    from: user,
    fee: incrementFee,
  });

  // Verify counter incremented
  const counterAfter = BigInt(
    (await counter.methods.get_counter(user).simulate({ from: user })).toString(),
  );
  if (counterAfter !== counterBefore + 1n) {
    throw new Error(`Counter mismatch: expected=${counterBefore + 1n} got=${counterAfter}`);
  }

  // Verify balances after increment
  await expectPrivateBalance(
    token,
    operator,
    "Post-increment operator",
    operatorReceived,
    "atLeast",
  );
  await expectPrivateBalance(token, user, "Post-increment user", claimAmount - userDebited);

  pinoLogger.info("[cold-start-smoke] PASS: counter increment via FPC succeeded");

  // =========================================================================
  // Phase 4: Transfer tokens to a fresh recipient via sponsored FPC
  // =========================================================================

  pinoLogger.info("[cold-start-smoke] transferring tokens to recipient via sponsored FPC");

  const sponsoredRecipient = (await deriveAccount(Fr.random(), ctx.wallet)).address;
  const sponsoredTransferAmount = aaPaymentAmount;
  userDebited += sponsoredTransferAmount;

  await token.methods
    .transfer_private_to_private(user, sponsoredRecipient, sponsoredTransferAmount, 0)
    .send({
      from: user,
      fee: {
        paymentMethod: new SponsoredFeePaymentMethod(sponsoredFpcAddress),
      },
    });

  // Verify balances after sponsored transfer
  // Sponsored FPC pays gas — user only debited the transfer amount itself
  await expectPrivateBalance(
    token,
    operator,
    "Post-sponsored operator",
    operatorReceived,
    "atLeast",
  );
  await expectPrivateBalance(token, user, "Post-sponsored user", claimAmount - userDebited);
  await expectPrivateBalance(
    token,
    sponsoredRecipient,
    "Sponsored recipient",
    sponsoredTransferAmount,
  );

  pinoLogger.info("[cold-start-smoke] PASS: sponsored FPC transfer succeeded");

  // =========================================================================
  // Phase 5: Transfer tokens to a fresh recipient via FPC fee_entrypoint
  // =========================================================================

  pinoLogger.info("[cold-start-smoke] transferring tokens to recipient via FPC");

  const recipient = (await deriveAccount(Fr.random(), ctx.wallet)).address;
  const transferAmount = aaPaymentAmount;
  const { aaPaymentAmount: transferFeePayment, ...transferFee } =
    await buildFpcPaymentMethod(fpcPaymentOpts);
  operatorReceived += transferFeePayment;
  userDebited += transferFeePayment + transferAmount;

  await token.methods.transfer_private_to_private(user, recipient, transferAmount, 0).send({
    from: user,
    fee: transferFee,
  });

  // Verify final balances
  await expectPrivateBalance(token, operator, "Final operator", operatorReceived, "atLeast");
  await expectPrivateBalance(token, user, "Final user", claimAmount - userDebited);
  await expectPrivateBalance(token, recipient, "Recipient", transferAmount);

  pinoLogger.info("[cold-start-smoke] PASS: token transfer via FPC succeeded");
}

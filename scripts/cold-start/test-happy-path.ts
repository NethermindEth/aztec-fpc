/**
 * Positive test: cold-start -> sponsored account deploy -> sponsored transfer
 * -> FPC transfer.
 *
 * Bridges tokens L1->L2 for the user, builds and proves the cold-start tx,
 * then deploys the user's account contract, seeds a public fee budget,
 * transfers tokens via sponsored FPC, and finally transfers tokens via our
 * FPC fee_entrypoint.
 */

import { inspect } from "node:util";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { Contract } from "@aztec/aztec.js/contracts";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import type { AztecNode } from "@aztec/aztec.js/node";
import { ProtocolContractAddress } from "@aztec/aztec.js/protocol";
import { DefaultEntrypoint } from "@aztec/entrypoints/default";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import {
  type CallIntent,
  SetPublicAuthwitContractInteraction,
} from "@aztec/aztec.js/authorization";
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

  // 2. Build the public transfer call and set its authwit in the AuthRegistry.
  //    Public authwits require an actual AuthRegistry.set_authorized() call —
  //    transient AuthWitness objects only work for private authwit validation.
  const nonce = Fr.random();

  const transferCall = await opts.token.methods
    .transfer_public_to_public(opts.user, opts.operator, aaPaymentAmount, nonce)
    .getFunctionCall();

  const intent: CallIntent = { caller: opts.fpcAddress, call: transferCall };
  const setAuthInteraction = await SetPublicAuthwitContractInteraction.create(
    opts.wallet,
    opts.user,
    intent,
    true,
  );
  const setAuthPayload = await setAuthInteraction.request();

  // 3. Build fee_entrypoint call
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

  // 4. Build payment method and gas settings.
  //    The set_authorized calls MUST precede fee_entrypoint so the authwit
  //    is written to the AuthRegistry before collect_public_fee_internal
  //    tries to consume it.
  const paymentMethod = {
    getAsset: async () => ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new ExecutionPayload(
        [...setAuthPayload.calls, feeEntrypointCall],
        [],
        [],
        [],
        opts.fpcAddress,
      ),
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

function describeValue(value: unknown): string {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return inspect(value, { depth: 4, getters: true, showHidden: true });
}

function coercePrimitiveBigInt(value: unknown, label: string): bigint | undefined {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`${label} is not an integer: ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    return BigInt(value);
  }
  return undefined;
}

function unwrapStructuredBigIntCandidate(value: object): unknown {
  if (Array.isArray(value) && value.length === 1) {
    return value[0];
  }
  if ("value" in value) {
    return (value as Record<string, unknown>).value;
  }
  if ("inner" in value) {
    return (value as Record<string, unknown>).inner;
  }
  if ("raw" in value) {
    return (value as Record<string, unknown>).raw;
  }
  if ("toBigInt" in value && typeof (value as { toBigInt?: unknown }).toBigInt === "function") {
    return (value as { toBigInt: () => unknown }).toBigInt();
  }

  const primitiveFromSymbol = (value as Record<PropertyKey, unknown>)[Symbol.toPrimitive];
  if (typeof primitiveFromSymbol === "function") {
    const primitive = primitiveFromSymbol.call(value, "number");
    if (primitive !== value) {
      return primitive;
    }
  }

  const primitiveFromValueOf = (value as { valueOf?: () => unknown }).valueOf?.();
  if (primitiveFromValueOf !== undefined && primitiveFromValueOf !== value) {
    return primitiveFromValueOf;
  }

  return undefined;
}

function tryCoerceFromStringRepresentation(value: object): bigint | undefined {
  if (typeof (value as { toString?: () => string }).toString !== "function") {
    return undefined;
  }

  const stringValue = value.toString();
  if (stringValue === "[object Object]") {
    return undefined;
  }

  try {
    return BigInt(stringValue);
  } catch {
    return undefined;
  }
}

function getCoercionKeys(value: object): PropertyKey[] {
  return [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertySymbols(value)].filter(
    (key) => key !== "length",
  );
}

function coerceFromCandidateList(
  value: object,
  ownKeys: PropertyKey[],
  label: string,
  seen: WeakSet<object>,
): bigint | undefined {
  if (ownKeys.length === 1) {
    const innerValue = (value as Record<PropertyKey, unknown>)[ownKeys[0]];
    if (innerValue !== value) {
      return coerceBigInt(innerValue, label, seen);
    }
  }

  for (const key of ownKeys) {
    const candidate = (value as Record<PropertyKey, unknown>)[key];
    if (candidate === value) {
      continue;
    }
    try {
      return coerceBigInt(candidate, label, seen);
    } catch {
      // Try the next structural candidate.
    }
  }

  return undefined;
}

function coerceObjectBigInt(value: object, label: string, seen: WeakSet<object>): bigint {
  if (value instanceof Fr) {
    return value.toBigInt();
  }
  if (seen.has(value)) {
    throw new Error(`Could not coerce ${label} to bigint: circular value ${describeValue(value)}`);
  }
  seen.add(value);

  const structuredCandidate = unwrapStructuredBigIntCandidate(value);
  if (structuredCandidate !== undefined) {
    return coerceBigInt(structuredCandidate, label, seen);
  }

  const stringCoercion = tryCoerceFromStringRepresentation(value);
  if (stringCoercion !== undefined) {
    return stringCoercion;
  }

  const ownKeys = getCoercionKeys(value);
  const keyCoercion = coerceFromCandidateList(value, ownKeys, label, seen);
  if (keyCoercion !== undefined) {
    return keyCoercion;
  }

  throw new Error(`Could not coerce ${label} to bigint: ${describeValue(value)}`);
}

function coerceBigInt(
  value: unknown,
  label: string,
  seen: WeakSet<object> = new WeakSet(),
): bigint {
  const primitiveValue = coercePrimitiveBigInt(value, label);
  if (primitiveValue !== undefined) {
    return primitiveValue;
  }
  if (value && typeof value === "object") {
    return coerceObjectBigInt(value, label, seen);
  }
  throw new Error(`Could not coerce ${label} to bigint: ${describeValue(value)}`);
}

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
  const balance = await readPrivateBalance(token, address, label);
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

async function expectPublicBalance(
  token: Contract,
  address: AztecAddress,
  label: string,
  expected: bigint,
  mode: "exact" | "atLeast" = "exact",
): Promise<bigint> {
  const balance = await readPublicBalance(token, address, label);
  const expectStr = mode === "atLeast" ? `>=${expected}` : `${expected}`;
  pinoLogger.info(`[cold-start-smoke] ${label}: public_balance=${balance} expected=${expectStr}`);
  if (mode === "exact" && balance !== expected) {
    throw new Error(`${label} public balance mismatch: expected=${expected} got=${balance}`);
  }
  if (mode === "atLeast" && balance < expected) {
    throw new Error(`${label} public balance too low: expected>=${expected} got=${balance}`);
  }
  return balance;
}

async function readPrivateBalance(
  token: Contract,
  address: AztecAddress,
  label: string,
): Promise<bigint> {
  return coerceBigInt(
    await token.methods.balance_of_private(address).simulate({ from: address }),
    `${label} private balance`,
  );
}

async function readPublicBalance(
  token: Contract,
  address: AztecAddress,
  label: string,
): Promise<bigint> {
  return coerceBigInt(
    await token.methods.balance_of_public(address).simulate({ from: address }),
    `${label} public balance`,
  );
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
    bridge,
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

  const recurringPhaseQuote = await fetchQuote(attestationUrl, user, tokenAddress, fjFeeAmount);
  const recurringPhasePayment = BigInt(recurringPhaseQuote.aa_payment_amount);
  const minimumRequiredClaim = recurringPhasePayment * 3n + aaPaymentAmount * 3n;
  if (claimAmount < minimumRequiredClaim) {
    throw new Error(
      `[cold-start-smoke] claim amount too low for happy path: claim_amount=${claimAmount} minimum_required=${minimumRequiredClaim} recurring_phase_payment=${recurringPhasePayment}`,
    );
  }

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
  // Phase 2: Deploy user account via SponsoredFPC, then seed public fee budget
  // =========================================================================

  pinoLogger.info("[cold-start-smoke] deploying user account via SponsoredFPC");

  let operatorPrivateReceived = aaPaymentAmount; // Phase 1 cold-start
  let operatorPublicReceived = 0n;
  let userPrivateDebited = aaPaymentAmount; // Phase 1 cold-start
  let userPublicRemaining = recurringPhasePayment * 2n;

  const deployMethod = await userData.accountManager.getDeployMethod();
  await deployMethod.send({
    from: AztecAddress.ZERO,
    fee: {
      paymentMethod: new SponsoredFeePaymentMethod(sponsoredFpcAddress),
    },
    skipClassPublication: true,
  });

  // Verify balances after deploy
  await expectPrivateBalance(token, user, "Post-deploy user", claimAmount - userPrivateDebited);
  await expectPrivateBalance(
    token,
    operator,
    "Post-deploy operator",
    operatorPrivateReceived,
    "atLeast",
  );
  await expectPublicBalance(token, operator, "Post-deploy operator", operatorPublicReceived);
  await expectPublicBalance(token, user, "Post-deploy user", 0n);

  await token.methods.transfer_private_to_public(user, user, userPublicRemaining, 0).send({
    from: user,
    fee: {
      paymentMethod: new SponsoredFeePaymentMethod(sponsoredFpcAddress),
    },
    wait: { timeout: 180 },
  });
  userPrivateDebited += userPublicRemaining;
  await expectPublicBalance(token, user, "User public fee budget", userPublicRemaining);

  pinoLogger.info("[cold-start-smoke] PASS: user account deployed via SponsoredFPC");

  // =========================================================================
  // Phase 3: Transfer tokens to a fresh recipient via sponsored FPC
  // =========================================================================

  pinoLogger.info("[cold-start-smoke] transferring tokens to recipient via sponsored FPC");

  const sponsoredRecipient = (await deriveAccount(Fr.random(), ctx.wallet)).address;
  const sponsoredTransferAmount = aaPaymentAmount;
  userPrivateDebited += sponsoredTransferAmount;

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
    operatorPrivateReceived,
    "atLeast",
  );
  await expectPrivateBalance(token, user, "Post-sponsored user", claimAmount - userPrivateDebited);
  await expectPublicBalance(
    token,
    operator,
    "Post-sponsored operator",
    operatorPublicReceived,
    "atLeast",
  );
  await expectPublicBalance(token, user, "Post-sponsored user", userPublicRemaining);
  await expectPrivateBalance(
    token,
    sponsoredRecipient,
    "Sponsored recipient",
    sponsoredTransferAmount,
  );

  pinoLogger.info("[cold-start-smoke] PASS: sponsored FPC transfer succeeded");

  // =========================================================================
  // Phase 4: Transfer tokens to a fresh recipient via FPC fee_entrypoint
  // =========================================================================

  pinoLogger.info("[cold-start-smoke] transferring tokens to recipient via FPC");

  const recipient = (await deriveAccount(Fr.random(), ctx.wallet)).address;
  const transferAmount = aaPaymentAmount;
  const { aaPaymentAmount: transferFeePayment, ...transferFee } =
    await buildFpcPaymentMethod(fpcPaymentOpts);
  operatorPublicReceived += transferFeePayment;
  userPublicRemaining -= transferFeePayment;

  const finalOperatorBefore = await expectPrivateBalance(
    token,
    operator,
    "Final operator before transfer",
    operatorPrivateReceived,
    "atLeast",
  );
  const finalUserBefore = await expectPrivateBalance(
    token,
    user,
    "Final user before transfer",
    claimAmount - userPrivateDebited,
  );
  const finalRecipientBefore = await expectPrivateBalance(
    token,
    recipient,
    "Recipient before transfer",
    0n,
  );
  userPrivateDebited += transferAmount;

  const finalTransfer = await token.methods
    .transfer_private_to_private(user, recipient, transferAmount, 0)
    .send({
      from: user,
      fee: transferFee,
      wait: { timeout: 180 },
    });
  pinoLogger.info(
    `[cold-start-smoke] final private transfer tx_fee_juice=${finalTransfer.receipt.transactionFee?.toString()}`,
  );

  const finalOperatorAfter = await readPrivateBalance(token, operator, "Final operator");
  const finalUserAfter = await readPrivateBalance(token, user, "Final user");
  const finalRecipientAfter = await readPrivateBalance(token, recipient, "Recipient");
  const finalOperatorPublicAfter = await readPublicBalance(
    token,
    operator,
    "Final operator public",
  );
  const finalUserPublicAfter = await readPublicBalance(token, user, "Final user public");

  pinoLogger.info(
    `[cold-start-smoke] final private transfer balances user=${finalUserAfter} operator=${finalOperatorAfter} recipient=${finalRecipientAfter}`,
  );
  pinoLogger.info(
    `[cold-start-smoke] final private transfer deltas user=${finalUserBefore - finalUserAfter} operator=${finalOperatorAfter - finalOperatorBefore} recipient=${finalRecipientAfter - finalRecipientBefore}`,
  );

  // Verify final balances
  if (finalOperatorAfter < operatorPrivateReceived) {
    throw new Error(
      `Final operator private balance too low: expected>=${operatorPrivateReceived} got=${finalOperatorAfter}`,
    );
  }
  if (finalOperatorPublicAfter < operatorPublicReceived) {
    throw new Error(
      `Final operator public balance too low: expected>=${operatorPublicReceived} got=${finalOperatorPublicAfter}`,
    );
  }
  if (finalUserAfter !== claimAmount - userPrivateDebited) {
    throw new Error(
      `Final user private balance mismatch: expected=${claimAmount - userPrivateDebited} got=${finalUserAfter}`,
    );
  }
  if (finalUserPublicAfter !== userPublicRemaining) {
    throw new Error(
      `Final user public balance mismatch: expected=${userPublicRemaining} got=${finalUserPublicAfter}`,
    );
  }
  if (finalRecipientAfter !== transferAmount) {
    throw new Error(
      `Recipient balance mismatch: expected=${transferAmount} got=${finalRecipientAfter}`,
    );
  }

  pinoLogger.info("[cold-start-smoke] PASS: token transfer via FPC succeeded");
}

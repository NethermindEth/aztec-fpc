import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import type { FeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode } from "@aztec/aztec.js/node";
import { ProtocolContractAddress } from "@aztec/aztec.js/protocol";
import type { Wallet as AccountWallet } from "@aztec/aztec.js/wallet";
import { DefaultEntrypoint } from "@aztec/entrypoints/default";
import { Gas, GasFees, GasSettings } from "@aztec/stdlib/gas";
import {
  ExecutionPayload,
  type TxHash,
  type TxProvingResult,
  type TxReceipt,
} from "@aztec/stdlib/tx";

import { requireDefaultArtifact } from "./internal/contracts";
import type {
  ColdStartQuoteResponse,
  ColdStartResult,
  CreatePaymentMethodInput,
  ExecuteColdStartInput,
  FpcClientConfig,
  FpcPaymentMethodResult,
  QuoteResponse,
} from "./types";

const GAS_BUFFER = new Gas(5_000, 100_000);
const COLD_START_GAS_LIMITS = new Gas(5_000, 1_000_000);
const TX_MINE_POLL_MS = 2_000;
const DEFAULT_TX_WAIT_TIMEOUT_MS = 180_000;

export class FpcClient {
  private readonly config: FpcClientConfig;

  constructor(config: FpcClientConfig) {
    this.config = config;
  }

  async createPaymentMethod(input: CreatePaymentMethodInput): Promise<FpcPaymentMethodResult> {
    const { fpcAddress, operator, node, attestationBaseUrl } = this.config;
    const { wallet, user, tokenAddress, estimatedGas } = input;

    if (!estimatedGas) {
      throw new Error("estimatedGas is required — simulate with fee: { estimateGas: true }");
    }
    const { gasLimits: rawGasLimits, teardownGasLimits } = estimatedGas;
    const gasLimits = rawGasLimits.add(GAS_BUFFER);

    const [fpc, token] = await Promise.all([
      attachContract(fpcAddress, "fpc", node, wallet),
      attachContract(tokenAddress, "token", node, wallet),
    ]);

    const gasFees = await node.getCurrentMinFees();
    const fjAmount = computeFjAmount(gasLimits, gasFees);

    const quote = await fetchQuote(attestationBaseUrl, user, tokenAddress, fjAmount);

    const { aaPaymentAmount, validUntil, sigBytes } = parseQuoteFields(quote);
    const { nonce, transferAuthwit } = await createTransferAuthwit(
      token,
      wallet,
      user,
      operator,
      fpcAddress,
      aaPaymentAmount,
    );

    const feeEntrypointCall = await fpc.methods
      .fee_entrypoint(tokenAddress, nonce, fjAmount, aaPaymentAmount, validUntil, sigBytes)
      .getFunctionCall();

    const gasSettings = new GasSettings(gasLimits, teardownGasLimits, gasFees, GasFees.empty());

    const paymentMethod: FeePaymentMethod = {
      getAsset: async () => ProtocolContractAddress.FeeJuice,
      getExecutionPayload: async () =>
        new ExecutionPayload([feeEntrypointCall], [transferAuthwit], [], [], fpcAddress),
      getFeePayer: async () => fpcAddress,
      getGasSettings: () => gasSettings,
    };

    return {
      fee: { paymentMethod },
      nonce,
      quote,
    };
  }

  async executeColdStart(input: ExecuteColdStartInput): Promise<ColdStartResult> {
    const { fpcAddress, operator, node, attestationBaseUrl } = this.config;
    const { wallet, userAddress, tokenAddress, bridgeAddress, bridgeClaim } = input;
    const timeoutMs = input.txWaitTimeoutMs ?? DEFAULT_TX_WAIT_TIMEOUT_MS;

    const [fpc, _token, _bridge] = await Promise.all([
      attachContract(fpcAddress, "fpc", node, wallet),
      attachContract(tokenAddress, "token", node, wallet),
      attachContract(bridgeAddress, "bridge", node, wallet),
    ]);

    const gasFees = await node.getCurrentMinFees();
    const fjAmount = computeFjAmount(COLD_START_GAS_LIMITS, gasFees);

    const quote = await fetchColdStartQuote(
      attestationBaseUrl,
      userAddress,
      tokenAddress,
      fjAmount,
      bridgeClaim.claimAmount,
      bridgeClaim.claimSecretHash,
    );

    const { aaPaymentAmount, validUntil, sigBytes } = parseQuoteFields(quote);

    const coldStartCall = await fpc.methods
      .cold_start_entrypoint(
        userAddress,
        tokenAddress,
        bridgeAddress,
        bridgeClaim.claimAmount,
        bridgeClaim.claimSecret,
        bridgeClaim.claimSecretHash,
        new Fr(bridgeClaim.messageLeafIndex),
        fjAmount,
        aaPaymentAmount,
        validUntil,
        sigBytes,
      )
      .getFunctionCall();

    const payload = new ExecutionPayload([coldStartCall], [], [], [], fpcAddress);

    const gasSettings = GasSettings.default({
      maxFeesPerGas: new GasFees(gasFees.feePerDaGas, gasFees.feePerL2Gas),
      gasLimits: COLD_START_GAS_LIMITS,
      teardownGasLimits: Gas.empty(),
    });

    const receipt = await proveAndSendTx(
      wallet,
      node,
      payload,
      gasSettings,
      [userAddress, operator, fpcAddress],
      timeoutMs,
    );

    return {
      txHash: receipt.txHash.toString(),
      txFee: receipt.transactionFee ?? 0n,
      fjAmount,
      aaPaymentAmount,
      quoteValidUntil: validUntil,
    };
  }
}

async function fetchQuote(
  attestationBaseUrl: string,
  user: AztecAddress,
  acceptedAsset: AztecAddress,
  fjAmount: bigint,
): Promise<QuoteResponse> {
  const quoteUrl = new URL(attestationBaseUrl);
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

async function fetchColdStartQuote(
  attestationBaseUrl: string,
  user: AztecAddress,
  acceptedAsset: AztecAddress,
  fjAmount: bigint,
  claimAmount: bigint,
  claimSecretHash: Fr,
): Promise<ColdStartQuoteResponse> {
  const quoteUrl = new URL(attestationBaseUrl);
  const normalizedPath = quoteUrl.pathname.replace(/\/+$/u, "");
  quoteUrl.pathname = normalizedPath.endsWith("/cold-start-quote")
    ? normalizedPath
    : `${normalizedPath}/cold-start-quote`;
  quoteUrl.searchParams.set("user", user.toString());
  quoteUrl.searchParams.set("accepted_asset", acceptedAsset.toString());
  quoteUrl.searchParams.set("fj_amount", fjAmount.toString());
  quoteUrl.searchParams.set("claim_amount", claimAmount.toString());
  quoteUrl.searchParams.set("claim_secret_hash", claimSecretHash.toString());

  const response = await fetch(quoteUrl.toString());
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cold-start quote request failed (${response.status}): ${body}`);
  }
  return (await response.json()) as ColdStartQuoteResponse;
}

async function proveAndSendTx(
  wallet: AccountWallet,
  node: AztecNode,
  payload: ExecutionPayload,
  gasSettings: GasSettings,
  signers: AztecAddress[],
  timeoutMs: number,
): Promise<TxReceipt> {
  const chainInfo = await wallet.getChainInfo();
  const entrypoint = new DefaultEntrypoint();
  const txRequest = await entrypoint.createTxExecutionRequest(payload, gasSettings, chainInfo);

  // biome-ignore lint/suspicious/noExplicitAny: EmbeddedWallet exposes PXE as a protected member
  const pxe = (wallet as any).pxe;
  const provingResult: TxProvingResult = await pxe.proveTx(txRequest, signers);

  const tx = await provingResult.toTx();
  await node.sendTx(tx);

  return waitForTx(tx.txHash, node, timeoutMs);
}

async function waitForTx(txHash: TxHash, node: AztecNode, timeoutMs: number): Promise<TxReceipt> {
  const deadline = Date.now() + timeoutMs;
  let receipt: TxReceipt | undefined;
  while (Date.now() < deadline) {
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
  return receipt;
}

async function attachContract(
  address: AztecAddress,
  label: "fpc" | "token" | "bridge",
  node: AztecNode,
  wallet: AccountWallet,
): Promise<Contract> {
  const artifact = requireDefaultArtifact(label);
  const instance = await node.getContract(address);
  if (!instance) {
    throw new Error(`${label} contract not found on node at ${address.toString()}`);
  }
  const secretKey = label === "fpc" ? Fr.ZERO : undefined;
  await wallet.registerContract(instance, artifact, secretKey);
  return Contract.at(address, artifact, wallet);
}

function computeFjAmount(gasLimits: Gas, gasFees: GasFees): bigint {
  const totalDaGas = BigInt(gasLimits.daGas);
  const totalL2Gas = BigInt(gasLimits.l2Gas);
  return totalDaGas * gasFees.feePerDaGas + totalL2Gas * gasFees.feePerL2Gas;
}

function parseQuoteFields(quote: QuoteResponse) {
  const aaPaymentAmount = BigInt(quote.aa_payment_amount);
  const validUntil = BigInt(quote.valid_until);
  const sigBytes = Array.from(Buffer.from(quote.signature.replace(/^0x/, ""), "hex"));
  return { aaPaymentAmount, validUntil, sigBytes };
}

async function createTransferAuthwit(
  token: Contract,
  wallet: AccountWallet,
  user: AztecAddress,
  operator: AztecAddress,
  fpcAddress: AztecAddress,
  amount: bigint,
) {
  const nonce = Fr.random();
  const transferCall = await token.methods
    .transfer_private_to_private(user, operator, amount, nonce)
    .getFunctionCall();
  const transferAuthwit = await wallet.createAuthWit(user, {
    caller: fpcAddress,
    call: transferCall,
  });
  return { nonce, transferAuthwit };
}

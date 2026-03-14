import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import type { FeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import { ProtocolContractAddress } from "@aztec/aztec.js/protocol";
import type { Wallet as AccountWallet } from "@aztec/aztec.js/wallet";
import { Gas, GasFees, GasSettings } from "@aztec/stdlib/gas";
import { ExecutionPayload } from "@aztec/stdlib/tx";

import { requireDefaultArtifact } from "./internal/contracts";
import type {
  CreatePaymentMethodInput,
  FpcClientConfig,
  FpcPaymentMethodResult,
  QuoteResponse,
} from "./types";

const GAS_BUFFER = new Gas(5_000, 10_000);

export class FpcClient {
  private readonly config: FpcClientConfig;

  constructor(config: FpcClientConfig) {
    this.config = config;
  }

  async createPaymentMethod(input: CreatePaymentMethodInput): Promise<FpcPaymentMethodResult> {
    const { fpcAddress, operator, node, attestationBaseUrl } = this.config;
    const { wallet, user, tokenAddress, estimatedGas } = input;

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

async function attachContract(
  address: AztecAddress,
  label: "fpc" | "token",
  node: FpcClientConfig["node"],
  wallet: AccountWallet,
): Promise<Contract> {
  const artifact = requireDefaultArtifact(label);
  const instance = await node.getContract(address);
  if (!instance) {
    throw new Error(`${label} contract not found on node at ${address.toString()}`);
  }
  await wallet.registerContract(instance, artifact);
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

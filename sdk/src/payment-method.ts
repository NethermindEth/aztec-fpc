import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract, type InteractionFeeOptions } from "@aztec/aztec.js/contracts";
import type { FeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode } from "@aztec/aztec.js/node";
import { ProtocolContractAddress } from "@aztec/aztec.js/protocol";
import type { Wallet as AccountWallet } from "@aztec/aztec.js/wallet";
import { Gas, GasFees, GasSettings } from "@aztec/stdlib/gas";
import { ExecutionPayload } from "@aztec/stdlib/tx";

import { requireDefaultArtifact } from "./internal/contracts";

export type FpcClientConfig = {
  fpcAddress: AztecAddress;
  operator: AztecAddress;
  node: AztecNode;
  attestationBaseUrl: string;
};

export type CreatePaymentMethodInput = {
  wallet: AccountWallet;
  user: AztecAddress;
  tokenAddress: AztecAddress;
  estimatedGas?: Pick<GasSettings, "gasLimits" | "teardownGasLimits">;
};

export type QuoteResponse = {
  accepted_asset: string;
  fj_amount: string;
  aa_payment_amount: string;
  valid_until: string;
  signature: string;
};

export type FpcPaymentMethodResult = {
  fee: InteractionFeeOptions;
  nonce: Fr;
  quote: QuoteResponse;
};

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
  node: AztecNode,
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

const GAS_BUFFER = new Gas(5_000, 10_000);

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

    // 1. Attach contracts
    const [fpc, token] = await Promise.all([
      attachContract(fpcAddress, "fpc", node, wallet),
      attachContract(tokenAddress, "token", node, wallet),
    ]);

    // 2. Query gas fees from node and compute fjAmount
    const gasFees = await node.getCurrentMinFees();
    const totalDaGas = BigInt(gasLimits.daGas);
    const totalL2Gas = BigInt(gasLimits.l2Gas);
    const fjAmount = totalDaGas * gasFees.feePerDaGas + totalL2Gas * gasFees.feePerL2Gas;

    // 3. Fetch quote
    const quote = await fetchQuote(attestationBaseUrl, user, tokenAddress, fjAmount);

    // 4. Parse quote fields for contract calls
    const aaPaymentAmount = BigInt(quote.aa_payment_amount);
    const validUntil = BigInt(quote.valid_until);
    const sigBytes = Array.from(Buffer.from(quote.signature.replace(/^0x/, ""), "hex"));

    // 5. Build transfer call + auth witness
    const nonce = Fr.random();
    const transferCall = await token.methods
      .transfer_private_to_private(user, operator, aaPaymentAmount, nonce)
      .getFunctionCall();
    const transferAuthwit = await wallet.createAuthWit(user, {
      caller: fpcAddress,
      call: transferCall,
    });

    // 6. Build fee_entrypoint call
    const feeEntrypointCall = await fpc.methods
      .fee_entrypoint(tokenAddress, nonce, fjAmount, aaPaymentAmount, validUntil, sigBytes)
      .getFunctionCall();

    // 7. Assemble payment method with embedded gas settings
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

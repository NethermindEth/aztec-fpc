import { AztecAddress } from "@aztec/aztec.js/addresses";
import { BatchCall, type TxSendResultMined } from "@aztec/aztec.js/contracts";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode } from "@aztec/aztec.js/node";
import { ProtocolContractAddress } from "@aztec/aztec.js/protocol";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import { computeInnerAuthWitHash } from "@aztec/stdlib/auth-witness";
import { Gas, GasFees } from "@aztec/stdlib/gas";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { ExecutionPayload, type TxReceipt } from "@aztec/stdlib/tx";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import { beforeAll, describe, expect, it } from "#test";
import type { FaucetContract } from "../../codegen/Faucet.ts";
import type { FPCMultiAssetContract } from "../../codegen/FPCMultiAsset.ts";
import type { TokenContract } from "../../codegen/Token.ts";
import { deriveAccount } from "../common/script-credentials.ts";
import { setup as commonSetup } from "../common/setup-helpers.ts";

type FullE2EConfig = {
  nodeUrl: string;
  manifestPath: string;
  testTokenManifestPath: string;
  operatorSecretKey: string;
  feeJuiceTimeoutMs: number;
  feeJuicePollMs: number;
  marketRateNum: number;
  marketRateDen: number;
  feeBips: number;
  daGasLimit: number;
  l2GasLimit: number;
  pxeProverEnabled: boolean;
};

type DeploymentRuntimeResult = {
  operator: AztecAddress;
  operatorSecretHex: string;
  user: AztecAddress;
  otherUser: AztecAddress;
  wallet: EmbeddedWallet;
  node: AztecNode;
  token: TokenContract;
  fpc: FPCMultiAssetContract;
  faucet: FaucetContract;
  sponsoredFeePayment: SponsoredFeePaymentMethod;
  gasLimits: Gas;
  maxFeesPerGas: GasFees;
};

type QuoteInput = {
  fjAmount: bigint;
  aaPaymentAmount: bigint;
  validUntil: bigint;
  quoteSigBytes: number[];
};

const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const HEX_32_BYTE_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const MAX_QUOTE_VALIDITY_SECONDS = 3600;
const QUOTE_DOMAIN_SEPARATOR = Fr.fromHexString("0x465043");

function readEnvPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Invalid integer env var ${name}: value cannot be empty`);
  }
  if (!POSITIVE_INTEGER_PATTERN.test(normalized)) {
    throw new Error(`Invalid integer env var ${name}=${value}`);
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid integer env var ${name}=${value} (out of safe integer range)`);
  }
  return parsed;
}

function assertPrivateKeyHex(value: string, fieldName: string): void {
  if (!HEX_32_BYTE_PATTERN.test(value)) {
    throw new Error(`${fieldName} must be a 32-byte 0x-prefixed private key`);
  }
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function getFinalRate(config: FullE2EConfig): {
  rateNum: bigint;
  rateDen: bigint;
} {
  return {
    rateNum: BigInt(config.marketRateNum) * BigInt(10_000 + config.feeBips),
    rateDen: BigInt(config.marketRateDen) * 10_000n,
  };
}

function computeMaxGasCost(gasLimits: Gas, maxFeesPerGas: GasFees): bigint {
  return (
    BigInt(gasLimits.daGas) * maxFeesPerGas.feePerDaGas +
    BigInt(gasLimits.l2Gas) * maxFeesPerGas.feePerL2Gas
  );
}

async function getLatestL2Timestamp(node: AztecNode): Promise<bigint> {
  const latest = await node.getBlock("latest");
  if (!latest) {
    throw new Error("Could not read latest L2 block");
  }
  return latest.timestamp;
}

type FeeEntrypointOverrides = {
  payer?: AztecAddress;
  validUntil?: bigint;
  maxFeesPerGas?: GasFees;
  fpcAddress?: AztecAddress;
  tokenAddress?: AztecAddress;
  fjAmount?: bigint;
  aaPaymentAmount?: bigint;
  rateNum?: bigint;
  rateDen?: bigint;
};

type ExecuteFeePaidTxOverrides = {
  maxFeesPerGas?: GasFees;
  authwitNonce?: Fr;
  authwitAmount?: bigint;
};

async function executeFeePaidTx(
  result: DeploymentRuntimeResult,
  quote: QuoteInput,
  overrides?: ExecuteFeePaidTxOverrides,
): Promise<TxSendResultMined<TxReceipt>> {
  const entrypointNonce = Fr.random();
  const authwitNonce = overrides?.authwitNonce ?? entrypointNonce;
  const authwitAmount = overrides?.authwitAmount ?? quote.aaPaymentAmount;
  const transferCall = await result.token.methods
    .transfer_private_to_private(result.user, result.operator, authwitAmount, authwitNonce)
    .getFunctionCall();
  const transferAuthwit = await result.wallet.createAuthWit(result.user, {
    caller: result.fpc.address,
    call: transferCall,
  });

  const feeEntrypointCall = await result.fpc.methods
    .fee_entrypoint(
      result.token.address,
      entrypointNonce,
      quote.fjAmount,
      quote.aaPaymentAmount,
      quote.validUntil,
      quote.quoteSigBytes,
    )
    .getFunctionCall();

  const paymentMethod = {
    getAsset: async () => ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new ExecutionPayload([feeEntrypointCall], [transferAuthwit], [], [], result.fpc.address),
    getFeePayer: async () => result.fpc.address,
    getGasSettings: () => undefined,
  };

  // Target call: self-transfer (no balance change, just exercises the fee_entrypoint path).
  return await result.token.methods
    .transfer_private_to_private(result.user, result.user, 1n, Fr.random())
    .send({
      from: result.user,
      fee: {
        paymentMethod,
        gasSettings: {
          gasLimits: result.gasLimits,
          teardownGasLimits: new Gas(0, 0),
          maxFeesPerGas: overrides?.maxFeesPerGas ?? result.maxFeesPerGas,
        },
      },
      wait: { timeout: 180 },
    });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value.trim();
}

function getConfig(): FullE2EConfig {
  const manifestPath = requireEnv("FPC_COLD_START_MANIFEST");
  const testTokenManifestPath = requireEnv("FPC_TEST_TOKEN_MANIFEST");
  const operatorSecretKey = requireEnv("FPC_OPERATOR_SECRET_KEY");
  assertPrivateKeyHex(operatorSecretKey, "FPC_OPERATOR_SECRET_KEY");
  const feeBips = readEnvPositiveInteger("FPC_FULL_E2E_FEE_BIPS", 200);
  if (feeBips > 10_000) {
    throw new Error(`FPC_FULL_E2E_FEE_BIPS must be <= 10000, got ${feeBips}`);
  }

  return {
    nodeUrl: process.env.AZTEC_NODE_URL ?? "http://localhost:8080",
    manifestPath,
    testTokenManifestPath,
    operatorSecretKey,
    feeJuiceTimeoutMs: readEnvPositiveInteger("FPC_FULL_E2E_FEE_JUICE_TIMEOUT_MS", 240_000),
    feeJuicePollMs: readEnvPositiveInteger("FPC_FULL_E2E_FEE_JUICE_POLL_MS", 2_000),
    marketRateNum: readEnvPositiveInteger("FPC_FULL_E2E_MARKET_RATE_NUM", 1),
    marketRateDen: readEnvPositiveInteger("FPC_FULL_E2E_MARKET_RATE_DEN", 1000),
    feeBips,
    daGasLimit: readEnvPositiveInteger("FPC_FULL_E2E_DA_GAS_LIMIT", 200_000),
    l2GasLimit: readEnvPositiveInteger("FPC_FULL_E2E_L2_GAS_LIMIT", 1_000_000),
    pxeProverEnabled:
      process.env.PXE_PROVER_ENABLED !== "0" && process.env.PXE_PROVER_ENABLED !== "false",
  };
}

async function setupFromManifest(config: FullE2EConfig): Promise<DeploymentRuntimeResult> {
  const { node, wallet, operator, contracts, sponsoredFpcAddress } = await commonSetup(
    {
      nodeUrl: config.nodeUrl,
      manifestPath: config.manifestPath,
      testTokenManifestPath: config.testTokenManifestPath,
      proverEnabled: config.pxeProverEnabled,
      messageTimeoutSeconds: Math.ceil(config.feeJuiceTimeoutMs / 1_000),
    },
    "fpc-full-lifecycle-e2e",
  );

  const { token, fpc, faucet } = contracts;

  const sponsoredFeePayment = new SponsoredFeePaymentMethod(sponsoredFpcAddress);

  // Derive fresh user and otherUser for negative scenarios.
  const userData = await deriveAccount(Fr.random(), wallet);
  const otherUserData = await deriveAccount(Fr.random(), wallet);
  const user = userData.address;
  const otherUser = otherUserData.address;

  // Deploy user and otherUser accounts via SponsoredFPC (batched).
  const deployBatch = new BatchCall(wallet, [
    await userData.accountManager.getDeployMethod(),
    await otherUserData.accountManager.getDeployMethod(),
  ]);
  await deployBatch.send({
    from: AztecAddress.ZERO,
    fee: { paymentMethod: sponsoredFeePayment },
  });

  // Fund user via faucet drip + shield (batched via SponsoredFPC).
  const { result: faucetConfig } = await faucet.methods.get_config().simulate({ from: user });
  const dripAmount = BigInt(faucetConfig.drip_amount.toString());
  const dripBatch = new BatchCall(wallet, [
    faucet.methods.drip(user),
    token.methods.transfer_public_to_private(user, user, dripAmount, Fr.random()),
  ]);
  await dripBatch.send({
    from: user,
    fee: { paymentMethod: sponsoredFeePayment },
  });

  const minFees = await node.getCurrentMinFees();
  const gasLimits = new Gas(config.daGasLimit, config.l2GasLimit);
  const maxFeesPerGas = new GasFees(minFees.feePerDaGas, minFees.feePerL2Gas);

  return {
    operator,
    operatorSecretHex: config.operatorSecretKey,
    user,
    otherUser,
    wallet,
    node,
    token,
    fpc,
    faucet,
    sponsoredFeePayment,
    gasLimits,
    maxFeesPerGas,
  };
}

async function signQuote(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
  node: AztecNode,
  overrides?: FeeEntrypointOverrides,
): Promise<QuoteInput> {
  const computedFjAmount = computeMaxGasCost(
    result.gasLimits,
    overrides?.maxFeesPerGas ?? result.maxFeesPerGas,
  );
  const { rateNum: configRateNum, rateDen: configRateDen } = getFinalRate(config);
  const rateNum = overrides?.rateNum ?? configRateNum;
  const rateDen = overrides?.rateDen ?? configRateDen;
  const latestTimestamp = await getLatestL2Timestamp(node);
  const validUntil = overrides?.validUntil ?? latestTimestamp + BigInt(MAX_QUOTE_VALIDITY_SECONDS);
  const user = overrides?.payer ?? result.user;
  const fpcAddress = overrides?.fpcAddress ?? result.fpc.address;
  const tokenAddress = overrides?.tokenAddress ?? result.token.address;

  const computedAaPayment = ceilDiv(computedFjAmount * rateNum, rateDen);
  const signedFjAmount = overrides?.fjAmount ?? computedFjAmount;
  const signedAaPayment = overrides?.aaPaymentAmount ?? computedAaPayment;
  const secret = Fr.fromHexString(result.operatorSecretHex);
  const signingKey = deriveSigningKey(secret);
  const schnorr = new Schnorr();
  const quoteHash = await computeInnerAuthWitHash([
    QUOTE_DOMAIN_SEPARATOR,
    fpcAddress.toField(),
    tokenAddress.toField(),
    new Fr(signedFjAmount),
    new Fr(signedAaPayment),
    new Fr(validUntil),
    user.toField(),
  ]);
  const signature = await schnorr.constructSignature(quoteHash.toBuffer(), signingKey);
  return {
    fjAmount: computedFjAmount,
    aaPaymentAmount: computedAaPayment,
    validUntil,
    quoteSigBytes: Array.from(signature.toBuffer()),
  };
}

let config: FullE2EConfig;
let result: DeploymentRuntimeResult;
let node: AztecNode;

describe("fpc full lifecycle e2e", () => {
  beforeAll(async () => {
    config = getConfig();
    result = await setupFromManifest(config);
    node = result.node;
  });

  it("rejects insufficient fee juice", async () => {
    const maxFeesPerGas = new GasFees(result.maxFeesPerGas.feePerDaGas, 2_000_000_000_000n);
    const quote = await signQuote(config, result, node, { maxFeesPerGas });

    const fpcBalance = await getFeeJuiceBalance(result.fpc.address, node);
    expect(quote.fjAmount).toBeGreaterThan(fpcBalance);

    return expect(executeFeePaidTx(result, quote, { maxFeesPerGas })).rejects.toThrow(
      /Invalid tx: Insufficient fee payer balance/,
    );
  });

  it("rejects replayed quote", async () => {
    const quote = await signQuote(config, result, node);
    await executeFeePaidTx(result, quote);

    return expect(executeFeePaidTx(result, quote)).rejects.toThrow(
      /Invalid tx: Existing nullifier/,
    );
  });

  it("rejects expired quote", async () => {
    const latestTimestamp = await getLatestL2Timestamp(node);
    const quote = await signQuote(config, result, node, {
      validUntil: latestTimestamp - 1n,
    });

    return expect(executeFeePaidTx(result, quote)).rejects.toThrow(
      /Assertion failed: quote expired 'anchor_ts <= valid_until'/,
    );
  });

  it("rejects overlong quote ttl", async () => {
    const latestTimestamp = await getLatestL2Timestamp(node);
    const quote = await signQuote(config, result, node, {
      validUntil: latestTimestamp + BigInt(MAX_QUOTE_VALIDITY_SECONDS * 2),
    });

    return expect(executeFeePaidTx(result, quote)).rejects.toThrow(
      /Assertion failed: quote ttl too large 'quote_ttl <= MAX_QUOTE_TTL_SECONDS'/,
    );
  });

  it("rejects quote signed for different sender", async () => {
    const quote = await signQuote(config, result, node, {
      payer: result.otherUser,
    });

    return expect(executeFeePaidTx(result, quote)).rejects.toThrow(
      /Cannot satisfy constraint 'result\[i] == signature\[32 \+ i]'/,
    );
  });

  it("rejects quote signed for wrong FPC address", async () => {
    const quote = await signQuote(config, result, node, {
      fpcAddress: result.faucet.address,
    });

    return expect(executeFeePaidTx(result, quote)).rejects.toThrow(
      /Cannot satisfy constraint 'result\[i] == signature\[32 \+ i]'/,
    );
  });

  it("rejects quote signed for wrong token address", async () => {
    const quote = await signQuote(config, result, node, {
      tokenAddress: result.faucet.address,
    });

    return expect(executeFeePaidTx(result, quote)).rejects.toThrow(
      /Cannot satisfy constraint 'result\[i] == signature\[32 \+ i]'/,
    );
  });

  it("rejects direct fee_entrypoint call outside setup phase", async () => {
    const quote = await signQuote(config, result, node);

    const transferAuthwitNonce = Fr.random();
    const transferCall = await result.token.methods
      .transfer_private_to_private(
        result.user,
        result.operator,
        quote.aaPaymentAmount,
        transferAuthwitNonce,
      )
      .getFunctionCall();
    const transferAuthwit = await result.wallet.createAuthWit(result.user, {
      caller: result.fpc.address,
      call: transferCall,
    });

    return expect(
      result.fpc.methods
        .fee_entrypoint(
          result.token.address,
          transferAuthwitNonce,
          quote.fjAmount,
          quote.aaPaymentAmount,
          quote.validUntil,
          quote.quoteSigBytes,
        )
        .send({
          from: result.user,
          authWitnesses: [transferAuthwit],
          wait: { timeout: 180 },
        }),
    ).rejects.toThrow(
      /Assertion failed: fee_entrypoint must run in setup phase '!self\.context\.in_revertible_phase\(\)'/,
    );
  });

  // --- On-chain chaos / adversarial tests ---

  it("rejects tampered signature", async () => {
    const quote = await signQuote(config, result, node);
    const tampered = [...quote.quoteSigBytes];
    tampered[0] = tampered[0] ^ 0xff;

    return expect(executeFeePaidTx(result, { ...quote, quoteSigBytes: tampered })).rejects.toThrow(
      /is not a valid grumpkin scalar/,
    );
  });

  it("rejects tampered fj amount in quote", async () => {
    const realFj = computeMaxGasCost(result.gasLimits, result.maxFeesPerGas);
    const quote = await signQuote(config, result, node, {
      fjAmount: realFj + 1n,
    });

    return expect(executeFeePaidTx(result, quote)).rejects.toThrow(
      /Cannot satisfy constraint 'result\[i] == signature\[32 \+ i]'/,
    );
  });

  it("rejects tampered aa payment amount in quote", async () => {
    const { rateNum, rateDen } = getFinalRate(config);
    const realFj = computeMaxGasCost(result.gasLimits, result.maxFeesPerGas);
    const realAa = ceilDiv(realFj * rateNum, rateDen);
    const quote = await signQuote(config, result, node, {
      aaPaymentAmount: realAa + 1n,
    });

    return expect(executeFeePaidTx(result, quote)).rejects.toThrow(
      /Cannot satisfy constraint 'result\[i] == signature\[32 \+ i]'/,
    );
  });

  it("rejects fj amount that does not match gas cost", async () => {
    const halved = new GasFees(
      result.maxFeesPerGas.feePerDaGas / 2n,
      result.maxFeesPerGas.feePerL2Gas / 2n,
    );
    const quote = await signQuote(config, result, node, { maxFeesPerGas: halved });

    return expect(executeFeePaidTx(result, quote)).rejects.toThrow(
      /Assertion failed: quoted fee amount mismatch 'fj_fee_amount == max_fee'/,
    );
  });

  it("rejects fee payment when user has insufficient token balance", async () => {
    const quote = await signQuote(config, result, node, {
      rateNum: 1_000_000_000_000n,
    });

    return expect(executeFeePaidTx(result, quote)).rejects.toThrow(
      /Assertion failed: Balance too low 'subtracted > 0'/,
    );
  });

  it("rejects authwit nonce mismatch", async () => {
    const quote = await signQuote(config, result, node);

    return expect(executeFeePaidTx(result, quote, { authwitNonce: Fr.random() })).rejects.toThrow(
      /Unknown auth witness for message hash/,
    );
  });

  it("rejects authwit amount mismatch", async () => {
    const quote = await signQuote(config, result, node);

    return expect(
      executeFeePaidTx(result, quote, {
        authwitAmount: quote.aaPaymentAmount + 1n,
      }),
    ).rejects.toThrow(/Unknown auth witness for message hash/);
  });

  it("rejects signature with wrong length", async () => {
    const quote = await signQuote(config, result, node);
    const truncated = quote.quoteSigBytes.slice(0, 63);

    return expect(executeFeePaidTx(result, { ...quote, quoteSigBytes: truncated })).rejects.toThrow(
      /Undefined argument quote_sig\[63] of type integer/,
    );
  });
});

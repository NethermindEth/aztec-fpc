import path from "node:path";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { BatchCall, type Contract } from "@aztec/aztec.js/contracts";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import type { AztecNode } from "@aztec/aztec.js/node";
import { DefaultEntrypoint } from "@aztec/entrypoints/default";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import { computeInnerAuthWitHash } from "@aztec/stdlib/auth-witness";
import { Gas, GasFees, GasSettings } from "@aztec/stdlib/gas";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { ExecutionPayload, type TxHash, type TxReceipt } from "@aztec/stdlib/tx";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { Hex } from "viem";
import { beforeAll, describe, expect, it } from "#test";
import { deriveAccount, resolveScriptAccounts } from "../common/script-credentials.ts";
import {
  setup as commonSetup,
  type L1Infra,
  mintL1Erc20WithRetry,
  setupL1Infrastructure,
} from "../common/setup-helpers.ts";

const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const HEX_32_BYTE_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const MAX_QUOTE_VALIDITY_SECONDS = 3600;
const COLD_START_QUOTE_DOMAIN_SEPARATOR = Fr.fromHexString("0x46504373");
const COLD_START_GAS_LIMITS = new Gas(5_000, 1_000_000);

type ColdStartValidationConfig = {
  nodeUrl: string;
  l1RpcUrl: string;
  manifestPath: string;
  testTokenManifestPath: string;
  operatorSecretKey: string;
  l1DeployerKey: string;
  userL1PrivateKey: string | undefined;
  claimAmount: bigint;
  feeJuiceTimeoutMs: number;
  messageTimeoutSeconds: number;
  marketRateNum: number;
  marketRateDen: number;
  feeBips: number;
  pxeProverEnabled: boolean;
};

type RuntimeResult = {
  repoRoot: string;
  operator: AztecAddress;
  operatorSecretHex: string;
  user: AztecAddress;
  otherUser: AztecAddress;
  wallet: EmbeddedWallet;
  node: AztecNode;
  token: Contract;
  fpc: Contract;
  faucet: Contract;
  bridge: Contract;
  sponsoredFeePayment: SponsoredFeePaymentMethod;
  gasLimits: Gas;
  maxFeesPerGas: GasFees;
  l1Infra: L1Infra;
  claimSecret: Fr;
  claimSecretHash: Fr;
  messageLeafIndex: bigint;
};

type ColdStartQuoteInput = {
  fjAmount: bigint;
  aaPaymentAmount: bigint;
  validUntil: bigint;
  quoteSigBytes: number[];
};

type ColdStartQuoteOverrides = {
  payer?: AztecAddress;
  validUntil?: bigint;
  fpcAddress?: AztecAddress;
  tokenAddress?: AztecAddress;
  fjAmount?: bigint;
  aaPaymentAmount?: bigint;
  claimAmount?: bigint;
  claimSecretHash?: Fr;
  rateNum?: bigint;
  rateDen?: bigint;
};

type ExecuteColdStartOverrides = {
  maxFeesPerGas?: GasFees;
  bridge?: AztecAddress;
  claimAmount?: bigint;
  claimSecret?: Fr;
  claimSecretHash?: Fr;
  messageLeafIndex?: bigint;
};

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

function getFinalRate(config: ColdStartValidationConfig): {
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value.trim();
}

function readEnvString(name: string): string | undefined {
  const value = process.env[name];
  if (!value || value.trim() === "") return undefined;
  return value.trim();
}

function readEnvPositiveBigInt(name: string, fallback: bigint): bigint {
  const value = process.env[name];
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!POSITIVE_INTEGER_PATTERN.test(trimmed)) {
    throw new Error(`Invalid bigint env var ${name}=${value}`);
  }
  return BigInt(trimmed);
}

function getConfig(): ColdStartValidationConfig {
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
    l1RpcUrl: process.env.L1_RPC_URL ?? "http://localhost:8545",
    manifestPath,
    testTokenManifestPath,
    operatorSecretKey,
    l1DeployerKey: requireEnv("FPC_L1_DEPLOYER_KEY"),
    userL1PrivateKey: readEnvString("FPC_COLD_START_USER_L1_KEY"),
    claimAmount: readEnvPositiveBigInt("FPC_COLD_START_CLAIM_AMOUNT", 10_000_000_000_000_000n),
    feeJuiceTimeoutMs: readEnvPositiveInteger("FPC_FULL_E2E_FEE_JUICE_TIMEOUT_MS", 240_000),
    messageTimeoutSeconds: readEnvPositiveInteger("FPC_SMOKE_MESSAGE_TIMEOUT_SECONDS", 120),
    marketRateNum: readEnvPositiveInteger("FPC_FULL_E2E_MARKET_RATE_NUM", 1),
    marketRateDen: readEnvPositiveInteger("FPC_FULL_E2E_MARKET_RATE_DEN", 1000),
    feeBips,
    pxeProverEnabled:
      process.env.PXE_PROVER_ENABLED !== "0" && process.env.PXE_PROVER_ENABLED !== "false",
  };
}

async function signColdStartQuote(
  config: ColdStartValidationConfig,
  result: RuntimeResult,
  node: AztecNode,
  overrides?: ColdStartQuoteOverrides,
): Promise<ColdStartQuoteInput> {
  const computedFjAmount = computeMaxGasCost(result.gasLimits, result.maxFeesPerGas);
  const { rateNum: configRateNum, rateDen: configRateDen } = getFinalRate(config);
  const rateNum = overrides?.rateNum ?? configRateNum;
  const rateDen = overrides?.rateDen ?? configRateDen;
  const latestTimestamp = await getLatestL2Timestamp(node);
  const validUntil = overrides?.validUntil ?? latestTimestamp + BigInt(MAX_QUOTE_VALIDITY_SECONDS);
  const user = overrides?.payer ?? result.user;
  const fpcAddress = overrides?.fpcAddress ?? result.fpc.address;
  const tokenAddress = overrides?.tokenAddress ?? result.token.address;
  const claimAmount = overrides?.claimAmount ?? config.claimAmount;
  const claimSecretHash = overrides?.claimSecretHash ?? result.claimSecretHash;

  const computedAaPayment = ceilDiv(computedFjAmount * rateNum, rateDen);
  const signedFjAmount = overrides?.fjAmount ?? computedFjAmount;
  const signedAaPayment = overrides?.aaPaymentAmount ?? computedAaPayment;

  const secret = Fr.fromHexString(result.operatorSecretHex);
  const signingKey = deriveSigningKey(secret);
  const schnorr = new Schnorr();
  const quoteHash = await computeInnerAuthWitHash([
    COLD_START_QUOTE_DOMAIN_SEPARATOR,
    fpcAddress.toField(),
    tokenAddress.toField(),
    new Fr(signedFjAmount),
    new Fr(signedAaPayment),
    new Fr(validUntil),
    user.toField(),
    new Fr(claimAmount),
    claimSecretHash,
  ]);
  const signature = await schnorr.constructSignature(quoteHash.toBuffer(), signingKey);
  return {
    fjAmount: computedFjAmount,
    aaPaymentAmount: computedAaPayment,
    validUntil,
    quoteSigBytes: Array.from(signature.toBuffer()),
  };
}

const TX_MINE_POLL_MS = 1_000;
const TX_TIMEOUT_MS = 180_000;

async function waitForTx(node: AztecNode, txHash: TxHash): Promise<TxReceipt> {
  const deadline = Date.now() + TX_TIMEOUT_MS;
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

async function executeColdStartTx(
  result: RuntimeResult,
  config: ColdStartValidationConfig,
  quote: ColdStartQuoteInput,
  overrides?: ExecuteColdStartOverrides,
): Promise<TxReceipt> {
  const bridge = overrides?.bridge ?? result.bridge.address;
  const claimAmount = overrides?.claimAmount ?? config.claimAmount;
  const claimSecret = overrides?.claimSecret ?? result.claimSecret;
  const claimSecretHash = overrides?.claimSecretHash ?? result.claimSecretHash;
  const messageLeafIndex = overrides?.messageLeafIndex ?? result.messageLeafIndex;
  const maxFeesPerGas = overrides?.maxFeesPerGas ?? result.maxFeesPerGas;

  const coldStartCall = await result.fpc.methods
    .cold_start_entrypoint(
      result.user,
      result.token.address,
      bridge,
      claimAmount,
      claimSecret,
      claimSecretHash,
      new Fr(messageLeafIndex),
      quote.fjAmount,
      quote.aaPaymentAmount,
      quote.validUntil,
      quote.quoteSigBytes,
    )
    .getFunctionCall();

  const payload = new ExecutionPayload([coldStartCall], [], [], [], result.fpc.address);
  const gasSettings = GasSettings.default({
    maxFeesPerGas,
    gasLimits: result.gasLimits,
    teardownGasLimits: Gas.empty(),
  });

  const chainInfo = await result.wallet.getChainInfo();
  const entrypoint = new DefaultEntrypoint();
  const txRequest = await entrypoint.createTxExecutionRequest(payload, gasSettings, chainInfo);

  // biome-ignore lint/suspicious/noExplicitAny: EmbeddedWallet exposes PXE as a protected member
  const pxe = (result.wallet as any).pxe;
  const provingResult = await pxe.proveTx(txRequest, [
    result.user,
    result.operator,
    result.fpc.address,
  ]);

  const tx = await provingResult.toTx();
  await result.node.sendTx(tx);
  return waitForTx(result.node, tx.txHash);
}

async function setupFromManifest(config: ColdStartValidationConfig): Promise<RuntimeResult> {
  const repoRoot = path.resolve(import.meta.dirname, "../..");

  const { testTokenManifest, node, wallet, operator, contracts, sponsoredFpcAddress } =
    await commonSetup(
      {
        nodeUrl: config.nodeUrl,
        manifestPath: config.manifestPath,
        testTokenManifestPath: config.testTokenManifestPath,
        proverEnabled: config.pxeProverEnabled,
        messageTimeoutSeconds: Math.ceil(config.feeJuiceTimeoutMs / 1_000),
      },
      repoRoot,
      "cold-start-validation",
    );

  const { token, fpc, faucet, bridge } = contracts;
  const sponsoredFeePayment = new SponsoredFeePaymentMethod(sponsoredFpcAddress);

  const userData = await deriveAccount(Fr.random(), wallet);
  const otherUserData = await deriveAccount(Fr.random(), wallet);
  const user = userData.address;
  const otherUser = otherUserData.address;

  const deployBatch = new BatchCall(wallet, [
    await userData.accountManager.getDeployMethod(),
    await otherUserData.accountManager.getDeployMethod(),
  ]);
  await deployBatch.send({
    from: AztecAddress.ZERO,
    fee: { paymentMethod: sponsoredFeePayment },
  });

  let l1PrivateKey: Hex;
  if (config.userL1PrivateKey) {
    l1PrivateKey = config.userL1PrivateKey as Hex;
  } else {
    ({ l1PrivateKey } = await resolveScriptAccounts(config.nodeUrl, config.l1RpcUrl, wallet, 0));
  }

  const l1Infra = await setupL1Infrastructure({
    l1RpcUrl: config.l1RpcUrl,
    l1PrivateKey,
    l1DeployerKey: config.l1DeployerKey,
    l1PortalAddress: testTokenManifest.l1_contracts.token_portal,
    l1Erc20Address: testTokenManifest.l1_contracts.erc20,
    node,
    loggerName: "cold-start-validation:bridge",
  });

  const { l1WalletClient, l1Erc20, portalManager } = l1Infra;
  await mintL1Erc20WithRetry(
    l1Erc20,
    l1WalletClient,
    l1WalletClient.account.address,
    config.claimAmount,
  );

  const bridgeClaim = await portalManager.bridgeTokensPrivate(user, config.claimAmount, false);
  const bridgeMsgHash = Fr.fromHexString(bridgeClaim.messageHash as string);
  await waitForL1ToL2MessageReady(node, bridgeMsgHash, {
    timeoutSeconds: config.messageTimeoutSeconds,
  });

  const minFees = await node.getCurrentMinFees();
  const gasLimits = COLD_START_GAS_LIMITS;
  const maxFeesPerGas = new GasFees(minFees.feePerDaGas, minFees.feePerL2Gas);

  return {
    repoRoot,
    operator,
    operatorSecretHex: config.operatorSecretKey,
    user,
    otherUser,
    wallet,
    node,
    token,
    fpc,
    faucet,
    bridge,
    sponsoredFeePayment,
    gasLimits,
    maxFeesPerGas,
    l1Infra,
    claimSecret: bridgeClaim.claimSecret,
    claimSecretHash: bridgeClaim.claimSecretHash,
    messageLeafIndex: bridgeClaim.messageLeafIndex,
  };
}

let config: ColdStartValidationConfig;
let result: RuntimeResult;
let node: AztecNode;

describe("cold-start entrypoint validation", () => {
  beforeAll(async () => {
    config = getConfig();
    result = await setupFromManifest(config);
    node = result.node;
  });

  it("rejects expired quote", async () => {
    const latestTimestamp = await getLatestL2Timestamp(node);
    const quote = await signColdStartQuote(config, result, node, {
      validUntil: latestTimestamp - 1n,
    });

    return expect(executeColdStartTx(result, config, quote)).rejects.toThrow(
      /Assertion failed: quote expired 'anchor_ts <= valid_until'/,
    );
  });

  it("rejects overlong quote ttl", async () => {
    const latestTimestamp = await getLatestL2Timestamp(node);
    const quote = await signColdStartQuote(config, result, node, {
      validUntil: latestTimestamp + BigInt(MAX_QUOTE_VALIDITY_SECONDS * 2),
    });

    return expect(executeColdStartTx(result, config, quote)).rejects.toThrow(
      /Assertion failed: quote ttl too large 'quote_ttl <= MAX_QUOTE_TTL_SECONDS'/,
    );
  });

  it("rejects quote signed for different sender", async () => {
    const quote = await signColdStartQuote(config, result, node, {
      payer: result.otherUser,
    });

    return expect(executeColdStartTx(result, config, quote)).rejects.toThrow(
      /Cannot satisfy constraint 'result\[i] == signature\[32 \+ i]'/,
    );
  });

  it("rejects quote signed for wrong FPC address", async () => {
    const quote = await signColdStartQuote(config, result, node, {
      fpcAddress: result.faucet.address,
    });

    return expect(executeColdStartTx(result, config, quote)).rejects.toThrow(
      /Cannot satisfy constraint 'result\[i] == signature\[32 \+ i]'/,
    );
  });

  it("rejects quote signed for wrong token address", async () => {
    const quote = await signColdStartQuote(config, result, node, {
      tokenAddress: result.faucet.address,
    });

    return expect(executeColdStartTx(result, config, quote)).rejects.toThrow(
      /Cannot satisfy constraint 'result\[i] == signature\[32 \+ i]'/,
    );
  });

  it("rejects tampered signature", async () => {
    const quote = await signColdStartQuote(config, result, node);
    const tampered = [...quote.quoteSigBytes];
    tampered[0] = tampered[0] ^ 0xff;

    return expect(
      executeColdStartTx(result, config, { ...quote, quoteSigBytes: tampered }),
    ).rejects.toThrow(/is not a valid grumpkin scalar/);
  });

  it("rejects tampered fj amount in quote", async () => {
    const realFj = computeMaxGasCost(result.gasLimits, result.maxFeesPerGas);
    const quote = await signColdStartQuote(config, result, node, {
      fjAmount: realFj + 1n,
    });

    return expect(executeColdStartTx(result, config, quote)).rejects.toThrow(
      /Cannot satisfy constraint 'result\[i] == signature\[32 \+ i]'/,
    );
  });

  it("rejects tampered aa payment amount in quote", async () => {
    const { rateNum, rateDen } = getFinalRate(config);
    const realFj = computeMaxGasCost(result.gasLimits, result.maxFeesPerGas);
    const realAa = ceilDiv(realFj * rateNum, rateDen);
    const quote = await signColdStartQuote(config, result, node, {
      aaPaymentAmount: realAa + 1n,
    });

    return expect(executeColdStartTx(result, config, quote)).rejects.toThrow(
      /Cannot satisfy constraint 'result\[i] == signature\[32 \+ i]'/,
    );
  });

  it("rejects fj amount that does not match gas cost", async () => {
    const halved = new GasFees(
      result.maxFeesPerGas.feePerDaGas / 2n,
      result.maxFeesPerGas.feePerL2Gas / 2n,
    );
    const quote = await signColdStartQuote(config, result, node);

    return expect(
      executeColdStartTx(result, config, quote, { maxFeesPerGas: halved }),
    ).rejects.toThrow(/Assertion failed: quoted fee amount mismatch 'fj_fee_amount == max_fee'/);
  });

  it("rejects replayed quote", async () => {
    const quote = await signColdStartQuote(config, result, node);
    await executeColdStartTx(result, config, quote);

    // The replay may fail with a nullifier collision (on-chain) or with the
    // bridge message already consumed (at PXE proving time), depending on
    // which check is reached first.
    return expect(executeColdStartTx(result, config, quote)).rejects.toThrow(
      /Invalid tx: Existing nullifier|No non-nullified L1 to L2 message found/,
    );
  });

  it("rejects signature with wrong length", async () => {
    const quote = await signColdStartQuote(config, result, node);
    const truncated = quote.quoteSigBytes.slice(0, 63);

    return expect(
      executeColdStartTx(result, config, { ...quote, quoteSigBytes: truncated }),
    ).rejects.toThrow(/Undefined argument quote_sig\[63] of type integer/);
  });

  it("rejects claim insufficient to cover fee", async () => {
    const { rateNum, rateDen } = getFinalRate(config);
    const realFj = computeMaxGasCost(result.gasLimits, result.maxFeesPerGas);
    const realAa = ceilDiv(realFj * rateNum, rateDen);
    const tinyClaimAmount = realAa - 1n;
    const quote = await signColdStartQuote(config, result, node, {
      claimAmount: tinyClaimAmount,
    });

    return expect(
      executeColdStartTx(result, config, quote, { claimAmount: tinyClaimAmount }),
    ).rejects.toThrow(
      /Assertion failed: claim insufficient to cover fee 'claim_amount >= aa_payment_amount'/,
    );
  });

  it("rejects tampered claim amount", async () => {
    const quote = await signColdStartQuote(config, result, node, {
      claimAmount: config.claimAmount + 1n,
    });

    return expect(executeColdStartTx(result, config, quote)).rejects.toThrow(
      /Cannot satisfy constraint 'result\[i] == signature\[32 \+ i]'/,
    );
  });

  it("rejects tampered claim secret hash", async () => {
    const quote = await signColdStartQuote(config, result, node, {
      claimSecretHash: Fr.random(),
    });

    return expect(executeColdStartTx(result, config, quote)).rejects.toThrow(
      /Cannot satisfy constraint 'result\[i] == signature\[32 \+ i]'/,
    );
  });

  it("rejects cold_start_entrypoint called through account entrypoint", async () => {
    const quote = await signColdStartQuote(config, result, node);

    return expect(
      result.fpc.methods
        .cold_start_entrypoint(
          result.user,
          result.token.address,
          result.bridge.address,
          config.claimAmount,
          result.claimSecret,
          result.claimSecretHash,
          new Fr(result.messageLeafIndex),
          quote.fjAmount,
          quote.aaPaymentAmount,
          quote.validUntil,
          quote.quoteSigBytes,
        )
        .send({
          from: result.user,
          wait: { timeout: 180 },
        }),
    ).rejects.toThrow(/Assertion failed: must be tx entrypoint/);
  });
});

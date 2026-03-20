import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import pino from "pino";

const pinoLogger = pino();

import type { ContractArtifact } from "@aztec/aztec.js/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { BatchCall, Contract, type TxSendResultMined } from "@aztec/aztec.js/contracts";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import { type AztecNode, createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { ProtocolContractAddress } from "@aztec/aztec.js/protocol";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { SPONSORED_FPC_SALT } from "@aztec/constants";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC";
import { loadContractArtifact, loadContractArtifactForPublic } from "@aztec/stdlib/abi";
import { computeInnerAuthWitHash } from "@aztec/stdlib/auth-witness";
import { getContractInstanceFromInstantiationParams } from "@aztec/stdlib/contract";
import { Gas, GasFees } from "@aztec/stdlib/gas";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
import { ExecutionPayload, type TxReceipt } from "@aztec/stdlib/tx";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { DevnetDeployManifest } from "@aztec-fpc/contract-deployment/src/devnet-manifest.ts";
import { sleep } from "../common/managed-process.ts";
import { deriveAccount } from "../common/script-credentials.ts";

type FullE2EConfig = {
  nodeUrl: string;
  manifestPath: string;
  operatorSecretKey: string;
  feeJuiceTimeoutMs: number;
  feeJuicePollMs: number;
  marketRateNum: number;
  marketRateDen: number;
  feeBips: number;
  daGasLimit: number;
  l2GasLimit: number;
};

type DeploymentRuntimeResult = {
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

const tokenArtifactPath = "token_contract-Token.json";
const fpcArtifactPath = "fpc-FPCMultiAsset.json";
const faucetArtifactPath = "faucet-Faucet.json";

function printHelp(): void {
  pinoLogger.info(`Usage: bun run e2e:full-lifecycle:fpc:local [--help]

Required env vars:
- FPC_COLD_START_MANIFEST — deployment manifest path
- FPC_OPERATOR_SECRET_KEY — operator 0x-prefixed 32-byte hex secret

Optional env vars:
- AZTEC_NODE_URL (default: http://localhost:8080)
- FPC_FULL_E2E_FEE_JUICE_TIMEOUT_MS (default: 240000)
- FPC_FULL_E2E_FEE_JUICE_POLL_MS (default: 2000)
- FPC_FULL_E2E_DA_GAS_LIMIT (default: 200000)
- FPC_FULL_E2E_L2_GAS_LIMIT (default: 1000000)
- FPC_FULL_E2E_MARKET_RATE_NUM (default: 1)
- FPC_FULL_E2E_MARKET_RATE_DEN (default: 1000)
- FPC_FULL_E2E_FEE_BIPS (default: 200)
`);
}

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

function loadArtifact(artifactPath: string): ContractArtifact {
  const raw = readFileSync(artifactPath, "utf8");
  const parsed = JSON.parse(raw) as NoirCompiledContract;
  try {
    return loadContractArtifact(parsed);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Contract's public bytecode has not been transpiled")
    ) {
      return loadContractArtifactForPublic(parsed);
    }
    throw error;
  }
}

async function registerAndGet(
  node: AztecNode,
  wallet: EmbeddedWallet,
  address: AztecAddress,
  artifact: ContractArtifact,
) {
  const instance = await node.getContract(address);
  if (!instance) {
    throw new Error(`Contract not found on node: ${address.toString()}`);
  }
  await wallet.registerContract(instance, artifact);
  return Contract.at(address, artifact, wallet);
}

async function waitForPositiveFeeJuiceBalance(
  node: AztecNode,
  feePayerAddress: AztecAddress,
  timeoutMs: number,
  pollMs: number,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const balance = await getFeeJuiceBalance(feePayerAddress, node);
    if (balance > 0n) {
      return balance;
    }
    await sleep(pollMs);
  }
  throw new Error(
    `Timed out waiting for positive Fee Juice balance on ${feePayerAddress.toString()}`,
  );
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
};

async function executeFeePaidTx(
  result: DeploymentRuntimeResult,
  quote: QuoteInput,
  maxFeesPerGas?: GasFees,
): Promise<TxSendResultMined<TxReceipt>> {
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

  const feeEntrypointCall = await result.fpc.methods
    .fee_entrypoint(
      result.token.address,
      transferAuthwitNonce,
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
          maxFeesPerGas: maxFeesPerGas ?? result.maxFeesPerGas,
        },
      },
      wait: { timeout: 180 },
    });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

async function expectFailure(
  scenario: string,
  expectedSubstrings: string[],
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = errorMessage(error).toLowerCase();
    if (expectedSubstrings.some((fragment) => message.includes(fragment.toLowerCase()))) {
      pinoLogger.info(`[full-lifecycle-e2e] PASS: ${scenario}`);
      return;
    }
    throw new Error(
      `[full-lifecycle-e2e] ${scenario} failed with unexpected error: ${errorMessage(error)}`,
    );
  }
  throw new Error(`[full-lifecycle-e2e] ${scenario} unexpectedly succeeded`);
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
  const operatorSecretKey = requireEnv("FPC_OPERATOR_SECRET_KEY");
  assertPrivateKeyHex(operatorSecretKey, "FPC_OPERATOR_SECRET_KEY");
  const feeBips = readEnvPositiveInteger("FPC_FULL_E2E_FEE_BIPS", 200);
  if (feeBips > 10_000) {
    throw new Error(`FPC_FULL_E2E_FEE_BIPS must be <= 10000, got ${feeBips}`);
  }

  return {
    nodeUrl: process.env.AZTEC_NODE_URL ?? "http://localhost:8080",
    manifestPath,
    operatorSecretKey,
    feeJuiceTimeoutMs: readEnvPositiveInteger("FPC_FULL_E2E_FEE_JUICE_TIMEOUT_MS", 240_000),
    feeJuicePollMs: readEnvPositiveInteger("FPC_FULL_E2E_FEE_JUICE_POLL_MS", 2_000),
    marketRateNum: readEnvPositiveInteger("FPC_FULL_E2E_MARKET_RATE_NUM", 1),
    marketRateDen: readEnvPositiveInteger("FPC_FULL_E2E_MARKET_RATE_DEN", 1000),
    feeBips,
    daGasLimit: readEnvPositiveInteger("FPC_FULL_E2E_DA_GAS_LIMIT", 200_000),
    l2GasLimit: readEnvPositiveInteger("FPC_FULL_E2E_L2_GAS_LIMIT", 1_000_000),
  };
}

async function setupFromManifest(config: FullE2EConfig): Promise<DeploymentRuntimeResult> {
  const repoRoot = path.resolve(import.meta.dirname, "../..");

  // Read pre-deployed contract addresses from manifest.
  if (!existsSync(config.manifestPath)) {
    throw new Error(`Manifest not found: ${config.manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(config.manifestPath, "utf8")) as DevnetDeployManifest;
  if (!manifest.contracts.faucet) {
    throw new Error(`Faucet contract not found in manifest: ${config.manifestPath}`);
  }

  const fpcAddress = AztecAddress.fromString(manifest.contracts.fpc);
  const tokenAddress = AztecAddress.fromString(manifest.contracts.accepted_asset);
  const faucetAddress = AztecAddress.fromString(manifest.contracts.faucet);

  pinoLogger.info(
    `[full-lifecycle-e2e] manifest loaded: fpc=${manifest.contracts.fpc}, token=${manifest.contracts.accepted_asset}`,
  );

  // Connect to node and create wallet.
  const node = createAztecNodeClient(config.nodeUrl);
  await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node);

  // Derive operator account and ensure it is deployed on-chain.
  const operatorSecretFr = Fr.fromHexString(config.operatorSecretKey);
  const operatorData = await deriveAccount(operatorSecretFr, wallet);
  const operator = operatorData.address;
  const operatorSecretHex = config.operatorSecretKey;

  // Derive fresh user and otherUser for negative scenarios.
  const userData = await deriveAccount(Fr.random(), wallet);
  const otherUserData = await deriveAccount(Fr.random(), wallet);
  const user = userData.address;
  const otherUser = otherUserData.address;

  const tokenArtifact = loadArtifact(path.join(repoRoot, "target", tokenArtifactPath));
  const fpcArtifact = loadArtifact(path.join(repoRoot, "target", fpcArtifactPath));
  const faucetArtifact = loadArtifact(path.join(repoRoot, "target", faucetArtifactPath));

  const token = await registerAndGet(node, wallet, tokenAddress, tokenArtifact);
  const fpc = await registerAndGet(node, wallet, fpcAddress, fpcArtifact);
  const faucet = await registerAndGet(node, wallet, faucetAddress, faucetArtifact);

  // Register the canonical SponsoredFPC contract.
  const sponsoredFpcInstance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContractArtifact,
    { salt: new Fr(SPONSORED_FPC_SALT) },
  );
  await wallet.registerContract(sponsoredFpcInstance, SponsoredFPCContractArtifact);
  const sponsoredFeePayment = new SponsoredFeePaymentMethod(sponsoredFpcInstance.address);

  // Deploy user and otherUser accounts via SponsoredFPC (batched).
  const deployBatch = new BatchCall(wallet, [
    await userData.accountManager.getDeployMethod(),
    await otherUserData.accountManager.getDeployMethod(),
  ]);
  await deployBatch.send({
    from: AztecAddress.ZERO,
    fee: { paymentMethod: sponsoredFeePayment },
  });
  pinoLogger.info("[full-lifecycle-e2e] user + otherUser accounts deployed via SponsoredFPC");

  // Fund user via faucet drip + shield (batched via SponsoredFPC).
  const { result: faucetConfig } = await faucet.methods.get_config().simulate({ from: user });
  const dripAmount = BigInt(faucetConfig.drip_amount.toString());
  const shieldAmount = dripAmount;
  const dripBatch = new BatchCall(wallet, [
    faucet.methods.drip(user),
    token.methods.transfer_public_to_private(user, user, shieldAmount, Fr.random()),
  ]);
  await dripBatch.send({
    from: user,
    fee: { paymentMethod: sponsoredFeePayment },
  });
  pinoLogger.info(
    `[full-lifecycle-e2e] user funded via faucet (drip=${dripAmount}, shielded=${shieldAmount})`,
  );

  const minFees = await node.getCurrentMinFees();
  const gasLimits = new Gas(config.daGasLimit, config.l2GasLimit);
  const maxFeesPerGas = new GasFees(minFees.feePerDaGas, minFees.feePerL2Gas);

  return {
    repoRoot,
    operator,
    operatorSecretHex,
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
  const fjAmount = computeMaxGasCost(
    result.gasLimits,
    overrides?.maxFeesPerGas ?? result.maxFeesPerGas,
  );
  const { rateNum, rateDen } = getFinalRate(config);
  const latestTimestamp = await getLatestL2Timestamp(node);
  const validUntil = overrides?.validUntil ?? latestTimestamp + BigInt(MAX_QUOTE_VALIDITY_SECONDS);
  const user = overrides?.payer ?? result.user;
  const fpcAddress = overrides?.fpcAddress ?? result.fpc.address;
  const tokenAddress = overrides?.tokenAddress ?? result.token.address;

  const aaPaymentAmount = ceilDiv(fjAmount * rateNum, rateDen);
  const secret = Fr.fromHexString(result.operatorSecretHex);
  const signingKey = deriveSigningKey(secret);
  const schnorr = new Schnorr();
  const quoteHash = await computeInnerAuthWitHash([
    QUOTE_DOMAIN_SEPARATOR,
    fpcAddress.toField(),
    tokenAddress.toField(),
    new Fr(fjAmount),
    new Fr(aaPaymentAmount),
    new Fr(validUntil),
    user.toField(),
  ]);
  const signature = await schnorr.constructSignature(quoteHash.toBuffer(), signingKey);
  return {
    fjAmount,
    aaPaymentAmount,
    validUntil,
    quoteSigBytes: Array.from(signature.toBuffer()),
  };
}

async function negativeQuoteReplayRejected(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
  node: AztecNode,
): Promise<void> {
  const quote = await signQuote(config, result, node);

  await executeFeePaidTx(result, quote);

  await expectFailure(
    "negative quote replay rejected",
    ["nullifier", "already exists", "duplicate"],
    () => executeFeePaidTx(result, quote),
  );
}

async function negativeExpiredQuoteRejected(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
  node: AztecNode,
): Promise<void> {
  const latestTimestamp = await getLatestL2Timestamp(node);
  const quote = await signQuote(config, result, node, {
    validUntil: latestTimestamp - 1n,
  });

  await expectFailure("negative expired quote rejected", ["quote expired"], () =>
    executeFeePaidTx(result, quote),
  );
}

async function negativeOverlongTtlRejected(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
  node: AztecNode,
): Promise<void> {
  const latestTimestamp = await getLatestL2Timestamp(node);
  const quote = await signQuote(config, result, node, {
    validUntil: latestTimestamp + BigInt(MAX_QUOTE_VALIDITY_SECONDS * 2),
  });

  await expectFailure("negative overlong quote ttl rejected", ["quote ttl too large"], () =>
    executeFeePaidTx(result, quote),
  );
}

async function negativeSenderBindingRejected(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
  node: AztecNode,
): Promise<void> {
  const quote = await signQuote(config, result, node, {
    payer: result.otherUser,
  });

  await expectFailure(
    "negative quote sender binding rejected",
    ["invalid quote signature", "Cannot satisfy constraint"],
    () => executeFeePaidTx(result, quote),
  );
}

async function negativeWrongFpcRejected(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
  node: AztecNode,
): Promise<void> {
  // Sign a quote bound to the faucet address instead of the real FPC.
  // The FPC contract verifies the signature against its own address, so it should reject.
  const quote = await signQuote(config, result, node, {
    fpcAddress: result.faucet.address,
  });

  await expectFailure(
    "negative wrong FPC address rejected",
    ["invalid quote signature", "Cannot satisfy constraint"],
    () => executeFeePaidTx(result, quote),
  );
}

async function negativeWrongTokenRejected(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
  node: AztecNode,
): Promise<void> {
  // Sign a quote bound to the faucet address instead of the real token.
  // The FPC contract verifies the signature against the actual accepted_asset, so it should reject.
  const quote = await signQuote(config, result, node, {
    tokenAddress: result.faucet.address,
  });

  await expectFailure(
    "negative wrong token address rejected",
    ["invalid quote signature", "Cannot satisfy constraint"],
    () => executeFeePaidTx(result, quote),
  );
}

async function negativeDirectEntrypointCallRejected(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
  node: AztecNode,
): Promise<void> {
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

  await expectFailure(
    "negative direct fee_entrypoint call rejected outside setup phase",
    ["must run in setup phase"],
    () =>
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
  );
}

async function negativeInsufficientFeeJuiceRejected(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
  node: AztecNode,
): Promise<void> {
  // Use extremely high gas limits so the fee exceeds the FPC's Fee Juice balance.
  const maxFeesPerGas = new GasFees(result.maxFeesPerGas.feePerDaGas, 2_000_000_000_000n);
  const quote = await signQuote(config, result, node, { maxFeesPerGas });

  const fpcBalance = await getFeeJuiceBalance(result.fpc.address, node);
  if (quote.fjAmount <= fpcBalance) {
    throw new Error(
      `Cannot test insufficient Fee Juice: excessive fee ${quote.fjAmount} does not exceed FPC balance ${fpcBalance}`,
    );
  }

  await expectFailure(
    "negative insufficient fee juice rejected",
    [
      "insufficient fee payer balance",
      "fee payer balance",
      "insufficient fee payer",
      "not enough fee",
    ],
    () => executeFeePaidTx(result, quote, maxFeesPerGas),
  );
}

async function runNegativeScenarios(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
  node: AztecNode,
): Promise<void> {
  await negativeInsufficientFeeJuiceRejected(config, result, node);
  await negativeQuoteReplayRejected(config, result, node);
  await negativeExpiredQuoteRejected(config, result, node);
  await negativeOverlongTtlRejected(config, result, node);
  await negativeSenderBindingRejected(config, result, node);
  await negativeWrongFpcRejected(config, result, node);
  await negativeWrongTokenRejected(config, result, node);
  await negativeDirectEntrypointCallRejected(config, result, node);
}

async function runOrchestration(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
): Promise<void> {
  const node = result.node;

  pinoLogger.info("[full-lifecycle-e2e] waiting for FPC Fee Juice balance > 0 (via topup service)");
  const feeJuiceBalance = await waitForPositiveFeeJuiceBalance(
    node,
    result.fpc.address,
    config.feeJuiceTimeoutMs,
    config.feeJuicePollMs,
  );
  pinoLogger.info(`[full-lifecycle-e2e] PASS: FPC has Fee Juice (fee_juice=${feeJuiceBalance})`);

  await runNegativeScenarios(config, result, node);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  const config = getConfig();
  pinoLogger.info(
    `[full-lifecycle-e2e] Config loaded: nodeUrl=${config.nodeUrl}, manifest=${config.manifestPath}`,
  );

  const result = await setupFromManifest(config);
  pinoLogger.info(`[full-lifecycle-e2e] operator=${result.operator.toString()}`);
  pinoLogger.info(`[full-lifecycle-e2e] user=${result.user.toString()}`);
  pinoLogger.info(`[full-lifecycle-e2e] other_user=${result.otherUser.toString()}`);
  pinoLogger.info(`[full-lifecycle-e2e] token=${result.token.address.toString()}`);
  pinoLogger.info(`[full-lifecycle-e2e] fpc=${result.fpc.address.toString()}`);
  pinoLogger.info("[full-lifecycle-e2e] PASS: setup from manifest complete");

  await runOrchestration(config, result);
  pinoLogger.info("[full-lifecycle-e2e] PASS: all negative scenarios passed");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  pinoLogger.error(`[full-lifecycle-e2e] FAIL: ${message}`);
  process.exitCode = 1;
});

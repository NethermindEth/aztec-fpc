import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import pino from "pino";

const pinoLogger = pino();

import type { ContractArtifact } from "@aztec/aztec.js/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { computeInnerAuthWitHash } from "@aztec/aztec.js/authorization";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { FeeJuiceContract, ProtocolContractAddress } from "@aztec/aztec.js/protocol";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import { loadContractArtifact, loadContractArtifactForPublic } from "@aztec/stdlib/abi";
import { computeSecretHash } from "@aztec/stdlib/hash";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
import { ExecutionPayload } from "@aztec/stdlib/tx";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { deployContract } from "@aztec-fpc/contract-deployment/src/deploy-utils.ts";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  type Hex,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveScriptAccounts } from "../../../scripts/common/script-credentials.ts";

const QUOTE_DOMAIN_SEPARATOR = Fr.fromHexString("0x465043");
const FEE_JUICE_TOPUP_SAFETY_MULTIPLIER = 5n;
const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const FEE_JUICE_PORTAL_ABI = parseAbi([
  "function depositToAztecPublic(bytes32 to, uint256 amount, bytes32 secretHash) returns (bytes32, uint256)",
  "event DepositToAztecPublic(bytes32 indexed to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)",
]);
const FPC_ARTIFACT_FILE_CANDIDATES = ["fpc-FPCMultiAsset.json", "fpc-FPC.json"] as const;

type SmokeConfig = {
  nodeUrl: string;
  nodeTimeoutMs: number;
  l1RpcUrl: string;
  l1PrivateKey: Hex;
  feeJuiceTopupWei: bigint | null;
  feeJuiceWaitTimeoutMs: number;
  rateNum: bigint;
  rateDen: bigint;
  quoteTtlSeconds: bigint;
  daGasLimit: number;
  l2GasLimit: number;
  feePerDaGasOverride: bigint | null;
  feePerL2GasOverride: bigint | null;
};

function readEnvBigInt(name: string, fallback: bigint): bigint {
  const value = process.env[name];
  if (!value) return fallback;
  return BigInt(value);
}

function readOptionalEnvBigInt(name: string): bigint | null {
  const value = process.env[name];
  return value ? BigInt(value) : null;
}

function readEnvNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric env var ${name}=${value}`);
  }
  return parsed;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

async function expectFailure(
  scenario: string,
  expectedSubstrings: string[],
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    const normalized = message.toLowerCase();
    if (expectedSubstrings.some((needle) => normalized.includes(needle.toLowerCase()))) {
      pinoLogger.info(`[smoke] PASS: ${scenario}`);
      return;
    }
    throw new Error(`${scenario} failed with unexpected error: ${message}`);
  }
  throw new Error(`${scenario} unexpectedly succeeded`);
}

function normalizeHexAddress(value: unknown, fieldName: string): Hex {
  if (typeof value === "string") {
    return value as Hex;
  }
  if (
    value &&
    typeof value === "object" &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    return value.toString() as Hex;
  }
  throw new Error(`Invalid L1 address in node info for ${fieldName}`);
}

function loadArtifact(artifactPath: string): ContractArtifact {
  const raw = readFileSync(artifactPath, "utf8");
  const parsed = JSON.parse(raw) as NoirCompiledContract;
  try {
    return loadContractArtifact(parsed);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes("Contract's public bytecode has not been transpiled")
    ) {
      return loadContractArtifactForPublic(parsed);
    }
    throw err;
  }
}

function resolveFpcArtifactPath(repoRoot: string): string {
  const explicitPath = process.env.FPC_FPC_ARTIFACT;
  if (explicitPath && explicitPath.trim().length > 0) {
    return path.resolve(explicitPath);
  }

  for (const artifactFile of FPC_ARTIFACT_FILE_CANDIDATES) {
    const candidatePath = path.join(repoRoot, "target", artifactFile);
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  const fallback = path.join(repoRoot, "target", FPC_ARTIFACT_FILE_CANDIDATES[0]);
  throw new Error(
    `FPC artifact not found. Looked for ${FPC_ARTIFACT_FILE_CANDIDATES.map((entry) => path.join(repoRoot, "target", entry)).join(", ")}. Set FPC_FPC_ARTIFACT to override. Default fallback path: ${fallback}`,
  );
}

function getConfig(): SmokeConfig {
  const nodeUrl = process.env.AZTEC_NODE_URL ?? "http://localhost:8080";
  const nodeTimeoutMs = readEnvNumber("FPC_SMOKE_NODE_TIMEOUT_MS", 30_000);
  const l1RpcUrl = process.env.FPC_SMOKE_L1_RPC_URL ?? "http://localhost:8545";
  const l1PrivateKey = "" as Hex; // Set by resolveScriptAccounts
  const feeJuiceTopupWei = readOptionalEnvBigInt("FPC_SMOKE_FEE_JUICE_TOPUP_WEI");
  const feeJuiceWaitTimeoutMs = readEnvNumber("FPC_SMOKE_FEE_JUICE_WAIT_TIMEOUT_MS", 120_000);
  // Match default attestation config effective rate:
  // market_rate_num=1, market_rate_den=1000, fee_bips=200
  // => rate_num=10200, rate_den=10000000
  const rateNum = readEnvBigInt("FPC_SMOKE_RATE_NUM", 10_200n);
  const rateDen = readEnvBigInt("FPC_SMOKE_RATE_DEN", 10_000_000n);
  const quoteTtlSeconds = readEnvBigInt("FPC_SMOKE_QUOTE_TTL_SECONDS", 3600n);
  const daGasLimit = readEnvNumber("FPC_SMOKE_DA_GAS_LIMIT", 1_000_000);
  const l2GasLimit = readEnvNumber("FPC_SMOKE_L2_GAS_LIMIT", 1_000_000);
  const feePerDaGasOverride = readOptionalEnvBigInt("FPC_SMOKE_FEE_PER_DA_GAS");
  const feePerL2GasOverride = readOptionalEnvBigInt("FPC_SMOKE_FEE_PER_L2_GAS");
  if (rateDen === 0n) {
    throw new Error("FPC_SMOKE_RATE_DEN must be non-zero");
  }
  if (rateNum <= 0n) {
    throw new Error("FPC_SMOKE_RATE_NUM must be > 0 for meaningful fee smoke coverage");
  }

  return {
    nodeUrl,
    nodeTimeoutMs,
    l1RpcUrl,
    l1PrivateKey,
    feeJuiceTopupWei,
    feeJuiceWaitTimeoutMs,
    rateNum,
    rateDen,
    quoteTtlSeconds,
    daGasLimit,
    l2GasLimit,
    feePerDaGasOverride,
    feePerL2GasOverride,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PublicClient = ReturnType<typeof createPublicClient>;
type WalletClient = ReturnType<typeof createWalletClient>;
type L1Receipt = Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;

interface FeeJuiceBridgeContracts {
  feeJuiceTokenAddress: Hex;
  portalAddress: Hex;
  recipientBytes32: Hex;
}

interface L1Clients {
  accountAddress: Hex;
  walletClient: WalletClient;
  publicClient: PublicClient;
}

interface FeeJuiceBridgeMessage {
  bridgeAmount: bigint;
  claimSecret: Fr;
  messageLeafIndex: bigint;
  l1ToL2MessageHash: Fr;
}

async function resolveFeeJuiceBridgeContracts(
  node: ReturnType<typeof createAztecNodeClient>,
  fpcAddress: string,
): Promise<FeeJuiceBridgeContracts> {
  const nodeInfo = await node.getNodeInfo();
  const l1Addresses = nodeInfo.l1ContractAddresses as Record<string, unknown>;
  const tokenAddressValue = l1Addresses.feeJuiceAddress ?? l1Addresses.feeJuice;
  const portalAddressValue = l1Addresses.feeJuicePortalAddress ?? l1Addresses.feeJuicePortal;
  if (!tokenAddressValue || !portalAddressValue) {
    throw new Error("Node info is missing FeeJuice L1 contract addresses");
  }

  return {
    feeJuiceTokenAddress: normalizeHexAddress(tokenAddressValue, "feeJuiceAddress"),
    portalAddress: normalizeHexAddress(portalAddressValue, "feeJuicePortalAddress"),
    recipientBytes32: `0x${fpcAddress.replace("0x", "").padStart(64, "0")}` as Hex,
  };
}

function createL1Clients(config: SmokeConfig): L1Clients {
  const account = privateKeyToAccount(config.l1PrivateKey);
  return {
    accountAddress: account.address,
    walletClient: createWalletClient({
      account,
      transport: http(config.l1RpcUrl),
    }),
    publicClient: createPublicClient({
      transport: http(config.l1RpcUrl),
    }),
  };
}

async function resolveBridgeAmount(
  publicClient: PublicClient,
  feeJuiceTokenAddress: Hex,
  accountAddress: Hex,
  requestedTopupWei: bigint,
): Promise<bigint> {
  const l1FeeJuiceBalance = (await publicClient.readContract({
    address: feeJuiceTokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [accountAddress],
  })) as bigint;
  if (l1FeeJuiceBalance === 0n) {
    throw new Error(`L1 FeeJuice balance is zero for ${accountAddress}; cannot fund FPC fee payer`);
  }

  const bridgeAmount =
    requestedTopupWei > l1FeeJuiceBalance ? l1FeeJuiceBalance : requestedTopupWei;
  if (bridgeAmount < requestedTopupWei) {
    pinoLogger.warn(
      `[smoke] WARN: requested FeeJuice topup ${requestedTopupWei} exceeds L1 balance ${l1FeeJuiceBalance}. Clamping bridge amount to ${bridgeAmount}.`,
    );
  }
  return bridgeAmount;
}

async function approveAndBridgeFeeJuice(
  walletClient: WalletClient,
  publicClient: PublicClient,
  contracts: FeeJuiceBridgeContracts,
  bridgeAmount: bigint,
): Promise<{ receipt: L1Receipt; claimSecret: Fr }> {
  const claimSecret = Fr.random();
  const claimSecretHash = await computeSecretHash(claimSecret);

  const approveHash = await walletClient.writeContract({
    address: contracts.feeJuiceTokenAddress,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [contracts.portalAddress, bridgeAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  pinoLogger.info(`[smoke] l1_fee_juice_approve_tx=${approveHash}`);

  const depositHash = await walletClient.writeContract({
    address: contracts.portalAddress,
    abi: FEE_JUICE_PORTAL_ABI,
    functionName: "depositToAztecPublic",
    args: [contracts.recipientBytes32, bridgeAmount, claimSecretHash.toString() as Hex],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
  pinoLogger.info(`[smoke] l1_fee_juice_bridge_tx=${depositHash}`);

  return { receipt, claimSecret };
}

function decodeFeeJuiceBridgeMessage(receipt: L1Receipt, portalAddress: Hex) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== portalAddress.toLowerCase()) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: FEE_JUICE_PORTAL_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "DepositToAztecPublic") {
        continue;
      }
      return {
        messageLeafIndex: decoded.args.index as bigint,
        l1ToL2MessageHash: Fr.fromHexString(decoded.args.key as string),
      };
    } catch {
      // Ignore non-matching logs from the same contract.
    }
  }

  throw new Error("Could not decode DepositToAztecPublic event for Fee Juice bridge");
}

async function claimFeeJuiceOnL2(
  config: SmokeConfig,
  node: ReturnType<typeof createAztecNodeClient>,
  wallet: EmbeddedWallet,
  operator: AztecAddress,
  fpcAddress: string,
  bridgeMessage: FeeJuiceBridgeMessage,
): Promise<void> {
  await waitForL1ToL2MessageReady(node, bridgeMessage.l1ToL2MessageHash, {
    timeoutSeconds: Math.floor(config.feeJuiceWaitTimeoutMs / 1000),
    forPublicConsumption: false,
  });

  const feeJuice = FeeJuiceContract.at(wallet);
  await feeJuice.methods
    .claim(
      AztecAddress.fromString(fpcAddress),
      bridgeMessage.bridgeAmount,
      bridgeMessage.claimSecret,
      new Fr(bridgeMessage.messageLeafIndex),
    )
    .send({ from: operator });
}

async function waitForFeeJuiceCredit(
  node: ReturnType<typeof createAztecNodeClient>,
  fpcAddress: string,
  timeoutMs: number,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const balance = await getFeeJuiceBalance(AztecAddress.fromString(fpcAddress), node);
    if (balance > 0n) {
      return balance;
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for Fee Juice credit on ${fpcAddress}`);
}

async function topUpFpcFeeJuice(
  config: SmokeConfig,
  node: ReturnType<typeof createAztecNodeClient>,
  wallet: EmbeddedWallet,
  operator: AztecAddress,
  fpcAddress: string,
  topupWei: bigint,
): Promise<bigint> {
  const contracts = await resolveFeeJuiceBridgeContracts(node, fpcAddress);
  const { accountAddress, walletClient, publicClient } = createL1Clients(config);
  const bridgeAmount = await resolveBridgeAmount(
    publicClient,
    contracts.feeJuiceTokenAddress,
    accountAddress,
    topupWei,
  );
  const { receipt, claimSecret } = await approveAndBridgeFeeJuice(
    walletClient,
    publicClient,
    contracts,
    bridgeAmount,
  );
  const decodedMessage = decodeFeeJuiceBridgeMessage(receipt, contracts.portalAddress);
  await claimFeeJuiceOnL2(config, node, wallet, operator, fpcAddress, {
    bridgeAmount,
    claimSecret,
    messageLeafIndex: decodedMessage.messageLeafIndex,
    l1ToL2MessageHash: decodedMessage.l1ToL2MessageHash,
  });
  return waitForFeeJuiceCredit(node, fpcAddress, config.feeJuiceWaitTimeoutMs);
}

async function waitForNodeReady(
  node: ReturnType<typeof createAztecNodeClient>,
  nodeUrl: string,
  timeoutMs: number,
): Promise<void> {
  await Promise.race([
    waitForNode(node),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out waiting for Aztec node at ${nodeUrl}`)),
        timeoutMs,
      ),
    ),
  ]);
}

function resolveFeeJuiceTopupWei(config: SmokeConfig, maxGasCostNoTeardown: bigint): bigint {
  const minimumTopupWei = maxGasCostNoTeardown * FEE_JUICE_TOPUP_SAFETY_MULTIPLIER + 1_000_000n;
  const feeJuiceTopupWei = config.feeJuiceTopupWei ?? minimumTopupWei;
  if (config.feeJuiceTopupWei !== null && config.feeJuiceTopupWei < minimumTopupWei) {
    throw new Error(
      `FPC_SMOKE_FEE_JUICE_TOPUP_WEI=${config.feeJuiceTopupWei} is below required minimum ${minimumTopupWei} for current gas settings`,
    );
  }
  return feeJuiceTopupWei;
}

async function maybeTopUpFpcFeeJuiceBalance(
  config: SmokeConfig,
  node: ReturnType<typeof createAztecNodeClient>,
  wallet: EmbeddedWallet,
  operator: AztecAddress,
  fpcAddress: string,
  feeJuiceTopupWei: bigint,
): Promise<void> {
  if (feeJuiceTopupWei > 0n) {
    const feeJuiceBalance = await topUpFpcFeeJuice(
      config,
      node,
      wallet,
      operator,
      fpcAddress,
      feeJuiceTopupWei,
    );
    pinoLogger.info(`[smoke] fpc_fee_juice_balance=${feeJuiceBalance}`);
    return;
  }

  pinoLogger.info("[smoke] skipping fee-juice top-up (FPC_SMOKE_FEE_JUICE_TOPUP_WEI=0)");
}

async function getLatestBlockTimestampOrThrow(
  node: ReturnType<typeof createAztecNodeClient>,
  errorMessage: string,
): Promise<bigint> {
  const latestBlock = await node.getBlock("latest");
  if (!latestBlock) {
    throw new Error(errorMessage);
  }
  return latestBlock.timestamp;
}

function assertExpectedAmount(label: string, expected: bigint, actual: bigint): void {
  if (actual !== expected) {
    throw new Error(`${label} mismatch. expected=${expected} got=${actual}`);
  }
}

async function main() {
  const config = getConfig();
  const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
  const tokenArtifactPath = path.join(repoRoot, "target", "token_contract-Token.json");
  const fpcArtifactPath = resolveFpcArtifactPath(repoRoot);

  const tokenArtifact = loadArtifact(tokenArtifactPath);
  const fpcArtifact = loadArtifact(fpcArtifactPath);

  const node = createAztecNodeClient(config.nodeUrl);
  await waitForNodeReady(node, config.nodeUrl, config.nodeTimeoutMs);
  const wallet = await EmbeddedWallet.create(node);
  const minFees = await node.getCurrentMinFees();
  const feePerDaGas = config.feePerDaGasOverride ?? minFees.feePerDaGas;
  const feePerL2Gas = config.feePerL2GasOverride ?? minFees.feePerL2Gas;
  const maxGasCostNoTeardown =
    BigInt(config.daGasLimit) * feePerDaGas + BigInt(config.l2GasLimit) * feePerL2Gas;
  const feeJuiceTopupWei = resolveFeeJuiceTopupWei(config, maxGasCostNoTeardown);

  const { accounts: testAccounts, l1PrivateKey } = await resolveScriptAccounts(
    config.nodeUrl,
    config.l1RpcUrl,
    wallet,
    2,
  );
  config.l1PrivateKey = l1PrivateKey as Hex;

  const operator = testAccounts[0].address;
  const user = testAccounts[1].address;

  pinoLogger.info(`[smoke] operator=${operator.toString()}`);
  pinoLogger.info(`[smoke] user=${user.toString()}`);

  // Derive operator signing key and public key for inline Schnorr verification.
  const schnorr = new Schnorr();
  const operatorSigningKey = deriveSigningKey(testAccounts[0].secret);
  const operatorPubKey = await schnorr.computePublicKey(operatorSigningKey);

  const token = await deployContract(
    wallet,
    tokenArtifact,
    ["SmokeToken", "SMK", 18, operator, operator],
    { from: operator },
    "constructor_with_minter",
  );
  pinoLogger.info(`[smoke] token=${token.address.toString()}`);

  const fpc = await deployContract(
    wallet,
    fpcArtifact,
    [operator, operatorPubKey.x, operatorPubKey.y],
    { from: operator },
  );
  pinoLogger.info(`[smoke] fpc=${fpc.address.toString()}`);

  pinoLogger.info(`[smoke] fee_per_da_gas=${feePerDaGas}`);
  pinoLogger.info(`[smoke] fee_per_l2_gas=${feePerL2Gas}`);
  pinoLogger.info(`[smoke] fee_juice_topup_wei=${feeJuiceTopupWei}`);

  await maybeTopUpFpcFeeJuiceBalance(
    config,
    node,
    wallet,
    operator,
    fpc.address.toString(),
    feeJuiceTopupWei,
  );

  const expectedCharge = ceilDiv(maxGasCostNoTeardown * config.rateNum, config.rateDen);
  const fjFeeAmount = maxGasCostNoTeardown;
  const aaPaymentAmount = expectedCharge;
  const mintAmount = expectedCharge + 1_000_000n;
  pinoLogger.info(`[smoke] expected_charge=${expectedCharge}`);

  await token.methods.mint_to_private(user, mintAmount).send({ from: operator });
  await token.methods.mint_to_public(user, 2n).send({ from: operator });

  const validUntil =
    (await getLatestBlockTimestampOrThrow(
      node,
      "Could not read latest L2 block while building quote validity window",
    )) + config.quoteTtlSeconds;
  const quoteHash = await computeInnerAuthWitHash([
    QUOTE_DOMAIN_SEPARATOR,
    fpc.address.toField(),
    token.address.toField(),
    new Fr(fjFeeAmount),
    new Fr(aaPaymentAmount),
    new Fr(validUntil),
    user.toField(),
  ]);
  const quoteSig = await schnorr.constructSignature(quoteHash.toBuffer(), operatorSigningKey);
  const quoteSigBytes = Array.from(quoteSig.toBuffer());

  const transferAuthwitNonce = Fr.random();
  const transferCall = token.methods.transfer_private_to_private(
    user,
    operator,
    aaPaymentAmount,
    transferAuthwitNonce,
  );
  const transferAuthwit = await wallet.createAuthWit(user, {
    caller: fpc.address,
    action: transferCall,
  });

  const userBefore = BigInt(
    (await token.methods.balance_of_private(user).simulate({ from: user })).toString(),
  );
  const operatorBefore = BigInt(
    (await token.methods.balance_of_private(operator).simulate({ from: operator })).toString(),
  );

  const feeEntrypointCall = await fpc.methods
    .fee_entrypoint(
      token.address,
      transferAuthwitNonce,
      fjFeeAmount,
      aaPaymentAmount,
      validUntil,
      quoteSigBytes,
    )
    .getFunctionCall();
  const fpcPaymentMethod = {
    getAsset: async () => ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new ExecutionPayload([feeEntrypointCall], [transferAuthwit], [], [], fpc.address),
    getFeePayer: async () => fpc.address,
    getGasSettings: () => undefined,
  };

  // Execute a normal user action while paying fees through FPC.
  const receipt = await token.methods.transfer_public_to_public(user, user, 1n, Fr.random()).send({
    from: user,
    fee: {
      paymentMethod: fpcPaymentMethod,
      gasSettings: {
        gasLimits: { daGas: config.daGasLimit, l2Gas: config.l2GasLimit },
        teardownGasLimits: { daGas: 0, l2Gas: 0 },
        maxFeesPerGas: { feePerDaGas, feePerL2Gas },
      },
    },
    wait: { timeout: 180 },
  });

  const userAfter = BigInt(
    (await token.methods.balance_of_private(user).simulate({ from: user })).toString(),
  );
  const operatorAfter = BigInt(
    (await token.methods.balance_of_private(operator).simulate({ from: operator })).toString(),
  );

  const userDebited = userBefore - userAfter;
  const operatorCredited = operatorAfter - operatorBefore;

  pinoLogger.info(`[smoke] expected_charge=${expectedCharge}`);
  pinoLogger.info(`[smoke] user_debited=${userDebited}`);
  pinoLogger.info(`[smoke] operator_credited=${operatorCredited}`);
  pinoLogger.info(`[smoke] operator_balance_after=${operatorAfter}`);
  pinoLogger.info(`[smoke] tx_fee_juice=${receipt.transactionFee}`);

  assertExpectedAmount("User debit", expectedCharge, userDebited);
  assertExpectedAmount("Operator credit", expectedCharge, operatorCredited);

  // Ensure negative-path tx can reach fee validation checks instead of failing
  // early due to insufficient private token balance.
  await token.methods.mint_to_private(user, expectedCharge + 1_000_000n).send({ from: operator });
  const negativeValidUntil =
    (await getLatestBlockTimestampOrThrow(
      node,
      "Could not read latest L2 block while building direct-call negative quote",
    )) + config.quoteTtlSeconds;
  const negativeQuoteHash = await computeInnerAuthWitHash([
    QUOTE_DOMAIN_SEPARATOR,
    fpc.address.toField(),
    token.address.toField(),
    new Fr(fjFeeAmount),
    new Fr(aaPaymentAmount),
    new Fr(negativeValidUntil),
    user.toField(),
  ]);
  const negativeQuoteSig = await schnorr.constructSignature(
    negativeQuoteHash.toBuffer(),
    operatorSigningKey,
  );
  const negativeQuoteSigBytes = Array.from(negativeQuoteSig.toBuffer());
  const negativeTransferAuthwitNonce = Fr.random();
  const negativeTransferCall = token.methods.transfer_private_to_private(
    user,
    operator,
    aaPaymentAmount,
    negativeTransferAuthwitNonce,
  );
  const negativeTransferAuthwit = await wallet.createAuthWit(user, {
    caller: fpc.address,
    action: negativeTransferCall,
  });
  const negativeFeeEntrypointCall = await fpc.methods
    .fee_entrypoint(
      token.address,
      negativeTransferAuthwitNonce,
      fjFeeAmount,
      aaPaymentAmount,
      negativeValidUntil,
      negativeQuoteSigBytes,
    )
    .getFunctionCall();
  const _negativePaymentMethod = {
    getAsset: async () => ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new ExecutionPayload(
        [negativeFeeEntrypointCall],
        [negativeTransferAuthwit],
        [],
        [],
        fpc.address,
      ),
    getFeePayer: async () => fpc.address,
    getGasSettings: () => undefined,
  };

  await expectFailure(
    "direct fee_entrypoint call rejected outside setup phase",
    ["must run in setup phase", "unknown auth witness"],
    () =>
      fpc.methods
        .fee_entrypoint(
          token.address,
          negativeTransferAuthwitNonce,
          fjFeeAmount,
          aaPaymentAmount,
          negativeValidUntil,
          negativeQuoteSigBytes,
        )
        .send({
          from: user,
          authWitnesses: [negativeTransferAuthwit],
          wait: { timeout: 180 },
        }),
  );

  pinoLogger.info("[smoke] PASS: fee_entrypoint end-to-end flow succeeded");
}

try {
  await main();
} catch (error) {
  pinoLogger.error(`[smoke] FAIL: ${(error as Error).message}`);
  process.exit(1);
}

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import type { ContractArtifact } from "@aztec/aztec.js/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { lookupValidity } from "@aztec/aztec.js/authorization";
import { Contract } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import {
  FeeJuiceContract,
  ProtocolContractAddress,
} from "@aztec/aztec.js/protocol";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import {
  loadContractArtifact,
  loadContractArtifactForPublic,
} from "@aztec/stdlib/abi";
import { computeSecretHash } from "@aztec/stdlib/hash";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
import { ExecutionPayload } from "@aztec/stdlib/tx";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  type Hex,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const DEFAULT_LOCAL_L1_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const HEX_32_BYTE_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const FEE_JUICE_PORTAL_ABI = parseAbi([
  "function depositToAztecPublic(bytes32 to, uint256 amount, bytes32 secretHash) returns (bytes32, uint256)",
  "event DepositToAztecPublic(bytes32 indexed to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)",
]);

type ManagedProcess = {
  name: string;
  process: ChildProcessWithoutNullStreams;
  getLogs: () => string;
};

type SmokeMode = "fpc" | "credit" | "both";
type ScenarioKind = "fpc" | "credit";

type SmokeConfig = {
  mode: SmokeMode;
  nodeUrl: string;
  l1RpcUrl: string;
  attestationPort: number;
  nodeTimeoutMs: number;
  httpTimeoutMs: number;
  topupWaitTimeoutMs: number;
  topupPollMs: number;
  quoteValiditySeconds: number;
  marketRateNum: number;
  marketRateDen: number;
  feeBips: number;
  daGasLimit: number;
  l2GasLimit: number;
  feeJuiceTopupSafetyMultiplier: bigint;
  topupConfirmTimeoutMs: number;
  topupConfirmPollInitialMs: number;
  topupConfirmPollMaxMs: number;
  relayAdvanceBlocks: number;
  creditMintMultiplier: bigint;
  creditMintBuffer: bigint;
};

type QuoteResponse = {
  accepted_asset: string;
  rate_num: string;
  rate_den: string;
  valid_until: string;
  signature: string;
};

type AssetResponse = {
  name: string;
  address: string;
};

type ServiceFlowResult = {
  rateNum: bigint;
  rateDen: bigint;
  validUntil: bigint;
  quoteSigBytes: number[];
};

function parseSmokeMode(value: string | undefined): SmokeMode {
  const normalized = (value ?? "both").trim().toLowerCase();
  if (
    normalized === "fpc" ||
    normalized === "credit" ||
    normalized === "both"
  ) {
    return normalized;
  }
  throw new Error(
    `Invalid FPC_SERVICES_SMOKE_MODE=${value}. Expected one of: fpc, credit, both`,
  );
}

function readEnvNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric env var ${name}=${value}`);
  }
  return parsed;
}

function readEnvBigInt(name: string, fallback: bigint): bigint {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = BigInt(value);
  if (parsed <= 0n) {
    throw new Error(`Invalid bigint env var ${name}=${value}`);
  }
  return parsed;
}

function readOptionalEnvBigInt(name: string): bigint | null {
  const value = process.env[name];
  return value ? BigInt(value) : null;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function getConfig(): SmokeConfig {
  const mode = parseSmokeMode(process.env.FPC_SERVICES_SMOKE_MODE);
  const config: SmokeConfig = {
    mode,
    nodeUrl: process.env.AZTEC_NODE_URL ?? "http://localhost:8080",
    l1RpcUrl:
      process.env.FPC_SERVICES_SMOKE_L1_RPC_URL ?? "http://127.0.0.1:8545",
    attestationPort: readEnvNumber("FPC_SERVICES_SMOKE_ATTESTATION_PORT", 3300),
    nodeTimeoutMs: readEnvNumber("FPC_SERVICES_SMOKE_NODE_TIMEOUT_MS", 45_000),
    httpTimeoutMs: readEnvNumber("FPC_SERVICES_SMOKE_HTTP_TIMEOUT_MS", 30_000),
    topupWaitTimeoutMs: readEnvNumber(
      "FPC_SERVICES_SMOKE_TOPUP_WAIT_TIMEOUT_MS",
      240_000,
    ),
    topupPollMs: readEnvNumber("FPC_SERVICES_SMOKE_TOPUP_POLL_MS", 2_000),
    quoteValiditySeconds: readEnvNumber(
      "FPC_SERVICES_SMOKE_QUOTE_VALIDITY_SECONDS",
      3600,
    ),
    marketRateNum: readEnvNumber("FPC_SERVICES_SMOKE_MARKET_RATE_NUM", 1),
    marketRateDen: readEnvNumber("FPC_SERVICES_SMOKE_MARKET_RATE_DEN", 1000),
    feeBips: readEnvNumber("FPC_SERVICES_SMOKE_FEE_BIPS", 200),
    daGasLimit: readEnvNumber("FPC_SERVICES_SMOKE_DA_GAS_LIMIT", 1_000_000),
    l2GasLimit: readEnvNumber("FPC_SERVICES_SMOKE_L2_GAS_LIMIT", 1_000_000),
    feeJuiceTopupSafetyMultiplier: readEnvBigInt(
      "FPC_SERVICES_SMOKE_TOPUP_SAFETY_MULTIPLIER",
      5n,
    ),
    topupConfirmTimeoutMs: readEnvNumber(
      "FPC_SERVICES_SMOKE_TOPUP_CONFIRM_TIMEOUT_MS",
      180_000,
    ),
    topupConfirmPollInitialMs: readEnvNumber(
      "FPC_SERVICES_SMOKE_TOPUP_CONFIRM_POLL_INITIAL_MS",
      1_000,
    ),
    topupConfirmPollMaxMs: readEnvNumber(
      "FPC_SERVICES_SMOKE_TOPUP_CONFIRM_POLL_MAX_MS",
      15_000,
    ),
    relayAdvanceBlocks: readEnvNumber(
      "FPC_SERVICES_SMOKE_RELAY_ADVANCE_BLOCKS",
      2,
    ),
    creditMintMultiplier: readEnvBigInt(
      "FPC_SERVICES_SMOKE_CREDIT_MINT_MULTIPLIER",
      5n,
    ),
    creditMintBuffer: readEnvBigInt(
      "FPC_SERVICES_SMOKE_CREDIT_MINT_BUFFER",
      1_000_000n,
    ),
  };

  if (config.relayAdvanceBlocks < 2) {
    throw new Error(
      `FPC_SERVICES_SMOKE_RELAY_ADVANCE_BLOCKS must be >= 2, got ${config.relayAdvanceBlocks}`,
    );
  }
  if (config.mode !== "fpc" && config.creditMintMultiplier <= 1n) {
    throw new Error(
      `FPC_SERVICES_SMOKE_CREDIT_MINT_MULTIPLIER must be > 1, got ${config.creditMintMultiplier}`,
    );
  }

  return config;
}

function startManagedProcess(
  name: string,
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
): ManagedProcess {
  let logs = "";
  const processHandle = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  processHandle.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    logs += text;
    process.stdout.write(`[${name}] ${text}`);
  });
  processHandle.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    logs += text;
    process.stderr.write(`[${name}] ${text}`);
  });

  return {
    name,
    process: processHandle,
    getLogs: () => logs,
  };
}

async function stopManagedProcess(proc: ManagedProcess): Promise<void> {
  if (proc.process.exitCode !== null) {
    return;
  }

  proc.process.kill("SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (proc.process.exitCode !== null) {
      return;
    }
    await sleep(100);
  }
  proc.process.kill("SIGKILL");
}

async function waitForNodeReady(
  node: ReturnType<typeof createAztecNodeClient>,
  timeoutMs: number,
): Promise<void> {
  await Promise.race([
    waitForNode(node),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`Timed out waiting for Aztec node after ${timeoutMs}ms`),
          ),
        timeoutMs,
      ),
    ),
  ]);
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep retrying during boot.
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for health endpoint: ${url}`);
}

async function waitForLog(
  proc: ManagedProcess,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (proc.getLogs().includes(expected)) {
      return;
    }
    if (proc.process.exitCode !== null) {
      throw new Error(
        `Process ${proc.name} exited before logging "${expected}" (exit=${proc.process.exitCode})`,
      );
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for ${proc.name} log "${expected}". Recent logs:\n${proc
      .getLogs()
      .slice(-4000)}`,
  );
}

async function waitForPositiveFeeJuiceBalance(
  node: ReturnType<typeof createAztecNodeClient>,
  fpcAddress: AztecAddress,
  timeoutMs: number,
  pollMs: number,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const balance = await getFeeJuiceBalance(fpcAddress, node);
    if (balance > 0n) {
      return balance;
    }
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for Fee Juice balance on ${fpcAddress}`);
}

async function getCurrentChainUnixSeconds(
  node: ReturnType<typeof createAztecNodeClient>,
): Promise<bigint> {
  const latest = await node.getBlock("latest");
  if (latest) {
    return latest.timestamp;
  }
  return BigInt(Math.floor(Date.now() / 1000));
}

async function advanceL2Blocks(
  token: Contract,
  operator: AztecAddress,
  user: AztecAddress,
  blocks: number,
): Promise<void> {
  for (let i = 0; i < blocks; i += 1) {
    await token.methods.mint_to_private(user, 1n).send({
      from: operator,
      wait: { timeout: 180 },
    });
    console.log(`[services-smoke] mock_relay_tx_confirmed=${i + 1}/${blocks}`);
  }
}

async function topUpFpcFeeJuiceManually(
  node: ReturnType<typeof createAztecNodeClient>,
  wallet: EmbeddedWallet,
  operator: AztecAddress,
  token: Contract,
  user: AztecAddress,
  feePayerAddress: string,
  topupWei: bigint,
  relayAdvanceBlocks: number,
  l1RpcUrl: string,
  l1PrivateKey: Hex,
  timeoutMs: number,
  pollMs: number,
): Promise<bigint> {
  const nodeInfo = await node.getNodeInfo();
  const l1Addresses = nodeInfo.l1ContractAddresses as Record<string, unknown>;
  const tokenAddressValue = l1Addresses.feeJuiceAddress ?? l1Addresses.feeJuice;
  const portalAddressValue =
    l1Addresses.feeJuicePortalAddress ?? l1Addresses.feeJuicePortal;
  if (!tokenAddressValue || !portalAddressValue) {
    throw new Error("Node info is missing FeeJuice L1 contract addresses");
  }

  const feeJuiceTokenAddress = normalizeHexAddress(
    tokenAddressValue,
    "feeJuiceAddress",
  );
  const portalAddress = normalizeHexAddress(
    portalAddressValue,
    "feeJuicePortalAddress",
  );
  const recipientBytes32 =
    `0x${feePayerAddress.replace("0x", "").padStart(64, "0")}` as Hex;

  const account = privateKeyToAccount(l1PrivateKey);
  const walletClient = createWalletClient({
    account,
    transport: http(l1RpcUrl),
  });
  const publicClient = createPublicClient({
    transport: http(l1RpcUrl),
  });

  const claimSecret = Fr.random();
  const claimSecretHash = await computeSecretHash(claimSecret);

  const approveHash = await walletClient.writeContract({
    address: feeJuiceTokenAddress,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [portalAddress, topupWei],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const bridgeHash = await walletClient.writeContract({
    address: portalAddress,
    abi: FEE_JUICE_PORTAL_ABI,
    functionName: "depositToAztecPublic",
    args: [recipientBytes32, topupWei, claimSecretHash.toString() as Hex],
  });
  const bridgeReceipt = await publicClient.waitForTransactionReceipt({
    hash: bridgeHash,
  });
  console.log(`[services-smoke] manual_bridge_tx=${bridgeHash}`);

  let messageLeafIndex: bigint | undefined;
  let l1ToL2MessageHash: Fr | undefined;
  for (const log of bridgeReceipt.logs) {
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
      messageLeafIndex = decoded.args.index as bigint;
      l1ToL2MessageHash = Fr.fromHexString(decoded.args.key as string);
      break;
    } catch {
      // Ignore non-matching logs emitted by this contract.
    }
  }

  if (messageLeafIndex === undefined || !l1ToL2MessageHash) {
    throw new Error(
      "Could not decode DepositToAztecPublic event for fallback bridge",
    );
  }

  // Local devnet requires additional L2 blocks before the bridge message
  // becomes claimable. Use lightweight mock txs to force block production.
  await advanceL2Blocks(token, operator, user, relayAdvanceBlocks);

  await waitForL1ToL2MessageReady(node, l1ToL2MessageHash, {
    timeoutSeconds: Math.max(1, Math.floor(timeoutMs / 1000)),
    forPublicConsumption: false,
  });

  const feeJuice = FeeJuiceContract.at(wallet);
  await feeJuice.methods
    .claim(
      AztecAddress.fromString(feePayerAddress),
      topupWei,
      claimSecret,
      new Fr(messageLeafIndex),
    )
    .send({ from: operator });

  return waitForPositiveFeeJuiceBalance(
    node,
    AztecAddress.fromString(feePayerAddress),
    timeoutMs,
    pollMs,
  );
}

async function fetchQuote(
  quoteUrl: string,
  timeoutMs: number,
): Promise<QuoteResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;

  while (Date.now() <= deadline) {
    try {
      const response = await fetch(quoteUrl);
      const bodyText = await response.text();
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${bodyText}`;
      } else {
        const parsed = JSON.parse(bodyText) as QuoteResponse;
        if (
          typeof parsed.accepted_asset === "string" &&
          typeof parsed.rate_num === "string" &&
          typeof parsed.rate_den === "string" &&
          typeof parsed.valid_until === "string" &&
          typeof parsed.signature === "string"
        ) {
          return parsed;
        }
        lastError = `Invalid quote payload: ${bodyText}`;
      }
    } catch (error) {
      lastError = (error as Error).message;
    }

    await sleep(500);
  }

  throw new Error(`Timed out requesting quote. Last error: ${lastError}`);
}

async function fetchAsset(
  assetUrl: string,
  timeoutMs: number,
): Promise<AssetResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;

  while (Date.now() <= deadline) {
    try {
      const response = await fetch(assetUrl);
      const bodyText = await response.text();
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${bodyText}`;
      } else {
        const parsed = JSON.parse(bodyText) as AssetResponse;
        if (
          typeof parsed.name === "string" &&
          typeof parsed.address === "string"
        ) {
          return parsed;
        }
        lastError = `Invalid asset payload: ${bodyText}`;
      }
    } catch (error) {
      lastError = (error as Error).message;
    }

    await sleep(500);
  }

  throw new Error(
    `Timed out requesting asset metadata. Last error: ${lastError}`,
  );
}

function assertPrivateKeyHex(value: string, fieldName: string): void {
  if (!HEX_32_BYTE_PATTERN.test(value)) {
    throw new Error(`${fieldName} must be a 32-byte 0x-prefixed private key`);
  }
}

function getScenarioKinds(mode: SmokeMode): ScenarioKind[] {
  switch (mode) {
    case "fpc":
      return ["fpc"];
    case "credit":
      return ["credit"];
    default:
      return ["fpc", "credit"];
  }
}

async function runServiceScenario(
  scenario: ScenarioKind,
  config: SmokeConfig,
  repoRoot: string,
  tmpDir: string,
  node: ReturnType<typeof createAztecNodeClient>,
  wallet: EmbeddedWallet,
  token: Contract,
  operator: AztecAddress,
  user: AztecAddress,
  feePayerAddress: AztecAddress,
  operatorSecretHex: string,
  l1PrivateKey: Hex,
  topupThreshold: bigint,
  topupAmount: bigint,
): Promise<ServiceFlowResult> {
  const scenarioPrefix = `[services-smoke:${scenario}]`;
  const managed: ManagedProcess[] = [];

  try {
    const attestationConfigPath = path.join(
      tmpDir,
      `attestation.${scenario}.config.yaml`,
    );
    const topupConfigPath = path.join(tmpDir, `topup.${scenario}.config.yaml`);

    writeFileSync(
      attestationConfigPath,
      `${[
        `fpc_address: "${feePayerAddress.toString()}"`,
        `aztec_node_url: "${config.nodeUrl}"`,
        `quote_validity_seconds: ${config.quoteValiditySeconds}`,
        `port: ${config.attestationPort}`,
        `accepted_asset_name: "SmokeToken"`,
        `accepted_asset_address: "${token.address.toString()}"`,
        `market_rate_num: ${config.marketRateNum}`,
        `market_rate_den: ${config.marketRateDen}`,
        `fee_bips: ${config.feeBips}`,
      ].join("\n")}\n`,
      "utf8",
    );

    writeFileSync(
      topupConfigPath,
      `${[
        `fpc_address: "${feePayerAddress.toString()}"`,
        `aztec_node_url: "${config.nodeUrl}"`,
        `l1_rpc_url: "${config.l1RpcUrl}"`,
        `threshold: "${topupThreshold}"`,
        `top_up_amount: "${topupAmount}"`,
        "check_interval_ms: 60000",
        `confirmation_timeout_ms: ${config.topupConfirmTimeoutMs}`,
        `confirmation_poll_initial_ms: ${config.topupConfirmPollInitialMs}`,
        `confirmation_poll_max_ms: ${config.topupConfirmPollMaxMs}`,
      ].join("\n")}\n`,
      "utf8",
    );

    const attestation = startManagedProcess(
      `attestation-${scenario}`,
      "bun",
      [
        "run",
        path.join(repoRoot, "services", "attestation", "dist", "index.js"),
        "--config",
        attestationConfigPath,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          OPERATOR_SECRET_KEY: operatorSecretHex,
        },
      },
    );
    managed.push(attestation);

    const attestationBaseUrl = `http://127.0.0.1:${config.attestationPort}`;
    await waitForHealth(`${attestationBaseUrl}/health`, config.httpTimeoutMs);
    console.log(`${scenarioPrefix} PASS: attestation service health endpoint`);
    const asset = await fetchAsset(
      `${attestationBaseUrl}/asset`,
      config.httpTimeoutMs,
    );
    if (asset.name !== "SmokeToken") {
      throw new Error(
        `${scenarioPrefix} asset name mismatch. expected=SmokeToken got=${asset.name}`,
      );
    }
    if (
      asset.address.toLowerCase() !== token.address.toString().toLowerCase()
    ) {
      throw new Error(
        `${scenarioPrefix} asset address mismatch. expected=${token.address.toString()} got=${asset.address}`,
      );
    }
    console.log(
      `${scenarioPrefix} PASS: asset endpoint matches deployed token`,
    );

    const topup = startManagedProcess(
      `topup-${scenario}`,
      "bun",
      [
        "run",
        path.join(repoRoot, "services", "topup", "dist", "index.js"),
        "--config",
        topupConfigPath,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          L1_OPERATOR_PRIVATE_KEY: l1PrivateKey,
        },
      },
    );
    managed.push(topup);

    await waitForLog(topup, "Top-up service started", config.httpTimeoutMs);
    await waitForLog(
      topup,
      "FPC Fee Juice balance:",
      config.topupWaitTimeoutMs,
    );
    await waitForLog(topup, "Bridge submitted.", config.topupWaitTimeoutMs);

    // Local devnet requires additional L2 blocks before the L1->L2 bridge
    // message becomes consumable. Force block production with lightweight txs.
    await advanceL2Blocks(token, operator, user, config.relayAdvanceBlocks);

    const initialFeeJuiceBalance = await getFeeJuiceBalance(
      feePayerAddress,
      node,
    );
    console.log(
      `${scenarioPrefix} fee_payer_fee_juice_before_wait=${initialFeeJuiceBalance}`,
    );

    let bridgedFeeJuiceBalance = initialFeeJuiceBalance;
    if (bridgedFeeJuiceBalance === 0n) {
      console.log(
        `${scenarioPrefix} topup balance delta not visible; running deterministic manual claim fallback`,
      );
      bridgedFeeJuiceBalance = await topUpFpcFeeJuiceManually(
        node,
        wallet,
        operator,
        token,
        user,
        feePayerAddress.toString(),
        topupAmount,
        config.relayAdvanceBlocks,
        config.l1RpcUrl,
        l1PrivateKey,
        config.topupWaitTimeoutMs,
        config.topupPollMs,
      );
    }
    console.log(
      `${scenarioPrefix} fee_payer_fee_juice_after_topup=${bridgedFeeJuiceBalance}`,
    );

    await waitForLog(
      topup,
      "Bridge confirmation outcome=confirmed",
      config.topupWaitTimeoutMs,
    );

    const chainNowBeforeQuote = await getCurrentChainUnixSeconds(node);
    const quote = await fetchQuote(
      `${attestationBaseUrl}/quote?user=${user.toString()}`,
      config.httpTimeoutMs,
    );
    const chainNowAfterQuote = await getCurrentChainUnixSeconds(node);
    const quoteSigBytes = Array.from(
      Buffer.from(quote.signature.replace("0x", ""), "hex"),
    );
    const rateNum = BigInt(quote.rate_num);
    const rateDen = BigInt(quote.rate_den);
    const validUntil = BigInt(quote.valid_until);

    if (quoteSigBytes.length !== 64) {
      throw new Error(
        `${scenarioPrefix} quote signature length must be 64 bytes, got ${quoteSigBytes.length}`,
      );
    }
    if (rateDen === 0n) {
      throw new Error(
        `${scenarioPrefix} attestation quote returned zero denominator`,
      );
    }
    if (
      quote.accepted_asset.toLowerCase() !==
      token.address.toString().toLowerCase()
    ) {
      throw new Error(
        `${scenarioPrefix} quote accepted_asset mismatch. expected=${token.address.toString()} got=${quote.accepted_asset}`,
      );
    }

    const expectedRateNum =
      BigInt(config.marketRateNum) * BigInt(10_000 + config.feeBips);
    const expectedRateDen = BigInt(config.marketRateDen) * 10_000n;
    if (rateNum !== expectedRateNum || rateDen !== expectedRateDen) {
      throw new Error(
        `${scenarioPrefix} quote rate mismatch. expected_num=${expectedRateNum} expected_den=${expectedRateDen} got_num=${rateNum} got_den=${rateDen}`,
      );
    }

    const chainNowMin =
      chainNowBeforeQuote < chainNowAfterQuote
        ? chainNowBeforeQuote
        : chainNowAfterQuote;
    const chainNowMax =
      chainNowBeforeQuote > chainNowAfterQuote
        ? chainNowBeforeQuote
        : chainNowAfterQuote;
    const minExpectedValidUntil =
      chainNowMin + BigInt(config.quoteValiditySeconds);
    const maxExpectedValidUntil =
      chainNowMax + BigInt(config.quoteValiditySeconds) + 5n;
    if (
      validUntil < minExpectedValidUntil ||
      validUntil > maxExpectedValidUntil
    ) {
      throw new Error(
        `${scenarioPrefix} quote validity window mismatch. chain_now_before=${chainNowBeforeQuote} chain_now_after=${chainNowAfterQuote} valid_until=${validUntil} expected_range=[${minExpectedValidUntil}, ${maxExpectedValidUntil}]`,
      );
    }

    const attestationLogs = attestation.getLogs();
    if (!attestationLogs.includes("quote_issued")) {
      throw new Error(
        `${scenarioPrefix} attestation service logs did not include quote_issued marker`,
      );
    }
    const topupLogs = topup.getLogs();
    if (!topupLogs.includes("FPC Fee Juice balance:")) {
      throw new Error(
        `${scenarioPrefix} top-up service logs did not include Fee Juice balance read`,
      );
    }

    return { rateNum, rateDen, validUntil, quoteSigBytes };
  } finally {
    for (const proc of managed.reverse()) {
      await stopManagedProcess(proc);
    }
  }
}

async function runFpcFeeEntrypointScenario(
  config: SmokeConfig,
  wallet: EmbeddedWallet,
  token: Contract,
  fpc: Contract,
  operator: AztecAddress,
  user: AztecAddress,
  maxGasCostNoTeardown: bigint,
  feePerDaGas: bigint,
  feePerL2Gas: bigint,
  quote: ServiceFlowResult,
): Promise<void> {
  const expectedCharge = ceilDiv(
    maxGasCostNoTeardown * quote.rateNum,
    quote.rateDen,
  );
  const mintAmount = expectedCharge + 1_000_000n;
  console.log(`[services-smoke:fpc] expected_charge=${expectedCharge}`);

  await token.methods
    .mint_to_private(user, mintAmount)
    .send({ from: operator });
  await token.methods.mint_to_public(user, 2n).send({ from: operator });

  const transferAuthwitNonce = Fr.random();
  const transferCall = token.methods.transfer_private_to_private(
    user,
    operator,
    expectedCharge,
    transferAuthwitNonce,
  );
  const transferAuthwit = await wallet.createAuthWit(user, {
    caller: fpc.address,
    action: transferCall,
  });
  const transferValidity = await lookupValidity(
    wallet,
    user,
    { caller: fpc.address, action: transferCall },
    transferAuthwit,
  );
  console.log(
    `[services-smoke:fpc] transfer_authwit_valid_private=${transferValidity.isValidInPrivate} transfer_authwit_valid_public=${transferValidity.isValidInPublic}`,
  );

  const userBefore = BigInt(
    (
      await token.methods.balance_of_private(user).simulate({ from: user })
    ).toString(),
  );
  const operatorBefore = BigInt(
    (
      await token.methods
        .balance_of_private(operator)
        .simulate({ from: operator })
    ).toString(),
  );

  const feeEntrypointCall = await fpc.methods
    .fee_entrypoint(
      transferAuthwitNonce,
      quote.rateNum,
      quote.rateDen,
      quote.validUntil,
      quote.quoteSigBytes,
    )
    .getFunctionCall();
  const paymentMethod = {
    getAsset: async () => ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new ExecutionPayload(
        [feeEntrypointCall],
        [transferAuthwit],
        [],
        [],
        fpc.address,
      ),
    getFeePayer: async () => fpc.address,
    getGasSettings: () => undefined,
  };

  const receipt = await token.methods
    .transfer_public_to_public(user, user, 1n, Fr.random())
    .send({
      from: user,
      fee: {
        paymentMethod,
        gasSettings: {
          gasLimits: { daGas: config.daGasLimit, l2Gas: config.l2GasLimit },
          maxFeesPerGas: { feePerDaGas, feePerL2Gas },
        },
      },
      wait: { timeout: 180 },
    });

  const userAfter = BigInt(
    (
      await token.methods.balance_of_private(user).simulate({ from: user })
    ).toString(),
  );
  const operatorAfter = BigInt(
    (
      await token.methods
        .balance_of_private(operator)
        .simulate({ from: operator })
    ).toString(),
  );

  const userDebited = userBefore - userAfter;
  const operatorCredited = operatorAfter - operatorBefore;
  if (userDebited !== expectedCharge) {
    throw new Error(
      `[services-smoke:fpc] user debit mismatch. expected=${expectedCharge} got=${userDebited}`,
    );
  }
  if (operatorCredited !== expectedCharge) {
    throw new Error(
      `[services-smoke:fpc] operator credit mismatch. expected=${expectedCharge} got=${operatorCredited}`,
    );
  }

  console.log(
    `[services-smoke:fpc] tx_fee_juice=${receipt.transactionFee} user_debited=${userDebited} operator_credited=${operatorCredited}`,
  );
  console.log(
    "[services-smoke:fpc] PASS: tx accepted with attestation quote + fee_entrypoint",
  );
}

async function runCreditFeeScenario(
  config: SmokeConfig,
  wallet: EmbeddedWallet,
  token: Contract,
  creditFpc: Contract,
  operator: AztecAddress,
  user: AztecAddress,
  maxGasCostNoTeardown: bigint,
  feePerDaGas: bigint,
  feePerL2Gas: bigint,
  quote: ServiceFlowResult,
): Promise<void> {
  const mintAmount =
    maxGasCostNoTeardown * config.creditMintMultiplier +
    config.creditMintBuffer;
  const expectedCharge = ceilDiv(mintAmount * quote.rateNum, quote.rateDen);
  console.log(`[services-smoke:credit] mint_amount=${mintAmount}`);
  console.log(`[services-smoke:credit] expected_charge=${expectedCharge}`);

  await token.methods
    .mint_to_private(user, expectedCharge + 1_000_000n)
    .send({ from: operator });
  await token.methods.mint_to_public(user, 2n).send({ from: operator });

  const transferAuthwitNonce = Fr.random();
  const transferCall = token.methods.transfer_private_to_private(
    user,
    operator,
    expectedCharge,
    transferAuthwitNonce,
  );
  const transferAuthwit = await wallet.createAuthWit(user, {
    caller: creditFpc.address,
    action: transferCall,
  });

  const userTokenBefore = BigInt(
    (
      await token.methods.balance_of_private(user).simulate({ from: user })
    ).toString(),
  );
  const operatorTokenBefore = BigInt(
    (
      await token.methods
        .balance_of_private(operator)
        .simulate({ from: operator })
    ).toString(),
  );

  const payAndMintCall = await creditFpc.methods
    .pay_and_mint(
      transferAuthwitNonce,
      quote.rateNum,
      quote.rateDen,
      quote.validUntil,
      quote.quoteSigBytes,
      mintAmount,
    )
    .getFunctionCall();
  const payAndMintPaymentMethod = {
    getAsset: async () => ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new ExecutionPayload(
        [payAndMintCall],
        [transferAuthwit],
        [],
        [],
        creditFpc.address,
      ),
    getFeePayer: async () => creditFpc.address,
    getGasSettings: () => undefined,
  };

  const payAndMintReceipt = await token.methods
    .transfer_public_to_public(user, user, 1n, Fr.random())
    .send({
      from: user,
      fee: {
        paymentMethod: payAndMintPaymentMethod,
        gasSettings: {
          gasLimits: { daGas: config.daGasLimit, l2Gas: config.l2GasLimit },
          maxFeesPerGas: { feePerDaGas, feePerL2Gas },
        },
      },
      wait: { timeout: 180 },
    });

  const userTokenAfterPayAndMint = BigInt(
    (
      await token.methods.balance_of_private(user).simulate({ from: user })
    ).toString(),
  );
  const operatorTokenAfterPayAndMint = BigInt(
    (
      await token.methods
        .balance_of_private(operator)
        .simulate({ from: operator })
    ).toString(),
  );
  const userDebited = userTokenBefore - userTokenAfterPayAndMint;
  const operatorCredited = operatorTokenAfterPayAndMint - operatorTokenBefore;
  const creditAfterPayAndMint = BigInt(
    (
      await creditFpc.methods.balance_of(user).simulate({ from: user })
    ).toString(),
  );
  const expectedCreditAfterPayAndMint = mintAmount - maxGasCostNoTeardown;

  console.log(
    `[services-smoke:credit] pay_and_mint_tx_fee_juice=${payAndMintReceipt.transactionFee}`,
  );
  console.log(`[services-smoke:credit] user_debited=${userDebited}`);
  console.log(`[services-smoke:credit] operator_credited=${operatorCredited}`);
  console.log(
    `[services-smoke:credit] credit_after_pay_and_mint=${creditAfterPayAndMint}`,
  );

  if (userDebited !== expectedCharge) {
    throw new Error(
      `[services-smoke:credit] user debit mismatch after pay_and_mint. expected=${expectedCharge} got=${userDebited}`,
    );
  }
  if (operatorCredited !== expectedCharge) {
    throw new Error(
      `[services-smoke:credit] operator credit mismatch after pay_and_mint. expected=${expectedCharge} got=${operatorCredited}`,
    );
  }
  if (creditAfterPayAndMint !== expectedCreditAfterPayAndMint) {
    throw new Error(
      `[services-smoke:credit] credit balance mismatch after pay_and_mint. expected=${expectedCreditAfterPayAndMint} got=${creditAfterPayAndMint}`,
    );
  }

  const quoteUsed = await creditFpc.methods
    .quote_used(quote.rateNum, quote.rateDen, quote.validUntil, user)
    .simulate({ from: user });
  if (!quoteUsed) {
    throw new Error(
      "[services-smoke:credit] quote_used returned false after successful pay_and_mint",
    );
  }

  const creditBeforePayWithCredit = creditAfterPayAndMint;
  const operatorTokenBeforePayWithCredit = operatorTokenAfterPayAndMint;
  const payWithCreditCall = await creditFpc.methods
    .pay_with_credit()
    .getFunctionCall();
  const payWithCreditPaymentMethod = {
    getAsset: async () => ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new ExecutionPayload([payWithCreditCall], [], [], [], creditFpc.address),
    getFeePayer: async () => creditFpc.address,
    getGasSettings: () => undefined,
  };

  const payWithCreditReceipt = await token.methods
    .transfer_public_to_public(user, user, 1n, Fr.random())
    .send({
      from: user,
      fee: {
        paymentMethod: payWithCreditPaymentMethod,
        gasSettings: {
          gasLimits: { daGas: config.daGasLimit, l2Gas: config.l2GasLimit },
          maxFeesPerGas: { feePerDaGas, feePerL2Gas },
        },
      },
      wait: { timeout: 180 },
    });

  const creditAfterPayWithCredit = BigInt(
    (
      await creditFpc.methods.balance_of(user).simulate({ from: user })
    ).toString(),
  );
  const operatorTokenAfterPayWithCredit = BigInt(
    (
      await token.methods
        .balance_of_private(operator)
        .simulate({ from: operator })
    ).toString(),
  );

  console.log(
    `[services-smoke:credit] pay_with_credit_tx_fee_juice=${payWithCreditReceipt.transactionFee}`,
  );
  console.log(
    `[services-smoke:credit] credit_before_pay_with_credit=${creditBeforePayWithCredit}`,
  );
  console.log(
    `[services-smoke:credit] credit_after_pay_with_credit=${creditAfterPayWithCredit}`,
  );

  if (creditAfterPayWithCredit >= creditBeforePayWithCredit) {
    throw new Error(
      `[services-smoke:credit] credit should decrease after pay_with_credit. before=${creditBeforePayWithCredit} after=${creditAfterPayWithCredit}`,
    );
  }
  if (operatorTokenAfterPayWithCredit !== operatorTokenBeforePayWithCredit) {
    throw new Error(
      `[services-smoke:credit] operator token balance changed during pay_with_credit. before=${operatorTokenBeforePayWithCredit} after=${operatorTokenAfterPayWithCredit}`,
    );
  }

  console.log(
    "[services-smoke:credit] PASS: pay_and_mint + quote_used + pay_with_credit flow succeeded",
  );
}

async function main() {
  const config = getConfig();
  const scriptDir =
    typeof __dirname === "string"
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..", "..");
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "fpc-services-smoke-"));

  try {
    const needsFpc = config.mode !== "credit";
    const needsCredit = config.mode !== "fpc";

    const tokenArtifactPath = path.join(
      repoRoot,
      "target",
      "token_contract-Token.json",
    );
    const fpcArtifactPath = path.join(repoRoot, "target", "fpc-FPC.json");
    const creditFpcArtifactPath = path.join(
      repoRoot,
      "target",
      "credit_fpc-CreditFPC.json",
    );
    const tokenArtifact = loadArtifact(tokenArtifactPath);
    const fpcArtifact = needsFpc ? loadArtifact(fpcArtifactPath) : null;
    const creditFpcArtifact = needsCredit
      ? loadArtifact(creditFpcArtifactPath)
      : null;

    const node = createAztecNodeClient(config.nodeUrl);
    await waitForNodeReady(node, config.nodeTimeoutMs);
    const wallet = await EmbeddedWallet.create(node);

    const minFees = await node.getCurrentMinFees();
    const feePerDaGas = minFees.feePerDaGas;
    const feePerL2Gas = minFees.feePerL2Gas;
    const maxGasCostNoTeardown =
      BigInt(config.daGasLimit) * feePerDaGas +
      BigInt(config.l2GasLimit) * feePerL2Gas;
    const requiredTxCountPerScenario = config.mode === "fpc" ? 1n : 2n;
    const minimumTopupWei =
      maxGasCostNoTeardown *
        config.feeJuiceTopupSafetyMultiplier *
        requiredTxCountPerScenario +
      1_000_000n;
    const configuredTopupWei = readOptionalEnvBigInt(
      "FPC_SERVICES_SMOKE_TOPUP_WEI",
    );
    const topupAmount = configuredTopupWei ?? minimumTopupWei;
    if (topupAmount < minimumTopupWei) {
      throw new Error(
        `FPC_SERVICES_SMOKE_TOPUP_WEI=${topupAmount} is below required minimum ${minimumTopupWei}`,
      );
    }
    const thresholdOverride = readOptionalEnvBigInt(
      "FPC_SERVICES_SMOKE_THRESHOLD_WEI",
    );
    const topupThreshold = thresholdOverride ?? topupAmount;
    if (topupThreshold <= 0n) {
      throw new Error("Top-up threshold must be greater than zero");
    }

    const testAccounts = await getInitialTestAccountsData();
    const operatorData = testAccounts.at(0);
    const userData = testAccounts.at(1);
    if (!operatorData || !userData) {
      throw new Error("Expected at least 2 initial test accounts");
    }

    const [operator, user] = await Promise.all([
      wallet
        .createSchnorrAccount(
          operatorData.secret,
          operatorData.salt,
          operatorData.signingKey,
        )
        .then((account) => account.address),
      wallet
        .createSchnorrAccount(
          userData.secret,
          userData.salt,
          userData.signingKey,
        )
        .then((account) => account.address),
    ]);

    console.log(`[services-smoke] operator=${operator.toString()}`);
    console.log(`[services-smoke] user=${user.toString()}`);
    console.log(`[services-smoke] mode=${config.mode}`);

    const token = await Contract.deploy(
      wallet,
      tokenArtifact,
      ["SmokeToken", "SMK", 18, operator, operator],
      "constructor_with_minter",
    ).send({ from: operator });
    console.log(`[services-smoke] token=${token.address.toString()}`);

    // Derive operator signing pubkey for inline Schnorr verification.
    const schnorr = new Schnorr();
    const operatorSigningKey = deriveSigningKey(testAccounts[0].secret);
    const operatorPubKey = await schnorr.computePublicKey(operatorSigningKey);

    let fpc: Contract | null = null;
    if (fpcArtifact) {
      fpc = await Contract.deploy(wallet, fpcArtifact, [
        operator,
        operatorPubKey.x,
        operatorPubKey.y,
        token.address,
      ]).send({ from: operator });
      console.log(`[services-smoke] fpc=${fpc.address.toString()}`);
    }

    let creditFpc: Contract | null = null;
    if (creditFpcArtifact) {
      creditFpc = await Contract.deploy(wallet, creditFpcArtifact, [
        operator,
        operatorPubKey.x,
        operatorPubKey.y,
        token.address,
      ]).send({ from: operator });
      console.log(
        `[services-smoke] credit_fpc=${creditFpc.address.toString()}`,
      );
    }

    console.log(
      `[services-smoke] topup_threshold_wei=${topupThreshold} topup_amount_wei=${topupAmount}`,
    );

    const operatorSecretHex = operatorData.secret.toString();
    assertPrivateKeyHex(operatorSecretHex, "operator secret");

    const l1PrivateKey =
      process.env.FPC_SERVICES_SMOKE_L1_PRIVATE_KEY ??
      DEFAULT_LOCAL_L1_PRIVATE_KEY;
    assertPrivateKeyHex(l1PrivateKey, "FPC_SERVICES_SMOKE_L1_PRIVATE_KEY");
    for (const scenario of getScenarioKinds(config.mode)) {
      if (scenario === "fpc") {
        if (!fpc) {
          throw new Error(
            "FPC scenario selected but FPC contract was not deployed",
          );
        }
        const quote = await runServiceScenario(
          "fpc",
          config,
          repoRoot,
          tmpDir,
          node,
          wallet,
          token,
          operator,
          user,
          fpc.address,
          operatorSecretHex,
          l1PrivateKey as Hex,
          topupThreshold,
          topupAmount,
        );
        await runFpcFeeEntrypointScenario(
          config,
          wallet,
          token,
          fpc,
          operator,
          user,
          maxGasCostNoTeardown,
          feePerDaGas,
          feePerL2Gas,
          quote,
        );
        continue;
      }

      if (!creditFpc) {
        throw new Error(
          "CreditFPC scenario selected but CreditFPC contract was not deployed",
        );
      }
      const quote = await runServiceScenario(
        "credit",
        config,
        repoRoot,
        tmpDir,
        node,
        wallet,
        token,
        operator,
        user,
        creditFpc.address,
        operatorSecretHex,
        l1PrivateKey as Hex,
        topupThreshold,
        topupAmount,
      );
      await runCreditFeeScenario(
        config,
        wallet,
        token,
        creditFpc,
        operator,
        user,
        maxGasCostNoTeardown,
        feePerDaGas,
        feePerL2Gas,
        quote,
      );
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

void (async () => {
  try {
    await main();
    console.log("[services-smoke] PASS: full services smoke flow succeeded");
  } catch (error) {
    console.error(`[services-smoke] FAIL: ${(error as Error).message}`);
    process.exit(1);
  }
})();

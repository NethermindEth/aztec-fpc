import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import type { ContractArtifact } from "@aztec/aztec.js/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import {
  loadContractArtifact,
  loadContractArtifactForPublic,
} from "@aztec/stdlib/abi";
import { computeSecretHash } from "@aztec/stdlib/hash";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
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

const HEX_32_BYTE_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const AZTEC_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const L1_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ZERO_L1_ADDRESS_PATTERN = /^0x0{40}$/i;
const DEFAULT_LOCAL_L1_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const FEE_JUICE_PORTAL_ABI = parseAbi([
  "function depositToAztecPublic(bytes32 to, uint256 amount, bytes32 secretHash) returns (bytes32, uint256)",
  "event DepositToAztecPublic(bytes32 indexed to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)",
]);

type DeployOutput = {
  operator: string;
  accepted_asset: string;
  fpc_address: string;
  l1_chain_id: number;
  l2_chain_id: number;
  deployer?: {
    account_index?: number;
    address?: string;
  };
  deploy?: {
    token?: {
      source?: string;
    };
  };
};

type SmokeConfig = {
  nodeUrl: string;
  l1RpcUrl: string;
  l1PrivateKey: Hex;
  deployOutputPath: string;
  relayAdvanceBlocks: number;
  feeJuiceTopupWei: bigint;
  feeJuiceWaitTimeoutMs: number;
  pollMs: number;
};

function parsePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return value;
}

function readEnvNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return parsePositiveInteger(
    parsed,
    `Invalid numeric env var ${name}=${value}`,
  );
}

function readEnvBigInt(name: string, fallback: bigint): bigint {
  const value = process.env[name];
  if (!value) return fallback;
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(
      `Invalid bigint env var ${name}=${value}. Expected an unsigned integer.`,
    );
  }
  if (parsed <= 0n) {
    throw new Error(`Invalid bigint env var ${name}=${value}`);
  }
  return parsed;
}

function getConfig(): SmokeConfig {
  const nodeUrl = process.env.AZTEC_NODE_URL ?? "http://127.0.0.1:8080";
  const l1RpcUrl =
    process.env.FPC_DEPLOY_SMOKE_L1_RPC_URL ?? "http://127.0.0.1:8545";
  const l1PrivateKey = (process.env.FPC_DEPLOY_SMOKE_L1_PRIVATE_KEY ??
    DEFAULT_LOCAL_L1_PRIVATE_KEY) as Hex;
  const deployOutputPath = process.env.FPC_DEPLOY_SMOKE_DEPLOY_OUTPUT;
  if (!deployOutputPath) {
    throw new Error(
      "Missing FPC_DEPLOY_SMOKE_DEPLOY_OUTPUT. Run the wrapper script so deploy output is generated first.",
    );
  }

  if (!HEX_32_BYTE_PATTERN.test(l1PrivateKey)) {
    throw new Error(
      "FPC_DEPLOY_SMOKE_L1_PRIVATE_KEY must be a 32-byte 0x-prefixed private key",
    );
  }

  const relayAdvanceBlocks = readEnvNumber(
    "FPC_DEPLOY_SMOKE_RELAY_ADVANCE_BLOCKS",
    2,
  );
  if (relayAdvanceBlocks < 2) {
    throw new Error(
      `FPC_DEPLOY_SMOKE_RELAY_ADVANCE_BLOCKS must be >= 2 for local relay, got ${relayAdvanceBlocks}`,
    );
  }

  return {
    nodeUrl,
    l1RpcUrl,
    l1PrivateKey,
    deployOutputPath,
    relayAdvanceBlocks,
    feeJuiceTopupWei: readEnvBigInt("FPC_DEPLOY_SMOKE_TOPUP_WEI", 1_000_000n),
    feeJuiceWaitTimeoutMs: readEnvNumber(
      "FPC_DEPLOY_SMOKE_FEE_JUICE_WAIT_TIMEOUT_MS",
      180_000,
    ),
    pollMs: readEnvNumber("FPC_DEPLOY_SMOKE_POLL_MS", 1_000),
  };
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

function parseAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !AZTEC_ADDRESS_PATTERN.test(value)) {
    throw new Error(
      `Invalid deploy output field ${field}: expected 32-byte 0x address, got ${String(value)}`,
    );
  }
  return value;
}

function parsePositiveChainId(value: unknown, fieldName: string): number {
  let chainIdBigInt: bigint;
  if (typeof value === "number" && Number.isInteger(value)) {
    chainIdBigInt = BigInt(value);
  } else if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) {
    chainIdBigInt = BigInt(value);
  } else if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    chainIdBigInt = BigInt(value);
  } else {
    throw new Error(
      `Invalid ${fieldName}: expected integer chain-id, got ${String(value)}`,
    );
  }

  if (chainIdBigInt <= 0n) {
    throw new Error(`Invalid ${fieldName}: expected chain-id > 0`);
  }
  if (chainIdBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `Invalid ${fieldName}: ${chainIdBigInt.toString()} exceeds Number.MAX_SAFE_INTEGER`,
    );
  }
  return Number(chainIdBigInt);
}

function loadDeployOutput(deployOutputPath: string): DeployOutput {
  let raw: string;
  try {
    raw = readFileSync(deployOutputPath, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read deploy output at ${deployOutputPath}: ${String(error)}`,
    );
  }

  let parsed: Partial<DeployOutput>;
  try {
    parsed = JSON.parse(raw) as Partial<DeployOutput>;
  } catch (error) {
    throw new Error(
      `Deploy output at ${deployOutputPath} is not valid JSON: ${String(error)}`,
    );
  }

  return {
    operator: parseAddress(parsed.operator, "operator"),
    accepted_asset: parseAddress(parsed.accepted_asset, "accepted_asset"),
    fpc_address: parseAddress(parsed.fpc_address, "fpc_address"),
    l1_chain_id: parsePositiveChainId(
      parsed.l1_chain_id,
      "deploy output l1_chain_id",
    ),
    l2_chain_id: parsePositiveChainId(
      parsed.l2_chain_id,
      "deploy output l2_chain_id",
    ),
    deployer: parsed.deployer,
    deploy: parsed.deploy,
  };
}

function normalizeHexAddress(value: unknown, fieldName: string): Hex {
  let candidate: string;
  if (typeof value === "string") {
    candidate = value;
  } else if (
    value &&
    typeof value === "object" &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    candidate = value.toString();
  } else {
    throw new Error(`Invalid L1 address in node info for ${fieldName}`);
  }

  if (!L1_ADDRESS_PATTERN.test(candidate)) {
    throw new Error(
      `Invalid L1 address in node info for ${fieldName}: ${candidate}`,
    );
  }
  if (ZERO_L1_ADDRESS_PATTERN.test(candidate)) {
    throw new Error(`Invalid L1 address in node info for ${fieldName}: zero`);
  }
  return candidate as Hex;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFeeJuiceBalanceAtLeast(
  node: ReturnType<typeof createAztecNodeClient>,
  fpcAddress: AztecAddress,
  minBalance: bigint,
  timeoutMs: number,
  pollMs: number,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  let latestBalance = 0n;
  while (Date.now() <= deadline) {
    const balance = await getFeeJuiceBalance(fpcAddress, node);
    latestBalance = balance;
    if (balance >= minBalance) {
      return balance;
    }
    await sleep(pollMs);
  }
  throw new Error(
    `Timed out waiting for Fee Juice balance on ${fpcAddress.toString()} to reach ${minBalance.toString()} (latest=${latestBalance.toString()})`,
  );
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
    console.log(`[deploy-smoke] mock_relay_tx_confirmed=${i + 1}/${blocks}`);
  }
}

async function main() {
  const config = getConfig();
  console.log(`[deploy-smoke] aztec_node_url=${config.nodeUrl}`);
  console.log(`[deploy-smoke] l1_rpc_url=${config.l1RpcUrl}`);
  console.log(`[deploy-smoke] deploy_output=${config.deployOutputPath}`);

  const deployed = loadDeployOutput(config.deployOutputPath);
  const operatorAddress = AztecAddress.fromString(deployed.operator);
  const tokenAddress = AztecAddress.fromString(deployed.accepted_asset);
  const fpcAddress = AztecAddress.fromString(deployed.fpc_address);

  console.log(`[deploy-smoke] operator=${operatorAddress.toString()}`);
  console.log(`[deploy-smoke] token=${tokenAddress.toString()}`);
  console.log(`[deploy-smoke] fpc=${fpcAddress.toString()}`);

  const node = createAztecNodeClient(config.nodeUrl);
  await Promise.race([
    waitForNode(node),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`Timed out waiting for Aztec node at ${config.nodeUrl}`),
          ),
        45_000,
      ),
    ),
  ]);

  const publicClient = createPublicClient({
    transport: http(config.l1RpcUrl),
  });
  const l1RpcChainId = await publicClient.getChainId();
  if (l1RpcChainId !== deployed.l1_chain_id) {
    throw new Error(
      `L1 chain-id mismatch between deploy output (${deployed.l1_chain_id}) and L1 RPC (${l1RpcChainId})`,
    );
  }

  const nodeInfo = await node.getNodeInfo();
  const nodeL1ChainId = parsePositiveChainId(
    (nodeInfo as { l1ChainId?: unknown }).l1ChainId,
    "node info l1ChainId",
  );
  if (nodeL1ChainId !== deployed.l1_chain_id) {
    throw new Error(
      `L1 chain-id mismatch between deploy output (${deployed.l1_chain_id}) and node (${nodeL1ChainId})`,
    );
  }
  const nodeL2ChainId = parsePositiveChainId(
    await node.getChainId(),
    "node_getChainId",
  );
  if (nodeL2ChainId !== deployed.l2_chain_id) {
    throw new Error(
      `L2 chain-id mismatch between deploy output (${deployed.l2_chain_id}) and node (${nodeL2ChainId})`,
    );
  }

  const wallet = await EmbeddedWallet.create(node);
  const accounts = await getInitialTestAccountsData();
  if (accounts.length < 2) {
    throw new Error("Expected at least 2 test accounts for local smoke flow");
  }

  let operatorAccount: { address: AztecAddress } | null = null;
  let userAccount: { address: AztecAddress } | null = null;

  for (const account of accounts) {
    const created = await wallet.createSchnorrAccount(
      account.secret,
      account.salt,
      account.signingKey,
    );
    if (
      created.address.toString().toLowerCase() ===
      operatorAddress.toString().toLowerCase()
    ) {
      operatorAccount = created as { address: AztecAddress };
    } else if (!userAccount) {
      userAccount = created as { address: AztecAddress };
    }
  }

  if (!operatorAccount) {
    throw new Error(
      `Could not map deploy output operator ${operatorAddress.toString()} to a local test account. Use default FPC_LOCAL_OPERATOR or a known imported local test account.`,
    );
  }
  if (!userAccount) {
    throw new Error("Could not resolve a secondary test account for mock txs");
  }

  const tokenArtifact = loadArtifact(
    path.join(REPO_ROOT, "target", "token_contract-Token.json"),
  );
  const token = Contract.at(tokenAddress, tokenArtifact, wallet);

  const l1Addresses = nodeInfo.l1ContractAddresses as Record<string, unknown>;
  const feeJuiceAddressRaw =
    l1Addresses.feeJuiceAddress ?? l1Addresses.feeJuice;
  const feeJuicePortalAddressRaw =
    l1Addresses.feeJuicePortalAddress ?? l1Addresses.feeJuicePortal;
  if (!feeJuiceAddressRaw || !feeJuicePortalAddressRaw) {
    throw new Error("Node info is missing FeeJuice L1 contract addresses");
  }

  const feeJuiceAddress = normalizeHexAddress(
    feeJuiceAddressRaw,
    "feeJuiceAddress",
  );
  const feeJuicePortalAddress = normalizeHexAddress(
    feeJuicePortalAddressRaw,
    "feeJuicePortalAddress",
  );

  const l1Account = privateKeyToAccount(config.l1PrivateKey);
  const walletClient = createWalletClient({
    account: l1Account,
    transport: http(config.l1RpcUrl),
  });
  const initialBalance = await getFeeJuiceBalance(fpcAddress, node);

  const claimSecret = Fr.random();
  const claimSecretHash = await computeSecretHash(claimSecret);

  const approveTxHash = await walletClient.writeContract({
    address: feeJuiceAddress,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [feeJuicePortalAddress, config.feeJuiceTopupWei],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
  console.log(`[deploy-smoke] l1_fee_juice_approve_tx=${approveTxHash}`);

  const recipientBytes32 =
    `0x${fpcAddress.toString().replace("0x", "").padStart(64, "0")}` as Hex;
  const bridgeTxHash = await walletClient.writeContract({
    address: feeJuicePortalAddress,
    abi: FEE_JUICE_PORTAL_ABI,
    functionName: "depositToAztecPublic",
    args: [
      recipientBytes32,
      config.feeJuiceTopupWei,
      claimSecretHash.toString() as Hex,
    ],
  });
  const bridgeReceipt = await publicClient.waitForTransactionReceipt({
    hash: bridgeTxHash,
  });
  console.log(`[deploy-smoke] l1_fee_juice_bridge_tx=${bridgeTxHash}`);

  let messageLeafIndex: bigint | undefined;
  let l1ToL2MessageHash: Fr | undefined;

  for (const log of bridgeReceipt.logs) {
    if (log.address.toLowerCase() !== feeJuicePortalAddress.toLowerCase()) {
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
      "Could not decode DepositToAztecPublic event; cannot continue relay-aware smoke",
    );
  }

  await advanceL2Blocks(
    token,
    operatorAccount.address,
    userAccount.address,
    config.relayAdvanceBlocks,
  );

  await waitForL1ToL2MessageReady(node, l1ToL2MessageHash, {
    timeoutSeconds: Math.max(
      1,
      Math.floor(config.feeJuiceWaitTimeoutMs / 1000),
    ),
    forPublicConsumption: false,
  });
  console.log("[deploy-smoke] l1_to_l2_message_ready=true");

  const feeJuice = FeeJuiceContract.at(wallet);
  await feeJuice.methods
    .claim(
      fpcAddress,
      config.feeJuiceTopupWei,
      claimSecret,
      new Fr(messageLeafIndex),
    )
    .send({
      from: operatorAccount.address,
      wait: { timeout: 180 },
    });

  const expectedMinimumBalance = initialBalance + config.feeJuiceTopupWei;
  const finalBalance = await waitForFeeJuiceBalanceAtLeast(
    node,
    fpcAddress,
    expectedMinimumBalance,
    config.feeJuiceWaitTimeoutMs,
    config.pollMs,
  );
  console.log(
    `[deploy-smoke] fpc_fee_juice_balance=${finalBalance} expected_min=${expectedMinimumBalance}`,
  );
  console.log(
    "[deploy-smoke] PASS: deploy output is usable and relay flow works",
  );
}

void (async () => {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    console.error(`[deploy-smoke] FAIL: ${(error as Error).message}`);
    process.exit(1);
  }
})();

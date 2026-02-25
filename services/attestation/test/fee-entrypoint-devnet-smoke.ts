import { readFileSync } from "node:fs";
import path from "node:path";

import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import type { ContractArtifact } from "@aztec/aztec.js/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { computeInnerAuthWitHash } from "@aztec/aztec.js/authorization";
import { Contract } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import {
  FeeJuiceContract,
  ProtocolContractAddress,
} from "@aztec/aztec.js/protocol";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import {
  loadContractArtifact,
  loadContractArtifactForPublic,
} from "@aztec/stdlib/abi";
import { computeSecretHash } from "@aztec/stdlib/hash";
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

const QUOTE_DOMAIN_SEPARATOR = Fr.fromHexString("0x465043");
const DEFAULT_LOCAL_L1_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const FEE_JUICE_TOPUP_SAFETY_MULTIPLIER = 5n;
const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const FEE_JUICE_PORTAL_ABI = parseAbi([
  "function depositToAztecPublic(bytes32 to, uint256 amount, bytes32 secretHash) returns (bytes32, uint256)",
  "event DepositToAztecPublic(bytes32 indexed to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)",
]);

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
  relayAdvanceBlocks: number;
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

function getConfig(): SmokeConfig {
  const nodeUrl = process.env.AZTEC_NODE_URL ?? "http://localhost:8080";
  const nodeTimeoutMs = readEnvNumber("FPC_SMOKE_NODE_TIMEOUT_MS", 30_000);
  const l1RpcUrl = process.env.FPC_SMOKE_L1_RPC_URL ?? "http://localhost:8545";
  const l1PrivateKey = (process.env.FPC_SMOKE_L1_PRIVATE_KEY ??
    DEFAULT_LOCAL_L1_PRIVATE_KEY) as Hex;
  const feeJuiceTopupWei = readOptionalEnvBigInt(
    "FPC_SMOKE_FEE_JUICE_TOPUP_WEI",
  );
  const feeJuiceWaitTimeoutMs = readEnvNumber(
    "FPC_SMOKE_FEE_JUICE_WAIT_TIMEOUT_MS",
    120_000,
  );
  const rateNum = readEnvBigInt("FPC_SMOKE_RATE_NUM", 0n);
  const rateDen = readEnvBigInt("FPC_SMOKE_RATE_DEN", 1n);
  const quoteTtlSeconds = readEnvBigInt("FPC_SMOKE_QUOTE_TTL_SECONDS", 3600n);
  const daGasLimit = readEnvNumber("FPC_SMOKE_DA_GAS_LIMIT", 1_000_000);
  const l2GasLimit = readEnvNumber("FPC_SMOKE_L2_GAS_LIMIT", 1_000_000);
  const feePerDaGasOverride = readOptionalEnvBigInt("FPC_SMOKE_FEE_PER_DA_GAS");
  const feePerL2GasOverride = readOptionalEnvBigInt("FPC_SMOKE_FEE_PER_L2_GAS");
  const relayAdvanceBlocks = readEnvNumber("FPC_SMOKE_RELAY_ADVANCE_BLOCKS", 2);

  if (rateDen === 0n) {
    throw new Error("FPC_SMOKE_RATE_DEN must be non-zero");
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
    relayAdvanceBlocks,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    console.log(`[smoke] mock_relay_tx_confirmed=${i + 1}/${blocks}`);
  }
}

async function topUpFpcFeeJuice(
  config: SmokeConfig,
  node: ReturnType<typeof createAztecNodeClient>,
  wallet: EmbeddedWallet,
  operator: AztecAddress,
  token: Contract,
  user: AztecAddress,
  fpcAddress: string,
  topupWei: bigint,
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
    `0x${fpcAddress.replace("0x", "").padStart(64, "0")}` as Hex;

  const account = privateKeyToAccount(config.l1PrivateKey);
  const walletClient = createWalletClient({
    account,
    transport: http(config.l1RpcUrl),
  });
  const publicClient = createPublicClient({
    transport: http(config.l1RpcUrl),
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
  console.log(`[smoke] l1_fee_juice_approve_tx=${approveHash}`);

  const hash = await walletClient.writeContract({
    address: portalAddress,
    abi: FEE_JUICE_PORTAL_ABI,
    functionName: "depositToAztecPublic",
    args: [recipientBytes32, topupWei, claimSecretHash.toString() as Hex],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[smoke] l1_fee_juice_bridge_tx=${hash}`);

  let messageLeafIndex: bigint | undefined;
  let l1ToL2MessageHash: Fr | undefined;
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
      messageLeafIndex = decoded.args.index as bigint;
      l1ToL2MessageHash = Fr.fromHexString(decoded.args.key as string);
      break;
    } catch {
      // Ignore non-matching logs from the same contract.
    }
  }
  if (messageLeafIndex === undefined || !l1ToL2MessageHash) {
    throw new Error(
      "Could not decode DepositToAztecPublic event for Fee Juice bridge",
    );
  }

  // Local network requires additional L2 blocks before an L1->L2 message can
  // be consumed. Force block production with lightweight mock txs.
  await advanceL2Blocks(token, operator, user, config.relayAdvanceBlocks);

  await waitForL1ToL2MessageReady(node, l1ToL2MessageHash, {
    timeoutSeconds: Math.floor(config.feeJuiceWaitTimeoutMs / 1000),
    forPublicConsumption: false,
  });

  const feeJuice = FeeJuiceContract.at(wallet);
  await feeJuice.methods
    .claim(
      AztecAddress.fromString(fpcAddress),
      topupWei,
      claimSecret,
      new Fr(messageLeafIndex),
    )
    .send({ from: operator });

  const deadline = Date.now() + config.feeJuiceWaitTimeoutMs;
  while (Date.now() < deadline) {
    const balance = await getFeeJuiceBalance(
      AztecAddress.fromString(fpcAddress),
      node,
    );
    if (balance > 0n) {
      return balance;
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for Fee Juice credit on ${fpcAddress}`);
}

async function main() {
  const config = getConfig();
  const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
  const tokenArtifactPath = path.join(
    repoRoot,
    "target",
    "token_contract-Token.json",
  );
  const fpcArtifactPath = path.join(repoRoot, "target", "fpc-FPC.json");

  const tokenArtifact = loadArtifact(tokenArtifactPath);
  const fpcArtifact = loadArtifact(fpcArtifactPath);

  const node = createAztecNodeClient(config.nodeUrl);
  await Promise.race([
    waitForNode(node),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`Timed out waiting for Aztec node at ${config.nodeUrl}`),
          ),
        config.nodeTimeoutMs,
      ),
    ),
  ]);
  const wallet = await EmbeddedWallet.create(node);
  const minFees = await node.getCurrentMinFees();
  const feePerDaGas = config.feePerDaGasOverride ?? minFees.feePerDaGas;
  const feePerL2Gas = config.feePerL2GasOverride ?? minFees.feePerL2Gas;
  const maxGasCostNoTeardown =
    BigInt(config.daGasLimit) * feePerDaGas +
    BigInt(config.l2GasLimit) * feePerL2Gas;
  const minimumTopupWei =
    maxGasCostNoTeardown * FEE_JUICE_TOPUP_SAFETY_MULTIPLIER + 1_000_000n;
  const feeJuiceTopupWei = config.feeJuiceTopupWei ?? minimumTopupWei;
  if (
    config.feeJuiceTopupWei !== null &&
    config.feeJuiceTopupWei < minimumTopupWei
  ) {
    throw new Error(
      `FPC_SMOKE_FEE_JUICE_TOPUP_WEI=${config.feeJuiceTopupWei} is below required minimum ${minimumTopupWei} for current gas settings`,
    );
  }

  const testAccounts = await getInitialTestAccountsData();
  const [operator, user] = await Promise.all(
    testAccounts.slice(0, 2).map(async (account) => {
      return (
        await wallet.createSchnorrAccount(
          account.secret,
          account.salt,
          account.signingKey,
        )
      ).address;
    }),
  );

  console.log(`[smoke] operator=${operator.toString()}`);
  console.log(`[smoke] user=${user.toString()}`);

  const token = await Contract.deploy(
    wallet,
    tokenArtifact,
    ["SmokeToken", "SMK", 18, operator, operator],
    "constructor_with_minter",
  ).send({ from: operator });
  console.log(`[smoke] token=${token.address.toString()}`);

  const fpc = await Contract.deploy(wallet, fpcArtifact, [
    operator,
    token.address,
  ]).send({ from: operator });
  console.log(`[smoke] fpc=${fpc.address.toString()}`);

  console.log(`[smoke] fee_per_da_gas=${feePerDaGas}`);
  console.log(`[smoke] fee_per_l2_gas=${feePerL2Gas}`);
  console.log(`[smoke] fee_juice_topup_wei=${feeJuiceTopupWei}`);

  if (feeJuiceTopupWei > 0n) {
    const feeJuiceBalance = await topUpFpcFeeJuice(
      config,
      node,
      wallet,
      operator,
      token,
      user,
      fpc.address.toString(),
      feeJuiceTopupWei,
    );
    console.log(`[smoke] fpc_fee_juice_balance=${feeJuiceBalance}`);
  } else {
    console.log(
      "[smoke] skipping fee-juice top-up (FPC_SMOKE_FEE_JUICE_TOPUP_WEI=0)",
    );
  }

  const expectedCharge = ceilDiv(
    maxGasCostNoTeardown * config.rateNum,
    config.rateDen,
  );
  const mintAmount = expectedCharge + 1_000_000n;
  console.log(`[smoke] expected_charge=${expectedCharge}`);

  await token.methods
    .mint_to_private(user, mintAmount)
    .send({ from: operator });
  await token.methods.mint_to_public(user, 2n).send({ from: operator });

  const latestBlock = await node.getBlock("latest");
  if (!latestBlock) {
    throw new Error(
      "Could not read latest L2 block while building quote validity window",
    );
  }
  const validUntil = latestBlock.timestamp + config.quoteTtlSeconds;
  const quoteInnerHash = await computeInnerAuthWitHash([
    QUOTE_DOMAIN_SEPARATOR,
    fpc.address.toField(),
    token.address.toField(),
    new Fr(config.rateNum),
    new Fr(config.rateDen),
    new Fr(validUntil),
    user.toField(),
  ]);

  const quoteAuthwit = await wallet.createAuthWit(operator, {
    consumer: fpc.address,
    innerHash: quoteInnerHash,
  });

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
      config.rateNum,
      config.rateDen,
      validUntil,
    )
    .getFunctionCall();
  const fpcPaymentMethod = {
    getAsset: async () => ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new ExecutionPayload(
        [feeEntrypointCall],
        [quoteAuthwit, transferAuthwit],
        [],
        [],
        fpc.address,
      ),
    getFeePayer: async () => fpc.address,
    getGasSettings: () => undefined,
  };

  // Execute a normal user action while paying fees through FPC.
  const receipt = await token.methods
    .transfer_public_to_public(user, user, 1n, Fr.random())
    .send({
      from: user,
      fee: {
        paymentMethod: fpcPaymentMethod,
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

  console.log(`[smoke] expected_charge=${expectedCharge}`);
  console.log(`[smoke] user_debited=${userDebited}`);
  console.log(`[smoke] operator_credited=${operatorCredited}`);
  console.log(`[smoke] operator_balance_after=${operatorAfter}`);
  console.log(`[smoke] tx_fee_juice=${receipt.transactionFee}`);

  if (userDebited !== expectedCharge) {
    throw new Error(
      `User debit mismatch. expected=${expectedCharge} got=${userDebited}`,
    );
  }
  if (operatorCredited !== expectedCharge) {
    throw new Error(
      `Operator credit mismatch. expected=${expectedCharge} got=${operatorCredited}`,
    );
  }

  console.log("[smoke] PASS: fee_entrypoint end-to-end flow succeeded");
}

try {
  await main();
} catch (error) {
  console.error(`[smoke] FAIL: ${(error as Error).message}`);
  process.exit(1);
}

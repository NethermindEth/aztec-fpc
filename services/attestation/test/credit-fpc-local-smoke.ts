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

const QUOTE_DOMAIN_SEPARATOR = Fr.fromHexString("0x465043");
const DEFAULT_LOCAL_L1_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const FEE_JUICE_TOPUP_SAFETY_MULTIPLIER = 5n;
const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
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
  mintMultiplier: bigint;
  mintBuffer: bigint;
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
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
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
    const message =
      error instanceof Error ? error.message : JSON.stringify(error);
    const normalized = message.toLowerCase();
    if (
      expectedSubstrings.some((needle) =>
        normalized.includes(needle.toLowerCase()),
      )
    ) {
      console.log(`[credit-smoke] PASS: ${scenario}`);
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

function getConfig(): SmokeConfig {
  const nodeUrl = process.env.AZTEC_NODE_URL ?? "http://localhost:8080";
  const nodeTimeoutMs = readEnvNumber(
    "CREDIT_FPC_SMOKE_NODE_TIMEOUT_MS",
    30_000,
  );
  const l1RpcUrl =
    process.env.CREDIT_FPC_SMOKE_L1_RPC_URL ?? "http://localhost:8545";
  const l1PrivateKey = (process.env.CREDIT_FPC_SMOKE_L1_PRIVATE_KEY ??
    DEFAULT_LOCAL_L1_PRIVATE_KEY) as Hex;
  const feeJuiceTopupWei = readOptionalEnvBigInt(
    "CREDIT_FPC_SMOKE_FEE_JUICE_TOPUP_WEI",
  );
  const feeJuiceWaitTimeoutMs = readEnvNumber(
    "CREDIT_FPC_SMOKE_FEE_JUICE_WAIT_TIMEOUT_MS",
    120_000,
  );
  const rateNum = readEnvBigInt("CREDIT_FPC_SMOKE_RATE_NUM", 1n);
  const rateDen = readEnvBigInt("CREDIT_FPC_SMOKE_RATE_DEN", 1n);
  const quoteTtlSeconds = readEnvBigInt(
    "CREDIT_FPC_SMOKE_QUOTE_TTL_SECONDS",
    3600n,
  );
  const daGasLimit = readEnvNumber("CREDIT_FPC_SMOKE_DA_GAS_LIMIT", 1_000_000);
  const l2GasLimit = readEnvNumber("CREDIT_FPC_SMOKE_L2_GAS_LIMIT", 1_000_000);
  const feePerDaGasOverride = readOptionalEnvBigInt(
    "CREDIT_FPC_SMOKE_FEE_PER_DA_GAS",
  );
  const feePerL2GasOverride = readOptionalEnvBigInt(
    "CREDIT_FPC_SMOKE_FEE_PER_L2_GAS",
  );
  const relayAdvanceBlocks = readEnvNumber(
    "CREDIT_FPC_SMOKE_RELAY_ADVANCE_BLOCKS",
    2,
  );
  const mintMultiplier = readEnvBigInt("CREDIT_FPC_SMOKE_MINT_MULTIPLIER", 5n);
  const mintBuffer = readEnvBigInt("CREDIT_FPC_SMOKE_MINT_BUFFER", 1_000_000n);

  if (rateDen === 0n) {
    throw new Error("CREDIT_FPC_SMOKE_RATE_DEN must be non-zero");
  }
  if (rateNum <= 0n) {
    throw new Error("CREDIT_FPC_SMOKE_RATE_NUM must be > 0");
  }
  if (relayAdvanceBlocks < 2) {
    throw new Error(
      `CREDIT_FPC_SMOKE_RELAY_ADVANCE_BLOCKS must be >= 2, got ${relayAdvanceBlocks}`,
    );
  }
  if (mintMultiplier <= 1n) {
    throw new Error(
      `CREDIT_FPC_SMOKE_MINT_MULTIPLIER must be > 1, got ${mintMultiplier}`,
    );
  }
  if (mintBuffer <= 0n) {
    throw new Error(
      `CREDIT_FPC_SMOKE_MINT_BUFFER must be > 0, got ${mintBuffer}`,
    );
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
    mintMultiplier,
    mintBuffer,
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
    console.log(`[credit-smoke] mock_relay_tx_confirmed=${i + 1}/${blocks}`);
  }
}

async function topUpContractFeeJuice(
  config: SmokeConfig,
  node: ReturnType<typeof createAztecNodeClient>,
  wallet: EmbeddedWallet,
  operator: AztecAddress,
  token: Contract,
  user: AztecAddress,
  feePayerAddress: string,
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
    `0x${feePayerAddress.replace("0x", "").padStart(64, "0")}` as Hex;

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
  const l1FeeJuiceBalance = (await publicClient.readContract({
    address: feeJuiceTokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;
  let effectiveTopupWei = topupWei;
  if (effectiveTopupWei > l1FeeJuiceBalance) {
    if (config.feeJuiceTopupWei !== null) {
      throw new Error(
        `CREDIT_FPC_SMOKE_FEE_JUICE_TOPUP_WEI=${effectiveTopupWei} exceeds L1 FeeJuice balance ${l1FeeJuiceBalance} for ${account.address}`,
      );
    }
    effectiveTopupWei = l1FeeJuiceBalance;
    console.log(
      `[credit-smoke] fee_juice_topup_clamped_to_l1_balance=${effectiveTopupWei} requested=${topupWei}`,
    );
  }
  if (effectiveTopupWei <= 0n) {
    throw new Error(
      `L1 FeeJuice balance is ${l1FeeJuiceBalance}; cannot top up contract fee payer`,
    );
  }

  const approveHash = await walletClient.writeContract({
    address: feeJuiceTokenAddress,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [portalAddress, effectiveTopupWei],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log(`[credit-smoke] l1_fee_juice_approve_tx=${approveHash}`);

  const hash = await walletClient.writeContract({
    address: portalAddress,
    abi: FEE_JUICE_PORTAL_ABI,
    functionName: "depositToAztecPublic",
    args: [
      recipientBytes32,
      effectiveTopupWei,
      claimSecretHash.toString() as Hex,
    ],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[credit-smoke] l1_fee_juice_bridge_tx=${hash}`);

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

  await advanceL2Blocks(token, operator, user, config.relayAdvanceBlocks);

  await waitForL1ToL2MessageReady(node, l1ToL2MessageHash, {
    timeoutSeconds: Math.floor(config.feeJuiceWaitTimeoutMs / 1000),
    forPublicConsumption: false,
  });

  const feeJuice = FeeJuiceContract.at(wallet);
  await feeJuice.methods
    .claim(
      AztecAddress.fromString(feePayerAddress),
      effectiveTopupWei,
      claimSecret,
      new Fr(messageLeafIndex),
    )
    .send({ from: operator });

  const deadline = Date.now() + config.feeJuiceWaitTimeoutMs;
  while (Date.now() < deadline) {
    const balance = await getFeeJuiceBalance(
      AztecAddress.fromString(feePayerAddress),
      node,
    );
    if (balance > 0n) {
      return balance;
    }
    await sleep(2_000);
  }
  throw new Error(
    `Timed out waiting for Fee Juice credit on ${feePayerAddress}`,
  );
}

async function main() {
  const config = getConfig();
  const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
  const tokenArtifactPath = path.join(
    repoRoot,
    "target",
    "token_contract-Token.json",
  );
  const creditFpcArtifactPath = path.join(
    repoRoot,
    "target",
    "credit_fpc-BackedCreditFPC.json",
  );

  const tokenArtifact = loadArtifact(tokenArtifactPath);
  const creditFpcArtifact = loadArtifact(creditFpcArtifactPath);

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
  if (config.feeJuiceTopupWei !== null && config.feeJuiceTopupWei <= 0n) {
    throw new Error(
      `CREDIT_FPC_SMOKE_FEE_JUICE_TOPUP_WEI must be > 0, got ${config.feeJuiceTopupWei}`,
    );
  }
  if (
    config.feeJuiceTopupWei !== null &&
    config.feeJuiceTopupWei < minimumTopupWei
  ) {
    console.log(
      `[credit-smoke] WARNING: CREDIT_FPC_SMOKE_FEE_JUICE_TOPUP_WEI=${config.feeJuiceTopupWei} is below recommended ${minimumTopupWei} for current gas settings`,
    );
  }

  const testAccounts = await getInitialTestAccountsData();
  const [operator, user, userOverdraft] = await Promise.all(
    testAccounts.slice(0, 3).map(async (account) => {
      return (
        await wallet.createSchnorrAccount(
          account.secret,
          account.salt,
          account.signingKey,
        )
      ).address;
    }),
  );

  console.log(`[credit-smoke] operator=${operator.toString()}`);
  console.log(`[credit-smoke] user=${user.toString()}`);
  console.log(`[credit-smoke] user_overdraft=${userOverdraft.toString()}`);

  const schnorr = new Schnorr();
  const operatorSigningKey = deriveSigningKey(testAccounts[0].secret);
  const operatorPubKey = await schnorr.computePublicKey(operatorSigningKey);

  const token = await Contract.deploy(
    wallet,
    tokenArtifact,
    ["CreditSmokeToken", "CSMK", 18, operator, operator],
    "constructor_with_minter",
  ).send({ from: operator });
  console.log(`[credit-smoke] token=${token.address.toString()}`);

  const creditFpc = await Contract.deploy(wallet, creditFpcArtifact, [
    operator,
    operatorPubKey.x,
    operatorPubKey.y,
  ]).send({ from: operator });
  console.log(`[credit-smoke] credit_fpc=${creditFpc.address.toString()}`);

  console.log(`[credit-smoke] fee_per_da_gas=${feePerDaGas}`);
  console.log(`[credit-smoke] fee_per_l2_gas=${feePerL2Gas}`);
  console.log(`[credit-smoke] fee_juice_topup_wei=${feeJuiceTopupWei}`);

  const feeJuiceBalance = await topUpContractFeeJuice(
    config,
    node,
    wallet,
    operator,
    token,
    user,
    creditFpc.address.toString(),
    feeJuiceTopupWei,
  );
  console.log(`[credit-smoke] credit_fpc_fee_juice_balance=${feeJuiceBalance}`);

  const mintAmount =
    maxGasCostNoTeardown * config.mintMultiplier + config.mintBuffer;
  const expectedCharge = ceilDiv(mintAmount * config.rateNum, config.rateDen);
  const fjCreditAmount = mintAmount;
  const aaPaymentAmount = expectedCharge;
  console.log(`[credit-smoke] mint_amount=${mintAmount}`);
  console.log(`[credit-smoke] expected_charge=${expectedCharge}`);

  await token.methods
    .mint_to_private(user, expectedCharge + 1_000_000n)
    .send({ from: operator });
  await token.methods.mint_to_public(user, 2n).send({ from: operator });

  const latestBlock = await node.getBlock("latest");
  if (!latestBlock) {
    throw new Error(
      "Could not read latest L2 block while building quote validity window",
    );
  }
  const validUntil = latestBlock.timestamp + config.quoteTtlSeconds;
  const quoteHash = await computeInnerAuthWitHash([
    QUOTE_DOMAIN_SEPARATOR,
    creditFpc.address.toField(),
    token.address.toField(),
    new Fr(fjCreditAmount),
    new Fr(aaPaymentAmount),
    new Fr(validUntil),
    user.toField(),
  ]);
  const quoteSig = await schnorr.constructSignature(
    quoteHash.toBuffer(),
    operatorSigningKey,
  );
  const quoteSigBytes = Array.from(quoteSig.toBuffer());

  const transferAuthwitNonce = Fr.random();
  const transferCall = token.methods.transfer_private_to_private(
    user,
    operator,
    aaPaymentAmount,
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
      token.address,
      transferAuthwitNonce,
      fjCreditAmount,
      aaPaymentAmount,
      validUntil,
      quoteSigBytes,
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
          teardownGasLimits: { daGas: 0, l2Gas: 0 },
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
    `[credit-smoke] pay_and_mint_tx_fee_juice=${payAndMintReceipt.transactionFee}`,
  );
  console.log(`[credit-smoke] user_debited=${userDebited}`);
  console.log(`[credit-smoke] operator_credited=${operatorCredited}`);
  console.log(
    `[credit-smoke] credit_after_pay_and_mint=${creditAfterPayAndMint}`,
  );

  if (userDebited !== expectedCharge) {
    throw new Error(
      `User debit mismatch after pay_and_mint. expected=${expectedCharge} got=${userDebited}`,
    );
  }
  if (operatorCredited !== expectedCharge) {
    throw new Error(
      `Operator credit mismatch after pay_and_mint. expected=${expectedCharge} got=${operatorCredited}`,
    );
  }
  if (creditAfterPayAndMint !== expectedCreditAfterPayAndMint) {
    throw new Error(
      `Credit balance mismatch after pay_and_mint. expected=${expectedCreditAfterPayAndMint} got=${creditAfterPayAndMint}`,
    );
  }

  await token.methods.mint_to_public(user, 1n).send({ from: operator });

  // Fund a second private transfer so the direct-call negative path reaches
  // fee-entrypoint phase checks instead of failing early on token balance.
  await token.methods
    .mint_to_private(user, aaPaymentAmount + 1_000_000n)
    .send({ from: operator });

  const latestBlockForNegative = await node.getBlock("latest");
  if (!latestBlockForNegative) {
    throw new Error(
      "Could not read latest L2 block while building pay_and_mint negative quote",
    );
  }
  const negativeValidUntil =
    latestBlockForNegative.timestamp + config.quoteTtlSeconds;
  const negativeQuoteHash = await computeInnerAuthWitHash([
    QUOTE_DOMAIN_SEPARATOR,
    creditFpc.address.toField(),
    token.address.toField(),
    new Fr(fjCreditAmount),
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
    caller: creditFpc.address,
    action: negativeTransferCall,
  });
  await expectFailure(
    "direct pay_and_mint call rejected outside setup phase",
    ["must run in setup phase"],
    () =>
      creditFpc.methods
        .pay_and_mint(
          token.address,
          negativeTransferAuthwitNonce,
          fjCreditAmount,
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

  await expectFailure(
    "direct pay_with_credit call rejected outside setup phase",
    ["must run in setup phase"],
    () =>
      creditFpc.methods.pay_with_credit().send({
        from: user,
        wait: { timeout: 180 },
      }),
  );

  await expectFailure(
    "direct pay_with_credit_exact call rejected outside setup phase",
    ["must run in setup phase"],
    () =>
      creditFpc.methods.pay_with_credit_exact().send({
        from: user,
        wait: { timeout: 180 },
      }),
  );

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
    `[credit-smoke] pay_with_credit_tx_fee_juice=${payWithCreditReceipt.transactionFee}`,
  );
  console.log(
    `[credit-smoke] credit_before_pay_with_credit=${creditBeforePayWithCredit}`,
  );
  console.log(
    `[credit-smoke] credit_after_pay_with_credit=${creditAfterPayWithCredit}`,
  );

  if (creditAfterPayWithCredit >= creditBeforePayWithCredit) {
    throw new Error(
      `Credit should decrease after pay_with_credit. before=${creditBeforePayWithCredit} after=${creditAfterPayWithCredit}`,
    );
  }
  if (operatorTokenAfterPayWithCredit !== operatorTokenBeforePayWithCredit) {
    throw new Error(
      `Operator token balance changed during pay_with_credit-only tx. before=${operatorTokenBeforePayWithCredit} after=${operatorTokenAfterPayWithCredit}`,
    );
  }

  const creditBeforePayWithCreditExact = creditAfterPayWithCredit;
  const totalsBeforePayWithCreditExact = BigInt(
    (await creditFpc.methods.totals().simulate({ from: user })).toString(),
  );
  const operatorTokenBeforePayWithCreditExact = operatorTokenAfterPayWithCredit;
  const payWithCreditExactCall = await creditFpc.methods
    .pay_with_credit_exact()
    .getFunctionCall();
  const payWithCreditExactPaymentMethod = {
    getAsset: async () => ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new ExecutionPayload(
        [payWithCreditExactCall],
        [],
        [],
        [],
        creditFpc.address,
      ),
    getFeePayer: async () => creditFpc.address,
    getGasSettings: () => undefined,
  };

  const payWithCreditExactReceipt = await token.methods
    .transfer_public_to_public(user, user, 1n, Fr.random())
    .send({
      from: user,
      fee: {
        paymentMethod: payWithCreditExactPaymentMethod,
        gasSettings: {
          gasLimits: { daGas: config.daGasLimit, l2Gas: config.l2GasLimit },
          maxFeesPerGas: { feePerDaGas, feePerL2Gas },
        },
      },
      wait: { timeout: 180 },
    });

  const creditAfterPayWithCreditExact = BigInt(
    (
      await creditFpc.methods.balance_of(user).simulate({ from: user })
    ).toString(),
  );
  const totalsAfterPayWithCreditExact = BigInt(
    (await creditFpc.methods.totals().simulate({ from: user })).toString(),
  );
  const operatorTokenAfterPayWithCreditExact = BigInt(
    (
      await token.methods
        .balance_of_private(operator)
        .simulate({ from: operator })
    ).toString(),
  );
  const exactTxFee = BigInt(
    payWithCreditExactReceipt.transactionFee.toString(),
  );
  const exactCreditDelta =
    creditBeforePayWithCreditExact - creditAfterPayWithCreditExact;
  const exactTotalsDelta =
    totalsBeforePayWithCreditExact - totalsAfterPayWithCreditExact;

  console.log(
    `[credit-smoke] pay_with_credit_exact_tx_fee_juice=${payWithCreditExactReceipt.transactionFee}`,
  );
  console.log(
    `[credit-smoke] credit_before_pay_with_credit_exact=${creditBeforePayWithCreditExact}`,
  );
  console.log(
    `[credit-smoke] credit_after_pay_with_credit_exact=${creditAfterPayWithCreditExact}`,
  );

  // Invariant checks for pay_with_credit_exact:
  // 1) user-visible credit and global totals must move together
  // 2) the deduction must never be negative
  if (exactCreditDelta !== exactTotalsDelta) {
    throw new Error(
      `Exact credit/totals mismatch. credit_delta=${exactCreditDelta} totals_delta=${exactTotalsDelta}`,
    );
  }
  if (exactCreditDelta < 0n) {
    throw new Error(
      `Exact credit delta must be non-negative, got ${exactCreditDelta}`,
    );
  }
  if (exactCreditDelta !== exactTxFee) {
    console.log(
      `[credit-smoke] WARNING: exact delta differs from receipt fee. tx_fee=${exactTxFee} credit_delta=${exactCreditDelta}`,
    );
  }
  if (
    operatorTokenAfterPayWithCreditExact !==
    operatorTokenBeforePayWithCreditExact
  ) {
    throw new Error(
      `Operator token balance changed during pay_with_credit_exact-only tx. before=${operatorTokenBeforePayWithCreditExact} after=${operatorTokenAfterPayWithCreditExact}`,
    );
  }

  const observedPayWithCreditCost =
    creditBeforePayWithCredit - creditAfterPayWithCredit;
  if (observedPayWithCreditCost <= 0n) {
    throw new Error(
      `Observed pay_with_credit deduction must be positive, got ${observedPayWithCreditCost}`,
    );
  }

  // Deterministic overdraft scenario:
  // 1) mint net credit for exactly four pay_with_credit payments
  // 2) run four pay_with_credit-backed transactions (success)
  // 3) the fifth pay_with_credit-backed transaction must fail
  const plannedSuccessfulPayWithCreditTxs = 4n;
  const overdraftNetCredit =
    observedPayWithCreditCost * plannedSuccessfulPayWithCreditTxs;
  const overdraftFjCreditAmount = maxGasCostNoTeardown + overdraftNetCredit;
  const overdraftAaPaymentAmount = ceilDiv(
    overdraftFjCreditAmount * config.rateNum,
    config.rateDen,
  );

  // Ensure FeeJuice backing is high enough for the additional mint. The contract
  // requires: fee_juice_balance >= unspent_credits + mint_amount at finalize_mint.
  const currentTotals = BigInt(
    (await creditFpc.methods.totals().simulate({ from: operator })).toString(),
  );
  const currentFeeJuiceBalance = await getFeeJuiceBalance(
    creditFpc.address,
    node,
  );
  const requiredFeeJuiceBalance = currentTotals + overdraftFjCreditAmount;
  if (currentFeeJuiceBalance < requiredFeeJuiceBalance) {
    const topupDelta =
      requiredFeeJuiceBalance - currentFeeJuiceBalance + 1_000_000n;
    console.log(
      `[credit-smoke] overdraft_fee_juice_topup_delta=${topupDelta} current_balance=${currentFeeJuiceBalance} required_balance=${requiredFeeJuiceBalance}`,
    );
    const toppedUpBalance = await topUpContractFeeJuice(
      config,
      node,
      wallet,
      operator,
      token,
      user,
      creditFpc.address.toString(),
      topupDelta,
    );
    console.log(
      `[credit-smoke] overdraft_fee_juice_balance_after_topup=${toppedUpBalance}`,
    );
  }

  await token.methods
    .mint_to_private(userOverdraft, overdraftAaPaymentAmount + 1_000_000n)
    .send({ from: operator });
  await token.methods
    .mint_to_public(userOverdraft, 10n)
    .send({ from: operator });

  const overdraftQuoteBlock = await node.getBlock("latest");
  if (!overdraftQuoteBlock) {
    throw new Error(
      "Could not read latest L2 block while building overdraft quote validity window",
    );
  }
  const overdraftValidUntil =
    overdraftQuoteBlock.timestamp + config.quoteTtlSeconds;
  const overdraftQuoteHash = await computeInnerAuthWitHash([
    QUOTE_DOMAIN_SEPARATOR,
    creditFpc.address.toField(),
    token.address.toField(),
    new Fr(overdraftFjCreditAmount),
    new Fr(overdraftAaPaymentAmount),
    new Fr(overdraftValidUntil),
    userOverdraft.toField(),
  ]);
  const overdraftQuoteSig = await schnorr.constructSignature(
    overdraftQuoteHash.toBuffer(),
    operatorSigningKey,
  );
  const overdraftQuoteSigBytes = Array.from(overdraftQuoteSig.toBuffer());

  const overdraftTransferAuthwitNonce = Fr.random();
  const overdraftTransferCall = token.methods.transfer_private_to_private(
    userOverdraft,
    operator,
    overdraftAaPaymentAmount,
    overdraftTransferAuthwitNonce,
  );
  const overdraftTransferAuthwit = await wallet.createAuthWit(userOverdraft, {
    caller: creditFpc.address,
    action: overdraftTransferCall,
  });

  const overdraftPayAndMintCall = await creditFpc.methods
    .pay_and_mint(
      token.address,
      overdraftTransferAuthwitNonce,
      overdraftFjCreditAmount,
      overdraftAaPaymentAmount,
      overdraftValidUntil,
      overdraftQuoteSigBytes,
    )
    .getFunctionCall();
  const overdraftPayAndMintPaymentMethod = {
    getAsset: async () => ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new ExecutionPayload(
        [overdraftPayAndMintCall],
        [overdraftTransferAuthwit],
        [],
        [],
        creditFpc.address,
      ),
    getFeePayer: async () => creditFpc.address,
    getGasSettings: () => undefined,
  };

  await token.methods
    .transfer_public_to_public(userOverdraft, userOverdraft, 1n, Fr.random())
    .send({
      from: userOverdraft,
      fee: {
        paymentMethod: overdraftPayAndMintPaymentMethod,
        gasSettings: {
          gasLimits: { daGas: config.daGasLimit, l2Gas: config.l2GasLimit },
          teardownGasLimits: { daGas: 0, l2Gas: 0 },
          maxFeesPerGas: { feePerDaGas, feePerL2Gas },
        },
      },
      wait: { timeout: 180 },
    });

  const overdraftPayWithCreditCall = await creditFpc.methods
    .pay_with_credit()
    .getFunctionCall();
  const overdraftPayWithCreditPaymentMethod = {
    getAsset: async () => ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new ExecutionPayload(
        [overdraftPayWithCreditCall],
        [],
        [],
        [],
        creditFpc.address,
      ),
    getFeePayer: async () => creditFpc.address,
    getGasSettings: () => undefined,
  };

  const overdraftCreditStart = BigInt(
    (
      await creditFpc.methods
        .balance_of(userOverdraft)
        .simulate({ from: userOverdraft })
    ).toString(),
  );
  if (overdraftCreditStart !== overdraftNetCredit) {
    throw new Error(
      `Overdraft scenario credit mismatch after pay_and_mint. expected=${overdraftNetCredit} got=${overdraftCreditStart}`,
    );
  }

  for (let i = 0n; i < plannedSuccessfulPayWithCreditTxs; i += 1n) {
    await token.methods
      .transfer_public_to_public(userOverdraft, userOverdraft, 1n, Fr.random())
      .send({
        from: userOverdraft,
        fee: {
          paymentMethod: overdraftPayWithCreditPaymentMethod,
          gasSettings: {
            gasLimits: { daGas: config.daGasLimit, l2Gas: config.l2GasLimit },
            maxFeesPerGas: { feePerDaGas, feePerL2Gas },
          },
        },
        wait: { timeout: 180 },
      });
    console.log(
      `[credit-smoke] overdraft_pay_with_credit_success=${i + 1n}/${plannedSuccessfulPayWithCreditTxs}`,
    );
  }

  await expectFailure(
    "fifth pay_with_credit tx fails after exhausting four-credit budget",
    ["Balance too low or note insufficient", "credit underflow"],
    () =>
      token.methods
        .transfer_public_to_public(
          userOverdraft,
          userOverdraft,
          1n,
          Fr.random(),
        )
        .send({
          from: userOverdraft,
          fee: {
            paymentMethod: overdraftPayWithCreditPaymentMethod,
            gasSettings: {
              gasLimits: { daGas: config.daGasLimit, l2Gas: config.l2GasLimit },
              maxFeesPerGas: { feePerDaGas, feePerL2Gas },
            },
          },
          wait: { timeout: 180 },
        }),
  );

  console.log(
    "[credit-smoke] PASS: credit_fpc pay_and_mint + pay_with_credit flow succeeded",
  );
}

try {
  await main();
} catch (error) {
  const err = error as Error;
  console.error(`[credit-smoke] FAIL: ${err.message}`);
  if (err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
}

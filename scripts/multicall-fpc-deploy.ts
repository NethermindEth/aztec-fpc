/**
 * MultiCall FPC Bridge MVP
 *
 * Demonstrates the onboarding flow for a new user who has no L2 account
 * and no Fee Juice. A single MultiCallEntrypoint transaction atomically:
 *   1. Deploys the user's Account Contract
 *   2. Claims bridged tokens privately via TokenBridge.claim_private
 *   3. Pays the transaction fee via FPC using the just-claimed tokens
 *
 * Deployment order (breaks circular dependencies):
 *   1. Deploy L1 TokenPortal (uninitialized)
 *   2. Deploy L2 Bridge with L1 portal address
 *   3. Deploy L2 Token with bridge as minter
 *   4. Call bridge.set_token(token_address)
 *   5. Initialize L1 TokenPortal with (registry, erc20, l2Bridge)
 *
 * Usage: AZTEC_NODE_URL=http://localhost:8080 bun run scripts/multicall-fpc-deploy.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import type { ContractArtifact } from "@aztec/aztec.js/abi";
import { AztecAddress, EthAddress } from "@aztec/aztec.js/addresses";
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
  TokenPortalAbi,
  TokenPortalBytecode,
  TestERC20Abi,
  TestERC20Bytecode,
} from "@aztec/l1-artifacts";
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
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const FEE_JUICE_PORTAL_ABI = parseAbi([
  "function depositToAztecPublic(bytes32 to, uint256 amount, bytes32 secretHash) returns (bytes32, uint256)",
  "event DepositToAztecPublic(bytes32 indexed to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)",
]);

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function loadArtifact(artifactPath: string): ContractArtifact {
  const raw = readFileSync(artifactPath, "utf8");
  const parsed = JSON.parse(raw) as NoirCompiledContract;
  try {
    return loadContractArtifact(parsed);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes(
        "Contract's public bytecode has not been transpiled",
      )
    ) {
      return loadContractArtifactForPublic(parsed);
    }
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHexAddress(value: unknown, fieldName: string): Hex {
  if (typeof value === "string") return value as Hex;
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

async function advanceL2Blocks(
  noop: Contract,
  operator: AztecAddress,
  blocks: number,
): Promise<void> {
  for (let i = 0; i < blocks; i += 1) {
    await noop.methods.noop().send({
      from: operator,
      wait: { timeout: 180 },
    });
    console.log(`[multicall] advance_block=${i + 1}/${blocks}`);
  }
}

async function topUpFpcFeeJuice(
  node: ReturnType<typeof createAztecNodeClient>,
  wallet: EmbeddedWallet,
  operator: AztecAddress,
  noop: Contract,
  fpcAddress: AztecAddress,
  topupWei: bigint,
  l1RpcUrl: string,
  l1PrivateKey: Hex,
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
    `0x${fpcAddress.toString().replace("0x", "").padStart(64, "0")}` as Hex;

  const account = privateKeyToAccount(l1PrivateKey);
  const walletClient = createWalletClient({
    account,
    transport: http(l1RpcUrl),
  });
  const publicClient = createPublicClient({ transport: http(l1RpcUrl) });

  const l1Balance = (await publicClient.readContract({
    address: feeJuiceTokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  } as any)) as bigint;
  if (l1Balance === 0n) {
    throw new Error(
      `L1 FeeJuice balance is zero for ${account.address}; cannot fund FPC fee payer`,
    );
  }
  const bridgeAmount = topupWei > l1Balance ? l1Balance : topupWei;

  const claimSecret = Fr.random();
  const claimSecretHash = await computeSecretHash(claimSecret);

  const approveHash = await walletClient.writeContract({
    address: feeJuiceTokenAddress,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [portalAddress, bridgeAmount],
  } as any);
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const hash = await walletClient.writeContract({
    address: portalAddress,
    abi: FEE_JUICE_PORTAL_ABI,
    functionName: "depositToAztecPublic",
    args: [recipientBytes32, bridgeAmount, claimSecretHash.toString() as Hex],
  } as any);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[multicall] l1_fee_juice_bridge_tx=${hash}`);

  let messageLeafIndex: bigint | undefined;
  let l1ToL2MessageHash: Fr | undefined;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== portalAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: FEE_JUICE_PORTAL_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "DepositToAztecPublic") continue;
      messageLeafIndex = (decoded.args as any).index as bigint;
      l1ToL2MessageHash = Fr.fromHexString((decoded.args as any).key as string);
      break;
    } catch {
      /* skip non-matching logs */
    }
  }
  if (messageLeafIndex === undefined || !l1ToL2MessageHash) {
    throw new Error("Could not decode DepositToAztecPublic event");
  }

  await advanceL2Blocks(noop, operator, 2);
  await waitForL1ToL2MessageReady(node, l1ToL2MessageHash, {
    timeoutSeconds: 120,
    forPublicConsumption: false,
  });

  const feeJuice = FeeJuiceContract.at(wallet);
  await feeJuice.methods
    .claim(fpcAddress, bridgeAmount, claimSecret, new Fr(messageLeafIndex))
    .send({ from: operator });

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const balance = await getFeeJuiceBalance(fpcAddress, node);
    if (balance > 0n) return balance;
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for Fee Juice credit on ${fpcAddress}`);
}

async function main() {
  const nodeUrl = process.env.AZTEC_NODE_URL ?? "http://localhost:8080";
  const l1RpcUrl = process.env.L1_RPC_URL ?? "http://localhost:8545";
  const l1PrivateKey = (process.env.L1_PRIVATE_KEY ??
    DEFAULT_LOCAL_L1_PRIVATE_KEY) as Hex;
  const daGasLimit = 1_000_000;
  const l2GasLimit = 1_000_000;
  const rateNum = 10_200n;
  const rateDen = 10_000_000n;
  const quoteTtlSeconds = 3600n;

  const repoRoot = path.resolve(import.meta.dirname, "..");
  const tokenArtifactPath = path.join(
    repoRoot,
    "target",
    "token_contract-Token.json",
  );
  const fpcArtifactPath = path.join(
    repoRoot,
    "target",
    "fpc-FPCMultiAsset.json",
  );
  const bridgeArtifactPath = path.join(
    repoRoot,
    "target",
    "token_bridge_contract-TokenBridge.json",
  );
  const noopArtifactPath = path.join(repoRoot, "target", "noop-Noop.json");

  const tokenArtifact = loadArtifact(tokenArtifactPath);
  const fpcArtifact = loadArtifact(fpcArtifactPath);
  const bridgeArtifact = loadArtifact(bridgeArtifactPath);
  const noopArtifact = loadArtifact(noopArtifactPath);

  console.log(`[multicall] connecting to ${nodeUrl}`);
  const node = createAztecNodeClient(nodeUrl);
  await Promise.race([
    waitForNode(node),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Node timeout")), 30_000),
    ),
  ]);
  const wallet = await EmbeddedWallet.create(node);
  const minFees = await node.getCurrentMinFees();
  const feePerDaGas = minFees.feePerDaGas;
  const feePerL2Gas = minFees.feePerL2Gas;

  const maxGasCost =
    BigInt(daGasLimit) * feePerDaGas + BigInt(l2GasLimit) * feePerL2Gas;
  const aaPaymentAmount = ceilDiv(maxGasCost * rateNum, rateDen);
  const bridgeAmount = aaPaymentAmount * 2n;
  console.log(
    `[multicall] feePerDaGas=${feePerDaGas} feePerL2Gas=${feePerL2Gas} maxGasCost=${maxGasCost} aaPaymentAmount=${aaPaymentAmount} bridgeAmount=${bridgeAmount}`,
  );

  const testAccounts = await getInitialTestAccountsData();
  const [operatorAccount, newUserAccount] = await Promise.all([
    wallet.createSchnorrAccount(
      testAccounts[0].secret,
      testAccounts[0].salt,
      testAccounts[0].signingKey,
    ),
    wallet.createSchnorrAccount(
      testAccounts[1].secret,
      testAccounts[1].salt,
      testAccounts[1].signingKey,
    ),
  ]);
  const operator = operatorAccount.address;
  const newUser = newUserAccount.address;
  console.log(`[multicall] operator=${operator}`);
  console.log(`[multicall] new_user=${newUser}`);

  const schnorr = new Schnorr();
  const operatorSigningKey = deriveSigningKey(testAccounts[0].secret);
  const operatorPubKey = await schnorr.computePublicKey(operatorSigningKey);

  console.log("[multicall] deploying L1 contracts...");
  const l1Account = privateKeyToAccount(l1PrivateKey);
  const l1WalletClient = createWalletClient({
    account: l1Account,
    transport: http(l1RpcUrl),
  });
  const l1PublicClient = createPublicClient({ transport: http(l1RpcUrl) });

  const deployErc20Hash = await l1WalletClient.deployContract({
    abi: TestERC20Abi as any,
    bytecode: TestERC20Bytecode as Hex,
    args: ["BridgeToken", "BTK", l1Account.address],
  });
  const erc20Receipt = await l1PublicClient.waitForTransactionReceipt({
    hash: deployErc20Hash,
  });
  const l1Erc20Address = erc20Receipt.contractAddress!;
  console.log(`[multicall] l1_erc20=${l1Erc20Address}`);

  // TokenPortal initialized later after L2 bridge is deployed
  const deployPortalHash = await l1WalletClient.deployContract({
    abi: TokenPortalAbi as any,
    bytecode: TokenPortalBytecode as Hex,
    args: [],
  });
  const portalReceipt = await l1PublicClient.waitForTransactionReceipt({
    hash: deployPortalHash,
  });
  const l1TokenPortalAddress = portalReceipt.contractAddress!;
  console.log(`[multicall] l1_token_portal=${l1TokenPortalAddress}`);

  console.log("[multicall] deploying L2 bridge...");
  const bridge = await Contract.deploy(
    wallet,
    bridgeArtifact,
    [EthAddress.fromString(l1TokenPortalAddress)],
    "constructor",
  ).send({ from: operator });
  console.log(`[multicall] bridge=${bridge.address}`);

  console.log("[multicall] deploying L2 token with bridge as minter...");
  const token = await Contract.deploy(
    wallet,
    tokenArtifact,
    ["BridgeToken", "BTK", 18, bridge.address, operator],
    "constructor_with_minter",
  ).send({ from: operator });
  console.log(`[multicall] token=${token.address}`);

  console.log("[multicall] setting token on bridge...");
  await bridge.methods
    .set_token(token.address)
    .send({ from: operator, wait: { timeout: 180 } });
  console.log("[multicall] bridge_token_set");

  console.log("[multicall] initializing L1 TokenPortal...");
  const nodeInfo = await node.getNodeInfo();
  const l1Addresses = nodeInfo.l1ContractAddresses as Record<string, unknown>;
  const registryAddress = normalizeHexAddress(
    l1Addresses.registryAddress ?? l1Addresses.registry,
    "registryAddress",
  );
  const l2BridgeBytes32 =
    `0x${bridge.address.toString().replace("0x", "").padStart(64, "0")}` as Hex;
  const initHash = await l1WalletClient.writeContract({
    address: l1TokenPortalAddress,
    abi: TokenPortalAbi as any,
    functionName: "initialize",
    args: [registryAddress, l1Erc20Address, l2BridgeBytes32],
  } as any);
  await l1PublicClient.waitForTransactionReceipt({ hash: initHash });
  console.log("[multicall] token_portal_initialized");

  console.log("[multicall] deploying Noop (for block advancement)...");
  const noop = await Contract.deploy(wallet, noopArtifact, []).send({
    from: operator,
  });
  console.log(`[multicall] noop=${noop.address}`);

  console.log("[multicall] deploying FPC...");
  const fpc = await Contract.deploy(wallet, fpcArtifact, [
    operator,
    operatorPubKey.x,
    operatorPubKey.y,
  ]).send({ from: operator });
  console.log(`[multicall] fpc=${fpc.address}`);

  const feeJuiceTopup =
    maxGasCost * FEE_JUICE_TOPUP_SAFETY_MULTIPLIER + 1_000_000n;
  console.log("[multicall] topping up FPC with Fee Juice...");
  const feeJuiceBalance = await topUpFpcFeeJuice(
    node,
    wallet,
    operator,
    noop,
    fpc.address,
    feeJuiceTopup,
    l1RpcUrl,
    l1PrivateKey,
  );
  console.log(`[multicall] fpc_fee_juice_balance=${feeJuiceBalance}`);

  console.log("[multicall] performing L1 deposit...");

  const addMinterHash = await l1WalletClient.writeContract({
    address: l1Erc20Address,
    abi: TestERC20Abi as any,
    functionName: "addMinter",
    args: [l1Account.address],
  } as any);
  await l1PublicClient.waitForTransactionReceipt({ hash: addMinterHash });

  const mintHash = await l1WalletClient.writeContract({
    address: l1Erc20Address,
    abi: TestERC20Abi as any,
    functionName: "mint",
    args: [l1Account.address, bridgeAmount],
  } as any);
  await l1PublicClient.waitForTransactionReceipt({ hash: mintHash });

  const approveHash = await l1WalletClient.writeContract({
    address: l1Erc20Address,
    abi: TestERC20Abi as any,
    functionName: "approve",
    args: [l1TokenPortalAddress, bridgeAmount],
  } as any);
  await l1PublicClient.waitForTransactionReceipt({ hash: approveHash });

  const claimSecret = Fr.random();
  const claimSecretHash = await computeSecretHash(claimSecret);

  const depositHash = await l1WalletClient.writeContract({
    address: l1TokenPortalAddress,
    abi: TokenPortalAbi as any,
    functionName: "depositToAztecPrivate",
    args: [bridgeAmount, claimSecretHash.toString() as Hex],
  } as any);
  const depositReceipt = await l1PublicClient.waitForTransactionReceipt({
    hash: depositHash,
  });
  console.log(`[multicall] l1_deposit_tx=${depositHash}`);

  const depositToPrivateEventAbi = [
    {
      type: "event" as const,
      name: "DepositToAztecPrivate" as const,
      inputs: [
        {
          name: "amount",
          type: "uint256" as const,
          indexed: false,
          internalType: "uint256" as const,
        },
        {
          name: "secretHashForL2MessageConsumption",
          type: "bytes32" as const,
          indexed: false,
          internalType: "bytes32" as const,
        },
        {
          name: "key",
          type: "bytes32" as const,
          indexed: false,
          internalType: "bytes32" as const,
        },
        {
          name: "index",
          type: "uint256" as const,
          indexed: false,
          internalType: "uint256" as const,
        },
      ],
      anonymous: false,
    },
  ] as const;

  let messageLeafIndex: bigint | undefined;
  let messageHash: Fr | undefined;
  for (const log of depositReceipt.logs) {
    if (log.address.toLowerCase() !== l1TokenPortalAddress.toLowerCase())
      continue;
    try {
      const decoded = decodeEventLog({
        abi: depositToPrivateEventAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "DepositToAztecPrivate") continue;
      messageLeafIndex = decoded.args.index;
      messageHash = Fr.fromHexString(decoded.args.key);
      break;
    } catch {
      /* skip non-matching logs */
    }
  }
  if (messageLeafIndex === undefined || !messageHash) {
    throw new Error("Could not decode DepositToAztecPrivate event");
  }
  console.log(
    `[multicall] message_leaf_index=${messageLeafIndex} message_hash=${messageHash}`,
  );

  console.log("[multicall] waiting for L1->L2 message readiness...");
  await advanceL2Blocks(noop, operator, 2);
  await waitForL1ToL2MessageReady(node, messageHash, {
    timeoutSeconds: 120,
    forPublicConsumption: false,
  });
  console.log("[multicall] l1_to_l2_message_ready");

  console.log("[multicall] building multicall transaction...");

  const fjFeeAmount = maxGasCost;

  const latestBlock = await node.getBlock("latest");
  if (!latestBlock) throw new Error("Could not read latest L2 block");
  const validUntil = latestBlock.timestamp + quoteTtlSeconds;

  const quoteHash = await computeInnerAuthWitHash([
    QUOTE_DOMAIN_SEPARATOR,
    fpc.address.toField(),
    token.address.toField(),
    new Fr(fjFeeAmount),
    new Fr(aaPaymentAmount),
    new Fr(validUntil),
    newUser.toField(),
  ]);
  const quoteSig = await schnorr.constructSignature(
    quoteHash.toBuffer(),
    operatorSigningKey,
  );
  const quoteSigBytes = Array.from(quoteSig.toBuffer());

  const claimPrivateCall = await bridge.methods
    .claim_private(
      token.address,
      newUser,
      bridgeAmount,
      claimSecret,
      new Fr(messageLeafIndex),
    )
    .getFunctionCall();

  const transferAuthwitNonce = Fr.random();
  const transferFnCall = await token.methods
    .transfer_private_to_private(
      newUser,
      operator,
      aaPaymentAmount,
      transferAuthwitNonce,
    )
    .getFunctionCall();
  const transferAuthwit = await wallet.createAuthWit(newUser, {
    caller: fpc.address,
    call: transferFnCall,
  });

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

  const feeExecutionPayload = new ExecutionPayload(
    [claimPrivateCall, feeEntrypointCall],
    [transferAuthwit],
    [],
    [],
    fpc.address,
  );

  console.log("[multicall] sending multicall transaction...");
  const deployMethod = await newUserAccount.getDeployMethod();
  const deployPayload = await deployMethod.request({
    from: newUser,
    deployer: AztecAddress.ZERO,
  } as any);

  // Manually merge deploy and fee payloads, overriding feePayer to FPC.
  // DeployMethod.request() sets the deployer as feePayer, which conflicts
  // with our FPC feePayer, so we construct a combined payload ourselves.
  const mergedPayload = new ExecutionPayload(
    [...feeExecutionPayload.calls, ...deployPayload.calls],
    [
      ...(feeExecutionPayload.authWitnesses ?? []),
      ...(deployPayload.authWitnesses ?? []),
    ],
    [
      ...(feeExecutionPayload.capsules ?? []),
      ...(deployPayload.capsules ?? []),
    ],
    [
      ...(feeExecutionPayload.extraHashedArgs ?? []),
      ...(deployPayload.extraHashedArgs ?? []),
    ],
    fpc.address,
  );

  const deployReceipt = await wallet.sendTx(mergedPayload, {
    from: newUser,
    fee: {
      gasSettings: {
        gasLimits: { daGas: daGasLimit, l2Gas: l2GasLimit },
        teardownGasLimits: { daGas: 0, l2Gas: 0 },
        maxFeesPerGas: { feePerDaGas, feePerL2Gas },
      },
    },
    wait: { timeout: 300 },
  } as any);
  console.log(`[multicall] tx_hash=${deployReceipt.txHash}`);
  console.log(`[multicall] tx_fee=${deployReceipt.transactionFee}`);

  console.log("[multicall] verifying...");

  const userBalance = BigInt(
    (
      await token.methods
        .balance_of_private(newUser)
        .simulate({ from: newUser })
    ).toString(),
  );
  console.log(`[multicall] user_private_balance=${userBalance}`);

  const operatorBalance = BigInt(
    (
      await token.methods
        .balance_of_private(operator)
        .simulate({ from: operator })
    ).toString(),
  );
  console.log(`[multicall] operator_private_balance=${operatorBalance}`);

  const expectedUserBalance = bridgeAmount - aaPaymentAmount;
  if (userBalance < expectedUserBalance) {
    console.warn(
      `[multicall] WARN: user balance ${userBalance} lower than expected ${expectedUserBalance}`,
    );
  }

  if (operatorBalance < aaPaymentAmount) {
    console.warn(
      `[multicall] WARN: operator did not receive expected payment ${aaPaymentAmount}`,
    );
  }

  console.log("[multicall] PASS: multicall FPC bridge flow succeeded");
}

try {
  await main();
} catch (error) {
  console.error(`[multicall] FAIL: ${(error as Error).message}`);
  console.error((error as Error).stack);
  process.exit(1);
}

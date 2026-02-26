/**
 * One-shot AltFPC gate count profiler.
 *
 * Profiles AltFPC.pay_and_mint and/or AltFPC.pay_fee by deploying Token + AltFPC
 * on a running local network and executing a full profile trace.
 *
 * Usage:
 *   node profiling/profile-alt-fpc-gates.mjs [--scenario pay_and_mint|pay_fee|both]
 *
 * Environment:
 *   AZTEC_NODE_URL  Node endpoint (default http://127.0.0.1:8080)
 *   ALT_FPC_TARGET  Artifact directory (default contracts/alt_fpc/alt_fpc/target)
 */

const NODE_URL = process.env.AZTEC_NODE_URL || "http://127.0.0.1:8080";
const TARGET_DIR =
  process.env.ALT_FPC_TARGET || "contracts/alt_fpc/alt_fpc/target";

const RATE_NUM = 1n;
const RATE_DEN = 1n;
const QUOTE_DOMAIN_SEP = 0x465043n; // "FPC"

import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { Contract } from "@aztec/aztec.js/contracts";
import { AccountManager } from "@aztec/aztec.js/wallet";
import { SchnorrAccountContract } from "@aztec/accounts/schnorr";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import { Fr } from "@aztec/foundation/curves/bn254";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { computeInnerAuthWitHash } from "@aztec/stdlib/auth-witness";
import {
  FunctionCall,
  FunctionSelector,
  FunctionType,
  loadContractArtifact,
  loadContractArtifactForPublic,
} from "@aztec/stdlib/abi";
import { ExecutionPayload } from "@aztec/stdlib/tx";
import { Gas, GasFees, GasSettings } from "@aztec/stdlib/gas";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import { createPXE, getPXEConfig } from "@aztec/pxe/server";
import { BaseWallet } from "@aztec/wallet-sdk/base-wallet";
import {
  readFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
  statSync,
  existsSync,
} from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = resolve(__dirname, "..", TARGET_DIR);
const REPO_ROOT = resolve(__dirname, "..");
const TOKEN_ARTIFACT_FALLBACK = resolve(
  __dirname,
  "token_contract-Token.aztec.json",
);

function parseScenarioArg() {
  const arg = process.argv.find((v) => v.startsWith("--scenario="));
  if (!arg) return "both";
  const scenario = arg.split("=")[1];
  if (!["pay_and_mint", "pay_fee", "both"].includes(scenario)) {
    throw new Error(
      `Invalid scenario '${scenario}'. Use pay_and_mint, pay_fee, or both.`,
    );
  }
  return scenario;
}

function findArtifact(contractName) {
  const suffix = `-${contractName}.json`;
  const matches = readdirSync(TARGET).filter((f) => f.endsWith(suffix));
  if (matches.length === 0) {
    throw new Error(
      `No artifact matching *${suffix} in ${TARGET}. Compile alt_fpc first.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple artifacts matching *${suffix} in ${TARGET}: ${matches.join(", ")}`,
    );
  }
  return join(TARGET, matches[0]);
}

function loadArtifactFromPath(artifactPath) {
  const parsed = JSON.parse(readFileSync(artifactPath, "utf8"));
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

function chooseTokenArtifactPath() {
  if (existsSync(TOKEN_ARTIFACT_FALLBACK)) {
    return TOKEN_ARTIFACT_FALLBACK;
  }
  return findArtifact("Token");
}

// ── Network timestamp (seconds) from latest block, fallback to wall clock ─────
async function getNetworkTimestamp(node) {
  const header = await node.getBlockHeader('latest').catch(() => null);
  const ts = header?.globalVariables?.timestamp;
  return ts != null ? BigInt(ts) : BigInt(Math.floor(Date.now() / 1000));
}

function feeJuiceToAsset(feeJuice, rateNum, rateDen) {
  if (feeJuice === 0n) return 0n;
  return (feeJuice * rateNum + rateDen - 1n) / rateDen;
}

function maxGasCostNoTeardown(gasSettings) {
  return (
    gasSettings.maxFeesPerGas.feePerDaGas * BigInt(gasSettings.gasLimits.daGas) +
    gasSettings.maxFeesPerGas.feePerL2Gas * BigInt(gasSettings.gasLimits.l2Gas)
  );
}

class SimpleWallet extends BaseWallet {
  #accounts = new Map();

  constructor(pxe, node) {
    super(pxe, node);
  }

  async addSchnorrAccount(secret, salt) {
    const contract = new SchnorrAccountContract(deriveSigningKey(secret));
    const manager = await AccountManager.create(this, secret, contract, new Fr(salt));
    const instance = manager.getInstance();
    const artifact = await contract.getContractArtifact();
    await this.registerContract(instance, artifact, secret);
    this.#accounts.set(manager.address.toString(), await manager.getAccount());
    return manager.address;
  }
}

class PayAndMintPaymentMethod {
  constructor(params) {
    this.fpcAddress = params.fpcAddress;
    this.transferAuthWit = params.transferAuthWit;
    this.quoteSigFields = params.quoteSigFields;
    this.transferNonce = params.transferNonce;
    this.rateNum = params.rateNum;
    this.rateDen = params.rateDen;
    this.validUntil = params.validUntil;
    this.mintAmount = params.mintAmount;
    this.gasSettings = params.gasSettings;
  }

  getFeePayer() {
    return Promise.resolve(this.fpcAddress);
  }

  getGasSettings() {
    return this.gasSettings;
  }

  async getExecutionPayload() {
    const selector = await FunctionSelector.fromSignature(
      "pay_and_mint(Field,u128,u128,u64,[u8;64],u128)",
    );
    const feeCall = FunctionCall.from({
      name: "pay_and_mint",
      to: this.fpcAddress,
      selector,
      type: FunctionType.PRIVATE,
      hideMsgSender: false,
      isStatic: false,
      args: [
        new Fr(this.transferNonce),
        new Fr(this.rateNum),
        new Fr(this.rateDen),
        new Fr(this.validUntil),
        ...this.quoteSigFields,
        new Fr(this.mintAmount),
      ],
      returnTypes: [],
    });

    return new ExecutionPayload(
      [feeCall],
      [this.transferAuthWit],
      [],
      [],
      this.fpcAddress,
    );
  }
}

class PayFeePaymentMethod {
  constructor(params) {
    this.fpcAddress = params.fpcAddress;
    this.gasSettings = params.gasSettings;
  }

  getFeePayer() {
    return Promise.resolve(this.fpcAddress);
  }

  getGasSettings() {
    return this.gasSettings;
  }

  async getExecutionPayload() {
    const selector = await FunctionSelector.fromSignature("pay_fee()");
    const feeCall = FunctionCall.from({
      name: "pay_fee",
      to: this.fpcAddress,
      selector,
      type: FunctionType.PRIVATE,
      hideMsgSender: false,
      isStatic: false,
      args: [],
      returnTypes: [],
    });

    return new ExecutionPayload([feeCall], [], [], [], this.fpcAddress);
  }
}

function printProfileTable(result) {
  const pad = (s, n) => String(s).padEnd(n);
  const fmt = (n) => n.toLocaleString();
  console.log(pad("Function", 60), pad("Own gates", 12), "Subtotal");
  console.log("-".repeat(88));
  let subtotal = 0;
  for (const step of result.executionSteps) {
    subtotal += step.gateCount ?? 0;
    console.log(
      pad(step.functionName ?? "(unknown)", 60),
      pad(fmt(step.gateCount ?? 0), 12),
      fmt(subtotal),
    );
  }
  console.log("-".repeat(88));
  console.log(pad("TOTAL", 60), "", fmt(subtotal));
}

function printTargetSummary(result, targetSuffix) {
  const match = result.executionSteps.find(
    (s) =>
      typeof s.functionName === "string" &&
      s.functionName.toLowerCase().includes(targetSuffix.toLowerCase()),
  );
  if (!match) {
    console.log(`[summary] target row not found for ${targetSuffix}`);
    return;
  }
  console.log(
    `[summary] ${match.functionName} own_gates=${match.gateCount ?? 0}`,
  );
}

async function buildScenarioContext(scenarioName) {
  const pxeDir = `/tmp/profile-alt-fpc-${scenarioName}-pxe`;
  rmSync(pxeDir, { recursive: true, force: true });
  mkdirSync(pxeDir, { recursive: true });

  const node = createAztecNodeClient(NODE_URL);
  const pxeConfig = {
    ...getPXEConfig(),
    dataDirectory: pxeDir,
    l1Contracts: await node.getL1ContractAddresses(),
  };
  const pxe = await createPXE(node, pxeConfig);
  const wallet = new SimpleWallet(pxe, node);

  const [userData, operatorData] = await getInitialTestAccountsData();
  const userAddress = await wallet.addSchnorrAccount(userData.secret, userData.salt);
  const operatorAddress = await wallet.addSchnorrAccount(
    operatorData.secret,
    operatorData.salt,
  );

  const schnorr = new Schnorr();
  const operatorSigningKey = deriveSigningKey(operatorData.secret);
  const operatorPubKey = await schnorr.computePublicKey(operatorSigningKey);

  const tokenArtifact = loadArtifactFromPath(chooseTokenArtifactPath());
  const altArtifact = loadArtifactFromPath(findArtifact("AltFPC"));

  let token;
  try {
    token = await Contract.deploy(
      wallet,
      tokenArtifact,
      ["AltProfileToken", "APT", 18, operatorAddress, AztecAddress.ZERO],
      "constructor_with_minter",
    ).send({ from: userAddress });
  } catch {
    token = await Contract.deploy(
      wallet,
      tokenArtifact,
      ["AltProfileToken", "APT", 18, operatorAddress, AztecAddress.ZERO],
      "__aztec_nr_internals__constructor_with_minter",
    ).send({ from: userAddress });
  }

  const altFpc = await Contract.deploy(wallet, altArtifact, [
    operatorAddress,
    operatorPubKey.x,
    operatorPubKey.y,
    token.address,
  ]).send({ from: userAddress });

  const tokenAsUser = Contract.at(token.address, tokenArtifact, wallet);
  const minFees = await node.getCurrentMinFees();
  const feeDa = minFees.feePerDaGas;
  const feeL2 = minFees.feePerL2Gas;
  const daGas = 786432n;
  const l2Gas = 6540000n;
  const gasSettings = GasSettings.default({
    gasLimits: new Gas(Number(daGas), Number(l2Gas)),
    maxFeesPerGas: new GasFees(feeDa, feeL2),
  });

  return {
    pxe,
    pxeDir,
    wallet,
    node,
    token,
    tokenAsUser,
    altFpc,
    userAddress,
    operatorAddress,
    gasSettings,
    schnorr,
    operatorSigningKey,
  };
}

async function buildPayAndMintPayment({
  node,
  wallet,
  tokenAsUser,
  altFpc,
  userAddress,
  operatorAddress,
  gasSettings,
  mintAmount,
  schnorr,
  operatorSigningKey,
}) {
  const networkTs = await getNetworkTimestamp(node);
  const validUntil = networkTs + 3600n;
  const transferNonce = BigInt(Date.now());

  const quoteHash = await computeInnerAuthWitHash([
    new Fr(QUOTE_DOMAIN_SEP),
    altFpc.address.toField(),
    tokenAsUser.address.toField(),
    new Fr(RATE_NUM),
    new Fr(RATE_DEN),
    new Fr(validUntil),
    userAddress.toField(),
  ]);

  const quoteSig = await schnorr.constructSignature(quoteHash.toBuffer(), operatorSigningKey);
  const quoteSigFields = Array.from(quoteSig.toBuffer()).map((b) => new Fr(b));

  const charge = feeJuiceToAsset(mintAmount, RATE_NUM, RATE_DEN);
  const transferAuthWit = await wallet.createAuthWit(userAddress, {
    caller: altFpc.address,
    action: tokenAsUser.methods.transfer_private_to_private(
      userAddress,
      operatorAddress,
      charge,
      transferNonce,
    ),
  });

  const paymentMethod = new PayAndMintPaymentMethod({
    fpcAddress: altFpc.address,
    transferAuthWit,
    quoteSigFields,
    transferNonce,
    rateNum: RATE_NUM,
    rateDen: RATE_DEN,
    validUntil,
    mintAmount,
    gasSettings,
  });

  return { paymentMethod, charge };
}

async function runPayAndMintScenario() {
  const ctx = await buildScenarioContext("pay_and_mint");
  try {
    const maxNoTeardown = maxGasCostNoTeardown(ctx.gasSettings);
    const mintAmount = maxNoTeardown + 1000n;
    const { paymentMethod, charge } = await buildPayAndMintPayment({
      node: ctx.node,
      wallet: ctx.wallet,
      tokenAsUser: ctx.tokenAsUser,
      altFpc: ctx.altFpc,
      userAddress: ctx.userAddress,
      operatorAddress: ctx.operatorAddress,
      gasSettings: ctx.gasSettings,
      mintAmount,
      schnorr: ctx.schnorr,
      operatorSigningKey: ctx.operatorSigningKey,
    });

    await ctx.tokenAsUser.methods
      .mint_to_private(ctx.userAddress, charge + 1000n)
      .send({ from: ctx.userAddress });

    const result = await ctx.tokenAsUser.methods
      .transfer_private_to_private(ctx.userAddress, ctx.userAddress, 1n, 0n)
      .profile({
        fee: { paymentMethod, gasSettings: ctx.gasSettings },
        from: ctx.userAddress,
        additionalScopes: [ctx.operatorAddress],
        profileMode: "full",
        skipProofGeneration: false,
      });

    console.log("\n=== Scenario: pay_and_mint ===\n");
    printProfileTable(result);
    printTargetSummary(result, "pay_and_mint");
  } finally {
    await ctx.pxe.stop?.();
    rmSync(ctx.pxeDir, { recursive: true, force: true });
  }
}

async function runPayFeeScenario() {
  const ctx = await buildScenarioContext("pay_fee");
  try {
    const maxNoTeardown = maxGasCostNoTeardown(ctx.gasSettings);
    const seedMintAmount = maxNoTeardown * 3n;
    const { paymentMethod: seedPayment, charge: seedCharge } =
      await buildPayAndMintPayment({
        node: ctx.node,
        wallet: ctx.wallet,
        tokenAsUser: ctx.tokenAsUser,
        altFpc: ctx.altFpc,
        userAddress: ctx.userAddress,
        operatorAddress: ctx.operatorAddress,
        gasSettings: ctx.gasSettings,
        mintAmount: seedMintAmount,
        schnorr: ctx.schnorr,
        operatorSigningKey: ctx.operatorSigningKey,
      });

    await ctx.tokenAsUser.methods
      .mint_to_private(ctx.userAddress, seedCharge + 5000n)
      .send({ from: ctx.userAddress });

    // Seed internal balance_set credit by executing pay_and_mint once.
    await ctx.tokenAsUser.methods
      .transfer_private_to_private(ctx.userAddress, ctx.userAddress, 1n, 0n)
      .send({
        from: ctx.userAddress,
        fee: { paymentMethod: seedPayment, gasSettings: ctx.gasSettings },
        additionalScopes: [ctx.operatorAddress],
        wait: { timeout: 180 },
      });

    const payFeePayment = new PayFeePaymentMethod({
      fpcAddress: ctx.altFpc.address,
      gasSettings: ctx.gasSettings,
    });

    const result = await ctx.tokenAsUser.methods
      .transfer_private_to_private(ctx.userAddress, ctx.userAddress, 1n, 0n)
      .profile({
        fee: { paymentMethod: payFeePayment, gasSettings: ctx.gasSettings },
        from: ctx.userAddress,
        profileMode: "full",
        skipProofGeneration: false,
      });

    console.log("\n=== Scenario: pay_fee ===\n");
    printProfileTable(result);
    printTargetSummary(result, "pay_fee");
  } finally {
    await ctx.pxe.stop?.();
    rmSync(ctx.pxeDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log("=== AltFPC Gate Count Profiler ===");
  console.log(`node:   ${NODE_URL}`);
  console.log(`target: ${TARGET}`);

  if (!existsSync(TARGET) || !statSync(TARGET).isDirectory()) {
    throw new Error(
      `Artifact directory does not exist: ${TARGET}. Run compile first.`,
    );
  }

  // Optional preflight warning for known alt_fpc dependency layout mismatch.
  const rootVendorToken = join(REPO_ROOT, "vendor/aztec-standards/src/token_contract");
  const contractsVendorToken = join(
    REPO_ROOT,
    "contracts/vendor/aztec-standards/src/token_contract",
  );
  if (existsSync(rootVendorToken) && !existsSync(contractsVendorToken)) {
    console.log(
      "[preflight] note: alt_fpc Nargo token path may require contracts/vendor symlink/layout.",
    );
  }

  const scenario = parseScenarioArg();
  if (scenario === "pay_and_mint" || scenario === "both") {
    await runPayAndMintScenario();
  }
  if (scenario === "pay_fee" || scenario === "both") {
    await runPayFeeScenario();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

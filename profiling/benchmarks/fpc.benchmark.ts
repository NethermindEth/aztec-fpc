/**
 * FPC benchmark using @defi-wonderland/aztec-benchmark.
 *
 * Deploys Token + FPC on a running local network, bridges Fee Juice,
 * mints tokens, builds authwits, and benchmarks FPC.fee_entrypoint
 * via a dummy app transaction (token self-transfer).
 *
 * The aztec-benchmark profiler calls .simulate(), .profile(), and .send()
 * on each interaction. The FPC fee payment method is attached automatically
 * so the profile captures all execution steps including fee_entrypoint.
 *
 * Environment:
 *   AZTEC_NODE_URL  — node endpoint  (default http://127.0.0.1:8080)
 *   L1_RPC_URL      — L1 (anvil) endpoint (default http://127.0.0.1:8545)
 */

import type { ContractFunctionInteractionCallIntent } from '@aztec/aztec.js/authorization';
import type { FeePaymentMethod } from '@aztec/aztec.js/fee';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { Contract } from '@aztec/aztec.js/contracts';
import { AccountManager } from '@aztec/aztec.js/wallet';
import { L1FeeJuicePortalManager } from '@aztec/aztec.js/ethereum';
import { SchnorrAccountContract } from '@aztec/accounts/schnorr';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { Fr } from '@aztec/foundation/curves/bn254';
import { createLogger } from '@aztec/foundation/log';
import { Schnorr } from '@aztec/foundation/crypto/schnorr';
import { FeeJuiceArtifact } from '@aztec/protocol-contracts/fee-juice';
import { ProtocolContractAddress } from '@aztec/protocol-contracts';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { computeInnerAuthWitHash } from '@aztec/stdlib/auth-witness';
import {
  FunctionCall,
  FunctionSelector,
  FunctionType,
  loadContractArtifact,
} from '@aztec/stdlib/abi';
import { ExecutionPayload } from '@aztec/stdlib/tx';
import { Gas, GasFees, GasSettings } from '@aztec/stdlib/gas';
import { deriveSigningKey } from '@aztec/stdlib/keys';
import { createPXE, getPXEConfig } from '@aztec/pxe/server';
import { BaseWallet } from '@aztec/wallet-sdk/base-wallet';
import {
  createWalletClient,
  defineChain,
  http,
  publicActions,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ── Constants ────────────────────────────────────────────────────────────────

const NODE_URL = process.env.AZTEC_NODE_URL || 'http://127.0.0.1:8080';
const L1_RPC_URL = process.env.L1_RPC_URL || 'http://127.0.0.1:8545';
const PXE_DATA_DIR = '/tmp/benchmark-fpc-pxe';

// Anvil default account 0 — only used for bridging Fee Juice in local dev.
const ANVIL_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const RATE_NUM = 1n;
const RATE_DEN = 1n;
const QUOTE_TTL_SECONDS = 3500n;
const QUOTE_DOMAIN_SEP = 0x465043n; // "FPC" as field

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = join(__dirname, '../../target');

// ── Helpers ──────────────────────────────────────────────────────────────────

function findArtifact(contractName: string): string {
  const suffix = `-${contractName}.json`;
  const matches = readdirSync(TARGET).filter((f) => f.endsWith(suffix));
  if (matches.length === 0) {
    throw new Error(
      `No artifact matching *${suffix} in ${TARGET}. Did you run 'aztec compile'?`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple artifacts matching *${suffix} in ${TARGET}: ${matches.join(', ')}`,
    );
  }
  return join(TARGET, matches[0]);
}

/** Ceiling division mirroring fee_math.nr */
function feeJuiceToAsset(
  feeJuice: bigint,
  rateNum: bigint,
  rateDen: bigint,
): bigint {
  if (feeJuice === 0n) return 0n;
  const product = feeJuice * rateNum;
  return (product + rateDen - 1n) / rateDen;
}

/** Sign a quote with the operator's Schnorr key. */
async function signQuote(
  schnorr: any,
  operatorSigningKey: any,
  fpcAddress: any,
  tokenAddress: any,
  rateNum: bigint,
  rateDen: bigint,
  validUntil: bigint,
  userAddress: any,
): Promise<any[]> {
  const quoteHash = await computeInnerAuthWitHash([
    new Fr(QUOTE_DOMAIN_SEP),
    fpcAddress.toField(),
    tokenAddress.toField(),
    new Fr(rateNum),
    new Fr(rateDen),
    new Fr(validUntil),
    userAddress.toField(),
  ]);
  const sig = await schnorr.constructSignature(
    quoteHash.toBuffer(),
    operatorSigningKey,
  );
  return Array.from(sig.toBuffer()).map((b: number) => new Fr(b));
}

// ── SimpleWallet ─────────────────────────────────────────────────────────────

class SimpleWallet extends BaseWallet {
  #accounts = new Map<string, any>();

  constructor(pxe: any, node: any) {
    super(pxe, node);
  }

  async addSchnorrAccount(secret: any, salt: any) {
    const contract = new SchnorrAccountContract(deriveSigningKey(secret));
    const manager = await AccountManager.create(
      this,
      secret,
      contract,
      new Fr(salt),
    );
    const instance = manager.getInstance();
    const artifact = await contract.getContractArtifact();
    await this.registerContract(instance, artifact, secret);
    this.#accounts.set(
      manager.address.toString(),
      await manager.getAccount(),
    );
    return manager.address;
  }

  async getAccountFromAddress(address: any) {
    const key = address.toString();
    if (!this.#accounts.has(key)) throw new Error(`Account not found: ${key}`);
    return this.#accounts.get(key);
  }

  async getAccounts() {
    return [...this.#accounts.keys()].map((addr) => ({
      alias: '',
      item: AztecAddress.fromString(addr),
    }));
  }
}

// ── CustomFPCPaymentMethod ───────────────────────────────────────────────────

class CustomFPCPaymentMethod {
  fpcAddress: any;
  transferAuthWit: any;
  quoteSigFields: any[];
  transferNonce: bigint;
  rateNum: bigint;
  rateDen: bigint;
  validUntil: bigint;
  gasSettings: any;

  constructor(
    fpcAddress: any,
    transferAuthWit: any,
    quoteSigFields: any[],
    transferNonce: bigint,
    rateNum: bigint,
    rateDen: bigint,
    validUntil: bigint,
    gasSettings: any,
  ) {
    this.fpcAddress = fpcAddress;
    this.transferAuthWit = transferAuthWit;
    this.quoteSigFields = quoteSigFields;
    this.transferNonce = transferNonce;
    this.rateNum = rateNum;
    this.rateDen = rateDen;
    this.validUntil = validUntil;
    this.gasSettings = gasSettings;
  }

  getFeePayer() {
    return Promise.resolve(this.fpcAddress);
  }
  getGasSettings() {
    return this.gasSettings;
  }

  async getExecutionPayload() {
    const selector = await FunctionSelector.fromSignature(
      'fee_entrypoint(Field,u128,u128,u64,[u8;64])',
    );

    const feeCall = FunctionCall.from({
      name: 'fee_entrypoint',
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

// ── L1 helpers (Fee Juice bridging) ──────────────────────────────────────────

async function createL1Client(node: any) {
  const nodeInfo = await node.getNodeInfo();
  const chain = defineChain({
    id: nodeInfo.l1ChainId,
    name: 'Local L1',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [L1_RPC_URL] } },
  });
  const account = privateKeyToAccount(ANVIL_PRIVATE_KEY as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(L1_RPC_URL),
  });
  return walletClient.extend(publicActions);
}

async function mineL1Blocks(l1Client: any, count: number) {
  for (let i = 0; i < count; i++) {
    await l1Client.request({ method: 'evm_mine', params: [] });
  }
}

/**
 * Bridge Fee Juice from L1 and claim on L2 so the FPC can act as fee payer.
 * Reuses the pattern from profile-gates-credit-fpc.mjs.
 */
async function fundFpcWithFeeJuice(
  node: any,
  wallet: SimpleWallet,
  fpcAddress: any,
  userAddress: any,
  tokenContract: any,
  l1Client: any,
) {
  const logger = createLogger('benchmark:bridge');
  const portalManager = await L1FeeJuicePortalManager.new(
    node,
    l1Client,
    logger,
  );

  const MINT_AMOUNT = 10n ** 21n;
  console.log(`Bridging ${MINT_AMOUNT} Fee Juice to FPC (L1 deposit)...`);
  const claim = await portalManager.bridgeTokensPublic(
    fpcAddress,
    MINT_AMOUNT,
    true,
  );
  console.log(
    `L1 deposit confirmed (messageLeafIndex=${claim.messageLeafIndex})`,
  );

  // Mine a small number of L1 blocks so the archiver discovers the deposit.
  await mineL1Blocks(l1Client, 5);

  const feeJuice = Contract.at(
    ProtocolContractAddress.FeeJuice,
    FeeJuiceArtifact,
    wallet,
  );
  const MAX_ATTEMPTS = 30;

  function isRetryable(msg: string) {
    return (
      msg.includes('No L1 to L2 message found') ||
      (msg.includes('Block hash') && msg.includes('not found'))
    );
  }

  console.log('Waiting for L2 to process L1 deposit...');
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));

    try {
      await tokenContract.methods
        .mint_to_private(userAddress, 1n)
        .send({ from: userAddress });
    } catch (e: any) {
      const msg = e.originalMessage || e.message || '';
      console.log(
        `  [${attempt}/${MAX_ATTEMPTS}] dummy tx failed: ${msg.substring(0, 80)}`,
      );
      try {
        await mineL1Blocks(l1Client, 1);
      } catch {}
      continue;
    }

    try {
      await feeJuice.methods
        .claim(
          fpcAddress,
          claim.claimAmount,
          claim.claimSecret,
          claim.messageLeafIndex,
        )
        .send({ from: userAddress });
      console.log(`Fee Juice claimed (attempt ${attempt}).`);
      return;
    } catch (e: any) {
      const msg = e.originalMessage || e.message || '';
      if (isRetryable(msg) && attempt < MAX_ATTEMPTS) {
        console.log(
          `  [${attempt}/${MAX_ATTEMPTS}] ${msg.substring(0, 80)}`,
        );
        try {
          await mineL1Blocks(l1Client, 1);
        } catch {}
        continue;
      }
      throw e;
    }
  }
  throw new Error(
    'Fee Juice claim failed: L1-to-L2 message never appeared in L2 tree',
  );
}

// ── Interaction wrapper ──────────────────────────────────────────────────────
// The published aztec-benchmark profiler calls f.request(), f.estimateGas(),
// f.profile(), and f.send().wait() directly on each item returned by
// getMethods(). It does NOT inject fee payment or sender options.
// This wrapper proxies a ContractFunctionInteraction and injects the FPC fee
// payment method + sender address into every call so the profile includes the
// FPC's fee_entrypoint execution steps.

class FeeWrappedInteraction {
  #action: any;
  #feeOpts: any;
  #from: any;
  #additionalScopes: any[];
  #gasSettings: any;

  profileTimeMs?: number;
  provingTimeMs?: number;

  constructor(
    action: any,
    feePaymentMethod: any,
    gasSettings: any,
    from: any,
    additionalScopes: any[] = [],
  ) {
    this.#action = action;
    this.#feeOpts = { paymentMethod: feePaymentMethod };
    this.#from = from;
    this.#additionalScopes = additionalScopes;
    this.#gasSettings = gasSettings;
  }

  request() {
    return this.#action.request();
  }

  async estimateGas() {
    const gl = this.#gasSettings.gasLimits;
    const tgl = this.#gasSettings.teardownGasLimits;
    return {
      gasLimits: { daGas: Number(gl.daGas), l2Gas: Number(gl.l2Gas) },
      teardownGasLimits: {
        daGas: Number(tgl?.daGas ?? 0),
        l2Gas: Number(tgl?.l2Gas ?? 0),
      },
    };
  }

  async profile(opts?: any) {
    const start = performance.now();
    const result = await this.#action.profile({
      ...opts,
      from: this.#from,
      fee: this.#feeOpts,
      additionalScopes: this.#additionalScopes,
    });
    this.profileTimeMs = performance.now() - start;
    return result;
  }

  send(opts?: any) {
    const self = this;
    const start = performance.now();
    const originalPromise = this.#action.send({
      ...opts,
      from: this.#from,
      fee: this.#feeOpts,
      additionalScopes: this.#additionalScopes,
    });
    // Wrap to capture proving time (proof generation dominates send())
    const timed: any = originalPromise.then((sentTx: any) => {
      self.provingTimeMs = performance.now() - start;
      return sentTx;
    });
    // The published profiler calls f.send().wait(). In this Aztec version
    // SentTx is directly awaitable but may not expose .wait(). Shim it so
    // the profiler's `await f.send().wait()` resolves correctly.
    timed.wait = () => timed;
    return timed;
  }
}

// ── Benchmark context ────────────────────────────────────────────────────────

interface FPCBenchmarkContext {
  pxe: any;
  wallet?: any;
  feePaymentMethod?: FeePaymentMethod;
  gasSettings: any;
  tokenAsUser: any;
  userAddress: any;
  operatorAddress: any;
  fpcAddress: any;
}

// ── Benchmark class ──────────────────────────────────────────────────────────
// The aztec-benchmark CLI duck-types this class (checks for getMethods/setup/
// teardown methods). We don't extend BenchmarkBase to avoid a runtime import
// of the @defi-wonderland/aztec-benchmark package from inside the benchmark
// file — the CLI already provides the runner.

export default class FPCBenchmark {
  #interactions: FeeWrappedInteraction[] = [];

  async setup(): Promise<FPCBenchmarkContext> {
    console.log('=== FPC Benchmark Setup ===\n');

    // ── Connect to node ────────────────────────────────────────────────────
    const node = createAztecNodeClient(NODE_URL);
    console.log('Connected to node at', NODE_URL);

    const latestHeader = await node.getBlockHeader('latest');
    const l2Timestamp = latestHeader.globalVariables.timestamp;
    const VALID_UNTIL = l2Timestamp + QUOTE_TTL_SECONDS;
    console.log(`L2 timestamp: ${l2Timestamp}, VALID_UNTIL: ${VALID_UNTIL}`);

    // ── Start embedded PXE (clean slate each run) ──────────────────────────
    rmSync(PXE_DATA_DIR, { recursive: true, force: true });
    mkdirSync(PXE_DATA_DIR, { recursive: true });
    const pxeConfig = {
      ...getPXEConfig(),
      dataDirectory: PXE_DATA_DIR,
      l1Contracts: await node.getL1ContractAddresses(),
    };
    const pxe = await createPXE(node, pxeConfig);
    console.log('PXE started');

    // ── Create wallet + register test accounts ─────────────────────────────
    const wallet = new SimpleWallet(pxe, node);
    const testAccounts = await getInitialTestAccountsData();
    const [userData, operatorData] = testAccounts;

    const userAddress = await wallet.addSchnorrAccount(
      userData.secret,
      userData.salt,
    );
    const operatorAddress = await wallet.addSchnorrAccount(
      operatorData.secret,
      operatorData.salt,
    );
    console.log('user:    ', userAddress.toString());
    console.log('operator:', operatorAddress.toString());

    // ── Derive operator Schnorr signing key + public key ───────────────────
    const schnorr = new Schnorr();
    const operatorSigningKey = deriveSigningKey(operatorData.secret);
    const operatorPubKey = await schnorr.computePublicKey(operatorSigningKey);

    // ── Load & normalise artifacts ─────────────────────────────────────────
    const tokenArtifact = loadContractArtifact(
      JSON.parse(readFileSync(findArtifact('Token'), 'utf8')),
    );
    const fpcArtifact = loadContractArtifact(
      JSON.parse(readFileSync(findArtifact('FPC'), 'utf8')),
    );

    // ── Deploy Token ───────────────────────────────────────────────────────
    console.log('\nDeploying Token...');
    const tokenDeploy = await Contract.deploy(wallet, tokenArtifact, [
      'TestToken',
      'TST',
      18,
      userAddress,
      AztecAddress.ZERO,
    ], 'constructor_with_minter').send({ from: userAddress });
    const tokenAddress = tokenDeploy.address;
    console.log('Token:', tokenAddress.toString());

    // ── Deploy FPC ─────────────────────────────────────────────────────────
    console.log('Deploying FPC...');
    const fpcDeploy = await Contract.deploy(wallet, fpcArtifact, [
      operatorAddress,
      operatorPubKey.x,
      operatorPubKey.y,
      tokenAddress,
    ]).send({ from: userAddress });
    const fpcAddress = fpcDeploy.address;
    console.log('FPC:  ', fpcAddress.toString());

    const tokenAsUser = Contract.at(tokenAddress, tokenArtifact, wallet);

    // ── Bridge Fee Juice to FPC via L1 ─────────────────────────────────────
    const l1Client = await createL1Client(node);
    await fundFpcWithFeeJuice(
      node,
      wallet,
      fpcAddress,
      userAddress,
      tokenAsUser,
      l1Client,
    );

    // ── Compute gas-dependent charge ───────────────────────────────────────
    const minFees = await node.getCurrentMinFees();
    const PADDING = 1.5;
    const feeDa = BigInt(Math.ceil(Number(minFees.feePerDaGas) * PADDING));
    const feeL2 = BigInt(Math.ceil(Number(minFees.feePerL2Gas) * PADDING));
    const DA_GAS = 786432n;
    const L2_GAS = 2000000n; // must stay within AVM processing limit for real sends
    const maxGasCost = feeDa * DA_GAS + feeL2 * L2_GAS;
    const charge = feeJuiceToAsset(maxGasCost, RATE_NUM, RATE_DEN);

    console.log(`\nfeePerDaGas=${feeDa} feePerL2Gas=${feeL2}`);
    console.log(`max gas cost: ${maxGasCost} | token charge: ${charge}`);

    // ── Mint tokens to user ────────────────────────────────────────────────
    const mintAmount = charge + 1000n;
    console.log(`\nMinting ${mintAmount} tokens to user...`);
    await tokenAsUser.methods
      .mint_to_private(userAddress, mintAmount)
      .send({ from: userAddress });
    console.log('Minted.');

    // ── Quote signature ────────────────────────────────────────────────────
    const quoteSigFields = await signQuote(
      schnorr,
      operatorSigningKey,
      fpcAddress,
      tokenAddress,
      RATE_NUM,
      RATE_DEN,
      VALID_UNTIL,
      userAddress,
    );
    console.log('Quote signature created.');

    // ── Transfer authwit ───────────────────────────────────────────────────
    const TX_NONCE = BigInt(Date.now());
    const transferAuthWit = await wallet.createAuthWit(userAddress, {
      caller: fpcAddress,
      action: tokenAsUser.methods.transfer_private_to_private(
        userAddress,
        operatorAddress,
        charge,
        TX_NONCE,
      ),
    });
    console.log('Transfer authwit created.');

    // ── Gas settings ───────────────────────────────────────────────────────
    const gasSettings = GasSettings.default({
      gasLimits: new Gas(Number(DA_GAS), Number(L2_GAS)),
      maxFeesPerGas: new GasFees(feeDa, feeL2),
    });

    const feePaymentMethod = new CustomFPCPaymentMethod(
      fpcAddress,
      transferAuthWit,
      quoteSigFields,
      TX_NONCE,
      RATE_NUM,
      RATE_DEN,
      VALID_UNTIL,
      gasSettings,
    );

    console.log('\n=== FPC Benchmark Setup Complete ===\n');

    return {
      pxe,
      wallet,
      tokenAsUser,
      userAddress,
      operatorAddress,
      fpcAddress,
      feePaymentMethod,
      gasSettings,
    };
  }

  getMethods(context: FPCBenchmarkContext) {
    const action = context.tokenAsUser.methods.transfer_private_to_private(
      context.userAddress,
      context.userAddress,
      1n,
      0n,
    );

    const interaction = new FeeWrappedInteraction(
      action,
      context.feePaymentMethod,
      context.gasSettings,
      context.userAddress,
      [context.operatorAddress],
    );
    this.#interactions = [interaction];
    return [interaction];
  }

  async teardown(context: FPCBenchmarkContext): Promise<void> {
    // Post-process the saved JSON to inject timing data that the published
    // profiler doesn't capture (profile simulation time + proving time).
    const jsonPath = join(__dirname, 'fpc.benchmark.json');
    try {
      const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
      for (let i = 0; i < report.results.length && i < this.#interactions.length; i++) {
        const ix = this.#interactions[i];
        report.results[i].profileTimeMs = ix.profileTimeMs ?? null;
        report.results[i].provingTimeMs = ix.provingTimeMs ?? null;
      }
      writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    } catch (e: any) {
      console.warn('Could not post-process benchmark JSON:', e.message);
    }

    console.log('Cleaning up benchmark environment...');
    await context.pxe.stop?.();
    rmSync(PXE_DATA_DIR, { recursive: true, force: true });

    // The PXE / node client leave open handles that prevent Node from exiting.
    // Give the CLI a moment to print its final messages, then force exit.
    setTimeout(() => process.exit(0), 500);
  }
}

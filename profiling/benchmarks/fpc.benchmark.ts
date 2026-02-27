/**
 * FPC benchmark using @defi-wonderland/aztec-benchmark.
 *
 * Deploys Token + FPC + Noop on a running local network, bridges Fee Juice,
 * mints tokens, builds authwits, and benchmarks FPC.fee_entrypoint via a
 * minimal Noop app transaction (same approach as the custom profiler).
 *
 * The aztec-benchmark profiler calls f.request(), f.estimateGas(), f.profile(),
 * and f.send().wait() directly on each interaction returned by getMethods().
 * FeeWrappedInteraction injects the FPC fee payment method, sender address,
 * and additional scopes into every call, and captures SDK timing data
 * (per-circuit witgen, proving time) for teardown to enrich the JSON.
 *
 * After profiling, teardown post-processes the JSON to:
 *  - Rename "noop" keys to "fee_entrypoint" for readability
 *  - Extract fpcGateCounts / fpcTotalGateCount (FPC-only gate breakdown)
 *  - Rename gateCounts to fullTrace to clarify it's the entire tx trace
 *  - Inject per-circuit witness generation timing (witgenMs) and proving time
 *  - Print a human-readable console summary
 *
 * Environment:
 *   AZTEC_NODE_URL  — node endpoint  (default http://127.0.0.1:8080)
 *   L1_RPC_URL      — L1 (anvil) endpoint (default http://127.0.0.1:8545)
 */

import type { FeePaymentMethod } from '@aztec/aztec.js/fee';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { Contract } from '@aztec/aztec.js/contracts';
import { L1FeeJuicePortalManager } from '@aztec/aztec.js/ethereum';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { Fr } from '@aztec/foundation/curves/bn254';
import { createLogger } from '@aztec/foundation/log';
import { Schnorr } from '@aztec/foundation/crypto/schnorr';
import { FeeJuiceArtifact } from '@aztec/protocol-contracts/fee-juice';
import { ProtocolContractAddress } from '@aztec/protocol-contracts';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
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
import {
  createWalletClient,
  defineChain,
  http,
  publicActions,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  findArtifact,
  feeJuiceToAsset,
  SimpleWallet,
  signQuote,
  extractFpcSteps,
} from '../profile-utils.mjs';

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

  getAsset(): Promise<any> {
    throw new Error('Asset is not required for custom FPC.');
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
  wallet: InstanceType<typeof SimpleWallet>,
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
// The installed aztec-benchmark profiler calls f.request(), f.estimateGas(),
// f.profile(), and f.send().wait() directly on each item returned by
// getMethods(). It does NOT inject fee payment, sender, or additional scopes.
// This wrapper proxies a ContractFunctionInteraction and injects the FPC fee
// payment method + sender address + additional scopes into every call so the
// profile captures the full trace including fee_entrypoint.
// It also captures SDK timing data (per-circuit witgen, proving time) from the
// profile result for teardown to inject into the JSON.

class FeeWrappedInteraction {
  #action: any;
  #feeOpts: any;
  #from: any;
  #additionalScopes: any[];
  #gasSettings: any;

  /** Per-function timing data captured from profile().stats.timings. */
  timings?: { perFunction: any[]; proving?: number; total?: number };

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
    const result = await this.#action.profile({
      ...opts,
      from: this.#from,
      fee: this.#feeOpts,
      additionalScopes: this.#additionalScopes,
      skipProofGeneration: false,
    });
    this.timings = result.stats?.timings ?? undefined;
    return result;
  }

  send(opts?: any) {
    const originalPromise = this.#action.send({
      ...opts,
      from: this.#from,
      fee: this.#feeOpts,
      additionalScopes: this.#additionalScopes,
    });
    // The profiler calls f.send().wait(). In this Aztec version SentTx is
    // directly awaitable but may not expose .wait(). Shim it so the
    // profiler's `await f.send().wait()` resolves correctly.
    const shimmed: any = originalPromise.then((sentTx: any) => sentTx);
    shimmed.wait = () => shimmed;
    return shimmed;
  }
}

// ── Benchmark context ────────────────────────────────────────────────────────

interface FPCBenchmarkContext {
  pxe: any;
  wallet?: any;
  feePaymentMethod?: FeePaymentMethod;
  gasSettings: any;
  tokenAsUser: any;
  noopAsUser: any;
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
    const noopArtifact = loadContractArtifact(
      JSON.parse(readFileSync(findArtifact('Noop'), 'utf8')),
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

    // ── Deploy Noop (minimal app tx placeholder for profiling) ────────────
    console.log('Deploying Noop...');
    const noopDeploy = await Contract.deploy(wallet, noopArtifact, []).send({
      from: userAddress,
    });
    console.log('Noop: ', noopDeploy.address.toString());

    const tokenAsUser = Contract.at(tokenAddress, tokenArtifact, wallet);
    const noopAsUser = Contract.at(noopDeploy.address, noopArtifact, wallet);

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
      QUOTE_DOMAIN_SEP,
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
      noopAsUser,
      userAddress,
      operatorAddress,
      fpcAddress,
      feePaymentMethod,
      gasSettings,
    };
  }

  getMethods(context: FPCBenchmarkContext) {
    const interaction = new FeeWrappedInteraction(
      context.noopAsUser.methods.noop(),
      context.feePaymentMethod,
      context.gasSettings,
      context.userAddress,
      [context.operatorAddress],
    );
    this.#interactions = [interaction];
    return [interaction];
  }

  async teardown(context: FPCBenchmarkContext): Promise<void> {
    // The CLI writes suffixed files (e.g. fpc_latest.benchmark.json) in CI,
    // or fpc.benchmark.json locally. Find the most recently written match.
    const jsonPath = readdirSync(__dirname)
      .filter((f: string) => f.startsWith('fpc') && f.endsWith('.benchmark.json'))
      .map((f: string) => join(__dirname, f))
      .sort((a: string, b: string) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

    const DISPLAY_NAME = 'fee_entrypoint';
    if (!jsonPath) {
      console.warn('No fpc*.benchmark.json found in', __dirname);
      return;
    }
    try {
      const report = JSON.parse(readFileSync(jsonPath, 'utf8'));

      for (let i = 0; i < report.results.length && i < this.#interactions.length; i++) {
        const ix = this.#interactions[i];
        const r = report.results[i];

        // Inject proving time from SDK timings captured in our wrapper.
        const provingTime = ix.timings?.proving ?? null;
        r.provingTime = provingTime;

        // Build a lookup of witgen timing by index from the SDK's perFunction.
        // perFunction and gateCounts share the same order (both derived from
        // executionSteps), so matching by index is safe.
        const perFunction: any[] = ix.timings?.perFunction ?? [];
        const witgenByIndex = new Map<number, number>();
        for (let j = 0; j < perFunction.length; j++) {
          if (perFunction[j]?.time != null) {
            witgenByIndex.set(j, perFunction[j].time);
          }
        }

        // Annotate each gate count entry with witgenMs.
        const rawSteps = r.gateCounts ?? [];
        for (let j = 0; j < rawSteps.length; j++) {
          rawSteps[j].witgenMs = witgenByIndex.get(j) ?? null;
        }

        // Extract FPC-only steps.
        const allSteps = rawSteps.map(
          (gc: any) => ({ functionName: gc.circuitName, gateCount: gc.gateCount, witgenMs: gc.witgenMs }),
        );
        const fpcSteps = extractFpcSteps(allSteps, 'FPC');
        r.fpcGateCounts = fpcSteps.map((s: any) => ({
          circuitName: s.functionName,
          gateCount: s.gateCount,
          witgenMs: s.witgenMs,
        }));
        r.fpcTotalGateCount = fpcSteps.reduce(
          (sum: number, s: any) => sum + (s.gateCount ?? 0), 0,
        );
        r.fpcTotalWitgenMs = fpcSteps.reduce(
          (sum: number, s: any) => sum + (s.witgenMs ?? 0), 0,
        );

        // Rename gateCounts → fullTrace for clarity.
        r.fullTrace = r.gateCounts;
        delete r.gateCounts;

        // Rename "noop" → "fee_entrypoint" (the installed profiler discovers
        // the name from .request() which returns "noop").
        const oldName = r.name;
        r.name = DISPLAY_NAME;
        if (report.summary?.[oldName] !== undefined) {
          report.summary[DISPLAY_NAME] = report.summary[oldName];
          delete report.summary[oldName];
        }
        if (report.gasSummary?.[oldName] !== undefined) {
          report.gasSummary[DISPLAY_NAME] = report.gasSummary[oldName];
          delete report.gasSummary[oldName];
        }

        this.#printResultTable(r);
      }

      // Add FPC-only and proving-time summaries.
      report.fpcSummary = {};
      report.provingTimeSummary = {};
      for (const r of report.results) {
        report.fpcSummary[r.name] = r.fpcTotalGateCount ?? 0;
        report.provingTimeSummary[r.name] = r.provingTime ?? 0;
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

  #printResultTable(r: any) {
    const pad = (s: string, n: number) => String(s).padEnd(n);
    const numFmt = (n: number) => n.toLocaleString();
    const msFmt = (n: number | null) => n != null ? n.toFixed(1) : '-';
    const LINE = '\u2500'.repeat(100);

    console.log(`\n=== FPC Benchmark Results: ${r.name} ===`);

    // FPC-only gate counts.
    if (r.fpcGateCounts?.length) {
      console.log('\nFPC-Only Gate Counts:');
      console.log(pad('Function', 50), pad('Own gates', 14), pad('Witgen (ms)', 14), 'Subtotal');
      console.log(LINE);
      let sub = 0;
      for (const gc of r.fpcGateCounts) {
        sub += gc.gateCount ?? 0;
        console.log(
          pad(gc.circuitName, 50),
          pad(numFmt(gc.gateCount ?? 0), 14),
          pad(msFmt(gc.witgenMs), 14),
          numFmt(sub),
        );
      }
      console.log(LINE);
      console.log(
        pad('FPC TOTAL', 50),
        pad(numFmt(r.fpcTotalGateCount), 14),
        pad(msFmt(r.fpcTotalWitgenMs), 14),
        '',
      );
    }

    // Full transaction trace.
    if (r.fullTrace?.length) {
      console.log('\nFull Transaction Trace:');
      console.log(pad('Function', 50), pad('Own gates', 14), pad('Witgen (ms)', 14), 'Subtotal');
      console.log(LINE);
      let sub = 0;
      for (const gc of r.fullTrace) {
        sub += gc.gateCount ?? 0;
        console.log(
          pad(gc.circuitName, 50),
          pad(numFmt(gc.gateCount ?? 0), 14),
          pad(msFmt(gc.witgenMs), 14),
          numFmt(sub),
        );
      }
      console.log(LINE);
      console.log(pad('TX TOTAL', 50), pad(numFmt(r.totalGateCount), 14), pad('', 14), '');
    }

    // Proving time + gas summary.
    const provingStr = r.provingTime != null
      ? `${numFmt(Math.round(r.provingTime))}ms (hardware-dependent, full tx)`
      : 'N/A';
    console.log(`\nProving time:  ${provingStr}`);
    if (r.gas) {
      const da = r.gas.gasLimits?.daGas ?? 'N/A';
      const l2 = r.gas.gasLimits?.l2Gas ?? 'N/A';
      console.log(`Gas:           DA ${typeof da === 'number' ? numFmt(da) : da} | L2 ${typeof l2 === 'number' ? numFmt(l2) : l2}`);
    }
    console.log('');
  }
}

import pino from 'pino';

const pinoLogger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: false,
      ignore: 'pid,hostname,time,level',
    },
  },
});
/**
 * Cold-start benchmark using the same runner.mjs profiler framework as fpc.benchmark.ts.
 *
 * Deploys Token + TokenBridge + FPC, bridges tokens via L1 TokenPortal, and
 * benchmarks FPC.cold_start_entrypoint.
 *
 * Key difference from fee_entrypoint: cold_start_entrypoint must be the tx root
 * (msg_sender = None), so it cannot use the SDK's ContractFunctionInteraction
 * flow. Instead, ColdStartAction builds TxExecutionRequest directly via
 * DefaultEntrypoint and calls PXE APIs (simulateTx / profileTx / proveTx).
 *
 * Environment:
 *   AZTEC_NODE_URL  — node endpoint  (default http://127.0.0.1:8080)
 *   L1_RPC_URL      — L1 (anvil) endpoint (default http://127.0.0.1:8545)
 */

import { FeeJuiceArtifact } from '@aztec/protocol-contracts/fee-juice';
import { ProtocolContractAddress } from '@aztec/protocol-contracts';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { Contract } from '@aztec/aztec.js/contracts';
import { L1FeeJuicePortalManager, L1ToL2TokenPortalManager } from '@aztec/aztec.js/ethereum';
import { isL1ToL2MessageReady } from '@aztec/aztec.js/messaging';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { Fr } from '@aztec/foundation/curves/bn254';
import { createLogger } from '@aztec/foundation/log';
import { Schnorr } from '@aztec/foundation/crypto/schnorr';
import { EthAddress } from '@aztec/foundation/eth-address';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { loadContractArtifact, loadContractArtifactForPublic } from '@aztec/stdlib/abi';
import { ExecutionPayload, HashedValues, TxContext, TxExecutionRequest } from '@aztec/stdlib/tx';
import { Gas, GasFees, GasSettings } from '@aztec/stdlib/gas';
import { deriveKeys, deriveSigningKey } from '@aztec/stdlib/keys';
import { createExtendedL1Client } from '@aztec/ethereum/client';
import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract';
import { TestERC20Abi, TestERC20Bytecode, TokenPortalAbi, TokenPortalBytecode } from '@aztec/l1-artifacts';
import { createPXE, getPXEConfig } from '@aztec/pxe/server';
import { extractChain, type Chain, type Hex } from 'viem';
import * as viemChains from 'viem/chains';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  findArtifact,
  SimpleWallet,
  signColdStartQuote,
  extractFpcSteps,
} from '../profile-utils.mjs';


const NODE_URL = process.env.AZTEC_NODE_URL || 'http://127.0.0.1:8080';
const L1_RPC_URL = process.env.L1_RPC_URL || 'http://127.0.0.1:8545';
const PXE_DATA_DIR = '/tmp/benchmark-cold-start-pxe';

// Anvil default account 0 — only used for L1 deploys + bridging in local dev.
const ANVIL_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const QUOTE_TTL_SECONDS = 3500n;
const COLD_START_DOMAIN_SEP = 0x46504373n; // "FPCs" as field
const CLAIM_AMOUNT = 10n ** 18n;
const RATE_NUM = 1n;
const RATE_DEN = 1n;

const __dirname = dirname(fileURLToPath(import.meta.url));


async function createL1Client(node: any) {
  const nodeInfo = await node.getNodeInfo();
  const chain = extractChain({ chains: Object.values(viemChains) as readonly Chain[], id: nodeInfo.l1ChainId });
  return createExtendedL1Client([L1_RPC_URL], ANVIL_PRIVATE_KEY, chain);
}

async function mineL1Blocks(l1Client: any, count: number) {
  for (let i = 0; i < count; i++) {
    await l1Client.request({ method: 'evm_mine', params: [] });
  }
}

function feeJuiceToAsset(feeJuice: bigint, rateNum: bigint, rateDen: bigint): bigint {
  if (feeJuice === 0n) return 0n;
  const product = feeJuice * rateNum;
  return (product + rateDen - 1n) / rateDen;
}

/**
 * ColdStartAction wraps PXE APIs to duck-type the runner's Profiler interface.
 *
 * Since cold_start_entrypoint must be the tx root (msg_sender = None), we
 * cannot use ContractFunctionInteraction (which goes through the account
 * entrypoint). Instead we build TxExecutionRequest manually via
 * DefaultEntrypoint's logic (inlined to avoid extra dependency).
 */
class ColdStartAction {
  #txRequest: TxExecutionRequest;
  #pxe: any;
  #node: any;
  #signers: any[];
  #gasSettings: GasSettings;

  /** Per-function timing data captured from profile(). */
  timings?: { perFunction: any[]; proving?: number; total?: number };

  constructor(
    txRequest: TxExecutionRequest,
    pxe: any,
    node: any,
    signers: any[],
    gasSettings: GasSettings,
  ) {
    this.#txRequest = txRequest;
    this.#pxe = pxe;
    this.#node = node;
    this.#signers = signers;
    this.#gasSettings = gasSettings;
  }

  request() {
    return this.#txRequest;
  }

  async simulate(opts?: any) {
    try {
      const simResult = await this.#pxe.simulateTx(this.#txRequest, {
        simulatePublic: true,
        scopes: this.#signers,
      });
      // Return actual gas from simulation (totalGas = billedGas).
      const gasUsed = simResult?.gasUsed;
      if (gasUsed) {
        return {
          estimatedGas: {
            gasLimits: {
              daGas: Number(gasUsed.totalGas?.daGas ?? gasUsed.billedGas?.daGas ?? 0),
              l2Gas: Number(gasUsed.totalGas?.l2Gas ?? gasUsed.billedGas?.l2Gas ?? 0),
            },
            teardownGasLimits: {
              daGas: Number(gasUsed.teardownGas?.daGas ?? 0),
              l2Gas: Number(gasUsed.teardownGas?.l2Gas ?? 0),
            },
          },
        };
      }
    } catch {
      // Simulation may fail in certain conditions; fall through to defaults.
    }

    // Fallback: return our known gas settings.
    const gl = this.#gasSettings.gasLimits;
    const tgl = this.#gasSettings.teardownGasLimits;
    return {
      estimatedGas: {
        gasLimits: { daGas: Number(gl.daGas), l2Gas: Number(gl.l2Gas) },
        teardownGasLimits: {
          daGas: Number(tgl?.daGas ?? 0),
          l2Gas: Number(tgl?.l2Gas ?? 0),
        },
      },
    };
  }

  async profile(opts?: any) {
    const result = await this.#pxe.profileTx(this.#txRequest, {
      profileMode: 'full',
      skipProofGeneration: false,
      scopes: this.#signers,
    });
    this.timings = result.stats?.timings ?? undefined;
    return result;
  }

  async send(opts?: any) {
    const provingResult = await this.#pxe.proveTx(this.#txRequest, this.#signers);
    const tx = await provingResult.toTx();
    await this.#node.sendTx(tx);

    // Wait for the tx to be mined.
    const txHash = tx.txHash;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const receipt = await this.#node.getTxReceipt(txHash);
      if (receipt.isMined()) return receipt;
      if (receipt.isDropped()) throw new Error(`Tx dropped: error=${receipt.error}`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error('Tx timed out waiting for block inclusion');
  }
}


interface ColdStartBenchmarkContext {
  pxe: any;
  wallet?: any;
  gasSettings: any;
  userAddress: any;
  operatorAddress: any;
  fpcAddress: any;
  _coldStartAction?: ColdStartAction;
}

export default class ColdStartBenchmark {
  #actions: ColdStartAction[] = [];

  async setup(): Promise<ColdStartBenchmarkContext> {
    pinoLogger.info('=== Cold-Start Benchmark Setup ===\n');

    const node = createAztecNodeClient(NODE_URL);
    pinoLogger.info(`Connected to node at ${NODE_URL}`);

    rmSync(PXE_DATA_DIR, { recursive: true, force: true });
    mkdirSync(PXE_DATA_DIR, { recursive: true });
    const pxeConfig = {
      ...getPXEConfig(),
      dataDirectory: PXE_DATA_DIR,
      l1Contracts: await node.getL1ContractAddresses(),
    };
    const pxe = await createPXE(node, pxeConfig);
    pinoLogger.info('PXE started');

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
    pinoLogger.info(`user:     ${userAddress.toString()}`);
    pinoLogger.info(`operator: ${operatorAddress.toString()}`);

    const schnorr = new Schnorr();
    const operatorSigningKey = deriveSigningKey(operatorData.secret);
    const operatorPubKey = await schnorr.computePublicKey(operatorSigningKey);

    // Load contract artifacts
    const tokenArtifact = loadContractArtifact(
      JSON.parse(readFileSync(findArtifact('Token'), 'utf8')),
    );
    const fpcArtifact = loadContractArtifact(
      JSON.parse(readFileSync(findArtifact('FPC'), 'utf8')),
    );
    const noopArtifact = loadContractArtifact(
      JSON.parse(readFileSync(findArtifact('Noop'), 'utf8')),
    );
    let bridgeArtifact: any;
    try {
      bridgeArtifact = loadContractArtifact(
        JSON.parse(readFileSync(findArtifact('TokenBridge'), 'utf8')),
      );
    } catch {
      // TokenBridge has public bytecode that needs transpilation
      bridgeArtifact = loadContractArtifactForPublic(
        JSON.parse(readFileSync(findArtifact('TokenBridge'), 'utf8')),
      );
    }

    // Pre-compute bridge address (needed for Token constructor)
    const bridgeDeploy = Contract.deploy(wallet, bridgeArtifact, []);
    const bridgeInstance = await bridgeDeploy.getInstance();
    const bridgeAddress = bridgeInstance.address;
    pinoLogger.info(`Bridge (pre-computed): ${bridgeAddress.toString()}`);

    // Deploy Token (with bridge as minter)
    pinoLogger.info('Deploying Token...');
    const { contract: tokenDeploy } = await Contract.deploy(wallet, tokenArtifact, [
      'TestToken',
      'TST',
      18,
      bridgeAddress,
    ], 'constructor_with_minter').send({ from: userAddress });
    const tokenAddress = tokenDeploy.address;
    pinoLogger.info(`Token: ${tokenAddress.toString()}`);

    // Deploy FPC with keys derived from Fr.ZERO so the address matches the keys
    // we'll register. cold_start_entrypoint calls set_sender_for_tags(fpc_address),
    // which requires the PXE to have public keys registered for fpc_address.
    // Using deployWithPublicKeys ensures address = computeAddress(deriveKeys(Fr.ZERO).hash, partial).
    pinoLogger.info('Deploying FPC...');
    const fpcKeys = (await deriveKeys(Fr.ZERO)).publicKeys;
    const { contract: fpcDeploy } = await Contract.deployWithPublicKeys(
      fpcKeys, wallet, fpcArtifact, [
        operatorAddress, operatorPubKey.x, operatorPubKey.y, tokenAddress,
      ],
    ).send({ from: userAddress });
    const fpcAddress = fpcDeploy.address;
    pinoLogger.info(`FPC:   ${fpcAddress.toString()}`);

    // Register FPC with secret key Fr.ZERO. Since the FPC was deployed with
    // deriveKeys(Fr.ZERO).publicKeys, registerAccount(Fr.ZERO, partialAddr)
    // will derive the same address → keys are stored under fpcAddress.
    const fpcInstanceFromNode = await node.getContract(fpcAddress);
    if (fpcInstanceFromNode) {
      await wallet.registerContract(fpcInstanceFromNode, fpcArtifact, Fr.ZERO);
    }

    // Deploy TokenBridge + Noop
    pinoLogger.info('Deploying TokenBridge...');
    await bridgeDeploy.send({ from: userAddress });
    pinoLogger.info(`Bridge: ${bridgeAddress.toString()}`);

    pinoLogger.info('Deploying Noop...');
    const { contract: noopDeploy } = await Contract.deploy(wallet, noopArtifact, []).send({
      from: userAddress,
    });
    const noopAsUser = Contract.at(noopDeploy.address, noopArtifact, wallet);
    pinoLogger.info(`Noop:  ${noopDeploy.address.toString()}`);

    const l1Client = await createL1Client(node);

    // Deploy L1 contracts
    pinoLogger.info('Deploying L1 TestERC20...');
    const l1Erc20Result = await deployL1Contract(
      l1Client,
      TestERC20Abi,
      TestERC20Bytecode as Hex,
      ['TestToken', 'TST', l1Client.account.address],
    );
    const l1Erc20Address = l1Erc20Result.address;
    pinoLogger.info(`L1 ERC20: ${l1Erc20Address.toString()}`);

    pinoLogger.info('Deploying L1 TokenPortal...');
    const l1PortalResult = await deployL1Contract(
      l1Client,
      TokenPortalAbi,
      TokenPortalBytecode as Hex,
    );
    const l1PortalAddress = l1PortalResult.address;
    pinoLogger.info(`L1 Portal: ${l1PortalAddress.toString()}`);

    // Initialize L1 TokenPortal
    const registryAddress = (await node.getL1ContractAddresses()).registryAddress;
    const initHash = await l1Client.writeContract({
      address: l1PortalAddress.toString() as Hex,
      abi: TokenPortalAbi,
      functionName: 'initialize',
      args: [registryAddress.toString() as Hex, l1Erc20Address.toString() as Hex, bridgeAddress.toString() as Hex],
    });
    await l1Client.waitForTransactionReceipt({ hash: initHash });
    pinoLogger.info('L1 TokenPortal initialized');

    // Set bridge config on L2
    const bridgeContract = Contract.at(bridgeAddress, bridgeArtifact, wallet);
    await bridgeContract.methods
      .set_config(tokenAddress, EthAddress.fromString(l1PortalAddress.toString()))
      .send({ from: userAddress });
    pinoLogger.info('Bridge config set');

    // Bridge Fee Juice to FPC
    pinoLogger.info('Bridging Fee Juice to FPC...');
    await fundFpcWithFeeJuice(node, wallet, fpcAddress, userAddress, noopAsUser, l1Client);

    // Mint L1 tokens and bridge for claim
    pinoLogger.info(`Minting L1 tokens (${CLAIM_AMOUNT}) and bridging to L2...`);
    const mintHash = await l1Client.writeContract({
      address: l1Erc20Address.toString() as Hex,
      abi: TestERC20Abi,
      functionName: 'mint',
      args: [l1Client.account.address, CLAIM_AMOUNT],
    });
    await l1Client.waitForTransactionReceipt({ hash: mintHash });

    const portalManager = new L1ToL2TokenPortalManager(
      EthAddress.fromString(l1PortalAddress.toString()),
      EthAddress.fromString(l1Erc20Address.toString()),
      undefined,
      l1Client,
      createLogger('benchmark:token-bridge'),
    );

    const bridgeClaim = await portalManager.bridgeTokensPrivate(fpcAddress, CLAIM_AMOUNT, false);
    pinoLogger.info(`Tokens bridged (messageLeafIndex=${bridgeClaim.messageLeafIndex})`);

    // Wait for L1→L2 message by mining L1 blocks and producing L2 blocks (noop txs).
    // The archiver needs both: L1 blocks to discover the deposit, and L2 blocks
    // to advance past the checkpoint that includes the message.
    await mineL1Blocks(l1Client, 5);

    // bridgeClaim types: claimSecret=Fr, claimSecretHash=Fr, messageHash=Hex, messageLeafIndex=bigint
    pinoLogger.info('Waiting for L1→L2 token bridge message to be ready...');
    const MSG_MAX_ATTEMPTS = 30;
    let msgReady = false;
    const bridgeMsgHash = Fr.fromHexString(bridgeClaim.messageHash as string);
    for (let attempt = 1; attempt <= MSG_MAX_ATTEMPTS; attempt++) {
      msgReady = await isL1ToL2MessageReady(node, bridgeMsgHash);
      if (msgReady) {
        pinoLogger.info(`L1→L2 message ready (attempt ${attempt})`);
        break;
      }
      pinoLogger.info(`  [${attempt}/${MSG_MAX_ATTEMPTS}] message not ready, sending noop + mining...`);
      try {
        await noopAsUser.methods.noop().send({ from: userAddress });
      } catch {}
      try {
        await mineL1Blocks(l1Client, 1);
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!msgReady) {
      throw new Error('L1→L2 token bridge message never became ready');
    }

    // Build gas settings
    const minFees = await node.getCurrentMinFees();
    const PADDING = 1.5;
    const feeDa = BigInt(Math.ceil(Number(minFees.feePerDaGas) * PADDING));
    const feeL2 = BigInt(Math.ceil(Number(minFees.feePerL2Gas) * PADDING));
    // Use the hardcoded cold start gas limits matching sdk/src/payment-method.ts
    const DA_GAS = 5_000n;
    const L2_GAS = 1_000_000n;
    const maxGasCost = feeDa * DA_GAS + feeL2 * L2_GAS;
    const charge = feeJuiceToAsset(maxGasCost, RATE_NUM, RATE_DEN);

    pinoLogger.info(`\nfeePerDaGas=${feeDa} feePerL2Gas=${feeL2}`);
    pinoLogger.info(`max gas cost: ${maxGasCost} | token charge: ${charge}`);

    const latestHeader = await node.getBlockHeader('latest');
    const l2Timestamp = latestHeader!.globalVariables.timestamp;
    const VALID_UNTIL = l2Timestamp + QUOTE_TTL_SECONDS;
    pinoLogger.info(`L2 timestamp: ${l2Timestamp}, VALID_UNTIL: ${VALID_UNTIL}`);

    // Sign cold-start quote
    const quoteSigFields = await signColdStartQuote(
      schnorr,
      operatorSigningKey,
      fpcAddress,
      tokenAddress,
      maxGasCost,
      charge,
      VALID_UNTIL,
      userAddress,
      COLD_START_DOMAIN_SEP,
      CLAIM_AMOUNT,
      bridgeClaim.claimSecretHash, // already Fr
    );
    pinoLogger.info('Cold-start quote signature created.');

    const gasSettings = GasSettings.default({
      gasLimits: new Gas(Number(DA_GAS), Number(L2_GAS)),
      teardownGasLimits: Gas.empty(),
      maxFeesPerGas: new GasFees(feeDa, feeL2),
    });

    // Build cold_start_entrypoint call
    const fpcContract = Contract.at(fpcAddress, fpcArtifact, wallet);
    const coldStartCall = await fpcContract.methods
      .cold_start_entrypoint(
        userAddress,
        tokenAddress,
        bridgeAddress,
        CLAIM_AMOUNT,
        bridgeClaim.claimSecret,       // Fr
        bridgeClaim.claimSecretHash,   // Fr
        new Fr(bridgeClaim.messageLeafIndex), // bigint → Fr
        maxGasCost,
        charge,
        VALID_UNTIL,
        quoteSigFields,
      )
      .getFunctionCall();

    // Build TxExecutionRequest via DefaultEntrypoint logic
    const payload = new ExecutionPayload([coldStartCall], [], [], [], fpcAddress);
    const { calls, authWitnesses, capsules, extraHashedArgs } = payload;
    const call = calls[0];
    const hashedArguments = [await HashedValues.fromArgs(call.args)];
    const nodeInfo = await node.getNodeInfo();
    const txContext = new TxContext(nodeInfo.l1ChainId, nodeInfo.rollupVersion, gasSettings);

    const txRequest = new TxExecutionRequest(
      call.to,
      call.selector,
      hashedArguments[0].hash,
      txContext,
      [...hashedArguments, ...extraHashedArgs],
      authWitnesses,
      capsules,
    );

    const signers = [userAddress, operatorAddress, fpcAddress];
    const coldStartAction = new ColdStartAction(txRequest, pxe, node, signers, gasSettings);

    pinoLogger.info('\n=== Cold-Start Benchmark Setup Complete ===\n');

    return {
      pxe,
      wallet,
      gasSettings,
      userAddress,
      operatorAddress,
      fpcAddress,
      _coldStartAction: coldStartAction,
    } as ColdStartBenchmarkContext;
  }

  getMethods(context: ColdStartBenchmarkContext) {
    const action = context._coldStartAction;
    if (!action) {
      throw new Error('ColdStartAction not found in context — was setup() called?');
    }
    this.#actions = [action];
    return [{
      interaction: { caller: context.userAddress, action },
      name: 'cold_start_entrypoint',
    }];
  }

  async teardown(context: ColdStartBenchmarkContext): Promise<void> {
    const jsonPath = readdirSync(__dirname)
      .filter((f: string) => f.startsWith('cold_start') && f.endsWith('.benchmark.json'))
      .map((f: string) => join(__dirname, f))
      .sort((a: string, b: string) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

    if (!jsonPath) {
      pinoLogger.warn(`No cold_start*.benchmark.json found in ${__dirname}`);
      return;
    }
    try {
      const report = JSON.parse(readFileSync(jsonPath, 'utf8'));

      for (let i = 0; i < report.results.length && i < this.#actions.length; i++) {
        const ix = this.#actions[i];
        const r = report.results[i];

        if (ix.timings?.proving != null) {
          r.provingTime = ix.timings.proving;
        }

        const perFunction: any[] = ix.timings?.perFunction ?? [];
        const witgenByIndex = new Map<number, number>();
        for (let j = 0; j < perFunction.length; j++) {
          if (perFunction[j]?.time != null) {
            witgenByIndex.set(j, perFunction[j].time);
          }
        }

        const rawSteps = r.gateCounts ?? [];
        for (let j = 0; j < rawSteps.length; j++) {
          rawSteps[j].witgenMs = witgenByIndex.get(j) ?? null;
        }

        const allSteps = rawSteps.map(
          (gc: any) => ({ functionName: gc.circuitName, gateCount: gc.gateCount, witgenMs: gc.witgenMs }),
        );

        // For cold_start, extractFpcSteps returns ALL steps (no Noop boundary).
        // We filter out tx-level kernel overhead to match what fee_entrypoint
        // reports: only FPC entrypoint + its sub-calls + per-call kernel_inners.
        // Excluded: kernel_init (tx init), kernel_reset/tail/hiding (finalization).
        const TX_OVERHEAD_KERNELS = new Set([
          'private_kernel_init',
          'private_kernel_reset',
          'private_kernel_tail',
          'hiding_kernel',
        ]);
        const fpcStepsRaw = extractFpcSteps(allSteps, ['FPC', 'FPCMultiAsset']);
        const fpcSteps = fpcStepsRaw.filter(
          (s: any) => !TX_OVERHEAD_KERNELS.has(s.functionName),
        );
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

        r.fullTrace = r.gateCounts;
        delete r.gateCounts;

        this.#printResultTable(r);
      }

      report.fpcSummary = {};
      report.provingTimeSummary = {};
      for (const r of report.results) {
        report.fpcSummary[r.name] = r.fpcTotalGateCount ?? 0;
        report.provingTimeSummary[r.name] = r.provingTime ?? 0;
      }

      if (report.systemInfo) {
        const si = report.systemInfo;
        pinoLogger.info('System Info:');
        pinoLogger.info(`  CPU:    ${si.cpuModel} (${si.cpuCores} threads)`);
        pinoLogger.info(`  Memory: ${si.totalMemoryGiB} GiB`);
        pinoLogger.info(`  Arch:   ${si.arch}`);
        pinoLogger.info('');
      }

      writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    } catch (e: any) {
      pinoLogger.warn(`Could not post-process benchmark JSON: ${e.message}`);
    }

    rmSync(PXE_DATA_DIR, { recursive: true, force: true });
  }

  #printResultTable(r: any) {
    const pad = (s: string, n: number) => String(s).padEnd(n);
    const numFmt = (n: number) => n.toLocaleString();
    const msFmt = (n: number | null) => n != null ? n.toFixed(1) : '-';
    const LINE = '\u2500'.repeat(100);

    pinoLogger.info(`\n=== Cold-Start Benchmark Results: ${r.name} ===`);

    if (r.fpcGateCounts?.length) {
      pinoLogger.info('\nFPC-Only Gate Counts:');
      pinoLogger.info(`${pad('Function', 50)} ${pad('Own gates', 14)} ${pad('Witgen (ms)', 14)} Subtotal`);
      pinoLogger.info(LINE);
      let sub = 0;
      for (const gc of r.fpcGateCounts) {
        sub += gc.gateCount ?? 0;
        pinoLogger.info(
          `${pad(gc.circuitName, 50)} ${pad(numFmt(gc.gateCount ?? 0), 14)} ${pad(msFmt(gc.witgenMs), 14)} ${numFmt(sub)}`,
        );
      }
      pinoLogger.info(LINE);
      pinoLogger.info(
        `${pad('FPC TOTAL', 50)} ${pad(numFmt(r.fpcTotalGateCount), 14)} ${pad(msFmt(r.fpcTotalWitgenMs), 14)}`,
      );
    }

    if (r.fullTrace?.length) {
      pinoLogger.info('\nFull Transaction Trace:');
      pinoLogger.info(`${pad('Function', 50)} ${pad('Own gates', 14)} ${pad('Witgen (ms)', 14)} Subtotal`);
      pinoLogger.info(LINE);
      let sub = 0;
      for (const gc of r.fullTrace) {
        sub += gc.gateCount ?? 0;
        pinoLogger.info(
          `${pad(gc.circuitName, 50)} ${pad(numFmt(gc.gateCount ?? 0), 14)} ${pad(msFmt(gc.witgenMs), 14)} ${numFmt(sub)}`,
        );
      }
      pinoLogger.info(LINE);
      pinoLogger.info(`${pad('TX TOTAL', 50)} ${pad(numFmt(r.totalGateCount), 14)}`);
    }

    const provingStr = r.provingTime != null
      ? `${numFmt(Math.round(r.provingTime))}ms (hardware-dependent, full tx)`
      : 'N/A';
    pinoLogger.info(`\nProving time:  ${provingStr}`);
    if (r.gas) {
      const da = r.gas.gasLimits?.daGas ?? 'N/A';
      const l2 = r.gas.gasLimits?.l2Gas ?? 'N/A';
      pinoLogger.info(`Gas:           DA ${typeof da === 'number' ? numFmt(da) : da} | L2 ${typeof l2 === 'number' ? numFmt(l2) : l2}`);
    }
    pinoLogger.info('');
  }
}


/**
 * Bridge Fee Juice from L1 and claim on L2 so the FPC can act as fee payer.
 */
async function fundFpcWithFeeJuice(
  node: any,
  wallet: InstanceType<typeof SimpleWallet>,
  fpcAddress: any,
  userAddress: any,
  noopContract: any,
  l1Client: any,
) {
  const logger = createLogger('benchmark:bridge');
  const portalManager = await L1FeeJuicePortalManager.new(
    node,
    l1Client,
    logger,
  );

  const MINT_AMOUNT = 10n ** 21n;
  pinoLogger.info(`Bridging ${MINT_AMOUNT} Fee Juice to FPC (L1 deposit)...`);
  const claim = await portalManager.bridgeTokensPublic(
    fpcAddress,
    MINT_AMOUNT,
    true,
  );
  pinoLogger.info(
    `L1 deposit confirmed (messageLeafIndex=${claim.messageLeafIndex})`,
  );

  await mineL1Blocks(l1Client, 5);

  const feeJuice = Contract.at(ProtocolContractAddress.FeeJuice, FeeJuiceArtifact, wallet);
  const MAX_ATTEMPTS = 30;

  function isRetryable(msg: string) {
    return (
      msg.includes('No L1 to L2 message found') ||
      (msg.includes('Block hash') && msg.includes('not found'))
    );
  }

  pinoLogger.info('Waiting for L2 to process L1 deposit...');
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));

    try {
      await noopContract.methods
        .noop()
        .send({ from: userAddress });
    } catch (e: any) {
      const msg = e.originalMessage || e.message || '';
      pinoLogger.info(
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
      pinoLogger.info(`Fee Juice claimed (attempt ${attempt}).`);
      return;
    } catch (e: any) {
      const msg = e.originalMessage || e.message || '';
      if (isRetryable(msg) && attempt < MAX_ATTEMPTS) {
        pinoLogger.info(
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

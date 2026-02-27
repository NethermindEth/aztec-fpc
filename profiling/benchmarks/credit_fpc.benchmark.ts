/**
 * CreditFPC benchmark using @defi-wonderland/aztec-benchmark.
 *
 * Deploys Token + CreditFPC + Noop on a running local network, bridges Fee
 * Juice, establishes credit balance via a real pay_and_mint tx, then
 * benchmarks both flows:
 *
 *   pay_and_mint     — user tops up credit balance (token transfer + mint)
 *   pay_with_credit  — user pays tx fee from existing credit (no transfer)
 *
 * The aztec-benchmark profiler expects getMethods() to return items of shape
 * {interaction: {caller, action}, name} (NamedBenchmarkedInteraction).
 *
 * Because the two flows use different fee payment methods, we do NOT set
 * feePaymentMethod on the returned context (the profiler would inject a single
 * one for all interactions).  Instead, each CreditFPCActionWrapper overrides
 * the fee option with its own payment method.
 *
 * After profiling, teardown post-processes the JSON to:
 *  - Extract fpcGateCounts / fpcTotalGateCount (CreditFPC-only gate breakdown)
 *  - Rename gateCounts to fullTrace to clarify it's the entire tx trace
 *  - Inject per-circuit witness generation timing (witgenMs)
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
import {
  AVM_MAX_PROCESSABLE_L2_GAS,
  MAX_PROCESSABLE_DA_GAS_PER_CHECKPOINT,
  DEFAULT_TEARDOWN_L2_GAS_LIMIT,
  DEFAULT_TEARDOWN_DA_GAS_LIMIT,
} from '@aztec/constants';
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
const PXE_DATA_DIR = '/tmp/benchmark-credit-fpc-pxe';

const ANVIL_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const RATE_NUM = 1n;
const RATE_DEN = 1n;
const QUOTE_TTL_SECONDS = 3500n;
const QUOTE_DOMAIN_SEP = 0x465043n; // "FPC" as field

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── PayAndMintPaymentMethod ─────────────────────────────────────────────────
// CreditFPC uses inline Schnorr verification: the operator's signature over
// the quote hash is passed as 64 Field args (one per byte of the 64-byte sig).

class PayAndMintPaymentMethod {
  fpcAddress: any;
  transferAuthWit: any;
  quoteSigFields: any[];
  transferNonce: bigint;
  fjCreditAmount: bigint;
  aaPaymentAmount: bigint;
  validUntil: bigint;
  gasSettings: any;

  constructor(
    fpcAddress: any,
    transferAuthWit: any,
    quoteSigFields: any[],
    transferNonce: bigint,
    fjCreditAmount: bigint,
    aaPaymentAmount: bigint,
    validUntil: bigint,
    gasSettings: any,
  ) {
    this.fpcAddress = fpcAddress;
    this.transferAuthWit = transferAuthWit;
    this.quoteSigFields = quoteSigFields;
    this.transferNonce = transferNonce;
    this.fjCreditAmount = fjCreditAmount;
    this.aaPaymentAmount = aaPaymentAmount;
    this.validUntil = validUntil;
    this.gasSettings = gasSettings;
  }

  getAsset(): Promise<any> {
    throw new Error('Asset is not required for CreditFPC.');
  }
  getFeePayer() {
    return Promise.resolve(this.fpcAddress);
  }
  getGasSettings() {
    return this.gasSettings;
  }

  async getExecutionPayload() {
    const selector = await FunctionSelector.fromSignature(
      'pay_and_mint(Field,u128,u128,u64,[u8;64])',
    );

    const feeCall = FunctionCall.from({
      name: 'pay_and_mint',
      to: this.fpcAddress,
      selector,
      type: FunctionType.PRIVATE,
      hideMsgSender: false,
      isStatic: false,
      args: [
        new Fr(this.transferNonce),
        new Fr(this.fjCreditAmount),
        new Fr(this.aaPaymentAmount),
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

// ── PayWithCreditPaymentMethod ──────────────────────────────────────────────

class PayWithCreditPaymentMethod {
  fpcAddress: any;
  gasSettings: any;

  constructor(fpcAddress: any, gasSettings: any) {
    this.fpcAddress = fpcAddress;
    this.gasSettings = gasSettings;
  }

  getAsset(): Promise<any> {
    throw new Error('Asset is not required for CreditFPC.');
  }
  getFeePayer() {
    return Promise.resolve(this.fpcAddress);
  }
  getGasSettings() {
    return this.gasSettings;
  }

  async getExecutionPayload() {
    const selector = await FunctionSelector.fromSignature('pay_with_credit()');

    const feeCall = FunctionCall.from({
      name: 'pay_with_credit',
      to: this.fpcAddress,
      selector,
      type: FunctionType.PRIVATE,
      hideMsgSender: false,
      isStatic: false,
      args: [],
      returnTypes: [],
    });

    return new ExecutionPayload(
      [feeCall],
      [],
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
  console.log(`Bridging ${MINT_AMOUNT} Fee Juice to CreditFPC (L1 deposit)...`);
  const claim = await portalManager.bridgeTokensPublic(
    fpcAddress,
    MINT_AMOUNT,
    true,
  );
  console.log(
    `L1 deposit confirmed (messageLeafIndex=${claim.messageLeafIndex})`,
  );

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

// ── Action wrapper ───────────────────────────────────────────────────────────
// Each CreditFPC flow uses a different fee payment method. Because the profiler
// injects a single feePaymentMethod from the context, we leave that field
// unset and override fee in every SDK call ourselves.

class CreditFPCActionWrapper {
  #inner: any;
  #feePaymentMethod: any;
  #additionalScopes: any[];
  #gasSettings: any;

  timings?: { perFunction: any[]; proving?: number; total?: number };

  constructor(
    inner: any,
    feePaymentMethod: any,
    additionalScopes: any[],
    gasSettings: any,
  ) {
    this.#inner = inner;
    this.#feePaymentMethod = feePaymentMethod;
    this.#additionalScopes = additionalScopes;
    this.#gasSettings = gasSettings;
  }

  request() {
    return this.#inner.request();
  }

  async simulate(opts?: any) {
    // Strip estimateGas — gas estimation changes the gasSettings, which
    // changes the token charge the FPC computes, breaking the auth witness.
    // Override fee with our own payment method.
    const { fee: _fee, ...rest } = opts ?? {};

    const result = await this.#inner.simulate({
      ...rest,
      fee: { paymentMethod: this.#feePaymentMethod },
      additionalScopes: this.#additionalScopes,
    });

    if (!result.estimatedGas && this.#gasSettings) {
      const gl = this.#gasSettings.gasLimits;
      const tgl = this.#gasSettings.teardownGasLimits;
      result.estimatedGas = {
        gasLimits: { daGas: Number(gl.daGas), l2Gas: Number(gl.l2Gas) },
        teardownGasLimits: {
          daGas: Number(tgl?.daGas ?? 0),
          l2Gas: Number(tgl?.l2Gas ?? 0),
        },
      };
    }
    return result;
  }

  async profile(opts?: any) {
    const { fee: _fee, ...rest } = opts ?? {};
    const result = await this.#inner.profile({
      ...rest,
      fee: { paymentMethod: this.#feePaymentMethod },
      additionalScopes: this.#additionalScopes,
    });
    this.timings = result.stats?.timings ?? undefined;
    return result;
  }

  send(opts?: any) {
    const { fee: _fee, ...rest } = opts ?? {};
    return this.#inner.send({
      ...rest,
      fee: { paymentMethod: this.#feePaymentMethod },
      additionalScopes: this.#additionalScopes,
    });
  }
}

// ── Benchmark context ────────────────────────────────────────────────────────

interface CreditFPCBenchmarkContext {
  pxe: any;
  wallet?: any;
  gasSettings: any;
  tokenAsUser: any;
  noopAsUser: any;
  userAddress: any;
  operatorAddress: any;
  fpcAddress: any;
}

// ── Benchmark class ──────────────────────────────────────────────────────────

export default class CreditFPCBenchmark {
  #actions: CreditFPCActionWrapper[] = [];
  #payAndMintPayment?: PayAndMintPaymentMethod;
  #payWithCreditPayment?: PayWithCreditPaymentMethod;

  async setup(): Promise<CreditFPCBenchmarkContext> {
    console.log('=== CreditFPC Benchmark Setup ===\n');

    // ── Connect to node ────────────────────────────────────────────────────
    const node = createAztecNodeClient(NODE_URL);
    console.log('Connected to node at', NODE_URL);

    console.log('Connected to node, will compute VALID_UNTIL after setup deploys.');

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
    const creditFpcArtifact = loadContractArtifact(
      JSON.parse(readFileSync(findArtifact('CreditFPC'), 'utf8')),
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

    // ── Deploy CreditFPC ──────────────────────────────────────────────────
    console.log('Deploying CreditFPC...');
    const creditFpcDeploy = await Contract.deploy(wallet, creditFpcArtifact, [
      operatorAddress,
      operatorPubKey.x,
      operatorPubKey.y,
      tokenAddress,
    ]).send({ from: userAddress });
    const fpcAddress = creditFpcDeploy.address;
    console.log('CreditFPC:', fpcAddress.toString());

    // ── Deploy Noop (minimal app tx placeholder for profiling) ────────────
    console.log('Deploying Noop...');
    const noopDeploy = await Contract.deploy(wallet, noopArtifact, []).send({
      from: userAddress,
    });
    console.log('Noop: ', noopDeploy.address.toString());

    await pxe.registerSender(fpcAddress);
    await pxe.registerSender(tokenAddress);
    console.log('Registered CreditFPC + Token as senders for note discovery.');

    const tokenAsUser = Contract.at(tokenAddress, tokenArtifact, wallet);
    const noopAsUser = Contract.at(noopDeploy.address, noopArtifact, wallet);

    // ── Bridge Fee Juice to CreditFPC via L1 ─────────────────────────────
    const l1Client = await createL1Client(node);
    await fundFpcWithFeeJuice(
      node,
      wallet,
      fpcAddress,
      userAddress,
      tokenAsUser,
      l1Client,
    );

    // ── Compute gas-dependent amounts ────────────────────────────────────
    const minFees = await node.getCurrentMinFees();
    const PADDING = 1.5;
    const feeDa = BigInt(Math.ceil(Number(minFees.feePerDaGas) * PADDING));
    const feeL2 = BigInt(Math.ceil(Number(minFees.feePerL2Gas) * PADDING));
    const DA_GAS = BigInt(MAX_PROCESSABLE_DA_GAS_PER_CHECKPOINT);
    const L2_GAS = BigInt(AVM_MAX_PROCESSABLE_L2_GAS);
    const maxGasCost = feeDa * DA_GAS + feeL2 * L2_GAS;

    // Total cost including teardown (needed for credit balance checks).
    const totalMaxCost =
      maxGasCost +
      feeDa * BigInt(DEFAULT_TEARDOWN_DA_GAS_LIMIT) +
      feeL2 * BigInt(DEFAULT_TEARDOWN_L2_GAS_LIMIT);

    // Credit amounts for the real send that establishes the balance:
    // must cover the send's own fee + profiled pay_and_mint + profiled pay_with_credit.
    const sendCreditMint = totalMaxCost * 4n;
    const sendTokenCharge = feeJuiceToAsset(sendCreditMint, RATE_NUM, RATE_DEN);

    // Credit amounts for the profiled pay_and_mint:
    const profileCreditMint = totalMaxCost * 3n;
    const profileTokenCharge = feeJuiceToAsset(profileCreditMint, RATE_NUM, RATE_DEN);

    console.log(`\nfeePerDaGas=${feeDa} feePerL2Gas=${feeL2}`);
    console.log(`max gas cost: ${maxGasCost} | total w/ teardown: ${totalMaxCost}`);
    console.log(`send credit mint: ${sendCreditMint} | token charge: ${sendTokenCharge}`);
    console.log(`profile credit mint: ${profileCreditMint} | token charge: ${profileTokenCharge}`);

    // ── Mint tokens to user (enough for the real send) ───────────────────
    const tokenMintAmount = sendTokenCharge + 10000n;
    console.log(`\nMinting ${tokenMintAmount} tokens to user...`);
    await tokenAsUser.methods
      .mint_to_private(userAddress, tokenMintAmount)
      .send({ from: userAddress });
    console.log('Minted.');

    // ── Gas settings ─────────────────────────────────────────────────────
    const gasSettings = GasSettings.default({
      gasLimits: new Gas(Number(DA_GAS), Number(L2_GAS)),
      maxFeesPerGas: new GasFees(feeDa, feeL2),
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Establish credit balance via a real pay_and_mint transaction.
    //  This MUST happen before any .profile() calls because profiling
    //  advances the PXE's sender tag indices.
    // ═══════════════════════════════════════════════════════════════════════

    // Refresh L2 timestamp for quote (blocks mined during setup)
    const latestHeader = await node.getBlockHeader('latest');
    const l2Timestamp = latestHeader!.globalVariables.timestamp;
    const VALID_UNTIL = l2Timestamp + QUOTE_TTL_SECONDS;
    console.log(`L2 timestamp: ${l2Timestamp}, VALID_UNTIL: ${VALID_UNTIL}`);

    const SEND_NONCE = BigInt(Date.now());

    const sendQuoteSigFields = await signQuote(
      schnorr,
      operatorSigningKey,
      fpcAddress,
      tokenAddress,
      sendCreditMint,
      sendTokenCharge,
      VALID_UNTIL,
      userAddress,
      QUOTE_DOMAIN_SEP,
    );

    const sendTransferAuthWit = await wallet.createAuthWit(userAddress, {
      caller: fpcAddress,
      action: tokenAsUser.methods.transfer_private_to_private(
        userAddress,
        operatorAddress,
        sendTokenCharge,
        SEND_NONCE,
      ),
    });

    const sendPayAndMint = new PayAndMintPaymentMethod(
      fpcAddress,
      sendTransferAuthWit,
      sendQuoteSigFields,
      SEND_NONCE,
      sendCreditMint,
      sendTokenCharge,
      VALID_UNTIL,
      gasSettings,
    );

    console.log('Establishing user credit balance (sending real pay_and_mint tx)...');
    await noopAsUser.methods
      .noop()
      .send({
        fee: { paymentMethod: sendPayAndMint, gasSettings },
        from: userAddress,
        additionalScopes: [operatorAddress],
      });
    console.log('Credit balance established (tx mined).');

    // Follow-up tx to advance archiver past the pay_and_mint block.
    console.log('Sending follow-up tx to advance archiver...');
    await tokenAsUser.methods
      .mint_to_private(userAddress, 1n)
      .send({ from: userAddress });
    console.log('Follow-up tx mined.');

    // ── Verify credit balance ────────────────────────────────────────────
    const creditFpcContract = Contract.at(fpcAddress, creditFpcArtifact, wallet);

    let creditBalance = 0n;
    for (let i = 0; i < 10; i++) {
      creditBalance = await creditFpcContract.methods
        .balance_of(userAddress)
        .simulate({ from: userAddress });
      console.log(`  [${i + 1}/10] Credit balance: ${creditBalance}`);
      if (creditBalance >= totalMaxCost) break;
      if (i < 9) {
        try {
          await tokenAsUser.methods
            .mint_to_private(userAddress, 1n)
            .send({ from: userAddress });
        } catch (e: any) {
          console.log(`  dummy tx failed (non-fatal): ${(e.message || '').substring(0, 80)}`);
        }
      }
    }

    // Fallback: use dev_mint with ONCHAIN_UNCONSTRAINED delivery.
    if (creditBalance < totalMaxCost) {
      console.log('\nCredit notes not yet visible. Trying dev_mint fallback...');

      const DEV_NONCE = SEND_NONCE + 1n;
      const devMintAmount = totalMaxCost * 3n;
      const devTokenCharge = feeJuiceToAsset(devMintAmount, RATE_NUM, RATE_DEN);

      await tokenAsUser.methods
        .mint_to_private(userAddress, devTokenCharge + 10000n)
        .send({ from: userAddress });

      const devTransferAuthWit = await wallet.createAuthWit(userAddress, {
        caller: fpcAddress,
        action: tokenAsUser.methods.transfer_private_to_private(
          userAddress,
          operatorAddress,
          devTokenCharge,
          DEV_NONCE,
        ),
      });

      const DEV_VALID_UNTIL = VALID_UNTIL + 5n;
      const devQuoteSigFields = await signQuote(
        schnorr,
        operatorSigningKey,
        fpcAddress,
        tokenAddress,
        devMintAmount,
        devTokenCharge,
        DEV_VALID_UNTIL,
        userAddress,
        QUOTE_DOMAIN_SEP,
      );

      const devPayAndMint = new PayAndMintPaymentMethod(
        fpcAddress,
        devTransferAuthWit,
        devQuoteSigFields,
        DEV_NONCE,
        devMintAmount,
        devTokenCharge,
        DEV_VALID_UNTIL,
        gasSettings,
      );

      await creditFpcContract.methods
        .dev_mint(totalMaxCost * 2n)
        .send({
          fee: { paymentMethod: devPayAndMint, gasSettings },
          from: userAddress,
          additionalScopes: [operatorAddress],
        });
      console.log('dev_mint tx mined.');

      await tokenAsUser.methods
        .mint_to_private(userAddress, 1n)
        .send({ from: userAddress });

      for (let i = 0; i < 10; i++) {
        creditBalance = await creditFpcContract.methods
          .balance_of(userAddress)
          .simulate({ from: userAddress });
        console.log(`  [${i + 1}/10] Credit balance: ${creditBalance}`);
        if (creditBalance >= totalMaxCost) break;
        if (i < 9) {
          try {
            await tokenAsUser.methods
              .mint_to_private(userAddress, 1n)
              .send({ from: userAddress });
          } catch (e: any) {
            console.log(`  dummy tx failed (non-fatal): ${(e.message || '').substring(0, 80)}`);
          }
        }
      }

      if (creditBalance < totalMaxCost) {
        throw new Error(
          `Credit balance ${creditBalance} still below required ${totalMaxCost} after dev_mint fallback.`,
        );
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Prepare profiling payment methods
    // ═══════════════════════════════════════════════════════════════════════

    // ── pay_and_mint profiling setup ─────────────────────────────────────
    const PROFILE_NONCE = SEND_NONCE + 10n;
    const PROFILE_VALID_UNTIL = VALID_UNTIL + 10n;

    const profileQuoteSigFields = await signQuote(
      schnorr,
      operatorSigningKey,
      fpcAddress,
      tokenAddress,
      profileCreditMint,
      profileTokenCharge,
      PROFILE_VALID_UNTIL,
      userAddress,
      QUOTE_DOMAIN_SEP,
    );

    const profileTransferAuthWit = await wallet.createAuthWit(userAddress, {
      caller: fpcAddress,
      action: tokenAsUser.methods.transfer_private_to_private(
        userAddress,
        operatorAddress,
        profileTokenCharge,
        PROFILE_NONCE,
      ),
    });

    this.#payAndMintPayment = new PayAndMintPaymentMethod(
      fpcAddress,
      profileTransferAuthWit,
      profileQuoteSigFields,
      PROFILE_NONCE,
      profileCreditMint,
      profileTokenCharge,
      PROFILE_VALID_UNTIL,
      gasSettings,
    );

    // Mint tokens for the profiled pay_and_mint send.
    await tokenAsUser.methods
      .mint_to_private(userAddress, profileTokenCharge + 10000n)
      .send({ from: userAddress });

    // ── pay_with_credit profiling setup ──────────────────────────────────
    this.#payWithCreditPayment = new PayWithCreditPaymentMethod(
      fpcAddress,
      gasSettings,
    );

    console.log('\n=== CreditFPC Benchmark Setup Complete ===\n');

    return {
      pxe,
      wallet,
      gasSettings,
      tokenAsUser,
      noopAsUser,
      userAddress,
      operatorAddress,
      fpcAddress,
    };
  }

  getMethods(context: CreditFPCBenchmarkContext) {
    const payAndMintAction = new CreditFPCActionWrapper(
      context.noopAsUser.methods.noop(),
      this.#payAndMintPayment,
      [context.operatorAddress],
      context.gasSettings,
    );
    const payWithCreditAction = new CreditFPCActionWrapper(
      context.noopAsUser.methods.noop(),
      this.#payWithCreditPayment,
      [],
      context.gasSettings,
    );

    this.#actions = [payAndMintAction, payWithCreditAction];

    return [
      {
        interaction: { caller: context.userAddress, action: payAndMintAction },
        name: 'pay_and_mint',
      },
      {
        interaction: { caller: context.userAddress, action: payWithCreditAction },
        name: 'pay_with_credit',
      },
    ];
  }

  async teardown(context: CreditFPCBenchmarkContext): Promise<void> {
    const jsonPath = readdirSync(__dirname)
      .filter((f: string) => f.startsWith('credit_fpc') && f.endsWith('.benchmark.json'))
      .map((f: string) => join(__dirname, f))
      .sort((a: string, b: string) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

    if (!jsonPath) {
      console.warn('No credit_fpc*.benchmark.json found in', __dirname);
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
        const fpcSteps = extractFpcSteps(allSteps, 'CreditFPC');
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
        console.log('System Info:');
        console.log(`  CPU:    ${si.cpuModel} (${si.cpuCores} threads)`);
        console.log(`  Memory: ${si.totalMemoryGiB} GiB`);
        console.log(`  Arch:   ${si.arch}`);
        console.log('');
      }

      writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    } catch (e: any) {
      console.warn('Could not post-process benchmark JSON:', e.message);
    }

    rmSync(PXE_DATA_DIR, { recursive: true, force: true });
  }

  #printResultTable(r: any) {
    const pad = (s: string, n: number) => String(s).padEnd(n);
    const numFmt = (n: number) => n.toLocaleString();
    const msFmt = (n: number | null) => n != null ? n.toFixed(1) : '-';
    const LINE = '\u2500'.repeat(100);

    console.log(`\n=== CreditFPC Benchmark Results: ${r.name} ===`);

    if (r.fpcGateCounts?.length) {
      console.log('\nCreditFPC-Only Gate Counts:');
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
        pad('CreditFPC TOTAL', 50),
        pad(numFmt(r.fpcTotalGateCount), 14),
        pad(msFmt(r.fpcTotalWitgenMs), 14),
        '',
      );
    }

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

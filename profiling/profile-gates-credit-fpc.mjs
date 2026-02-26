/**
 * CreditFPC gate count profiler.
 *
 * Deploys Token + CreditFPC on a running local network, then profiles both
 * the pay_and_mint and pay_with_credit flows — all in a single run.
 *
 * pay_and_mint:       user tops up credit balance (token transfer + balance mint)
 * pay_with_credit:    user pays tx fee from existing credit balance (no transfer)
 *
 * Environment:
 *   AZTEC_NODE_URL  — node endpoint (default http://127.0.0.1:8080)
 *   L1_RPC_URL      — L1 (anvil) endpoint (default http://127.0.0.1:8545)
 */

const NODE_URL     = process.env.AZTEC_NODE_URL || 'http://127.0.0.1:8080';
const L1_RPC_URL   = process.env.L1_RPC_URL     || 'http://127.0.0.1:8545';
const PXE_DATA_DIR = '/tmp/profile-fpc-pxe';

// Anvil default account 0 — only used for bridging Fee Juice in local dev.
const ANVIL_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// 1:1 rate
const RATE_NUM = 1n;
const RATE_DEN = 1n;

const QUOTE_DOMAIN_SEP = 0x465043n; // "FPC" as field

// ── Imports ───────────────────────────────────────────────────────────────────
import { createAztecNodeClient }       from '@aztec/aztec.js/node';
import { Contract }                    from '@aztec/aztec.js/contracts';
import { AccountManager }              from '@aztec/aztec.js/wallet';
import { L1FeeJuicePortalManager }     from '@aztec/aztec.js/ethereum';
import { SchnorrAccountContract }      from '@aztec/accounts/schnorr';
import { getInitialTestAccountsData }  from '@aztec/accounts/testing';
import { Fr }                          from '@aztec/foundation/curves/bn254';
import { createLogger }                from '@aztec/foundation/log';
import { Schnorr }                     from '@aztec/foundation/crypto/schnorr';
import { FeeJuiceArtifact }            from '@aztec/protocol-contracts/fee-juice';
import { ProtocolContractAddress }     from '@aztec/protocol-contracts';
import { AztecAddress }                from '@aztec/stdlib/aztec-address';
import { computeInnerAuthWitHash }     from '@aztec/stdlib/auth-witness';
import {
  FunctionCall, FunctionSelector, FunctionType, loadContractArtifact,
} from '@aztec/stdlib/abi';
import { ExecutionPayload }            from '@aztec/stdlib/tx';
import { Gas, GasFees, GasSettings }  from '@aztec/stdlib/gas';
import {
  DEFAULT_TEARDOWN_L2_GAS_LIMIT,
  DEFAULT_TEARDOWN_DA_GAS_LIMIT,
} from '@aztec/constants';
import { deriveSigningKey }            from '@aztec/stdlib/keys';
import { createPXE, getPXEConfig }     from '@aztec/pxe/server';
import { BaseWallet }                  from '@aztec/wallet-sdk/base-wallet';
import { createWalletClient, defineChain, http, publicActions } from 'viem';
import { privateKeyToAccount }         from 'viem/accounts';
import { readFileSync, readdirSync, mkdirSync, rmSync } from 'fs';
import { fileURLToPath }               from 'url';
import { dirname, join }               from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET    = join(__dirname, '../target');

function findArtifact(contractName) {
  const suffix = `-${contractName}.json`;
  const matches = readdirSync(TARGET).filter(f => f.endsWith(suffix));
  if (matches.length === 0) {
    throw new Error(`No artifact matching *${suffix} in ${TARGET}. Did you run 'aztec compile'?`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple artifacts matching *${suffix} in ${TARGET}: ${matches.join(', ')}`);
  }
  return join(TARGET, matches[0]);
}

// ── fee_juice_to_asset: ceiling division (mirrors fee_math.nr) ────────────────
function feeJuiceToAsset(feeJuice, rateNum, rateDen) {
  if (feeJuice === 0n) return 0n;
  const product = feeJuice * rateNum;
  return (product + rateDen - 1n) / rateDen;
}

// ── Minimal wallet backed by an embedded PXE ──────────────────────────────────
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

  async getAccountFromAddress(address) {
    const key = address.toString();
    if (!this.#accounts.has(key)) throw new Error(`Account not found: ${key}`);
    return this.#accounts.get(key);
  }

  async getAccounts() {
    return [...this.#accounts.keys()].map(addr => ({
      alias: '',
      item: AztecAddress.fromString(addr),
    }));
  }
}

// ── Fee payment method for CreditFPC.pay_and_mint ─────────────────────────────
//
// CreditFPC uses inline Schnorr verification: the operator's signature over the
// quote hash is passed as 64 Field args (one per byte of the 64-byte sig).
// There is no quote authwit — only the transfer authwit is in the payload.
class PayAndMintPaymentMethod {
  constructor(fpcAddress, transferAuthWit, quoteSigFields, transferNonce, rateNum, rateDen, validUntil, mintAmount, gasSettings) {
    this.fpcAddress      = fpcAddress;
    this.transferAuthWit = transferAuthWit;
    this.quoteSigFields  = quoteSigFields;
    this.transferNonce   = transferNonce;
    this.rateNum         = rateNum;
    this.rateDen         = rateDen;
    this.validUntil      = validUntil;
    this.mintAmount      = mintAmount;
    this.gasSettings     = gasSettings;
  }

  getFeePayer()    { return Promise.resolve(this.fpcAddress); }
  getGasSettings() { return this.gasSettings; }

  async getExecutionPayload() {
    const selector = await FunctionSelector.fromSignature('pay_and_mint(Field,u128,u128,u64,[u8;64],u128)');

    const feeCall = FunctionCall.from({
      name: 'pay_and_mint',
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

// ── Fee payment method for CreditFPC.pay_with_credit ──────────────────────────
class PayWithCreditPaymentMethod {
  constructor(fpcAddress, gasSettings) {
    this.fpcAddress  = fpcAddress;
    this.gasSettings = gasSettings;
  }

  getFeePayer()    { return Promise.resolve(this.fpcAddress); }
  getGasSettings() { return this.gasSettings; }

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

// ── Sign a quote with the operator's Schnorr key ──────────────────────────────
async function signQuote(schnorr, operatorSigningKey, fpcAddress, tokenAddress, rateNum, rateDen, validUntil, userAddress) {
  const quoteHash = await computeInnerAuthWitHash([
    new Fr(QUOTE_DOMAIN_SEP),
    fpcAddress.toField(),
    tokenAddress.toField(),
    new Fr(rateNum),
    new Fr(rateDen),
    new Fr(validUntil),
    userAddress.toField(),
  ]);
  const sig = await schnorr.constructSignature(quoteHash.toBuffer(), operatorSigningKey);
  return Array.from(sig.toBuffer()).map(b => new Fr(b));
}

// ── L1 client helper (reusable across funding + archiver nudging) ─────────────
async function createL1Client(node) {
  const nodeInfo = await node.getNodeInfo();
  const chain = defineChain({
    id: nodeInfo.l1ChainId,
    name: 'Local L1',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [L1_RPC_URL] } },
  });
  const account = privateKeyToAccount(ANVIL_PRIVATE_KEY);
  const walletClient = createWalletClient({ account, chain, transport: http(L1_RPC_URL) });
  return walletClient.extend(publicActions);
}

async function mineL1Blocks(l1Client, count) {
  for (let i = 0; i < count; i++) {
    await l1Client.request({ method: 'evm_mine', params: [] });
  }
}

// ── Bridge Fee Juice from L1 and claim on L2 so CreditFPC can act as fee payer ─
async function fundFpcWithFeeJuice(node, wallet, fpcAddress, userAddress, tokenContract, l1Client) {
  const logger = createLogger('profiling:bridge');
  const portalManager = await L1FeeJuicePortalManager.new(
    node, l1Client, logger,
  );

  const MINT_AMOUNT = 10n ** 21n;
  console.log(`Bridging ${MINT_AMOUNT} Fee Juice to CreditFPC (L1 deposit)...`);
  const claim = await portalManager.bridgeTokensPublic(fpcAddress, MINT_AMOUNT, true);
  console.log(`L1 deposit confirmed (messageLeafIndex=${claim.messageLeafIndex})`);

  // Mine a small number of L1 blocks so the archiver discovers the deposit.
  // Too many blocks (20+) causes L2 reorgs; zero blocks means the archiver
  // never sees the deposit. 5 is a safe middle ground.
  await mineL1Blocks(l1Client, 5);

  const feeJuice = Contract.at(ProtocolContractAddress.FeeJuice, FeeJuiceArtifact, wallet);
  const MAX_ATTEMPTS = 30;

  function isRetryable(msg) {
    return msg.includes('No L1 to L2 message found') ||
      (msg.includes('Block hash') && msg.includes('not found'));
  }

  console.log('Waiting for L2 to process L1 deposit...');
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, 3000));

    // Trigger L2 block production via a dummy tx. This may fail transiently
    // (e.g. "Block hash not found" during reorg recovery) — that's OK.
    try {
      await tokenContract.methods.mint_to_private(userAddress, 1n).send({ from: userAddress });
    } catch (e) {
      const msg = e.originalMessage || e.message || '';
      console.log(`  [${attempt}/${MAX_ATTEMPTS}] dummy tx failed: ${msg.substring(0, 80)}`);
      // Mine 1 more L1 block to nudge the archiver, then retry.
      try { await mineL1Blocks(l1Client, 1); } catch {}
      continue;
    }

    // Attempt the claim. The dummy tx above triggered an L2 block which may
    // have ingested the L1-to-L2 message.
    try {
      await feeJuice.methods
        .claim(fpcAddress, claim.claimAmount, claim.claimSecret, claim.messageLeafIndex)
        .send({ from: userAddress });
      console.log(`Fee Juice claimed (attempt ${attempt}).`);
      return;
    } catch (e) {
      const msg = e.originalMessage || e.message || '';
      if (isRetryable(msg) && attempt < MAX_ATTEMPTS) {
        console.log(`  [${attempt}/${MAX_ATTEMPTS}] ${msg.substring(0, 80)}`);
        // Mine 1 more L1 block gently.
        try { await mineL1Blocks(l1Client, 1); } catch {}
        continue;
      }
      throw e;
    }
  }
  throw new Error('Fee Juice claim failed: L1-to-L2 message never appeared in L2 tree');
}

// ── Pretty-print gate count table ─────────────────────────────────────────────
function printGateTable(title, executionSteps) {
  console.log(`\n=== ${title} ===\n`);
  const pad    = (s, n) => String(s).padEnd(n);
  const numFmt = n => n.toLocaleString();
  console.log(pad('Function', 60), pad('Own gates', 12), 'Subtotal');
  console.log('─'.repeat(88));
  let subtotal = 0;
  for (const step of executionSteps) {
    subtotal += step.gateCount ?? 0;
    const name = step.functionName ?? '(unknown)';
    console.log(pad(name, 60), pad(numFmt(step.gateCount ?? 0), 12), numFmt(subtotal));
  }
  console.log('─'.repeat(88));
  console.log(pad('TOTAL', 60), '', numFmt(subtotal));
  return subtotal;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== CreditFPC Gate Count Profiler ===\n');

  // ── Connect to node ─────────────────────────────────────────────────────────
  const node = createAztecNodeClient(NODE_URL);
  console.log('Connected to node at', NODE_URL);

  // Derive VALID_UNTIL from the L2 block timestamp (not Date.now()) because
  // the sandbox may use a different time base than the host system clock.
  const latestHeader = await node.getBlockHeader('latest');
  const l2Timestamp = latestHeader.globalVariables.timestamp;
  const VALID_UNTIL = l2Timestamp + 7200n;
  console.log(`L2 timestamp: ${l2Timestamp}, VALID_UNTIL: ${VALID_UNTIL}`);

  // ── Start embedded PXE (clean slate each run) ──────────────────────────────
  rmSync(PXE_DATA_DIR, { recursive: true, force: true });
  mkdirSync(PXE_DATA_DIR, { recursive: true });
  const pxeConfig = {
    ...getPXEConfig(),
    dataDirectory: PXE_DATA_DIR,
    l1Contracts: await node.getL1ContractAddresses(),
  };
  const pxe = await createPXE(node, pxeConfig);
  console.log('PXE started');

  // ── Create wallet + register test accounts ─────────────────────────────────
  const wallet = new SimpleWallet(pxe, node);
  const testAccounts = await getInitialTestAccountsData();
  const [userData, operatorData] = testAccounts;

  const userAddress     = await wallet.addSchnorrAccount(userData.secret, userData.salt);
  const operatorAddress = await wallet.addSchnorrAccount(operatorData.secret, operatorData.salt);
  console.log('user:    ', userAddress.toString());
  console.log('operator:', operatorAddress.toString());

  // ── Derive operator Schnorr signing key + public key ─────────────────────
  const schnorr            = new Schnorr();
  const operatorSigningKey = deriveSigningKey(operatorData.secret);
  const operatorPubKey     = await schnorr.computePublicKey(operatorSigningKey);
  console.log('operator pubkey x:', operatorPubKey.x.toString());
  console.log('operator pubkey y:', operatorPubKey.y.toString());

  // ── Load & normalise artifacts ────────────────────────────────────────────
  const tokenArtifactPath  = findArtifact('Token');
  const creditFpcArtifactPath = findArtifact('CreditFPC');
  console.log('Token artifact:    ', tokenArtifactPath);
  console.log('CreditFPC artifact:', creditFpcArtifactPath);

  const tokenArtifact = loadContractArtifact(
    JSON.parse(readFileSync(tokenArtifactPath, 'utf8')),
  );
  const creditFpcArtifact = loadContractArtifact(
    JSON.parse(readFileSync(creditFpcArtifactPath, 'utf8')),
  );

  // ── Deploy Token ──────────────────────────────────────────────────────────
  console.log('\nDeploying Token...');
  const tokenDeploy = await Contract.deploy(
    wallet, tokenArtifact,
    ['TestToken', 'TST', 18, userAddress, AztecAddress.ZERO],
    'constructor_with_minter',
  ).send({ from: userAddress });
  const tokenAddress = tokenDeploy.address;
  console.log('Token:', tokenAddress.toString());

  // ── Deploy CreditFPC ──────────────────────────────────────────────────────
  // Constructor: (operator, operator_pubkey_x, operator_pubkey_y, accepted_asset)
  console.log('Deploying CreditFPC...');
  const creditFpcDeploy = await Contract.deploy(
    wallet, creditFpcArtifact,
    [operatorAddress, operatorPubKey.x, operatorPubKey.y, tokenAddress],
  ).send({ from: userAddress });
  const fpcAddress = creditFpcDeploy.address;
  console.log('CreditFPC:', fpcAddress.toString());

  // Register both contracts as senders so the PXE discovers notes they create.
  await pxe.registerSender(fpcAddress);
  await pxe.registerSender(tokenAddress);
  console.log('Registered CreditFPC + Token as senders for note discovery.');

  // ── Contract wrapper for method calls ─────────────────────────────────────
  const tokenAsUser = Contract.at(tokenAddress, tokenArtifact, wallet);

  // ── L1 client (reused for Fee Juice bridging + archiver nudging) ─────────
  const l1Client = await createL1Client(node);

  // ── Fund CreditFPC with Fee Juice so it can pay protocol fees on real txs ─
  // The profiling simulation (.profile()) doesn't check Fee Juice, but the
  // real .send() used to establish credit balance does.
  await fundFpcWithFeeJuice(node, wallet, fpcAddress, userAddress, tokenAsUser, l1Client);

  // ── Compute gas-dependent amounts ─────────────────────────────────────────
  const minFees = await node.getCurrentMinFees();
  const PADDING = 1.5;
  const feeDa = BigInt(Math.ceil(Number(minFees.feePerDaGas) * PADDING));
  const feeL2 = BigInt(Math.ceil(Number(minFees.feePerL2Gas) * PADDING));

  const PROFILE_DA_GAS = 786432n;
  const PROFILE_L2_GAS = 6540000n;

  const profileMaxGasCost  = feeDa * PROFILE_DA_GAS + feeL2 * PROFILE_L2_GAS;
  const profileCreditMint  = profileMaxGasCost * 3n;
  const profileTokenCharge = feeJuiceToAsset(profileCreditMint, RATE_NUM, RATE_DEN);

  console.log(`\nfeePerDaGas=${feeDa} feePerL2Gas=${feeL2}`);
  console.log(`profile max gas cost: ${profileMaxGasCost}`);
  console.log(`profile credit mint: ${profileCreditMint} | token charge: ${profileTokenCharge}`);

  // ── Gas settings ───────────────────────────────────────────────────────────
  const profileGasSettings = GasSettings.default({
    gasLimits:     new Gas(Number(PROFILE_DA_GAS), Number(PROFILE_L2_GAS)),
    maxFeesPerGas: new GasFees(feeDa, feeL2),
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Establish credit balance via dev_mint BEFORE any .profile() calls.
  //  Profiling advances the PXE's sender tag indices (via
  //  get_next_app_tag_as_sender oracle), so real sends must happen first.
  //
  //  We use dev_mint (a regular private function, not a fee-payment
  //  entrypoint) because pay_and_mint is not on the node's setup function
  //  allowlist and cannot be used as a fee payment method on a fresh node.
  //  dev_mint creates credit via ONCHAIN_UNCONSTRAINED delivery which the
  //  PXE can always discover.
  // ═══════════════════════════════════════════════════════════════════════════

  const creditFpcContract = Contract.at(fpcAddress, creditFpcArtifact, wallet);
  const payWithCreditTeardownCost =
    feeL2 * (PROFILE_L2_GAS + BigInt(DEFAULT_TEARDOWN_L2_GAS_LIMIT))
    + feeDa * (PROFILE_DA_GAS + BigInt(DEFAULT_TEARDOWN_DA_GAS_LIMIT));
  console.log(`\npay_with_credit max_gas_cost (with teardown): ${payWithCreditTeardownCost}`);

  const devMintAmount = payWithCreditTeardownCost * 3n;
  console.log(`Establishing credit balance via dev_mint (${devMintAmount})...`);
  await creditFpcContract.methods
    .dev_mint(devMintAmount)
    .send({ from: userAddress });
  console.log('dev_mint tx mined.');

  // Send a follow-up tx to advance the archiver past the dev_mint block
  console.log('Sending follow-up tx to advance archiver...');
  await tokenAsUser.methods
    .mint_to_private(userAddress, 1n)
    .send({ from: userAddress });
  console.log('Follow-up tx mined.');

  let creditBalance = 0n;
  for (let i = 0; i < 10; i++) {
    creditBalance = await creditFpcContract.methods.balance_of(userAddress).simulate({ from: userAddress });
    const synced = await pxe.getSyncedBlockHeader();
    const syncedNum = Number(synced.globalVariables.blockNumber);
    const curTips = await node.getL2Tips();
    console.log(`  [${i + 1}/10] PXE block: ${syncedNum} | L2Tips.proposed: ${curTips.proposed.number} | Credit balance: ${creditBalance}`);
    if (creditBalance >= payWithCreditTeardownCost) break;
    if (i < 9) {
      try {
        await tokenAsUser.methods.mint_to_private(userAddress, 1n).send({ from: userAddress });
      } catch (e) {
        console.log(`  dummy tx failed (non-fatal): ${(e.message || '').substring(0, 80)}`);
      }
    }
  }

  if (creditBalance < payWithCreditTeardownCost) {
    throw new Error(`Credit balance ${creditBalance} still below required ${payWithCreditTeardownCost} after dev_mint.`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  FLOW 1: pay_and_mint profiling (AFTER the real send, so tag indices
  //  used by the real tx aren't polluted by profiling oracle calls)
  // ═══════════════════════════════════════════════════════════════════════════

  const PROFILE_NONCE = BigInt(Date.now());

  // Fresh quote sig for profiling (different valid_until avoids nullifier collision
  // with the real send: quote_hash includes valid_until, so VALID_UNTIL + 10
  // produces a different hash and different nullifier).
  const PROFILE_VALID_UNTIL = VALID_UNTIL + 10n;
  const profileQuoteSigFields = await signQuote(
    schnorr, operatorSigningKey, fpcAddress, tokenAddress,
    RATE_NUM, RATE_DEN, PROFILE_VALID_UNTIL, userAddress,
  );

  const profileTransferAuthWit = await wallet.createAuthWit(userAddress, {
    caller: fpcAddress,
    action: tokenAsUser.methods.transfer_private_to_public(
      userAddress, fpcAddress, profileTokenCharge, PROFILE_NONCE,
    ),
  });

  const payAndMintPayment = new PayAndMintPaymentMethod(
    fpcAddress, profileTransferAuthWit, profileQuoteSigFields, PROFILE_NONCE,
    RATE_NUM, RATE_DEN, PROFILE_VALID_UNTIL, profileCreditMint, profileGasSettings,
  );

  // Mint extra tokens for the profiling simulation
  await tokenAsUser.methods
    .mint_to_private(userAddress, profileTokenCharge + 10000n)
    .send({ from: userAddress });

  console.log('\nProfiling pay_and_mint (this takes a few minutes)...');
  const payAndMintResult = await tokenAsUser.methods
    .transfer_private_to_private(userAddress, userAddress, 1n, 0n)
    .profile({
      fee: { paymentMethod: payAndMintPayment, gasSettings: profileGasSettings },
      from: userAddress,
      additionalScopes: [operatorAddress],
      profileMode: 'full',
      skipProofGeneration: false,
    });

  const payAndMintTotal = printGateTable(
    'Flow 1: pay_and_mint (top-up + fee)',
    payAndMintResult.executionSteps,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  //  FLOW 2: pay_with_credit profiling
  // ═══════════════════════════════════════════════════════════════════════════

  const payWithCreditPayment = new PayWithCreditPaymentMethod(fpcAddress, profileGasSettings);

  console.log('\nProfiling pay_with_credit (this takes a few minutes)...');
  const payWithCreditResult = await tokenAsUser.methods
    .transfer_private_to_private(userAddress, userAddress, 1n, 0n)
    .profile({
      fee: { paymentMethod: payWithCreditPayment, gasSettings: profileGasSettings },
      from: userAddress,
      profileMode: 'full',
      skipProofGeneration: false,
    });

  const payWithCreditTotal = printGateTable(
    'Flow 2: pay_with_credit (balance-only)',
    payWithCreditResult.executionSteps,
  );

  // ── Summary ────────────────────────────────────────────────────────────────
  const numFmt = n => n.toLocaleString();
  console.log('\n=== Summary ===\n');
  console.log(`pay_and_mint total:      ${numFmt(payAndMintTotal)} gates`);
  console.log(`pay_with_credit total:   ${numFmt(payWithCreditTotal)} gates`);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  await pxe.stop?.();
  rmSync(PXE_DATA_DIR, { recursive: true, force: true });
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

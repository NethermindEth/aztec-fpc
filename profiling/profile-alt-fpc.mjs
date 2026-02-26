/**
 * AltFPC gate count profiler.
 *
 * Deploys Token + AltFPC on a running local network, mints tokens, builds
 * authwits, and profiles AltFPC.pay_and_mint — all in a single run.
 *
 * NOTE: pay_fee profiling requires a pre-existing credit balance (from an
 * on-chain pay_and_mint execution), which needs the AltFPC funded with Fee
 * Juice. This script currently only profiles pay_and_mint.
 *
 * Environment:
 *   AZTEC_NODE_URL  — node endpoint (default http://127.0.0.1:8080)
 */

const NODE_URL     = process.env.AZTEC_NODE_URL || 'http://127.0.0.1:8080';
const PXE_DATA_DIR = '/tmp/profile-alt-fpc-pxe';

// 1:1 rate
const RATE_NUM = 1n;
const RATE_DEN = 1n;

const QUOTE_DOMAIN_SEP = 0x465043n; // "FPC" as field

// ── Imports ───────────────────────────────────────────────────────────────────
import { createAztecNodeClient }       from '@aztec/aztec.js/node';
import { Contract }                    from '@aztec/aztec.js/contracts';
import { AccountManager }              from '@aztec/aztec.js/wallet';
import { SchnorrAccountContract }      from '@aztec/accounts/schnorr';
import { getInitialTestAccountsData }  from '@aztec/accounts/testing';
import { Fr }                          from '@aztec/foundation/curves/bn254';
import { AztecAddress }                from '@aztec/stdlib/aztec-address';
import { computeInnerAuthWitHash }     from '@aztec/stdlib/auth-witness';
import {
  FunctionCall, FunctionSelector, FunctionType, loadContractArtifact,
} from '@aztec/stdlib/abi';
import { ExecutionPayload }            from '@aztec/stdlib/tx';
import { Gas, GasFees, GasSettings }  from '@aztec/stdlib/gas';
import { deriveSigningKey }            from '@aztec/stdlib/keys';
import { Schnorr }                     from '@aztec/foundation/crypto/schnorr';
import { createPXE, getPXEConfig }     from '@aztec/pxe/server';
import { BaseWallet }                  from '@aztec/wallet-sdk/base-wallet';
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

// ── Network timestamp (seconds) from latest block, fallback to wall clock ─────
async function getNetworkTimestamp(node) {
  const header = await node.getBlockHeader('latest').catch(() => null);
  const ts = header?.globalVariables?.timestamp;
  return ts != null ? BigInt(ts) : BigInt(Math.floor(Date.now() / 1000));
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

// ── Payment method for pay_and_mint ───────────────────────────────────────────
class PayAndMintMethod {
  constructor(fpcAddress, transferAuthWit, quoteSigFields, authwitNonce, rateNum, rateDen, validUntil, mintAmount, gasSettings) {
    this.fpcAddress      = fpcAddress;
    this.transferAuthWit = transferAuthWit;
    this.quoteSigFields  = quoteSigFields;
    this.authwitNonce    = authwitNonce;
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
        new Fr(this.authwitNonce),
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

// ── Print gate count table ────────────────────────────────────────────────────
function printGateTable(title, result) {
  console.log(`\n=== ${title} ===\n`);
  const pad    = (s, n) => String(s).padEnd(n);
  const numFmt = n => n.toLocaleString();
  console.log(pad('Function', 60), pad('Own gates', 12), 'Subtotal');
  console.log('─'.repeat(88));
  let subtotal = 0;
  for (const step of result.executionSteps) {
    subtotal += step.gateCount ?? 0;
    const name = step.functionName ?? '(unknown)';
    console.log(pad(name, 60), pad(numFmt(step.gateCount ?? 0), 12), numFmt(subtotal));
  }
  console.log('─'.repeat(88));
  console.log(pad('TOTAL', 60), '', numFmt(subtotal));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== AltFPC Gate Count Profiler ===\n');

  // ── Connect to node ─────────────────────────────────────────────────────────
  const node = createAztecNodeClient(NODE_URL);
  console.log('Connected to node at', NODE_URL);

  // Anchor VALID_UNTIL to the network's clock, not the local wall clock.
  // This prevents "quote expired" errors when the Aztec node's block
  // timestamps differ from the host clock.
  const networkTs = await getNetworkTimestamp(node);
  const VALID_UNTIL = networkTs + 3600n;
  const TX_NONCE    = BigInt(Date.now());

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

  // ── Derive operator signing key + public key ──────────────────────────────
  const schnorr            = new Schnorr();
  const operatorSigningKey = deriveSigningKey(operatorData.secret);
  const operatorPubKey     = await schnorr.computePublicKey(operatorSigningKey);
  console.log('operator pubkey x:', operatorPubKey.x.toString());
  console.log('operator pubkey y:', operatorPubKey.y.toString());

  // ── Load & normalize artifacts ─────────────────────────────────────────────
  const tokenArtifactPath  = findArtifact('Token');
  const altFpcArtifactPath = findArtifact('AltFPC');
  console.log('Token artifact: ', tokenArtifactPath);
  console.log('AltFPC artifact:', altFpcArtifactPath);

  const tokenArtifact = loadContractArtifact(
    JSON.parse(readFileSync(tokenArtifactPath, 'utf8')),
  );
  const altFpcArtifact = loadContractArtifact(
    JSON.parse(readFileSync(altFpcArtifactPath, 'utf8')),
  );

  // ── Deploy Token ───────────────────────────────────────────────────────────
  console.log('\nDeploying Token...');
  const tokenDeploy = await Contract.deploy(
    wallet, tokenArtifact,
    ['TestToken', 'TST', 18, userAddress, AztecAddress.ZERO],
    'constructor_with_minter',
  ).send({ from: userAddress });
  const tokenAddress = tokenDeploy.address;
  console.log('Token:', tokenAddress.toString());

  // ── Deploy AltFPC ─────────────────────────────────────────────────────────
  // Constructor: (operator, operator_pubkey_x, operator_pubkey_y, accepted_asset)
  console.log('Deploying AltFPC...');
  const altFpcDeploy = await Contract.deploy(
    wallet, altFpcArtifact,
    [operatorAddress, operatorPubKey.x, operatorPubKey.y, tokenAddress],
  ).send({ from: userAddress });
  const altFpcAddress = altFpcDeploy.address;
  console.log('AltFPC:', altFpcAddress.toString());

  // ── Contract wrapper for method calls ──────────────────────────────────────
  const tokenAsUser = Contract.at(tokenAddress, tokenArtifact, wallet);

  // ── Compute gas-dependent charge ───────────────────────────────────────────
  const minFees = await node.getCurrentMinFees();
  const PADDING = 1.5;
  const feeDa = BigInt(Math.ceil(Number(minFees.feePerDaGas) * PADDING));
  const feeL2 = BigInt(Math.ceil(Number(minFees.feePerL2Gas) * PADDING));
  const DA_GAS  = 786432n;
  const L2_GAS  = 6540000n;
  const maxGasCost = feeDa * DA_GAS + feeL2 * L2_GAS;

  // In pay_and_mint, charge = fee_juice_to_asset(mint_amount, rate_num, rate_den)
  // We set mint_amount = maxGasCost so charge = maxGasCost (with 1:1 rate)
  const mintAmount = maxGasCost;
  const charge = feeJuiceToAsset(mintAmount, RATE_NUM, RATE_DEN);

  console.log(`\nfeePerDaGas=${feeDa} feePerL2Gas=${feeL2}`);
  console.log(`max gas cost: ${maxGasCost} | mint amount: ${mintAmount} | charge: ${charge}`);

  // ── Mint tokens to user ────────────────────────────────────────────────────
  const tokenMintAmount = charge + 1000n;
  console.log(`\nMinting ${tokenMintAmount} tokens to user...`);
  await tokenAsUser.methods
    .mint_to_private(userAddress, tokenMintAmount)
    .send({ from: userAddress });
  console.log('Minted.');

  // ── Quote signature: sign the quote hash with operator's Schnorr key ──────
  const quoteHash = await computeInnerAuthWitHash([
    new Fr(QUOTE_DOMAIN_SEP),
    altFpcAddress.toField(),
    tokenAddress.toField(),
    new Fr(RATE_NUM),
    new Fr(RATE_DEN),
    new Fr(VALID_UNTIL),
    userAddress.toField(),
  ]);
  const quoteSig = await schnorr.constructSignature(quoteHash.toBuffer(), operatorSigningKey);
  const quoteSigFields = Array.from(quoteSig.toBuffer()).map(b => new Fr(b));
  console.log('Quote signature created (inline Schnorr).');

  // ── Transfer authwit: user authorises AltFPC to pull tokens ────────────────
  const transferAuthWit = await wallet.createAuthWit(userAddress, {
    caller: altFpcAddress,
    action: tokenAsUser.methods.transfer_private_to_private(
      userAddress, operatorAddress, charge, TX_NONCE,
    ),
  });
  console.log('Transfer authwit created.');

  // ── Gas settings ───────────────────────────────────────────────────────────
  const gasSettings = GasSettings.default({
    gasLimits:     new Gas(Number(DA_GAS), Number(L2_GAS)),
    maxFeesPerGas: new GasFees(feeDa, feeL2),
  });

  const feePayment = new PayAndMintMethod(
    altFpcAddress, transferAuthWit, quoteSigFields,
    TX_NONCE, RATE_NUM, RATE_DEN, VALID_UNTIL, mintAmount, gasSettings,
  );

  // ── Profile pay_and_mint ──────────────────────────────────────────────────
  console.log('\nProfiling pay_and_mint (this takes a few minutes)...');
  const result = await tokenAsUser.methods
    .transfer_private_to_private(userAddress, userAddress, 1n, 0n)
    .profile({
      fee: { paymentMethod: feePayment, gasSettings },
      from: userAddress,
      additionalScopes: [operatorAddress],
      profileMode: 'full',
      skipProofGeneration: false,
    });

  printGateTable('AltFPC Gate Count Profile: pay_and_mint', result);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  await pxe.stop?.();
  rmSync(PXE_DATA_DIR, { recursive: true, force: true });
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

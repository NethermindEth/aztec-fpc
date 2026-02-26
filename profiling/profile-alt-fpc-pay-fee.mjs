/**
 * AltFPC gate count profiler -- pay_fee path.
 *
 * Uses AltFPCMock (identical pay_fee logic, but with a simple mint_credit
 * function) to avoid Fee Juice bridging. The mock is deployed and funded
 * with .send() (user pays fees), then pay_fee is profiled with .profile().
 *
 * Environment:
 *   AZTEC_NODE_URL  -- node endpoint (default http://127.0.0.1:8080)
 */

const NODE_URL     = process.env.AZTEC_NODE_URL || 'http://127.0.0.1:8080';
const PXE_DATA_DIR = '/tmp/profile-alt-fpc-payfee-pxe';

// ── Imports ───────────────────────────────────────────────────────────────────
import { createAztecNodeClient }       from '@aztec/aztec.js/node';
import { Contract }                    from '@aztec/aztec.js/contracts';
import { AccountManager }              from '@aztec/aztec.js/wallet';
import { SchnorrAccountContract }      from '@aztec/accounts/schnorr';
import { getInitialTestAccountsData }  from '@aztec/accounts/testing';
import { Fr }                          from '@aztec/foundation/curves/bn254';
import { AztecAddress }                from '@aztec/stdlib/aztec-address';
import {
  FunctionCall, FunctionSelector, FunctionType, loadContractArtifact,
} from '@aztec/stdlib/abi';
import { ExecutionPayload }            from '@aztec/stdlib/tx';
import { Gas, GasFees, GasSettings }  from '@aztec/stdlib/gas';
import { deriveSigningKey }            from '@aztec/stdlib/keys';
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
  if (matches.length === 0) throw new Error(`No artifact matching *${suffix} in ${TARGET}`);
  if (matches.length > 1) throw new Error(`Multiple artifacts matching *${suffix}: ${matches.join(', ')}`);
  return join(TARGET, matches[0]);
}

// ── Minimal wallet backed by an embedded PXE ──────────────────────────────────
class SimpleWallet extends BaseWallet {
  #accounts = new Map();
  constructor(pxe, node) { super(pxe, node); }

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
      alias: '', item: AztecAddress.fromString(addr),
    }));
  }
}

// ── Payment method: pay_fee ───────────────────────────────────────────────────
class PayFeeMethod {
  constructor(fpcAddress, gasSettings) {
    this.fpcAddress  = fpcAddress;
    this.gasSettings = gasSettings;
  }

  getFeePayer()    { return Promise.resolve(this.fpcAddress); }
  getGasSettings() { return this.gasSettings; }

  async getExecutionPayload() {
    const selector = await FunctionSelector.fromSignature('pay_fee()');
    const feeCall = FunctionCall.from({
      name: 'pay_fee', to: this.fpcAddress, selector,
      type: FunctionType.PRIVATE, hideMsgSender: false, isStatic: false,
      args: [], returnTypes: [],
    });
    return new ExecutionPayload([feeCall], [], [], [], this.fpcAddress);
  }
}

// ── Print gate count table ────────────────────────────────────────────────────
function printGateTable(title, result) {
  console.log(`\n=== ${title} ===\n`);
  const pad    = (s, n) => String(s).padEnd(n);
  const numFmt = n => n.toLocaleString();
  console.log(pad('Function', 60), pad('Own gates', 12), 'Subtotal');
  console.log('-'.repeat(88));
  let subtotal = 0;
  for (const step of result.executionSteps) {
    subtotal += step.gateCount ?? 0;
    console.log(pad(step.functionName ?? '(unknown)', 60), pad(numFmt(step.gateCount ?? 0), 12), numFmt(subtotal));
  }
  console.log('-'.repeat(88));
  console.log(pad('TOTAL', 60), '', numFmt(subtotal));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== AltFPC Gate Count Profiler: pay_fee ===\n');

  const node = createAztecNodeClient(NODE_URL);
  console.log('Connected to node at', NODE_URL);

  // ── PXE ─────────────────────────────────────────────────────────────────────
  rmSync(PXE_DATA_DIR, { recursive: true, force: true });
  mkdirSync(PXE_DATA_DIR, { recursive: true });
  const pxe = await createPXE(node, {
    ...getPXEConfig(),
    dataDirectory: PXE_DATA_DIR,
    l1Contracts: await node.getL1ContractAddresses(),
  });
  console.log('PXE started');

  // ── Accounts ────────────────────────────────────────────────────────────────
  const wallet = new SimpleWallet(pxe, node);
  const [userData, operatorData] = await getInitialTestAccountsData();
  const userAddress     = await wallet.addSchnorrAccount(userData.secret, userData.salt);
  const operatorAddress = await wallet.addSchnorrAccount(operatorData.secret, operatorData.salt);
  console.log('user:    ', userAddress.toString());
  console.log('operator:', operatorAddress.toString());

  // ── Artifact ────────────────────────────────────────────────────────────────
  const mockArtifact = loadContractArtifact(
    JSON.parse(readFileSync(findArtifact('AltFPCMock'), 'utf8')),
  );

  // ── Deploy AltFPCMock (user pays fees, no Fee Juice needed on mock) ─────────
  console.log('\nDeploying AltFPCMock...');
  const mockDeploy = await Contract.deploy(
    wallet, mockArtifact,
    [operatorAddress, userAddress],  // dummy values, pay_fee doesn't read these
  ).send({ from: userAddress });
  const mockAddress = mockDeploy.address;
  console.log('AltFPCMock:', mockAddress.toString());

  const mockContract = Contract.at(mockAddress, mockArtifact, wallet);

  // ── Gas math ────────────────────────────────────────────────────────────────
  const minFees = await node.getCurrentMinFees();
  const PADDING = 1.5;
  const feeDa = BigInt(Math.ceil(Number(minFees.feePerDaGas) * PADDING));
  const feeL2 = BigInt(Math.ceil(Number(minFees.feePerL2Gas) * PADDING));

  // Large gas limits for profiling (not sent to network)
  const DA_GAS = 786432n;
  const L2_GAS = 6540000n;
  const profileMaxGasCost = feeDa * DA_GAS + feeL2 * L2_GAS;

  // Credit = 100000x what pay_fee will need
  const CREDIT_MULTIPLIER = 100000n;
  const creditAmount = profileMaxGasCost * CREDIT_MULTIPLIER;

  console.log(`\nprofileMaxGasCost: ${profileMaxGasCost}`);
  console.log(`creditAmount (${CREDIT_MULTIPLIER}x): ${creditAmount}`);

  // ── Mint credit via .send() (user pays fees for this tx) ────────────────────
  console.log('\nMinting credit to user...');
  await mockContract.methods
    .mint_credit(creditAmount)
    .send({ from: userAddress });
  console.log('Credit minted.');

  // ── Profile pay_fee ─────────────────────────────────────────────────────────
  const gasSettings = GasSettings.default({
    gasLimits:     new Gas(Number(DA_GAS), Number(L2_GAS)),
    maxFeesPerGas: new GasFees(feeDa, feeL2),
  });

  const payFeeMethod = new PayFeeMethod(mockAddress, gasSettings);

  // We need a Token contract for the dummy app call (transfer_private_to_private).
  // Deploy a token and mint a tiny amount so the app call succeeds.
  const tokenArtifact = loadContractArtifact(
    JSON.parse(readFileSync(findArtifact('Token'), 'utf8')),
  );

  console.log('\nDeploying Token (for dummy app call)...');
  const tokenDeploy = await Contract.deploy(
    wallet, tokenArtifact,
    ['TestToken', 'TST', 18, userAddress, AztecAddress.ZERO],
    'constructor_with_minter',
  ).send({ from: userAddress });
  const tokenAddress = tokenDeploy.address;
  console.log('Token:', tokenAddress.toString());

  const tokenAsUser = Contract.at(tokenAddress, tokenArtifact, wallet);

  console.log('Minting tokens for dummy app call...');
  await tokenAsUser.methods
    .mint_to_private(userAddress, 1000n)
    .send({ from: userAddress });
  console.log('Tokens minted.');

  console.log('\nProfiling pay_fee (this takes a few minutes)...');
  const result = await tokenAsUser.methods
    .transfer_private_to_private(userAddress, userAddress, 1n, 0n)
    .profile({
      fee: { paymentMethod: payFeeMethod, gasSettings },
      from: userAddress,
      profileMode: 'full',
      skipProofGeneration: false,
    });

  printGateTable('AltFPC Gate Count Profile: pay_fee', result);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  await pxe.stop?.();
  rmSync(PXE_DATA_DIR, { recursive: true, force: true });
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

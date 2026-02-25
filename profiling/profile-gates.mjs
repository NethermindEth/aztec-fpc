/**
 * One-shot FPC gate count profiler.
 *
 * Deploys Token + FPC on a running local network, mints tokens, builds
 * authwits, and profiles FPC.fee_entrypoint — all in a single run.
 *
 * Environment:
 *   AZTEC_NODE_URL  — node endpoint (default http://127.0.0.1:8080)
 */

const NODE_URL     = process.env.AZTEC_NODE_URL || 'http://127.0.0.1:8080';
const PXE_DATA_DIR = '/tmp/profile-fpc-pxe';

// 1:1 rate, valid 1 hour
const RATE_NUM    = 1n;
const RATE_DEN    = 1n;
const VALID_UNTIL = BigInt(Math.floor(Date.now() / 1000) + 3600);
const TX_NONCE    = BigInt(Date.now());

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
import { createPXE, getPXEConfig }     from '@aztec/pxe/server';
import { BaseWallet }                  from '@aztec/wallet-sdk/base-wallet';
import { readFileSync, mkdirSync, rmSync } from 'fs';
import { fileURLToPath }               from 'url';
import { dirname, join }               from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET    = join(__dirname, '../target');

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

// ── Custom FeePaymentMethod for our FPC ───────────────────────────────────────
class CustomFPCPaymentMethod {
  constructor(fpcAddress, transferAuthWit, transferNonce, rateNum, rateDen, validUntil, gasSettings) {
    this.fpcAddress      = fpcAddress;
    this.transferAuthWit = transferAuthWit;
    this.transferNonce   = transferNonce;
    this.rateNum         = rateNum;
    this.rateDen         = rateDen;
    this.validUntil      = validUntil;
    this.gasSettings     = gasSettings;
  }

  getFeePayer()    { return Promise.resolve(this.fpcAddress); }
  getGasSettings() { return this.gasSettings; }

  async getExecutionPayload() {
    const selector = await FunctionSelector.fromSignature('fee_entrypoint(Field,u128,u128,u64)');

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

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== FPC Gate Count Profiler ===\n');

  // ── Connect to node ─────────────────────────────────────────────────────────
  const node = createAztecNodeClient(NODE_URL);
  console.log('Connected to node at', NODE_URL);

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

  // ── Load & normalize artifacts ─────────────────────────────────────────────
  const tokenArtifact = loadContractArtifact(
    JSON.parse(readFileSync(join(TARGET, 'token_contract-Token.json'), 'utf8')),
  );
  const fpcArtifact = loadContractArtifact(
    JSON.parse(readFileSync(join(TARGET, 'fpc-FPC.json'), 'utf8')),
  );

  // ── Deploy Token ───────────────────────────────────────────────────────────
  // constructor_with_minter(name, symbol, decimals, minter, upgrade_authority)
  // userAddress doubles as minter for this profiling run.
  console.log('\nDeploying Token...');
  const tokenDeploy = await Contract.deploy(
    wallet, tokenArtifact,
    ['TestToken', 'TST', 18, userAddress, AztecAddress.ZERO],
    'constructor_with_minter',
  ).send({ from: userAddress });
  const tokenAddress = tokenDeploy.address;
  console.log('Token:', tokenAddress.toString());

  // ── Deploy FPC ─────────────────────────────────────────────────────────────
  // Constructor: (operator, accepted_asset)
  console.log('Deploying FPC...');
  const fpcDeploy = await Contract.deploy(
    wallet, fpcArtifact,
    [operatorAddress, tokenAddress],
  ).send({ from: userAddress });
  const fpcAddress = fpcDeploy.address;
  console.log('FPC:  ', fpcAddress.toString());

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
  const charge     = feeJuiceToAsset(maxGasCost, RATE_NUM, RATE_DEN);

  console.log(`\nfeePerDaGas=${feeDa} feePerL2Gas=${feeL2}`);
  console.log(`max gas cost: ${maxGasCost} | token charge: ${charge}`);

  // ── Mint tokens to user ────────────────────────────────────────────────────
  const mintAmount = charge + 1000n;
  console.log(`\nMinting ${mintAmount} tokens to user...`);
  await tokenAsUser.methods
    .mint_to_private(userAddress, mintAmount)
    .send({ from: userAddress });
  console.log('Minted.');

  // ── Quote authwit: operator authorises FPC to consume the fee quote ────────
  // inner_hash = poseidon2([DOMAIN_SEP, fpc, token, rate_num, rate_den, valid_until, user])
  const quoteInnerHash = await computeInnerAuthWitHash([
    new Fr(QUOTE_DOMAIN_SEP),
    fpcAddress.toField(),
    tokenAddress.toField(),
    new Fr(RATE_NUM),
    new Fr(RATE_DEN),
    new Fr(VALID_UNTIL),
    userAddress.toField(),
  ]);
  const quoteAuthWit = await wallet.createAuthWit(operatorAddress, {
    consumer: fpcAddress,
    innerHash: quoteInnerHash,
  });
  console.log('Quote authwit created.');

  // ── Transfer authwit: user authorises FPC to pull `charge` tokens ──────────
  // FPC calls: Token.transfer_private_to_private(user, operator, charge, TX_NONCE)
  const transferAuthWit = await wallet.createAuthWit(userAddress, {
    caller: fpcAddress,
    action: tokenAsUser.methods.transfer_private_to_private(
      userAddress, operatorAddress, charge, TX_NONCE,
    ),
  });
  console.log('Transfer authwit created.');

  // ── Gas settings matching the computed charge ──────────────────────────────
  const gasSettings = GasSettings.default({
    gasLimits:     new Gas(Number(DA_GAS), Number(L2_GAS)),
    maxFeesPerGas: new GasFees(feeDa, feeL2),
  });

  const feePayment = new CustomFPCPaymentMethod(
    fpcAddress, transferAuthWit, TX_NONCE, RATE_NUM, RATE_DEN, VALID_UNTIL, gasSettings,
  );

  // ── Profile ────────────────────────────────────────────────────────────────
  // Dummy app tx: Token.transfer_private_to_private(user→user, 1, nonce=0).
  // When from == msg_sender the token contract requires nonce=0 (no authwit path).
  console.log('\nProfiling (this takes a few minutes)...');
  const result = await tokenAsUser.methods
    .transfer_private_to_private(userAddress, userAddress, 1n, 0n)
    .profile({
      fee: { paymentMethod: feePayment, gasSettings },
      from: userAddress,
      additionalScopes: [operatorAddress],
      authWitnesses: [quoteAuthWit],
      profileMode: 'full',
      skipProofGeneration: false,
    });

  // ── Print results ──────────────────────────────────────────────────────────
  console.log('\n=== Gate Count Profile ===\n');
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

  // ── Cleanup ────────────────────────────────────────────────────────────────
  await pxe.stop?.();
  rmSync(PXE_DATA_DIR, { recursive: true, force: true });
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

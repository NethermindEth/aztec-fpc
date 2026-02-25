/**
 * Profile gate count of FPC.fee_entrypoint.
 *
 * Run from the aztec-packages yarn-project directory so @aztec/* packages resolve:
 *   cd /path/to/aztec-packages/yarn-project
 *   node /path/to/aztec-fpc/profiling/profile-fpc.mjs
 *
 * Update TOKEN_ADDRESS and FPC_ADDRESS after each redeploy (see deploy-fpc.mjs).
 */

// ── Deployed addresses ────────────────────────────────────────────────────────
const TOKEN_ADDRESS = '0x2b699e1bcdc58eae28f184477eb2a2a2d99be04e4399df4a63dfccf5c0c53f63';
const FPC_ADDRESS   = '0x0c2338b34ae53d209a433d2b77e4a8f1f2b1ba0ab5fb3b8f2acdd9085e6b9385';
const NODE_URL      = 'http://127.0.0.1:8080';
const PXE_DATA_DIR  = '/tmp/profile-fpc-pxe';

// Quote params: 1:1 rate, valid 1h
const RATE_NUM    = 1n;
const RATE_DEN    = 1n;
const VALID_UNTIL = BigInt(Math.floor(Date.now() / 1000) + 3600);
const TX_NONCE    = BigInt(Date.now()); // unique per run

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
import { FunctionCall, FunctionSelector, FunctionType, loadContractArtifact } from '@aztec/stdlib/abi';
import { ExecutionPayload }            from '@aztec/stdlib/tx';
import { Gas, GasFees, GasSettings }  from '@aztec/stdlib/gas';
import { deriveSigningKey }            from '@aztec/stdlib/keys';
import { createPXE, getPXEConfig }     from '@aztec/pxe/server';
import { BaseWallet }                  from '@aztec/wallet-sdk/base-wallet';
import { readFileSync, mkdirSync }     from 'fs';
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

  /** Register a Schnorr account into this wallet by secret key + salt. Returns the address. */
  async addSchnorrAccount(secret, salt) {
    const contract = new SchnorrAccountContract(deriveSigningKey(secret));
    const manager = await AccountManager.create(this, secret, contract, new Fr(salt));
    const instance = manager.getInstance();
    const artifact = await contract.getContractArtifact();
    // registerContract stores instance+artifact in PXE and calls pxe.registerAccount for the key
    await this.registerContract(instance, artifact, secret);
    this.#accounts.set(manager.address.toString(), await manager.getAccount());
    return manager.address;
  }

  async getAccountFromAddress(address) {
    const key = address.toString();
    if (!this.#accounts.has(key)) throw new Error(`Account not found in wallet: ${key}`);
    return this.#accounts.get(key);
  }

  async getAccounts() {
    return [...this.#accounts.keys()].map(addr => ({ alias: '', item: AztecAddress.fromString(addr) }));
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
    // Build function call: fee_entrypoint(authwit_nonce, rate_num, rate_den, valid_until)
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
      [this.transferAuthWit],  // transfer authwit so FPC can pull tokens from user
      [],
      [],
      this.fpcAddress,         // feePayer
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== FPC.fee_entrypoint Gate Count Profiler ===\n');

  // Create node client
  const node = createAztecNodeClient(NODE_URL);
  console.log('Connected to node at', NODE_URL);

  // Create embedded PXE
  mkdirSync(PXE_DATA_DIR, { recursive: true });
  const pxeConfig = {
    ...getPXEConfig(),
    dataDirectory: PXE_DATA_DIR,
    l1Contracts: await node.getL1ContractAddresses(),
  };
  const pxe = await createPXE(node, pxeConfig);
  console.log('PXE started at', PXE_DATA_DIR);

  // Create minimal wallet
  const wallet = new SimpleWallet(pxe, node);

  // Load test accounts (deterministic keys)
  const testAccountsData = await getInitialTestAccountsData();
  const [userData, operatorData] = testAccountsData;

  // Register user (test0) and operator (test1) in wallet
  const userAddress     = await wallet.addSchnorrAccount(userData.secret, userData.salt);
  const operatorAddress = await wallet.addSchnorrAccount(operatorData.secret, operatorData.salt);

  console.log('user:    ', userAddress.toString());
  console.log('operator:', operatorAddress.toString());

  const fpcAddress   = AztecAddress.fromString(FPC_ADDRESS);
  const tokenAddress = AztecAddress.fromString(TOKEN_ADDRESS);

  // Load Token and FPC artifacts.
  // loadContractArtifact normalises raw-nargo format (no functionType field, has
  // custom_attributes) into the ContractArtifact shape the workspace code expects.
  const tokenArtifact = loadContractArtifact(
    JSON.parse(readFileSync(join(TARGET, 'token_contract-Token.json'), 'utf8')),
  );
  const fpcArtifact = loadContractArtifact(
    JSON.parse(readFileSync(join(TARGET, 'fpc-FPC.json'), 'utf8')),
  );

  // Register token and FPC contracts in PXE (fetch instances from node)
  const tokenInstance = await node.getContract(tokenAddress);
  if (!tokenInstance) throw new Error(`Token not found on node at ${TOKEN_ADDRESS}`);
  await wallet.registerContract(tokenInstance, tokenArtifact);
  console.log('Token contract registered.');

  const fpcInstance = await node.getContract(fpcAddress);
  if (!fpcInstance) throw new Error(`FPC not found on node at ${FPC_ADDRESS}`);
  await wallet.registerContract(fpcInstance, fpcArtifact);
  console.log('FPC contract registered.');

  // Contract wrappers (both use the same wallet; `from` in options selects the signer)
  const tokenAsOperator = Contract.at(tokenAddress, tokenArtifact, wallet);
  const tokenAsUser     = Contract.at(tokenAddress, tokenArtifact, wallet);

  // ── Compute gas-dependent charge ─────────────────────────────────────────
  const minFees = await node.getCurrentMinFees();
  const PADDING  = 1.5;
  // minFees.feePerDaGas is a bigint (UInt128)
  const feeDa = BigInt(Math.ceil(Number(minFees.feePerDaGas) * PADDING));
  const feeL2 = BigInt(Math.ceil(Number(minFees.feePerL2Gas) * PADDING));
  const DA_GAS  = 786432n;
  const L2_GAS  = 6540000n;
  const maxGasCost = feeDa * DA_GAS + feeL2 * L2_GAS;
  const charge     = feeJuiceToAsset(maxGasCost, RATE_NUM, RATE_DEN);

  console.log(`\nfeePerDaGas=${feeDa} feePerL2Gas=${feeL2}`);
  console.log(`max gas cost: ${maxGasCost} | token charge: ${charge}`);

  // ── Mint tokens to user ───────────────────────────────────────────────────
  const mintAmount = charge + 1000n;
  console.log(`\nMinting ${mintAmount} tokens to user...`);
  await tokenAsOperator.methods.mint_to_private(userAddress, mintAmount)
    .send({ from: userAddress });
  console.log('Minted.');

  // ── Quote authwit: operator authorizes FPC to consume this quote ──────────
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
  // Operator signs: "fpc is allowed to consume this inner hash"
  const quoteAuthWit = await wallet.createAuthWit(operatorAddress, {
    consumer: fpcAddress,
    innerHash: quoteInnerHash,
  });
  console.log('Quote authwit created.');

  // ── Transfer authwit: user authorizes FPC to transfer `charge` tokens ─────
  // FPC will call: Token.transfer_in_private(user, operator, charge, TX_NONCE)
  // We use the ContractFunctionInteraction directly (action field) — resolved at runtime
  const transferAuthWit = await wallet.createAuthWit(userAddress, {
    caller: fpcAddress,
    action: tokenAsUser.methods.transfer_in_private(userAddress, operatorAddress, charge, TX_NONCE),
  });
  console.log('Transfer authwit created.');

  // ── Gas settings matching the computed charge ─────────────────────────────
  const gasSettings = GasSettings.default({
    gasLimits:     new Gas(Number(DA_GAS), Number(L2_GAS)),
    maxFeesPerGas: new GasFees(feeDa, feeL2),
  });

  const feePayment = new CustomFPCPaymentMethod(
    fpcAddress, transferAuthWit, TX_NONCE, RATE_NUM, RATE_DEN, VALID_UNTIL, gasSettings,
  );

  // ── Run the profile ───────────────────────────────────────────────────────
  // Profile Token.transfer_in_private(user→user, amount=1, nonce=0).
  // When from == msg_sender, the token contract requires nonce=0 (no authwit path).
  console.log('\nRunning profile (takes a few minutes for IVC proof generation)...');
  const result = await tokenAsUser.methods
    .transfer_in_private(userAddress, userAddress, 1n, 0n)
    .profile({
      fee: { paymentMethod: feePayment, gasSettings },
      from: userAddress,
      // Include operatorAddress so PXE can decrypt the operator's signing_public_key note
      // (needed by SchnorrAccount.verify_private_authwit when FPC calls the operator's account)
      additionalScopes: [operatorAddress],
      // quoteAuthWit authorizes FPC to consume the operator's fee quote
      // transferAuthWit is already inside feePayment.getExecutionPayload()
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

  await pxe.stop?.();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

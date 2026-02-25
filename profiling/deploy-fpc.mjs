/**
 * Deploy Token and FPC contracts using aztec-packages workspace packages.
 *
 * This ensures the class IDs computed here match those in profile-fpc.mjs
 * (both use the same getContractClassFromArtifact implementation), whereas
 * the devbox aztec-wallet binary may use a different version.
 *
 * Run from the aztec-packages yarn-project directory so @aztec/* packages resolve:
 *   cd /path/to/aztec-packages/yarn-project
 *   node /path/to/aztec-fpc/profiling/deploy-fpc.mjs
 *
 * After success, copy the printed TOKEN_ADDRESS and FPC_ADDRESS into profile-fpc.mjs.
 */

const NODE_URL     = 'http://127.0.0.1:8080';
const PXE_DATA_DIR = '/tmp/deploy-fpc-pxe';

// ── Imports ───────────────────────────────────────────────────────────────────
import { createAztecNodeClient }      from '@aztec/aztec.js/node';
import { Contract }                   from '@aztec/aztec.js/contracts';
import { AccountManager }             from '@aztec/aztec.js/wallet';
import { SchnorrAccountContract }     from '@aztec/accounts/schnorr';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { Fr }                         from '@aztec/foundation/curves/bn254';
import { AztecAddress }               from '@aztec/stdlib/aztec-address';
import { deriveSigningKey }           from '@aztec/stdlib/keys';
import { createPXE, getPXEConfig }    from '@aztec/pxe/server';
import { BaseWallet }                 from '@aztec/wallet-sdk/base-wallet';
import { readFileSync, mkdirSync }    from 'fs';
import { fileURLToPath }              from 'url';
import { dirname, join }              from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET    = join(__dirname, '../target');

// ── Minimal wallet (same as profile-fpc.mjs) ─────────────────────────────────
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
    return [...this.#accounts.keys()].map(addr => ({ alias: '', item: AztecAddress.fromString(addr) }));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Deploy Token + FPC via workspace packages ===\n');

  const node = createAztecNodeClient(NODE_URL);

  mkdirSync(PXE_DATA_DIR, { recursive: true });
  const pxeConfig = {
    ...getPXEConfig(),
    dataDirectory: PXE_DATA_DIR,
    l1Contracts: await node.getL1ContractAddresses(),
  };
  const pxe = await createPXE(node, pxeConfig);

  const wallet = new SimpleWallet(pxe, node);

  // test0 = admin/minter, test1 = operator
  const testAccountsData = await getInitialTestAccountsData();
  const [userData, operatorData] = testAccountsData;

  const adminAddress    = await wallet.addSchnorrAccount(userData.secret, userData.salt);
  const operatorAddress = await wallet.addSchnorrAccount(operatorData.secret, operatorData.salt);
  console.log('admin (test0):   ', adminAddress.toString());
  console.log('operator (test1):', operatorAddress.toString());

  const tokenArtifactRaw = JSON.parse(readFileSync(join(TARGET, 'token_contract-Token.json'), 'utf8'));
  const fpcArtifactRaw   = JSON.parse(readFileSync(join(TARGET, 'fpc-FPC.json'), 'utf8'));

  // ── Diagnostic: show function types so we can spot old-format artifacts ──
  console.log('\n── Token artifact diagnostics ──');
  console.log('Has nonDispatchPublicFunctions:', Array.isArray(tokenArtifactRaw.nonDispatchPublicFunctions));
  console.log('transpiled:', tokenArtifactRaw.transpiled);
  for (const fn of (tokenArtifactRaw.functions ?? []).slice(0, 3)) {
    const attrs = fn.custom_attributes ?? [];
    console.log(`  fn "${fn.name}": functionType="${fn.functionType}" attrs=${JSON.stringify(attrs)} bytecodeLen=${fn.bytecode?.length ?? 0}`);
  }

  // ── Normalize to ContractArtifact (handles old nargo raw format) ──────────
  const { loadContractArtifact } = await import('@aztec/stdlib/abi');
  const tokenArtifact = loadContractArtifact(tokenArtifactRaw);
  const fpcArtifact   = loadContractArtifact(fpcArtifactRaw);

  // ── Deploy Token ──────────────────────────────────────────────────────────
  // Constructor: (admin: AztecAddress, name: str<31>, symbol: str<31>, decimals: u8)
  console.log('\nDeploying Token...');
  const tokenContract = await Contract.deploy(
    wallet,
    tokenArtifact,
    [adminAddress, 'TestToken', 'TST', 18n],
  ).send({ from: adminAddress });

  const tokenAddress = tokenContract.address;
  console.log('Token deployed at:', tokenAddress.toString());

  // ── Deploy FPC ────────────────────────────────────────────────────────────
  // Constructor: (operator: AztecAddress, accepted_asset: AztecAddress)
  console.log('\nDeploying FPC...');
  const fpcContract = await Contract.deploy(
    wallet,
    fpcArtifact,
    [operatorAddress, tokenAddress],
  ).send({ from: adminAddress });

  const fpcAddress = fpcContract.address;
  console.log('FPC deployed at:', fpcAddress.toString());

  // ── Print the constants to paste into profile-fpc.mjs ────────────────────
  console.log('\n=== Update profile-fpc.mjs with these addresses ===');
  console.log(`const TOKEN_ADDRESS = '${tokenAddress.toString()}';`);
  console.log(`const FPC_ADDRESS   = '${fpcAddress.toString()}';`);

  await pxe.stop?.();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

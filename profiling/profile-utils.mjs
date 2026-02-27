/**
 * Shared utilities for FPC gate count profiling scripts.
 */

import { AccountManager }              from '@aztec/aztec.js/wallet';
import { SchnorrAccountContract }      from '@aztec/accounts/schnorr';
import { Fr }                          from '@aztec/foundation/curves/bn254';
import { AztecAddress }                from '@aztec/stdlib/aztec-address';
import { computeInnerAuthWitHash }     from '@aztec/stdlib/auth-witness';
import { deriveSigningKey }            from '@aztec/stdlib/keys';
import { BaseWallet }                  from '@aztec/wallet-sdk/base-wallet';
import { readdirSync }                 from 'fs';
import { fileURLToPath }               from 'url';
import { dirname, join }               from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET    = join(__dirname, '../target');

// ── Artifact lookup ─────────────────────────────────────────────────────────
export function findArtifact(contractName) {
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

// ── fee_juice_to_asset: ceiling division (mirrors fee_math.nr) ──────────────
export function feeJuiceToAsset(feeJuice, rateNum, rateDen) {
  if (feeJuice === 0n) return 0n;
  const product = feeJuice * rateNum;
  return (product + rateDen - 1n) / rateDen;
}

// ── Minimal wallet backed by an embedded PXE ────────────────────────────────
export class SimpleWallet extends BaseWallet {
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

  async stop() {
    await this.pxe?.stop?.();
  }
}

// ── Sign a quote with the operator's Schnorr key ────────────────────────────
export async function signQuote(schnorr, operatorSigningKey, fpcAddress, tokenAddress, rateNum, rateDen, validUntil, userAddress, quoteDomainSep) {
  const quoteHash = await computeInnerAuthWitHash([
    new Fr(quoteDomainSep),
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

// ── Extract FPC-only execution steps ────────────────────────────────────────
// Profile trace has the shape: [A] [FPC] [B]
//   A = tx overhead (account entrypoint, kernel init, etc.)
//   FPC = fee payment entrypoint + all sub-calls it triggers
//   B = Noop app tx + finalization kernels
// We find the FPC block by its two boundaries:
//   start = first step matching the FPC contract name
//   end   = first Noop: step (the app tx we control)
export function extractFpcSteps(executionSteps, fpcContractName) {
  const fpcStart = executionSteps.findIndex(s =>
    (s.functionName ?? '').startsWith(fpcContractName + ':'),
  );
  if (fpcStart === -1) return [];

  let noopIdx = -1;
  for (let i = fpcStart; i < executionSteps.length; i++) {
    if ((executionSteps[i].functionName ?? '').startsWith('Noop:')) {
      noopIdx = i;
      break;
    }
  }
  if (noopIdx === -1) noopIdx = executionSteps.length;

  return executionSteps.slice(fpcStart, noopIdx);
}

// ── Pretty-print FPC-only gate count table ──────────────────────────────────
export function printFpcGateTable(title, executionSteps, fpcContractName) {
  const fpcSteps = extractFpcSteps(executionSteps, fpcContractName);
  console.log(`\n=== FPC Gate Count: ${title} ===\n`);
  const pad    = (s, n) => String(s).padEnd(n);
  const numFmt = n => n.toLocaleString();
  console.log(pad('Function', 60), pad('Own gates', 12), 'Subtotal');
  console.log('─'.repeat(88));
  let subtotal = 0;
  for (const step of fpcSteps) {
    subtotal += step.gateCount ?? 0;
    const name = step.functionName ?? '(unknown)';
    console.log(pad(name, 60), pad(numFmt(step.gateCount ?? 0), 12), numFmt(subtotal));
  }
  console.log('─'.repeat(88));
  console.log(pad('FPC TOTAL', 60), '', numFmt(subtotal));
  return subtotal;
}

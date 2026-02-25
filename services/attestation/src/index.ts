/**
 * Attestation Service — entry point
 *
 * Starts an HTTP server that signs confidential exchange-rate quotes for the FPC.
 * The operator private key is loaded from config (or env var override).
 *
 * Usage:
 *   cp config.example.yaml config.yaml
 *   # edit config.yaml
 *   node dist/index.js [--config path/to/config.yaml]
 */

import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { Fr } from '@aztec/aztec.js/fields';
import {
  getSchnorrAccountContractAddress,
  SchnorrAccountContract,
} from '@aztec/accounts/schnorr';
import { deriveSigningKey } from '@aztec/stdlib/keys';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const configPath = process.argv.find((_, i, a) => a[i - 1] === '--config') ?? 'config.yaml';

async function main() {
  const config = loadConfig(configPath);

  // ── Connect to Aztec node ────────────────────────────────────────────────────
  const node = createAztecNodeClient(config.aztec_node_url);

  // ── Derive operator address and signing key ───────────────────────────────────
  // TODO: In production, load the secret key from a KMS or HSM rather than
  //       reading it from a config file. The key should never be stored in
  //       plaintext — use environment injection or a secrets manager.
  const secretKey = Fr.fromHexString(config.operator_secret_key);
  const signingKey = deriveSigningKey(secretKey);
  const operatorAddress = await getSchnorrAccountContractAddress(secretKey, Fr.ZERO);
  const accountContract = new SchnorrAccountContract(signingKey);
  // getAuthWitnessProvider ignores the address — it only needs the signing key
  const authWitnessProvider = accountContract.getAuthWitnessProvider(undefined as any);

  // ── Fetch chain info for authwit signing ───────────────────────────────────────
  const [chainId, version] = await Promise.all([
    node.getChainId(),
    node.getVersion(),
  ]);
  const chainInfo = { chainId: new Fr(chainId), version: new Fr(version) };

  console.log(`Operator address:  ${operatorAddress}`);
  console.log(`FPC address:       ${config.fpc_address}`);
  console.log(`Accepted asset:    ${config.accepted_asset_name} (${config.accepted_asset_address})`);

  // ── Start HTTP server ────────────────────────────────────────────────────────
  const app = buildServer(config, authWitnessProvider, chainInfo);

  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`Attestation service listening on port ${config.port}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

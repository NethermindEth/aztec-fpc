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

import { createPXEClient, getSchnorrAccount } from '@aztec/aztec.js';
import { Fr } from '@aztec/aztec.js';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const configPath = process.argv.find((_, i, a) => a[i - 1] === '--config') ?? 'config.yaml';

async function main() {
  const config = loadConfig(configPath);

  // ── Connect to Aztec node ────────────────────────────────────────────────────
  const pxe = createPXEClient(config.aztec_node_url);

  // ── Load the operator wallet ──────────────────────────────────────────────────
  // TODO: In production, load the secret key from a KMS or HSM rather than
  //       reading it from a config file. The key should never be stored in
  //       plaintext — use environment injection or a secrets manager.
  const secretKey = Fr.fromHexString(config.operator_secret_key);
  const wallet = await getSchnorrAccount(pxe, secretKey, Fr.ZERO).getWallet();

  console.log(`Operator address:  ${wallet.getAddress()}`);
  console.log(`FPC address:       ${config.fpc_address}`);
  console.log(`Accepted asset:    ${config.accepted_asset_name} (${config.accepted_asset_address})`);

  // ── Start HTTP server ────────────────────────────────────────────────────────
  const app = buildServer(config, wallet);

  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`Attestation service listening on port ${config.port}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

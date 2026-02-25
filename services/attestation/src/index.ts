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

import {
  getSchnorrAccountContractAddress,
  SchnorrAccountContract,
} from "@aztec/accounts/schnorr";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { CompleteAddress } from "@aztec/stdlib/contract";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { createQuoteAuthwitSigner } from "./signer.js";

const configPath =
  process.argv.find((_, i, a) => a[i - 1] === "--config") ?? "config.yaml";

async function main() {
  const config = loadConfig(configPath);
  if (config.operator_secret_key_dual_source) {
    console.warn(
      "Both OPERATOR_SECRET_KEY and config.operator_secret_key are set; using OPERATOR_SECRET_KEY",
    );
  }
  if (config.operator_secret_key_source === "env") {
    console.log("Operator secret key source: env (OPERATOR_SECRET_KEY)");
  } else {
    console.warn(
      "Operator secret key source: config file (operator_secret_key); prefer OPERATOR_SECRET_KEY in non-dev environments",
    );
  }

  // ── Connect to Aztec node ────────────────────────────────────────────────────
  const node = createAztecNodeClient(config.aztec_node_url);

  // ── Derive operator address and signing key ───────────────────────────────────
  // TODO: In production, load the secret key from a KMS or HSM rather than
  //       reading it from a config file. The key should never be stored in
  //       plaintext — use environment injection or a secrets manager.
  const secretKey = Fr.fromHexString(config.operator_secret_key);
  const signingKey = deriveSigningKey(secretKey);
  const operatorAddress = await getSchnorrAccountContractAddress(
    secretKey,
    Fr.ZERO,
  );
  const accountContract = new SchnorrAccountContract(signingKey);
  // This API currently requires a CompleteAddress, but Schnorr provider creation
  // only depends on the signing key.
  const operatorCompleteAddress = await CompleteAddress.random();
  const authWitnessProvider = accountContract.getAuthWitnessProvider(
    operatorCompleteAddress,
  );

  // ── Fetch chain info for authwit signing ───────────────────────────────────────
  const [chainId, version] = await Promise.all([
    node.getChainId(),
    node.getVersion(),
  ]);
  const chainInfo = { chainId: new Fr(chainId), version: new Fr(version) };
  const quoteSigner = createQuoteAuthwitSigner(authWitnessProvider, chainInfo);

  console.log(`Operator address:  ${operatorAddress}`);
  console.log(`FPC address:       ${config.fpc_address}`);
  console.log(
    `Accepted asset:    ${config.accepted_asset_name} (${config.accepted_asset_address})`,
  );

  // ── Start HTTP server ────────────────────────────────────────────────────────
  const app = buildServer(config, quoteSigner);

  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`Attestation service listening on port ${config.port}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

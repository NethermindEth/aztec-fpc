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

import { getSchnorrAccountContractAddress } from "@aztec/accounts/schnorr";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { loadConfig } from "./config.js";
import {
  FpcImmutableVerificationError,
  verifyFpcImmutablesOnStartup,
} from "./fpc-immutables.js";
import { buildServer } from "./server.js";
import type { QuoteSchnorrSigner } from "./signer.js";

const configPath =
  process.argv.find((_, i, a) => a[i - 1] === "--config") ?? "config.yaml";

async function main() {
  const config = loadConfig(configPath);
  console.log(`Runtime profile: ${config.runtime_profile}`);

  if (config.operator_secret_key_dual_source) {
    console.warn(
      "Both OPERATOR_SECRET_KEY and config.operator_secret_key are set; using OPERATOR_SECRET_KEY",
    );
  }

  console.log(
    `Operator secret key provider: ${config.operator_secret_key_provider} (resolved source: ${config.operator_secret_key_source})`,
  );
  if (config.operator_secret_key_source === "config") {
    console.warn(
      "Operator secret key source: config file (operator_secret_key); this should only be used in non-production profiles",
    );
  }

  // ── Connect to Aztec node ────────────────────────────────────────────────────
  const node = createAztecNodeClient(config.aztec_node_url);

  // ── Derive operator address and signing key ───────────────────────────────────
  // Secret resolution happens in config loading. Production mode rejects
  // plaintext config secrets and supports env/external providers.
  const secretKey = Fr.fromHexString(config.operator_secret_key);
  const signingKey = deriveSigningKey(secretKey);
  const derivedOperatorAddress = await getSchnorrAccountContractAddress(
    secretKey,
    Fr.ZERO,
  );
  const operatorAddress = config.operator_address
    ? AztecAddress.fromString(config.operator_address)
    : derivedOperatorAddress;
  const fpcAddress = AztecAddress.fromString(config.fpc_address);
  const acceptedAssetAddress = AztecAddress.fromString(
    config.accepted_asset_address,
  );
  if (
    config.operator_address &&
    !operatorAddress.equals(derivedOperatorAddress)
  ) {
    console.warn(
      `[startup] operator_address override is set to ${operatorAddress.toString()} (signer-derived with salt=0 is ${derivedOperatorAddress.toString()})`,
    );
  }

  // ── Build Schnorr signer ────────────────────────────────────────────────────
  const schnorrSigner = new Schnorr();
  const operatorPubKey = await schnorrSigner.computePublicKey(signingKey);

  try {
    await verifyFpcImmutablesOnStartup(node, {
      fpcAddress,
      acceptedAsset: acceptedAssetAddress,
      operatorAddress,
      operatorPubkeyX: Fr.fromString(operatorPubKey.x.toString()),
      operatorPubkeyY: Fr.fromString(operatorPubKey.y.toString()),
    });
    console.log(
      `[startup] On-chain FPC immutables verified for ${fpcAddress.toString()}`,
    );
  } catch (error) {
    if (error instanceof FpcImmutableVerificationError) {
      console.error(error.message);
    }
    throw error;
  }

  const quoteSigner: QuoteSchnorrSigner = {
    async signQuoteHash(quoteHash: Fr): Promise<string> {
      const sig = await schnorrSigner.constructSignature(
        quoteHash.toBuffer(),
        signingKey,
      );
      return `0x${Buffer.from(sig.toBuffer()).toString("hex")}`;
    },
  };

  console.log(`Operator address:  ${operatorAddress.toString()}`);
  if (!operatorAddress.equals(derivedOperatorAddress)) {
    console.log(
      `Signer-derived operator address (salt=0): ${derivedOperatorAddress.toString()}`,
    );
  }
  console.log(`Operator pubkey x: ${operatorPubKey.x.toString()}`);
  console.log(`Operator pubkey y: ${operatorPubKey.y.toString()}`);
  console.log(`FPC address:       ${fpcAddress.toString()}`);
  console.log(
    `Accepted asset:    ${config.accepted_asset_name} (${acceptedAssetAddress.toString()})`,
  );

  // ── Start HTTP server ────────────────────────────────────────────────────────
  const app = buildServer(config, quoteSigner, {
    nowUnixSeconds: async () => {
      const latest = await node.getBlock("latest");
      if (latest) {
        return latest.timestamp;
      }
      return BigInt(Math.floor(Date.now() / 1000));
    },
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`Attestation service listening on port ${config.port}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

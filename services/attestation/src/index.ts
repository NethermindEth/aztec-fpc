import pino from "pino";

const pinoLogger = pino();

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
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { FileBackedAssetPolicyStore } from "./asset-policy-store.js";
import { loadConfig } from "./config.js";
import { FpcImmutableVerificationError, verifyFpcImmutablesOnStartup } from "./fpc-immutables.js";
import { OperatorTreasury } from "./operator-treasury.js";
import { buildServer } from "./server.js";
import type { QuoteSchnorrSigner } from "./signer.js";

const configPath = process.argv.find((_, i, a) => a[i - 1] === "--config") ?? "config.yaml";

async function main() {
  const config = loadConfig(configPath);
  pinoLogger.info(`Runtime profile: ${config.runtime_profile}`);

  if (config.operator_secret_key_dual_source) {
    pinoLogger.warn(
      "Both OPERATOR_SECRET_KEY and config.operator_secret_key are set; using OPERATOR_SECRET_KEY",
    );
  }

  pinoLogger.info(
    `Operator secret key provider: ${config.operator_secret_key_provider} (resolved source: ${config.operator_secret_key_source})`,
  );
  if (config.operator_secret_key_source === "config") {
    pinoLogger.warn(
      "Operator secret key source: config file (operator_secret_key); this should only be used in non-production profiles",
    );
  }

  const node = createAztecNodeClient(config.aztec_node_url);
  await waitForNode(node);
  const assetPolicyStore = await FileBackedAssetPolicyStore.create(config);
  const treasury = new OperatorTreasury(config);

  // Secret resolution happens in config loading. Production mode rejects
  // plaintext config secrets and supports env/external providers.
  const secretKey = Fr.fromHexString(config.operator_secret_key);
  const signingKey = deriveSigningKey(secretKey);
  const derivedOperatorAddress = await getSchnorrAccountContractAddress(secretKey, Fr.ZERO);
  const operatorAddress = config.operator_address
    ? AztecAddress.fromString(config.operator_address)
    : derivedOperatorAddress;
  const fpcAddress = AztecAddress.fromString(config.fpc_address);
  const acceptedAssetAddress = AztecAddress.fromString(config.accepted_asset_address);
  if (config.operator_address && !operatorAddress.equals(derivedOperatorAddress)) {
    pinoLogger.warn(
      `[startup] operator_address override is set to ${operatorAddress.toString()} (signer-derived with salt=0 is ${derivedOperatorAddress.toString()})`,
    );
  }

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
    pinoLogger.info(`[startup] On-chain FPC immutables verified for ${fpcAddress.toString()}`);
  } catch (error) {
    if (error instanceof FpcImmutableVerificationError) {
      pinoLogger.error(error.message);
    }
    throw error;
  }

  const quoteSigner: QuoteSchnorrSigner = {
    async signQuoteHash(quoteHash: Fr): Promise<string> {
      const sig = await schnorrSigner.constructSignature(quoteHash.toBuffer(), signingKey);
      return `0x${Buffer.from(sig.toBuffer()).toString("hex")}`;
    },
  };

  pinoLogger.info(`Operator address:  ${operatorAddress.toString()}`);
  if (!operatorAddress.equals(derivedOperatorAddress)) {
    pinoLogger.info(
      `Signer-derived operator address (salt=0): ${derivedOperatorAddress.toString()}`,
    );
  }
  pinoLogger.info(`Operator pubkey x: ${operatorPubKey.x.toString()}`);
  pinoLogger.info(`Operator pubkey y: ${operatorPubKey.y.toString()}`);
  pinoLogger.info(`FPC address:       ${fpcAddress.toString()}`);
  pinoLogger.info(
    `Default asset:     ${config.accepted_asset_name} (${acceptedAssetAddress.toString()})`,
  );
  pinoLogger.info(`Supported assets:  ${assetPolicyStore.getAll().length}`);
  if (config.admin_auth.enabled) {
    pinoLogger.info("Admin API enabled (authentication header configured)");
  } else {
    pinoLogger.warn(
      "Admin API disabled: configure admin_api_key to enable asset management and sweeps",
    );
  }

  const app = await buildServer(config, quoteSigner, {
    assetPolicyStore,
    nowUnixSeconds: async () => {
      const latest = await node.getBlock("latest");
      if (latest) {
        return latest.timestamp;
      }
      return BigInt(Math.floor(Date.now() / 1000));
    },
    treasury,
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  pinoLogger.info(`Attestation service listening on port ${config.port}`);
}

main().catch((err) => {
  pinoLogger.error({ err }, "Fatal error:");
  process.exit(1);
});

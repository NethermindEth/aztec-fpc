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
import { type Config, loadConfig } from "./config.js";
import { FpcImmutableVerificationError, verifyFpcImmutablesOnStartup } from "./fpc-immutables.js";
import { OperatorTreasury } from "./operator-treasury.js";
import { buildServer } from "./server.js";
import type { QuoteSchnorrSigner } from "./signer.js";

const configPath = process.argv.find((_, i, a) => a[i - 1] === "--config") ?? "config.yaml";

interface StartupIdentity {
  acceptedAssetAddress: AztecAddress;
  derivedOperatorAddress: AztecAddress;
  fpcAddress: AztecAddress;
  operatorAddress: AztecAddress;
  operatorPubKey: Awaited<ReturnType<Schnorr["computePublicKey"]>>;
  quoteSigner: QuoteSchnorrSigner;
}

function logSecretKeyConfiguration(config: Config): void {
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
}

async function createStartupIdentity(config: Config): Promise<StartupIdentity> {
  const secretKey = Fr.fromHexString(config.operator_secret_key);
  const signingKey = deriveSigningKey(secretKey);
  const derivedOperatorAddress = await getSchnorrAccountContractAddress(secretKey, Fr.ZERO);
  const operatorAddress = config.operator_address
    ? AztecAddress.fromString(config.operator_address)
    : derivedOperatorAddress;
  const fpcAddress = AztecAddress.fromString(config.fpc_address);
  const acceptedAssetAddress = AztecAddress.fromString(config.accepted_asset_address);
  const schnorrSigner = new Schnorr();
  const operatorPubKey = await schnorrSigner.computePublicKey(signingKey);
  const quoteSigner: QuoteSchnorrSigner = {
    async signQuoteHash(quoteHash: Fr): Promise<string> {
      const sig = await schnorrSigner.constructSignature(quoteHash.toBuffer(), signingKey);
      return `0x${Buffer.from(sig.toBuffer()).toString("hex")}`;
    },
  };

  return {
    acceptedAssetAddress,
    derivedOperatorAddress,
    fpcAddress,
    operatorAddress,
    operatorPubKey,
    quoteSigner,
  };
}

function logOperatorAddressOverride(identity: StartupIdentity, config: Config): void {
  if (
    config.operator_address &&
    !identity.operatorAddress.equals(identity.derivedOperatorAddress)
  ) {
    pinoLogger.warn(
      `[startup] operator_address override is set to ${identity.operatorAddress.toString()} (signer-derived with salt=0 is ${identity.derivedOperatorAddress.toString()})`,
    );
  }
}

async function verifyStartupImmutables(
  node: ReturnType<typeof createAztecNodeClient>,
  identity: StartupIdentity,
): Promise<void> {
  try {
    await verifyFpcImmutablesOnStartup(node, {
      fpcAddress: identity.fpcAddress,
      acceptedAsset: identity.acceptedAssetAddress,
      operatorAddress: identity.operatorAddress,
      operatorPubkeyX: Fr.fromString(identity.operatorPubKey.x.toString()),
      operatorPubkeyY: Fr.fromString(identity.operatorPubKey.y.toString()),
    });
    pinoLogger.info(
      `[startup] On-chain FPC immutables verified for ${identity.fpcAddress.toString()}`,
    );
  } catch (error) {
    if (error instanceof FpcImmutableVerificationError) {
      pinoLogger.error(error.message);
    }
    throw error;
  }
}

function logStartupSummary(
  config: Config,
  identity: StartupIdentity,
  supportedAssetCount: number,
): void {
  pinoLogger.info(`Operator address:  ${identity.operatorAddress.toString()}`);
  if (!identity.operatorAddress.equals(identity.derivedOperatorAddress)) {
    pinoLogger.info(
      `Signer-derived operator address (salt=0): ${identity.derivedOperatorAddress.toString()}`,
    );
  }
  pinoLogger.info(`Operator pubkey x: ${identity.operatorPubKey.x.toString()}`);
  pinoLogger.info(`Operator pubkey y: ${identity.operatorPubKey.y.toString()}`);
  pinoLogger.info(`FPC address:       ${identity.fpcAddress.toString()}`);
  pinoLogger.info(
    `Default asset:     ${config.accepted_asset_name} (${identity.acceptedAssetAddress.toString()})`,
  );
  pinoLogger.info(`Supported assets:  ${supportedAssetCount}`);
  if (config.admin_auth.enabled) {
    pinoLogger.info("Admin API enabled (authentication header configured)");
    return;
  }
  pinoLogger.warn(
    "Admin API disabled: configure admin_api_key to enable asset management and sweeps",
  );
}

async function main() {
  const config = loadConfig(configPath);
  logSecretKeyConfiguration(config);

  const node = createAztecNodeClient(config.aztec_node_url);
  await waitForNode(node);
  const assetPolicyStore = await FileBackedAssetPolicyStore.create(config);
  const treasury = new OperatorTreasury(config);
  const identity = await createStartupIdentity(config);
  logOperatorAddressOverride(identity, config);
  await verifyStartupImmutables(node, identity);
  logStartupSummary(config, identity, assetPolicyStore.getAll().length);

  const app = buildServer(config, identity.quoteSigner, {
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

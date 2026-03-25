import { existsSync } from "node:fs";
import path from "node:path";
import { getSchnorrAccountContractAddress } from "@aztec/accounts/schnorr";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract, type DeployOptions } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";

import { deriveKeys, deriveSigningKey } from "@aztec/stdlib/keys";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import pino from "pino";
import { deployContract, loadArtifact, REQUIRED_ARTIFACTS } from "./deploy-utils.js";
import { type DeployManifest, writeDeployManifest } from "./manifest.js";

const pinoLogger = pino();

type CliArgs = {
  nodeUrl: string;
  sponsoredFpcAddress: string | null;
  deployerSecretKey: string | null;
  deployerSecretKeyRef: string | null;
  operatorSecretKey: string | null;
  operatorSecretKeyRef: string | null;
  operator: string | null;
  out: string;
  proverEnabled: boolean;
  preflightOnly: boolean;
};

type CliParseResult =
  | {
      kind: "help";
    }
  | {
      kind: "args";
      args: CliArgs;
    };

type OperatorIdentity = {
  address: string;
  pubkeyX: string;
  pubkeyY: string;
};

const AZTEC_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ZERO_AZTEC_ADDRESS_PATTERN = /^0x0{64}$/i;
const HEX_32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const DEVNET_DEFAULT_NODE_URL = "https://v4-devnet-2.aztec-labs.com/";
const DEVNET_DEFAULT_DATA_DIR = "./deployments";
const DEVNET_DEFAULT_TEST_KEY =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

function usage(): string {
  return [
    "Usage:",
    "  bun run contract-deployment/dist/index.js [options]",
    "",
    "All arguments are optional. CLI args take precedence over env vars.",
    "",
    "Credentials (prefer env vars to avoid leaking secrets in shell history):",
    "  --deployer-secret-key <hex32>   Deployer secret key (default: devnet test key) [env: FPC_DEPLOYER_SECRET_KEY]",
    "  --deployer-secret-key-ref <ref> Deployer key reference [env: FPC_DEPLOYER_SECRET_KEY_REF]",
    "  --operator-secret-key <hex32>    Operator secret key (default: deployer key) [env: FPC_OPERATOR_SECRET_KEY]",
    "  --operator-secret-key-ref <ref>  Operator key reference [env: FPC_OPERATOR_SECRET_KEY_REF]",
    "",
    "Network:",
    `  --node-url <url>                 Aztec node URL (default: ${DEVNET_DEFAULT_NODE_URL}) [env: AZTEC_NODE_URL]`,
    "",
    "Options:",
    "  --operator <aztec_address>       Operator address (default: derived from key) [env: FPC_OPERATOR]",
    "  --sponsored-fpc-address <addr>   Use sponsored FPC payment mode [env: FPC_SPONSORED_FPC_ADDRESS]",
    "  --pxe-prover-enabled <bool>      Enable PXE prover (default: true) [env: PXE_PROVER_ENABLED]",
    "  --preflight-only                 Run checks only, do not deploy [env: FPC_PREFLIGHT_ONLY=1]",
    "",
    "Outputs:",
    `  --data-dir <dir>                 Data directory for artifacts (default: ${DEVNET_DEFAULT_DATA_DIR}) [env: FPC_DATA_DIR]`,
    "  --out <path.json>                Output manifest path (default: $FPC_DATA_DIR/manifest.json) [env: FPC_OUT]",
    "",
    "  --help, -h                       Show this help",
    "",
    "Notes:",
    "  - --sponsored-fpc-address determines payment mode: if provided, contracts are deployed with",
    "    sponsored FPC payment; if absent, deployer account uses --register-only and",
    "    contracts are deployed with fee juice payment.",
    "  - --operator is optional; if omitted, the operator address is derived from --operator-secret-key.",
    "    If both are provided, they must match.",
  ].join("\n");
}

function nextArg(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliError(`Missing value for ${flag}`);
  }
  return value;
}

function parseNonEmptyString(value: string, fieldName: string): string {
  if (value.trim().length === 0) {
    throw new CliError(`Invalid ${fieldName}: expected non-empty string`);
  }
  return value;
}

function parseHttpUrl(value: string, fieldName: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new CliError(`Invalid ${fieldName}: expected http(s) URL, got "${value}"`);
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(`Invalid ${fieldName}: expected URL, got "${value}"`);
  }
}

function parseAztecAddress(value: string, fieldName: string): string {
  if (!AZTEC_ADDRESS_PATTERN.test(value)) {
    throw new CliError(`Invalid ${fieldName}: expected 32-byte 0x-prefixed Aztec address`);
  }
  if (ZERO_AZTEC_ADDRESS_PATTERN.test(value)) {
    throw new CliError(`Invalid ${fieldName}: zero address is not allowed`);
  }
  return value;
}

function parseBooleanFlag(value: string, fieldName: string): boolean {
  const lower = value.toLowerCase();
  if (lower === "1" || lower === "true") return true;
  if (lower === "0" || lower === "false") return false;
  throw new CliError(`Invalid ${fieldName}: expected "true", "false", "1", or "0", got "${value}"`);
}

function parseHex32(value: string, fieldName: string): string {
  if (!HEX_32_PATTERN.test(value)) {
    throw new CliError(`Invalid ${fieldName}: expected 32-byte 0x-prefixed hex value`);
  }
  return value;
}

function parseSecretPair(
  rawValue: string | null,
  rawRef: string | null,
  valueFlag: string,
  refFlag: string,
): { value: string | null; ref: string | null } {
  if (rawValue && rawRef) {
    throw new CliError(`Ambiguous key input: provide only one of ${valueFlag} or ${refFlag}`);
  }
  return {
    value: rawValue,
    ref: rawRef,
  };
}

function parseCliArgs(argv: string[]): CliParseResult {
  let nodeUrl: string = process.env.AZTEC_NODE_URL ?? DEVNET_DEFAULT_NODE_URL;
  let sponsoredFpcAddress: string | null = process.env.FPC_SPONSORED_FPC_ADDRESS ?? null;
  let deployerSecretKey: string | null = process.env.FPC_DEPLOYER_SECRET_KEY ?? null;
  let deployerSecretKeyRef: string | null = process.env.FPC_DEPLOYER_SECRET_KEY_REF ?? null;
  let operatorSecretKey: string | null = process.env.FPC_OPERATOR_SECRET_KEY ?? null;
  let operatorSecretKeyRef: string | null = process.env.FPC_OPERATOR_SECRET_KEY_REF ?? null;
  let operator: string | null = process.env.FPC_OPERATOR ?? null;
  let dataDir: string = process.env.FPC_DATA_DIR ?? DEVNET_DEFAULT_DATA_DIR;
  let outExplicit = !!process.env.FPC_OUT;
  let out: string = process.env.FPC_OUT ?? path.join(dataDir, "manifest.json");
  let proverEnabled = process.env.PXE_PROVER_ENABLED
    ? parseBooleanFlag(process.env.PXE_PROVER_ENABLED, "PXE_PROVER_ENABLED")
    : true;
  let preflightOnly = process.env.FPC_PREFLIGHT_ONLY === "1";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--node-url":
        nodeUrl = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--sponsored-fpc-address":
        sponsoredFpcAddress = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--deployer-secret-key":
        deployerSecretKey = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--deployer-secret-key-ref":
        deployerSecretKeyRef = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--operator-secret-key":
        operatorSecretKey = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--operator-secret-key-ref":
        operatorSecretKeyRef = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--operator":
        operator = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--data-dir":
        dataDir = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--out":
        out = nextArg(argv, i, arg);
        outExplicit = true;
        i += 1;
        break;
      case "--pxe-prover-enabled":
        proverEnabled = parseBooleanFlag(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--preflight-only":
        preflightOnly = true;
        break;
      case "--help":
      case "-h":
        pinoLogger.info(usage());
        return { kind: "help" };
      default:
        throw new CliError(`Unknown argument: ${arg}`);
    }
  }

  if (!outExplicit) {
    out = path.join(dataDir, "manifest.json");
  }

  const parsedDeployer = parseSecretPair(
    deployerSecretKey,
    deployerSecretKeyRef,
    "--deployer-secret-key",
    "--deployer-secret-key-ref",
  );
  const parsedOperatorSecret = parseSecretPair(
    operatorSecretKey,
    operatorSecretKeyRef,
    "--operator-secret-key",
    "--operator-secret-key-ref",
  );

  if (!parsedDeployer.value && !parsedDeployer.ref) {
    pinoLogger.warn("WARN: No deployer key provided. Using default devnet test key.");
    parsedDeployer.value = DEVNET_DEFAULT_TEST_KEY;
  }
  if (!parsedOperatorSecret.value && !parsedOperatorSecret.ref) {
    parsedOperatorSecret.value = parsedDeployer.value ?? DEVNET_DEFAULT_TEST_KEY;
    pinoLogger.warn(
      "WARN: No operator key provided. Using deployer key as operator key for devnet.",
    );
  }

  const parsedNodeUrl = parseHttpUrl(nodeUrl, "--node-url");
  const parsedOperator = operator !== null ? parseAztecAddress(operator, "--operator") : null;

  return {
    kind: "args",
    args: {
      nodeUrl: parsedNodeUrl,
      sponsoredFpcAddress: sponsoredFpcAddress
        ? parseAztecAddress(sponsoredFpcAddress, "--sponsored-fpc-address")
        : null,
      deployerSecretKey: parsedDeployer.value
        ? parseHex32(parsedDeployer.value, "--deployer-secret-key")
        : null,
      deployerSecretKeyRef: parsedDeployer.ref
        ? parseNonEmptyString(parsedDeployer.ref, "--deployer-secret-key-ref")
        : null,
      operatorSecretKey: parsedOperatorSecret.value
        ? parseHex32(parsedOperatorSecret.value, "--operator-secret-key")
        : null,
      operatorSecretKeyRef: parsedOperatorSecret.ref
        ? parseNonEmptyString(parsedOperatorSecret.ref, "--operator-secret-key-ref")
        : null,
      operator: parsedOperator,
      out,
      proverEnabled,
      preflightOnly,
    },
  };
}

async function deriveOperatorIdentity(operatorSecretKey: string): Promise<OperatorIdentity> {
  const secretKeyFr = Fr.fromHexString(operatorSecretKey);
  const signingKey = deriveSigningKey(secretKeyFr);
  const schnorr = new Schnorr();
  const pubkey = await schnorr.computePublicKey(signingKey);
  const address = await getSchnorrAccountContractAddress(secretKeyFr, Fr.ZERO);

  return {
    address: address.toString(),
    pubkeyX: pubkey.x.toString(),
    pubkeyY: pubkey.y.toString(),
  };
}

function assertRequiredArtifactsExistForDevnet(fpcArtifactPath: string): void {
  if (!existsSync(fpcArtifactPath)) {
    throw new CliError(
      `Artifact preflight failed: FPC artifact not found at ${fpcArtifactPath}.\nRun 'aztec compile --workspace --force' and retry.`,
    );
  }
}

async function main(): Promise<void> {
  const parseResult = parseCliArgs(process.argv.slice(2));
  if (parseResult.kind === "help") {
    return;
  }
  const args = parseResult.args;
  const fpcArtifactPath = REQUIRED_ARTIFACTS.fpc;

  pinoLogger.info("[deploy-fpc-devnet] starting preflight checks");
  pinoLogger.info(`[deploy-fpc-devnet] node_url=${args.nodeUrl}`);
  pinoLogger.info(
    `[deploy-fpc-devnet] sponsored_fpc_address=${args.sponsoredFpcAddress ?? "<none — fee juice payment>"}`,
  );
  pinoLogger.info(`[deploy-fpc-devnet] fpc_artifact=${fpcArtifactPath}`);
  pinoLogger.info(`[deploy-fpc-devnet] output_manifest_path=${path.resolve(args.out)}`);

  assertRequiredArtifactsExistForDevnet(fpcArtifactPath);
  pinoLogger.info("[deploy-fpc-devnet] artifact preflight passed");

  const node = createAztecNodeClient(args.nodeUrl);
  await waitForNode(node);
  const nodeInfo = await node.getNodeInfo();
  pinoLogger.info(
    `[deploy-fpc-devnet] node preflight passed. node_version=${nodeInfo.nodeVersion} l1_chain_id=${nodeInfo.l1ChainId} rollup_version=${nodeInfo.rollupVersion}`,
  );

  if (args.sponsoredFpcAddress) {
    pinoLogger.info(
      `[deploy-fpc-devnet] using sponsored FPC payment. address=${args.sponsoredFpcAddress}`,
    );
  } else {
    pinoLogger.info(
      "[deploy-fpc-devnet] no sponsored FPC address provided; using fee juice payment mode",
    );
  }

  if (!args.deployerSecretKey) {
    throw new CliError(
      "Contract deployment requires --deployer-secret-key (inline key). The provided --deployer-secret-key-ref cannot be resolved by this script yet.",
    );
  }

  if (!args.operatorSecretKey) {
    if (args.preflightOnly) {
      pinoLogger.info(
        "[deploy-fpc-devnet] operator secret key reference detected; pubkey derivation is deferred in preflight-only mode",
      );
      pinoLogger.info("[deploy-fpc-devnet] step 3 preflight checks passed");
      pinoLogger.info("[deploy-fpc-devnet] preflight-only requested; exiting");
      return;
    }
    throw new CliError(
      "Operator pubkey derivation requires --operator-secret-key. The provided --operator-secret-key-ref cannot be resolved by this script yet.",
    );
  }

  const operatorIdentity = await deriveOperatorIdentity(args.operatorSecretKey);
  if (args.operator && args.operator.toLowerCase() !== operatorIdentity.address.toLowerCase()) {
    throw new CliError(
      `--operator ${args.operator} does not match address derived from --operator-secret-key: ${operatorIdentity.address}. Remove --operator to use the derived address, or provide the matching secret key.`,
    );
  }
  pinoLogger.info(
    `[deploy-fpc-devnet] operator identity derived. address=${operatorIdentity.address} pubkey_x=${operatorIdentity.pubkeyX} pubkey_y=${operatorIdentity.pubkeyY}`,
  );
  pinoLogger.info("[deploy-fpc-devnet] step 3 account resolution checks passed");

  if (args.preflightOnly) {
    pinoLogger.info("[deploy-fpc-devnet] preflight-only requested; exiting");
    return;
  }

  // --- JS API wallet setup for contract deployments ---
  const wallet = await EmbeddedWallet.create(node, {
    pxeConfig: { proverEnabled: args.proverEnabled, syncChainTip: "checkpointed" },
  });

  const deployerSecretFr = Fr.fromHexString(args.deployerSecretKey);
  const deployerSigningKey = deriveSigningKey(deployerSecretFr);
  const deployerAccount = await wallet.createSchnorrAccount(
    deployerSecretFr,
    Fr.ZERO,
    deployerSigningKey,
  );
  const deployerAddress = deployerAccount.address;
  const operatorAddress = AztecAddress.fromString(operatorIdentity.address);

  if (!operatorAddress.equals(deployerAddress)) {
    const operatorSecretFr = Fr.fromHexString(args.operatorSecretKey);
    const operatorSigningKey = deriveSigningKey(operatorSecretFr);
    await wallet.createSchnorrAccount(operatorSecretFr, Fr.ZERO, operatorSigningKey);
  }

  pinoLogger.info(
    `[deploy-fpc-devnet] embedded wallet ready. deployer=${deployerAddress.toString()}`,
  );

  let deployOpts: DeployOptions;
  if (args.sponsoredFpcAddress) {
    const { SponsoredFeePaymentMethod } = await import("@aztec/aztec.js/fee");
    deployOpts = {
      from: deployerAddress,
      fee: {
        paymentMethod: new SponsoredFeePaymentMethod(
          AztecAddress.fromString(args.sponsoredFpcAddress),
        ),
      },
    };
  } else {
    deployOpts = { from: deployerAddress };
  }

  const fpcArtifact = loadArtifact(fpcArtifactPath);
  pinoLogger.info(
    `[deploy-fpc-devnet] deploying ${fpcArtifact.name} contract from ${fpcArtifactPath}`,
  );

  const { publicKeys: fpcPublicKeys } = await deriveKeys(Fr.ZERO);
  const fpcDeployMethod = Contract.deployWithPublicKeys(fpcPublicKeys, wallet, fpcArtifact, [
    operatorAddress,
    operatorIdentity.pubkeyX,
    operatorIdentity.pubkeyY,
  ]);
  const fpcAddress = (await fpcDeployMethod.getInstance()).address.toString();
  const fpcDeployTxHash = await deployContract(wallet, fpcArtifact, fpcDeployMethod, deployOpts);
  pinoLogger.info(`[deploy-fpc-devnet] fpc deployed. address=${fpcAddress}`);

  const feeAssetHandlerAddress = nodeInfo.l1ContractAddresses.feeAssetHandlerAddress;
  if (!feeAssetHandlerAddress) {
    throw new CliError("node_getNodeInfo.l1ContractAddresses.feeAssetHandlerAddress is missing");
  }

  const manifest: DeployManifest = {
    status: "deploy_ok",
    generated_at: new Date().toISOString(),
    network: {
      node_url: args.nodeUrl,
      node_version: nodeInfo.nodeVersion,
      l1_chain_id: nodeInfo.l1ChainId,
      rollup_version: nodeInfo.rollupVersion,
    },
    aztec_required_addresses: {
      ...(args.sponsoredFpcAddress
        ? { sponsored_fpc_address: AztecAddress.fromString(args.sponsoredFpcAddress) }
        : {}),
    },
    deployer_address: deployerAddress,
    contracts: {
      fpc: AztecAddress.fromString(fpcAddress),
    },
    operator: {
      address: AztecAddress.fromString(operatorIdentity.address),
      pubkey_x: Fr.fromHexString(operatorIdentity.pubkeyX),
      pubkey_y: Fr.fromHexString(operatorIdentity.pubkeyY),
    },
    tx_hashes: {
      fpc_deploy: fpcDeployTxHash,
    },
  };
  writeDeployManifest(args.out, manifest);

  pinoLogger.info(
    `[deploy-fpc-devnet] deployment completed. wrote manifest to ${path.resolve(args.out)}`,
  );
  pinoLogger.info(
    `[deploy-fpc-devnet] output contracts: fpc=${manifest.contracts.fpc} variant=${fpcArtifact.name}`,
  );

  process.exit(0);
}

main().catch((error) => {
  if (error instanceof CliError) {
    pinoLogger.error(`[deploy-fpc-devnet] ERROR: ${error.message}`);
    pinoLogger.error("");
    pinoLogger.error(usage());
  } else {
    pinoLogger.error(
      `[deploy-fpc-devnet] Unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
  process.exit(1);
});

import { readFileSync } from "node:fs";
import path from "node:path";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";

import { EmbeddedWallet } from "@aztec/wallets/embedded";
import pino from "pino";
import YAML from "yaml";
import { z } from "zod";
import { aztecAddress } from "./manifest-types.js";
import { deployTestToken, type TestTokenDeployDeps } from "./test-token.js";

const pinoLogger = pino();
const LABEL = "configure-token";

// ── Schemas ──────────────────────────────────────────────────────────

const tokenConfigSchema = z.object({
  name: z.string().min(1, "token name must be non-empty"),
  symbol: z.string().min(1, "token symbol must be non-empty"),
  decimals: z.number().int().min(0).max(77).default(18),
  address: aztecAddress.optional(),
  market_rate_num: z.number().positive("market_rate_num must be positive"),
  market_rate_den: z.number().positive("market_rate_den must be positive"),
  fee_bips: z.number().int().min(0).max(10000, "fee_bips must be 0–10000"),
});

const masterConfigTokensSchema = z.object({
  tokens: z.array(tokenConfigSchema).min(1, "at least one token is required"),
});

type TokenConfig = z.infer<typeof tokenConfigSchema>;

type RegistrationCtx = {
  attestationUrl: string;
  adminApiKey: string;
  healthTimeoutMs: number;
};

type CliArgs = {
  configPath: string;
  registration: RegistrationCtx | null;
};

// ── CLI parsing ──────────────────────────────────────────────────────

function usage(): string {
  return [
    "Usage:",
    "  configure-token [options]",
    "",
    "Reads the master config (tokens section) and for each token:",
    "  1. Deploys a test token if no address is specified",
    "  2. Registers the token with the attestation server via admin API",
    "",
    "Options:",
    "  --attestation-url <url>      Attestation server URL [env: FPC_ATTESTATION_URL]",
    "  --admin-api-key <key>        Admin API key [env: ADMIN_API_KEY]",
    "  --config <path>              Master config path [env: FPC_MASTER_CONFIG, default: $FPC_DATA_DIR/fpc-config.yaml]",
    "  --health-timeout-ms <ms>     Attestation health check timeout (default: 30000) [env: FPC_HEALTH_TIMEOUT_MS]",
    "  --skip-registration          Deploy tokens only, skip attestation registration [env: FPC_SKIP_REGISTRATION=1|true]",
    "  --help, -h                   Show this help",
  ].join("\n");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value.trim();
}

function parseCliArgs(argv: string[]): CliArgs | null {
  const dataDir = process.env.FPC_DATA_DIR ?? "./deployments";
  let attestationUrl = process.env.FPC_ATTESTATION_URL ?? "";
  let adminApiKey = process.env.ADMIN_API_KEY ?? "";
  let configPath = process.env.FPC_MASTER_CONFIG ?? path.join(dataDir, "fpc-config.yaml");
  let healthTimeoutMs = Number(process.env.FPC_HEALTH_TIMEOUT_MS ?? "30000");
  let skipRegistration =
    process.env.FPC_SKIP_REGISTRATION === "1" || process.env.FPC_SKIP_REGISTRATION === "true";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--attestation-url":
        attestationUrl = argv[++i] ?? "";
        break;
      case "--admin-api-key":
        adminApiKey = argv[++i] ?? "";
        break;
      case "--config":
        configPath = argv[++i] ?? "";
        break;
      case "--health-timeout-ms":
        healthTimeoutMs = Number(argv[++i]);
        break;
      case "--skip-registration":
        skipRegistration = true;
        break;
      case "--help":
      case "-h":
        pinoLogger.info(usage());
        return null;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  let registration: RegistrationCtx | null = null;
  if (!skipRegistration) {
    if (!attestationUrl) throw new Error("--attestation-url or FPC_ATTESTATION_URL is required");
    if (!adminApiKey) throw new Error("--admin-api-key or ADMIN_API_KEY is required");
    registration = {
      attestationUrl: attestationUrl.replace(/\/$/, ""),
      adminApiKey,
      healthTimeoutMs,
    };
  }

  return {
    configPath: path.resolve(configPath),
    registration,
  };
}

// ── Config reading ───────────────────────────────────────────────────

function readTokenConfigs(configPath: string): TokenConfig[] {
  const raw = readFileSync(configPath, "utf8");
  const parsed = YAML.parse(raw);
  const result = masterConfigTokensSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid token config in ${configPath}:\n${issues}`);
  }
  return result.data.tokens;
}

// ── Attestation API ──────────────────────────────────────────────────

async function waitForAttestationHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pollMs = 2000;
  pinoLogger.info(`[${LABEL}] waiting for attestation health at ${baseUrl}/health`);

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        pinoLogger.info(`[${LABEL}] attestation server is healthy`);
        return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Attestation server not healthy after ${timeoutMs}ms`);
}

async function registerAssetPolicy(
  baseUrl: string,
  adminApiKey: string,
  tokenAddress: AztecAddress,
  policy: TokenConfig,
): Promise<void> {
  const url = `${baseUrl}/admin/asset-policies/${tokenAddress}`;
  pinoLogger.info(`[${LABEL}] PUT ${url}`);

  const { address: _, ...body } = policy;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-admin-api-key": adminApiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to register asset policy (${res.status}): ${body}`);
  }

  pinoLogger.info(`[${LABEL}] registered asset: address=${tokenAddress} name=${policy.name}`);
}

// ── Test token deployment ────────────────────────────────────────────

async function initDeployDeps(): Promise<TestTokenDeployDeps> {
  const nodeUrl = process.env.AZTEC_NODE_URL;
  if (!nodeUrl) throw new Error("AZTEC_NODE_URL is required to deploy test tokens");

  const l1RpcUrl = requireEnv("L1_RPC_URL");
  const l1DeployerKey = requireEnv("FPC_L1_DEPLOYER_KEY");
  const deployerSecretKey = requireEnv("FPC_DEPLOYER_SECRET_KEY");
  const proverEnabled =
    process.env.PXE_PROVER_ENABLED !== "0" && process.env.PXE_PROVER_ENABLED !== "false";

  const node = createAztecNodeClient(nodeUrl);
  await waitForNode(node);
  const nodeInfo = await node.getNodeInfo();

  const wallet = await EmbeddedWallet.create(node, {
    pxeConfig: { proverEnabled, syncChainTip: "checkpointed" },
  });

  const deployerSecretFr = Fr.fromHexString(deployerSecretKey);
  const deployerAccount = await wallet.createSchnorrAccount(deployerSecretFr, Fr.ZERO);
  const deployerAddress = deployerAccount.address;

  return {
    l1DeployerKey,
    l1RpcUrl,
    l1ChainId: nodeInfo.l1ChainId,
    l1RegistryAddress: nodeInfo.l1ContractAddresses.registryAddress.toString(),
    wallet,
    node,
    operatorAddress: deployerAddress,
    deployOpts: { from: deployerAddress },
  };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args) return;

  const tokens = readTokenConfigs(args.configPath);
  pinoLogger.info(`[${LABEL}] loaded ${tokens.length} token(s) from ${args.configPath}`);

  // Phase 1: resolve / deploy all tokens (no attestation dependency)
  const dataDir = process.env.FPC_DATA_DIR ?? "./deployments";
  let deployDeps: TestTokenDeployDeps | undefined;
  const resolved: { address: AztecAddress; token: TokenConfig }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let address: AztecAddress;
    if (token.address) {
      address = token.address;
      pinoLogger.info(`[${LABEL}] token[${i}] "${token.name}" — using existing address ${address}`);
    } else {
      deployDeps ??= await initDeployDeps();
      const outPath = path.join(dataDir, "tokens", `${token.name}.json`);
      const manifest = await deployTestToken(deployDeps, {
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        outPath,
      });
      address = manifest.contracts.token;
      pinoLogger.info(`[${LABEL}] token[${i}] "${token.name}" — deployed test token at ${address}`);
    }
    resolved.push({ address, token });
  }

  // Phase 2: wait for attestation and register all tokens
  if (args.registration) {
    await waitForAttestationHealth(
      args.registration.attestationUrl,
      args.registration.healthTimeoutMs,
    );
    for (const { address, token } of resolved) {
      await registerAssetPolicy(
        args.registration.attestationUrl,
        args.registration.adminApiKey,
        address,
        token,
      );
    }
  }

  pinoLogger.info(`[${LABEL}] done — ${tokens.length} token(s) configured`);
  process.exit(0);
}

main().catch((error) => {
  pinoLogger.error(
    `[${LABEL}] error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});

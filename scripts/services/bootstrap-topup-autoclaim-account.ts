import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";

const pinoLogger = pino();

import { getSchnorrAccountContractAddress } from "@aztec/accounts/schnorr";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { EmbeddedWallet } from "@aztec/wallets/embedded";

const LOG_PREFIX = "[topup-autoclaim-bootstrap]";
const DEFAULT_MANIFEST_PATH = "./deployments/devnet-manifest-v2.json";
const DEFAULT_ALIAS_PREFIX = "topup-autoclaim";
const DEFAULT_AZTEC_WALLET_TIMEOUT_MS = 90_000;
const AZTEC_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const HEX_32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);

type PaymentMode = "auto" | "sponsored" | "fee_juice" | "register_only";

type CliArgs = {
  manifestPath: string;
  nodeUrl: string | null;
  secretKey: string | null;
  useOperatorSecretKey: boolean | null;
  sponsoredFpcAddress: string | null;
  paymentMode: PaymentMode | null;
  alias: string | null;
};

type PartialManifest = {
  network?: {
    node_url?: string;
  };
  aztec_required_addresses?: {
    sponsored_fpc_address?: string;
  };
};

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

function usage(): string {
  return [
    "Usage:",
    "  bunx tsx scripts/services/bootstrap-topup-autoclaim-account.ts \\",
    "    [--manifest <path.json>] \\",
    "    [--node-url <http(s)://...>] \\",
    "    [--secret-key <0x...32-byte-hex>] \\",
    "    [--use-operator-secret-key <true|false>] \\",
    "    [--sponsored-fpc-address <0x...aztec-address>] \\",
    "    [--payment-mode <auto|sponsored|fee_juice|register_only>] \\",
    "    [--alias <wallet-alias>]",
    "",
    "Defaults / fallbacks:",
    `  --manifest ${DEFAULT_MANIFEST_PATH}`,
    "  --node-url from AZTEC_NODE_URL or manifest.network.node_url",
    "  --secret-key from TOPUP_AUTOCLAIM_SECRET_KEY or (if enabled) OPERATOR_SECRET_KEY",
    "  --use-operator-secret-key from TOPUP_AUTOCLAIM_USE_OPERATOR_SECRET_KEY (default false)",
    "  --sponsored-fpc-address from TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS / FPC_DEVNET_SPONSORED_FPC_ADDRESS / SPONSORED_FPC_ADDRESS / manifest.aztec_required_addresses.sponsored_fpc_address",
    "  --payment-mode from TOPUP_AUTOCLAIM_BOOTSTRAP_PAYMENT_MODE (default auto)",
    "",
    "Behavior:",
    "  - derives claimer address from secret key using salt=0",
    "  - if account is already publicly deployed, exits successfully",
    "  - otherwise tries to publicly deploy account via aztec-wallet (--public-deploy)",
    "  - re-checks publication and fails if still not publicly deployed",
  ].join("\n");
}

function parseOptionalEnv(name: string): string | null {
  const value = process.env[name];
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function parseBoolean(name: string, raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (TRUE_ENV_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_ENV_VALUES.has(normalized)) {
    return false;
  }
  throw new CliError(`Invalid ${name}. Expected one of: 1/0, true/false, yes/no, on/off`);
}

function parseOptionalBoolean(name: string, raw: string | null): boolean | null {
  if (raw === null) {
    return null;
  }
  return parseBoolean(name, raw);
}

function parseSecretKey(name: string, raw: string): string {
  const withPrefix = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!HEX_32_PATTERN.test(withPrefix)) {
    throw new CliError(`Invalid ${name}. Expected 32-byte 0x-prefixed hex string`);
  }
  return withPrefix;
}

function parseOptionalSecretKey(name: string, raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  return parseSecretKey(name, raw);
}

function parseAztecAddress(name: string, raw: string): string {
  if (!AZTEC_ADDRESS_PATTERN.test(raw)) {
    throw new CliError(`Invalid ${name}. Expected 32-byte 0x-prefixed Aztec address`);
  }
  return raw;
}

function parseOptionalAztecAddress(name: string, raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  return parseAztecAddress(name, raw);
}

function parsePaymentMode(name: string, raw: string): PaymentMode {
  const normalized = raw.trim().toLowerCase();
  switch (normalized) {
    case "auto":
    case "sponsored":
    case "fee_juice":
    case "register_only":
      return normalized;
    default:
      throw new CliError(
        `Invalid ${name}. Expected one of: auto|sponsored|fee_juice|register_only`,
      );
  }
}

function parseOptionalPaymentMode(name: string, raw: string | null): PaymentMode | null {
  if (raw === null) {
    return null;
  }
  return parsePaymentMode(name, raw);
}

function parseHttpUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliError(`Invalid ${name}. Expected a URL, got: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CliError(`Invalid ${name}. Expected http(s) URL, got: ${value}`);
  }
  return parsed.toString();
}

function nextArg(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliError(`Missing value for ${flag}`);
  }
  return value;
}

function parseCliArgs(argv: string[]): CliArgs {
  let manifestPath = parseOptionalEnv("FPC_DEPLOY_MANIFEST") ?? DEFAULT_MANIFEST_PATH;
  let nodeUrl = parseOptionalEnv("AZTEC_NODE_URL");
  let secretKey = parseOptionalSecretKey(
    "TOPUP_AUTOCLAIM_SECRET_KEY",
    parseOptionalEnv("TOPUP_AUTOCLAIM_SECRET_KEY"),
  );
  let useOperatorSecretKey = parseOptionalBoolean(
    "TOPUP_AUTOCLAIM_USE_OPERATOR_SECRET_KEY",
    parseOptionalEnv("TOPUP_AUTOCLAIM_USE_OPERATOR_SECRET_KEY"),
  );
  let sponsoredFpcAddress = parseOptionalAztecAddress(
    "TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS",
    parseOptionalEnv("TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS"),
  );
  let paymentMode = parseOptionalPaymentMode(
    "TOPUP_AUTOCLAIM_BOOTSTRAP_PAYMENT_MODE",
    parseOptionalEnv("TOPUP_AUTOCLAIM_BOOTSTRAP_PAYMENT_MODE"),
  );
  let alias = parseOptionalEnv("TOPUP_AUTOCLAIM_BOOTSTRAP_ALIAS");

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--manifest":
        manifestPath = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--node-url":
        nodeUrl = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--secret-key":
        secretKey = parseSecretKey(arg, nextArg(argv, i, arg));
        i += 1;
        break;
      case "--use-operator-secret-key":
        useOperatorSecretKey = parseBoolean(arg, nextArg(argv, i, arg));
        i += 1;
        break;
      case "--sponsored-fpc-address":
        sponsoredFpcAddress = parseAztecAddress(arg, nextArg(argv, i, arg));
        i += 1;
        break;
      case "--payment-mode":
        paymentMode = parsePaymentMode(arg, nextArg(argv, i, arg));
        i += 1;
        break;
      case "--alias":
        alias = nextArg(argv, i, arg).trim();
        i += 1;
        break;
      case "--help":
      case "-h":
        pinoLogger.info(usage());
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) {
          throw new CliError(`Unknown argument: ${arg}`);
        }
    }
  }

  return {
    manifestPath: path.resolve(manifestPath),
    nodeUrl,
    secretKey,
    useOperatorSecretKey,
    sponsoredFpcAddress,
    paymentMode,
    alias,
  };
}

function readManifest(manifestPath: string): PartialManifest {
  try {
    const raw = readFileSync(manifestPath, "utf8");
    return JSON.parse(raw) as PartialManifest;
  } catch (error) {
    throw new CliError(`Failed to read manifest at ${manifestPath}: ${String(error)}`);
  }
}

function pickOptional<T>(...values: (T | null | undefined)[]): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}

function resolveSecretKey(args: CliArgs): { secretKey: string; source: string } {
  const operatorSecretKey = parseOptionalSecretKey(
    "OPERATOR_SECRET_KEY",
    parseOptionalEnv("OPERATOR_SECRET_KEY"),
  );
  const useOperatorSecretKey = args.useOperatorSecretKey ?? false;

  if (args.secretKey) {
    return {
      secretKey: args.secretKey,
      source: "TOPUP_AUTOCLAIM_SECRET_KEY/--secret-key",
    };
  }
  if (useOperatorSecretKey && operatorSecretKey) {
    return { secretKey: operatorSecretKey, source: "OPERATOR_SECRET_KEY" };
  }
  throw new CliError(
    "Could not resolve claimer secret key. Set TOPUP_AUTOCLAIM_SECRET_KEY (or pass --secret-key), or enable TOPUP_AUTOCLAIM_USE_OPERATOR_SECRET_KEY=1 with OPERATOR_SECRET_KEY set.",
  );
}

function resolveSponsoredFpcAddress(args: CliArgs, manifest: PartialManifest): string | null {
  const fallback = pickOptional(
    parseOptionalAztecAddress(
      "FPC_DEVNET_SPONSORED_FPC_ADDRESS",
      parseOptionalEnv("FPC_DEVNET_SPONSORED_FPC_ADDRESS"),
    ),
    parseOptionalAztecAddress("SPONSORED_FPC_ADDRESS", parseOptionalEnv("SPONSORED_FPC_ADDRESS")),
    parseOptionalAztecAddress(
      "manifest.aztec_required_addresses.sponsored_fpc_address",
      manifest.aztec_required_addresses?.sponsored_fpc_address ?? null,
    ),
  );
  return args.sponsoredFpcAddress ?? fallback;
}

function resolvePaymentMode(
  args: CliArgs,
  sponsoredFpcAddress: string | null,
): Exclude<PaymentMode, "auto"> {
  const requested = args.paymentMode ?? "auto";
  if (requested === "auto") {
    return sponsoredFpcAddress ? "sponsored" : "fee_juice";
  }
  return requested;
}

function isCreateAccountConflict(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("nullifier conflict") ||
    normalized.includes("existing nullifier") ||
    normalized.includes("already exists") ||
    normalized.includes("already registered")
  );
}

function shouldAttemptExistingAccountPublicDeployFallback(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    isCreateAccountConflict(message) ||
    normalized.includes("unable to be added to state and is invalid") ||
    normalized.includes("existing account")
  );
}

function resolveAztecWalletTimeoutMs(): number {
  const raw = parseOptionalEnv("TOPUP_AUTOCLAIM_BOOTSTRAP_WALLET_TIMEOUT_MS");
  if (!raw) {
    return DEFAULT_AZTEC_WALLET_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError(
      "Invalid TOPUP_AUTOCLAIM_BOOTSTRAP_WALLET_TIMEOUT_MS. Expected a positive integer (milliseconds).",
    );
  }
  return parsed;
}

function runAztecWalletCommand(nodeUrl: string, args: string[], description: string): string {
  const walletBin = process.env.AZTEC_WALLET_BIN ?? "aztec-wallet";
  const walletDataDir =
    process.env.AZTEC_WALLET_DATA_DIR ?? process.env.FPC_DEVNET_WALLET_DATA_DIR ?? null;
  const commandArgs = [
    ...(walletDataDir ? ["--data-dir", walletDataDir] : []),
    "--node-url",
    nodeUrl,
    ...args,
  ];
  const timeoutMs = resolveAztecWalletTimeoutMs();
  try {
    return execFileSync(walletBin, commandArgs, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      killSignal: "SIGTERM",
    });
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error && "stderr" in error) {
      const stdout = String((error as { stdout?: unknown }).stdout ?? "");
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      const message = "message" in error ? String((error as { message?: unknown }).message) : "";
      const timedOut =
        message.toLowerCase().includes("timed out") ||
        ("killed" in error && (error as { killed?: unknown }).killed === true);
      const timeoutSuffix = timedOut
        ? `\nCommand exceeded timeout (${timeoutMs}ms). Set TOPUP_AUTOCLAIM_BOOTSTRAP_WALLET_TIMEOUT_MS to adjust.`
        : "";
      throw new CliError(
        `Failed to ${description} via '${walletBin} ${commandArgs.join(" ")}'.${timeoutSuffix}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    throw new CliError(`Failed to ${description}: ${String(error)}`);
  }
}

function registerSponsoredFpc(nodeUrl: string, sponsoredFpcAddress: string): void {
  runAztecWalletCommand(
    nodeUrl,
    [
      "register-contract",
      "--alias",
      "sponsoredfpc",
      sponsoredFpcAddress,
      "SponsoredFPC",
      "--salt",
      "0",
    ],
    `register sponsored FPC contract ${sponsoredFpcAddress}`,
  );
}

function deriveAddress(secretKey: string): AztecAddress {
  const secretFr = Fr.fromHexString(secretKey);
  return getSchnorrAccountContractAddress(secretFr, Fr.ZERO);
}

async function isPublished(nodeUrl: string, address: AztecAddress): Promise<boolean> {
  const node = createAztecNodeClient(nodeUrl);
  await waitForNode(node);
  const contract = await node.getContract(address);
  return Boolean(contract);
}

function buildAlias(explicitAlias: string | null, address: AztecAddress): string {
  if (explicitAlias && explicitAlias.length > 0) {
    return explicitAlias;
  }
  const suffix = Date.now().toString().slice(-6);
  return `${DEFAULT_ALIAS_PREFIX}-${address.toString().slice(2, 10).toLowerCase()}-${suffix}`;
}

function createAccountWithMode(params: {
  nodeUrl: string;
  alias: string;
  secretKey: string;
  paymentMode: Exclude<PaymentMode, "auto">;
  sponsoredFpcAddress: string | null;
}): void {
  const baseArgs = ["create-account", "--alias", params.alias, "--secret-key", params.secretKey];

  if (params.paymentMode === "register_only") {
    runAztecWalletCommand(
      params.nodeUrl,
      [
        "create-account",
        "--register-only",
        "--alias",
        params.alias,
        "--secret-key",
        params.secretKey,
      ],
      `register-only import claimer account alias accounts:${params.alias}`,
    );
    return;
  }

  const withPayment = [...baseArgs];
  if (params.paymentMode === "sponsored") {
    if (!params.sponsoredFpcAddress) {
      throw new CliError(
        "Payment mode 'sponsored' requested but no sponsored FPC address was provided.",
      );
    }
    withPayment.push("--payment", `method=fpc-sponsored,fpc=${params.sponsoredFpcAddress}`);
  }
  const publicDeployArgs = [...withPayment, "--public-deploy"];

  try {
    runAztecWalletCommand(
      params.nodeUrl,
      publicDeployArgs,
      `create claimer account alias accounts:${params.alias} with payment=${params.paymentMode}`,
    );
    return;
  } catch (error) {
    const message = String(error);
    if (!shouldAttemptExistingAccountPublicDeployFallback(message)) {
      throw error;
    }
    pinoLogger.warn(
      `${LOG_PREFIX} create-account did not complete cleanly; retrying public deployment with --skip-initialization`,
    );
    runAztecWalletCommand(
      params.nodeUrl,
      [...publicDeployArgs, "--skip-initialization"],
      `publicly deploy existing claimer account alias accounts:${params.alias} after create-account conflict`,
    );
  }
}

async function registerSponsoredFpcInEmbeddedWallet(
  nodeUrl: string,
  sponsoredFpcAddress: string,
  wallet: EmbeddedWallet,
): Promise<AztecAddress> {
  const moduleId = "@aztec/noir-contracts.js/SponsoredFPC";
  let sponsoredFpcArtifact: unknown;
  try {
    const imported = (await import(moduleId)) as {
      SponsoredFPCContractArtifact?: unknown;
    };
    sponsoredFpcArtifact = imported.SponsoredFPCContractArtifact;
  } catch {
    const requireFromTopup = createRequire(path.resolve("services/topup/package.json"));
    const resolved = requireFromTopup.resolve(moduleId);
    const imported = (await import(pathToFileURL(resolved).href)) as {
      SponsoredFPCContractArtifact?: unknown;
    };
    sponsoredFpcArtifact = imported.SponsoredFPCContractArtifact;
  }
  if (!sponsoredFpcArtifact) {
    throw new CliError("Failed to load SponsoredFPC artifact for embedded-wallet registration");
  }

  const node = createAztecNodeClient(nodeUrl);
  await waitForNode(node);
  const sponsorAddress = AztecAddress.fromString(sponsoredFpcAddress);
  const sponsorInstance = await node.getContract(sponsorAddress);
  if (!sponsorInstance) {
    throw new CliError(
      `Sponsored FPC contract ${sponsoredFpcAddress} is not available on node ${nodeUrl}`,
    );
  }
  await wallet.registerContract(
    sponsorInstance,
    sponsoredFpcArtifact as Parameters<EmbeddedWallet["registerContract"]>[1],
  );
  return sponsorAddress;
}

async function deployWithAztecJsFallback(params: {
  nodeUrl: string;
  secretKey: string;
  paymentMode: Exclude<PaymentMode, "auto">;
  sponsoredFpcAddress: string | null;
  claimerAddress: AztecAddress;
}): Promise<void> {
  if (params.paymentMode === "register_only") {
    return;
  }

  const node = createAztecNodeClient(params.nodeUrl);
  await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxeConfig: { proverEnabled: true },
  });

  const secret = Fr.fromHexString(params.secretKey);
  const signingKey = deriveSigningKey(secret);
  const account = await wallet.createSchnorrAccount(secret, Fr.ZERO, signingKey);
  if (account.address.toString().toLowerCase() !== params.claimerAddress.toString().toLowerCase()) {
    throw new CliError(
      `Aztec.js fallback derived unexpected account address ${account.address.toString()} (expected ${params.claimerAddress.toString()})`,
    );
  }

  const attemptModes: ("sponsored" | "fee_juice")[] =
    params.paymentMode === "sponsored" ? ["sponsored", "fee_juice"] : ["fee_juice"];
  const failures: string[] = [];

  for (const mode of attemptModes) {
    try {
      const deployMethod = await account.getDeployMethod();
      if (mode === "sponsored") {
        if (!params.sponsoredFpcAddress) {
          throw new CliError(
            "Aztec.js fallback cannot use sponsored mode without sponsored FPC address",
          );
        }
        const sponsorAddress = await registerSponsoredFpcInEmbeddedWallet(
          params.nodeUrl,
          params.sponsoredFpcAddress,
          wallet,
        );
        await deployMethod.send({
          from: AztecAddress.ZERO,
          fee: { paymentMethod: new SponsoredFeePaymentMethod(sponsorAddress) },
          wait: { timeout: 120 },
        });
      } else {
        await deployMethod.send({
          from: AztecAddress.ZERO,
          wait: { timeout: 120 },
        });
      }
      pinoLogger.info(`${LOG_PREFIX} aztec.js fallback deployment sent with mode=${mode}`);
      return;
    } catch (error) {
      const message = String(error);
      // "Existing nullifier" means the contract's deployment nullifier already
      // exists in state (e.g. genesis-deployed test accounts on a local network).
      // The instance IS deployed even though getContract() doesn't index it.
      if (message.includes("Existing nullifier") || message.includes("existing nullifier")) {
        pinoLogger.info(
          `${LOG_PREFIX} aztec.js fallback got "Existing nullifier" with mode=${mode} — account already deployed; treating as success`,
        );
        return;
      }
      failures.push(`${mode}: ${message}`);
      pinoLogger.warn(
        `${LOG_PREFIX} aztec.js fallback deployment failed with mode=${mode}`,
        message,
      );
    }
  }

  throw new CliError(
    `Aztec.js fallback could not deploy claimer account. Attempts: ${failures.join(" | ")}`,
  );
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const manifest = readManifest(args.manifestPath);

  const nodeUrlRaw = args.nodeUrl ?? manifest.network?.node_url;
  if (!nodeUrlRaw) {
    throw new CliError(
      "Missing node URL. Set AZTEC_NODE_URL, pass --node-url, or include manifest.network.node_url.",
    );
  }
  const nodeUrl = parseHttpUrl("node URL", nodeUrlRaw);
  const resolvedSecretKey = resolveSecretKey(args);
  const sponsoredFpcAddress = resolveSponsoredFpcAddress(args, manifest);
  const paymentMode = resolvePaymentMode(args, sponsoredFpcAddress);
  const claimerAddress = await deriveAddress(resolvedSecretKey.secretKey);
  const alias = buildAlias(args.alias, claimerAddress);

  pinoLogger.info(
    `${LOG_PREFIX} resolved claimer=${claimerAddress.toString()} secret_source=${resolvedSecretKey.source} payment_mode=${paymentMode}`,
  );

  if (await isPublished(nodeUrl, claimerAddress)) {
    pinoLogger.info(
      `${LOG_PREFIX} already published: ${claimerAddress.toString()} (no action needed)`,
    );
    return;
  }

  if (paymentMode === "sponsored" && sponsoredFpcAddress) {
    pinoLogger.info(`${LOG_PREFIX} registering SponsoredFPC in wallet: ${sponsoredFpcAddress}`);
    registerSponsoredFpc(nodeUrl, sponsoredFpcAddress);
  }

  pinoLogger.info(
    `${LOG_PREFIX} deploying/importing claimer account via aztec-wallet alias=accounts:${alias}`,
  );
  let walletBootstrapError: string | null = null;
  try {
    createAccountWithMode({
      nodeUrl,
      alias,
      secretKey: resolvedSecretKey.secretKey,
      paymentMode,
      sponsoredFpcAddress,
    });
  } catch (error) {
    walletBootstrapError = String(error);
    pinoLogger.warn(
      `${LOG_PREFIX} aztec-wallet bootstrap path failed; will attempt aztec.js fallback`,
      walletBootstrapError,
    );
  }

  let publishedAfterBootstrap = await isPublished(nodeUrl, claimerAddress);
  let aztecJsFallbackError: string | null = null;
  if (!publishedAfterBootstrap && paymentMode !== "register_only") {
    pinoLogger.info(
      `${LOG_PREFIX} claimer still not published after aztec-wallet path; attempting aztec.js fallback`,
    );
    try {
      await deployWithAztecJsFallback({
        nodeUrl,
        secretKey: resolvedSecretKey.secretKey,
        paymentMode,
        sponsoredFpcAddress,
        claimerAddress,
      });
      // Fallback returned without throwing — account is deployed (or was already
      // deployed per "Existing nullifier"); trust the result rather than re-checking
      // via getContract(), which may not index genesis-deployed accounts.
      publishedAfterBootstrap = true;
    } catch (error) {
      aztecJsFallbackError = String(error);
      publishedAfterBootstrap = await isPublished(nodeUrl, claimerAddress);
    }
  }

  if (!publishedAfterBootstrap) {
    const details = [walletBootstrapError, aztecJsFallbackError]
      .filter((entry): entry is string => Boolean(entry))
      .join(" | ");
    const detailsSuffix = details.length > 0 ? ` Details: ${details}` : "";
    throw new CliError(
      `Bootstrap finished but claimer ${claimerAddress.toString()} is still not publicly deployed on ${nodeUrl}. If you used fee_juice mode, ensure claimer has FeeJuice; otherwise retry with sponsored mode and a valid TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS.${detailsSuffix}`,
    );
  }

  pinoLogger.info(
    `${LOG_PREFIX} success: claimer is publicly deployed (${claimerAddress.toString()})`,
  );
  pinoLogger.info(
    `${LOG_PREFIX} use TOPUP_AUTOCLAIM_SECRET_KEY for this claimer when running topup`,
  );
}

main().catch((error) => {
  pinoLogger.error(`${LOG_PREFIX} ERROR: ${String(error)}`);
  pinoLogger.error(usage());
  process.exit(1);
});

import { readFileSync } from "node:fs";
import path from "node:path";

import { getSchnorrAccountContractAddress } from "@aztec/accounts/schnorr";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";

const HEX_32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_UINT_PATTERN = /^(0|[1-9][0-9]*)$/;
const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);
const LOG_PREFIX = "[topup-autoclaim-preflight]";
const DEFAULT_MANIFEST_PATH = "./deployments/devnet-manifest-v2.json";
const DEFAULT_TEST_ACCOUNT_INDEX = 0;

type CliArgs = {
  manifestPath: string;
  nodeUrl: string | null;
  secretKey: string | null;
  useOperatorSecretKey: boolean | null;
  testAccountIndex: number | null;
  autoClaimEnabled: boolean | null;
  requirePublishedAccount: boolean | null;
};

type PartialManifest = {
  network?: {
    node_url?: string;
  };
  deployment_accounts?: {
    l2_deployer?: {
      private_key?: string;
      address?: string;
    };
  };
};

function usage(): string {
  return [
    "Usage:",
    "  bunx tsx scripts/services/preflight-topup-autoclaim.ts \\",
    "    [--manifest <path.json>] \\",
    "    [--node-url <http(s)://...>] \\",
    "    [--secret-key <0x...32-byte-hex>] \\",
    "    [--use-operator-secret-key <true|false>] \\",
    "    [--test-account-index <uint>] \\",
    "    [--auto-claim-enabled <true|false>] \\",
    "    [--require-published-account <true|false>]",
    "",
    "Defaults / fallbacks:",
    `  --manifest ${DEFAULT_MANIFEST_PATH}`,
    "  --node-url from AZTEC_NODE_URL or manifest.network.node_url",
    "  --secret-key from TOPUP_AUTOCLAIM_SECRET_KEY or (if enabled) OPERATOR_SECRET_KEY or manifest.deployment_accounts.l2_deployer.private_key",
    "  --use-operator-secret-key from TOPUP_AUTOCLAIM_USE_OPERATOR_SECRET_KEY (default false)",
    `  --test-account-index from TOPUP_AUTOCLAIM_TEST_ACCOUNT_INDEX (default ${DEFAULT_TEST_ACCOUNT_INDEX})`,
    "  --auto-claim-enabled from TOPUP_AUTOCLAIM_ENABLED (default true)",
    "  --require-published-account from TOPUP_AUTOCLAIM_REQUIRE_PUBLISHED_ACCOUNT (default true)",
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
  throw new Error(`Invalid ${name}. Expected one of: 1/0, true/false, yes/no, on/off`);
}

function parseOptionalBoolean(name: string, raw: string | null): boolean | null {
  if (raw === null) {
    return null;
  }
  return parseBoolean(name, raw);
}

function parseOptionalSecretKey(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const withPrefix = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!HEX_32_PATTERN.test(withPrefix)) {
    throw new Error("Invalid secret key. Expected 32-byte 0x-prefixed hex string");
  }
  return withPrefix;
}

function parseOptionalTestAccountIndex(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  if (!DECIMAL_UINT_PATTERN.test(raw)) {
    throw new Error("Invalid test account index. Expected a non-negative integer");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Invalid test account index. Value is too large");
  }
  return parsed;
}

function parseHttpUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}. Expected a URL, got: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid ${name}. Expected http(s) URL, got: ${value}`);
  }
  return parsed.toString();
}

function parseCliArgs(argv: string[]): CliArgs {
  let manifestPath = parseOptionalEnv("FPC_DEPLOY_MANIFEST") ?? DEFAULT_MANIFEST_PATH;
  let nodeUrl = parseOptionalEnv("AZTEC_NODE_URL");
  let secretKey = parseOptionalSecretKey(parseOptionalEnv("TOPUP_AUTOCLAIM_SECRET_KEY"));
  let useOperatorSecretKey = parseOptionalBoolean(
    "TOPUP_AUTOCLAIM_USE_OPERATOR_SECRET_KEY",
    parseOptionalEnv("TOPUP_AUTOCLAIM_USE_OPERATOR_SECRET_KEY"),
  );
  let testAccountIndex = parseOptionalTestAccountIndex(
    parseOptionalEnv("TOPUP_AUTOCLAIM_TEST_ACCOUNT_INDEX"),
  );
  let autoClaimEnabled = parseOptionalBoolean(
    "TOPUP_AUTOCLAIM_ENABLED",
    parseOptionalEnv("TOPUP_AUTOCLAIM_ENABLED"),
  );
  let requirePublishedAccount = parseOptionalBoolean(
    "TOPUP_AUTOCLAIM_REQUIRE_PUBLISHED_ACCOUNT",
    parseOptionalEnv("TOPUP_AUTOCLAIM_REQUIRE_PUBLISHED_ACCOUNT"),
  );

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    const nextOrThrow = (): string => {
      if (!next || next.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      return next;
    };

    switch (arg) {
      case "--manifest":
        manifestPath = nextOrThrow();
        break;
      case "--node-url":
        nodeUrl = nextOrThrow();
        break;
      case "--secret-key":
        secretKey = parseOptionalSecretKey(nextOrThrow());
        break;
      case "--use-operator-secret-key":
        useOperatorSecretKey = parseBoolean(arg, nextOrThrow());
        break;
      case "--test-account-index":
        testAccountIndex = parseOptionalTestAccountIndex(nextOrThrow());
        break;
      case "--auto-claim-enabled":
        autoClaimEnabled = parseBoolean(arg, nextOrThrow());
        break;
      case "--require-published-account":
        requirePublishedAccount = parseBoolean(arg, nextOrThrow());
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }
  }

  return {
    manifestPath: path.resolve(manifestPath),
    nodeUrl,
    secretKey,
    useOperatorSecretKey,
    testAccountIndex,
    autoClaimEnabled,
    requirePublishedAccount,
  };
}

function readManifest(manifestPath: string): PartialManifest {
  const raw = readFileSync(manifestPath, "utf8");
  return JSON.parse(raw) as PartialManifest;
}

async function resolveClaimer(params: {
  explicitSecretKey: string | null;
  useOperatorSecretKey: boolean;
  testAccountIndex: number;
  manifest: PartialManifest;
}): Promise<{
  address: AztecAddress;
  source: "secret_key" | "test_account";
  detail: string;
}> {
  const operatorSecretKey = parseOptionalSecretKey(parseOptionalEnv("OPERATOR_SECRET_KEY"));
  const manifestSecretKey = parseOptionalSecretKey(
    params.manifest.deployment_accounts?.l2_deployer?.private_key ?? null,
  );
  const chosenSecretKey =
    params.explicitSecretKey ??
    (params.useOperatorSecretKey ? operatorSecretKey : null) ??
    manifestSecretKey;

  if (chosenSecretKey) {
    const secretFr = Fr.fromHexString(chosenSecretKey);
    const address = await getSchnorrAccountContractAddress(secretFr, Fr.ZERO);
    return {
      address,
      source: "secret_key",
      detail:
        params.explicitSecretKey !== null
          ? "TOPUP_AUTOCLAIM_SECRET_KEY/--secret-key"
          : params.useOperatorSecretKey && operatorSecretKey
            ? "OPERATOR_SECRET_KEY (fallback enabled)"
            : "manifest.deployment_accounts.l2_deployer.private_key",
    };
  }

  const testAccounts = await getInitialTestAccountsData();
  if (params.testAccountIndex >= testAccounts.length) {
    throw new Error(
      `TOPUP_AUTOCLAIM_TEST_ACCOUNT_INDEX out of range. index=${params.testAccountIndex}, available=${testAccounts.length}`,
    );
  }
  const testAccount = testAccounts[params.testAccountIndex];
  const address = await getSchnorrAccountContractAddress(testAccount.secret, testAccount.salt);
  return {
    address,
    source: "test_account",
    detail: `TOPUP_AUTOCLAIM_TEST_ACCOUNT_INDEX=${params.testAccountIndex}`,
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const manifest = readManifest(args.manifestPath);
  const autoClaimEnabled = args.autoClaimEnabled ?? true;
  const requirePublishedAccount = args.requirePublishedAccount ?? true;
  const useOperatorSecretKey = args.useOperatorSecretKey ?? false;
  const testAccountIndex = args.testAccountIndex ?? DEFAULT_TEST_ACCOUNT_INDEX;

  if (!autoClaimEnabled) {
    console.log(`${LOG_PREFIX} skipping: TOPUP_AUTOCLAIM_ENABLED is false/0 for this run`);
    return;
  }

  if (!requirePublishedAccount) {
    console.log(
      `${LOG_PREFIX} skipping: TOPUP_AUTOCLAIM_REQUIRE_PUBLISHED_ACCOUNT is false/0 for this run`,
    );
    return;
  }

  const nodeUrlRaw = args.nodeUrl ?? manifest.network?.node_url;
  if (!nodeUrlRaw) {
    throw new Error(
      "Missing node URL. Set AZTEC_NODE_URL, pass --node-url, or provide manifest.network.node_url",
    );
  }
  const nodeUrl = parseHttpUrl("node URL", nodeUrlRaw);
  const node = createAztecNodeClient(nodeUrl);

  const claimer = await resolveClaimer({
    explicitSecretKey: args.secretKey,
    useOperatorSecretKey,
    testAccountIndex,
    manifest,
  });

  console.log(
    `${LOG_PREFIX} checking claimer=${claimer.address.toString()} source=${claimer.source} (${claimer.detail}) on node=${nodeUrl}`,
  );

  await waitForNode(node);
  const published = await node.getContract(claimer.address);
  if (!published) {
    throw new Error(
      `Auto-claim claimer ${claimer.address.toString()} is not publicly deployed on ${nodeUrl}. Use a publicly deployed account for TOPUP_AUTOCLAIM_SECRET_KEY (or disable this preflight with TOPUP_AUTOCLAIM_REQUIRE_PUBLISHED_ACCOUNT=0 for debugging).`,
    );
  }

  console.log(
    `${LOG_PREFIX} ok: claimer account is publicly deployed (${claimer.address.toString()})`,
  );

  const manifestDeployerAddress = manifest.deployment_accounts?.l2_deployer?.address ?? null;
  if (
    manifestDeployerAddress &&
    manifestDeployerAddress.toLowerCase() !== claimer.address.toString().toLowerCase()
  ) {
    console.log(
      `${LOG_PREFIX} note: claimer differs from manifest deployment_accounts.l2_deployer.address (${manifestDeployerAddress})`,
    );
  }
}

main().catch((error) => {
  console.error(`${LOG_PREFIX} ERROR: ${String(error)}`);
  console.error(usage());
  process.exit(1);
});

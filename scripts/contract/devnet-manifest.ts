import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const AZTEC_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ETH_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ZERO_AZTEC_ADDRESS_PATTERN = /^0x0{64}$/i;
const ZERO_ETH_ADDRESS_PATTERN = /^0x0{40}$/i;
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ZERO_TX_HASH_PATTERN = /^0x0{64}$/i;
const DECIMAL_UINT_PATTERN = /^(0|[1-9][0-9]*)$/;
const HEX_FIELD_PATTERN = /^0x[0-9a-fA-F]+$/;
const HEX_32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export type DevnetDeployManifest = {
  status: "deploy_ok";
  generated_at: string;
  network: {
    node_url: string;
    node_version: string;
    l1_chain_id: number;
    rollup_version: number;
  };
  aztec_required_addresses: {
    l1_contract_addresses: {
      registryAddress: string;
      rollupAddress: string;
      inboxAddress: string;
      outboxAddress: string;
      feeJuiceAddress: string;
      feeJuicePortalAddress: string;
      feeAssetHandlerAddress: string;
    };
    protocol_contract_addresses: {
      instanceRegistry: string;
      classRegistry: string;
      multiCallEntrypoint: string;
      feeJuice: string;
    };
    sponsored_fpc_address: string;
  };
  deployment_accounts: {
    l2_deployer: {
      alias: string;
      address: string;
      private_key?: string;
      private_key_ref?: string;
    };
    l1_topup_operator?: {
      address: string;
      private_key?: string;
      private_key_ref?: string;
    };
  };
  contracts: {
    accepted_asset: string;
    fpc: string;
    credit_fpc: string;
  };
  operator: {
    address: string;
    pubkey_x: string;
    pubkey_y: string;
  };
  tx_hashes: {
    accepted_asset_deploy: string | null;
    fpc_deploy: string | null;
    credit_fpc_deploy: string | null;
  };
  payment_mode?: string;
};

export type LegacyDeployOutputCompat = {
  aztec_node_url: string;
  l1_chain_id: number;
  operator: string;
  accepted_asset: string;
  fpc_address: string;
  credit_fpc_address: string;
  node_contracts: {
    fee_juice_portal_address: string;
    fee_juice_address: string;
  };
  deploy: {
    token: {
      address: string;
      source: "deployed" | "provided" | "reused";
    };
    fpc: {
      address: string;
      source: "deployed" | "reused";
    };
    credit_fpc: {
      address: string;
      source: "deployed" | "reused";
    };
  };
};

export type DevnetDeployManifestWithCompat = DevnetDeployManifest &
  LegacyDeployOutputCompat;

class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(
  root: Record<string, unknown>,
  key: string,
  context: string,
): Record<string, unknown> {
  const value = root[key];
  if (!isObjectRecord(value)) {
    throw new ManifestValidationError(`Missing or invalid ${context}.${key}`);
  }
  return value;
}

function requireString(
  root: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const value = root[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ManifestValidationError(`Missing or invalid ${context}.${key}`);
  }
  return value;
}

function optionalString(
  root: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  const value = root[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ManifestValidationError(`Invalid ${context}.${key}`);
  }
  return value;
}

function requirePositiveSafeInteger(
  root: Record<string, unknown>,
  key: string,
  context: string,
): number {
  const value = root[key];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    !Number.isSafeInteger(value)
  ) {
    throw new ManifestValidationError(`Missing or invalid ${context}.${key}`);
  }
  return value;
}

function requireIsoTimestamp(
  root: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const value = requireString(root, key, context);
  if (Number.isNaN(Date.parse(value))) {
    throw new ManifestValidationError(
      `Invalid ${context}.${key}: not an ISO timestamp`,
    );
  }
  return value;
}

function requireHttpUrl(
  root: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const value = requireString(root, key, context);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ManifestValidationError(
        `Invalid ${context}.${key}: expected http(s) URL`,
      );
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof ManifestValidationError) {
      throw error;
    }
    throw new ManifestValidationError(
      `Invalid ${context}.${key}: expected URL`,
    );
  }
}

function parseAztecAddress(value: string, fieldPath: string): string {
  if (
    !AZTEC_ADDRESS_PATTERN.test(value) ||
    ZERO_AZTEC_ADDRESS_PATTERN.test(value)
  ) {
    throw new ManifestValidationError(
      `Invalid ${fieldPath}: expected non-zero Aztec address`,
    );
  }
  return value;
}

function parseEthAddress(value: string, fieldPath: string): string {
  if (
    !ETH_ADDRESS_PATTERN.test(value) ||
    ZERO_ETH_ADDRESS_PATTERN.test(value)
  ) {
    throw new ManifestValidationError(
      `Invalid ${fieldPath}: expected non-zero EVM address`,
    );
  }
  return value;
}

function parseFieldValue(value: string, fieldPath: string): string {
  if (!DECIMAL_UINT_PATTERN.test(value) && !HEX_FIELD_PATTERN.test(value)) {
    throw new ManifestValidationError(
      `Invalid ${fieldPath}: expected decimal integer or 0x-prefixed hex field value`,
    );
  }
  return value;
}

function parseTxHashOrNull(value: unknown, fieldPath: string): string | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    !TX_HASH_PATTERN.test(value) ||
    ZERO_TX_HASH_PATTERN.test(value)
  ) {
    throw new ManifestValidationError(
      `Invalid ${fieldPath}: expected tx hash or null`,
    );
  }
  return value;
}

function parseKeyMaterial(
  root: Record<string, unknown>,
  context: string,
): { privateKey?: string; privateKeyRef?: string } {
  const privateKey = optionalString(root, "private_key", context);
  const privateKeyRef = optionalString(root, "private_key_ref", context);

  if (!privateKey && !privateKeyRef) {
    throw new ManifestValidationError(
      `Invalid ${context}: must include private_key or private_key_ref`,
    );
  }

  if (privateKey && !HEX_32_PATTERN.test(privateKey)) {
    throw new ManifestValidationError(
      `Invalid ${context}.private_key: expected 32-byte 0x-prefixed hex`,
    );
  }

  return { privateKey, privateKeyRef };
}

function hasOwn(root: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(root, key);
}

function parseManifest(input: unknown): DevnetDeployManifest {
  if (!isObjectRecord(input)) {
    throw new ManifestValidationError("Manifest must be a JSON object");
  }

  const status = requireString(input, "status", "manifest");
  if (status !== "deploy_ok") {
    throw new ManifestValidationError(
      'Invalid manifest.status: expected "deploy_ok"',
    );
  }

  const networkRaw = requireObject(input, "network", "manifest");
  const network = {
    node_url: requireHttpUrl(networkRaw, "node_url", "manifest.network"),
    node_version: requireString(networkRaw, "node_version", "manifest.network"),
    l1_chain_id: requirePositiveSafeInteger(
      networkRaw,
      "l1_chain_id",
      "manifest.network",
    ),
    rollup_version: requirePositiveSafeInteger(
      networkRaw,
      "rollup_version",
      "manifest.network",
    ),
  };

  const aztecAddressesRaw = requireObject(
    input,
    "aztec_required_addresses",
    "manifest",
  );
  const l1ContractsRaw = requireObject(
    aztecAddressesRaw,
    "l1_contract_addresses",
    "manifest.aztec_required_addresses",
  );
  const protocolContractsRaw = requireObject(
    aztecAddressesRaw,
    "protocol_contract_addresses",
    "manifest.aztec_required_addresses",
  );

  const l1ContractAddresses = {
    registryAddress: parseEthAddress(
      requireString(
        l1ContractsRaw,
        "registryAddress",
        "manifest.aztec_required_addresses.l1_contract_addresses",
      ),
      "manifest.aztec_required_addresses.l1_contract_addresses.registryAddress",
    ),
    rollupAddress: parseEthAddress(
      requireString(
        l1ContractsRaw,
        "rollupAddress",
        "manifest.aztec_required_addresses.l1_contract_addresses",
      ),
      "manifest.aztec_required_addresses.l1_contract_addresses.rollupAddress",
    ),
    inboxAddress: parseEthAddress(
      requireString(
        l1ContractsRaw,
        "inboxAddress",
        "manifest.aztec_required_addresses.l1_contract_addresses",
      ),
      "manifest.aztec_required_addresses.l1_contract_addresses.inboxAddress",
    ),
    outboxAddress: parseEthAddress(
      requireString(
        l1ContractsRaw,
        "outboxAddress",
        "manifest.aztec_required_addresses.l1_contract_addresses",
      ),
      "manifest.aztec_required_addresses.l1_contract_addresses.outboxAddress",
    ),
    feeJuiceAddress: parseEthAddress(
      requireString(
        l1ContractsRaw,
        "feeJuiceAddress",
        "manifest.aztec_required_addresses.l1_contract_addresses",
      ),
      "manifest.aztec_required_addresses.l1_contract_addresses.feeJuiceAddress",
    ),
    feeJuicePortalAddress: parseEthAddress(
      requireString(
        l1ContractsRaw,
        "feeJuicePortalAddress",
        "manifest.aztec_required_addresses.l1_contract_addresses",
      ),
      "manifest.aztec_required_addresses.l1_contract_addresses.feeJuicePortalAddress",
    ),
    feeAssetHandlerAddress: parseEthAddress(
      requireString(
        l1ContractsRaw,
        "feeAssetHandlerAddress",
        "manifest.aztec_required_addresses.l1_contract_addresses",
      ),
      "manifest.aztec_required_addresses.l1_contract_addresses.feeAssetHandlerAddress",
    ),
  };

  const protocolContractAddresses = {
    instanceRegistry: parseAztecAddress(
      requireString(
        protocolContractsRaw,
        "instanceRegistry",
        "manifest.aztec_required_addresses.protocol_contract_addresses",
      ),
      "manifest.aztec_required_addresses.protocol_contract_addresses.instanceRegistry",
    ),
    classRegistry: parseAztecAddress(
      requireString(
        protocolContractsRaw,
        "classRegistry",
        "manifest.aztec_required_addresses.protocol_contract_addresses",
      ),
      "manifest.aztec_required_addresses.protocol_contract_addresses.classRegistry",
    ),
    multiCallEntrypoint: parseAztecAddress(
      requireString(
        protocolContractsRaw,
        "multiCallEntrypoint",
        "manifest.aztec_required_addresses.protocol_contract_addresses",
      ),
      "manifest.aztec_required_addresses.protocol_contract_addresses.multiCallEntrypoint",
    ),
    feeJuice: parseAztecAddress(
      requireString(
        protocolContractsRaw,
        "feeJuice",
        "manifest.aztec_required_addresses.protocol_contract_addresses",
      ),
      "manifest.aztec_required_addresses.protocol_contract_addresses.feeJuice",
    ),
  };

  const deploymentAccountsRaw = requireObject(
    input,
    "deployment_accounts",
    "manifest",
  );
  const l2DeployerRaw = requireObject(
    deploymentAccountsRaw,
    "l2_deployer",
    "manifest.deployment_accounts",
  );
  const l2DeployerKeyMaterial = parseKeyMaterial(
    l2DeployerRaw,
    "manifest.deployment_accounts.l2_deployer",
  );
  const l2Deployer: DevnetDeployManifest["deployment_accounts"]["l2_deployer"] =
    {
      alias: requireString(
        l2DeployerRaw,
        "alias",
        "manifest.deployment_accounts.l2_deployer",
      ),
      address: parseAztecAddress(
        requireString(
          l2DeployerRaw,
          "address",
          "manifest.deployment_accounts.l2_deployer",
        ),
        "manifest.deployment_accounts.l2_deployer.address",
      ),
      ...(l2DeployerKeyMaterial.privateKey
        ? { private_key: l2DeployerKeyMaterial.privateKey }
        : {}),
      ...(l2DeployerKeyMaterial.privateKeyRef
        ? { private_key_ref: l2DeployerKeyMaterial.privateKeyRef }
        : {}),
    };

  let l1TopupOperator: DevnetDeployManifest["deployment_accounts"]["l1_topup_operator"];
  if (hasOwn(deploymentAccountsRaw, "l1_topup_operator")) {
    const l1TopupRaw = requireObject(
      deploymentAccountsRaw,
      "l1_topup_operator",
      "manifest.deployment_accounts",
    );
    const l1KeyMaterial = parseKeyMaterial(
      l1TopupRaw,
      "manifest.deployment_accounts.l1_topup_operator",
    );
    l1TopupOperator = {
      address: parseEthAddress(
        requireString(
          l1TopupRaw,
          "address",
          "manifest.deployment_accounts.l1_topup_operator",
        ),
        "manifest.deployment_accounts.l1_topup_operator.address",
      ),
      ...(l1KeyMaterial.privateKey
        ? { private_key: l1KeyMaterial.privateKey }
        : {}),
      ...(l1KeyMaterial.privateKeyRef
        ? { private_key_ref: l1KeyMaterial.privateKeyRef }
        : {}),
    };
  }

  const contractsRaw = requireObject(input, "contracts", "manifest");
  const contracts = {
    accepted_asset: parseAztecAddress(
      requireString(contractsRaw, "accepted_asset", "manifest.contracts"),
      "manifest.contracts.accepted_asset",
    ),
    fpc: parseAztecAddress(
      requireString(contractsRaw, "fpc", "manifest.contracts"),
      "manifest.contracts.fpc",
    ),
    credit_fpc: parseAztecAddress(
      requireString(contractsRaw, "credit_fpc", "manifest.contracts"),
      "manifest.contracts.credit_fpc",
    ),
  };

  const operatorRaw = requireObject(input, "operator", "manifest");
  const operator = {
    address: parseAztecAddress(
      requireString(operatorRaw, "address", "manifest.operator"),
      "manifest.operator.address",
    ),
    pubkey_x: parseFieldValue(
      requireString(operatorRaw, "pubkey_x", "manifest.operator"),
      "manifest.operator.pubkey_x",
    ),
    pubkey_y: parseFieldValue(
      requireString(operatorRaw, "pubkey_y", "manifest.operator"),
      "manifest.operator.pubkey_y",
    ),
  };

  const txHashesRaw = requireObject(input, "tx_hashes", "manifest");
  const txHashes = {
    accepted_asset_deploy: parseTxHashOrNull(
      txHashesRaw.accepted_asset_deploy,
      "manifest.tx_hashes.accepted_asset_deploy",
    ),
    fpc_deploy: parseTxHashOrNull(
      txHashesRaw.fpc_deploy,
      "manifest.tx_hashes.fpc_deploy",
    ),
    credit_fpc_deploy: parseTxHashOrNull(
      txHashesRaw.credit_fpc_deploy,
      "manifest.tx_hashes.credit_fpc_deploy",
    ),
  };

  const paymentMode = optionalString(input, "payment_mode", "manifest");

  return {
    status: "deploy_ok",
    generated_at: requireIsoTimestamp(input, "generated_at", "manifest"),
    network,
    aztec_required_addresses: {
      l1_contract_addresses: l1ContractAddresses,
      protocol_contract_addresses: protocolContractAddresses,
      sponsored_fpc_address: parseAztecAddress(
        requireString(
          aztecAddressesRaw,
          "sponsored_fpc_address",
          "manifest.aztec_required_addresses",
        ),
        "manifest.aztec_required_addresses.sponsored_fpc_address",
      ),
    },
    deployment_accounts: {
      l2_deployer: l2Deployer,
      ...(l1TopupOperator ? { l1_topup_operator: l1TopupOperator } : {}),
    },
    contracts,
    operator,
    tx_hashes: txHashes,
    ...(paymentMode ? { payment_mode: paymentMode } : {}),
  };
}

function inferTokenSource(
  txHash: DevnetDeployManifest["tx_hashes"]["accepted_asset_deploy"],
): "deployed" | "provided" | "reused" {
  if (txHash) {
    return "deployed";
  }
  return "provided";
}

function inferContractDeploySource(
  txHash: DevnetDeployManifest["tx_hashes"]["fpc_deploy"],
): "deployed" | "reused" {
  if (txHash) {
    return "deployed";
  }
  return "reused";
}

export function withLegacyDeployCompat(
  manifest: DevnetDeployManifest,
): DevnetDeployManifestWithCompat {
  return {
    ...manifest,
    aztec_node_url: manifest.network.node_url,
    l1_chain_id: manifest.network.l1_chain_id,
    operator: manifest.operator.address,
    accepted_asset: manifest.contracts.accepted_asset,
    fpc_address: manifest.contracts.fpc,
    credit_fpc_address: manifest.contracts.credit_fpc,
    node_contracts: {
      fee_juice_portal_address:
        manifest.aztec_required_addresses.l1_contract_addresses
          .feeJuicePortalAddress,
      fee_juice_address:
        manifest.aztec_required_addresses.l1_contract_addresses.feeJuiceAddress,
    },
    deploy: {
      token: {
        address: manifest.contracts.accepted_asset,
        source: inferTokenSource(manifest.tx_hashes.accepted_asset_deploy),
      },
      fpc: {
        address: manifest.contracts.fpc,
        source: inferContractDeploySource(manifest.tx_hashes.fpc_deploy),
      },
      credit_fpc: {
        address: manifest.contracts.credit_fpc,
        source: inferContractDeploySource(manifest.tx_hashes.credit_fpc_deploy),
      },
    },
  };
}

export function validateDevnetDeployManifest(
  input: unknown,
): DevnetDeployManifest {
  return parseManifest(input);
}

export function assertValidDevnetDeployManifest(
  input: unknown,
): asserts input is DevnetDeployManifest {
  parseManifest(input);
}

export function writeDevnetDeployManifest(
  outPath: string,
  input: unknown,
): DevnetDeployManifestWithCompat {
  const manifest = parseManifest(input);
  const withCompat = withLegacyDeployCompat(manifest);

  const absolute = path.resolve(outPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(withCompat, null, 2)}\n`, "utf8");

  return withCompat;
}

function buildSelfCheckFixture(): DevnetDeployManifest {
  return {
    status: "deploy_ok",
    generated_at: "2026-02-27T00:00:00.000Z",
    network: {
      node_url: "https://v4-devnet-2.aztec-labs.com/",
      node_version: "4.0.0-devnet.2-patch.2",
      l1_chain_id: 11155111,
      rollup_version: 615022430,
    },
    aztec_required_addresses: {
      l1_contract_addresses: {
        registryAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        rollupAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        inboxAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
        outboxAddress: "0xdddddddddddddddddddddddddddddddddddddddd",
        feeJuiceAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        feeJuicePortalAddress: "0xffffffffffffffffffffffffffffffffffffffff",
        feeAssetHandlerAddress: "0x1111111111111111111111111111111111111111",
      },
      protocol_contract_addresses: {
        instanceRegistry:
          "0x0000000000000000000000000000000000000000000000000000000000000002",
        classRegistry:
          "0x0000000000000000000000000000000000000000000000000000000000000003",
        multiCallEntrypoint:
          "0x0000000000000000000000000000000000000000000000000000000000000004",
        feeJuice:
          "0x0000000000000000000000000000000000000000000000000000000000000005",
      },
      sponsored_fpc_address:
        "0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2",
    },
    deployment_accounts: {
      l2_deployer: {
        alias: "my-wallet",
        address:
          "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        private_key_ref: "secret-manager://devnet/l2-deployer",
      },
    },
    contracts: {
      accepted_asset:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      fpc: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      credit_fpc:
        "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    },
    operator: {
      address:
        "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      pubkey_x: "123456789",
      pubkey_y: "987654321",
    },
    tx_hashes: {
      accepted_asset_deploy:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      fpc_deploy:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      credit_fpc_deploy:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
    },
    payment_mode: "fpc-sponsored",
  };
}

function expectThrow(description: string, fn: () => void): void {
  let didThrow = false;
  try {
    fn();
  } catch {
    didThrow = true;
  }
  if (!didThrow) {
    throw new Error(
      `Self-check expected failure did not occur: ${description}`,
    );
  }
}

function runSelfCheck(): void {
  const validFixture = buildSelfCheckFixture();
  const validated = validateDevnetDeployManifest(validFixture);
  const withCompat = withLegacyDeployCompat(validated);

  if (withCompat.accepted_asset !== validated.contracts.accepted_asset) {
    throw new Error(
      "Self-check failed: accepted_asset compat mapping mismatch",
    );
  }
  if (withCompat.fpc_address !== validated.contracts.fpc) {
    throw new Error("Self-check failed: fpc_address compat mapping mismatch");
  }

  expectThrow("missing required l1 fee bridge address", () => {
    const broken = buildSelfCheckFixture() as unknown as Record<
      string,
      unknown
    >;
    const aztecAddresses = broken.aztec_required_addresses as Record<
      string,
      unknown
    >;
    const l1Contracts = aztecAddresses.l1_contract_addresses as Record<
      string,
      unknown
    >;
    delete l1Contracts.feeJuicePortalAddress;
    validateDevnetDeployManifest(broken);
  });

  expectThrow("l2_deployer missing private_key and private_key_ref", () => {
    const broken = buildSelfCheckFixture() as unknown as Record<
      string,
      unknown
    >;
    const deploymentAccounts = broken.deployment_accounts as Record<
      string,
      unknown
    >;
    const l2Deployer = deploymentAccounts.l2_deployer as Record<
      string,
      unknown
    >;
    delete l2Deployer.private_key;
    delete l2Deployer.private_key_ref;
    validateDevnetDeployManifest(broken);
  });

  console.log("[devnet-manifest] self-check passed");
}

function usage(): string {
  return [
    "Usage:",
    "  bunx tsx scripts/contract/devnet-manifest.ts --self-check",
    "",
    "Exports:",
    "  - validateDevnetDeployManifest(input)",
    "  - assertValidDevnetDeployManifest(input)",
    "  - withLegacyDeployCompat(manifest)",
    "  - writeDevnetDeployManifest(outPath, input)",
  ].join("\n");
}

function main(argv: string[]): void {
  if (argv.includes("--self-check")) {
    runSelfCheck();
    return;
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }

  throw new ManifestValidationError(
    'No command provided. Use "--self-check" to run validator sanity checks.',
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (error instanceof ManifestValidationError) {
    console.error(`[devnet-manifest] ERROR: ${error.message}`);
    console.error(usage());
  } else {
    console.error("[devnet-manifest] Unexpected error:", error);
  }
  process.exit(1);
}

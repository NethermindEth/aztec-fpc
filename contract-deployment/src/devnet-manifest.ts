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
export type FpcArtifactName = "FPCMultiAsset";

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
    sponsored_fpc_address?: string;
  };
  deployer_address: string;
  contracts: {
    accepted_asset: string;
    fpc: string;
    faucet?: string;
    counter?: string;
    bridge?: string;
  };
  l1_contracts?: {
    token_portal: string;
    erc20: string;
  };
  fpc_artifact?: {
    name: FpcArtifactName;
    path: string;
  };
  operator: {
    address: string;
    pubkey_x: string;
    pubkey_y: string;
  };
  tx_hashes: {
    accepted_asset_deploy: string | null;
    fpc_deploy: string | null;
    faucet_deploy?: string | null;
    counter_deploy?: string | null;
    bridge_deploy?: string | null;
  };
  faucet_config?: {
    drip_amount: string;
    cooldown_seconds: number;
    initial_supply: string;
  };
  payment_mode?: string;
};

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

function requireString(root: Record<string, unknown>, key: string, context: string): string {
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

function requireIsoTimestamp(root: Record<string, unknown>, key: string, context: string): string {
  const value = requireString(root, key, context);
  if (Number.isNaN(Date.parse(value))) {
    throw new ManifestValidationError(`Invalid ${context}.${key}: not an ISO timestamp`);
  }
  return value;
}

function requireHttpUrl(root: Record<string, unknown>, key: string, context: string): string {
  const value = requireString(root, key, context);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ManifestValidationError(`Invalid ${context}.${key}: expected http(s) URL`);
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof ManifestValidationError) {
      throw error;
    }
    throw new ManifestValidationError(`Invalid ${context}.${key}: expected URL`);
  }
}

function parseAztecAddress(value: string, fieldPath: string): string {
  if (!AZTEC_ADDRESS_PATTERN.test(value) || ZERO_AZTEC_ADDRESS_PATTERN.test(value)) {
    throw new ManifestValidationError(`Invalid ${fieldPath}: expected non-zero Aztec address`);
  }
  return value;
}

function parseEthAddress(value: string, fieldPath: string): string {
  if (!ETH_ADDRESS_PATTERN.test(value) || ZERO_ETH_ADDRESS_PATTERN.test(value)) {
    throw new ManifestValidationError(`Invalid ${fieldPath}: expected non-zero EVM address`);
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
    throw new ManifestValidationError(`Invalid ${fieldPath}: expected tx hash or null`);
  }
  return value;
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
    throw new ManifestValidationError('Invalid manifest.status: expected "deploy_ok"');
  }

  const networkRaw = requireObject(input, "network", "manifest");
  const network = {
    node_url: requireHttpUrl(networkRaw, "node_url", "manifest.network"),
    node_version: requireString(networkRaw, "node_version", "manifest.network"),
    l1_chain_id: requirePositiveSafeInteger(networkRaw, "l1_chain_id", "manifest.network"),
    rollup_version: requirePositiveSafeInteger(networkRaw, "rollup_version", "manifest.network"),
  };

  const aztecAddressesRaw = requireObject(input, "aztec_required_addresses", "manifest");
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

  const sponsoredFpcAddressRaw = optionalString(
    aztecAddressesRaw,
    "sponsored_fpc_address",
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

  const deployerAddress = parseAztecAddress(
    requireString(input, "deployer_address", "manifest"),
    "manifest.deployer_address",
  );

  const contractsRaw = requireObject(input, "contracts", "manifest");
  const faucetAddressRaw = hasOwn(contractsRaw, "faucet")
    ? requireString(contractsRaw, "faucet", "manifest.contracts")
    : undefined;
  const counterAddressRaw = hasOwn(contractsRaw, "counter")
    ? requireString(contractsRaw, "counter", "manifest.contracts")
    : undefined;
  const bridgeAddressRaw = hasOwn(contractsRaw, "bridge")
    ? requireString(contractsRaw, "bridge", "manifest.contracts")
    : undefined;
  const contracts = {
    accepted_asset: parseAztecAddress(
      requireString(contractsRaw, "accepted_asset", "manifest.contracts"),
      "manifest.contracts.accepted_asset",
    ),
    fpc: parseAztecAddress(
      requireString(contractsRaw, "fpc", "manifest.contracts"),
      "manifest.contracts.fpc",
    ),
    ...(faucetAddressRaw !== undefined
      ? {
          faucet: parseAztecAddress(faucetAddressRaw, "manifest.contracts.faucet"),
        }
      : {}),
    ...(counterAddressRaw !== undefined
      ? {
          counter: parseAztecAddress(counterAddressRaw, "manifest.contracts.counter"),
        }
      : {}),
    ...(bridgeAddressRaw !== undefined
      ? {
          bridge: parseAztecAddress(bridgeAddressRaw, "manifest.contracts.bridge"),
        }
      : {}),
  };

  let l1Contracts: DevnetDeployManifest["l1_contracts"];
  if (hasOwn(input, "l1_contracts")) {
    const l1ContractsRaw2 = requireObject(input, "l1_contracts", "manifest");
    l1Contracts = {
      token_portal: parseEthAddress(
        requireString(l1ContractsRaw2, "token_portal", "manifest.l1_contracts"),
        "manifest.l1_contracts.token_portal",
      ),
      erc20: parseEthAddress(
        requireString(l1ContractsRaw2, "erc20", "manifest.l1_contracts"),
        "manifest.l1_contracts.erc20",
      ),
    };
  }

  let fpcArtifact: DevnetDeployManifest["fpc_artifact"];
  if (hasOwn(input, "fpc_artifact")) {
    const fpcArtifactRaw = requireObject(input, "fpc_artifact", "manifest");
    const artifactName = requireString(fpcArtifactRaw, "name", "manifest.fpc_artifact");
    if (artifactName !== "FPCMultiAsset") {
      throw new ManifestValidationError(
        'Invalid manifest.fpc_artifact.name: expected "FPCMultiAsset"',
      );
    }
    const artifactPath = requireString(fpcArtifactRaw, "path", "manifest.fpc_artifact");
    fpcArtifact = {
      name: artifactName,
      path: artifactPath,
    };
  }

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
    fpc_deploy: parseTxHashOrNull(txHashesRaw.fpc_deploy, "manifest.tx_hashes.fpc_deploy"),
    ...(hasOwn(txHashesRaw, "faucet_deploy")
      ? {
          faucet_deploy: parseTxHashOrNull(
            txHashesRaw.faucet_deploy,
            "manifest.tx_hashes.faucet_deploy",
          ),
        }
      : {}),
    ...(hasOwn(txHashesRaw, "counter_deploy")
      ? {
          counter_deploy: parseTxHashOrNull(
            txHashesRaw.counter_deploy,
            "manifest.tx_hashes.counter_deploy",
          ),
        }
      : {}),
    ...(hasOwn(txHashesRaw, "bridge_deploy")
      ? {
          bridge_deploy: parseTxHashOrNull(
            txHashesRaw.bridge_deploy,
            "manifest.tx_hashes.bridge_deploy",
          ),
        }
      : {}),
  };

  let faucetConfig: DevnetDeployManifest["faucet_config"];
  if (hasOwn(input, "faucet_config")) {
    const rawFc = requireObject(input, "faucet_config", "manifest");
    const dripAmount = requireString(rawFc, "drip_amount", "manifest.faucet_config");
    const cooldownSecondsRaw = rawFc.cooldown_seconds;
    const initialSupply = requireString(rawFc, "initial_supply", "manifest.faucet_config");
    if (!DECIMAL_UINT_PATTERN.test(dripAmount)) {
      throw new ManifestValidationError(
        "Invalid manifest.faucet_config.drip_amount: expected non-negative decimal integer",
      );
    }
    if (
      typeof cooldownSecondsRaw !== "number" ||
      !Number.isInteger(cooldownSecondsRaw) ||
      cooldownSecondsRaw < 0 ||
      !Number.isSafeInteger(cooldownSecondsRaw)
    ) {
      throw new ManifestValidationError(
        "Invalid manifest.faucet_config.cooldown_seconds: expected non-negative safe integer",
      );
    }
    if (!DECIMAL_UINT_PATTERN.test(initialSupply)) {
      throw new ManifestValidationError(
        "Invalid manifest.faucet_config.initial_supply: expected non-negative decimal integer",
      );
    }
    faucetConfig = {
      drip_amount: dripAmount,
      cooldown_seconds: cooldownSecondsRaw,
      initial_supply: initialSupply,
    };
  }

  const paymentMode = optionalString(input, "payment_mode", "manifest");

  return {
    status: "deploy_ok",
    generated_at: requireIsoTimestamp(input, "generated_at", "manifest"),
    network,
    aztec_required_addresses: {
      l1_contract_addresses: l1ContractAddresses,
      protocol_contract_addresses: protocolContractAddresses,
      ...(sponsoredFpcAddressRaw
        ? {
            sponsored_fpc_address: parseAztecAddress(
              sponsoredFpcAddressRaw,
              "manifest.aztec_required_addresses.sponsored_fpc_address",
            ),
          }
        : {}),
    },
    deployer_address: deployerAddress,
    contracts,
    ...(l1Contracts ? { l1_contracts: l1Contracts } : {}),
    ...(fpcArtifact ? { fpc_artifact: fpcArtifact } : {}),
    operator,
    tx_hashes: txHashes,
    ...(faucetConfig ? { faucet_config: faucetConfig } : {}),
    ...(paymentMode ? { payment_mode: paymentMode } : {}),
  };
}

export function validateDevnetDeployManifest(input: unknown): DevnetDeployManifest {
  return parseManifest(input);
}

export function assertValidDevnetDeployManifest(
  input: unknown,
): asserts input is DevnetDeployManifest {
  parseManifest(input);
}

export function writeDevnetDeployManifest(outPath: string, input: unknown): DevnetDeployManifest {
  const manifest = parseManifest(input);

  const absolute = path.resolve(outPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return manifest;
}

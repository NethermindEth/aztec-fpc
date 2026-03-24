import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config, SupportedAssetPolicy } from "./config.js";
import { normalizeAztecAddress } from "./config.js";

interface PersistedAssetPolicyStateFile {
  version: 1;
  supported_assets: SupportedAssetPolicy[];
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertFeeBips(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 10000) {
    throw new Error("fee_bips must be an integer in range [0, 10000]");
  }
}

function normalizeSupportedAssetPolicy(policy: SupportedAssetPolicy): SupportedAssetPolicy {
  const normalized = {
    address: normalizeAztecAddress(policy.address),
    name: policy.name.trim(),
    market_rate_num: policy.market_rate_num,
    market_rate_den: policy.market_rate_den,
    fee_bips: policy.fee_bips,
  };

  if (normalized.name.length === 0) {
    throw new Error("asset name must be non-empty");
  }
  assertPositiveInteger(normalized.market_rate_num, "market_rate_num");
  assertPositiveInteger(normalized.market_rate_den, "market_rate_den");
  assertFeeBips(normalized.fee_bips);

  return normalized;
}

function normalizeSupportedAssetPolicies(policies: SupportedAssetPolicy[]): SupportedAssetPolicy[] {
  if (policies.length === 0) {
    throw new Error("supported_assets must contain at least one asset");
  }

  const seen = new Set<string>();
  return policies.map((policy) => {
    const normalized = normalizeSupportedAssetPolicy(policy);
    if (seen.has(normalized.address)) {
      throw new Error(`Duplicate supported asset address: ${normalized.address}`);
    }
    seen.add(normalized.address);
    return normalized;
  });
}

async function writeJsonAtomically(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, `${contents}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function readStateFile(filePath: string): Promise<PersistedAssetPolicyStateFile | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;
    if (maybeNodeError.code === "ENOENT") {
      return null;
    }
    throw new Error(`Failed reading asset policy state file at ${filePath}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Asset policy state file is not valid JSON at ${filePath}`, { cause: error });
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Asset policy state file is malformed at ${filePath}: expected root object`);
  }

  const root = parsed as { version?: unknown; supported_assets?: unknown };
  if (root.version !== 1) {
    throw new Error(
      `Unsupported asset policy state version in ${filePath}: ${String(root.version)}`,
    );
  }
  if (!Array.isArray(root.supported_assets)) {
    throw new Error(
      `Asset policy state file is malformed at ${filePath}: supported_assets must be an array`,
    );
  }

  return {
    version: 1,
    supported_assets: normalizeSupportedAssetPolicies(
      root.supported_assets as SupportedAssetPolicy[],
    ),
  };
}

export interface AssetPolicyStore {
  getAll(): SupportedAssetPolicy[];
  upsert(policy: SupportedAssetPolicy): Promise<SupportedAssetPolicy>;
  remove(address: string): Promise<SupportedAssetPolicy>;
}

export class MemoryAssetPolicyStore implements AssetPolicyStore {
  private supportedAssets: SupportedAssetPolicy[];

  constructor(initialPolicies: SupportedAssetPolicy[]) {
    this.supportedAssets = normalizeSupportedAssetPolicies(initialPolicies);
  }

  getAll(): SupportedAssetPolicy[] {
    return this.supportedAssets.map((asset) => ({ ...asset }));
  }

  upsert(policy: SupportedAssetPolicy): Promise<SupportedAssetPolicy> {
    const normalized = normalizeSupportedAssetPolicy(policy);
    const index = this.supportedAssets.findIndex((asset) => asset.address === normalized.address);
    if (index >= 0) {
      this.supportedAssets[index] = normalized;
    } else {
      this.supportedAssets = [...this.supportedAssets, normalized];
    }
    this.supportedAssets.sort((left, right) => left.name.localeCompare(right.name));
    return Promise.resolve({ ...normalized });
  }

  remove(address: string): Promise<SupportedAssetPolicy> {
    if (this.supportedAssets.length === 1) {
      throw new Error("Cannot remove the last supported asset");
    }

    const normalizedAddress = normalizeAztecAddress(address);
    const index = this.supportedAssets.findIndex((asset) => asset.address === normalizedAddress);
    if (index < 0) {
      throw new Error(`Supported asset not found: ${normalizedAddress}`);
    }

    const [removed] = this.supportedAssets.splice(index, 1);
    return Promise.resolve(removed);
  }
}

export class FileBackedAssetPolicyStore implements AssetPolicyStore {
  private supportedAssets: SupportedAssetPolicy[];

  private constructor(
    private readonly filePath: string,
    initialPolicies: SupportedAssetPolicy[],
  ) {
    this.supportedAssets = normalizeSupportedAssetPolicies(initialPolicies);
  }

  static async create(config: Config): Promise<FileBackedAssetPolicyStore> {
    const storedState = await readStateFile(config.asset_policy_state_path);
    const initialPolicies = storedState?.supported_assets ?? config.supported_assets;
    const store = new FileBackedAssetPolicyStore(config.asset_policy_state_path, initialPolicies);

    if (!storedState) {
      await store.persist();
    }

    return store;
  }

  getAll(): SupportedAssetPolicy[] {
    return this.supportedAssets.map((asset) => ({ ...asset }));
  }

  async upsert(policy: SupportedAssetPolicy): Promise<SupportedAssetPolicy> {
    const normalized = normalizeSupportedAssetPolicy(policy);
    const index = this.supportedAssets.findIndex((asset) => asset.address === normalized.address);
    if (index >= 0) {
      this.supportedAssets[index] = normalized;
    } else {
      this.supportedAssets = [...this.supportedAssets, normalized];
    }
    this.supportedAssets.sort((left, right) => left.name.localeCompare(right.name));
    await this.persist();
    return { ...normalized };
  }

  async remove(address: string): Promise<SupportedAssetPolicy> {
    if (this.supportedAssets.length === 1) {
      throw new Error("Cannot remove the last supported asset");
    }

    const normalizedAddress = normalizeAztecAddress(address);
    const index = this.supportedAssets.findIndex((asset) => asset.address === normalizedAddress);
    if (index < 0) {
      throw new Error(`Supported asset not found: ${normalizedAddress}`);
    }

    const [removed] = this.supportedAssets.splice(index, 1);
    await this.persist();
    return removed;
  }

  private async persist(): Promise<void> {
    const payload: PersistedAssetPolicyStateFile = {
      version: 1,
      supported_assets: this.supportedAssets,
    };
    await writeJsonAtomically(this.filePath, JSON.stringify(payload, null, 2));
  }
}

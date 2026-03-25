import { open, type RootDatabase } from "lmdb";
import type { Config, SupportedAssetPolicy } from "./config.js";
import { normalizeAztecAddress } from "./config.js";

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

export interface AssetPolicyStore {
  getAll(): SupportedAssetPolicy[];
  upsert(policy: SupportedAssetPolicy): Promise<SupportedAssetPolicy>;
  remove(address: string): Promise<SupportedAssetPolicy>;
  close(): Promise<void>;
}

export class LmdbAssetPolicyStore implements AssetPolicyStore {
  private readonly db: RootDatabase<SupportedAssetPolicy, string>;

  constructor(config: Config) {
    this.db = open<SupportedAssetPolicy, string>({
      path: config.asset_policy_state_path,
    });

    if (this.db.getKeysCount() === 0) {
      const normalized = normalizeSupportedAssetPolicies(config.supported_assets);
      for (const policy of normalized) {
        this.db.putSync(policy.address, policy);
      }
    }
  }

  getAll(): SupportedAssetPolicy[] {
    const entries: SupportedAssetPolicy[] = [];
    for (const { value } of this.db.getRange()) {
      entries.push({ ...value });
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    return entries;
  }

  async upsert(policy: SupportedAssetPolicy): Promise<SupportedAssetPolicy> {
    const normalized = normalizeSupportedAssetPolicy(policy);
    await this.db.put(normalized.address, normalized);
    return { ...normalized };
  }

  async remove(address: string): Promise<SupportedAssetPolicy> {
    if (this.db.getKeysCount() <= 1) {
      throw new Error("Cannot remove the last supported asset");
    }

    const normalizedAddress = normalizeAztecAddress(address);
    const existing = this.db.get(normalizedAddress);
    if (!existing) {
      throw new Error(`Supported asset not found: ${normalizedAddress}`);
    }

    const removed = await this.db.remove(normalizedAddress);
    if (!removed) {
      throw new Error(`Failed to remove supported asset: ${normalizedAddress}`);
    }

    return existing;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

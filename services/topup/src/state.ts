import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { open, type RootDatabase } from "lmdb";
import type { BridgeResult } from "./bridge.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 doesn't kill — it checks if the process exists (POSIX convention)
    return true;
  } catch {
    return false;
  }
}

export async function acquireProcessLock(lockPath: string): Promise<void> {
  try {
    const existing = await readFile(lockPath, "utf8");
    const existingPid = Number.parseInt(existing.trim(), 10);
    if (!Number.isNaN(existingPid) && isProcessAlive(existingPid)) {
      throw new Error(
        `Another topup service instance is running (pid=${existingPid}, lock=${lockPath}). ` +
          "Stop the other instance or remove the stale lock file.",
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function releaseProcessLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
}

export interface PersistedBridgeSubmission {
  baselineBalance: string;
  amount: string;
  claimSecret: string;
  claimSecretHash: string;
  messageHash: `0x${string}`;
  messageLeafIndex: string;
  submittedAtMs: number;
}

export interface BridgeStateStore {
  storageLabel: string;
  read(): Promise<PersistedBridgeSubmission | null>;
  write(
    baselineBalance: bigint,
    bridgeResult: Pick<
      BridgeResult,
      | "amount"
      | "claimSecret"
      | "claimSecretHash"
      | "messageHash"
      | "messageLeafIndex"
      | "submittedAtMs"
    >,
  ): Promise<void>;
  clear(): Promise<void>;
}

const UINT_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const FIELD_HEX_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function assertUintString(context: string, field: string, value: unknown): string {
  if (typeof value !== "string" || !UINT_DECIMAL_PATTERN.test(value)) {
    throw new Error(
      `Bridge state is malformed (${context}): ${field} must be an unsigned integer string`,
    );
  }
  return value;
}

function assertFieldHexString(context: string, field: string, value: unknown): string {
  if (typeof value !== "string" || !FIELD_HEX_PATTERN.test(value)) {
    throw new Error(
      `Bridge state is malformed (${context}): ${field} must be a 32-byte 0x-prefixed hex string`,
    );
  }
  return value;
}

function assertPersistedBridgeSubmission(
  context: string,
  value: unknown,
): PersistedBridgeSubmission {
  if (!value || typeof value !== "object") {
    throw new Error(`Bridge state is malformed (${context}): expected object`);
  }

  const candidate = value as {
    baselineBalance?: unknown;
    amount?: unknown;
    claimSecret?: unknown;
    claimSecretHash?: unknown;
    messageHash?: unknown;
    messageLeafIndex?: unknown;
    submittedAtMs?: unknown;
  };
  if (typeof candidate.submittedAtMs !== "number") {
    throw new Error(`Bridge state is malformed (${context}): invalid bridge payload`);
  }
  if (!Number.isInteger(candidate.submittedAtMs) || candidate.submittedAtMs < 0) {
    throw new Error(
      `Bridge state is malformed (${context}): submittedAtMs must be a non-negative integer`,
    );
  }

  const baselineBalance = assertUintString(context, "baselineBalance", candidate.baselineBalance);
  const amount = assertUintString(context, "amount", candidate.amount);
  if (BigInt(amount) <= 0n) {
    throw new Error(`Bridge state is malformed (${context}): amount must be greater than zero`);
  }
  const claimSecret = assertFieldHexString(context, "claimSecret", candidate.claimSecret);
  const claimSecretHash = assertFieldHexString(
    context,
    "claimSecretHash",
    candidate.claimSecretHash,
  );
  const messageHash = assertFieldHexString(context, "messageHash", candidate.messageHash);
  const messageLeafIndex = assertUintString(
    context,
    "messageLeafIndex",
    candidate.messageLeafIndex,
  );

  return {
    baselineBalance,
    amount,
    claimSecret,
    claimSecretHash,
    messageHash: messageHash as `0x${string}`,
    messageLeafIndex,
    submittedAtMs: candidate.submittedAtMs,
  };
}

const BRIDGE_KEY = "bridge";

export async function openTopupDatabase(dataDir: string): Promise<RootDatabase> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  return open({ path: dataDir, mapSize: 10 * 1024 * 1024 });
}

export function createLmdbBridgeStateStore(db: RootDatabase, dataDir: string): BridgeStateStore {
  const storageLabel = `lmdb://${dataDir}`;
  return {
    storageLabel,
    read(): Promise<PersistedBridgeSubmission | null> {
      const raw = db.get(BRIDGE_KEY);
      if (raw === undefined) {
        return Promise.resolve(null);
      }
      return Promise.resolve(assertPersistedBridgeSubmission(storageLabel, raw));
    },
    async write(
      baselineBalance: bigint,
      bridgeResult: Pick<
        BridgeResult,
        | "amount"
        | "claimSecret"
        | "claimSecretHash"
        | "messageHash"
        | "messageLeafIndex"
        | "submittedAtMs"
      >,
    ): Promise<void> {
      const payload: PersistedBridgeSubmission = {
        baselineBalance: baselineBalance.toString(),
        amount: bridgeResult.amount.toString(),
        // Plaintext is acceptable: the operator's L1 private key lives at the same
        // privilege level, the data dir is 0o700, and the entry is cleared on confirmation.
        claimSecret: bridgeResult.claimSecret,
        claimSecretHash: bridgeResult.claimSecretHash,
        messageHash: bridgeResult.messageHash,
        messageLeafIndex: bridgeResult.messageLeafIndex.toString(),
        submittedAtMs: bridgeResult.submittedAtMs,
      };
      await db.put(BRIDGE_KEY, payload);
    },
    async clear(): Promise<void> {
      await db.remove(BRIDGE_KEY);
    },
  };
}

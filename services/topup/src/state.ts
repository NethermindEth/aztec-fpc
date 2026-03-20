import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BridgeResult } from "./bridge.js";

// PID-based singleton lock

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
    const maybeNodeError = error as NodeJS.ErrnoException;
    if (maybeNodeError.code !== "ENOENT") {
      // Re-throw unless the lock file simply doesn't exist
      if (maybeNodeError.message?.includes("Another topup service")) {
        throw error;
      }
    }
  }
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function releaseProcessLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
}

interface PersistedBridgeStateFile {
  version: 1;
  bridge: PersistedBridgeSubmission;
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
  filePath: string;
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

function assertUintString(filePath: string, field: string, value: unknown): string {
  if (typeof value !== "string" || !UINT_DECIMAL_PATTERN.test(value)) {
    throw new Error(
      `Bridge state file is malformed at ${filePath}: ${field} must be an unsigned integer string`,
    );
  }
  return value;
}

function assertFieldHexString(filePath: string, field: string, value: unknown): string {
  if (typeof value !== "string" || !FIELD_HEX_PATTERN.test(value)) {
    throw new Error(
      `Bridge state file is malformed at ${filePath}: ${field} must be a 32-byte 0x-prefixed hex string`,
    );
  }
  return value;
}

function assertPersistedBridgeSubmission(
  filePath: string,
  value: unknown,
): PersistedBridgeSubmission {
  if (!value || typeof value !== "object") {
    throw new Error(`Bridge state file is malformed at ${filePath}: expected object`);
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
    throw new Error(`Bridge state file is malformed at ${filePath}: invalid bridge payload`);
  }
  if (!Number.isInteger(candidate.submittedAtMs) || candidate.submittedAtMs < 0) {
    throw new Error(
      `Bridge state file is malformed at ${filePath}: submittedAtMs must be a non-negative integer`,
    );
  }

  const baselineBalance = assertUintString(filePath, "baselineBalance", candidate.baselineBalance);
  const amount = assertUintString(filePath, "amount", candidate.amount);
  if (BigInt(amount) <= 0n) {
    throw new Error(
      `Bridge state file is malformed at ${filePath}: amount must be greater than zero`,
    );
  }
  const claimSecret = assertFieldHexString(filePath, "claimSecret", candidate.claimSecret);
  const claimSecretHash = assertFieldHexString(
    filePath,
    "claimSecretHash",
    candidate.claimSecretHash,
  );
  const messageHash = assertFieldHexString(filePath, "messageHash", candidate.messageHash);
  const messageLeafIndex = assertUintString(
    filePath,
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

async function writeJsonAtomically(filePath: string, contents: string) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, `${contents}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

const MAX_STATE_FILE_SIZE = 1_048_576; // 1 MiB

async function readBridgeStateFile(filePath: string): Promise<string | null> {
  let fd: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fd = await open(filePath, "r");
    const fileStat = await fd.stat();
    if (fileStat.size > MAX_STATE_FILE_SIZE) {
      throw new Error(
        `Bridge state file at ${filePath} is ${fileStat.size} bytes, exceeding maximum ${MAX_STATE_FILE_SIZE}`,
      );
    }
    return await fd.readFile("utf8");
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;
    if (maybeNodeError.code === "ENOENT") {
      return null;
    }
    throw new Error(`Failed reading bridge state file at ${filePath}`, {
      cause: error,
    });
  } finally {
    await fd?.close();
  }
}

function parseBridgeStateFile(filePath: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Bridge state file is not valid JSON at ${filePath}`, {
      cause: error,
    });
  }
}

function parsePersistedBridgeSubmission(
  filePath: string,
  parsed: unknown,
): PersistedBridgeSubmission {
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Bridge state file is malformed at ${filePath}: expected root object`);
  }

  const root = parsed as { version?: unknown; bridge?: unknown };
  if (root.version !== 1) {
    throw new Error(`Unsupported bridge state version in ${filePath}: ${String(root.version)}`);
  }

  return assertPersistedBridgeSubmission(filePath, root.bridge);
}

async function readPersistedBridgeSubmission(
  filePath: string,
): Promise<PersistedBridgeSubmission | null> {
  const raw = await readBridgeStateFile(filePath);
  if (raw === null) {
    return null;
  }
  const parsed = parseBridgeStateFile(filePath, raw);
  return parsePersistedBridgeSubmission(filePath, parsed);
}

export function createBridgeStateStore(filePath: string): BridgeStateStore {
  return {
    filePath,
    read(): Promise<PersistedBridgeSubmission | null> {
      return readPersistedBridgeSubmission(filePath);
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
      // claimSecret is stored in plaintext. This is acceptable because:
      // 1. The operator's L1 private key (which controls the entire bridge wallet)
      //    is held in-process memory at the same privilege level — any attacker
      //    who can read this file can also read the operator key from
      //    /proc/<pid>/environ or process memory, which is strictly more valuable.
      // 2. Encrypting with a key derived from the operator key is circular: if the
      //    attacker has one, they have both.
      // 3. The file is short-lived (cleared after confirmation), written with
      //    restrictive permissions (0o600), and protected by a PID-based singleton
      //    lock — the exposure window is bounded by the confirmation timeout.
      // 4. If the state file is exposed through a different vector (e.g. backup
      //    leak, misconfigured volume mount), the claim secret only allows
      //    front-running a single in-flight L2 claim, not draining the wallet.
      const payload: PersistedBridgeStateFile = {
        version: 1,
        bridge: {
          baselineBalance: baselineBalance.toString(),
          amount: bridgeResult.amount.toString(),
          claimSecret: bridgeResult.claimSecret,
          claimSecretHash: bridgeResult.claimSecretHash,
          messageHash: bridgeResult.messageHash,
          messageLeafIndex: bridgeResult.messageLeafIndex.toString(),
          submittedAtMs: bridgeResult.submittedAtMs,
        },
      };

      await writeJsonAtomically(filePath, JSON.stringify(payload));
    },
    async clear(): Promise<void> {
      await rm(filePath, { force: true });
    },
  };
}

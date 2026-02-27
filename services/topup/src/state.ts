import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BridgeResult } from "./bridge.js";

interface PersistedBridgeStateFile {
  version: 1;
  bridge: PersistedBridgeSubmission;
}

export interface PersistedBridgeSubmission {
  baselineBalance: string;
  amount: string;
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

function assertUintString(
  filePath: string,
  field: string,
  value: unknown,
): string {
  if (typeof value !== "string" || !UINT_DECIMAL_PATTERN.test(value)) {
    throw new Error(
      `Bridge state file is malformed at ${filePath}: ${field} must be an unsigned integer string`,
    );
  }
  return value;
}

function assertFieldHexString(
  filePath: string,
  field: string,
  value: unknown,
): string {
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
    throw new Error(
      `Bridge state file is malformed at ${filePath}: expected object`,
    );
  }

  const candidate = value as {
    baselineBalance?: unknown;
    amount?: unknown;
    claimSecretHash?: unknown;
    messageHash?: unknown;
    messageLeafIndex?: unknown;
    submittedAtMs?: unknown;
  };
  if (typeof candidate.submittedAtMs !== "number") {
    throw new Error(
      `Bridge state file is malformed at ${filePath}: invalid bridge payload`,
    );
  }
  if (
    !Number.isInteger(candidate.submittedAtMs) ||
    candidate.submittedAtMs < 0
  ) {
    throw new Error(
      `Bridge state file is malformed at ${filePath}: submittedAtMs must be a non-negative integer`,
    );
  }

  const baselineBalance = assertUintString(
    filePath,
    "baselineBalance",
    candidate.baselineBalance,
  );
  const amount = assertUintString(filePath, "amount", candidate.amount);
  if (BigInt(amount) <= 0n) {
    throw new Error(
      `Bridge state file is malformed at ${filePath}: amount must be greater than zero`,
    );
  }
  const claimSecretHash = assertFieldHexString(
    filePath,
    "claimSecretHash",
    candidate.claimSecretHash,
  );
  const messageHash = assertFieldHexString(
    filePath,
    "messageHash",
    candidate.messageHash,
  );
  const messageLeafIndex = assertUintString(
    filePath,
    "messageLeafIndex",
    candidate.messageLeafIndex,
  );

  return {
    baselineBalance,
    amount,
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

export function createBridgeStateStore(filePath: string): BridgeStateStore {
  return {
    filePath,
    async read(): Promise<PersistedBridgeSubmission | null> {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        const maybeNodeError = error as NodeJS.ErrnoException;
        if (maybeNodeError.code === "ENOENT") {
          return null;
        }
        throw new Error(`Failed reading bridge state file at ${filePath}`, {
          cause: error,
        });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new Error(`Bridge state file is not valid JSON at ${filePath}`, {
          cause: error,
        });
      }

      if (!parsed || typeof parsed !== "object") {
        throw new Error(
          `Bridge state file is malformed at ${filePath}: expected root object`,
        );
      }

      const root = parsed as { version?: unknown; bridge?: unknown };
      if (root.version !== 1) {
        throw new Error(
          `Unsupported bridge state version in ${filePath}: ${String(root.version)}`,
        );
      }

      return assertPersistedBridgeSubmission(filePath, root.bridge);
    },
    async write(
      baselineBalance: bigint,
      bridgeResult: Pick<
        BridgeResult,
        | "amount"
        | "claimSecretHash"
        | "messageHash"
        | "messageLeafIndex"
        | "submittedAtMs"
      >,
    ): Promise<void> {
      const payload: PersistedBridgeStateFile = {
        version: 1,
        bridge: {
          baselineBalance: baselineBalance.toString(),
          amount: bridgeResult.amount.toString(),
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

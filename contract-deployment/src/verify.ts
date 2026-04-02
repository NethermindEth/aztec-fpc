import type { AztecNode } from "@aztec/aztec.js/node";
import pino from "pino";
import { FpcImmutableVerificationError, verifyFpcImmutablesOnStartup } from "./fpc-immutables.js";
import type { DeployManifest } from "./manifest.js";

export {
  computeExpectedFpcInitializationHash,
  type FpcImmutableInputs,
  FpcImmutableVerificationError,
  type FpcImmutableVerificationReason,
  verifyFpcImmutablesOnStartup,
} from "./fpc-immutables.js";

const pinoLogger = pino();

function formatCheckIssues(issues: string[]): string {
  if (issues.length === 0) {
    return "<none>";
  }
  return issues.map((issue) => `  - ${issue}`).join("\n");
}

function isRetryableVerificationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error);
  return (
    (message.includes("block") && message.includes("not found")) ||
    message.includes("reorg") ||
    message.includes("timeout") ||
    message.includes("temporarily unavailable")
  );
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function stringifyWithToString(value: unknown, context: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (
    value &&
    typeof value === "object" &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    return value.toString();
  }
  throw new Error(
    `${context} returned invalid value ${String(value)} (expected string-like output)`,
  );
}

function isZeroFieldLike(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return true;
  }
  if (/^0x0+$/i.test(trimmed)) {
    return true;
  }
  if (/^0+$/.test(trimmed)) {
    return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyAttempt(params: {
  manifest: DeployManifest;
  node: AztecNode;
}): Promise<string[]> {
  const { manifest, node } = params;
  const issues: string[] = [];

  const contracts = [
    {
      key: "fpc",
      address: manifest.contracts.fpc,
    },
  ] as const;

  for (const contract of contracts) {
    const address = contract.address;

    const deployed = await node.getContract(address);
    if (!deployed) {
      issues.push(`on-chain contract missing: ${contract.key} at ${contract.address}`);
      continue;
    }

    const deployedRecord = asObjectRecord(deployed);
    if (!deployedRecord) {
      issues.push(`invalid on-chain contract payload for ${contract.key} at ${contract.address}`);
      continue;
    }

    const initializationHashRaw = deployedRecord.initializationHash;
    if (!initializationHashRaw) {
      issues.push(`missing initialization hash for ${contract.key}`);
    } else {
      const initializationHash = stringifyWithToString(
        initializationHashRaw,
        `${contract.key} initialization hash`,
      );
      if (isZeroFieldLike(initializationHash)) {
        issues.push(`contract appears uninitialized (zero initialization hash): ${contract.key}`);
      }
    }

    const classId = deployedRecord.currentContractClassId;
    if (!classId) {
      issues.push(`missing current contract class id for ${contract.key}`);
      continue;
    }
    const classPayload = await node.getContractClass(
      classId as Parameters<AztecNode["getContractClass"]>[0],
    );
    if (!classPayload) {
      issues.push(`contract class not publicly registered: ${contract.key}`);
    }
  }

  try {
    await verifyFpcImmutablesOnStartup(node, {
      fpcAddress: manifest.contracts.fpc,
      operatorAddress: manifest.operator.address,
      operatorPubkeyX: manifest.operator.pubkey_x,
      operatorPubkeyY: manifest.operator.pubkey_y,
    });
  } catch (error) {
    if (error instanceof FpcImmutableVerificationError && error.reason === "IMMUTABLE_MISMATCH") {
      throw new Error(
        `FPC immutable mismatch detected and will not recover with retries: ${error.message}`,
      );
    }
    issues.push(`fpc immutable verification pending: ${String(error)}`);
  }

  return issues;
}

export interface VerifyDeploymentOptions {
  manifest: DeployManifest;
  node: AztecNode;
  maxAttempts?: number;
  pollMs?: number;
}

export async function verifyDeployment(options: VerifyDeploymentOptions): Promise<void> {
  const { manifest, node, maxAttempts = 20, pollMs = 3_000 } = options;

  let lastIssues: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      lastIssues = await verifyAttempt({ manifest, node });
    } catch (error) {
      if (!isRetryableVerificationError(error) || attempt >= maxAttempts) {
        throw error;
      }
      pinoLogger.warn(
        `[verify-fpc-devnet] transient verification error on attempt ${attempt}/${maxAttempts}: ${String(error)}`,
      );
      pinoLogger.warn(`[verify-fpc-devnet] retrying in ${pollMs}ms after transient error`);
      await sleep(pollMs);
      continue;
    }

    if (lastIssues.length === 0) {
      pinoLogger.info(
        `[verify-fpc-devnet] verification passed on attempt ${attempt}/${maxAttempts}`,
      );
      pinoLogger.info(`[verify-fpc-devnet] contracts ready: fpc=${manifest.contracts.fpc}`);
      return;
    }

    if (attempt < maxAttempts) {
      pinoLogger.warn(
        `[verify-fpc-devnet] verification pending on attempt ${attempt}/${maxAttempts}:\n${formatCheckIssues(lastIssues)}`,
      );
      pinoLogger.warn(`[verify-fpc-devnet] retrying in ${pollMs}ms while metadata/state settles`);
      await sleep(pollMs);
    }
  }

  throw new Error(
    `[verify-fpc-devnet] verification failed after ${maxAttempts} attempts:\n${formatCheckIssues(lastIssues)}`,
  );
}

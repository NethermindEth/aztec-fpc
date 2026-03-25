import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import { waitForFeeJuiceBridgeConfirmation } from "./confirm.js";
import type { GetFeeJuiceBalance } from "./monitor.js";
import type { BridgeStateStore, PersistedBridgeSubmission } from "./state.js";

export type ReconciliationOutcome = "none" | "confirmed" | "timeout" | "aborted";

export interface ReconcileBridgeStateOptions {
  stateStore: BridgeStateStore;
  getBalance: GetFeeJuiceBalance;
  node: Pick<AztecNode, "getBlock" | "getL1ToL2MessageCheckpoint">;
  fpcAddress: AztecAddress;
  timeoutMs: number;
  initialPollMs: number;
  maxPollMs: number;
  abortSignal?: AbortSignal;
  logger?: Pick<Console, "log" | "warn">;
  /** Evict persisted bridge older than this (ms). Breaks reconciliation deadlock. */
  maxAgeMs?: number;
  /** Factory that builds an onMessageReady callback from the persisted bridge (e.g., to trigger auto-claim). */
  buildOnMessageReady?: (persisted: PersistedBridgeSubmission) => (() => Promise<void>) | undefined;
}

export interface ReconcileBridgeDeps {
  confirmBridge: typeof waitForFeeJuiceBridgeConfirmation;
}

const DEFAULT_RECONCILE_DEPS: ReconcileBridgeDeps = {
  confirmBridge: waitForFeeJuiceBridgeConfirmation,
};

export async function reconcilePersistedBridgeState(
  options: ReconcileBridgeStateOptions,
  depsOverride: Partial<ReconcileBridgeDeps> = {},
): Promise<ReconciliationOutcome> {
  const logger = options.logger ?? console;
  const deps: ReconcileBridgeDeps = {
    ...DEFAULT_RECONCILE_DEPS,
    ...depsOverride,
  };
  let persistedBridge: PersistedBridgeSubmission | null;
  try {
    persistedBridge = await options.stateStore.read();
  } catch (error) {
    logger.warn(`Failed to read persisted bridge state: ${String(error)}. Clearing corrupt entry.`);
    try {
      await options.stateStore.clear();
    } catch {
      // Already logged the root cause above; clearing is best-effort.
    }
    return "none";
  }

  if (!persistedBridge) {
    return "none";
  }

  if (options.maxAgeMs !== undefined) {
    const ageMs = Date.now() - persistedBridge.submittedAtMs;
    if (ageMs > options.maxAgeMs) {
      logger.warn(
        `CRITICAL: Evicting stale persisted bridge message_hash=${persistedBridge.messageHash} age_ms=${ageMs} max_age_ms=${options.maxAgeMs}. Bridge funds may require manual recovery.`,
      );
      await options.stateStore.clear();
      return "none";
    }
  }

  const baselineBalance = BigInt(persistedBridge.baselineBalance);
  logger.log(
    `Reconciling persisted bridge operation message_hash=${persistedBridge.messageHash} submitted_at_ms=${persistedBridge.submittedAtMs} baseline=${baselineBalance} amount=${persistedBridge.amount}`,
  );

  const result = await deps.confirmBridge({
    getBalance: options.getBalance,
    fpcAddress: options.fpcAddress,
    baselineBalance,
    timeoutMs: options.timeoutMs,
    initialPollMs: options.initialPollMs,
    maxPollMs: options.maxPollMs,
    abortSignal: options.abortSignal,
    messageContext: {
      node: options.node,
      messageHash: persistedBridge.messageHash,
    },
    onMessageReady: options.buildOnMessageReady?.(persistedBridge),
  });

  if (result.status === "aborted") {
    logger.warn(
      `Persisted bridge reconciliation aborted message_hash=${persistedBridge.messageHash}`,
    );
    return "aborted";
  }

  if (result.status === "confirmed") {
    await options.stateStore.clear();
    logger.log(
      `Persisted bridge reconciliation outcome=confirmed message_hash=${persistedBridge.messageHash} delta=${result.observedDelta} attempts=${result.attempts} elapsed_ms=${result.elapsedMs}`,
    );
    return "confirmed";
  }

  logger.warn(
    `Persisted bridge reconciliation outcome=timeout message_hash=${persistedBridge.messageHash} delta=${result.observedDelta} attempts=${result.attempts} elapsed_ms=${result.elapsedMs}; preserving state for retry`,
  );
  return "timeout";
}

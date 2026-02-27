import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import { waitForFeeJuiceBridgeConfirmation } from "./confirm.js";
import type { FeeJuiceBalanceReader } from "./monitor.js";
import type { BridgeStateStore } from "./state.js";

export type ReconciliationOutcome =
  | "none"
  | "confirmed"
  | "timeout"
  | "aborted";

export interface ReconcileBridgeStateOptions {
  stateStore: BridgeStateStore;
  balanceReader: FeeJuiceBalanceReader;
  node: Pick<AztecNode, "getBlockNumber" | "getL1ToL2MessageBlock">;
  fpcAddress: AztecAddress;
  timeoutMs: number;
  initialPollMs: number;
  maxPollMs: number;
  abortSignal?: AbortSignal;
  logger?: Pick<Console, "log" | "warn">;
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
  const persistedBridge = await options.stateStore.read();

  if (!persistedBridge) {
    return "none";
  }

  const baselineBalance = BigInt(persistedBridge.baselineBalance);
  logger.log(
    `Reconciling persisted bridge operation message_hash=${persistedBridge.messageHash} submitted_at_ms=${persistedBridge.submittedAtMs} baseline=${baselineBalance} amount=${persistedBridge.amount}`,
  );

  const result = await deps.confirmBridge({
    balanceReader: options.balanceReader,
    fpcAddress: options.fpcAddress,
    baselineBalance,
    timeoutMs: options.timeoutMs,
    initialPollMs: options.initialPollMs,
    maxPollMs: options.maxPollMs,
    abortSignal: options.abortSignal,
    messageContext: {
      node: options.node,
      messageHash: persistedBridge.messageHash,
      forPublicConsumption: false,
    },
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

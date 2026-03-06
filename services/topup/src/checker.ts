import type { BridgeResult } from "./bridge.js";
import type { BridgeConfirmationResult } from "./confirm.js";

export interface TopupCheckerConfig {
  threshold: bigint;
  topUpAmount: bigint;
  logClaimSecret?: boolean;
}

export interface TopupCheckerDependencies {
  getBalance: () => Promise<bigint>;
  bridge: (amount: bigint) => Promise<BridgeResult>;
  confirm: (
    baselineBalance: bigint,
    bridgeResult: BridgeResult,
  ) => Promise<BridgeConfirmationResult>;
  onBridgeSubmitted?: (baselineBalance: bigint, bridgeResult: BridgeResult) => Promise<void> | void;
  onBridgeSettled?: (
    baselineBalance: bigint,
    bridgeResult: BridgeResult,
    confirmation: BridgeConfirmationResult,
  ) => Promise<void> | void;
  onBridgeFailed?: (error: unknown) => Promise<void> | void;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export interface TopupChecker {
  checkAndTopUp: () => Promise<void>;
  isBridgeInFlight: () => boolean;
  requestStop: () => void;
  isStopping: () => boolean;
}

function shouldSkipCheck(
  stopping: boolean,
  bridgeInFlight: boolean,
  logger: Pick<Console, "log" | "warn" | "error">,
): boolean {
  if (stopping) {
    logger.log("Shutdown requested, skipping top-up check");
    return true;
  }
  if (bridgeInFlight) {
    logger.log("Bridge already in-flight, skipping check");
    return true;
  }
  return false;
}

function shouldSubmitBridge(
  balance: bigint,
  threshold: bigint,
  stopping: boolean,
  logger: Pick<Console, "log" | "warn" | "error">,
): boolean {
  if (balance >= threshold) {
    return false;
  }
  if (stopping) {
    logger.log("Shutdown requested, skipping bridge submission");
    return false;
  }
  return true;
}

function logBridgeConfirmationOutcome(
  logger: Pick<Console, "log" | "warn" | "error">,
  confirmation: BridgeConfirmationResult,
): void {
  if (confirmation.status === "confirmed") {
    logger.log(
      `Bridge confirmation outcome=confirmed delta=${confirmation.observedDelta} baseline=${confirmation.baselineBalance} current=${confirmation.lastObservedBalance} attempts=${confirmation.attempts} poll_errors=${confirmation.pollErrors} message_ready=${confirmation.messageReady} message_check_attempted=${confirmation.messageCheckAttempted} message_check_failed=${confirmation.messageCheckFailed} message_action_attempted=${confirmation.messageReadyActionAttempted} message_action_succeeded=${confirmation.messageReadyActionSucceeded} message_action_failed=${confirmation.messageReadyActionFailed} elapsed_ms=${confirmation.elapsedMs}`,
    );
    return;
  }
  if (confirmation.status === "aborted") {
    logger.warn(
      `Bridge confirmation outcome=aborted delta=${confirmation.observedDelta} baseline=${confirmation.baselineBalance} current=${confirmation.lastObservedBalance} attempts=${confirmation.attempts} poll_errors=${confirmation.pollErrors} message_ready=${confirmation.messageReady} message_check_attempted=${confirmation.messageCheckAttempted} message_check_failed=${confirmation.messageCheckFailed} message_action_attempted=${confirmation.messageReadyActionAttempted} message_action_succeeded=${confirmation.messageReadyActionSucceeded} message_action_failed=${confirmation.messageReadyActionFailed} elapsed_ms=${confirmation.elapsedMs}`,
    );
    return;
  }
  logger.warn(
    `Bridge confirmation outcome=timeout delta=${confirmation.observedDelta} baseline=${confirmation.baselineBalance} max_observed=${confirmation.maxObservedBalance} attempts=${confirmation.attempts} poll_errors=${confirmation.pollErrors} message_ready=${confirmation.messageReady} message_check_attempted=${confirmation.messageCheckAttempted} message_check_failed=${confirmation.messageCheckFailed} message_action_attempted=${confirmation.messageReadyActionAttempted} message_action_succeeded=${confirmation.messageReadyActionSucceeded} message_action_failed=${confirmation.messageReadyActionFailed} elapsed_ms=${confirmation.elapsedMs}`,
  );
}

async function executeBridgeAndConfirmation(params: {
  config: TopupCheckerConfig;
  deps: TopupCheckerDependencies;
  logger: Pick<Console, "log" | "warn" | "error">;
  balance: bigint;
  includeClaimSecretInLogs: boolean;
}): Promise<void> {
  const { config, deps, logger, balance, includeClaimSecretInLogs } = params;
  logger.log(`Balance below threshold — initiating bridge of ${config.topUpAmount} wei`);
  const result = await deps.bridge(config.topUpAmount);
  await deps.onBridgeSubmitted?.(balance, result);
  logger.log(
    `Bridge submitted. l1_to_l2_message_hash=${result.messageHash} leaf_index=${result.messageLeafIndex} claim_secret_hash=${result.claimSecretHash}${
      includeClaimSecretInLogs ? ` claim_secret=${result.claimSecret}` : ""
    }`,
  );
  logger.log(`Bridged ${result.amount} wei. Waiting for L2 confirmation...`);

  const confirmation = await deps.confirm(balance, result);
  await deps.onBridgeSettled?.(balance, result, confirmation);
  logBridgeConfirmationOutcome(logger, confirmation);
}

async function handleBridgeFailure(
  deps: TopupCheckerDependencies,
  logger: Pick<Console, "log" | "warn" | "error">,
  error: unknown,
): Promise<void> {
  try {
    await deps.onBridgeFailed?.(error);
  } catch (hookError) {
    logger.error("Bridge failure hook failed", hookError);
  }
  logger.error("Bridge confirmation outcome=failed", error);
}

/**
 * Creates the stateful top-up checker used by the service loop.
 */
export function createTopupChecker(
  config: TopupCheckerConfig,
  deps: TopupCheckerDependencies,
): TopupChecker {
  const logger = deps.logger ?? console;
  const includeClaimSecretInLogs = config.logClaimSecret ?? false;
  let bridgeInFlight = false;
  let stopping = false;

  async function checkAndTopUp() {
    if (shouldSkipCheck(stopping, bridgeInFlight, logger)) {
      return;
    }

    let balance: bigint;
    try {
      balance = await deps.getBalance();
    } catch (err) {
      logger.error("Failed to read Fee Juice balance:", err);
      return;
    }

    logger.log(`Top-up target Fee Juice balance: ${balance} wei (threshold: ${config.threshold})`);

    if (!shouldSubmitBridge(balance, config.threshold, stopping, logger)) {
      return;
    }

    bridgeInFlight = true;

    try {
      await executeBridgeAndConfirmation({
        config,
        deps,
        logger,
        balance,
        includeClaimSecretInLogs,
      });
    } catch (err) {
      await handleBridgeFailure(deps, logger, err);
    } finally {
      bridgeInFlight = false;
    }
  }

  return {
    checkAndTopUp,
    isBridgeInFlight: () => bridgeInFlight,
    requestStop: () => {
      stopping = true;
    },
    isStopping: () => stopping,
  };
}

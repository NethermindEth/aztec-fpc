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
  onBridgeSubmitted?: (
    baselineBalance: bigint,
    bridgeResult: BridgeResult,
  ) => Promise<void> | void;
  onBridgeSettled?: (
    baselineBalance: bigint,
    bridgeResult: BridgeResult,
    confirmation: BridgeConfirmationResult,
  ) => Promise<void> | void;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export interface TopupChecker {
  checkAndTopUp: () => Promise<void>;
  isBridgeInFlight: () => boolean;
  requestStop: () => void;
  isStopping: () => boolean;
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
    if (stopping) {
      logger.log("Shutdown requested, skipping top-up check");
      return;
    }

    if (bridgeInFlight) {
      logger.log("Bridge already in-flight, skipping check");
      return;
    }

    let balance: bigint;
    try {
      balance = await deps.getBalance();
    } catch (err) {
      logger.error("Failed to read Fee Juice balance:", err);
      return;
    }

    logger.log(
      `FPC Fee Juice balance: ${balance} wei (threshold: ${config.threshold})`,
    );

    if (balance >= config.threshold) {
      return;
    }

    if (stopping) {
      logger.log("Shutdown requested, skipping bridge submission");
      return;
    }

    logger.log(
      `Balance below threshold — initiating bridge of ${config.topUpAmount} wei`,
    );
    bridgeInFlight = true;

    try {
      const result = await deps.bridge(config.topUpAmount);
      await deps.onBridgeSubmitted?.(balance, result);
      logger.log(
        `Bridge submitted. l1_to_l2_message_hash=${result.messageHash} leaf_index=${result.messageLeafIndex} claim_secret_hash=${result.claimSecretHash}${
          includeClaimSecretInLogs ? ` claim_secret=${result.claimSecret}` : ""
        }`,
      );
      logger.log(
        `Bridged ${result.amount} wei. Waiting for L2 confirmation...`,
      );

      const confirmation = await deps.confirm(balance, result);
      await deps.onBridgeSettled?.(balance, result, confirmation);
      if (confirmation.status === "confirmed") {
        logger.log(
          `Bridge confirmation outcome=confirmed delta=${confirmation.observedDelta} baseline=${confirmation.baselineBalance} current=${confirmation.lastObservedBalance} attempts=${confirmation.attempts} poll_errors=${confirmation.pollErrors} message_ready=${confirmation.messageReady} message_check_attempted=${confirmation.messageCheckAttempted} message_check_failed=${confirmation.messageCheckFailed} elapsed_ms=${confirmation.elapsedMs}`,
        );
      } else if (confirmation.status === "aborted") {
        logger.warn(
          `Bridge confirmation outcome=aborted delta=${confirmation.observedDelta} baseline=${confirmation.baselineBalance} current=${confirmation.lastObservedBalance} attempts=${confirmation.attempts} poll_errors=${confirmation.pollErrors} message_ready=${confirmation.messageReady} message_check_attempted=${confirmation.messageCheckAttempted} message_check_failed=${confirmation.messageCheckFailed} elapsed_ms=${confirmation.elapsedMs}`,
        );
      } else {
        logger.warn(
          `Bridge confirmation outcome=timeout delta=${confirmation.observedDelta} baseline=${confirmation.baselineBalance} max_observed=${confirmation.maxObservedBalance} attempts=${confirmation.attempts} poll_errors=${confirmation.pollErrors} message_ready=${confirmation.messageReady} message_check_attempted=${confirmation.messageCheckAttempted} message_check_failed=${confirmation.messageCheckFailed} elapsed_ms=${confirmation.elapsedMs}`,
        );
      }
    } catch (err) {
      logger.error("Bridge confirmation outcome=failed", err);
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

import pino from "pino";

const pinoLogger = pino();

/**
 * Top-up Service — entry point
 *
 * Monitors the MultiAssetFPC's Fee Juice balance on L2 and automatically
 * bridges more Fee Juice from L1 when it drops below the configured threshold.
 *
 * Usage:
 *   cp config.example.yaml config.yaml
 *   # edit config.yaml
 *   node dist/index.js [--config path/to/config.yaml]
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { createTopupAutoClaimer, type TopupAutoClaimer } from "./autoclaim.js";
import { bridgeFeeJuice } from "./bridge.js";
import { createTopupChecker, type TopupChecker, type TopupCheckerDependencies } from "./checker.js";
import { type Config, loadConfig } from "./config.js";
import { waitForFeeJuiceBridgeConfirmation } from "./confirm.js";
import { assertL1RpcChainIdMatches } from "./l1.js";
import { createFeeJuiceBalanceReader, type FeeJuiceBalanceReader } from "./monitor.js";
import { createTopupOpsServer, type TopupOpsServer, TopupOpsState } from "./ops.js";
import { reconcilePersistedBridgeState } from "./reconcile.js";
import { type BridgeStateStore, createBridgeStateStore } from "./state.js";

type TopupConfig = Config;
type TopupNodeClient = ReturnType<typeof createAztecNodeClient>;
type TopupNodeInfo = Awaited<ReturnType<TopupNodeClient["getNodeInfo"]>>;
type TopupAutoClaimerInstance = Awaited<ReturnType<typeof createTopupAutoClaimer>>;
type ConfirmedBridgeResult = Parameters<TopupCheckerDependencies["confirm"]>[1];
type TopupBridgeStateStore = BridgeStateStore;
type TopupLoopState = {
  intervalHandle?: NodeJS.Timeout;
  inFlightCheck?: Promise<void>;
  shutdownResolve?: () => void;
  shutdownPromise: Promise<void>;
};

interface ServiceAddresses {
  fpcAddress: AztecAddress;
  topupTargetAddress: AztecAddress;
}

interface NodeChainInfo {
  l1ChainId: number;
  feeJuicePortalAddress: TopupNodeInfo["l1ContractAddresses"]["feeJuicePortalAddress"];
  feeJuiceAddress: TopupNodeInfo["l1ContractAddresses"]["feeJuiceAddress"];
}

interface AutoClaimerState {
  autoClaimer: TopupAutoClaimerInstance | null;
  autoClaimerFeeJuiceBalance: bigint | null;
}

interface StartupLogContext extends ServiceAddresses, NodeChainInfo, AutoClaimerState {
  config: TopupConfig;
  threshold: bigint;
  topUpAmount: bigint;
  logClaimSecret: boolean;
  bridgeStateStore: TopupBridgeStateStore;
  balanceReader: FeeJuiceBalanceReader;
}

function parseConfigPath(argv: string[]): string {
  return argv.find((_, i, args) => args[i - 1] === "--config") ?? "config.yaml";
}

function parseNonZeroAddress(rawValue: string, label: string): AztecAddress {
  const parsed = AztecAddress.fromString(rawValue);
  if (parsed.isZero()) {
    throw new Error(`Invalid ${label}: zero address is not allowed`);
  }
  return parsed;
}

function resolveServiceAddresses(config: TopupConfig): ServiceAddresses {
  const fpcAddress = parseNonZeroAddress(config.fpc_address, "fpc_address");
  const topupTargetAddressEnv = process.env.TOPUP_FEE_JUICE_RECIPIENT_ADDRESS?.trim() ?? "";
  const topupTargetAddressRaw =
    topupTargetAddressEnv.length > 0 ? topupTargetAddressEnv : config.fpc_address;
  const topupTargetAddress = parseNonZeroAddress(
    topupTargetAddressRaw,
    "TOPUP_FEE_JUICE_RECIPIENT_ADDRESS",
  );
  return { fpcAddress, topupTargetAddress };
}

function logResolvedOperatorKey(config: TopupConfig): void {
  if (config.l1_operator_private_key_dual_source) {
    pinoLogger.warn(
      "Both L1_OPERATOR_PRIVATE_KEY and config.l1_operator_private_key are set; using L1_OPERATOR_PRIVATE_KEY",
    );
  }
  pinoLogger.info(
    `L1 operator private key provider: ${config.l1_operator_private_key_provider} (resolved source: ${config.l1_operator_private_key_source})`,
  );
  if (config.l1_operator_private_key_source === "config") {
    pinoLogger.warn(
      "L1 operator private key source: config file (l1_operator_private_key); this should only be used in non-production profiles",
    );
  }
}

async function resolveNodeChainInfo(
  pxe: TopupNodeClient,
  config: TopupConfig,
): Promise<NodeChainInfo> {
  const nodeInfo = await pxe.getNodeInfo();
  const l1ChainId = nodeInfo.l1ChainId;
  if (!Number.isInteger(l1ChainId) || l1ChainId <= 0) {
    throw new Error(`Node info returned invalid l1ChainId=${String(l1ChainId)}`);
  }

  const feeJuicePortalAddress = nodeInfo.l1ContractAddresses.feeJuicePortalAddress;
  if (feeJuicePortalAddress.isZero()) {
    throw new Error("Node info returned zero l1ContractAddresses.feeJuicePortalAddress");
  }

  const feeJuiceAddress = nodeInfo.l1ContractAddresses.feeJuiceAddress;
  if (feeJuiceAddress.isZero()) {
    throw new Error("Node info returned zero l1ContractAddresses.feeJuiceAddress");
  }

  await assertL1RpcChainIdMatches(config.l1_rpc_url, l1ChainId);
  return { l1ChainId, feeJuicePortalAddress, feeJuiceAddress };
}

async function resolveAutoClaimerState(
  autoClaimEnabled: boolean,
  pxe: TopupNodeClient,
  balanceReader: FeeJuiceBalanceReader,
): Promise<AutoClaimerState> {
  if (!autoClaimEnabled) {
    return { autoClaimer: null, autoClaimerFeeJuiceBalance: null };
  }

  const autoClaimer = await createTopupAutoClaimer(pxe);
  let autoClaimerFeeJuiceBalance: bigint | null = null;
  try {
    autoClaimerFeeJuiceBalance = await balanceReader.getBalance(autoClaimer.claimerAddress);
  } catch (error) {
    pinoLogger.warn(
      { err: error },
      `Could not read auto-claim claimer Fee Juice balance for ${autoClaimer.claimerAddress.toString()}`,
    );
  }
  return { autoClaimer, autoClaimerFeeJuiceBalance };
}

function logAutoClaimStartup(
  autoClaimer: TopupAutoClaimer | null,
  autoClaimerFeeJuiceBalance: bigint | null,
): void {
  if (!autoClaimer) {
    pinoLogger.warn("  Auto-claim: disabled (TOPUP_AUTOCLAIM_ENABLED=0)");
    return;
  }

  pinoLogger.info(
    `  Auto-claim: enabled (claimer=${autoClaimer.claimerAddress.toString()} source=${autoClaimer.claimerSource} payment=${autoClaimer.paymentMode})`,
  );
  if (autoClaimer.sponsoredFpcAddress) {
    pinoLogger.info(`  Auto-claim sponsor contract: ${autoClaimer.sponsoredFpcAddress.toString()}`);
  }
  if (autoClaimerFeeJuiceBalance !== null) {
    pinoLogger.info(`  Auto-claim claimer Fee Juice balance: ${autoClaimerFeeJuiceBalance} wei`);
    if (autoClaimer.paymentMode === "fee_juice" && autoClaimerFeeJuiceBalance <= 0n) {
      pinoLogger.warn(
        "  Auto-claim warning: claimer has zero Fee Juice. Claims will fail unless this account is funded on L2.",
      );
    }
  }
}

function logStartupDetails(context: StartupLogContext): void {
  pinoLogger.info("Top-up service started");
  pinoLogger.info(`  FPC address:   ${context.config.fpc_address}`);
  pinoLogger.info(`  Top-up target: ${context.topupTargetAddress.toString()}`);
  if (
    context.topupTargetAddress.toString().toLowerCase() !==
    context.fpcAddress.toString().toLowerCase()
  ) {
    pinoLogger.warn(
      `  Top-up target differs from FPC address; monitoring and claims will target ${context.topupTargetAddress.toString()}`,
    );
  }
  pinoLogger.info(`  Threshold:     ${context.threshold} wei`);
  pinoLogger.info(`  Top-up amount: ${context.topUpAmount} wei`);
  pinoLogger.info(`  Bridge state file: ${context.bridgeStateStore.filePath}`);
  pinoLogger.info(`  Check interval: ${context.config.check_interval_ms}ms`);
  pinoLogger.info(`  L1 chain id:   ${context.l1ChainId}`);
  pinoLogger.info(`  L1 portal:     ${context.feeJuicePortalAddress.toString()}`);
  pinoLogger.info(`  L1 fee juice:  ${context.feeJuiceAddress.toString()}`);
  pinoLogger.info(`  Confirm timeout: ${context.config.confirmation_timeout_ms}ms`);
  pinoLogger.info(
    `  Confirm poll:  ${context.config.confirmation_poll_initial_ms}ms -> ${context.config.confirmation_poll_max_ms}ms`,
  );
  pinoLogger.info(
    `  Fee Juice contract: ${context.balanceReader.feeJuiceAddress.toString()} (${context.balanceReader.addressSource})`,
  );
  pinoLogger.info(`  Ops endpoint:  http://0.0.0.0:${context.config.ops_port}`);
  if (context.logClaimSecret) {
    pinoLogger.warn(
      "TOPUP_LOG_CLAIM_SECRET=1 enabled: bridge claim secrets will be printed to logs (for local smoke/debug only)",
    );
  }
  logAutoClaimStartup(context.autoClaimer, context.autoClaimerFeeJuiceBalance);
}

function createGetBalanceDependency(
  balanceReader: FeeJuiceBalanceReader,
  topupTargetAddress: AztecAddress,
  opsState: TopupOpsState,
): TopupCheckerDependencies["getBalance"] {
  return async () => {
    try {
      const balance = await balanceReader.getBalance(topupTargetAddress);
      opsState.recordBalanceCheckSuccess();
      return balance;
    } catch (error) {
      opsState.recordBalanceCheckFailure(error);
      throw error;
    }
  };
}

function createOnMessageReadyHandler(
  autoClaimer: TopupAutoClaimer | null,
  topupTargetAddress: AztecAddress,
  bridgeResult: ConfirmedBridgeResult,
  confirmationTimeoutMs: number,
): (() => Promise<void>) | undefined {
  if (!autoClaimer) {
    return undefined;
  }
  return async () => {
    const txHash = await autoClaimer.claim({
      recipient: topupTargetAddress,
      amount: bridgeResult.amount,
      claimSecret: bridgeResult.claimSecret,
      messageLeafIndex: bridgeResult.messageLeafIndex,
      messageHash: bridgeResult.messageHash,
      waitTimeoutSeconds: Math.max(30, Math.floor(confirmationTimeoutMs / 1000)),
    });
    pinoLogger.info(
      `Auto-claim submitted message_hash=${bridgeResult.messageHash} tx_hash=${txHash}`,
    );
  };
}

function createConfirmDependency(
  balanceReader: FeeJuiceBalanceReader,
  topupTargetAddress: AztecAddress,
  config: TopupConfig,
  pxe: TopupNodeClient,
  shutdownController: AbortController,
  autoClaimer: TopupAutoClaimer | null,
): TopupCheckerDependencies["confirm"] {
  return (baselineBalance, bridgeResult) =>
    waitForFeeJuiceBridgeConfirmation({
      balanceReader,
      fpcAddress: topupTargetAddress,
      baselineBalance,
      timeoutMs: config.confirmation_timeout_ms,
      initialPollMs: config.confirmation_poll_initial_ms,
      maxPollMs: config.confirmation_poll_max_ms,
      abortSignal: shutdownController.signal,
      messageContext: {
        node: pxe,
        messageHash: bridgeResult.messageHash,
        // Keep false here: SDK readiness with true may resolve one block
        // earlier and trigger premature claim attempts.
        forPublicConsumption: false,
      },
      onMessageReady: createOnMessageReadyHandler(
        autoClaimer,
        topupTargetAddress,
        bridgeResult,
        config.confirmation_timeout_ms,
      ),
    });
}

function createOnBridgeSubmittedDependency(
  opsState: TopupOpsState,
  bridgeStateStore: TopupBridgeStateStore,
): NonNullable<TopupCheckerDependencies["onBridgeSubmitted"]> {
  return async (baselineBalance, bridgeResult) => {
    opsState.recordBridgeEvent("submitted");
    try {
      await bridgeStateStore.write(baselineBalance, bridgeResult);
      pinoLogger.info(
        `Persisted in-flight bridge metadata message_hash=${bridgeResult.messageHash} leaf_index=${bridgeResult.messageLeafIndex}`,
      );
    } catch (error) {
      pinoLogger.warn(
        { err: error },
        `Failed to persist in-flight bridge metadata message_hash=${bridgeResult.messageHash}; continuing with in-memory confirmation only`,
      );
    }
  };
}

function createOnBridgeSettledDependency(
  opsState: TopupOpsState,
  bridgeStateStore: TopupBridgeStateStore,
): NonNullable<TopupCheckerDependencies["onBridgeSettled"]> {
  return async (_baselineBalance, bridgeResult, confirmation) => {
    opsState.recordBridgeEvent(confirmation.status);
    if (confirmation.status !== "confirmed") {
      pinoLogger.warn(
        `Retaining persisted bridge metadata message_hash=${bridgeResult.messageHash} outcome=${confirmation.status}`,
      );
      return;
    }
    try {
      await bridgeStateStore.clear();
      pinoLogger.info(
        `Cleared persisted bridge metadata message_hash=${bridgeResult.messageHash} outcome=${confirmation.status}`,
      );
    } catch (error) {
      pinoLogger.warn(
        { err: error },
        `Failed to clear persisted bridge metadata message_hash=${bridgeResult.messageHash} after confirmed bridge`,
      );
    }
  };
}

function buildCheckerDependencies(args: {
  pxe: TopupNodeClient;
  config: TopupConfig;
  l1ChainId: number;
  topupTargetAddress: AztecAddress;
  balanceReader: FeeJuiceBalanceReader;
  bridgeStateStore: TopupBridgeStateStore;
  shutdownController: AbortController;
  autoClaimer: TopupAutoClaimer | null;
  opsState: TopupOpsState;
}): TopupCheckerDependencies {
  return {
    getBalance: createGetBalanceDependency(
      args.balanceReader,
      args.topupTargetAddress,
      args.opsState,
    ),
    bridge: (amount) =>
      bridgeFeeJuice(
        args.pxe,
        args.config.l1_rpc_url,
        args.l1ChainId,
        args.config.l1_operator_private_key,
        args.topupTargetAddress,
        amount,
      ),
    confirm: createConfirmDependency(
      args.balanceReader,
      args.topupTargetAddress,
      args.config,
      args.pxe,
      args.shutdownController,
      args.autoClaimer,
    ),
    onBridgeSubmitted: createOnBridgeSubmittedDependency(args.opsState, args.bridgeStateStore),
    onBridgeSettled: createOnBridgeSettledDependency(args.opsState, args.bridgeStateStore),
    onBridgeFailed: () => {
      args.opsState.recordBridgeEvent("failed");
    },
  };
}

function createLoopState(): TopupLoopState {
  let shutdownResolve: (() => void) | undefined;
  const shutdownPromise = new Promise<void>((resolve) => {
    shutdownResolve = resolve;
  });
  return {
    shutdownResolve,
    shutdownPromise,
  };
}

function registerShutdownHandlers(args: {
  shutdownController: AbortController;
  opsState: TopupOpsState;
  checker: TopupChecker;
  loopState: TopupLoopState;
  opsServer: TopupOpsServer;
}): void {
  const requestShutdown = (signal: NodeJS.Signals) => {
    if (args.shutdownController.signal.aborted) {
      return;
    }
    pinoLogger.info(`Received ${signal}. Starting graceful shutdown...`);
    args.opsState.markShutdownRequested();
    args.checker.requestStop();
    args.shutdownController.abort();
    if (args.loopState.intervalHandle) {
      clearInterval(args.loopState.intervalHandle);
      args.loopState.intervalHandle = undefined;
    }
    void (async () => {
      try {
        await args.loopState.inFlightCheck;
        await args.opsServer.close();
      } catch (error) {
        pinoLogger.error({ err: error }, "Failed to stop top-up ops server cleanly:");
      } finally {
        pinoLogger.info("Top-up service stopped");
        args.loopState.shutdownResolve?.();
      }
    })();
  };

  process.once("SIGTERM", () => requestShutdown("SIGTERM"));
  process.once("SIGINT", () => requestShutdown("SIGINT"));
}

function createReconciliationRunner(args: {
  bridgeStateStore: TopupBridgeStateStore;
  balanceReader: FeeJuiceBalanceReader;
  pxe: TopupNodeClient;
  topupTargetAddress: AztecAddress;
  config: TopupConfig;
  shutdownController: AbortController;
}): () => Promise<boolean> {
  return async () => {
    const outcome = await reconcilePersistedBridgeState({
      stateStore: args.bridgeStateStore,
      balanceReader: args.balanceReader,
      node: args.pxe,
      fpcAddress: args.topupTargetAddress,
      timeoutMs: args.config.confirmation_timeout_ms,
      initialPollMs: args.config.confirmation_poll_initial_ms,
      maxPollMs: args.config.confirmation_poll_max_ms,
      abortSignal: args.shutdownController.signal,
    });

    if (outcome === "timeout") {
      pinoLogger.warn(
        "Skipping new bridge submission: persisted bridge reconciliation did not complete yet",
      );
      return false;
    }
    return outcome !== "aborted";
  };
}

function createCycleRunner(args: {
  shutdownController: AbortController;
  loopState: TopupLoopState;
  runCheck: () => Promise<void>;
  runReconciliation: () => Promise<boolean>;
}): () => Promise<void> {
  return async () => {
    if (args.shutdownController.signal.aborted) {
      return;
    }
    if (args.loopState.inFlightCheck) {
      return args.loopState.inFlightCheck;
    }

    args.loopState.inFlightCheck = (async () => {
      if (!(await args.runReconciliation())) {
        return;
      }
      await args.runCheck();
    })()
      .catch((error) => {
        pinoLogger.error({ err: error }, "Top-up check failed:");
      })
      .finally(() => {
        args.loopState.inFlightCheck = undefined;
      });

    await args.loopState.inFlightCheck;
  };
}

async function runServiceLoop(
  checkIntervalMs: number,
  shutdownController: AbortController,
  loopState: TopupLoopState,
  runCycle: () => Promise<void>,
): Promise<void> {
  // Run once immediately, then on the configured interval.
  await runCycle();
  if (shutdownController.signal.aborted) {
    return;
  }

  loopState.intervalHandle = setInterval(() => {
    void runCycle();
  }, checkIntervalMs);
  await loopState.shutdownPromise;
}

const configPath = parseConfigPath(process.argv);

async function main(): Promise<void> {
  const config = loadConfig(configPath);
  pinoLogger.info(`Runtime profile: ${config.runtime_profile}`);
  logResolvedOperatorKey(config);

  const pxe = createAztecNodeClient(config.aztec_node_url);
  const { fpcAddress, topupTargetAddress } = resolveServiceAddresses(config);
  const { l1ChainId, feeJuicePortalAddress, feeJuiceAddress } = await resolveNodeChainInfo(
    pxe,
    config,
  );

  const threshold = BigInt(config.threshold);
  const topUpAmount = BigInt(config.top_up_amount);
  const logClaimSecret = process.env.TOPUP_LOG_CLAIM_SECRET === "1";
  const autoClaimEnabled = process.env.TOPUP_AUTOCLAIM_ENABLED !== "0";
  const bridgeStateStore = createBridgeStateStore(config.bridge_state_path);
  const balanceReader = await createFeeJuiceBalanceReader(pxe);
  const { autoClaimer, autoClaimerFeeJuiceBalance } = await resolveAutoClaimerState(
    autoClaimEnabled,
    pxe,
    balanceReader,
  );

  const shutdownController = new AbortController();
  const opsState = new TopupOpsState({
    checkIntervalMs: config.check_interval_ms,
  });
  const opsServer = createTopupOpsServer(opsState);
  await opsServer.listen("0.0.0.0", config.ops_port);

  logStartupDetails({
    config,
    fpcAddress,
    topupTargetAddress,
    l1ChainId,
    feeJuicePortalAddress,
    feeJuiceAddress,
    threshold,
    topUpAmount,
    logClaimSecret,
    bridgeStateStore,
    balanceReader,
    autoClaimer,
    autoClaimerFeeJuiceBalance,
  });

  const checker = createTopupChecker(
    { threshold, topUpAmount, logClaimSecret },
    buildCheckerDependencies({
      pxe,
      config,
      l1ChainId,
      topupTargetAddress,
      balanceReader,
      bridgeStateStore,
      shutdownController,
      autoClaimer,
      opsState,
    }),
  );

  const loopState = createLoopState();
  registerShutdownHandlers({
    shutdownController,
    opsState,
    checker,
    loopState,
    opsServer,
  });

  const runReconciliation = createReconciliationRunner({
    bridgeStateStore,
    balanceReader,
    pxe,
    topupTargetAddress,
    config,
    shutdownController,
  });
  const runCycle = createCycleRunner({
    shutdownController,
    loopState,
    runCheck: () => checker.checkAndTopUp(),
    runReconciliation,
  });

  await runServiceLoop(config.check_interval_ms, shutdownController, loopState, runCycle);
}
main().catch((err) => {
  pinoLogger.error({ err }, "Fatal error:");
  process.exit(1);
});

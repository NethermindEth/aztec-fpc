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
import pino from "pino";
import { createTopupAutoClaimer, type TopupAutoClaimer } from "./autoclaim.js";
import { bridgeFeeJuice } from "./bridge.js";
import { createTopupChecker, type TopupChecker, type TopupCheckerDependencies } from "./checker.js";
import { type Config, loadConfig } from "./config.js";
import { waitForFeeJuiceBridgeConfirmation } from "./confirm.js";
import { assertL1RpcChainIdMatches } from "./l1.js";
import { createFeeJuiceBalanceReader, type FeeJuiceBalanceReader } from "./monitor.js";
import { createTopupOpsServer, type TopupOpsServer, TopupOpsState } from "./ops.js";
import { reconcilePersistedBridgeState } from "./reconcile.js";
import {
  acquireProcessLock,
  type BridgeStateStore,
  createBridgeStateStore,
  releaseProcessLock,
} from "./state.js";

const pinoLogger = pino();

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
  runtimeProfile: string,
): Promise<AutoClaimerState> {
  if (!autoClaimEnabled) {
    return { autoClaimer: null, autoClaimerFeeJuiceBalance: null };
  }

  const autoClaimer = await createTopupAutoClaimer(pxe, runtimeProfile);
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
      "Claim secret logging enabled (runtime_profile=development): bridge claim secrets will be printed to logs",
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
    // Fail-closed: if we cannot persist the bridge record, let the error propagate.
    // The L1 tx is already submitted, but failing here triggers onBridgeFailed in the
    // checker, and crashing forces reconciliation on restart — safer than losing the record.
    await bridgeStateStore.write(baselineBalance, bridgeResult);
    pinoLogger.info(
      `Persisted in-flight bridge metadata message_hash=${bridgeResult.messageHash} leaf_index=${bridgeResult.messageLeafIndex}`,
    );
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
  lockPath: string;
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
        await releaseProcessLock(args.lockPath).catch(() => {});
        pinoLogger.info("Top-up service stopped");
        args.loopState.shutdownResolve?.();
      }
    })();
  };

  process.once("SIGTERM", () => requestShutdown("SIGTERM"));
  process.once("SIGINT", () => requestShutdown("SIGINT"));
}

const RECONCILIATION_MAX_AGE_MS = 24 * 60 * 60 * 1_000; // 24 hours

function createReconciliationRunner(args: {
  bridgeStateStore: TopupBridgeStateStore;
  balanceReader: FeeJuiceBalanceReader;
  pxe: TopupNodeClient;
  topupTargetAddress: AztecAddress;
  config: TopupConfig;
  shutdownController: AbortController;
  autoClaimer: TopupAutoClaimerInstance | null;
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
      maxAgeMs: RECONCILIATION_MAX_AGE_MS,
      buildOnMessageReady: args.autoClaimer
        ? (persisted) => {
            if (!persisted.claimSecret) return undefined;
            return async () => {
              const txHash = await args.autoClaimer?.claim({
                recipient: args.topupTargetAddress,
                amount: BigInt(persisted.amount),
                claimSecret: persisted.claimSecret,
                messageLeafIndex: BigInt(persisted.messageLeafIndex),
                messageHash: persisted.messageHash as `0x${string}`,
                waitTimeoutSeconds: Math.max(
                  30,
                  Math.floor(args.config.confirmation_timeout_ms / 1000),
                ),
              });
              pinoLogger.info(
                `Reconciliation auto-claim submitted message_hash=${persisted.messageHash} tx_hash=${txHash}`,
              );
            };
          }
        : undefined,
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
  const logClaimSecret = config.runtime_profile === "development";
  const autoClaimEnabled = process.env.TOPUP_AUTOCLAIM_ENABLED !== "0";
  const bridgeStateStore = createBridgeStateStore(config.bridge_state_path);
  const lockPath = `${config.bridge_state_path}.lock`;
  await acquireProcessLock(lockPath);

  // Everything between lock acquisition and shutdown handler registration
  // must be wrapped so the lock is released if startup fails. Without this,
  // a crash during initialization (e.g. node connection, balance reader)
  // leaves a stale lock file that blocks the next restart.
  let balanceReader: FeeJuiceBalanceReader;
  let autoClaimer: TopupAutoClaimerInstance | null;
  let shutdownController: AbortController;
  let opsState: TopupOpsState;
  let opsServer: TopupOpsServer;
  let checker: TopupChecker;
  let loopState: TopupLoopState;
  try {
    balanceReader = await createFeeJuiceBalanceReader(pxe);
    const autoClaimerState = await resolveAutoClaimerState(
      autoClaimEnabled,
      pxe,
      balanceReader,
      config.runtime_profile,
    );
    autoClaimer = autoClaimerState.autoClaimer;
    const autoClaimerFeeJuiceBalance = autoClaimerState.autoClaimerFeeJuiceBalance;

    shutdownController = new AbortController();
    opsState = new TopupOpsState({
      checkIntervalMs: config.check_interval_ms,
    });
    opsServer = createTopupOpsServer(opsState);
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

    checker = createTopupChecker(
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

    loopState = createLoopState();
  } catch (error) {
    await releaseProcessLock(lockPath).catch(() => {});
    throw error;
  }

  registerShutdownHandlers({
    shutdownController,
    opsState,
    checker,
    loopState,
    opsServer,
    lockPath,
  });

  const runReconciliation = createReconciliationRunner({
    bridgeStateStore,
    balanceReader,
    pxe,
    topupTargetAddress,
    config,
    shutdownController,
    autoClaimer,
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

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
import { bridgeFeeJuice } from "./bridge.js";
import { createTopupChecker } from "./checker.js";
import { loadConfig } from "./config.js";
import { waitForFeeJuiceBridgeConfirmation } from "./confirm.js";
import { assertL1RpcChainIdMatches } from "./l1.js";
import { createFeeJuiceBalanceReader } from "./monitor.js";
import { createTopupOpsServer, TopupOpsState } from "./ops.js";
import { reconcilePersistedBridgeState } from "./reconcile.js";
import { createBridgeStateStore } from "./state.js";

const configPath =
  process.argv.find((_, i, a) => a[i - 1] === "--config") ?? "config.yaml";

async function main() {
  const config = loadConfig(configPath);
  console.log(`Runtime profile: ${config.runtime_profile}`);

  if (config.l1_operator_private_key_dual_source) {
    console.warn(
      "Both L1_OPERATOR_PRIVATE_KEY and config.l1_operator_private_key are set; using L1_OPERATOR_PRIVATE_KEY",
    );
  }
  console.log(
    `L1 operator private key provider: ${config.l1_operator_private_key_provider} (resolved source: ${config.l1_operator_private_key_source})`,
  );
  if (config.l1_operator_private_key_source === "config") {
    console.warn(
      "L1 operator private key source: config file (l1_operator_private_key); this should only be used in non-production profiles",
    );
  }
  const pxe = createAztecNodeClient(config.aztec_node_url);
  const fpcAddress = AztecAddress.fromString(config.fpc_address);
  if (fpcAddress.isZero()) {
    throw new Error("Invalid fpc_address: zero address is not allowed");
  }
  const nodeInfo = await pxe.getNodeInfo();
  const l1ChainId = nodeInfo.l1ChainId;
  if (!Number.isInteger(l1ChainId) || l1ChainId <= 0) {
    throw new Error(
      `Node info returned invalid l1ChainId=${String(l1ChainId)}`,
    );
  }
  const feeJuicePortalAddress =
    nodeInfo.l1ContractAddresses.feeJuicePortalAddress;
  const feeJuiceAddress = nodeInfo.l1ContractAddresses.feeJuiceAddress;
  if (feeJuicePortalAddress.isZero()) {
    throw new Error(
      "Node info returned zero l1ContractAddresses.feeJuicePortalAddress",
    );
  }
  if (feeJuiceAddress.isZero()) {
    throw new Error(
      "Node info returned zero l1ContractAddresses.feeJuiceAddress",
    );
  }
  await assertL1RpcChainIdMatches(config.l1_rpc_url, l1ChainId);

  const threshold = BigInt(config.threshold);
  const topUpAmount = BigInt(config.top_up_amount);
  const logClaimSecret = process.env.TOPUP_LOG_CLAIM_SECRET === "1";
  const bridgeStateStore = createBridgeStateStore(config.bridge_state_path);
  const balanceReader = await createFeeJuiceBalanceReader(pxe);
  const shutdownController = new AbortController();
  const opsState = new TopupOpsState({
    checkIntervalMs: config.check_interval_ms,
  });
  const opsServer = createTopupOpsServer(opsState);
  await opsServer.listen("0.0.0.0", config.ops_port);

  console.log(`Top-up service started`);
  console.log(`  FPC address:   ${config.fpc_address}`);
  console.log(`  Threshold:     ${threshold} wei`);
  console.log(`  Top-up amount: ${topUpAmount} wei`);
  console.log(`  Bridge state file: ${bridgeStateStore.filePath}`);
  console.log(`  Check interval: ${config.check_interval_ms}ms`);
  console.log(`  L1 chain id:   ${l1ChainId}`);
  console.log(`  L1 portal:     ${feeJuicePortalAddress.toString()}`);
  console.log(`  L1 fee juice:  ${feeJuiceAddress.toString()}`);
  console.log(`  Confirm timeout: ${config.confirmation_timeout_ms}ms`);
  console.log(
    `  Confirm poll:  ${config.confirmation_poll_initial_ms}ms -> ${config.confirmation_poll_max_ms}ms`,
  );
  console.log(
    `  Fee Juice contract: ${balanceReader.feeJuiceAddress.toString()} (${balanceReader.addressSource})`,
  );
  console.log(`  Ops endpoint:  http://0.0.0.0:${config.ops_port}`);
  if (logClaimSecret) {
    console.warn(
      "TOPUP_LOG_CLAIM_SECRET=1 enabled: bridge claim secrets will be printed to logs (for local smoke/debug only)",
    );
  }

  let intervalHandle: NodeJS.Timeout | undefined;
  let inFlightCheck: Promise<void> | undefined;
  let shutdownResolve: (() => void) | undefined;
  const shutdownPromise = new Promise<void>((resolve) => {
    shutdownResolve = resolve;
  });

  const checker = createTopupChecker(
    { threshold, topUpAmount, logClaimSecret },
    {
      getBalance: async () => {
        try {
          const balance = await balanceReader.getBalance(fpcAddress);
          opsState.recordBalanceCheckSuccess();
          return balance;
        } catch (error) {
          opsState.recordBalanceCheckFailure(error);
          throw error;
        }
      },
      bridge: (amount) =>
        bridgeFeeJuice(
          pxe,
          config.l1_rpc_url,
          l1ChainId,
          config.l1_operator_private_key,
          fpcAddress,
          amount,
        ),
      confirm: (baselineBalance, bridgeResult) =>
        waitForFeeJuiceBridgeConfirmation({
          balanceReader,
          fpcAddress,
          baselineBalance,
          timeoutMs: config.confirmation_timeout_ms,
          initialPollMs: config.confirmation_poll_initial_ms,
          maxPollMs: config.confirmation_poll_max_ms,
          abortSignal: shutdownController.signal,
          messageContext: {
            node: pxe,
            messageHash: bridgeResult.messageHash,
            forPublicConsumption: false,
          },
        }),
      onBridgeSubmitted: async (baselineBalance, bridgeResult) => {
        opsState.recordBridgeEvent("submitted");
        await bridgeStateStore.write(baselineBalance, bridgeResult);
        console.log(
          `Persisted in-flight bridge metadata message_hash=${bridgeResult.messageHash} leaf_index=${bridgeResult.messageLeafIndex}`,
        );
      },
      onBridgeSettled: async (_baselineBalance, bridgeResult, confirmation) => {
        opsState.recordBridgeEvent(confirmation.status);
        if (confirmation.status !== "confirmed") {
          console.warn(
            `Retaining persisted bridge metadata message_hash=${bridgeResult.messageHash} outcome=${confirmation.status}`,
          );
          return;
        }
        await bridgeStateStore.clear();
        console.log(
          `Cleared persisted bridge metadata message_hash=${bridgeResult.messageHash} outcome=${confirmation.status}`,
        );
      },
      onBridgeFailed: () => {
        opsState.recordBridgeEvent("failed");
      },
    },
  );

  const requestShutdown = (signal: NodeJS.Signals) => {
    if (shutdownController.signal.aborted) {
      return;
    }
    console.log(`Received ${signal}. Starting graceful shutdown...`);
    opsState.markShutdownRequested();
    checker.requestStop();
    shutdownController.abort();
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = undefined;
    }
    void (async () => {
      try {
        await inFlightCheck;
        await opsServer.close();
      } catch (error) {
        console.error("Failed to stop top-up ops server cleanly:", error);
      } finally {
        console.log("Top-up service stopped");
        shutdownResolve?.();
      }
    })();
  };

  process.once("SIGTERM", () => requestShutdown("SIGTERM"));
  process.once("SIGINT", () => requestShutdown("SIGINT"));

  const runCheck = async () => {
    await checker.checkAndTopUp();
  };

  const runCycle = async () => {
    if (shutdownController.signal.aborted) {
      return;
    }
    if (inFlightCheck) {
      return inFlightCheck;
    }

    inFlightCheck = (async () => {
      if (!(await runReconciliation())) {
        return;
      }
      await runCheck();
    })()
      .catch((error) => {
        console.error("Top-up check failed:", error);
      })
      .finally(() => {
        inFlightCheck = undefined;
      });

    await inFlightCheck;
  };

  const runReconciliation = async (): Promise<boolean> => {
    const outcome = await reconcilePersistedBridgeState({
      stateStore: bridgeStateStore,
      balanceReader,
      node: pxe,
      fpcAddress,
      timeoutMs: config.confirmation_timeout_ms,
      initialPollMs: config.confirmation_poll_initial_ms,
      maxPollMs: config.confirmation_poll_max_ms,
      abortSignal: shutdownController.signal,
    });

    if (outcome === "timeout") {
      console.warn(
        "Skipping new bridge submission: persisted bridge reconciliation did not complete yet",
      );
      return false;
    }

    return outcome !== "aborted";
  };

  // Run once immediately, then on the configured interval.
  await runCycle();

  if (shutdownController.signal.aborted) {
    return;
  }

  intervalHandle = setInterval(() => {
    void runCycle();
  }, config.check_interval_ms);

  await shutdownPromise;
}
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

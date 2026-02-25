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
import { loadConfig } from "./config.js";
import { bridgeFeeJuice } from "./bridge.js";
import { waitForFeeJuiceBridgeConfirmation } from "./confirm.js";
import { createFeeJuiceBalanceReader } from "./monitor.js";

const configPath =
  process.argv.find((_, i, a) => a[i - 1] === "--config") ?? "config.yaml";

async function main() {
  const config = loadConfig(configPath);
  const pxe = createAztecNodeClient(config.aztec_node_url);
  const fpcAddress = AztecAddress.fromString(config.fpc_address);
  const threshold = BigInt(config.threshold);
  const topUpAmount = BigInt(config.top_up_amount);
  const balanceReader = await createFeeJuiceBalanceReader(config, pxe);

  console.log(`Top-up service started`);
  console.log(`  FPC address:   ${config.fpc_address}`);
  console.log(`  Threshold:     ${threshold} wei`);
  console.log(`  Top-up amount: ${topUpAmount} wei`);
  console.log(`  Check interval: ${config.check_interval_ms}ms`);
  console.log(`  L1 chain id:   ${config.l1_chain_id}`);
  console.log(`  L1 portal:     ${config.fee_juice_portal_address}`);
  console.log(`  Confirm timeout: ${config.confirmation_timeout_ms}ms`);
  console.log(
    `  Confirm poll:  ${config.confirmation_poll_initial_ms}ms -> ${config.confirmation_poll_max_ms}ms`,
  );
  console.log(
    `  Fee Juice contract: ${balanceReader.feeJuiceAddress.toString()} (${balanceReader.addressSource})`,
  );

  // Track whether a bridge is in-flight to avoid stacking multiple concurrent bridges
  let bridgeInFlight = false;

  async function checkAndTopUp() {
    if (bridgeInFlight) {
      console.log("Bridge already in-flight, skipping check");
      return;
    }

    let balance: bigint;
    try {
      balance = await balanceReader.getBalance(fpcAddress);
    } catch (err) {
      console.error("Failed to read Fee Juice balance:", err);
      return;
    }

    console.log(
      `FPC Fee Juice balance: ${balance} wei (threshold: ${threshold})`,
    );

    if (balance >= threshold) return;

    console.log(
      `Balance below threshold — initiating bridge of ${topUpAmount} wei`,
    );
    bridgeInFlight = true;

    try {
      const result = await bridgeFeeJuice(
        config.l1_rpc_url,
        config.l1_chain_id,
        config.l1_operator_private_key,
        config.fee_juice_portal_address,
        fpcAddress,
        topUpAmount,
      );

      console.log(`Bridge submitted. L1 tx: ${result.l1TxHash}`);
      console.log(
        `Bridged ${result.amount} wei. Waiting for L2 confirmation...`,
      );

      const confirmation = await waitForFeeJuiceBridgeConfirmation({
        balanceReader,
        fpcAddress,
        baselineBalance: balance,
        timeoutMs: config.confirmation_timeout_ms,
        initialPollMs: config.confirmation_poll_initial_ms,
        maxPollMs: config.confirmation_poll_max_ms,
      });

      if (confirmation.status === "confirmed") {
        console.log(
          `Bridge confirmation outcome=confirmed delta=${confirmation.observedDelta} baseline=${confirmation.baselineBalance} current=${confirmation.lastObservedBalance} attempts=${confirmation.attempts} poll_errors=${confirmation.pollErrors} elapsed_ms=${confirmation.elapsedMs}`,
        );
      } else {
        console.warn(
          `Bridge confirmation outcome=timeout delta=${confirmation.observedDelta} baseline=${confirmation.baselineBalance} max_observed=${confirmation.maxObservedBalance} attempts=${confirmation.attempts} poll_errors=${confirmation.pollErrors} elapsed_ms=${confirmation.elapsedMs}`,
        );
      }
    } catch (err) {
      console.error("Bridge confirmation outcome=failed", err);
    } finally {
      bridgeInFlight = false;
    }
  }

  // Run once immediately, then on the configured interval
  await checkAndTopUp();
  setInterval(checkAndTopUp, config.check_interval_ms);
}
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

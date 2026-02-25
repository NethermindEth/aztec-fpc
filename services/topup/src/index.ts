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
import { createFeeJuiceBalanceReader } from "./monitor.js";

const configPath =
  process.argv.find((_, i, a) => a[i - 1] === "--config") ?? "config.yaml";

async function main() {
  const config = loadConfig(configPath);
  if (config.l1_operator_private_key_dual_source) {
    console.warn(
      "Both L1_OPERATOR_PRIVATE_KEY and config.l1_operator_private_key are set; using L1_OPERATOR_PRIVATE_KEY",
    );
  }
  if (config.l1_operator_private_key_source === "env") {
    console.log(
      "L1 operator private key source: env (L1_OPERATOR_PRIVATE_KEY)",
    );
  } else {
    console.warn(
      "L1 operator private key source: config file (l1_operator_private_key); prefer L1_OPERATOR_PRIVATE_KEY in non-dev environments",
    );
  }
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

  const checker = createTopupChecker(
    { threshold, topUpAmount },
    {
      getBalance: () => balanceReader.getBalance(fpcAddress),
      bridge: (amount) =>
        bridgeFeeJuice(
          config.l1_rpc_url,
          config.l1_chain_id,
          config.l1_operator_private_key,
          config.fee_juice_portal_address,
          fpcAddress,
          amount,
        ),
      confirm: (baselineBalance) =>
        waitForFeeJuiceBridgeConfirmation({
          balanceReader,
          fpcAddress,
          baselineBalance,
          timeoutMs: config.confirmation_timeout_ms,
          initialPollMs: config.confirmation_poll_initial_ms,
          maxPollMs: config.confirmation_poll_max_ms,
        }),
    },
  );

  // Run once immediately, then on the configured interval
  await checker.checkAndTopUp();
  setInterval(checker.checkAndTopUp, config.check_interval_ms);
}
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

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
import { createPublicClient, http } from "viem";
import { bridgeFeeJuice } from "./bridge.js";
import { createTopupChecker } from "./checker.js";
import { loadConfig } from "./config.js";
import { waitForFeeJuiceBridgeConfirmation } from "./confirm.js";
import { createFeeJuiceBalanceReader } from "./monitor.js";

const configPath =
  process.argv.find((_, i, a) => a[i - 1] === "--config") ?? "config.yaml";

async function assertL1RpcChainIdMatches(
  l1RpcUrl: string,
  expectedChainId: number,
): Promise<void> {
  const publicClient = createPublicClient({ transport: http(l1RpcUrl) });
  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== expectedChainId) {
    throw new Error(
      `L1 chain mismatch: aztec node expects chain_id=${expectedChainId}, but RPC ${l1RpcUrl} reports chain_id=${rpcChainId}`,
    );
  }
}

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
  const balanceReader = await createFeeJuiceBalanceReader(pxe);

  console.log(`Top-up service started`);
  console.log(`  FPC address:   ${config.fpc_address}`);
  console.log(`  Threshold:     ${threshold} wei`);
  console.log(`  Top-up amount: ${topUpAmount} wei`);
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

  const checker = createTopupChecker(
    { threshold, topUpAmount },
    {
      getBalance: () => balanceReader.getBalance(fpcAddress),
      bridge: (amount) =>
        bridgeFeeJuice(
          pxe,
          config.l1_rpc_url,
          l1ChainId,
          config.l1_operator_private_key,
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

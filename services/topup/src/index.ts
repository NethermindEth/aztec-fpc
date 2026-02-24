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

import { AztecAddress, createPXEClient } from '@aztec/aztec.js';
import type { Hex } from 'viem';
import { loadConfig } from './config.js';
import { getFeeJuiceBalance } from './monitor.js';
import { bridgeFeeJuice } from './bridge.js';

const configPath = process.argv.find((_, i, a) => a[i - 1] === '--config') ?? 'config.yaml';

async function main() {
  const config = loadConfig(configPath);
  const pxe = createPXEClient(config.aztec_node_url);
  const fpcAddress = AztecAddress.fromString(config.fpc_address);
  const threshold = BigInt(config.threshold);
  const topUpAmount = BigInt(config.top_up_amount);

  console.log(`Top-up service started`);
  console.log(`  FPC address:   ${config.fpc_address}`);
  console.log(`  Threshold:     ${threshold} wei`);
  console.log(`  Top-up amount: ${topUpAmount} wei`);
  console.log(`  Check interval: ${config.check_interval_ms}ms`);

  // Track whether a bridge is in-flight to avoid stacking multiple concurrent bridges
  let bridgeInFlight = false;

  async function checkAndTopUp() {
    if (bridgeInFlight) {
      console.log('Bridge already in-flight, skipping check');
      return;
    }

    let balance: bigint;
    try {
      balance = await getFeeJuiceBalance(pxe, fpcAddress);
    } catch (err) {
      console.error('Failed to read Fee Juice balance:', err);
      return;
    }

    console.log(`FPC Fee Juice balance: ${balance} wei (threshold: ${threshold})`);

    if (balance >= threshold) return;

    console.log(`Balance below threshold — initiating bridge of ${topUpAmount} wei`);
    bridgeInFlight = true;

    try {
      const result = await bridgeFeeJuice(
        config.l1_rpc_url,
        config.l1_operator_private_key as Hex,
        config.fee_juice_portal_address as Hex,
        config.fpc_address,
        topUpAmount,
      );

      console.log(`Bridge submitted. L1 tx: ${result.l1TxHash}`);
      console.log(`Bridged ${result.amount} wei. Waiting for L2 confirmation...`);

      // Wait for the L2 message to be processed. L1→L2 message processing
      // happens within the next few L2 blocks after L1 confirmation.
      // We wait a generous period before re-enabling checks.
      // TODO: replace with a proper L2 message confirmation check using
      //   pxe.getL1ToL2MembershipWitness or similar once the tx hash is known.
      await sleep(120_000); // 2 minutes
      console.log('Bridge cool-down complete. Resuming balance checks.');
    } catch (err) {
      console.error('Bridge failed:', err);
    } finally {
      bridgeInFlight = false;
    }
  }

  // Run once immediately, then on the configured interval
  await checkAndTopUp();
  setInterval(checkAndTopUp, config.check_interval_ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

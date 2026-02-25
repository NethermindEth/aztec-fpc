import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode, NodeInfo } from "@aztec/aztec.js/node";
import type { Config } from "../src/config.js";
import {
  createFeeJuiceBalanceReader,
  resolveFeeJuiceAddress,
} from "../src/monitor.js";

const TEST_AZTEC_ADDRESS =
  "0x27e0f62fe6edf34f850dd7c1cc7cd638f7ec38ed3eb5ae4bd8c0c941c78e67ac";
const TEST_FEE_JUICE_ADDRESS =
  "0x0000000000000000000000000000000000000000000000000000000000000005";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    fpc_address: TEST_AZTEC_ADDRESS,
    aztec_node_url: "http://localhost:8080",
    fee_juice_address: undefined,
    l1_chain_id: 31337,
    l1_rpc_url: "http://localhost:8545",
    fee_juice_portal_address: "0x6770742ecff10f57ac1f2e33ef54dca228ff9411",
    l1_operator_private_key:
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    l1_operator_private_key_source: "config",
    l1_operator_private_key_dual_source: false,
    threshold: "1",
    top_up_amount: "2",
    check_interval_ms: 60_000,
    confirmation_timeout_ms: 180_000,
    confirmation_poll_initial_ms: 1_000,
    confirmation_poll_max_ms: 15_000,
    ...overrides,
  };
}

function makeNodeInfo(feeJuiceAddress: AztecAddress): NodeInfo {
  return {
    nodeVersion: "test",
    l1ChainId: 31337,
    rollupVersion: 1,
    enr: undefined,
    l1ContractAddresses: {} as never,
    protocolContractAddresses: {
      classRegistry: feeJuiceAddress,
      feeJuice: feeJuiceAddress,
      instanceRegistry: feeJuiceAddress,
      multiCallEntrypoint: feeJuiceAddress,
    },
    realProofs: false,
  };
}

describe("monitor", () => {
  it("resolves fee juice address from explicit config override", async () => {
    const config = makeConfig({ fee_juice_address: TEST_FEE_JUICE_ADDRESS });
    const node = {
      getNodeInfo: async () => {
        throw new Error("should not be called");
      },
    } as unknown as AztecNode;

    const resolved = await resolveFeeJuiceAddress(config, node);
    assert.equal(resolved.source, "config");
    assert.equal(resolved.address.toString(), TEST_FEE_JUICE_ADDRESS);
  });

  it("resolves fee juice address from node info when no override is set", async () => {
    const config = makeConfig({ fee_juice_address: undefined });
    const nodeFeeJuice = AztecAddress.fromString(TEST_FEE_JUICE_ADDRESS);
    const node = {
      getNodeInfo: async () => makeNodeInfo(nodeFeeJuice),
    } as unknown as AztecNode;

    const resolved = await resolveFeeJuiceAddress(config, node);
    assert.equal(resolved.source, "node_info");
    assert.equal(resolved.address.toString(), TEST_FEE_JUICE_ADDRESS);
  });

  it("returns bigint balance via storage fallback path", async () => {
    const config = makeConfig({ fee_juice_address: TEST_FEE_JUICE_ADDRESS });
    const node = {
      getPublicStorageAt: async () => new Fr(42n),
    } as unknown as AztecNode;
    const owner = AztecAddress.fromString(TEST_AZTEC_ADDRESS);

    const reader = await createFeeJuiceBalanceReader(config, node);
    const balance = await reader.getBalance(owner);
    assert.equal(balance, 42n);
  });

  it("throws actionable error when balance read fails", async () => {
    const config = makeConfig({ fee_juice_address: TEST_FEE_JUICE_ADDRESS });
    const node = {
      getPublicStorageAt: async () => {
        throw new Error("rpc unavailable");
      },
    } as unknown as AztecNode;
    const owner = AztecAddress.fromString(TEST_AZTEC_ADDRESS);

    const reader = await createFeeJuiceBalanceReader(config, node);
    await assert.rejects(
      () => reader.getBalance(owner),
      /Unable to read Fee Juice balance from L2 storage/,
    );
  });
});

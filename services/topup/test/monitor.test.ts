import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode, NodeInfo } from "@aztec/aztec.js/node";
import {
  createFeeJuiceBalanceReader,
  resolveFeeJuiceAddress,
} from "../src/monitor.js";

const TEST_AZTEC_ADDRESS =
  "0x27e0f62fe6edf34f850dd7c1cc7cd638f7ec38ed3eb5ae4bd8c0c941c78e67ac";
const TEST_FEE_JUICE_ADDRESS =
  "0x0000000000000000000000000000000000000000000000000000000000000005";

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
  it("resolves fee juice address from node info", async () => {
    const nodeFeeJuice = AztecAddress.fromString(TEST_FEE_JUICE_ADDRESS);
    const node = {
      getNodeInfo: async () => makeNodeInfo(nodeFeeJuice),
    } as unknown as AztecNode;

    const resolved = await resolveFeeJuiceAddress(node);
    assert.equal(resolved.source, "node_info");
    assert.equal(resolved.address.toString(), TEST_FEE_JUICE_ADDRESS);
  });

  it("returns bigint balance via storage fallback path", async () => {
    const nodeFeeJuice = AztecAddress.fromString(TEST_FEE_JUICE_ADDRESS);
    const node = {
      getNodeInfo: async () => makeNodeInfo(nodeFeeJuice),
      getPublicStorageAt: async () => new Fr(42n),
    } as unknown as AztecNode;
    const owner = AztecAddress.fromString(TEST_AZTEC_ADDRESS);

    const reader = await createFeeJuiceBalanceReader(node);
    const balance = await reader.getBalance(owner);
    assert.equal(balance, 42n);
  });

  it("throws actionable error when balance read fails", async () => {
    const nodeFeeJuice = AztecAddress.fromString(TEST_FEE_JUICE_ADDRESS);
    const node = {
      getNodeInfo: async () => makeNodeInfo(nodeFeeJuice),
      getPublicStorageAt: async () => {
        throw new Error("rpc unavailable");
      },
    } as unknown as AztecNode;
    const owner = AztecAddress.fromString(TEST_AZTEC_ADDRESS);

    const reader = await createFeeJuiceBalanceReader(node);
    await assert.rejects(
      () => reader.getBalance(owner),
      /Unable to read Fee Juice balance from L2 storage/,
    );
  });

  it("throws when node reports zero fee juice address", async () => {
    const node = {
      getNodeInfo: async () => makeNodeInfo(AztecAddress.zero()),
    } as unknown as AztecNode;

    await assert.rejects(
      () => resolveFeeJuiceAddress(node),
      /protocolContractAddresses\.feeJuice/,
    );
  });
});

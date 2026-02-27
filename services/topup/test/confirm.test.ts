import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode } from "@aztec/aztec.js/node";
import { waitForFeeJuiceBridgeConfirmation } from "../src/confirm.js";

const FPC = AztecAddress.fromString(
  "0x27e0f62fe6edf34f850dd7c1cc7cd638f7ec38ed3eb5ae4bd8c0c941c78e67ac",
);
const MESSAGE_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000123";

describe("confirm", () => {
  it("confirms on balance delta when message check is still pending", async () => {
    let reads = 0;
    const result = await waitForFeeJuiceBridgeConfirmation(
      {
        balanceReader: {
          feeJuiceAddress: AztecAddress.zero(),
          addressSource: "node_info",
          getBalance: async () => {
            reads += 1;
            return reads < 2 ? 10n : 11n;
          },
        },
        fpcAddress: FPC,
        baselineBalance: 10n,
        timeoutMs: 200,
        initialPollMs: 1,
        maxPollMs: 5,
        messageContext: {
          node: {} as Pick<
            AztecNode,
            "getBlockNumber" | "getL1ToL2MessageBlock"
          >,
          messageHash: MESSAGE_HASH,
          forPublicConsumption: false,
        },
      },
      {
        waitForL1ToL2MessageReady: async (_node, _hash: Fr) => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          return true;
        },
      },
    );

    assert.equal(result.status, "confirmed");
    assert.equal(result.observedDelta, 1n);
    assert.equal(result.messageCheckAttempted, true);
    assert.equal(result.messageReady, false);
    assert.equal(result.messageCheckFailed, false);
  });

  it("falls back to balance polling when message check fails", async () => {
    let reads = 0;
    const result = await waitForFeeJuiceBridgeConfirmation(
      {
        balanceReader: {
          feeJuiceAddress: AztecAddress.zero(),
          addressSource: "node_info",
          getBalance: async () => {
            reads += 1;
            return reads < 3 ? 10n : 12n;
          },
        },
        fpcAddress: FPC,
        baselineBalance: 10n,
        timeoutMs: 400,
        initialPollMs: 1,
        maxPollMs: 5,
        messageContext: {
          node: {} as Pick<
            AztecNode,
            "getBlockNumber" | "getL1ToL2MessageBlock"
          >,
          messageHash: MESSAGE_HASH,
          forPublicConsumption: false,
        },
      },
      {
        waitForL1ToL2MessageReady: async () => {
          throw new Error("pxe unavailable");
        },
      },
    );

    assert.equal(result.status, "confirmed");
    assert.equal(result.observedDelta, 2n);
    assert.equal(result.messageCheckAttempted, true);
    assert.equal(result.messageReady, false);
    assert.equal(result.messageCheckFailed, true);
  });

  it("confirms when message becomes ready even without a balance delta", async () => {
    const result = await waitForFeeJuiceBridgeConfirmation(
      {
        balanceReader: {
          feeJuiceAddress: AztecAddress.zero(),
          addressSource: "node_info",
          getBalance: async () => 10n,
        },
        fpcAddress: FPC,
        baselineBalance: 10n,
        timeoutMs: 200,
        initialPollMs: 1,
        maxPollMs: 5,
        messageContext: {
          node: {} as Pick<
            AztecNode,
            "getBlockNumber" | "getL1ToL2MessageBlock"
          >,
          messageHash: MESSAGE_HASH,
          forPublicConsumption: false,
        },
      },
      {
        waitForL1ToL2MessageReady: async () => true,
      },
    );

    assert.equal(result.status, "confirmed");
    assert.equal(result.observedDelta, 0n);
    assert.equal(result.messageCheckAttempted, true);
    assert.equal(result.messageReady, true);
    assert.equal(result.messageCheckFailed, false);
  });

  it("does not throw when balance reads fail but message readiness confirms", async () => {
    await assert.doesNotReject(async () => {
      const result = await waitForFeeJuiceBridgeConfirmation(
        {
          balanceReader: {
            feeJuiceAddress: AztecAddress.zero(),
            addressSource: "node_info",
            getBalance: async () => {
              throw new Error("temporary balance rpc failure");
            },
          },
          fpcAddress: FPC,
          baselineBalance: 10n,
          timeoutMs: 200,
          initialPollMs: 1,
          maxPollMs: 5,
          messageContext: {
            node: {} as Pick<
              AztecNode,
              "getBlockNumber" | "getL1ToL2MessageBlock"
            >,
            messageHash: MESSAGE_HASH,
            forPublicConsumption: false,
          },
        },
        {
          waitForL1ToL2MessageReady: async () => true,
        },
      );

      assert.equal(result.status, "confirmed");
      assert.equal(result.messageReady, true);
    });
  });

  it("returns aborted when abort signal is triggered", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await waitForFeeJuiceBridgeConfirmation(
      {
        balanceReader: {
          feeJuiceAddress: AztecAddress.zero(),
          addressSource: "node_info",
          getBalance: async () => 10n,
        },
        fpcAddress: FPC,
        baselineBalance: 10n,
        timeoutMs: 200,
        initialPollMs: 1,
        maxPollMs: 5,
        abortSignal: controller.signal,
      },
      {
        waitForL1ToL2MessageReady: async () => false,
      },
    );

    assert.equal(result.status, "aborted");
  });
});

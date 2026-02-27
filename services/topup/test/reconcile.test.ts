import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { reconcilePersistedBridgeState } from "../src/reconcile.js";
import type { BridgeStateStore } from "../src/state.js";

const FPC = AztecAddress.fromString(
  "0x27e0f62fe6edf34f850dd7c1cc7cd638f7ec38ed3eb5ae4bd8c0c941c78e67ac",
);

function makeStore(
  value: Awaited<ReturnType<BridgeStateStore["read"]>>,
): BridgeStateStore & { clearCalls: number } {
  return {
    filePath: "/tmp/state.json",
    clearCalls: 0,
    read: async () => value,
    write: async () => {
      throw new Error("not used");
    },
    clear: async function clear() {
      this.clearCalls += 1;
    },
  };
}

describe("reconcile", () => {
  it("returns none when there is no persisted bridge", async () => {
    const store = makeStore(null);
    const result = await reconcilePersistedBridgeState(
      {
        stateStore: store,
        balanceReader: {
          feeJuiceAddress: AztecAddress.zero(),
          addressSource: "node_info",
          getBalance: async () => 0n,
        },
        node: {} as never,
        fpcAddress: FPC,
        timeoutMs: 1,
        initialPollMs: 1,
        maxPollMs: 1,
      },
      {
        confirmBridge: async () => {
          throw new Error("not used");
        },
      },
    );
    assert.equal(result, "none");
    assert.equal(store.clearCalls, 0);
  });

  it("clears persisted state after confirmed reconciliation", async () => {
    const store = makeStore({
      baselineBalance: "10",
      amount: "3",
      claimSecretHash: `0x${"11".repeat(32)}`,
      messageHash: `0x${"ab".repeat(32)}`,
      messageLeafIndex: "2",
      submittedAtMs: 1,
    });

    const result = await reconcilePersistedBridgeState(
      {
        stateStore: store,
        balanceReader: {
          feeJuiceAddress: AztecAddress.zero(),
          addressSource: "node_info",
          getBalance: async () => 10n,
        },
        node: {} as never,
        fpcAddress: FPC,
        timeoutMs: 1,
        initialPollMs: 1,
        maxPollMs: 1,
      },
      {
        confirmBridge: async () => ({
          status: "confirmed",
          baselineBalance: 10n,
          maxObservedBalance: 11n,
          lastObservedBalance: 11n,
          observedDelta: 1n,
          elapsedMs: 1,
          attempts: 1,
          pollErrors: 0,
          messageCheckAttempted: true,
          messageReady: true,
          messageCheckFailed: false,
        }),
      },
    );

    assert.equal(result, "confirmed");
    assert.equal(store.clearCalls, 1);
  });

  it("keeps persisted state when reconciliation is aborted", async () => {
    const store = makeStore({
      baselineBalance: "10",
      amount: "3",
      claimSecretHash: `0x${"11".repeat(32)}`,
      messageHash: `0x${"ab".repeat(32)}`,
      messageLeafIndex: "2",
      submittedAtMs: 1,
    });

    const result = await reconcilePersistedBridgeState(
      {
        stateStore: store,
        balanceReader: {
          feeJuiceAddress: AztecAddress.zero(),
          addressSource: "node_info",
          getBalance: async () => 10n,
        },
        node: {} as never,
        fpcAddress: FPC,
        timeoutMs: 1,
        initialPollMs: 1,
        maxPollMs: 1,
      },
      {
        confirmBridge: async () => ({
          status: "aborted",
          baselineBalance: 10n,
          maxObservedBalance: 10n,
          lastObservedBalance: 10n,
          observedDelta: 0n,
          elapsedMs: 1,
          attempts: 0,
          pollErrors: 0,
          messageCheckAttempted: true,
          messageReady: false,
          messageCheckFailed: false,
        }),
      },
    );

    assert.equal(result, "aborted");
    assert.equal(store.clearCalls, 0);
  });

  it("keeps persisted state when reconciliation times out", async () => {
    const store = makeStore({
      baselineBalance: "10",
      amount: "3",
      claimSecretHash: `0x${"11".repeat(32)}`,
      messageHash: `0x${"ab".repeat(32)}`,
      messageLeafIndex: "2",
      submittedAtMs: 1,
    });

    const result = await reconcilePersistedBridgeState(
      {
        stateStore: store,
        balanceReader: {
          feeJuiceAddress: AztecAddress.zero(),
          addressSource: "node_info",
          getBalance: async () => 10n,
        },
        node: {} as never,
        fpcAddress: FPC,
        timeoutMs: 1,
        initialPollMs: 1,
        maxPollMs: 1,
      },
      {
        confirmBridge: async () => ({
          status: "timeout",
          baselineBalance: 10n,
          maxObservedBalance: 10n,
          lastObservedBalance: 10n,
          observedDelta: 0n,
          elapsedMs: 1,
          attempts: 1,
          pollErrors: 0,
          messageCheckAttempted: true,
          messageReady: false,
          messageCheckFailed: false,
        }),
      },
    );

    assert.equal(result, "timeout");
    assert.equal(store.clearCalls, 0);
  });
});

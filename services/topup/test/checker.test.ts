import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTopupChecker } from "../src/checker.js";

const HASH = `0x${"ab".repeat(32)}` as `0x${string}`;

describe("checker", () => {
  it("does not bridge when balance is at or above threshold", async () => {
    let bridgeCalls = 0;
    let confirmCalls = 0;
    const checker = createTopupChecker(
      { threshold: 5n, topUpAmount: 2n },
      {
        getBalance: async () => 5n,
        bridge: async () => {
          bridgeCalls += 1;
          return { l1TxHash: HASH, amount: 2n };
        },
        confirm: async () => {
          confirmCalls += 1;
          return {
            status: "confirmed",
            baselineBalance: 0n,
            maxObservedBalance: 5n,
            lastObservedBalance: 5n,
            observedDelta: 5n,
            elapsedMs: 1,
            attempts: 1,
            pollErrors: 0,
          };
        },
      },
    );

    await checker.checkAndTopUp();
    assert.equal(bridgeCalls, 0);
    assert.equal(confirmCalls, 0);
    assert.equal(checker.isBridgeInFlight(), false);
  });

  it("bridges once while in-flight guard is active", async () => {
    let bridgeCalls = 0;
    let confirmCalls = 0;
    let confirmBaseline: bigint | undefined;

    let resolveBridge:
      | ((value: { l1TxHash: `0x${string}`; amount: bigint }) => void)
      | undefined;
    const bridgePromise = new Promise<{
      l1TxHash: `0x${string}`;
      amount: bigint;
    }>((resolve) => {
      resolveBridge = resolve;
    });

    const checker = createTopupChecker(
      { threshold: 5n, topUpAmount: 2n },
      {
        getBalance: async () => 1n,
        bridge: async () => {
          bridgeCalls += 1;
          return bridgePromise;
        },
        confirm: async (baselineBalance) => {
          confirmCalls += 1;
          confirmBaseline = baselineBalance;
          return {
            status: "timeout",
            baselineBalance,
            maxObservedBalance: 1n,
            lastObservedBalance: 1n,
            observedDelta: 0n,
            elapsedMs: 1,
            attempts: 1,
            pollErrors: 0,
          };
        },
      },
    );

    const firstRun = checker.checkAndTopUp();
    await Promise.resolve();
    assert.equal(checker.isBridgeInFlight(), true);

    await checker.checkAndTopUp();
    assert.equal(bridgeCalls, 1);

    resolveBridge?.({ l1TxHash: HASH, amount: 2n });
    await firstRun;

    assert.equal(confirmCalls, 1);
    assert.equal(confirmBaseline, 1n);
    assert.equal(checker.isBridgeInFlight(), false);
  });
});

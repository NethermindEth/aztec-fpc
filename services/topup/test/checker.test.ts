import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTopupChecker } from "../src/checker.js";

const HASH = `0x${"ab".repeat(32)}` as `0x${string}`;
const SECRET = `0x${"11".repeat(32)}`;
const SECRET_HASH = `0x${"22".repeat(32)}`;

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
          return {
            amount: 2n,
            claimSecret: SECRET,
            claimSecretHash: SECRET_HASH,
            messageHash: HASH,
            messageLeafIndex: 1n,
          };
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
      | ((value: {
          amount: bigint;
          claimSecret: string;
          claimSecretHash: string;
          messageHash: `0x${string}`;
          messageLeafIndex: bigint;
        }) => void)
      | undefined;
    const bridgePromise = new Promise<{
      amount: bigint;
      claimSecret: string;
      claimSecretHash: string;
      messageHash: `0x${string}`;
      messageLeafIndex: bigint;
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

    resolveBridge?.({
      amount: 2n,
      claimSecret: SECRET,
      claimSecretHash: SECRET_HASH,
      messageHash: HASH,
      messageLeafIndex: 1n,
    });
    await firstRun;

    assert.equal(confirmCalls, 1);
    assert.equal(confirmBaseline, 1n);
    assert.equal(checker.isBridgeInFlight(), false);
  });
});

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
            submittedAtMs: 1,
          };
        },
        confirm: async (_baselineBalance, _bridgeResult) => {
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
            messageCheckAttempted: true,
            messageReady: true,
            messageCheckFailed: false,
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
      submittedAtMs: number;
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
        confirm: async (baselineBalance, _bridgeResult) => {
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
            messageCheckAttempted: true,
            messageReady: false,
            messageCheckFailed: false,
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
      submittedAtMs: 1,
    });
    await firstRun;

    assert.equal(confirmCalls, 1);
    assert.equal(confirmBaseline, 1n);
    assert.equal(checker.isBridgeInFlight(), false);
  });

  it("does not start new checks after stop is requested", async () => {
    let getBalanceCalls = 0;
    let bridgeCalls = 0;
    const checker = createTopupChecker(
      { threshold: 5n, topUpAmount: 2n },
      {
        getBalance: async () => {
          getBalanceCalls += 1;
          return 1n;
        },
        bridge: async () => {
          bridgeCalls += 1;
          return {
            amount: 2n,
            claimSecret: SECRET,
            claimSecretHash: SECRET_HASH,
            messageHash: HASH,
            messageLeafIndex: 1n,
            submittedAtMs: 1,
          };
        },
        confirm: async () => ({
          status: "confirmed",
          baselineBalance: 1n,
          maxObservedBalance: 3n,
          lastObservedBalance: 3n,
          observedDelta: 2n,
          elapsedMs: 1,
          attempts: 1,
          pollErrors: 0,
          messageCheckAttempted: true,
          messageReady: true,
          messageCheckFailed: false,
        }),
      },
    );

    checker.requestStop();
    assert.equal(checker.isStopping(), true);
    await checker.checkAndTopUp();

    assert.equal(getBalanceCalls, 0);
    assert.equal(bridgeCalls, 0);
  });

  it("invokes bridge persistence hooks around submit and settle", async () => {
    let submitted = 0;
    let settled = 0;
    const checker = createTopupChecker(
      { threshold: 5n, topUpAmount: 2n },
      {
        getBalance: async () => 1n,
        bridge: async () => ({
          amount: 2n,
          claimSecret: SECRET,
          claimSecretHash: SECRET_HASH,
          messageHash: HASH,
          messageLeafIndex: 1n,
          submittedAtMs: 1,
        }),
        confirm: async () => ({
          status: "timeout",
          baselineBalance: 1n,
          maxObservedBalance: 1n,
          lastObservedBalance: 1n,
          observedDelta: 0n,
          elapsedMs: 1,
          attempts: 1,
          pollErrors: 0,
          messageCheckAttempted: true,
          messageReady: false,
          messageCheckFailed: false,
        }),
        onBridgeSubmitted: () => {
          submitted += 1;
        },
        onBridgeSettled: () => {
          settled += 1;
        },
      },
    );

    await checker.checkAndTopUp();
    assert.equal(submitted, 1);
    assert.equal(settled, 1);
  });
});

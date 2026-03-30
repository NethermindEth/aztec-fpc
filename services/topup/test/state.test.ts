import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { describe, it } from "#test";
import {
  type ReconcileBridgeStateOptions,
  reconcilePersistedBridgeState,
} from "../src/reconcile.js";
import {
  acquireProcessLock,
  createLmdbBridgeStateStore,
  openTopupDatabase,
  releaseProcessLock,
} from "../src/state.js";

const HASH = `0x${"ab".repeat(32)}` as `0x${string}`;
const FPC = AztecAddress.fromString(
  "0x27e0f62fe6edf34f850dd7c1cc7cd638f7ec38ed3eb5ae4bd8c0c941c78e67ac",
);

function stubNode(): ReconcileBridgeStateOptions["node"] {
  return {} as ReconcileBridgeStateOptions["node"];
}

function makeTempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "topup-state-test-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("lmdb bridge state store", () => {
  it("writes and reads persisted bridge metadata", async () => {
    const temp = makeTempDir();
    const db = await openTopupDatabase(path.join(temp.dir, "db"));
    const store = createLmdbBridgeStateStore(db, path.join(temp.dir, "db"));

    await store.write(10n, {
      amount: 3n,
      claimSecret: `0x${"33".repeat(32)}`,
      claimSecretHash: `0x${"11".repeat(32)}`,
      messageHash: HASH,
      messageLeafIndex: 9n,
      submittedAtMs: 1234,
    });

    const value = await store.read();
    assert.deepEqual(value, {
      baselineBalance: "10",
      amount: "3",
      claimSecret: `0x${"33".repeat(32)}`,
      claimSecretHash: `0x${"11".repeat(32)}`,
      messageHash: HASH,
      messageLeafIndex: "9",
      submittedAtMs: 1234,
    });

    await db.close();
    temp.cleanup();
  });

  it("returns null when no bridge state exists", async () => {
    const temp = makeTempDir();
    const db = await openTopupDatabase(path.join(temp.dir, "db"));
    const store = createLmdbBridgeStateStore(db, path.join(temp.dir, "db"));

    assert.equal(await store.read(), null);

    await db.close();
    temp.cleanup();
  });

  it("clears persisted bridge metadata", async () => {
    const temp = makeTempDir();
    const db = await openTopupDatabase(path.join(temp.dir, "db"));
    const store = createLmdbBridgeStateStore(db, path.join(temp.dir, "db"));

    await store.write(1n, {
      amount: 2n,
      claimSecret: `0x${"33".repeat(32)}`,
      claimSecretHash: `0x${"22".repeat(32)}`,
      messageHash: HASH,
      messageLeafIndex: 1n,
      submittedAtMs: 1,
    });
    await store.clear();
    assert.equal(await store.read(), null);

    await db.close();
    temp.cleanup();
  });

  it("overwrites existing bridge state on write", async () => {
    const temp = makeTempDir();
    const db = await openTopupDatabase(path.join(temp.dir, "db"));
    const store = createLmdbBridgeStateStore(db, path.join(temp.dir, "db"));

    await store.write(10n, {
      amount: 3n,
      claimSecret: `0x${"33".repeat(32)}`,
      claimSecretHash: `0x${"11".repeat(32)}`,
      messageHash: HASH,
      messageLeafIndex: 9n,
      submittedAtMs: 1000,
    });

    await store.write(20n, {
      amount: 5n,
      claimSecret: `0x${"44".repeat(32)}`,
      claimSecretHash: `0x${"55".repeat(32)}`,
      messageHash: `0x${"cd".repeat(32)}` as `0x${string}`,
      messageLeafIndex: 42n,
      submittedAtMs: 2000,
    });

    const value = await store.read();
    assert.equal(value?.baselineBalance, "20");
    assert.equal(value?.amount, "5");
    assert.equal(value?.submittedAtMs, 2000);

    await db.close();
    temp.cleanup();
  });

  it("creates data directory with 0o700 permissions", async () => {
    const temp = makeTempDir();
    const dbPath = path.join(temp.dir, "new-db");
    const db = await openTopupDatabase(dbPath);

    const mode = statSync(dbPath).mode & 0o777;
    assert.equal(mode, 0o700);

    await db.close();
    temp.cleanup();
  });

  it("throws on malformed data in LMDB", async () => {
    const temp = makeTempDir();
    const dbPath = path.join(temp.dir, "db");
    const db = await openTopupDatabase(dbPath);

    // Write garbage directly via the raw db handle
    await db.put("bridge", { bad: true });

    const store = createLmdbBridgeStateStore(db, dbPath);
    assert.throws(() => store.read(), /Bridge state is malformed/);

    await db.close();
    temp.cleanup();
  });

  it("sets a meaningful storageLabel", async () => {
    const temp = makeTempDir();
    const dbPath = path.join(temp.dir, "db");
    const db = await openTopupDatabase(dbPath);
    const store = createLmdbBridgeStateStore(db, path.join(temp.dir, "db"));

    assert.ok(store.storageLabel.startsWith("lmdb://"));

    await db.close();
    temp.cleanup();
  });
});

describe("crash recovery", () => {
  const bridgeInput = {
    amount: 5n,
    claimSecret: `0x${"aa".repeat(32)}`,
    claimSecretHash: `0x${"bb".repeat(32)}`,
    messageHash: HASH,
    messageLeafIndex: 7n,
    submittedAtMs: 1700000000000,
  };

  const expectedPersisted = {
    baselineBalance: "100",
    amount: "5",
    claimSecret: bridgeInput.claimSecret,
    claimSecretHash: bridgeInput.claimSecretHash,
    messageHash: HASH,
    messageLeafIndex: "7",
    submittedAtMs: 1700000000000,
  };

  it("recovers persisted bridge state after db close and reopen", async () => {
    const temp = makeTempDir();
    const dbPath = path.join(temp.dir, "db");

    // Session 1: write bridge state, then close (simulates crash)
    const db1 = await openTopupDatabase(dbPath);
    const store1 = createLmdbBridgeStateStore(db1, dbPath);
    await store1.write(100n, bridgeInput);
    await db1.close();

    // Session 2: reopen and verify state survived
    const db2 = await openTopupDatabase(dbPath);
    const store2 = createLmdbBridgeStateStore(db2, dbPath);
    const recovered = await store2.read();
    assert.deepEqual(recovered, expectedPersisted);

    await db2.close();
    temp.cleanup();
  });

  it("reconciles recovered state to confirmed and clears it", async () => {
    const temp = makeTempDir();
    const dbPath = path.join(temp.dir, "db");

    // Session 1: write bridge state, then close (simulates crash)
    const db1 = await openTopupDatabase(dbPath);
    const store1 = createLmdbBridgeStateStore(db1, dbPath);
    await store1.write(100n, bridgeInput);
    await db1.close();

    // Session 2: reopen and reconcile
    const db2 = await openTopupDatabase(dbPath);
    const store2 = createLmdbBridgeStateStore(db2, dbPath);

    const outcome = await reconcilePersistedBridgeState(
      {
        stateStore: store2,
        getBalance: async () => 105n,
        node: stubNode(),
        fpcAddress: FPC,
        timeoutMs: 1,
        initialPollMs: 1,
        maxPollMs: 1,
      },
      {
        confirmBridge: async () => ({
          status: "confirmed",
          baselineBalance: 100n,
          maxObservedBalance: 105n,
          lastObservedBalance: 105n,
          observedDelta: 5n,
          elapsedMs: 1,
          attempts: 1,
          pollErrors: 0,
          messageCheckAttempted: false,
          messageReady: false,
          messageCheckFailed: false,
          messageReadyActionAttempted: false,
          messageReadyActionSucceeded: false,
          messageReadyActionFailed: false,
        }),
      },
    );

    assert.equal(outcome, "confirmed");
    assert.equal(
      await store2.read(),
      null,
      "state should be cleared after confirmed reconciliation",
    );

    await db2.close();
    temp.cleanup();
  });

  it("preserves state across restart when reconciliation times out", async () => {
    const temp = makeTempDir();
    const dbPath = path.join(temp.dir, "db");

    // Session 1: write bridge state, then close
    const db1 = await openTopupDatabase(dbPath);
    const store1 = createLmdbBridgeStateStore(db1, dbPath);
    await store1.write(100n, bridgeInput);
    await db1.close();

    // Session 2: reconciliation times out — state should be preserved
    const db2 = await openTopupDatabase(dbPath);
    const store2 = createLmdbBridgeStateStore(db2, dbPath);

    const outcome = await reconcilePersistedBridgeState(
      {
        stateStore: store2,
        getBalance: async () => 100n,
        node: stubNode(),
        fpcAddress: FPC,
        timeoutMs: 1,
        initialPollMs: 1,
        maxPollMs: 1,
      },
      {
        confirmBridge: async () => ({
          status: "timeout",
          baselineBalance: 100n,
          maxObservedBalance: 100n,
          lastObservedBalance: 100n,
          observedDelta: 0n,
          elapsedMs: 1,
          attempts: 1,
          pollErrors: 0,
          messageCheckAttempted: false,
          messageReady: false,
          messageCheckFailed: false,
          messageReadyActionAttempted: false,
          messageReadyActionSucceeded: false,
          messageReadyActionFailed: false,
        }),
      },
    );

    assert.equal(outcome, "timeout");
    assert.deepEqual(await store2.read(), expectedPersisted, "state should survive for next retry");
    await db2.close();

    // Session 3: state still there for another attempt
    const db3 = await openTopupDatabase(dbPath);
    const store3 = createLmdbBridgeStateStore(db3, dbPath);
    assert.deepEqual(await store3.read(), expectedPersisted);
    await db3.close();

    temp.cleanup();
  });

  it("reconcile clears corrupt LMDB state and returns none", async () => {
    const temp = makeTempDir();
    const dbPath = path.join(temp.dir, "db");
    const db = await openTopupDatabase(dbPath);

    // Write garbage directly so store.read() throws
    await db.put("bridge", { bad: true });
    const store = createLmdbBridgeStateStore(db, dbPath);

    const outcome = await reconcilePersistedBridgeState(
      {
        stateStore: store,
        getBalance: async () => 0n,
        node: stubNode(),
        fpcAddress: FPC,
        timeoutMs: 1,
        initialPollMs: 1,
        maxPollMs: 1,
        logger: { log: () => {}, warn: () => {} },
      },
      { confirmBridge: () => Promise.reject(new Error("should not be called")) },
    );

    assert.equal(outcome, "none");
    assert.equal(await store.read(), null, "corrupt entry should have been cleared");

    await db.close();
    temp.cleanup();
  });
});

describe("process lock", () => {
  it("acquires lock and writes current PID", async () => {
    const temp = makeTempDir();
    const lockPath = path.join(temp.dir, "test.lock");
    await acquireProcessLock(lockPath);
    const content = readFileSync(lockPath, "utf8").trim();
    assert.equal(content, `${process.pid}`);
    await releaseProcessLock(lockPath);
    temp.cleanup();
  });

  it("rejects lock when another live process holds it", async () => {
    const temp = makeTempDir();
    const lockPath = path.join(temp.dir, "test.lock");
    writeFileSync(lockPath, `${process.pid}\n`, "utf8");
    await assert.rejects(() => acquireProcessLock(lockPath), /Another topup service instance/);
    await releaseProcessLock(lockPath);
    temp.cleanup();
  });

  it("overwrites stale lock from dead process", async () => {
    const temp = makeTempDir();
    const lockPath = path.join(temp.dir, "test.lock");
    writeFileSync(lockPath, "999999999\n", "utf8");
    await acquireProcessLock(lockPath);
    const content = readFileSync(lockPath, "utf8").trim();
    assert.equal(content, `${process.pid}`);
    await releaseProcessLock(lockPath);
    temp.cleanup();
  });

  it("releases lock by removing lock file", async () => {
    const temp = makeTempDir();
    const lockPath = path.join(temp.dir, "test.lock");
    await acquireProcessLock(lockPath);
    await releaseProcessLock(lockPath);
    await acquireProcessLock(lockPath);
    await releaseProcessLock(lockPath);
    temp.cleanup();
  });

  it("acquires lock when lock file contains non-numeric content", async () => {
    const temp = makeTempDir();
    const lockPath = path.join(temp.dir, "test.lock");
    writeFileSync(lockPath, "not-a-pid\n", "utf8");
    await acquireProcessLock(lockPath);
    const content = readFileSync(lockPath, "utf8").trim();
    assert.equal(content, `${process.pid}`);
    await releaseProcessLock(lockPath);
    temp.cleanup();
  });

  it("acquires lock when lock file is empty", async () => {
    const temp = makeTempDir();
    const lockPath = path.join(temp.dir, "test.lock");
    writeFileSync(lockPath, "", "utf8");
    await acquireProcessLock(lockPath);
    const content = readFileSync(lockPath, "utf8").trim();
    assert.equal(content, `${process.pid}`);
    await releaseProcessLock(lockPath);
    temp.cleanup();
  });
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createBridgeStateStore } from "../src/state.js";

const HASH = `0x${"ab".repeat(32)}` as `0x${string}`;

function makeTempFilePath() {
  const dir = mkdtempSync(path.join(tmpdir(), "topup-state-test-"));
  const filePath = path.join(dir, "bridge-state.json");
  return {
    filePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("state", () => {
  it("writes and reads persisted bridge metadata", async () => {
    const temp = makeTempFilePath();
    const store = createBridgeStateStore(temp.filePath);

    await store.write(10n, {
      amount: 3n,
      claimSecretHash: `0x${"11".repeat(32)}`,
      messageHash: HASH,
      messageLeafIndex: 9n,
      submittedAtMs: 1234,
    });

    const value = await store.read();
    assert.deepEqual(value, {
      baselineBalance: "10",
      amount: "3",
      claimSecretHash: `0x${"11".repeat(32)}`,
      messageHash: HASH,
      messageLeafIndex: "9",
      submittedAtMs: 1234,
    });

    temp.cleanup();
  });

  it("returns null when state file does not exist", async () => {
    const temp = makeTempFilePath();
    const store = createBridgeStateStore(temp.filePath);
    assert.equal(await store.read(), null);
    temp.cleanup();
  });

  it("clears persisted bridge metadata", async () => {
    const temp = makeTempFilePath();
    const store = createBridgeStateStore(temp.filePath);

    await store.write(1n, {
      amount: 2n,
      claimSecretHash: `0x${"22".repeat(32)}`,
      messageHash: HASH,
      messageLeafIndex: 1n,
      submittedAtMs: 1,
    });
    await store.clear();
    assert.equal(await store.read(), null);

    temp.cleanup();
  });

  it("throws actionable error when state file is malformed", async () => {
    const temp = makeTempFilePath();
    writeFileSync(temp.filePath, "{bad-json", "utf8");

    const store = createBridgeStateStore(temp.filePath);
    await assert.rejects(
      () => store.read(),
      /Bridge state file is not valid JSON/,
    );

    temp.cleanup();
  });

  it("throws actionable error when persisted payload fields are invalid", async () => {
    const temp = makeTempFilePath();
    writeFileSync(
      temp.filePath,
      JSON.stringify({
        version: 1,
        bridge: {
          baselineBalance: "10",
          amount: "0",
          claimSecretHash: "not-a-field",
          messageHash: HASH,
          messageLeafIndex: "2",
          submittedAtMs: 1,
        },
      }),
      "utf8",
    );

    const store = createBridgeStateStore(temp.filePath);
    await assert.rejects(
      () => store.read(),
      /amount must be greater than zero|claimSecretHash must be a 32-byte 0x-prefixed hex string/,
    );

    temp.cleanup();
  });
});

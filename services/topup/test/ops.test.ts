import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTopupOpsServer, TopupOpsState } from "../src/ops.js";

describe("topup ops", () => {
  it("reports readiness transitions based on balance check outcomes", () => {
    const state = new TopupOpsState({ checkIntervalMs: 1_000 });

    const initial = state.snapshotReadiness(10_000);
    assert.equal(initial.ready, false);
    assert.equal(initial.status, "not_ready");
    assert.equal(
      initial.reasons.some(
        (reason) => reason.code === "no_successful_balance_checks",
      ),
      true,
    );

    state.recordBalanceCheckSuccess();
    const ready = state.snapshotReadiness();
    assert.equal(ready.ready, true);
    assert.equal(ready.checks.last_balance_check_ok, true);

    state.recordBalanceCheckFailure(new Error("rpc unavailable"));
    const failed = state.snapshotReadiness();
    assert.equal(failed.ready, false);
    assert.equal(
      failed.reasons.some(
        (reason) => reason.code === "last_balance_check_failed",
      ),
      true,
    );
  });

  it("serves /health /ready and /metrics from ops server", async () => {
    const state = new TopupOpsState({ checkIntervalMs: 1_000 });
    const server = createTopupOpsServer(state);
    await server.listen("127.0.0.1", 0);

    const port = server.port();
    assert.notEqual(port, null);
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const health = await fetch(`${baseUrl}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: "ok" });

      const notReady = await fetch(`${baseUrl}/ready`);
      assert.equal(notReady.status, 503);
      const notReadyBody = (await notReady.json()) as {
        ready: boolean;
        reasons: Array<{ code: string }>;
      };
      assert.equal(notReadyBody.ready, false);
      assert.equal(
        notReadyBody.reasons.some(
          (reason) => reason.code === "no_successful_balance_checks",
        ),
        true,
      );

      state.recordBalanceCheckSuccess();
      state.recordBridgeEvent("submitted");
      state.recordBridgeEvent("confirmed");
      state.recordBridgeEvent("timeout");

      const ready = await fetch(`${baseUrl}/ready`);
      assert.equal(ready.status, 200);
      const readyBody = (await ready.json()) as { ready: boolean };
      assert.equal(readyBody.ready, true);

      const metrics = await fetch(`${baseUrl}/metrics`);
      assert.equal(metrics.status, 200);
      const metricsBody = await metrics.text();
      assert.match(
        metricsBody,
        /topup_bridge_events_total\{event="submitted"\} 1/,
      );
      assert.match(
        metricsBody,
        /topup_bridge_events_total\{event="confirmed"\} 1/,
      );
      assert.match(
        metricsBody,
        /topup_bridge_events_total\{event="timeout"\} 1/,
      );
    } finally {
      await server.close();
    }
  });
});

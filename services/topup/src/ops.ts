import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export type BridgeMetricEvent =
  | "submitted"
  | "confirmed"
  | "timeout"
  | "aborted"
  | "failed";

const BRIDGE_EVENTS: BridgeMetricEvent[] = [
  "submitted",
  "confirmed",
  "timeout",
  "aborted",
  "failed",
];

interface TopupReadinessReason {
  code: string;
  message: string;
}

export interface TopupReadinessSnapshot {
  ready: boolean;
  status: "ready" | "not_ready";
  reasons: TopupReadinessReason[];
  checks: {
    successful_balance_checks: number;
    failed_balance_checks: number;
    last_balance_check_ok: boolean;
    last_balance_check_age_seconds: number | null;
  };
}

export interface TopupOpsStateOptions {
  checkIntervalMs: number;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

export class TopupOpsState {
  private readonly startedAtMs = Date.now();
  private readonly staleBalanceCheckAfterMs: number;
  private readonly bridgeEventTotals = new Map<BridgeMetricEvent, number>();
  private successfulBalanceChecks = 0;
  private failedBalanceChecks = 0;
  private lastBalanceCheckAtMs: number | undefined;
  private lastBalanceCheckOk = false;
  private lastBalanceCheckError: string | undefined;
  private shutdownRequested = false;

  constructor(options: TopupOpsStateOptions) {
    this.staleBalanceCheckAfterMs = Math.max(
      options.checkIntervalMs * 3,
      30_000,
    );
    for (const event of BRIDGE_EVENTS) {
      this.bridgeEventTotals.set(event, 0);
    }
  }

  recordBalanceCheckSuccess(): void {
    this.successfulBalanceChecks += 1;
    this.lastBalanceCheckAtMs = Date.now();
    this.lastBalanceCheckOk = true;
    this.lastBalanceCheckError = undefined;
  }

  recordBalanceCheckFailure(error: unknown): void {
    this.failedBalanceChecks += 1;
    this.lastBalanceCheckAtMs = Date.now();
    this.lastBalanceCheckOk = false;
    this.lastBalanceCheckError = formatErrorMessage(error);
  }

  recordBridgeEvent(event: BridgeMetricEvent): void {
    this.bridgeEventTotals.set(
      event,
      (this.bridgeEventTotals.get(event) ?? 0) + 1,
    );
  }

  markShutdownRequested(): void {
    this.shutdownRequested = true;
  }

  snapshotReadiness(nowMs = Date.now()): TopupReadinessSnapshot {
    const reasons: TopupReadinessReason[] = [];
    const lastBalanceCheckAgeSeconds =
      this.lastBalanceCheckAtMs === undefined
        ? null
        : Math.max(0, Math.floor((nowMs - this.lastBalanceCheckAtMs) / 1000));

    if (this.shutdownRequested) {
      reasons.push({
        code: "shutdown_in_progress",
        message: "Graceful shutdown has been requested",
      });
    }

    if (this.successfulBalanceChecks === 0) {
      reasons.push({
        code: "no_successful_balance_checks",
        message: "No successful Fee Juice balance checks yet",
      });
    }

    if (!this.lastBalanceCheckOk && this.failedBalanceChecks > 0) {
      reasons.push({
        code: "last_balance_check_failed",
        message: this.lastBalanceCheckError
          ? `Last Fee Juice balance check failed: ${this.lastBalanceCheckError}`
          : "Last Fee Juice balance check failed",
      });
    }

    if (
      this.lastBalanceCheckAtMs !== undefined &&
      nowMs - this.lastBalanceCheckAtMs > this.staleBalanceCheckAfterMs
    ) {
      reasons.push({
        code: "balance_check_stale",
        message: `Last Fee Juice balance check is stale (> ${this.staleBalanceCheckAfterMs}ms)`,
      });
    }

    const ready = reasons.length === 0;

    return {
      ready,
      status: ready ? "ready" : "not_ready",
      reasons,
      checks: {
        successful_balance_checks: this.successfulBalanceChecks,
        failed_balance_checks: this.failedBalanceChecks,
        last_balance_check_ok: this.lastBalanceCheckOk,
        last_balance_check_age_seconds: lastBalanceCheckAgeSeconds,
      },
    };
  }

  renderPrometheus(nowMs = Date.now()): string {
    const readiness = this.snapshotReadiness(nowMs);
    const lines: string[] = [
      "# HELP topup_bridge_events_total Count of top-up bridge lifecycle events by outcome.",
      "# TYPE topup_bridge_events_total counter",
    ];

    for (const event of BRIDGE_EVENTS) {
      lines.push(
        `topup_bridge_events_total{event="${event}"} ${this.bridgeEventTotals.get(event) ?? 0}`,
      );
    }

    lines.push(
      "# HELP topup_balance_checks_total Count of Fee Juice balance checks by outcome.",
      "# TYPE topup_balance_checks_total counter",
      `topup_balance_checks_total{outcome="success"} ${this.successfulBalanceChecks}`,
      `topup_balance_checks_total{outcome="error"} ${this.failedBalanceChecks}`,
      "# HELP topup_readiness_status 1 when service is ready, 0 otherwise.",
      "# TYPE topup_readiness_status gauge",
      `topup_readiness_status ${readiness.ready ? 1 : 0}`,
      "# HELP topup_uptime_seconds Service uptime in seconds.",
      "# TYPE topup_uptime_seconds gauge",
      `topup_uptime_seconds ${Math.max(0, Math.floor((nowMs - this.startedAtMs) / 1000))}`,
    );

    return `${lines.join("\n")}\n`;
  }
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  body: string,
): void {
  response.statusCode = statusCode;
  response.setHeader(
    "content-type",
    "text/plain; version=0.0.4; charset=utf-8",
  );
  response.end(body);
}

function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: TopupOpsState,
): void {
  const method = request.method ?? "GET";
  if (method !== "GET") {
    sendJson(response, 405, {
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "Only GET is supported",
      },
    });
    return;
  }

  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const nowMs = Date.now();

  if (url.pathname === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (url.pathname === "/ready") {
    const readiness = state.snapshotReadiness(nowMs);
    sendJson(response, readiness.ready ? 200 : 503, readiness);
    return;
  }

  if (url.pathname === "/metrics") {
    sendText(response, 200, state.renderPrometheus(nowMs));
    return;
  }

  sendJson(response, 404, {
    error: {
      code: "NOT_FOUND",
      message: "Not found",
    },
  });
}

export interface TopupOpsServer {
  listen(host: string, port: number): Promise<void>;
  close(): Promise<void>;
  port(): number | null;
}

export function createTopupOpsServer(state: TopupOpsState): TopupOpsServer {
  const server = createServer((request, response) => {
    routeRequest(request, response, state);
  });

  return {
    listen(host: string, port: number): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    port(): number | null {
      const address = server.address();
      if (!address || typeof address === "string") {
        return null;
      }
      return address.port;
    },
  };
}

export type QuoteOutcome =
  | "success"
  | "bad_request"
  | "unauthorized"
  | "rate_limited"
  | "internal_error";

const QUOTE_OUTCOMES: QuoteOutcome[] = [
  "success",
  "bad_request",
  "unauthorized",
  "rate_limited",
  "internal_error",
];

const ERROR_OUTCOMES: Exclude<QuoteOutcome, "success">[] = [
  "bad_request",
  "unauthorized",
  "rate_limited",
  "internal_error",
];

const LATENCY_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5,
];

interface QuoteLatencyHistogramState {
  bucketCounts: number[];
  count: number;
  sumSeconds: number;
}

function createLatencyState(): QuoteLatencyHistogramState {
  return {
    bucketCounts: Array.from(
      { length: LATENCY_BUCKETS_SECONDS.length },
      () => 0,
    ),
    count: 0,
    sumSeconds: 0,
  };
}

export class AttestationMetrics {
  private readonly quoteRequestsTotal = new Map<QuoteOutcome, number>();
  private readonly quoteErrorsTotal = new Map<
    Exclude<QuoteOutcome, "success">,
    number
  >();
  private readonly quoteLatency = new Map<
    QuoteOutcome,
    QuoteLatencyHistogramState
  >();

  constructor() {
    for (const outcome of QUOTE_OUTCOMES) {
      this.quoteRequestsTotal.set(outcome, 0);
      this.quoteLatency.set(outcome, createLatencyState());
    }

    for (const outcome of ERROR_OUTCOMES) {
      this.quoteErrorsTotal.set(outcome, 0);
    }
  }

  observeQuote(outcome: QuoteOutcome, durationSeconds: number): void {
    this.quoteRequestsTotal.set(
      outcome,
      (this.quoteRequestsTotal.get(outcome) ?? 0) + 1,
    );

    if (outcome !== "success") {
      this.quoteErrorsTotal.set(
        outcome,
        (this.quoteErrorsTotal.get(outcome) ?? 0) + 1,
      );
    }

    const latency = this.quoteLatency.get(outcome);
    if (!latency) {
      return;
    }

    latency.count += 1;
    latency.sumSeconds += durationSeconds;
    for (const [idx, bucketUpperBound] of LATENCY_BUCKETS_SECONDS.entries()) {
      if (durationSeconds <= bucketUpperBound) {
        latency.bucketCounts[idx] += 1;
        break;
      }
    }
  }

  renderPrometheus(): string {
    const lines: string[] = [];

    lines.push(
      "# HELP attestation_quote_requests_total Count of /quote requests by outcome.",
      "# TYPE attestation_quote_requests_total counter",
    );
    for (const outcome of QUOTE_OUTCOMES) {
      lines.push(
        `attestation_quote_requests_total{outcome="${outcome}"} ${this.quoteRequestsTotal.get(outcome) ?? 0}`,
      );
    }

    lines.push(
      "# HELP attestation_quote_errors_total Count of /quote failures by error type.",
      "# TYPE attestation_quote_errors_total counter",
    );
    for (const errorType of ERROR_OUTCOMES) {
      lines.push(
        `attestation_quote_errors_total{error_type="${errorType}"} ${this.quoteErrorsTotal.get(errorType) ?? 0}`,
      );
    }

    lines.push(
      "# HELP attestation_quote_latency_seconds Latency histogram for /quote requests by outcome.",
      "# TYPE attestation_quote_latency_seconds histogram",
    );
    for (const outcome of QUOTE_OUTCOMES) {
      const latency = this.quoteLatency.get(outcome) ?? createLatencyState();
      let cumulative = 0;
      for (const [idx, bucketUpperBound] of LATENCY_BUCKETS_SECONDS.entries()) {
        cumulative += latency.bucketCounts[idx] ?? 0;
        lines.push(
          `attestation_quote_latency_seconds_bucket{outcome="${outcome}",le="${bucketUpperBound}"} ${cumulative}`,
        );
      }
      lines.push(
        `attestation_quote_latency_seconds_bucket{outcome="${outcome}",le="+Inf"} ${latency.count}`,
        `attestation_quote_latency_seconds_sum{outcome="${outcome}"} ${latency.sumSeconds}`,
        `attestation_quote_latency_seconds_count{outcome="${outcome}"} ${latency.count}`,
      );
    }

    return `${lines.join("\n")}\n`;
  }
}

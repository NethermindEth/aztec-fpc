import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { FeeJuiceBalanceReader } from "./monitor.js";

export type BridgeConfirmationStatus = "confirmed" | "timeout";

export interface BridgeConfirmationOptions {
  balanceReader: FeeJuiceBalanceReader;
  fpcAddress: AztecAddress;
  baselineBalance: bigint;
  timeoutMs: number;
  initialPollMs: number;
  maxPollMs: number;
}

export interface BridgeConfirmationResult {
  status: BridgeConfirmationStatus;
  baselineBalance: bigint;
  maxObservedBalance: bigint;
  lastObservedBalance: bigint;
  observedDelta: bigint;
  elapsedMs: number;
  attempts: number;
  pollErrors: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Confirms a bridge by observing Fee Juice balance growth on L2.
 *
 * This is the explicit fallback strategy when message-level confirmation APIs
 * are unavailable in the current service flow.
 */
export async function waitForFeeJuiceBridgeConfirmation(
  options: BridgeConfirmationOptions,
): Promise<BridgeConfirmationResult> {
  const start = Date.now();
  const deadline = start + options.timeoutMs;
  let pollMs = options.initialPollMs;
  let maxObservedBalance = options.baselineBalance;
  let lastObservedBalance = options.baselineBalance;
  let attempts = 0;
  let pollErrors = 0;
  let successfulReads = 0;

  while (Date.now() <= deadline) {
    attempts += 1;
    try {
      const balance = await options.balanceReader.getBalance(
        options.fpcAddress,
      );
      successfulReads += 1;
      lastObservedBalance = balance;
      if (balance > maxObservedBalance) {
        maxObservedBalance = balance;
      }

      const observedDelta = maxObservedBalance - options.baselineBalance;
      if (observedDelta > 0n) {
        return {
          status: "confirmed",
          baselineBalance: options.baselineBalance,
          maxObservedBalance,
          lastObservedBalance,
          observedDelta,
          elapsedMs: Date.now() - start,
          attempts,
          pollErrors,
        };
      }
    } catch (error) {
      pollErrors += 1;
      console.warn("Fee Juice confirmation poll failed; retrying", error);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(pollMs, remainingMs));
    pollMs = Math.min(options.maxPollMs, Math.floor(pollMs * 1.5));
  }

  if (successfulReads === 0) {
    throw new Error(
      `Unable to read Fee Juice balance during confirmation polling after ${attempts} attempt(s)`,
    );
  }

  return {
    status: "timeout",
    baselineBalance: options.baselineBalance,
    maxObservedBalance,
    lastObservedBalance,
    observedDelta: maxObservedBalance - options.baselineBalance,
    elapsedMs: Date.now() - start,
    attempts,
    pollErrors,
  };
}

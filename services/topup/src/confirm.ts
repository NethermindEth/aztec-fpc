import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { Hex } from "viem";
import type { FeeJuiceBalanceReader } from "./monitor.js";

export type BridgeConfirmationStatus = "confirmed" | "timeout";

export interface BridgeMessageContext {
  node: Pick<AztecNode, "getBlockNumber" | "getL1ToL2MessageBlock">;
  messageHash: Hex;
  forPublicConsumption: boolean;
}

export interface BridgeConfirmationOptions {
  balanceReader: FeeJuiceBalanceReader;
  fpcAddress: AztecAddress;
  baselineBalance: bigint;
  timeoutMs: number;
  initialPollMs: number;
  maxPollMs: number;
  messageContext?: BridgeMessageContext;
}

export interface BridgeConfirmDeps {
  waitForL1ToL2MessageReady: typeof waitForL1ToL2MessageReady;
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
  messageCheckAttempted: boolean;
  messageReady: boolean;
  messageCheckFailed: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_CONFIRM_DEPS: BridgeConfirmDeps = {
  waitForL1ToL2MessageReady,
};

/**
 * Confirms a bridge by combining message-level readiness checks and
 * Fee Juice balance growth observation.
 *
 * Message readiness is a stronger signal that the L1->L2 bridge message has
 * entered the consumable state. Balance polling remains the fallback and final
 * guardrail for observable Fee Juice effects on the target FPC.
 */
export async function waitForFeeJuiceBridgeConfirmation(
  options: BridgeConfirmationOptions,
  depsOverride: Partial<BridgeConfirmDeps> = {},
): Promise<BridgeConfirmationResult> {
  const deps: BridgeConfirmDeps = { ...DEFAULT_CONFIRM_DEPS, ...depsOverride };
  const start = Date.now();
  const deadline = start + options.timeoutMs;
  let pollMs = options.initialPollMs;
  let maxObservedBalance = options.baselineBalance;
  let lastObservedBalance = options.baselineBalance;
  let attempts = 0;
  let pollErrors = 0;
  let successfulReads = 0;
  let messageCheckAttempted = false;
  let messageReady = false;
  let messageCheckFailed = false;
  let messageWaitPromise: Promise<void> | undefined;

  if (options.messageContext) {
    messageCheckAttempted = true;
    let messageHash: Fr | undefined;
    try {
      messageHash = Fr.fromHexString(options.messageContext.messageHash);
    } catch (error) {
      messageCheckFailed = true;
      console.warn(
        "L1->L2 message hash is not a valid field element; skipping message readiness check",
        error,
      );
    }

    if (messageHash) {
      const timeoutSeconds = Math.max(1, Math.floor(options.timeoutMs / 1000));
      messageWaitPromise = deps
        .waitForL1ToL2MessageReady(options.messageContext.node, messageHash, {
          timeoutSeconds,
          forPublicConsumption: options.messageContext.forPublicConsumption,
        })
        .then((ready) => {
          messageReady = ready;
        })
        .catch((error) => {
          messageCheckFailed = true;
          console.warn("L1->L2 message readiness check failed", error);
        });
    }
  }

  async function settleMessageCheckNonBlocking() {
    if (!messageWaitPromise) {
      return;
    }
    await Promise.race([messageWaitPromise, sleep(0)]);
  }

  function buildConfirmedResult(): BridgeConfirmationResult {
    return {
      status: "confirmed",
      baselineBalance: options.baselineBalance,
      maxObservedBalance,
      lastObservedBalance,
      observedDelta: maxObservedBalance - options.baselineBalance,
      elapsedMs: Date.now() - start,
      attempts,
      pollErrors,
      messageCheckAttempted,
      messageReady,
      messageCheckFailed,
    };
  }

  while (Date.now() <= deadline) {
    attempts += 1;
    await settleMessageCheckNonBlocking();
    if (messageReady) {
      return buildConfirmedResult();
    }

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
        await settleMessageCheckNonBlocking();
        return buildConfirmedResult();
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

  await settleMessageCheckNonBlocking();
  if (messageReady) {
    return buildConfirmedResult();
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
    messageCheckAttempted,
    messageReady,
    messageCheckFailed,
  };
}

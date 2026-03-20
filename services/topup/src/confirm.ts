import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import type { AztecNode } from "@aztec/aztec.js/node";
import pino from "pino";
import type { Hex } from "viem";
import type { FeeJuiceBalanceReader } from "./monitor.js";

const pinoLogger = pino();

export type BridgeConfirmationStatus = "confirmed" | "timeout" | "aborted";

export interface BridgeMessageContext {
  node: Pick<AztecNode, "getBlock" | "getL1ToL2MessageCheckpoint">;
  messageHash: Hex;
}

export interface BridgeConfirmationOptions {
  balanceReader: FeeJuiceBalanceReader;
  fpcAddress: AztecAddress;
  baselineBalance: bigint;
  timeoutMs: number;
  initialPollMs: number;
  maxPollMs: number;
  messageContext?: BridgeMessageContext;
  onMessageReady?: () => Promise<void> | void;
  abortSignal?: AbortSignal;
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
  messageReadyActionAttempted: boolean;
  messageReadyActionSucceeded: boolean;
  messageReadyActionFailed: boolean;
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error("confirmation polling aborted"));
    };

    function cleanup() {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
    }

    if (abortSignal) {
      if (abortSignal.aborted) {
        cleanup();
        reject(new Error("confirmation polling aborted"));
        return;
      }
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

const DEFAULT_CONFIRM_DEPS: BridgeConfirmDeps = {
  waitForL1ToL2MessageReady,
};

interface BridgeConfirmationState {
  startMs: number;
  deadlineMs: number;
  pollMs: number;
  maxObservedBalance: bigint;
  lastObservedBalance: bigint;
  attempts: number;
  pollErrors: number;
  successfulReads: number;
  messageCheckAttempted: boolean;
  messageReady: boolean;
  messageCheckFailed: boolean;
  messageReadyActionAttempted: boolean;
  messageReadyActionSucceeded: boolean;
  messageReadyActionFailed: boolean;
}

function createBridgeConfirmationState(
  options: BridgeConfirmationOptions,
): BridgeConfirmationState {
  const startMs = Date.now();
  return {
    startMs,
    deadlineMs: startMs + options.timeoutMs,
    pollMs: options.initialPollMs,
    maxObservedBalance: options.baselineBalance,
    lastObservedBalance: options.baselineBalance,
    attempts: 0,
    pollErrors: 0,
    successfulReads: 0,
    messageCheckAttempted: false,
    messageReady: false,
    messageCheckFailed: false,
    messageReadyActionAttempted: false,
    messageReadyActionSucceeded: false,
    messageReadyActionFailed: false,
  };
}

function buildResult(
  options: BridgeConfirmationOptions,
  state: BridgeConfirmationState,
  status: BridgeConfirmationStatus,
): BridgeConfirmationResult {
  return {
    status,
    baselineBalance: options.baselineBalance,
    maxObservedBalance: state.maxObservedBalance,
    lastObservedBalance: state.lastObservedBalance,
    observedDelta: state.maxObservedBalance - options.baselineBalance,
    elapsedMs: Date.now() - state.startMs,
    attempts: state.attempts,
    pollErrors: state.pollErrors,
    messageCheckAttempted: state.messageCheckAttempted,
    messageReady: state.messageReady,
    messageCheckFailed: state.messageCheckFailed,
    messageReadyActionAttempted: state.messageReadyActionAttempted,
    messageReadyActionSucceeded: state.messageReadyActionSucceeded,
    messageReadyActionFailed: state.messageReadyActionFailed,
  };
}

function isAborted(abortSignal?: AbortSignal): boolean {
  return abortSignal?.aborted === true;
}

async function settleMessageCheckNonBlocking(messageWaitPromise?: Promise<void>): Promise<void> {
  if (!messageWaitPromise) {
    return;
  }
  await Promise.race([messageWaitPromise, sleep(0)]);
}

function startMessageReadinessCheck(
  options: BridgeConfirmationOptions,
  deps: BridgeConfirmDeps,
  state: BridgeConfirmationState,
): Promise<void> | undefined {
  if (!options.messageContext) {
    return undefined;
  }

  state.messageCheckAttempted = true;
  let messageHash: Fr | undefined;
  try {
    messageHash = Fr.fromHexString(options.messageContext.messageHash);
  } catch (error) {
    state.messageCheckFailed = true;
    pinoLogger.warn(
      { err: error },
      "L1->L2 message hash is not a valid field element; skipping message readiness check",
    );
  }
  if (!messageHash) {
    return undefined;
  }

  const timeoutSeconds = Math.max(1, Math.floor(options.timeoutMs / 1000));
  return deps
    .waitForL1ToL2MessageReady(options.messageContext.node, messageHash, {
      timeoutSeconds,
    })
    .then((ready) => {
      state.messageReady = ready;
    })
    .catch((error) => {
      state.messageCheckFailed = true;
      pinoLogger.warn({ err: error }, "L1->L2 message readiness check failed");
    });
}

async function maybeRunMessageReadyAction(
  options: BridgeConfirmationOptions,
  state: BridgeConfirmationState,
): Promise<void> {
  if (
    !state.messageReady ||
    !options.onMessageReady ||
    state.messageReadyActionSucceeded ||
    state.messageReadyActionAttempted
  ) {
    return;
  }

  state.messageReadyActionAttempted = true;
  try {
    await options.onMessageReady();
    state.messageReadyActionSucceeded = true;
  } catch (error) {
    state.messageReadyActionFailed = true;
    pinoLogger.warn({ err: error }, "Message-ready action failed; retrying");
  }
}

async function pollBalanceOnce(
  options: BridgeConfirmationOptions,
  state: BridgeConfirmationState,
): Promise<boolean> {
  try {
    const balance = await options.balanceReader.getBalance(options.fpcAddress);
    state.successfulReads += 1;
    state.lastObservedBalance = balance;
    if (balance > state.maxObservedBalance) {
      state.maxObservedBalance = balance;
    }
    return state.maxObservedBalance - options.baselineBalance > 0n;
  } catch (error) {
    state.pollErrors += 1;
    pinoLogger.warn({ err: error }, "Fee Juice confirmation poll failed; retrying");
    return false;
  }
}

async function waitForNextPoll(
  state: BridgeConfirmationState,
  maxPollMs: number,
  abortSignal?: AbortSignal,
): Promise<"continue" | "aborted" | "timeout"> {
  const remainingMs = state.deadlineMs - Date.now();
  if (remainingMs <= 0) {
    return "timeout";
  }
  try {
    await sleep(Math.min(state.pollMs, remainingMs), abortSignal);
  } catch {
    return "aborted";
  }
  state.pollMs = Math.min(maxPollMs, Math.floor(state.pollMs * 1.5));
  return "continue";
}

async function pollUntilConfirmed(
  options: BridgeConfirmationOptions,
  state: BridgeConfirmationState,
  messageWaitPromise: Promise<void> | undefined,
): Promise<BridgeConfirmationStatus | undefined> {
  while (Date.now() <= state.deadlineMs) {
    if (isAborted(options.abortSignal)) {
      return "aborted";
    }

    state.attempts += 1;
    await settleMessageCheckNonBlocking(messageWaitPromise);
    await maybeRunMessageReadyAction(options, state);

    const balanceDeltaPositive = await pollBalanceOnce(options, state);
    if (balanceDeltaPositive) {
      await settleMessageCheckNonBlocking(messageWaitPromise);
      // When messageContext is provided we require both balance growth AND
      // message readiness to avoid false confirmation from external deposits.
      // Exception: if the message check itself failed we fall back to
      // balance-delta only (the message check cannot provide a signal).
      if (!options.messageContext || state.messageReady || state.messageCheckFailed) {
        return "confirmed";
      }
      // Balance grew but message not yet ready — may be an external deposit.
      // Continue polling; the bridge amount will still arrive later.
    }

    const pollStep = await waitForNextPoll(state, options.maxPollMs, options.abortSignal);
    if (pollStep === "aborted") {
      return "aborted";
    }
    if (pollStep === "timeout") {
      break;
    }
  }

  return undefined;
}

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
  const state = createBridgeConfirmationState(options);
  const messageWaitPromise = startMessageReadinessCheck(options, deps, state);

  if (isAborted(options.abortSignal)) {
    return buildResult(options, state, "aborted");
  }

  const status = await pollUntilConfirmed(options, state, messageWaitPromise);
  if (status) {
    return buildResult(options, state, status);
  }

  await settleMessageCheckNonBlocking(messageWaitPromise);

  if (state.successfulReads === 0) {
    if (state.messageReady) {
      return buildResult(options, state, "timeout");
    }
    throw new Error(
      `Unable to read Fee Juice balance during confirmation polling after ${state.attempts} attempt(s)`,
    );
  }

  return buildResult(options, state, "timeout");
}

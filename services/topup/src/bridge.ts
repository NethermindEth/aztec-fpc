import pino from "pino";

const pinoLogger = pino();

/**
 * L1 -> L2 Fee Juice bridge via Aztec SDK L1FeeJuicePortalManager.
 */

import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { L1FeeJuicePortalManager, type L2AmountClaim } from "@aztec/aztec.js/ethereum";
import type { AztecNode } from "@aztec/aztec.js/node";
import { createExtendedL1Client } from "@aztec/ethereum/client";
import { createLogger, type Logger } from "@aztec/foundation/log";
import { type Chain, extractChain, type Hex } from "viem";
import * as viemChains from "viem/chains";

export interface BridgeResult {
  amount: bigint;
  claimSecret: string;
  claimSecretHash: string;
  messageHash: Hex;
  messageLeafIndex: bigint;
  submittedAtMs: number;
}

type ExtendedWalletClient = Parameters<typeof L1FeeJuicePortalManager.new>[1];

interface FeeJuicePortalManagerLike {
  bridgeTokensPublic(to: AztecAddress, amount: bigint): Promise<L2AmountClaim>;
}

type CreatePortalManager = (
  node: AztecNode,
  extendedClient: ExtendedWalletClient,
  logger: Logger,
) => Promise<FeeJuicePortalManagerLike>;

const createPortalManager: CreatePortalManager = async (node, extendedClient, logger) =>
  L1FeeJuicePortalManager.new(node, extendedClient, logger);

function makeBridgeLogger(): Logger {
  return createLogger("topup:bridge");
}

const MAX_NONCE_RETRY_ATTEMPTS = 3;

function isNonceConflictError(error: unknown): boolean {
  const normalized = String(error).toLowerCase();
  return (
    normalized.includes("replacementnotallowed") ||
    normalized.includes("replacement not allowed") ||
    normalized.includes("nonce too low") ||
    normalized.includes("already known")
  );
}

export interface BridgeDeps {
  createExtendedL1Client: typeof createExtendedL1Client;
  createPortalManager: CreatePortalManager;
  createLogger: () => Logger;
  chains: readonly Chain[];
}

const DEFAULT_BRIDGE_DEPS: BridgeDeps = {
  createExtendedL1Client,
  createPortalManager,
  createLogger: makeBridgeLogger,
  chains: Object.values(viemChains),
};

/**
 * Bridge `amount` wei of Fee Juice from L1 to the FPC's L2 address.
 */
export async function bridgeFeeJuice(
  node: AztecNode,
  l1RpcUrl: string,
  l1ChainId: number,
  privateKey: string,
  fpcL2Address: AztecAddress,
  amount: bigint,
  depsOverride: Partial<BridgeDeps> = {},
): Promise<BridgeResult> {
  if (fpcL2Address.isZero()) {
    throw new Error("Invalid fpc_address: zero address is not allowed");
  }
  if (amount <= 0n) {
    throw new Error("Invalid top_up_amount: amount must be greater than zero");
  }

  const deps: BridgeDeps = { ...DEFAULT_BRIDGE_DEPS, ...depsOverride };
  const chain = extractChain({ chains: deps.chains as readonly Chain[], id: l1ChainId });
  const logger = deps.createLogger();
  let lastError: unknown;
  let claim: L2AmountClaim | undefined;

  for (let attempt = 1; attempt <= MAX_NONCE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const extendedClient = deps.createExtendedL1Client(
        [l1RpcUrl],
        privateKey as Hex,
        chain,
      ) as ExtendedWalletClient;
      const portalManager = await deps.createPortalManager(node, extendedClient, logger);
      claim = await portalManager.bridgeTokensPublic(fpcL2Address, amount);
      break;
    } catch (error) {
      lastError = error;
      if (!isNonceConflictError(error) || attempt >= MAX_NONCE_RETRY_ATTEMPTS) {
        throw error;
      }
      pinoLogger.warn(
        { err: error },
        `Bridge nonce conflict detected; retrying bridge submission attempt=${attempt + 1}/${MAX_NONCE_RETRY_ATTEMPTS}`,
      );
    }
  }
  if (!claim) {
    throw new Error(
      `Failed to submit bridge after nonce retry attempts. Last error: ${String(lastError)}`,
    );
  }

  return {
    amount: claim.claimAmount,
    claimSecret: claim.claimSecret.toString(),
    claimSecretHash: claim.claimSecretHash.toString(),
    messageHash: claim.messageHash,
    messageLeafIndex: claim.messageLeafIndex,
    submittedAtMs: Date.now(),
  };
}

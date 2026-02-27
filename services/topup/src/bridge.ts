/**
 * L1 -> L2 Fee Juice bridge via Aztec SDK L1FeeJuicePortalManager.
 */

import type { AztecAddress } from "@aztec/aztec.js/addresses";
import {
  L1FeeJuicePortalManager,
  type L2AmountClaim,
} from "@aztec/aztec.js/ethereum";
import type { AztecNode } from "@aztec/aztec.js/node";
import { createLogger, type Logger } from "@aztec/foundation/log";
import {
  type Chain,
  createWalletClient,
  defineChain,
  type Hex,
  http,
  publicActions,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
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

const createPortalManager: CreatePortalManager = async (
  node,
  extendedClient,
  logger,
) => L1FeeJuicePortalManager.new(node, extendedClient, logger);

function makeBridgeLogger(): Logger {
  return createLogger("topup:bridge");
}

export interface BridgeDeps {
  createWalletClient: typeof createWalletClient;
  defineChain: typeof defineChain;
  http: typeof http;
  privateKeyToAccount: typeof privateKeyToAccount;
  createPortalManager: CreatePortalManager;
  createLogger: () => Logger;
  knownChains: Chain[];
}

const DEFAULT_BRIDGE_DEPS: BridgeDeps = {
  createWalletClient,
  defineChain,
  http,
  privateKeyToAccount,
  createPortalManager,
  createLogger: makeBridgeLogger,
  knownChains: Object.values(viemChains).filter(isChain),
};

function isChain(value: unknown): value is Chain {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    id?: unknown;
    name?: unknown;
    nativeCurrency?: unknown;
    rpcUrls?: unknown;
  };

  return (
    typeof candidate.id === "number" &&
    typeof candidate.name === "string" &&
    typeof candidate.nativeCurrency === "object" &&
    typeof candidate.rpcUrls === "object"
  );
}

function resolveL1Chain(
  chainId: number,
  rpcUrl: string,
  deps: BridgeDeps,
): Chain {
  const known = deps.knownChains.find((chain) => chain.id === chainId);
  if (known) {
    return {
      ...known,
      rpcUrls: {
        ...known.rpcUrls,
        default: { http: [rpcUrl] },
        public: { http: [rpcUrl] },
      },
    };
  }

  return deps.defineChain({
    id: chainId,
    name: `L1 Chain ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: { http: [rpcUrl] },
      public: { http: [rpcUrl] },
    },
  });
}

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
  const chain = resolveL1Chain(l1ChainId, l1RpcUrl, deps);
  const account = deps.privateKeyToAccount(privateKey as Hex);
  const walletClient = deps.createWalletClient({
    account,
    chain,
    transport: deps.http(l1RpcUrl),
  });
  const extendedClient = walletClient.extend(
    publicActions,
  ) as unknown as ExtendedWalletClient;
  const portalManager = await deps.createPortalManager(
    node,
    extendedClient,
    deps.createLogger(),
  );

  const claim = await portalManager.bridgeTokensPublic(fpcL2Address, amount);

  return {
    amount: claim.claimAmount,
    claimSecret: claim.claimSecret.toString(),
    claimSecretHash: claim.claimSecretHash.toString(),
    messageHash: claim.messageHash,
    messageLeafIndex: claim.messageLeafIndex,
    submittedAtMs: Date.now(),
  };
}

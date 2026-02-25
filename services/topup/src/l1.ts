import { createPublicClient, http } from "viem";

export interface L1ChainDeps {
  createPublicClient: typeof createPublicClient;
  http: typeof http;
}

const DEFAULT_L1_CHAIN_DEPS: L1ChainDeps = {
  createPublicClient,
  http,
};

/**
 * Validates that the configured L1 RPC points at the same chain as the Aztec node.
 */
export async function assertL1RpcChainIdMatches(
  l1RpcUrl: string,
  expectedChainId: number,
  depsOverride: Partial<L1ChainDeps> = {},
): Promise<void> {
  const deps: L1ChainDeps = { ...DEFAULT_L1_CHAIN_DEPS, ...depsOverride };
  const publicClient = deps.createPublicClient({ transport: deps.http(l1RpcUrl) });
  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== expectedChainId) {
    throw new Error(
      `L1 chain mismatch: aztec node expects chain_id=${expectedChainId}, but RPC ${l1RpcUrl} reports chain_id=${rpcChainId}`,
    );
  }
}

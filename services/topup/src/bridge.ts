/**
 * L1 -> L2 Fee Juice bridge via FeeJuicePortal.depositToAztecPublic.
 */

import type { AztecAddress } from "@aztec/aztec.js/addresses";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  parseAbi,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as viemChains from "viem/chains";

// Minimal ABI for the FeeJuice portal entrypoint.
const FEE_JUICE_PORTAL_ABI = parseAbi([
  "function depositToAztecPublic(bytes32 to, uint256 amount, bytes32 secretHash) payable returns (bytes32)",
]);

const ZERO_SECRET_HASH = `0x${"00".repeat(32)}` as Hex;

export interface BridgeResult {
  l1TxHash: Hex;
  amount: bigint;
}

export interface BridgeDeps {
  createPublicClient: typeof createPublicClient;
  createWalletClient: typeof createWalletClient;
  defineChain: typeof defineChain;
  getAddress: typeof getAddress;
  http: typeof http;
  isAddress: typeof isAddress;
  privateKeyToAccount: typeof privateKeyToAccount;
  knownChains: Chain[];
}

const DEFAULT_BRIDGE_DEPS: BridgeDeps = {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  privateKeyToAccount,
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

function normalizePortalAddress(portalAddress: string, deps: BridgeDeps): Hex {
  if (!deps.isAddress(portalAddress)) {
    throw new Error(
      `Invalid fee_juice_portal_address: expected 20-byte 0x-prefixed hex, got ${portalAddress}`,
    );
  }
  return deps.getAddress(portalAddress);
}

function normalizeRecipientBytes32(fpcL2Address: AztecAddress): Hex {
  const asHex = fpcL2Address.toString();
  if (!/^0x[0-9a-fA-F]{64}$/.test(asHex)) {
    throw new Error(
      `Invalid fpc_address: expected 32-byte 0x-prefixed hex, got ${asHex}`,
    );
  }
  if (fpcL2Address.isZero()) {
    throw new Error("Invalid fpc_address: zero address is not allowed");
  }
  return asHex as Hex;
}

/**
 * Bridge `amount` wei of Fee Juice from L1 to the FPC's L2 address.
 */
export async function bridgeFeeJuice(
  l1RpcUrl: string,
  l1ChainId: number,
  privateKey: string,
  portalAddress: string,
  fpcL2Address: AztecAddress,
  amount: bigint,
  depsOverride: Partial<BridgeDeps> = {},
): Promise<BridgeResult> {
  const deps: BridgeDeps = { ...DEFAULT_BRIDGE_DEPS, ...depsOverride };
  const chain = resolveL1Chain(l1ChainId, l1RpcUrl, deps);
  const account = deps.privateKeyToAccount(privateKey as Hex);
  const normalizedPortalAddress = normalizePortalAddress(portalAddress, deps);
  const recipientBytes32 = normalizeRecipientBytes32(fpcL2Address);

  const publicClient = deps.createPublicClient({
    chain,
    transport: deps.http(l1RpcUrl),
  });

  const walletClient = deps.createWalletClient({
    account,
    chain,
    transport: deps.http(l1RpcUrl),
  });

  const hash = await walletClient.writeContract({
    address: normalizedPortalAddress,
    abi: FEE_JUICE_PORTAL_ABI,
    functionName: "depositToAztecPublic",
    args: [recipientBytes32, amount, ZERO_SECRET_HASH],
    value: amount,
    chain,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`L1 bridge transaction reverted: ${hash}`);
  }

  return { l1TxHash: hash, amount };
}

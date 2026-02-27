import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode } from "@aztec/aztec.js/node";
import { createLogger } from "@aztec/foundation/log";
import type { Chain, createWalletClient, defineChain, http } from "viem";
import type { privateKeyToAccount } from "viem/accounts";
import type { BridgeDeps } from "../src/bridge.js";
import { bridgeFeeJuice } from "../src/bridge.js";

const MESSAGE_HASH = `0x${"ab".repeat(32)}` as `0x${string}`;
const PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const FPC = AztecAddress.fromString(
  "0x27e0f62fe6edf34f850dd7c1cc7cd638f7ec38ed3eb5ae4bd8c0c941c78e67ac",
);

function makeNode(): AztecNode {
  return {} as AztecNode;
}

function makeDeps(overrides: Partial<BridgeDeps> = {}): BridgeDeps {
  return {
    createWalletClient: (() =>
      ({
        extend: () => ({}),
      }) as never) as typeof createWalletClient,
    defineChain: ((chain) => chain) as typeof defineChain,
    http: ((_url) => ({}) as never) as typeof http,
    privateKeyToAccount: (() =>
      ({
        address: `0x${"11".repeat(20)}`,
      }) as never) as typeof privateKeyToAccount,
    createPortalManager: async () =>
      ({
        bridgeTokensPublic: async (_to: AztecAddress, amount: bigint) => ({
          claimAmount: amount,
          claimSecret: new Fr(1n),
          claimSecretHash: new Fr(2n),
          messageHash: MESSAGE_HASH,
          messageLeafIndex: 7n,
        }),
      }) as never,
    createLogger: () => createLogger("topup:test"),
    knownChains: [
      {
        id: 31337,
        name: "Anvil",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: {
          default: { http: ["http://localhost:8545"] },
          public: { http: ["http://localhost:8545"] },
        },
      } as Chain,
    ] as Chain[],
    ...overrides,
  };
}

describe("bridge", () => {
  it("uses the sdk portal manager and returns bridge metadata", async () => {
    let capturedChainId: number | undefined;
    let capturedTo: AztecAddress | undefined;
    let capturedAmount: bigint | undefined;

    const deps = makeDeps({
      createWalletClient: ((args: { chain: { id: number } }) => {
        capturedChainId = args.chain.id;
        return {
          extend: () => ({}),
        };
      }) as never,
      createPortalManager: async () =>
        ({
          bridgeTokensPublic: async (to: AztecAddress, amount: bigint) => {
            capturedTo = to;
            capturedAmount = amount;
            return {
              claimAmount: amount,
              claimSecret: new Fr(1n),
              claimSecretHash: new Fr(2n),
              messageHash: MESSAGE_HASH,
              messageLeafIndex: 7n,
            };
          },
        }) as never,
    });

    const result = await bridgeFeeJuice(
      makeNode(),
      "http://localhost:8545",
      31337,
      PRIVATE_KEY,
      FPC,
      123n,
      deps,
    );

    assert.equal(capturedChainId, 31337);
    assert.equal(capturedTo?.toString(), FPC.toString());
    assert.equal(capturedAmount, 123n);
    assert.equal(result.amount, 123n);
    assert.equal(result.claimSecret, new Fr(1n).toString());
    assert.equal(result.claimSecretHash, new Fr(2n).toString());
    assert.equal(result.messageHash, MESSAGE_HASH);
    assert.equal(result.messageLeafIndex, 7n);
    assert.equal(typeof result.submittedAtMs, "number");
    assert.equal(Number.isFinite(result.submittedAtMs), true);
  });

  it("fails fast on zero fpc address", async () => {
    await assert.rejects(
      () =>
        bridgeFeeJuice(
          makeNode(),
          "http://localhost:8545",
          31337,
          PRIVATE_KEY,
          AztecAddress.zero(),
          1n,
        ),
      /Invalid fpc_address/,
    );
  });

  it("fails fast on non-positive top-up amount", async () => {
    await assert.rejects(
      () =>
        bridgeFeeJuice(
          makeNode(),
          "http://localhost:8545",
          31337,
          PRIVATE_KEY,
          FPC,
          0n,
        ),
      /Invalid top_up_amount/,
    );
  });
});

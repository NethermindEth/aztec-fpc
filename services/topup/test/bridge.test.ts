import assert from "node:assert/strict";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { createExtendedL1Client } from "@aztec/ethereum/client";
import { createLogger } from "@aztec/foundation/log";
import type { Chain } from "viem";
import { describe, it } from "#test";
import type { BridgeDeps } from "../src/bridge.js";
import { bridgeFeeJuice, isNonceTooLowError, isRetryableNonceError } from "../src/bridge.js";

const MESSAGE_HASH = `0x${"ab".repeat(32)}` as `0x${string}`;
const PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const FPC = AztecAddress.fromString(
  "0x27e0f62fe6edf34f850dd7c1cc7cd638f7ec38ed3eb5ae4bd8c0c941c78e67ac",
);

function makeNode(): AztecNode {
  return {} as AztecNode;
}

function makeDeps(overrides: Partial<BridgeDeps> = {}): BridgeDeps {
  return {
    createExtendedL1Client: (() => ({})) as never as typeof createExtendedL1Client,
    createPortalManager: async () =>
      ({
        bridgeTokensPublic: (_to: AztecAddress, amount: bigint) =>
          Promise.resolve({
            claimAmount: amount,
            claimSecret: new Fr(1n),
            claimSecretHash: new Fr(2n),
            messageHash: MESSAGE_HASH,
            messageLeafIndex: 7n,
          }),
      }) as never,
    createLogger: () => createLogger("topup:test"),
    chains: [
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
      createExtendedL1Client: ((_rpcUrls: string[], _account: unknown, chain?: { id: number }) => {
        capturedChainId = chain?.id;
        return {};
      }) as never,
      createPortalManager: async () =>
        ({
          bridgeTokensPublic: (to: AztecAddress, amount: bigint) => {
            capturedTo = to;
            capturedAmount = amount;
            return Promise.resolve({
              claimAmount: amount,
              claimSecret: new Fr(1n),
              claimSecretHash: new Fr(2n),
              messageHash: MESSAGE_HASH,
              messageLeafIndex: 7n,
            });
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
      () => bridgeFeeJuice(makeNode(), "http://localhost:8545", 31337, PRIVATE_KEY, FPC, 0n),
      /Invalid top_up_amount/,
    );
  });

  it("retries bridge submission on retryable nonce conflicts", async () => {
    let attempts = 0;
    const deps = makeDeps({
      createPortalManager: async () =>
        ({
          bridgeTokensPublic: (_to: AztecAddress, amount: bigint) => {
            attempts += 1;
            if (attempts === 1) {
              return Promise.reject(new Error("already known"));
            }
            return Promise.resolve({
              claimAmount: amount,
              claimSecret: new Fr(11n),
              claimSecretHash: new Fr(22n),
              messageHash: MESSAGE_HASH,
              messageLeafIndex: 99n,
            });
          },
        }) as never,
    });

    const result = await bridgeFeeJuice(
      makeNode(),
      "http://localhost:8545",
      31337,
      PRIVATE_KEY,
      FPC,
      321n,
      deps,
    );

    assert.equal(attempts, 2);
    assert.equal(result.amount, 321n);
    assert.equal(result.messageLeafIndex, 99n);
  });

  it("fails immediately on nonce-too-low without retry", async () => {
    let attempts = 0;
    const deps = makeDeps({
      createPortalManager: async () =>
        ({
          bridgeTokensPublic: () => {
            attempts += 1;
            return Promise.reject(new Error("nonce too low"));
          },
        }) as never,
    });

    await assert.rejects(
      () => bridgeFeeJuice(makeNode(), "http://localhost:8545", 31337, PRIVATE_KEY, FPC, 1n, deps),
      /nonce-too-low.*Not retrying/,
    );
    assert.equal(attempts, 1);
  });

  it("fails after exhausting retryable nonce conflict retries", async () => {
    let attempts = 0;
    const deps = makeDeps({
      createPortalManager: async () =>
        ({
          bridgeTokensPublic: () => {
            attempts += 1;
            return Promise.reject(new Error("already known"));
          },
        }) as never,
    });

    await assert.rejects(
      () => bridgeFeeJuice(makeNode(), "http://localhost:8545", 31337, PRIVATE_KEY, FPC, 1n, deps),
      /already known/,
    );
    assert.equal(attempts, 3);
  }, 15_000);

  it("classifies nonce errors correctly", () => {
    assert.equal(isNonceTooLowError(new Error("nonce too low")), true);
    assert.equal(isNonceTooLowError(new Error("already known")), false);
    assert.equal(isRetryableNonceError(new Error("already known")), true);
    assert.equal(isRetryableNonceError(new Error("replacement not allowed")), true);
    assert.equal(isRetryableNonceError(new Error("nonce too low")), false);
    assert.equal(isRetryableNonceError(new Error("some other error")), false);
  });
});

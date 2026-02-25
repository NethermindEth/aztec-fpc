import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { BridgeDeps } from "../src/bridge.js";
import { bridgeFeeJuice } from "../src/bridge.js";

const HASH = `0x${"ab".repeat(32)}` as `0x${string}`;
const PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const FPC = AztecAddress.fromString(
  "0x27e0f62fe6edf34f850dd7c1cc7cd638f7ec38ed3eb5ae4bd8c0c941c78e67ac",
);

function makeDeps(overrides: Partial<BridgeDeps> = {}): BridgeDeps {
  let latestWriteCall: unknown;
  const deps: BridgeDeps = {
    createPublicClient: () =>
      ({
        waitForTransactionReceipt: async () => ({ status: "success" }),
      }) as never,
    createWalletClient: () =>
      ({
        writeContract: async (args: unknown) => {
          latestWriteCall = args;
          return HASH;
        },
      }) as never,
    defineChain: (chain) => chain as never,
    getAddress: (address) => address.toLowerCase() as never,
    http: (_url) => ({}) as never,
    isAddress: () => true,
    privateKeyToAccount: () => ({ address: `0x${"11".repeat(20)}` }) as never,
    knownChains: [
      {
        id: 31337,
        name: "Anvil",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: {
          default: { http: ["http://localhost:8545"] },
          public: { http: ["http://localhost:8545"] },
        },
      } as never,
    ],
    ...overrides,
  };

  return Object.assign(deps, {
    _latestWriteCall: () => latestWriteCall,
  }) as BridgeDeps & { _latestWriteCall: () => unknown };
}

describe("bridge", () => {
  it("submits depositToAztecPublic with expected args", async () => {
    const deps = makeDeps();
    const result = await bridgeFeeJuice(
      "http://localhost:8545",
      31337,
      PRIVATE_KEY,
      "0x6770742ecff10f57ac1f2e33ef54dca228ff9411",
      FPC,
      123n,
      deps,
    );

    assert.deepEqual(result, { l1TxHash: HASH, amount: 123n });

    const writeCall = (
      deps as BridgeDeps & { _latestWriteCall: () => unknown }
    )._latestWriteCall() as {
      functionName: string;
      args: [string, bigint, string];
      value: bigint;
    };
    assert.equal(writeCall.functionName, "depositToAztecPublic");
    assert.equal(writeCall.args[0], FPC.toString());
    assert.equal(writeCall.args[1], 123n);
    assert.equal(writeCall.args[2], `0x${"00".repeat(32)}`);
    assert.equal(writeCall.value, 123n);
  });

  it("fails fast on invalid portal address", async () => {
    const deps = makeDeps({ isAddress: () => false });

    await assert.rejects(
      () =>
        bridgeFeeJuice(
          "http://localhost:8545",
          31337,
          PRIVATE_KEY,
          "invalid",
          FPC,
          1n,
          deps,
        ),
      /Invalid fee_juice_portal_address/,
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "#test";
import type { L1ChainDeps } from "../src/l1.js";
import { assertL1RpcChainIdMatches } from "../src/l1.js";

function makeDeps(chainId: number): L1ChainDeps {
  return {
    createPublicClient: (() => ({
      getChainId: async () => chainId,
    })) as unknown as L1ChainDeps["createPublicClient"],
    http: (() => ({})) as unknown as L1ChainDeps["http"],
  };
}

describe("l1", () => {
  it("passes when rpc chain id matches expected", async () => {
    await assert.doesNotReject(() =>
      assertL1RpcChainIdMatches("http://localhost:8545", 31337, makeDeps(31337)),
    );
  });

  it("throws when rpc chain id mismatches expected", async () => {
    await assert.rejects(
      () => assertL1RpcChainIdMatches("http://localhost:8545", 31337, makeDeps(1)),
      /L1 chain mismatch/,
    );
  });
});

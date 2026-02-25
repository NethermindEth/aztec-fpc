import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertL1RpcChainIdMatches } from "../src/l1.js";

describe("l1", () => {
  it("passes when rpc chain id matches expected", async () => {
    await assert.doesNotReject(() =>
      assertL1RpcChainIdMatches("http://localhost:8545", 31337, {
        createPublicClient: (() =>
          ({
            getChainId: async () => 31337,
          }) as never) as never,
        http: ((_url) => ({})) as never,
      }),
    );
  });

  it("throws when rpc chain id mismatches expected", async () => {
    await assert.rejects(
      () =>
        assertL1RpcChainIdMatches("http://localhost:8545", 31337, {
          createPublicClient: (() =>
            ({
              getChainId: async () => 1,
            }) as never) as never,
          http: ((_url) => ({})) as never,
        }),
      /L1 chain mismatch/,
    );
  });
});

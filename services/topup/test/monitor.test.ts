import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AztecNode } from "@aztec/aztec.js/node";
import { createGetFeeJuiceBalance } from "../src/monitor.js";

describe("monitor", () => {
  it("returns a callable getBalance function", () => {
    const node = {} as unknown as AztecNode;
    const getBalance = createGetFeeJuiceBalance(node);
    assert.equal(typeof getBalance, "function");
  });
});

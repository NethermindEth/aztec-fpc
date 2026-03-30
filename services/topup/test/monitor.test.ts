import assert from "node:assert/strict";
import type { AztecNode } from "@aztec/aztec.js/node";
import { describe, it } from "#test";
import { createGetFeeJuiceBalance } from "../src/monitor.js";

describe("monitor", () => {
  it("returns a callable getBalance function", () => {
    const node = {} as unknown as AztecNode;
    const getBalance = createGetFeeJuiceBalance(node);
    assert.equal(typeof getBalance, "function");
  });
});

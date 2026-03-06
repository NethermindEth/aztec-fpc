import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSponsoredCounterClient } from "../src/index";
import * as contracts from "../src/internal/contracts";

vi.mock("../src/internal/contracts", () => ({
  connectAndAttachContracts: vi.fn(async () => ({
    addresses: {
      targets: {
        counter: {
          toString: () => "0x0000000000000000000000000000000000000000000000000000000000000001",
        },
      },
      user: {
        toString: () => "0x0000000000000000000000000000000000000000000000000000000000000000",
      },
    },
    counter: {},
    faucet: {},
  })),
}));

describe("createSponsoredCounterClient scaffold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a client with increment()", async () => {
    const client = await createSponsoredCounterClient({
      wallet: {} as never,
      account: "0x0000000000000000000000000000000000000000000000000000000000000000",
    });

    expect(typeof client.increment).toBe("function");
    expect(contracts.connectAndAttachContracts).not.toHaveBeenCalled();
  });
});

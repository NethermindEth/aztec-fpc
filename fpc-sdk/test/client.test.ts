import { describe, expect, it } from "vitest";

import { createSponsoredCounterClient } from "../src/index";

describe("createSponsoredCounterClient scaffold", () => {
  it("returns a client with increment()", async () => {
    const client = await createSponsoredCounterClient({
      wallet: {} as never,
      account:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
    });

    expect(typeof client.increment).toBe("function");
  });
});

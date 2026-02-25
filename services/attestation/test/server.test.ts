import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { Config } from "../src/config.js";
import { buildServer } from "../src/server.js";
import type { QuoteAuthwitSigner } from "../src/signer.js";
import { computeQuoteInnerHash } from "../src/signer.js";

const VALID_USER =
  "0x089323ce9a610e9f013b661ce80dde444b554e9f6ed9f5167adb234668f0af72";

const TEST_CONFIG: Config = {
  fpc_address:
    "0x27e0f62fe6edf34f850dd7c1cc7cd638f7ec38ed3eb5ae4bd8c0c941c78e67ac",
  aztec_node_url: "http://localhost:8080",
  quote_validity_seconds: 300,
  port: 3000,
  accepted_asset_address:
    "0x0000000000000000000000000000000000000000000000000000000000000002",
  accepted_asset_name: "humanUSDC",
  market_rate_num: 1,
  market_rate_den: 1000,
  fee_bips: 200,
  operator_secret_key:
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  operator_secret_key_source: "config",
  operator_secret_key_dual_source: false,
  pxe_data_directory: undefined,
};

describe("server", () => {
  it("returns health status", async () => {
    const app = buildServer(TEST_CONFIG, {
      createForQuote: async () => "0xignored",
    });

    try {
      const response = await app.inject({ method: "GET", url: "/health" });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { status: "ok" });
    } finally {
      await app.close();
    }
  });

  it("returns accepted asset metadata", async () => {
    const app = buildServer(TEST_CONFIG, {
      createForQuote: async () => "0xignored",
    });

    try {
      const response = await app.inject({ method: "GET", url: "/asset" });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        name: TEST_CONFIG.accepted_asset_name,
        address: TEST_CONFIG.accepted_asset_address,
      });
    } finally {
      await app.close();
    }
  });

  it("returns quote payload with required fields on happy path", async () => {
    let calledConsumer: string | undefined;
    let calledInnerHashHex: string | undefined;
    const quoteSigner: QuoteAuthwitSigner = {
      createForQuote: async (consumer, innerHash) => {
        calledConsumer = consumer.toString();
        calledInnerHashHex = innerHash.toString();
        return "0xabc123";
      },
    };
    const app = buildServer(TEST_CONFIG, quoteSigner);

    try {
      const nowBefore = Math.floor(Date.now() / 1000);
      const response = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
      });
      const nowAfter = Math.floor(Date.now() / 1000);
      assert.equal(response.statusCode, 200);

      const body = response.json() as {
        accepted_asset: string;
        rate_num: string;
        rate_den: string;
        valid_until: string;
        authwit: string;
      };
      assert.equal(body.accepted_asset, TEST_CONFIG.accepted_asset_address);
      assert.equal(body.rate_num, "10200");
      assert.equal(body.rate_den, "10000000");
      assert.equal(body.authwit, "0xabc123");

      const validUntil = BigInt(body.valid_until);
      assert.equal(
        validUntil >= BigInt(nowBefore + TEST_CONFIG.quote_validity_seconds),
        true,
      );
      assert.equal(
        validUntil <= BigInt(nowAfter + TEST_CONFIG.quote_validity_seconds),
        true,
      );

      assert.equal(calledConsumer, TEST_CONFIG.fpc_address);
      const expectedInnerHash = await computeQuoteInnerHash({
        fpcAddress: AztecAddress.fromString(TEST_CONFIG.fpc_address),
        acceptedAsset: AztecAddress.fromString(
          TEST_CONFIG.accepted_asset_address,
        ),
        rateNum: 10200n,
        rateDen: 10000000n,
        validUntil,
        userAddress: AztecAddress.fromString(VALID_USER),
      });
      assert.equal(calledInnerHashHex, expectedInnerHash.toString());
    } finally {
      await app.close();
    }
  });

  it("returns 400 for missing user", async () => {
    const app = buildServer(TEST_CONFIG, {
      createForQuote: async () => "0xignored",
    });

    try {
      const response = await app.inject({ method: "GET", url: "/quote" });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), {
        error: {
          code: "BAD_REQUEST",
          message: "Missing required query param: user",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("returns 400 for invalid user address", async () => {
    const app = buildServer(TEST_CONFIG, {
      createForQuote: async () => "0xignored",
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/quote?user=not_an_address",
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), {
        error: {
          code: "BAD_REQUEST",
          message: "Invalid user address",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("returns 500 when quote signer fails", async () => {
    const app = buildServer(TEST_CONFIG, {
      createForQuote: async () => {
        throw new Error("signing backend unavailable");
      },
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
      });
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), {
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error",
        },
      });
    } finally {
      await app.close();
    }
  });
});

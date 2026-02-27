import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { Config } from "../src/config.js";
import { buildServer } from "../src/server.js";
import type { QuoteSchnorrSigner } from "../src/signer.js";
import { computeQuoteHash } from "../src/signer.js";

const VALID_USER =
  "0x089323ce9a610e9f013b661ce80dde444b554e9f6ed9f5167adb234668f0af72";

const TEST_CONFIG: Config = {
  runtime_profile: "development",
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
  operator_secret_provider: "auto",
  operator_secret_key:
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  operator_secret_key_source: "config",
  operator_secret_key_provider: "auto",
  operator_secret_key_dual_source: false,
  quote_auth: {
    mode: "disabled",
    apiKey: undefined,
    apiKeyHeader: "x-api-key",
    trustedHeaderName: undefined,
    trustedHeaderValue: undefined,
  },
  quote_rate_limit: {
    enabled: true,
    maxRequests: 60,
    windowSeconds: 60,
    maxTrackedKeys: 10000,
  },
  pxe_data_directory: undefined,
};

function mockSigner(returnValue: string = "0xabc123"): QuoteSchnorrSigner {
  return { signQuoteHash: async () => returnValue };
}

function failingSigner(): QuoteSchnorrSigner {
  return {
    signQuoteHash: async () => {
      throw new Error("signing backend unavailable");
    },
  };
}

function withQuoteAuth(quoteAuth: Partial<Config["quote_auth"]>): Config {
  return {
    ...TEST_CONFIG,
    quote_auth: {
      ...TEST_CONFIG.quote_auth,
      ...quoteAuth,
    },
  };
}

function withQuoteRateLimit(
  quoteRateLimit: Partial<Config["quote_rate_limit"]>,
  config: Config = TEST_CONFIG,
): Config {
  return {
    ...config,
    quote_rate_limit: {
      ...config.quote_rate_limit,
      ...quoteRateLimit,
    },
  };
}

describe("server", () => {
  it("returns health status", async () => {
    const app = buildServer(TEST_CONFIG, mockSigner());

    try {
      const response = await app.inject({ method: "GET", url: "/health" });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { status: "ok" });
    } finally {
      await app.close();
    }
  });

  it("returns accepted asset metadata", async () => {
    const app = buildServer(TEST_CONFIG, mockSigner());

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
    let calledQuoteHashHex: string | undefined;
    const signer: QuoteSchnorrSigner = {
      signQuoteHash: async (quoteHash) => {
        calledQuoteHashHex = quoteHash.toString();
        return "0xabc123";
      },
    };
    const app = buildServer(TEST_CONFIG, signer);

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
        signature: string;
      };
      assert.equal(body.accepted_asset, TEST_CONFIG.accepted_asset_address);
      assert.equal(body.rate_num, "10200");
      assert.equal(body.rate_den, "10000000");
      assert.equal(body.signature, "0xabc123");

      const validUntil = BigInt(body.valid_until);
      assert.equal(
        validUntil >= BigInt(nowBefore + TEST_CONFIG.quote_validity_seconds),
        true,
      );
      assert.equal(
        validUntil <= BigInt(nowAfter + TEST_CONFIG.quote_validity_seconds),
        true,
      );

      const expectedHash = await computeQuoteHash({
        fpcAddress: AztecAddress.fromString(TEST_CONFIG.fpc_address),
        acceptedAsset: AztecAddress.fromString(
          TEST_CONFIG.accepted_asset_address,
        ),
        rateNum: 10200n,
        rateDen: 10000000n,
        validUntil,
        userAddress: AztecAddress.fromString(VALID_USER),
      });
      assert.equal(calledQuoteHashHex, expectedHash.toString());
    } finally {
      await app.close();
    }
  });

  it("returns 400 for missing user", async () => {
    const app = buildServer(TEST_CONFIG, mockSigner());

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
    const app = buildServer(TEST_CONFIG, mockSigner());

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
    const app = buildServer(TEST_CONFIG, failingSigner());

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

  it("returns 401 for protected mode when auth header is missing", async () => {
    const app = buildServer(
      withQuoteAuth({
        mode: "api_key",
        apiKey: "super-secret",
      }),
      mockSigner(),
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
      });
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), {
        error: {
          code: "UNAUTHORIZED",
          message: "Unauthorized",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("returns 200 for protected mode when api key header is valid", async () => {
    const app = buildServer(
      withQuoteAuth({
        mode: "api_key",
        apiKey: "super-secret",
      }),
      mockSigner(),
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
        headers: {
          "x-api-key": "super-secret",
        },
      });
      assert.equal(response.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it("returns 401 for protected mode when api key header is wrong", async () => {
    const app = buildServer(
      withQuoteAuth({
        mode: "api_key",
        apiKey: "super-secret",
      }),
      mockSigner(),
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
        headers: {
          "x-api-key": "wrong-secret",
        },
      });
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), {
        error: {
          code: "UNAUTHORIZED",
          message: "Unauthorized",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("returns 200 in trusted_header mode when trusted upstream header is valid", async () => {
    const app = buildServer(
      withQuoteAuth({
        mode: "trusted_header",
        trustedHeaderName: "x-internal-attestation",
        trustedHeaderValue: "allow",
      }),
      mockSigner(),
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
        headers: {
          "x-internal-attestation": "allow",
        },
      });
      assert.equal(response.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it("returns 200 in api_key_or_trusted_header mode when either header is valid", async () => {
    const app = buildServer(
      withQuoteAuth({
        mode: "api_key_or_trusted_header",
        apiKey: "super-secret",
        trustedHeaderName: "x-internal-attestation",
        trustedHeaderValue: "allow",
      }),
      mockSigner(),
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
        headers: {
          "x-internal-attestation": "allow",
        },
      });
      assert.equal(response.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it("returns 401 in api_key_and_trusted_header mode when one header is missing", async () => {
    const app = buildServer(
      withQuoteAuth({
        mode: "api_key_and_trusted_header",
        apiKey: "super-secret",
        trustedHeaderName: "x-internal-attestation",
        trustedHeaderValue: "allow",
      }),
      mockSigner(),
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
        headers: {
          "x-api-key": "super-secret",
        },
      });
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), {
        error: {
          code: "UNAUTHORIZED",
          message: "Unauthorized",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("returns 200 in api_key_and_trusted_header mode when both headers are valid", async () => {
    const app = buildServer(
      withQuoteAuth({
        mode: "api_key_and_trusted_header",
        apiKey: "super-secret",
        trustedHeaderName: "x-internal-attestation",
        trustedHeaderValue: "allow",
      }),
      mockSigner(),
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
        headers: {
          "x-api-key": "super-secret",
          "x-internal-attestation": "allow",
        },
      });
      assert.equal(response.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it("returns 429 when quote rate limit is exceeded", async () => {
    const nowUnix = 1_700_000_000n;
    const app = buildServer(
      withQuoteRateLimit({
        enabled: true,
        maxRequests: 2,
        windowSeconds: 60,
      }),
      mockSigner(),
      {
        nowUnixSeconds: () => nowUnix,
      },
    );

    try {
      const r1 = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
      });
      const r2 = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
      });
      const r3 = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
      });

      assert.equal(r1.statusCode, 200);
      assert.equal(r2.statusCode, 200);
      assert.equal(r3.statusCode, 429);
      assert.deepEqual(r3.json(), {
        error: {
          code: "RATE_LIMITED",
          message: "Too many quote requests",
        },
      });

      const expectedRetryAfter = String(60 - (Number(nowUnix) % 60) || 60);
      assert.equal(r3.headers["retry-after"], expectedRetryAfter);
    } finally {
      await app.close();
    }
  });

  it("does not throttle when quote rate limiting is disabled", async () => {
    const app = buildServer(
      withQuoteRateLimit({
        enabled: false,
        maxRequests: 1,
        windowSeconds: 60,
      }),
      mockSigner(),
      {
        nowUnixSeconds: () => 1_700_000_000n,
      },
    );

    try {
      const r1 = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
      });
      const r2 = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
      });

      assert.equal(r1.statusCode, 200);
      assert.equal(r2.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it("resets quote rate limit after the fixed window elapses", async () => {
    let nowUnix = 1_700_000_000n;
    const app = buildServer(
      withQuoteRateLimit({
        enabled: true,
        maxRequests: 1,
        windowSeconds: 60,
      }),
      mockSigner(),
      {
        nowUnixSeconds: () => nowUnix,
      },
    );

    try {
      const r1 = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
      });
      const r2 = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
      });
      nowUnix += 60n;
      const r3 = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
      });

      assert.equal(r1.statusCode, 200);
      assert.equal(r2.statusCode, 429);
      assert.equal(r3.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it("uses api key identity for rate limiting when a valid api key is presented", async () => {
    const app = buildServer(
      withQuoteRateLimit(
        {
          enabled: true,
          maxRequests: 1,
          windowSeconds: 60,
        },
        withQuoteAuth({
          mode: "api_key",
          apiKey: "good-key",
        }),
      ),
      mockSigner(),
      {
        nowUnixSeconds: () => 1_700_000_000n,
      },
    );

    try {
      const goodKeyFirst = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
        headers: {
          "x-api-key": "good-key",
        },
      });
      const badKeyResponse = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
        headers: {
          "x-api-key": "bad-key",
        },
      });
      const goodKeySecond = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
        headers: {
          "x-api-key": "good-key",
        },
      });

      assert.equal(goodKeyFirst.statusCode, 200);
      assert.equal(badKeyResponse.statusCode, 401);
      assert.equal(goodKeySecond.statusCode, 429);
    } finally {
      await app.close();
    }
  });

  it("falls back to ip rate limiting when api key is missing or invalid", async () => {
    const app = buildServer(
      withQuoteRateLimit(
        {
          enabled: true,
          maxRequests: 1,
          windowSeconds: 60,
        },
        withQuoteAuth({
          mode: "api_key",
          apiKey: "good-key",
        }),
      ),
      mockSigner(),
      {
        nowUnixSeconds: () => 1_700_000_000n,
      },
    );

    try {
      const badKeyFirst = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
        headers: {
          "x-api-key": "bad-key-1",
        },
      });
      const badKeySecond = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
        headers: {
          "x-api-key": "bad-key-2",
        },
      });

      assert.equal(badKeyFirst.statusCode, 401);
      assert.equal(badKeySecond.statusCode, 429);
      assert.deepEqual(badKeySecond.json(), {
        error: {
          code: "RATE_LIMITED",
          message: "Too many quote requests",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("uses ip identity for rate limiting when api key auth mode is disabled", async () => {
    const app = buildServer(
      withQuoteRateLimit({
        enabled: true,
        maxRequests: 1,
        windowSeconds: 60,
      }),
      mockSigner(),
      {
        nowUnixSeconds: () => 1_700_000_000n,
      },
    );

    try {
      const r1 = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
      });
      const r2 = await app.inject({
        method: "GET",
        url: `/quote?user=${VALID_USER}`,
        headers: {
          "x-api-key": "attempt-bypass",
        },
      });

      assert.equal(r1.statusCode, 200);
      assert.equal(r2.statusCode, 429);
    } finally {
      await app.close();
    }
  });
});

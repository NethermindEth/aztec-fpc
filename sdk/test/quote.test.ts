import { AztecAddress } from "@aztec/aztec.js/addresses";
import { describe, expect, it } from "vitest";

import { QuoteValidationError } from "../src/errors";
import {
  buildQuoteUrl,
  resolveAcceptedAssetsAndDiscovery,
  resolveDiscoveryFpcAddress,
  selectAcceptedAsset,
  validateQuote,
} from "../src/internal/quote";

const USER = AztecAddress.fromString(
  "0x226762b1e122bd46054de3fd21a19f0500ebe072aeac35fe0bb82d43b85f94fd",
);
const TOKEN = AztecAddress.fromString(
  "0x10600e2f256b6500de5a79367d70b4c7d8121c408a2127dbcba995a1abc0d6f8",
);
const TOKEN_TWO = AztecAddress.fromString(
  "0x016fa39000902287772e653a9e6cc2026dbb0f97c08a4d1b2c51ebbad4a4b24f",
);
const BASE_URL = "https://attestation.example/v2";
const DISCOVERY_URL = "https://attestation.example/.well-known/fpc.json";

type MockRoute = {
  body?: unknown;
  rawBody?: string;
  status?: number;
};

function makeFetch(routes: Record<string, MockRoute>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const route = routes[url];
    if (!route) {
      return new Response("not found", { status: 404 });
    }

    const status = route.status ?? 200;
    if (route.rawBody !== undefined) {
      return new Response(route.rawBody, { status });
    }
    return new Response(JSON.stringify(route.body), {
      headers: { "content-type": "application/json" },
      status,
    });
  }) as typeof fetch;
}

describe("quote url", () => {
  it("appends /quote with query params", () => {
    const url = buildQuoteUrl({
      acceptedAsset: TOKEN,
      attestationBaseUrl: "https://aztec-fpc.staging-nethermind.xyz/v2",
      fjAmount: 123n,
      user: USER,
    });
    expect(url).toContain("/v2/quote?");
    expect(url).toContain(`user=${encodeURIComponent(USER.toString())}`);
    expect(url).toContain(
      `accepted_asset=${encodeURIComponent(TOKEN.toString())}`,
    );
    expect(url).toContain("fj_amount=123");
  });
});

describe("attestation discovery", () => {
  it("resolves accepted assets from accepted-assets endpoint first", async () => {
    const out = await resolveAcceptedAssetsAndDiscovery({
      attestationBaseUrl: BASE_URL,
      fetchImpl: makeFetch({
        [DISCOVERY_URL]: {
          body: {
            endpoints: {
              accepted_assets: "/accepted-assets",
            },
            fpc_address:
              "0x24a735808258519dc1637f1833202ea2dc7c829a0a82c73f61bbd195fce4105b",
          },
        },
        "https://attestation.example/accepted-assets": {
          body: [
            { address: TOKEN.toString(), name: "humanUSDC" },
            { address: TOKEN_TWO.toString(), name: "humanETH" },
          ],
        },
      }),
    });

    expect(out.source).toBe("accepted_assets_endpoint");
    expect(out.assets).toEqual([
      { address: TOKEN.toString(), name: "humanUSDC" },
      { address: TOKEN_TWO.toString(), name: "humanETH" },
    ]);
    expect(out.fpcAddress?.toString()).toBe(
      "0x24a735808258519dc1637f1833202ea2dc7c829a0a82c73f61bbd195fce4105b",
    );
  });

  it("falls back to discovery supported_assets when endpoint is unavailable", async () => {
    const out = await resolveAcceptedAssetsAndDiscovery({
      attestationBaseUrl: BASE_URL,
      fetchImpl: makeFetch({
        [DISCOVERY_URL]: {
          body: {
            endpoints: {
              accepted_assets: "/missing-accepted-assets",
            },
            supported_assets: [
              { address: TOKEN.toString(), name: "humanUSDC" },
              { address: TOKEN_TWO.toString(), name: "humanETH" },
            ],
          },
        },
      }),
    });

    expect(out.source).toBe("discovery_supported_assets");
    expect(out.assets).toHaveLength(2);
  });

  it("falls back to legacy /asset endpoint when other sources fail", async () => {
    const out = await resolveAcceptedAssetsAndDiscovery({
      attestationBaseUrl: BASE_URL,
      fetchImpl: makeFetch({
        [DISCOVERY_URL]: {
          body: {
            endpoints: {
              accepted_assets: "/missing-accepted-assets",
              asset: "/asset",
            },
            supported_assets: [],
          },
        },
        "https://attestation.example/asset": {
          body: { address: TOKEN.toString(), name: "humanUSDC" },
        },
      }),
    });

    expect(out.source).toBe("legacy_asset_endpoint");
    expect(out.assets).toEqual([
      { address: TOKEN.toString(), name: "humanUSDC" },
    ]);
  });

  it("throws when accepted assets payloads are malformed across all fallbacks", async () => {
    await expect(
      resolveAcceptedAssetsAndDiscovery({
        attestationBaseUrl: BASE_URL,
        fetchImpl: makeFetch({
          [DISCOVERY_URL]: {
            body: {
              endpoints: {
                accepted_assets: "/accepted-assets",
                asset: "/asset",
              },
              supported_assets: [{ address: "0xnotvalid", name: "bad" }],
            },
          },
          "https://attestation.example/accepted-assets": {
            body: [{ address: "0xnotvalid", name: "bad" }],
          },
          "https://attestation.example/asset": {
            body: { address: "0xnotvalid", name: "bad" },
          },
        }),
      }),
    ).rejects.toBeInstanceOf(QuoteValidationError);
  });

  it("handles malformed discovery JSON by falling back to legacy /asset", async () => {
    const out = await resolveAcceptedAssetsAndDiscovery({
      attestationBaseUrl: BASE_URL,
      fetchImpl: makeFetch({
        [DISCOVERY_URL]: {
          rawBody: "{",
        },
        "https://attestation.example/asset": {
          body: { address: TOKEN.toString(), name: "humanUSDC" },
        },
      }),
    });

    expect(out.source).toBe("legacy_asset_endpoint");
    expect(out.assets[0]?.address).toBe(TOKEN.toString());
  });
});

describe("discovery fpc address resolution", () => {
  it("parses valid discovery fpc address", () => {
    const out = resolveDiscoveryFpcAddress({
      discovery: {
        fpc_address:
          "0x24a735808258519dc1637f1833202ea2dc7c829a0a82c73f61bbd195fce4105b",
      },
      required: true,
    });

    expect(out?.toString()).toBe(
      "0x24a735808258519dc1637f1833202ea2dc7c829a0a82c73f61bbd195fce4105b",
    );
  });

  it("throws when required discovery fpc address is missing", () => {
    expect(() =>
      resolveDiscoveryFpcAddress({ discovery: {}, required: true }),
    ).toThrow(QuoteValidationError);
  });

  it("throws when required discovery fpc address is invalid", () => {
    expect(() =>
      resolveDiscoveryFpcAddress({
        discovery: { fpc_address: "0xnotvalid" },
        required: true,
      }),
    ).toThrow(QuoteValidationError);
  });
});

describe("accepted asset selection", () => {
  const supportedAssets = [
    { address: TOKEN.toString(), name: "humanUSDC" },
    { address: TOKEN_TWO.toString(), name: "humanETH" },
  ];

  it("supports explicit accepted asset address selection", async () => {
    const out = await selectAcceptedAsset({
      explicitAcceptedAsset: TOKEN_TWO,
      supportedAssets,
    });

    expect(out.toString()).toBe(TOKEN_TWO.toString());
  });

  it("defaults to first accepted asset when no strategy is provided", async () => {
    const out = await selectAcceptedAsset({ supportedAssets });

    expect(out.toString()).toBe(TOKEN.toString());
  });

  it("supports selector callback strategy", async () => {
    const out = await selectAcceptedAsset({
      selector: async (assets) => assets[1]?.address,
      supportedAssets,
    });

    expect(out.toString()).toBe(TOKEN_TWO.toString());
  });

  it("throws when explicit accepted asset is unsupported", async () => {
    await expect(
      selectAcceptedAsset({
        explicitAcceptedAsset:
          "0x0000000000000000000000000000000000000000000000000000000000000099",
        supportedAssets,
      }),
    ).rejects.toBeInstanceOf(QuoteValidationError);
  });

  it("throws when selector does not return a selection", async () => {
    await expect(
      selectAcceptedAsset({
        selector: async () => undefined,
        supportedAssets,
      }),
    ).rejects.toBeInstanceOf(QuoteValidationError);
  });
});

describe("quote validation", () => {
  it("accepts a valid quote", () => {
    const out = validateQuote({
      expectedAcceptedAsset: TOKEN,
      expectedFjAmount: 100n,
      quote: {
        accepted_asset: TOKEN.toString(),
        aa_payment_amount: "77",
        fj_amount: "100",
        signature: `0x${"11".repeat(64)}`,
        valid_until: "999",
      },
    });
    expect(out.aaPaymentAmount).toBe(77n);
    expect(out.fjAmount).toBe(100n);
    expect(out.signatureBytes).toHaveLength(64);
  });

  it("rejects accepted asset mismatch", () => {
    expect(() =>
      validateQuote({
        expectedAcceptedAsset: TOKEN,
        expectedFjAmount: 100n,
        quote: {
          accepted_asset:
            "0x016fa39000902287772e653a9e6cc2026dbb0f97c08a4d1b2c51ebbad4a4b24f",
          aa_payment_amount: "77",
          fj_amount: "100",
          signature: `0x${"11".repeat(64)}`,
          valid_until: "999",
        },
      }),
    ).toThrow(QuoteValidationError);
  });

  it("rejects fj amount mismatch", () => {
    expect(() =>
      validateQuote({
        expectedAcceptedAsset: TOKEN,
        expectedFjAmount: 100n,
        quote: {
          accepted_asset: TOKEN.toString(),
          aa_payment_amount: "77",
          fj_amount: "101",
          signature: `0x${"11".repeat(64)}`,
          valid_until: "999",
        },
      }),
    ).toThrow(QuoteValidationError);
  });

  it("rejects non-64-byte signature", () => {
    expect(() =>
      validateQuote({
        expectedAcceptedAsset: TOKEN,
        expectedFjAmount: 100n,
        quote: {
          accepted_asset: TOKEN.toString(),
          aa_payment_amount: "77",
          fj_amount: "100",
          signature: `0x${"11".repeat(63)}`,
          valid_until: "999",
        },
      }),
    ).toThrow(QuoteValidationError);
  });
});

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { ProtocolContractAddress } from "@aztec/aztec.js/protocol";
import { Gas, GasFees, GasSettings } from "@aztec/stdlib/gas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FpcClient } from "../src/payment-method";

vi.mock("../src/internal/contracts", () => ({
  requireDefaultArtifact: vi.fn(() => ({ name: "MockArtifact" })),
}));

vi.mock("@aztec/aztec.js/contracts", () => {
  const contractInstance = {
    address: AztecAddress.fromString(
      "0x24a735808258519dc1637f1833202ea2dc7c829a0a82c73f61bbd195fce4105b",
    ),
    methods: {
      transfer_private_to_private: vi.fn(() => ({
        getFunctionCall: vi.fn(async () => ({ fn: "transfer" })),
      })),
      fee_entrypoint: vi.fn(() => ({
        getFunctionCall: vi.fn(async () => ({ fn: "fee_entrypoint" })),
      })),
    },
  };

  return {
    Contract: {
      at: vi.fn(() => contractInstance),
    },
    __contractInstance: contractInstance,
  };
});

const USER = AztecAddress.fromString(
  "0x226762b1e122bd46054de3fd21a19f0500ebe072aeac35fe0bb82d43b85f94fd",
);
const TOKEN_ADDRESS = AztecAddress.fromString(
  "0x10600e2f256b6500de5a79367d70b4c7d8121c408a2127dbcba995a1abc0d6f8",
);
const OPERATOR = AztecAddress.fromString(
  "0x18a15b90bea06cea7cbd06b3940533952aa9e5f94c157000c727321644d07af8",
);
const FPC_ADDRESS = AztecAddress.fromString(
  "0x24a735808258519dc1637f1833202ea2dc7c829a0a82c73f61bbd195fce4105b",
);

const FEE_PER_DA_GAS = 2n;
const FEE_PER_L2_GAS = 3n;
const MOCK_GAS_FEES = new GasFees(FEE_PER_DA_GAS, FEE_PER_L2_GAS);
const DA_GAS_LIMIT = 1_000_000;
const L2_GAS_LIMIT = 1_000_000;
const EXPECTED_FJ_AMOUNT =
  BigInt(DA_GAS_LIMIT) * FEE_PER_DA_GAS + BigInt(L2_GAS_LIMIT) * FEE_PER_L2_GAS;

const QUOTE_RESPONSE = {
  accepted_asset: TOKEN_ADDRESS.toString(),
  fj_amount: EXPECTED_FJ_AMOUNT.toString(),
  aa_payment_amount: "500",
  valid_until: "9999",
  signature: "ab".repeat(64),
};

function createMockNode() {
  return {
    getCurrentMinFees: vi.fn(async () => MOCK_GAS_FEES),
    getContract: vi.fn(async () => ({ address: FPC_ADDRESS })),
  };
}

function createMockWallet() {
  return {
    createAuthWit: vi.fn(async () => ({ witness: "ok" })),
    registerContract: vi.fn(async () => undefined),
  };
}

function mockFetchOk(body: unknown) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
}

function createClient(nodeOverride?: ReturnType<typeof createMockNode>) {
  return new FpcClient({
    fpcAddress: FPC_ADDRESS,
    operator: OPERATOR,
    node: (nodeOverride ?? createMockNode()) as never,
    attestationBaseUrl: "https://example.com/v2",
    daGasLimit: DA_GAS_LIMIT,
    l2GasLimit: L2_GAS_LIMIT,
  });
}

describe("FpcClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("builds payment method with correct fee payer, asset, and gas settings", async () => {
    const wallet = createMockWallet();
    globalThis.fetch = mockFetchOk(QUOTE_RESPONSE) as never;

    const client = createClient();
    const result = await client.createPaymentMethod({
      wallet: wallet as never,
      user: USER,
      tokenAddress: TOKEN_ADDRESS,
    });

    expect(await result.fee.paymentMethod.getAsset()).toBe(ProtocolContractAddress.FeeJuice);
    expect(await result.fee.paymentMethod.getFeePayer()).toBe(FPC_ADDRESS);
    expect(result.fee.paymentMethod.getGasSettings()).toEqual(
      new GasSettings(
        new Gas(DA_GAS_LIMIT, L2_GAS_LIMIT),
        new Gas(0, 0),
        MOCK_GAS_FEES,
        GasFees.empty(),
      ),
    );
  });

  it("computes fjAmount from node gas fees and gas limits", async () => {
    const wallet = createMockWallet();
    const node = createMockNode();
    globalThis.fetch = mockFetchOk(QUOTE_RESPONSE) as never;

    const client = createClient(node);
    const result = await client.createPaymentMethod({
      wallet: wallet as never,
      user: USER,
      tokenAddress: TOKEN_ADDRESS,
    });

    expect(result.quote.fj_amount).toBe(EXPECTED_FJ_AMOUNT.toString());
    expect(node.getCurrentMinFees).toHaveBeenCalledTimes(1);
  });

  it("constructs correct quote URL", async () => {
    const wallet = createMockWallet();
    const mockFetch = mockFetchOk(QUOTE_RESPONSE);
    globalThis.fetch = mockFetch as never;

    const client = createClient();
    await client.createPaymentMethod({
      wallet: wallet as never,
      user: USER,
      tokenAddress: TOKEN_ADDRESS,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(mockFetch.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/v2/quote");
    expect(calledUrl.searchParams.get("user")).toBe(USER.toString());
    expect(calledUrl.searchParams.get("accepted_asset")).toBe(TOKEN_ADDRESS.toString());
    expect(calledUrl.searchParams.get("fj_amount")).toBe(EXPECTED_FJ_AMOUNT.toString());
  });

  it("returns full quote response", async () => {
    const wallet = createMockWallet();
    globalThis.fetch = mockFetchOk(QUOTE_RESPONSE) as never;

    const client = createClient();
    const result = await client.createPaymentMethod({
      wallet: wallet as never,
      user: USER,
      tokenAddress: TOKEN_ADDRESS,
    });

    expect(result.quote).toEqual(QUOTE_RESPONSE);
  });

  it("calls wallet.createAuthWit with correct args", async () => {
    const wallet = createMockWallet();
    globalThis.fetch = mockFetchOk(QUOTE_RESPONSE) as never;

    const client = createClient();
    await client.createPaymentMethod({
      wallet: wallet as never,
      user: USER,
      tokenAddress: TOKEN_ADDRESS,
    });

    expect(wallet.createAuthWit).toHaveBeenCalledTimes(1);
    expect(wallet.createAuthWit).toHaveBeenCalledWith(USER, {
      caller: FPC_ADDRESS,
      call: { fn: "transfer" },
    });
  });

  it("registers contracts with wallet before use", async () => {
    const wallet = createMockWallet();
    globalThis.fetch = mockFetchOk(QUOTE_RESPONSE) as never;

    const client = createClient();
    await client.createPaymentMethod({
      wallet: wallet as never,
      user: USER,
      tokenAddress: TOKEN_ADDRESS,
    });

    expect(wallet.registerContract).toHaveBeenCalledTimes(2);
  });

  it("propagates fetch errors", async () => {
    const wallet = createMockWallet();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    })) as never;

    const client = createClient();
    await expect(
      client.createPaymentMethod({
        wallet: wallet as never,
        user: USER,
        tokenAddress: TOKEN_ADDRESS,
      }),
    ).rejects.toThrow("Quote request failed (500)");
  });

  it("throws when contract not found on node", async () => {
    const wallet = createMockWallet();
    globalThis.fetch = mockFetchOk(QUOTE_RESPONSE) as never;

    const node = createMockNode();
    node.getContract.mockResolvedValue(null);

    const client = createClient(node);
    await expect(
      client.createPaymentMethod({
        wallet: wallet as never,
        user: USER,
        tokenAddress: TOKEN_ADDRESS,
      }),
    ).rejects.toThrow("contract not found on node");
  });
});

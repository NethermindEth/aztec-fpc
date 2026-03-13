import { AztecAddress } from "@aztec/aztec.js/addresses";
import * as feeJuiceUtils from "@aztec/aztec.js/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SponsoredTxFailedError } from "../src/errors";
import { executeSponsoredCall, executeSponsoredEntrypoint } from "../src/index";
import * as contracts from "../src/internal/contracts";
import * as feePayment from "../src/internal/fee-payment";
import * as quote from "../src/internal/quote";

vi.mock("../src/internal/contracts", () => ({
  connectAndAttachContracts: vi.fn(),
}));
vi.mock("../src/internal/quote", () => ({
  fetchAndValidateQuote: vi.fn(),
  resolveAcceptedAssetsAndDiscovery: vi.fn(),
  resolveDiscoveryFpcAddress: vi.fn(),
  selectAcceptedAsset: vi.fn(),
}));
vi.mock("../src/internal/fee-payment", () => ({
  createSponsoredPaymentMethod: vi.fn(async () => ({
    paymentMethod: {
      getAsset: async () => undefined,
      getExecutionPayload: async () => undefined,
      getFeePayer: async () => undefined,
      getGasSettings: () => undefined,
    },
  })),
}));
vi.mock("@aztec/aztec.js/utils", () => ({
  getFeeJuiceBalance: vi.fn(async () => 999_999_999n),
}));

const USER = AztecAddress.fromString(
  "0x226762b1e122bd46054de3fd21a19f0500ebe072aeac35fe0bb82d43b85f94fd",
);
const TOKEN = AztecAddress.fromString(
  "0x10600e2f256b6500de5a79367d70b4c7d8121c408a2127dbcba995a1abc0d6f8",
);
const OPERATOR = AztecAddress.fromString(
  "0x18a15b90bea06cea7cbd06b3940533952aa9e5f94c157000c727321644d07af8",
);
const FPC = AztecAddress.fromString(
  "0x24a735808258519dc1637f1833202ea2dc7c829a0a82c73f61bbd195fce4105b",
);
const TARGET = AztecAddress.fromString(
  "0x016fa39000902287772e653a9e6cc2026dbb0f97c08a4d1b2c51ebbad4a4b24f",
);

function buildContext() {
  const privateValues = [100n, 90n];

  return {
    acceptedAsset: {
      methods: {
        balance_of_private: () => ({
          simulate: async () => ({ result: privateValues.shift() ?? 90n }),
        }),
      },
    },
    addresses: {
      acceptedAsset: TOKEN,
      fpc: FPC,
      operator: OPERATOR,
      targets: {
        custom: TARGET,
        target: TARGET,
      },
      user: USER,
    },
    faucet: undefined,
    fpc: {
      address: FPC,
      methods: {},
    },
    node: {
      getCurrentMinFees: async () => ({
        feePerDaGas: 1n,
        feePerL2Gas: 1n,
      }),
    },
    targets: {
      custom: {
        methods: {
          do_work: () => ({
            send: async () => ({
              receipt: {
                transactionFee: 123n,
                txHash: { toString: () => "0xabc" },
              },
            }),
          }),
        },
      },
      target: {
        methods: {
          increment: () => ({
            send: async () => ({
              receipt: {
                transactionFee: 123n,
                txHash: { toString: () => "0xabc" },
              },
            }),
          }),
        },
      },
    },
    token: {
      methods: {
        balance_of_private: () => ({
          simulate: async () => ({ result: privateValues.shift() ?? 90n }),
        }),
      },
    },
  };
}

describe("executeSponsoredCall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(contracts.connectAndAttachContracts).mockResolvedValue(buildContext() as never);
    vi.mocked(quote.resolveAcceptedAssetsAndDiscovery).mockResolvedValue({
      assets: [{ address: TOKEN.toString(), name: "humanUSDC" }],
      source: "accepted_assets_endpoint",
    } as never);
    vi.mocked(quote.selectAcceptedAsset).mockResolvedValue(TOKEN);
    vi.mocked(quote.resolveDiscoveryFpcAddress).mockReturnValue(FPC);
    vi.mocked(quote.fetchAndValidateQuote).mockResolvedValue({
      aaPaymentAmount: 10n,
      accepted_asset: TOKEN.toString(),
      fjAmount: 2_000_000n,
      fj_amount: "2000000",
      signature: "0x",
      signatureBytes: [1, 2, 3],
      validUntil: 999n,
      valid_until: "999",
    });
    vi.mocked(feeJuiceUtils.getFeeJuiceBalance).mockResolvedValue(999_999_999n);
  });

  it("executes arbitrary caller-built interaction with sponsorship", async () => {
    const send = vi.fn(async () => ({
      receipt: {
        transactionFee: 123n,
        txHash: { toString: () => "0xabc" },
      },
    }));

    const out = await executeSponsoredCall({
      account: USER,
      buildCall: (ctx) => {
        expect(ctx.contracts.targets.custom).toBeDefined();
        return Promise.resolve({ send });
      },
      sponsorship: {
        attestationBaseUrl: "https://attestation.example/v2",
        runtimeConfig: {
          acceptedAsset: { artifact: {} as never },
          fpc: { address: FPC, artifact: {} as never },
          nodeUrl: "http://node.example:8080",
          operatorAddress: OPERATOR,
          targets: {
            custom: { address: TARGET, artifact: {} as never },
          },
        },
      },
      wallet: {} as never,
    });

    expect(out.txHash).toBe("0xabc");
    expect(out.txFeeJuice).toBe(123n);
    expect(out.expectedCharge).toBe(10n);
    expect(out.userDebited).toBe(10n);
    expect(send).toHaveBeenCalledTimes(1);
    expect(contracts.connectAndAttachContracts).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeConfig: expect.objectContaining({
          acceptedAsset: expect.objectContaining({
            address: TOKEN,
          }),
        }),
      }),
    );
  });

  it("throws typed error when buildCall returns invalid interaction", async () => {
    await expect(
      executeSponsoredCall({
        account: USER,
        buildCall: async () => ({}) as never,
        sponsorship: {
          attestationBaseUrl: "https://attestation.example/v2",
          runtimeConfig: {
            acceptedAsset: { artifact: {} as never },
            fpc: { address: FPC, artifact: {} as never },
            nodeUrl: "http://node.example:8080",
            operatorAddress: OPERATOR,
          },
        },
        wallet: {} as never,
      }),
    ).rejects.toBeInstanceOf(SponsoredTxFailedError);
  });

  it("throws typed error when postChecks fail", async () => {
    await expect(
      executeSponsoredCall({
        account: USER,
        buildCall: async () => ({
          send: async () => ({
            receipt: {
              transactionFee: 123n,
              txHash: { toString: () => "0xabc" },
            },
          }),
        }),
        postChecks: () => Promise.reject(new Error("post-check failed")),
        sponsorship: {
          attestationBaseUrl: "https://attestation.example/v2",
          runtimeConfig: {
            acceptedAsset: { artifact: {} as never },
            fpc: { address: FPC, artifact: {} as never },
            nodeUrl: "http://node.example:8080",
            operatorAddress: OPERATOR,
          },
        },
        wallet: {} as never,
      }),
    ).rejects.toBeInstanceOf(SponsoredTxFailedError);
  });

  it("passes through discovery-driven fpc resolution", async () => {
    await executeSponsoredCall({
      account: USER,
      buildCall: async () => ({
        send: async () => ({
          receipt: {
            transactionFee: 123n,
            txHash: { toString: () => "0xabc" },
          },
        }),
      }),
      sponsorship: {
        attestationBaseUrl: "https://attestation.example/v2",
        resolveFpcFromDiscovery: true,
        runtimeConfig: {
          acceptedAsset: { artifact: {} as never },
          fpc: { artifact: {} as never },
          nodeUrl: "http://node.example:8080",
          operatorAddress: OPERATOR,
        },
      },
      wallet: {} as never,
    });

    expect(quote.resolveDiscoveryFpcAddress).toHaveBeenCalledTimes(1);
    expect(contracts.connectAndAttachContracts).toHaveBeenCalledWith(
      expect.objectContaining({ discoveryFpcAddress: FPC }),
    );
  });

  it("rejects when receipt shape omits transaction metadata", async () => {
    await expect(
      executeSponsoredCall({
        account: USER,
        buildCall: async () => ({
          send: async () => ({ ok: true }),
        }),
        sponsorship: {
          attestationBaseUrl: "https://attestation.example/v2",
          runtimeConfig: {
            acceptedAsset: { artifact: {} as never },
            fpc: { address: FPC, artifact: {} as never },
            nodeUrl: "http://node.example:8080",
            operatorAddress: OPERATOR,
          },
        },
        wallet: {} as never,
      }),
    ).rejects.toBeInstanceOf(SponsoredTxFailedError);
  });

  it("builds sponsored payment method once per execution", async () => {
    await executeSponsoredCall({
      account: USER,
      buildCall: async () => ({
        send: async () => ({
          receipt: {
            transactionFee: 123n,
            txHash: { toString: () => "0xabc" },
          },
        }),
      }),
      sponsorship: {
        attestationBaseUrl: "https://attestation.example/v2",
        runtimeConfig: {
          acceptedAsset: { artifact: {} as never },
          fpc: { address: FPC, artifact: {} as never },
          nodeUrl: "http://node.example:8080",
          operatorAddress: OPERATOR,
        },
      },
      wallet: {} as never,
    });

    expect(feePayment.createSponsoredPaymentMethod).toHaveBeenCalledTimes(1);
  });
});

describe("executeSponsoredEntrypoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(contracts.connectAndAttachContracts).mockResolvedValue(buildContext() as never);
    vi.mocked(quote.resolveAcceptedAssetsAndDiscovery).mockResolvedValue({
      assets: [{ address: TOKEN.toString(), name: "humanUSDC" }],
      source: "accepted_assets_endpoint",
    } as never);
    vi.mocked(quote.selectAcceptedAsset).mockResolvedValue(TOKEN);
    vi.mocked(quote.resolveDiscoveryFpcAddress).mockReturnValue(FPC);
    vi.mocked(quote.fetchAndValidateQuote).mockResolvedValue({
      aaPaymentAmount: 10n,
      accepted_asset: TOKEN.toString(),
      fjAmount: 2_000_000n,
      fj_amount: "2000000",
      signature: "0x",
      signatureBytes: [1, 2, 3],
      validUntil: 999n,
      valid_until: "999",
    });
    vi.mocked(feeJuiceUtils.getFeeJuiceBalance).mockResolvedValue(999_999_999n);
  });

  it("executes target entrypoint without custom buildCall plumbing", async () => {
    const callMethod = vi.fn(() => ({
      send: async () => ({
        receipt: {
          transactionFee: 123n,
          txHash: { toString: () => "0xdef" },
        },
      }),
    }));

    vi.mocked(contracts.connectAndAttachContracts).mockResolvedValueOnce({
      ...buildContext(),
      addresses: {
        ...buildContext().addresses,
        targets: { target: TARGET },
      },
      targets: {
        target: {
          methods: {
            increment: callMethod,
          },
        },
      },
    } as never);

    const out = await executeSponsoredEntrypoint({
      account: USER,
      sponsorship: {
        attestationBaseUrl: "https://attestation.example/v2",
        runtimeConfig: {
          acceptedAsset: { artifact: {} as never },
          fpc: { address: FPC, artifact: {} as never },
          nodeUrl: "http://node.example:8080",
          operatorAddress: OPERATOR,
        },
      },
      target: {
        address: TARGET,
        appendUserToArgs: true,
        args: ["$USER"],
        artifact: {} as never,
        method: "increment",
      },
      wallet: {} as never,
    });

    expect(out.txHash).toBe("0xdef");
    expect(callMethod).toHaveBeenCalledWith(USER, USER);
    expect(contracts.connectAndAttachContracts).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeConfig: expect.objectContaining({
          targets: expect.objectContaining({
            target: expect.objectContaining({
              address: TARGET,
            }),
          }),
        }),
      }),
    );
  });

  it("throws when target is not provided and not registered in runtime config", () => {
    expect(() =>
      executeSponsoredEntrypoint({
        account: USER,
        sponsorship: {
          attestationBaseUrl: "https://attestation.example/v2",
          runtimeConfig: {
            acceptedAsset: { artifact: {} as never },
            fpc: { address: FPC, artifact: {} as never },
            nodeUrl: "http://node.example:8080",
            operatorAddress: OPERATOR,
          },
        },
        target: {
          method: "increment",
        },
        wallet: {} as never,
      }),
    ).toThrow(SponsoredTxFailedError);
  });
});

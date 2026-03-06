import { AztecAddress } from "@aztec/aztec.js/addresses";
import * as feeJuiceUtils from "@aztec/aztec.js/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InsufficientFpcFeeJuiceError, SponsoredTxFailedError } from "../src/errors";
import { createSponsoredCounterClient } from "../src/index";
import * as balanceBootstrap from "../src/internal/balance-bootstrap";
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
vi.mock("../src/internal/balance-bootstrap", () => ({
  ensurePrivateBalance: vi.fn(async () => 0n),
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

function buildContext(input: {
  counterAfter: bigint;
  privateAfter?: bigint;
  privateBefore?: bigint;
}): unknown {
  const counterValues = [0n, input.counterAfter];
  const privateValues = [input.privateBefore ?? 100n, input.privateAfter ?? 90n];

  const counterContract = {
    methods: {
      get_counter: () => ({
        simulate: async () => counterValues.shift() ?? input.counterAfter,
      }),
      increment: () => ({
        send: async () => ({
          transactionFee: 123n,
          txHash: { toString: () => "0xabc" },
        }),
      }),
    },
  };

  return {
    acceptedAsset: {
      methods: {
        balance_of_private: () => ({
          simulate: async () => privateValues.shift() ?? 90n,
        }),
      },
    },
    addresses: {
      acceptedAsset: TOKEN,
      fpc: FPC,
      operator: OPERATOR,
      targets: {
        counter: USER,
      },
      user: USER,
    },
    counter: counterContract,
    faucet: {},
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
      counter: counterContract,
    },
    token: {
      methods: {
        balance_of_private: () => ({
          simulate: async () => privateValues.shift() ?? 90n,
        }),
      },
    },
  };
}

describe("increment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(quote.resolveAcceptedAssetsAndDiscovery).mockResolvedValue({
      assets: [{ address: TOKEN.toString(), name: "humanUSDC" }],
      source: "accepted_assets_endpoint",
    } as never);
    vi.mocked(quote.selectAcceptedAsset).mockResolvedValue(TOKEN);
    vi.mocked(quote.fetchAndValidateQuote).mockResolvedValue({
      aaPaymentAmount: 10n,
      accepted_asset: TOKEN.toString(),
      fjAmount: 2_000_000n,
      fj_amount: "2000000",
      quoteSignatureBytes: [1, 2, 3],
      signature: "0x",
      signatureBytes: [1, 2, 3],
      validUntil: 999n,
      valid_until: "999",
    });
    vi.mocked(feeJuiceUtils.getFeeJuiceBalance).mockResolvedValue(999_999_999n);
  });

  it("returns result payload when increment invariants hold", async () => {
    vi.mocked(contracts.connectAndAttachContracts).mockResolvedValue(
      buildContext({ counterAfter: 1n }) as never,
    );

    const client = await createSponsoredCounterClient({
      account: USER,
      wallet: {} as never,
    });
    const out = await client.increment();

    expect(out.txHash).toBe("0xabc");
    expect(out.txFeeJuice).toBe(123n);
    expect(out.counterBefore).toBe(0n);
    expect(out.counterAfter).toBe(1n);
    expect(out.expectedCharge).toBe(10n);
    expect(out.userDebited).toBe(10n);
    expect(quote.resolveAcceptedAssetsAndDiscovery).toHaveBeenCalledTimes(1);
    expect(quote.fetchAndValidateQuote).toHaveBeenCalledTimes(1);
    expect(balanceBootstrap.ensurePrivateBalance).toHaveBeenCalledTimes(1);
    expect(feePayment.createSponsoredPaymentMethod).toHaveBeenCalledTimes(1);
    expect(feeJuiceUtils.getFeeJuiceBalance).toHaveBeenCalledTimes(1);
  });

  it("throws when counter invariant fails", async () => {
    vi.mocked(contracts.connectAndAttachContracts).mockResolvedValue(
      buildContext({ counterAfter: 2n }) as never,
    );

    const client = await createSponsoredCounterClient({
      account: USER.toString(),
      wallet: {} as never,
    });

    await expect(client.increment()).rejects.toBeInstanceOf(SponsoredTxFailedError);
  });

  it("throws when debit/accounting invariant fails", async () => {
    vi.mocked(contracts.connectAndAttachContracts).mockResolvedValue(
      buildContext({
        counterAfter: 1n,
        privateAfter: 95n,
        privateBefore: 100n,
      }) as never,
    );

    const client = await createSponsoredCounterClient({
      account: USER.toString(),
      wallet: {} as never,
    });

    await expect(client.increment()).rejects.toBeInstanceOf(SponsoredTxFailedError);
  });

  it("throws typed error when fpc fee juice is insufficient", async () => {
    vi.mocked(contracts.connectAndAttachContracts).mockResolvedValue(
      buildContext({ counterAfter: 1n }) as never,
    );
    vi.mocked(feeJuiceUtils.getFeeJuiceBalance).mockResolvedValue(1n);

    const client = await createSponsoredCounterClient({
      account: USER,
      wallet: {} as never,
    });

    await expect(client.increment()).rejects.toBeInstanceOf(InsufficientFpcFeeJuiceError);
  });
});

import { describe, expect, it, vi } from "vitest";

import { BalanceBootstrapError } from "../src/errors";
import { ensurePrivateBalance } from "../src/internal/balance-bootstrap";

describe("bootstrap", () => {
  it("reaches required private balance after drip and shield", async () => {
    let privateBalance = 0n;
    let publicBalance = 0n;

    const drip = vi.fn(() => {
      publicBalance = 25n;
    });
    const shield = vi.fn(() => {
      privateBalance += publicBalance;
      publicBalance = 0n;
    });

    const out = await ensurePrivateBalance({
      faucet: {
        methods: {
          drip: () => ({ send: async () => drip() }),
        },
      },
      from: "user",
      maxFaucetAttempts: 3,
      minimumPrivateAcceptedAsset: 10n,
      token: {
        methods: {
          balance_of_private: () => ({
            simulate: async () => privateBalance,
          }),
          balance_of_public: () => ({
            simulate: async () => publicBalance,
          }),
          transfer_public_to_private: () => ({
            send: async () => shield(),
          }),
        },
      },
      txWaitTimeoutSeconds: 180,
      user: "user",
    });

    expect(out).toBeGreaterThanOrEqual(10n);
    expect(drip).toHaveBeenCalledTimes(1);
    expect(shield).toHaveBeenCalledTimes(1);
  });

  it("fails after max faucet attempts when public balance stays zero", async () => {
    const drip = vi.fn(() => {});
    const shield = vi.fn(() => {});

    await expect(
      ensurePrivateBalance({
        faucet: {
          methods: {
            drip: () => ({ send: async () => drip() }),
          },
        },
        from: "user",
        maxFaucetAttempts: 2,
        minimumPrivateAcceptedAsset: 10n,
        token: {
          methods: {
            balance_of_private: () => ({ simulate: async () => 0n }),
            balance_of_public: () => ({ simulate: async () => 0n }),
            transfer_public_to_private: () => ({ send: async () => shield() }),
          },
        },
        txWaitTimeoutSeconds: 180,
        user: "user",
      }),
    ).rejects.toBeInstanceOf(BalanceBootstrapError);
  });
});

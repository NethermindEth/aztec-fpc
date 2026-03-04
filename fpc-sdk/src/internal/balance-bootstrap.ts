import { Fr } from "@aztec/aztec.js/fields";

import { BalanceBootstrapError } from "../errors";

export type BalanceBootstrapInput = {
  faucet: {
    methods: {
      drip: (
        user: unknown,
      ) => { send: (args: { from: unknown; wait: { timeout: number } }) => Promise<unknown> };
    };
  };
  from: unknown;
  maxFaucetAttempts: number;
  minimumPrivateAcceptedAsset: bigint;
  token: {
    methods: {
      balance_of_private: (
        user: unknown,
      ) => { simulate: (args: { from: unknown }) => Promise<{ toString(): string } | bigint> };
      balance_of_public: (
        user: unknown,
      ) => { simulate: (args: { from: unknown }) => Promise<{ toString(): string } | bigint> };
      transfer_public_to_private: (
        from: unknown,
        to: unknown,
        amount: bigint,
        secret: Fr,
      ) => { send: (args: { from: unknown; wait: { timeout: number } }) => Promise<unknown> };
    };
  };
  txWaitTimeoutSeconds: number;
  user: unknown;
};

function toBigInt(value: { toString(): string } | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value.toString());
}

export async function ensurePrivateBalance(input: BalanceBootstrapInput): Promise<bigint> {
  let userPrivateBalance = toBigInt(
    await input.token.methods.balance_of_private(input.user).simulate({ from: input.from }),
  );

  for (
    let attempt = 1;
    userPrivateBalance < input.minimumPrivateAcceptedAsset;
    attempt += 1
  ) {
    if (attempt > input.maxFaucetAttempts) {
      throw new BalanceBootstrapError(
        "Unable to reach required private accepted-asset balance after faucet attempts.",
        {
          current: userPrivateBalance.toString(),
          maxFaucetAttempts: input.maxFaucetAttempts,
          required: input.minimumPrivateAcceptedAsset.toString(),
        },
      );
    }

    let userPublicBalance = toBigInt(
      await input.token.methods.balance_of_public(input.user).simulate({ from: input.from }),
    );

    if (userPublicBalance === 0n) {
      await input.faucet.methods.drip(input.user).send({
        from: input.from,
        wait: { timeout: input.txWaitTimeoutSeconds },
      });

      userPublicBalance = toBigInt(
        await input.token.methods.balance_of_public(input.user).simulate({ from: input.from }),
      );
    }

    if (userPublicBalance === 0n) {
      throw new BalanceBootstrapError(
        "Faucet drip did not credit user public balance; cannot shield funds.",
        {
          attempt,
        },
      );
    }

    await input.token.methods
      .transfer_public_to_private(input.user, input.user, userPublicBalance, Fr.random())
      .send({
        from: input.from,
        wait: { timeout: input.txWaitTimeoutSeconds },
      });

    userPrivateBalance = toBigInt(
      await input.token.methods.balance_of_private(input.user).simulate({ from: input.from }),
    );
  }

  return userPrivateBalance;
}

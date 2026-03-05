import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { Gas, GasFees } from "@aztec/stdlib/gas";
import { createDevnetRuntimeConfig, SDK_DEFAULTS } from "./defaults";
import {
  InsufficientFpcFeeJuiceError,
  SponsoredSdkError,
  SponsoredTxFailedError,
} from "./errors";
import { ensurePrivateBalance } from "./internal/balance-bootstrap";
import { connectAndAttachContracts } from "./internal/contracts";
import { createSponsoredPaymentMethod } from "./internal/fee-payment";
import {
  fetchAndValidateQuote,
  resolveAcceptedAssetsAndDiscovery,
  resolveDiscoveryFpcAddress,
  selectAcceptedAsset,
} from "./internal/quote";
import type {
  CreateSponsoredCounterClientInput,
  ExecuteSponsoredCallInput,
  SponsoredCounterClient,
  SponsoredExecutionResult,
} from "./types";

function toBigInt(value: { toString(): string } | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value.toString());
}

function sameAddress(
  a: { toString(): string },
  b: { toString(): string },
): boolean {
  return a.toString().toLowerCase() === b.toString().toLowerCase();
}

function readReceiptMetadata(receipt: unknown): {
  txFeeJuice: bigint;
  txHash: string;
} {
  if (!receipt || typeof receipt !== "object") {
    throw new SponsoredTxFailedError(
      "Sponsored call receipt must be an object with txHash and transactionFee.",
    );
  }

  const txHashCandidate = (receipt as { txHash?: { toString(): string } }).txHash;
  if (!txHashCandidate || typeof txHashCandidate.toString !== "function") {
    throw new SponsoredTxFailedError(
      "Sponsored call receipt is missing txHash.",
    );
  }

  const feeCandidate = (receipt as {
    transactionFee?: { toString(): string } | bigint;
  }).transactionFee;
  if (feeCandidate === undefined) {
    throw new SponsoredTxFailedError(
      "Sponsored call receipt is missing transactionFee.",
    );
  }

  return {
    txFeeJuice: toBigInt(feeCandidate),
    txHash: txHashCandidate.toString(),
  };
}

type CounterContractLike = {
  methods: {
    get_counter: (user: unknown) => {
      simulate: (args: {
        from: unknown;
      }) => Promise<{ toString(): string } | bigint>;
    };
    increment: (user: unknown) => {
      send: (args: {
        fee: unknown;
        from: unknown;
        wait: { timeout: number };
      }) => Promise<unknown>;
    };
  };
};

function asCounterContract(target: unknown): CounterContractLike {
  if (!target || typeof target !== "object") {
    throw new SponsoredTxFailedError("Counter target contract is missing.");
  }
  const methods = (target as { methods?: unknown }).methods;
  if (!methods || typeof methods !== "object") {
    throw new SponsoredTxFailedError(
      "Counter target contract does not expose methods.",
    );
  }

  const getCounter = (methods as { get_counter?: unknown }).get_counter;
  const increment = (methods as { increment?: unknown }).increment;
  if (typeof getCounter !== "function" || typeof increment !== "function") {
    throw new SponsoredTxFailedError(
      "Counter target contract is missing get_counter/increment methods.",
    );
  }

  return target as CounterContractLike;
}

export async function executeSponsoredCall<TReceipt>(
  input: ExecuteSponsoredCallInput<TReceipt>,
): Promise<SponsoredExecutionResult<TReceipt>> {
  try {
    const sponsorship = input.sponsorship;
    const daGasLimit = sponsorship.daGasLimit ?? SDK_DEFAULTS.daGasLimit;
    const l2GasLimit = sponsorship.l2GasLimit ?? SDK_DEFAULTS.l2GasLimit;
    const maxFaucetAttempts =
      sponsorship.maxFaucetAttempts ?? SDK_DEFAULTS.maxFaucetAttempts;
    const minimumPrivateBalanceBuffer =
      sponsorship.minimumPrivateBalanceBuffer ??
      SDK_DEFAULTS.minimumPrivateBalanceBuffer;
    const txWaitTimeoutSeconds =
      sponsorship.txWaitTimeoutSeconds ?? SDK_DEFAULTS.txWaitTimeoutSeconds;

    const discovered = await resolveAcceptedAssetsAndDiscovery({
      attestationBaseUrl: sponsorship.attestationBaseUrl,
      fetchImpl: sponsorship.fetchImpl,
    });
    const acceptedAssetAddress = await selectAcceptedAsset({
      explicitAcceptedAsset:
        sponsorship.tokenSelection?.explicitAcceptedAsset ??
        sponsorship.runtimeConfig.acceptedAsset.address,
      selector: sponsorship.tokenSelection?.selector,
      supportedAssets: discovered.assets,
    });

    const discoveryFpcAddress = sponsorship.resolveFpcFromDiscovery
      ? resolveDiscoveryFpcAddress({
          discovery: discovered.discovery,
          required: true,
        })
      : sponsorship.discoveryFpcAddress;

    const runtimeConfig = {
      ...sponsorship.runtimeConfig,
      acceptedAsset: {
        ...sponsorship.runtimeConfig.acceptedAsset,
        address: acceptedAssetAddress,
      },
    };

    const context = await connectAndAttachContracts({
      account: input.account,
      discoveryFpcAddress,
      runtimeConfig,
      wallet: input.wallet,
    });

    const minFees = await context.node.getCurrentMinFees();
    const fjAmount =
      BigInt(daGasLimit) * minFees.feePerDaGas +
      BigInt(l2GasLimit) * minFees.feePerL2Gas;
    const fpcFeeJuiceBalance = await getFeeJuiceBalance(
      context.addresses.fpc,
      context.node,
    );
    if (fpcFeeJuiceBalance < fjAmount) {
      throw new InsufficientFpcFeeJuiceError(
        "FPC FeeJuice balance is below required amount.",
        {
          current: fpcFeeJuiceBalance.toString(),
          required: fjAmount.toString(),
        },
      );
    }

    const quote = await fetchAndValidateQuote({
      acceptedAsset: acceptedAssetAddress,
      attestationBaseUrl: sponsorship.attestationBaseUrl,
      fetchImpl: sponsorship.fetchImpl,
      fjAmount,
      user: context.addresses.user,
    });

    if (context.faucet) {
      await ensurePrivateBalance({
        faucet: context.faucet as never,
        from: context.addresses.user,
        maxFaucetAttempts,
        minimumPrivateAcceptedAsset:
          quote.aaPaymentAmount + minimumPrivateBalanceBuffer,
        token: context.acceptedAsset as never,
        txWaitTimeoutSeconds,
        user: context.addresses.user,
      });
    }

    const userPrivateBefore = toBigInt(
      await context.acceptedAsset.methods
        .balance_of_private(context.addresses.user)
        .simulate({ from: context.addresses.user }),
    );

    const { paymentMethod } = await createSponsoredPaymentMethod({
      aaPaymentAmount: quote.aaPaymentAmount,
      fpc: context.fpc as never,
      fjAmount,
      operatorAddress: context.addresses.operator,
      quoteSignatureBytes: quote.signatureBytes,
      quoteValidUntil: quote.validUntil,
      token: context.acceptedAsset as never,
      tokenAddress: acceptedAssetAddress,
      user: context.addresses.user,
      wallet: input.wallet,
    });

    const interaction = await input.buildCall({
      acceptedAssetAddress,
      contracts: {
        acceptedAsset: context.acceptedAsset,
        faucet: context.faucet,
        fpc: context.fpc,
        node: context.node,
        targets: context.targets,
      },
      user: context.addresses.user,
    });
    if (!interaction || typeof interaction.send !== "function") {
      throw new SponsoredTxFailedError(
        "buildCall must return an interaction with send(args).",
      );
    }

    const gasLimits = new Gas(daGasLimit, l2GasLimit);
    const teardownGasLimits = new Gas(0, 0);
    const maxFeesPerGas = new GasFees(
      minFees.feePerDaGas,
      minFees.feePerL2Gas,
    );

    let receipt: TReceipt;
    try {
      receipt = await interaction.send({
        fee: {
          gasSettings: { gasLimits, maxFeesPerGas, teardownGasLimits },
          paymentMethod,
        },
        from: context.addresses.user,
        wait: { timeout: txWaitTimeoutSeconds },
      });
    } catch (error) {
      throw new SponsoredTxFailedError(
        "Sponsored transaction submission failed.",
        {
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }

    const userPrivateAfter = toBigInt(
      await context.acceptedAsset.methods
        .balance_of_private(context.addresses.user)
        .simulate({ from: context.addresses.user }),
    );
    const userDebited = userPrivateBefore - userPrivateAfter;

    if (
      !sameAddress(context.addresses.user, context.addresses.operator) &&
      userDebited !== quote.aaPaymentAmount
    ) {
      throw new SponsoredTxFailedError("Accounting invariant failed.", {
        expectedCharge: quote.aaPaymentAmount.toString(),
        userDebited: userDebited.toString(),
      });
    }

    if (input.postChecks) {
      try {
        await input.postChecks({
          expectedCharge: quote.aaPaymentAmount,
          fjAmount,
          receipt,
          user: context.addresses.user,
          userDebited,
        });
      } catch (error) {
        throw new SponsoredTxFailedError("Sponsored post-check failed.", {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const receiptMeta = readReceiptMetadata(receipt);
    return {
      expectedCharge: quote.aaPaymentAmount,
      fjAmount,
      quoteValidUntil: quote.validUntil,
      receipt,
      txFeeJuice: receiptMeta.txFeeJuice,
      txHash: receiptMeta.txHash,
      userDebited,
    };
  } catch (error) {
    if (error instanceof SponsoredSdkError) {
      throw error;
    }
    throw new SponsoredTxFailedError("Failed to execute sponsored call.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function createSponsoredCounterClient(
  input: CreateSponsoredCounterClientInput,
): Promise<SponsoredCounterClient> {
  return {
    async increment() {
      try {
        let counter: CounterContractLike | undefined;
        let counterBefore: bigint | undefined;
        let counterAfter: bigint | undefined;

        const execution = await executeSponsoredCall<{
          transactionFee: { toString(): string } | bigint;
          txHash: { toString(): string };
        }>({
          account: input.account,
          buildCall: async (ctx) => {
            counter = asCounterContract(ctx.contracts.targets.counter);
            counterBefore = toBigInt(
              await counter.methods
                .get_counter(ctx.user)
                .simulate({ from: ctx.user }),
            );
            return counter.methods.increment(ctx.user);
          },
          postChecks: async (ctx) => {
            if (!counter || counterBefore === undefined) {
              throw new SponsoredTxFailedError(
                "Counter state was not initialized before post-checks.",
              );
            }
            counterAfter = toBigInt(
              await counter.methods
                .get_counter(ctx.user)
                .simulate({ from: ctx.user }),
            );
            if (counterAfter !== counterBefore + 1n) {
              throw new SponsoredTxFailedError(
                "Counter increment invariant failed.",
                {
                  counterAfter: counterAfter.toString(),
                  counterBefore: counterBefore.toString(),
                },
              );
            }
          },
          sponsorship: {
            attestationBaseUrl: SDK_DEFAULTS.attestationBaseUrl,
            daGasLimit: SDK_DEFAULTS.daGasLimit,
            l2GasLimit: SDK_DEFAULTS.l2GasLimit,
            maxFaucetAttempts: SDK_DEFAULTS.maxFaucetAttempts,
            minimumPrivateBalanceBuffer:
              SDK_DEFAULTS.minimumPrivateBalanceBuffer,
            runtimeConfig: createDevnetRuntimeConfig(),
            txWaitTimeoutSeconds: SDK_DEFAULTS.txWaitTimeoutSeconds,
          },
          wallet: input.wallet,
        });

        if (counterBefore === undefined || counterAfter === undefined) {
          throw new SponsoredTxFailedError(
            "Counter state was not captured by wrapper flow.",
          );
        }

        return {
          counterAfter,
          counterBefore,
          expectedCharge: execution.expectedCharge,
          quoteValidUntil: execution.quoteValidUntil,
          txFeeJuice: execution.txFeeJuice,
          txHash: execution.txHash,
          userDebited: execution.userDebited,
        };
      } catch (error) {
        if (error instanceof SponsoredSdkError) {
          throw error;
        }
        throw new SponsoredTxFailedError(
          "Failed to execute sponsored increment.",
          {
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
    },
  };
}

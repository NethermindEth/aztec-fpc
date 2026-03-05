import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { Gas, GasFees } from "@aztec/stdlib/gas";
import { createDevnetRuntimeConfig, SDK_DEFAULTS } from "./defaults";
import { InsufficientFpcFeeJuiceError, SponsoredSdkError, SponsoredTxFailedError } from "./errors";
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
  ExecuteSponsoredEntrypointInput,
  SponsoredCounterClient,
  SponsoredExecutionResult,
  SponsorshipConfig,
} from "./types";

function toBigInt(value: { toString(): string } | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value.toString());
}

function sameAddress(a: { toString(): string }, b: { toString(): string }): boolean {
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
    throw new SponsoredTxFailedError("Sponsored call receipt is missing txHash.");
  }

  const feeCandidate = (
    receipt as {
      transactionFee?: { toString(): string } | bigint;
    }
  ).transactionFee;
  if (feeCandidate === undefined) {
    throw new SponsoredTxFailedError("Sponsored call receipt is missing transactionFee.");
  }

  return {
    txFeeJuice: toBigInt(feeCandidate),
    txHash: txHashCandidate.toString(),
  };
}

type CounterReceipt = {
  transactionFee: { toString(): string } | bigint;
  txHash: { toString(): string };
};

type CounterContractLike = {
  methods: {
    get_counter: (user: unknown) => {
      simulate: (args: { from: unknown }) => Promise<{ toString(): string } | bigint>;
    };
    increment: (user: unknown) => {
      send: (args: {
        fee: unknown;
        from: unknown;
        wait: { timeout: number };
      }) => Promise<CounterReceipt>;
    };
  };
};

function asCounterContract(target: unknown): CounterContractLike {
  if (!target || typeof target !== "object") {
    throw new SponsoredTxFailedError("Counter target contract is missing.");
  }
  const methods = (target as { methods?: unknown }).methods;
  if (!methods || typeof methods !== "object") {
    throw new SponsoredTxFailedError("Counter target contract does not expose methods.");
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

type EntrypointContractLike = {
  methods: Record<string, (...args: unknown[]) => unknown>;
};

function asEntrypointContract(target: unknown, label: string): EntrypointContractLike {
  if (!target || typeof target !== "object") {
    throw new SponsoredTxFailedError(
      `Target contract '${label}' is missing from attached runtime targets.`,
    );
  }
  const methods = (target as { methods?: unknown }).methods;
  if (!methods || typeof methods !== "object") {
    throw new SponsoredTxFailedError(`Target contract '${label}' does not expose methods.`);
  }
  return target as EntrypointContractLike;
}

function buildEntrypointArgs(input: {
  appendUserToArgs?: boolean;
  args?: readonly unknown[];
  user: { toString(): string };
  userArgPlaceholders?: readonly string[];
}): unknown[] {
  const placeholders = new Set(
    (input.userArgPlaceholders ?? ["$USER", "__USER__"]).map((value) => value.toLowerCase()),
  );
  const args = (input.args ?? []).map((arg) => {
    if (typeof arg === "string" && placeholders.has(arg.trim().toLowerCase())) {
      return input.user;
    }
    return arg;
  });
  if (input.appendUserToArgs) {
    args.push(input.user);
  }
  return args;
}

export function executeSponsoredEntrypoint<TReceipt>(
  input: ExecuteSponsoredEntrypointInput<TReceipt>,
): Promise<SponsoredExecutionResult<TReceipt>> {
  const targetLabel = input.target.label ?? "target";
  const runtimeTargets = {
    ...(input.sponsorship.runtimeConfig.targets ?? {}),
  };
  const runtimeTarget = runtimeTargets[targetLabel];

  if (input.target.address !== undefined || input.target.artifact !== undefined) {
    runtimeTargets[targetLabel] = {
      ...runtimeTarget,
      address: input.target.address ?? runtimeTarget?.address,
      artifact: input.target.artifact ?? runtimeTarget?.artifact,
    };
  } else if (!runtimeTarget) {
    throw new SponsoredTxFailedError(
      `Target '${targetLabel}' is not configured. Provide target.address/artifact or register runtimeConfig.targets['${targetLabel}'].`,
    );
  }

  return executeSponsoredCall<TReceipt>({
    account: input.account,
    buildCall: (ctx) => {
      const target = asEntrypointContract(ctx.contracts.targets[targetLabel], targetLabel);
      const method = target.methods[input.target.method];
      if (typeof method !== "function") {
        throw new SponsoredTxFailedError(
          `Target method '${input.target.method}' was not found on target '${targetLabel}'.`,
        );
      }

      const builtArgs = buildEntrypointArgs({
        appendUserToArgs: input.target.appendUserToArgs,
        args: input.target.args,
        user: ctx.user,
        userArgPlaceholders: input.target.userArgPlaceholders,
      });
      return Promise.resolve(method(...builtArgs) as never);
    },
    postChecks: input.postChecks,
    sponsorship: {
      ...input.sponsorship,
      runtimeConfig: {
        ...input.sponsorship.runtimeConfig,
        targets: runtimeTargets,
      },
    },
    wallet: input.wallet,
  });
}

type ConnectedContext = Awaited<ReturnType<typeof connectAndAttachContracts>>;

type SponsoredExecutionDefaults = {
  daGasLimit: number;
  l2GasLimit: number;
  maxFaucetAttempts: number;
  minimumPrivateBalanceBuffer: bigint;
  txWaitTimeoutSeconds: number;
};

function resolveExecutionDefaults(sponsorship: SponsorshipConfig): SponsoredExecutionDefaults {
  return {
    daGasLimit: sponsorship.daGasLimit ?? SDK_DEFAULTS.daGasLimit,
    l2GasLimit: sponsorship.l2GasLimit ?? SDK_DEFAULTS.l2GasLimit,
    maxFaucetAttempts: sponsorship.maxFaucetAttempts ?? SDK_DEFAULTS.maxFaucetAttempts,
    minimumPrivateBalanceBuffer:
      sponsorship.minimumPrivateBalanceBuffer ?? SDK_DEFAULTS.minimumPrivateBalanceBuffer,
    txWaitTimeoutSeconds: sponsorship.txWaitTimeoutSeconds ?? SDK_DEFAULTS.txWaitTimeoutSeconds,
  };
}

async function resolveConnectedContext(input: {
  account: ExecuteSponsoredCallInput<unknown>["account"];
  sponsorship: SponsorshipConfig;
  wallet: ExecuteSponsoredCallInput<unknown>["wallet"];
}): Promise<{
  acceptedAssetAddress: Awaited<ReturnType<typeof selectAcceptedAsset>>;
  context: ConnectedContext;
}> {
  const discovered = await resolveAcceptedAssetsAndDiscovery({
    attestationBaseUrl: input.sponsorship.attestationBaseUrl,
    fetchImpl: input.sponsorship.fetchImpl,
  });
  const acceptedAssetAddress = await selectAcceptedAsset({
    explicitAcceptedAsset:
      input.sponsorship.tokenSelection?.explicitAcceptedAsset ??
      input.sponsorship.runtimeConfig.acceptedAsset.address,
    selector: input.sponsorship.tokenSelection?.selector,
    supportedAssets: discovered.assets,
  });
  const discoveryFpcAddress = input.sponsorship.resolveFpcFromDiscovery
    ? resolveDiscoveryFpcAddress({
        discovery: discovered.discovery,
        required: true,
      })
    : input.sponsorship.discoveryFpcAddress;

  const runtimeConfig = {
    ...input.sponsorship.runtimeConfig,
    acceptedAsset: {
      ...input.sponsorship.runtimeConfig.acceptedAsset,
      address: acceptedAssetAddress,
    },
  };

  const context = await connectAndAttachContracts({
    account: input.account,
    discoveryFpcAddress,
    runtimeConfig,
    wallet: input.wallet,
  });
  return { acceptedAssetAddress, context };
}

async function computeFeeJuiceAndMinFees(input: {
  context: ConnectedContext;
  daGasLimit: number;
  l2GasLimit: number;
}): Promise<{
  fjAmount: bigint;
  minFees: Awaited<ReturnType<ConnectedContext["node"]["getCurrentMinFees"]>>;
}> {
  const minFees = await input.context.node.getCurrentMinFees();
  const fjAmount =
    BigInt(input.daGasLimit) * minFees.feePerDaGas + BigInt(input.l2GasLimit) * minFees.feePerL2Gas;
  const fpcFeeJuiceBalance = await getFeeJuiceBalance(
    input.context.addresses.fpc,
    input.context.node,
  );

  if (fpcFeeJuiceBalance < fjAmount) {
    throw new InsufficientFpcFeeJuiceError("FPC FeeJuice balance is below required amount.", {
      current: fpcFeeJuiceBalance.toString(),
      required: fjAmount.toString(),
    });
  }
  return { fjAmount, minFees };
}

async function bootstrapIfNeeded(input: {
  context: ConnectedContext;
  maxFaucetAttempts: number;
  minimumPrivateBalanceBuffer: bigint;
  quoteAaPaymentAmount: bigint;
  txWaitTimeoutSeconds: number;
}): Promise<void> {
  if (!input.context.faucet) {
    return;
  }
  await ensurePrivateBalance({
    faucet: input.context.faucet as never,
    from: input.context.addresses.user,
    maxFaucetAttempts: input.maxFaucetAttempts,
    minimumPrivateAcceptedAsset: input.quoteAaPaymentAmount + input.minimumPrivateBalanceBuffer,
    token: input.context.acceptedAsset as never,
    txWaitTimeoutSeconds: input.txWaitTimeoutSeconds,
    user: input.context.addresses.user,
  });
}

async function readUserPrivateBalance(context: ConnectedContext): Promise<bigint> {
  return toBigInt(
    await context.acceptedAsset.methods
      .balance_of_private(context.addresses.user)
      .simulate({ from: context.addresses.user }),
  );
}

function assertInteraction<TReceipt>(interaction: unknown): asserts interaction is {
  send(args: {
    fee: {
      gasSettings: unknown;
      paymentMethod: unknown;
    };
    from: unknown;
    wait: { timeout: number };
  }): Promise<TReceipt>;
} {
  if (
    !interaction ||
    typeof interaction !== "object" ||
    typeof (interaction as { send?: unknown }).send !== "function"
  ) {
    throw new SponsoredTxFailedError("buildCall must return an interaction with send(args).");
  }
}

async function sendSponsoredInteraction<TReceipt>(input: {
  interaction: {
    send(args: {
      fee: {
        gasSettings: unknown;
        paymentMethod: unknown;
      };
      from: unknown;
      wait: { timeout: number };
    }): Promise<TReceipt>;
  };
  maxFeesPerGas: GasFees;
  daGasLimit: number;
  l2GasLimit: number;
  paymentMethod: unknown;
  txWaitTimeoutSeconds: number;
  user: unknown;
}): Promise<TReceipt> {
  const gasLimits = new Gas(input.daGasLimit, input.l2GasLimit);
  const teardownGasLimits = new Gas(0, 0);

  try {
    return await input.interaction.send({
      fee: {
        gasSettings: { gasLimits, maxFeesPerGas: input.maxFeesPerGas, teardownGasLimits },
        paymentMethod: input.paymentMethod,
      },
      from: input.user,
      wait: { timeout: input.txWaitTimeoutSeconds },
    });
  } catch (error) {
    throw new SponsoredTxFailedError("Sponsored transaction submission failed.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function assertDebitInvariant(input: {
  expectedCharge: bigint;
  operator: { toString(): string };
  user: { toString(): string };
  userDebited: bigint;
}): void {
  if (!sameAddress(input.user, input.operator) && input.userDebited !== input.expectedCharge) {
    throw new SponsoredTxFailedError("Accounting invariant failed.", {
      expectedCharge: input.expectedCharge.toString(),
      userDebited: input.userDebited.toString(),
    });
  }
}

async function runPostChecksIfProvided<TReceipt>(input: {
  expectedCharge: bigint;
  fjAmount: bigint;
  postChecks: ExecuteSponsoredCallInput<TReceipt>["postChecks"];
  receipt: TReceipt;
  user: ConnectedContext["addresses"]["user"];
  userDebited: bigint;
}): Promise<void> {
  if (!input.postChecks) {
    return;
  }
  try {
    await input.postChecks({
      expectedCharge: input.expectedCharge,
      fjAmount: input.fjAmount,
      receipt: input.receipt,
      user: input.user,
      userDebited: input.userDebited,
    });
  } catch (error) {
    throw new SponsoredTxFailedError("Sponsored post-check failed.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function executeSponsoredCall<TReceipt>(
  input: ExecuteSponsoredCallInput<TReceipt>,
): Promise<SponsoredExecutionResult<TReceipt>> {
  try {
    const sponsorship = input.sponsorship;
    const defaults = resolveExecutionDefaults(sponsorship);
    const { acceptedAssetAddress, context } = await resolveConnectedContext({
      account: input.account,
      sponsorship,
      wallet: input.wallet,
    });
    const { fjAmount, minFees } = await computeFeeJuiceAndMinFees({
      context,
      daGasLimit: defaults.daGasLimit,
      l2GasLimit: defaults.l2GasLimit,
    });

    const quote = await fetchAndValidateQuote({
      acceptedAsset: acceptedAssetAddress,
      attestationBaseUrl: sponsorship.attestationBaseUrl,
      fetchImpl: sponsorship.fetchImpl,
      fjAmount,
      user: context.addresses.user,
    });

    await bootstrapIfNeeded({
      context,
      maxFaucetAttempts: defaults.maxFaucetAttempts,
      minimumPrivateBalanceBuffer: defaults.minimumPrivateBalanceBuffer,
      quoteAaPaymentAmount: quote.aaPaymentAmount,
      txWaitTimeoutSeconds: defaults.txWaitTimeoutSeconds,
    });
    const userPrivateBefore = await readUserPrivateBalance(context);

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

    const maybeInteraction = await input.buildCall({
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
    assertInteraction<TReceipt>(maybeInteraction);
    const maxFeesPerGas = new GasFees(minFees.feePerDaGas, minFees.feePerL2Gas);

    const receipt = await sendSponsoredInteraction({
      interaction: maybeInteraction,
      maxFeesPerGas,
      daGasLimit: defaults.daGasLimit,
      l2GasLimit: defaults.l2GasLimit,
      paymentMethod,
      txWaitTimeoutSeconds: defaults.txWaitTimeoutSeconds,
      user: context.addresses.user,
    });
    const userPrivateAfter = await readUserPrivateBalance(context);
    const userDebited = userPrivateBefore - userPrivateAfter;

    assertDebitInvariant({
      expectedCharge: quote.aaPaymentAmount,
      operator: context.addresses.operator,
      user: context.addresses.user,
      userDebited,
    });
    await runPostChecksIfProvided({
      expectedCharge: quote.aaPaymentAmount,
      fjAmount,
      postChecks: input.postChecks,
      receipt,
      user: context.addresses.user,
      userDebited,
    });

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

export function createSponsoredCounterClient(
  input: CreateSponsoredCounterClientInput,
): Promise<SponsoredCounterClient> {
  return Promise.resolve({
    async increment() {
      try {
        let counter: CounterContractLike | undefined;
        let counterBefore: bigint | undefined;
        let counterAfter: bigint | undefined;

        const execution = await executeSponsoredCall<CounterReceipt>({
          account: input.account,
          buildCall: async (ctx) => {
            counter = asCounterContract(ctx.contracts.targets.counter);
            counterBefore = toBigInt(
              await counter.methods.get_counter(ctx.user).simulate({ from: ctx.user }),
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
              await counter.methods.get_counter(ctx.user).simulate({ from: ctx.user }),
            );
            if (counterAfter !== counterBefore + 1n) {
              throw new SponsoredTxFailedError("Counter increment invariant failed.", {
                counterAfter: counterAfter.toString(),
                counterBefore: counterBefore.toString(),
              });
            }
          },
          sponsorship: {
            attestationBaseUrl: SDK_DEFAULTS.attestationBaseUrl,
            daGasLimit: SDK_DEFAULTS.daGasLimit,
            l2GasLimit: SDK_DEFAULTS.l2GasLimit,
            maxFaucetAttempts: SDK_DEFAULTS.maxFaucetAttempts,
            minimumPrivateBalanceBuffer: SDK_DEFAULTS.minimumPrivateBalanceBuffer,
            runtimeConfig: createDevnetRuntimeConfig(),
            txWaitTimeoutSeconds: SDK_DEFAULTS.txWaitTimeoutSeconds,
          },
          wallet: input.wallet,
        });

        if (counterBefore === undefined || counterAfter === undefined) {
          throw new SponsoredTxFailedError("Counter state was not captured by wrapper flow.");
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
        throw new SponsoredTxFailedError("Failed to execute sponsored increment.", {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
}

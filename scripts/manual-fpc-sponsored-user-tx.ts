import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";

const pinoLogger = pino();

import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import type { ContractArtifact } from "@aztec/aztec.js/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { ProtocolContractAddress } from "@aztec/aztec.js/protocol";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { loadContractArtifact, loadContractArtifactForPublic } from "@aztec/stdlib/abi";
import { Gas, GasFees } from "@aztec/stdlib/gas";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
import { ExecutionPayload } from "@aztec/stdlib/tx";
import { EmbeddedWallet } from "@aztec/wallets/embedded";

/**
 * This script executes one manually-constructed sponsored transaction using this
 * repo's custom FPC contract:
 *
 * 1) Reads deployed addresses from configs/deploy-manifest.json.
 * 2) Fetches a quote from the attestation service.
 * 3) Creates a token transfer authwit for FPC.fee_entrypoint(...).
 * 4) Builds a custom payment method payload (ExecutionPayload).
 * 5) Sends a normal user call (Counter.increment) with the FPC payment payload
 *    attached.
 *
 * Why this script exists:
 * - aztec-wallet's built-in `--payment method=fpc-private|fpc-public` targets
 *   a canonical paymaster ABI (fee_entrypoint_private/public).
 * - this repo's FPC uses FPCMultiAsset.fee_entrypoint(...) with quote fields,
 *   so we need manual payload construction.
 *
 * Optional mode:
 * - `--deploy-counter-only` deploys the mock counter and exits, printing:
 *   `counter=<address>`
 */

type QuoteResponse = {
  accepted_asset: string;
  fj_amount: string;
  aa_payment_amount: string;
  valid_until: string;
  signature: string;
};

type Config = {
  nodeUrl: string;
  quoteBaseUrl: string;
  manifestPath: string;
  tokenArtifactPath: string;
  fpcArtifactPath: string;
  counterArtifactPath: string;
  mockCounterAddress?: string;
  ephemeralWallet: boolean;
  daGasLimit: number;
  l2GasLimit: number;
  feeJuiceWaitMs: number;
  feeJuicePollMs: number;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function readConfig(): Config {
  const ephemeralWallet = process.env.EMBEDDED_WALLET_EPHEMERAL !== "0";
  return {
    nodeUrl: process.env.AZTEC_NODE_URL ?? "http://localhost:8080",
    quoteBaseUrl: process.env.QUOTE_BASE_URL ?? "http://localhost:3000",
    manifestPath: process.env.MANIFEST_PATH ?? path.join(repoRoot, "deployments", "manifest.json"),
    tokenArtifactPath:
      process.env.TOKEN_ARTIFACT_PATH ?? path.join(repoRoot, "target", "token_contract-Token.json"),
    fpcArtifactPath:
      process.env.FPC_ARTIFACT_PATH ?? path.join(repoRoot, "target", "fpc-FPCMultiAsset.json"),
    counterArtifactPath:
      process.env.COUNTER_ARTIFACT_PATH ??
      path.join(repoRoot, "target", "mock_counter-Counter.json"),
    mockCounterAddress: process.env.MOCK_COUNTER_ADDRESS,
    ephemeralWallet,
    daGasLimit: Number(process.env.DA_GAS_LIMIT ?? "200000"),
    l2GasLimit: Number(process.env.L2_GAS_LIMIT ?? "1000000"),
    feeJuiceWaitMs: Number(process.env.FEE_JUICE_WAIT_MS ?? "120000"),
    feeJuicePollMs: Number(process.env.FEE_JUICE_POLL_MS ?? "2000"),
  };
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`${name} must be a positive integer. Got: ${value}`);
  }
}

function loadArtifact(artifactPath: string): ContractArtifact {
  const parsed = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as NoirCompiledContract;
  try {
    return loadContractArtifact(parsed);
  } catch (err) {
    // Local builds may contain public bytecode that requires this fallback.
    if (
      err instanceof Error &&
      err.message.includes("Contract's public bytecode has not been transpiled")
    ) {
      return loadContractArtifactForPublic(parsed);
    }
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFeeJuice(
  fpcAddress: AztecAddress,
  node: ReturnType<typeof createAztecNodeClient>,
  waitMs: number,
  pollMs: number,
  minimumBalance: bigint,
): Promise<bigint> {
  const deadline = Date.now() + waitMs;
  let balance = await getFeeJuiceBalance(fpcAddress, node);

  while (balance < minimumBalance && Date.now() < deadline) {
    await sleep(pollMs);
    balance = await getFeeJuiceBalance(fpcAddress, node);
  }
  return balance;
}

async function fetchQuote(
  quoteBaseUrl: string,
  user: AztecAddress,
  acceptedAsset: AztecAddress,
  fjAmount: bigint,
): Promise<QuoteResponse> {
  const quoteUrl = new URL(`${quoteBaseUrl}/quote`);
  quoteUrl.searchParams.set("user", user.toString());
  quoteUrl.searchParams.set("accepted_asset", acceptedAsset.toString());
  quoteUrl.searchParams.set("fj_amount", fjAmount.toString());

  const res = await fetch(quoteUrl.toString());
  if (!res.ok) {
    const body = await res.text();
    if (body.includes("Unsupported accepted_asset")) {
      throw new Error(
        `Quote request failed (${res.status}): attestation accepted_asset is out of sync with manifest token ${acceptedAsset.toString()}. Recreate deploy+attestation+topup together and retry. Raw: ${body}`,
      );
    }
    throw new Error(`Quote request failed (${res.status}): ${body}`);
  }
  return (await res.json()) as QuoteResponse;
}

async function attachRegisteredContract(
  wallet: EmbeddedWallet,
  node: ReturnType<typeof createAztecNodeClient>,
  address: AztecAddress,
  artifact: ContractArtifact,
  label: string,
): Promise<Contract> {
  const instance = await node.getContract(address);
  if (!instance) {
    throw new Error(`Missing ${label} contract instance on node at ${address.toString()}`);
  }
  await wallet.registerContract(instance, artifact);
  return Contract.at(address, artifact, wallet);
}

async function main() {
  const deployCounterOnly = process.argv.slice(2).includes("--deploy-counter-only");
  const cfg = readConfig();
  assertPositiveInt("DA_GAS_LIMIT", cfg.daGasLimit);
  assertPositiveInt("L2_GAS_LIMIT", cfg.l2GasLimit);
  assertPositiveInt("FEE_JUICE_WAIT_MS", cfg.feeJuiceWaitMs);
  assertPositiveInt("FEE_JUICE_POLL_MS", cfg.feeJuicePollMs);
  // Step 0: load deployment addresses + artifacts produced by local deploy.
  const manifest = JSON.parse(fs.readFileSync(cfg.manifestPath, "utf8")) as {
    contracts: { fpc: string; accepted_asset: string };
    operator: { address: string };
  };
  const fpcAddress = AztecAddress.fromString(manifest.contracts.fpc);
  const tokenAddress = AztecAddress.fromString(manifest.contracts.accepted_asset);
  const operatorFromManifest = AztecAddress.fromString(manifest.operator.address);

  const tokenArtifact = loadArtifact(cfg.tokenArtifactPath);
  const fpcArtifact = loadArtifact(cfg.fpcArtifactPath);
  const counterArtifact = loadArtifact(cfg.counterArtifactPath);

  // Step 1: connect wallet and derive local test accounts (operator/user).
  const node = createAztecNodeClient(cfg.nodeUrl);
  await waitForNode(node);
  // Use ephemeral wallet/PXE stores by default to avoid stale anchor hashes
  // when local-network has been restarted or re-initialized between runs.
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: cfg.ephemeralWallet,
  });

  const testAccounts = await getInitialTestAccountsData();
  const [operator, user] = await Promise.all(
    testAccounts.slice(0, 2).map(async (account) => {
      return (await wallet.createSchnorrAccount(account.secret, account.salt, account.signingKey))
        .address;
    }),
  );
  if (!operator.equals(operatorFromManifest)) {
    throw new Error(`Operator mismatch. manifest=${operatorFromManifest} wallet=${operator}`);
  }

  const token = await attachRegisteredContract(
    wallet,
    node,
    tokenAddress,
    tokenArtifact,
    "accepted_asset",
  );
  const fpc = await attachRegisteredContract(wallet, node, fpcAddress, fpcArtifact, "fpc");
  let counter: Contract;
  if (cfg.mockCounterAddress && cfg.mockCounterAddress.length > 0) {
    counter = await attachRegisteredContract(
      wallet,
      node,
      AztecAddress.fromString(cfg.mockCounterAddress),
      counterArtifact,
      "mock_counter",
    );
  } else {
    // Deploy Counter.initialize(headstart=0, owner=user) for this manual run.
    ({ contract: counter } = await Contract.deploy(
      wallet,
      counterArtifact,
      [0n, user],
      "initialize",
    ).send({
      from: user,
    }));
  }
  pinoLogger.info(`counter=${counter.address.toString()}`);
  if (deployCounterOnly) {
    return;
  }

  // Step 2: compute fj_amount that must match get_max_gas_cost_no_teardown(...)
  // in FPC.fee_entrypoint. We use node min fees and explicit gas limits.
  const minFees = await node.getCurrentMinFees();
  const feePerDaGas = minFees.feePerDaGas;
  const feePerL2Gas = minFees.feePerL2Gas;
  const fjAmount = BigInt(cfg.daGasLimit) * feePerDaGas + BigInt(cfg.l2GasLimit) * feePerL2Gas;

  // Step 3: ensure FPC has Fee Juice to sponsor this tx.
  const fpcFeeJuiceBalance = await waitForFeeJuice(
    fpcAddress,
    node,
    cfg.feeJuiceWaitMs,
    cfg.feeJuicePollMs,
    fjAmount,
  );
  if (fpcFeeJuiceBalance < fjAmount) {
    throw new Error(
      `FPC Fee Juice balance ${fpcFeeJuiceBalance} is below required ${fjAmount} at ${fpcAddress}. Increase topup amount and retry.`,
    );
  }

  // Step 4: request quote from attestation service. This gives us:
  // - aa_payment_amount (token charge),
  // - valid_until,
  // - signature bound to (user, asset, fj_amount, aa_payment_amount, valid_until).
  const quote = await fetchQuote(cfg.quoteBaseUrl, user, tokenAddress, fjAmount);
  pinoLogger.info(`[manual-fpc] attestation_quote_response=${JSON.stringify(quote)}`);
  const aaPaymentAmount = BigInt(quote.aa_payment_amount);
  const quoteSigBytes = Array.from(Buffer.from(quote.signature.replace(/^0x/, ""), "hex"));

  // Step 5: fund user with:
  // - private token notes for FPC payment transfer.
  // The app call is Counter.increment (private), so no public token balance is needed.
  await token.methods.mint_to_private(user, aaPaymentAmount + 1_000_000n).send({ from: operator });

  // Step 6: create authwit that authorizes FPC to call
  // Token.transfer_private_to_private(user -> operator, aa_payment_amount, nonce).
  const nonce = Fr.random();
  const transferCall = await token.methods
    .transfer_private_to_private(user, operator, aaPaymentAmount, nonce)
    .getFunctionCall();
  const transferAuthwit = await wallet.createAuthWit(user, {
    caller: fpcAddress,
    call: transferCall,
  });

  // Record balances before tx so we can prove token accounting after.
  const { result: userPrivateBeforeRaw } = await token.methods
    .balance_of_private(user)
    .simulate({ from: user });
  const userPrivateBefore = BigInt(userPrivateBeforeRaw.toString());
  const { result: operatorPrivateBeforeRaw } = await token.methods
    .balance_of_private(operator)
    .simulate({ from: operator });
  const operatorPrivateBefore = BigInt(operatorPrivateBeforeRaw.toString());

  // Step 7: build the FPC fee payload manually.
  // This is the critical piece that substitutes for a generic paymaster method.
  const feeEntrypointCall = await fpc.methods
    .fee_entrypoint(
      tokenAddress,
      nonce,
      BigInt(quote.fj_amount),
      aaPaymentAmount,
      BigInt(quote.valid_until),
      quoteSigBytes,
    )
    .getFunctionCall();

  const paymentMethod = {
    getAsset: async () => ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new ExecutionPayload([feeEntrypointCall], [transferAuthwit], [], [], fpcAddress),
    getFeePayer: async () => fpcAddress,
    getGasSettings: () => undefined,
  };
  const gasLimits = new Gas(cfg.daGasLimit, cfg.l2GasLimit);
  const teardownGasLimits = new Gas(0, 0);
  const maxFeesPerGas = new GasFees(feePerDaGas, feePerL2Gas);
  const txPayloadPreview = {
    app_call: {
      contract: counter.address.toString(),
      function: "increment",
      args: [user.toString()],
    },
    fee: {
      fee_payer: fpcAddress.toString(),
      asset: ProtocolContractAddress.FeeJuice.toString(),
      gas_settings: {
        gas_limits: {
          da: cfg.daGasLimit,
          l2: cfg.l2GasLimit,
        },
        teardown_gas_limits: {
          da: 0,
          l2: 0,
        },
        max_fees_per_gas: {
          da: feePerDaGas.toString(),
          l2: feePerL2Gas.toString(),
        },
      },
      fee_entrypoint_args: {
        accepted_asset: tokenAddress.toString(),
        nonce: nonce.toString(),
        fj_amount: quote.fj_amount,
        aa_payment_amount: aaPaymentAmount.toString(),
        valid_until: quote.valid_until,
        signature: quote.signature,
        signature_num_bytes: quoteSigBytes.length,
      },
      authwit_transfer: {
        token: tokenAddress.toString(),
        from: user.toString(),
        to: operator.toString(),
        amount: aaPaymentAmount.toString(),
        nonce: nonce.toString(),
      },
    },
  };
  pinoLogger.info(`[manual-fpc] tx_payload_preview=${JSON.stringify(txPayloadPreview)}`);

  // Step 8: send a normal user call `y.x()` while attaching the FPC payment
  // payload. Here y = Counter and x = increment(owner).
  const { result: counterBeforeRaw } = await counter.methods
    .get_counter(user)
    .simulate({ from: user });
  const counterBefore = BigInt(counterBeforeRaw.toString());
  const { receipt } = await counter.methods.increment(user).send({
    from: user,
    fee: {
      paymentMethod,
      gasSettings: { gasLimits, teardownGasLimits, maxFeesPerGas },
    },
    wait: { timeout: 180 },
  });
  const { result: counterAfterRaw } = await counter.methods
    .get_counter(user)
    .simulate({ from: user });
  const counterAfter = BigInt(counterAfterRaw.toString());

  // Step 9: verify accounting and print a concise summary.
  const { result: userPrivateAfterRaw } = await token.methods
    .balance_of_private(user)
    .simulate({ from: user });
  const userPrivateAfter = BigInt(userPrivateAfterRaw.toString());
  const { result: operatorPrivateAfterRaw } = await token.methods
    .balance_of_private(operator)
    .simulate({ from: operator });
  const operatorPrivateAfter = BigInt(operatorPrivateAfterRaw.toString());

  const userDebited = userPrivateBefore - userPrivateAfter;
  const operatorCredited = operatorPrivateAfter - operatorPrivateBefore;

  pinoLogger.info(`operator=${operator}`);
  pinoLogger.info(`user=${user}`);
  pinoLogger.info(`token=${tokenAddress}`);
  pinoLogger.info(`fpc=${fpcAddress}`);
  pinoLogger.info(`tx_hash=${receipt.txHash.toString()}`);
  pinoLogger.info(`tx_fee_juice=${receipt.transactionFee}`);
  pinoLogger.info(`expected_charge=${aaPaymentAmount}`);
  pinoLogger.info(`user_debited=${userDebited}`);
  pinoLogger.info(`operator_credited=${operatorCredited}`);
  pinoLogger.info(`counter_before=${counterBefore}`);
  pinoLogger.info(`counter_after=${counterAfter}`);
  pinoLogger.info("PASS: sponsored Counter.increment tx via FPCMultiAsset fee_entrypoint");

  if (userDebited !== aaPaymentAmount || operatorCredited !== aaPaymentAmount) {
    throw new Error(
      `Accounting mismatch. expected=${aaPaymentAmount} user_debited=${userDebited} operator_credited=${operatorCredited}`,
    );
  }
  if (counterAfter !== counterBefore + 1n) {
    throw new Error(
      `Counter mismatch. expected_after=${counterBefore + 1n} actual_after=${counterAfter}`,
    );
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("not found when querying world state")) {
    pinoLogger.error(
      "HINT: stale embedded wallet state detected. Rerun with default ephemeral mode (EMBEDDED_WALLET_EPHEMERAL unset) or clear local pxe_data_*/wallet_data_* directories.",
    );
  }
  pinoLogger.error(`FAIL: ${message}`);
  process.exit(1);
});

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import type { ContractArtifact } from "@aztec/aztec.js/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { ProtocolContractAddress } from "@aztec/aztec.js/protocol";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import {
  loadContractArtifact,
  loadContractArtifactForPublic,
} from "@aztec/stdlib/abi";
import { Gas, GasFees } from "@aztec/stdlib/gas";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
import { ExecutionPayload } from "@aztec/stdlib/tx";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { advanceLocalNetworkBlocks } from "./advance-local-network-blocks.ts";

/**
 * This script executes one manually-constructed sponsored transaction using this
 * repo's CreditFPC contract:
 *
 * 1) Reads deployed addresses from configs/deploy-manifest.json.
 * 2) Fetches a quote from the attestation service.
 * 3) Creates a token transfer authwit for CreditFPC.pay_and_mint(...).
 * 4) Builds a custom payment method payload (ExecutionPayload).
 * 5) Sends a normal user call (Counter.increment) with the CreditFPC payment
 *    payload attached.
 *
 * Why this script exists:
 * - aztec-wallet's built-in `--payment method=fpc-private|fpc-public` targets
 *   a canonical paymaster ABI (fee_entrypoint_private/public).
 * - this repo's CreditFPC uses BackedCreditFPC.pay_and_mint(...) with quote
 *   fields and private credit minting, so we need manual payload construction.
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
  creditFpcArtifactPath: string;
  counterArtifactPath: string;
  topupCreditConfigPath: string;
  attestationCreditConfigPath: string;
  skipServiceConfigChecks: boolean;
  mockCounterAddress?: string;
  ephemeralWallet: boolean;
  relayAdvanceBlocks: number;
  relayAdvanceEveryPolls: number;
  daGasLimit: number;
  l2GasLimit: number;
  creditMintMultiplier: bigint;
  creditMintBuffer: bigint;
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
    quoteBaseUrl: process.env.QUOTE_BASE_URL ?? "http://localhost:3002",
    manifestPath:
      process.env.MANIFEST_PATH ??
      path.join(repoRoot, "configs", "deploy-manifest.json"),
    tokenArtifactPath:
      process.env.TOKEN_ARTIFACT_PATH ??
      path.join(repoRoot, "target", "token_contract-Token.json"),
    creditFpcArtifactPath:
      process.env.CREDIT_FPC_ARTIFACT_PATH ??
      path.join(repoRoot, "target", "credit_fpc-BackedCreditFPC.json"),
    counterArtifactPath:
      process.env.COUNTER_ARTIFACT_PATH ??
      path.join(repoRoot, "target", "mock_counter-Counter.json"),
    topupCreditConfigPath:
      process.env.TOPUP_CREDIT_CONFIG_PATH ??
      path.join(repoRoot, "configs", "topup-credit", "config.yaml"),
    attestationCreditConfigPath:
      process.env.ATTESTATION_CREDIT_CONFIG_PATH ??
      path.join(repoRoot, "configs", "attestation-credit", "config.yaml"),
    skipServiceConfigChecks: process.env.SKIP_SERVICE_CONFIG_CHECKS === "1",
    mockCounterAddress: process.env.MOCK_COUNTER_ADDRESS,
    ephemeralWallet,
    relayAdvanceBlocks: Number(process.env.RELAY_ADVANCE_BLOCKS ?? "2"),
    relayAdvanceEveryPolls: Number(
      process.env.RELAY_ADVANCE_EVERY_POLLS ?? "5",
    ),
    daGasLimit: Number(process.env.DA_GAS_LIMIT ?? "1000000"),
    l2GasLimit: Number(process.env.L2_GAS_LIMIT ?? "1000000"),
    creditMintMultiplier: BigInt(process.env.CREDIT_MINT_MULTIPLIER ?? "2"),
    creditMintBuffer: BigInt(process.env.CREDIT_MINT_BUFFER ?? "1000000"),
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
  const parsed = JSON.parse(
    fs.readFileSync(artifactPath, "utf8"),
  ) as NoirCompiledContract;
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

function readYamlStringField(
  filePath: string,
  key: string,
): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const contents = fs.readFileSync(filePath, "utf8");
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = contents.match(
    new RegExp(
      `^\\s*${escapedKey}:\\s*(?:"([^"]+)"|'([^']+)'|([^#\\s]+))\\s*(?:#.*)?$`,
      "m",
    ),
  );
  return match ? (match[1] ?? match[2] ?? match[3])?.trim() : undefined;
}

function assertConfigAddressMatches(
  configPath: string,
  key: string,
  expected: AztecAddress,
  serviceLabel: string,
): void {
  if (!fs.existsSync(configPath)) {
    return;
  }
  const value = readYamlStringField(configPath, key);
  if (!value) {
    throw new Error(
      `${serviceLabel} config missing ${key} at ${configPath}. Regenerate configs via \`bash scripts/config/generate-service-configs.sh\` and restart the service.`,
    );
  }
  let configuredAddress: AztecAddress;
  try {
    configuredAddress = AztecAddress.fromString(value);
  } catch (error) {
    throw new Error(
      `${serviceLabel} config has invalid ${key}=${value} at ${configPath}: ${String(error)}`,
    );
  }
  if (!configuredAddress.equals(expected)) {
    throw new Error(
      `${serviceLabel} config mismatch at ${configPath}: ${key}=${configuredAddress.toString()} but manifest expects ${expected.toString()}. Regenerate configs via \`bash scripts/config/generate-service-configs.sh\` and restart the service.`,
    );
  }
}

function assertCreditServiceConfigAlignment(
  cfg: Config,
  creditFpcAddress: AztecAddress,
  tokenAddress: AztecAddress,
): void {
  if (cfg.skipServiceConfigChecks) {
    return;
  }
  assertConfigAddressMatches(
    cfg.topupCreditConfigPath,
    "fpc_address",
    creditFpcAddress,
    "topup-credit",
  );
  assertConfigAddressMatches(
    cfg.attestationCreditConfigPath,
    "fpc_address",
    creditFpcAddress,
    "attestation-credit",
  );
  assertConfigAddressMatches(
    cfg.attestationCreditConfigPath,
    "accepted_asset_address",
    tokenAddress,
    "attestation-credit",
  );
}

async function waitForFeeJuice(
  feePayerAddress: AztecAddress,
  node: ReturnType<typeof createAztecNodeClient>,
  waitMs: number,
  pollMs: number,
  minimumBalance: bigint,
  onZeroBalancePoll?: (pollNumber: number) => Promise<void>,
  zeroBalancePollInterval = 1,
): Promise<bigint> {
  const deadline = Date.now() + waitMs;
  let balance = await getFeeJuiceBalance(feePayerAddress, node);
  let pollNumber = 0;

  // The topup service may still be bridging funds. Poll until fee balance
  // reaches the minimum required for this transaction's estimated max gas cost.
  while (balance < minimumBalance && Date.now() < deadline) {
    pollNumber += 1;
    if (
      onZeroBalancePoll &&
      zeroBalancePollInterval > 0 &&
      pollNumber % zeroBalancePollInterval === 0
    ) {
      await onZeroBalancePoll(pollNumber);
    }
    await sleep(pollMs);
    balance = await getFeeJuiceBalance(feePayerAddress, node);
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
    throw new Error(
      `Missing ${label} contract instance on node at ${address.toString()}`,
    );
  }
  await wallet.registerContract(instance, artifact);
  return Contract.at(address, artifact, wallet);
}

async function main() {
  const deployCounterOnly = process.argv
    .slice(2)
    .includes("--deploy-counter-only");
  const cfg = readConfig();
  assertPositiveInt("DA_GAS_LIMIT", cfg.daGasLimit);
  assertPositiveInt("L2_GAS_LIMIT", cfg.l2GasLimit);
  assertPositiveInt("FEE_JUICE_WAIT_MS", cfg.feeJuiceWaitMs);
  assertPositiveInt("FEE_JUICE_POLL_MS", cfg.feeJuicePollMs);
  if (cfg.creditMintMultiplier <= 1n) {
    throw new Error(
      `CREDIT_MINT_MULTIPLIER must be > 1. Got: ${cfg.creditMintMultiplier}`,
    );
  }
  if (cfg.creditMintBuffer <= 0n) {
    throw new Error(
      `CREDIT_MINT_BUFFER must be > 0. Got: ${cfg.creditMintBuffer}`,
    );
  }
  if (!Number.isInteger(cfg.relayAdvanceBlocks) || cfg.relayAdvanceBlocks < 0) {
    throw new Error(
      `RELAY_ADVANCE_BLOCKS must be an integer >= 0. Got: ${cfg.relayAdvanceBlocks}`,
    );
  }
  assertPositiveInt("RELAY_ADVANCE_EVERY_POLLS", cfg.relayAdvanceEveryPolls);

  // Step 0: load deployment addresses + artifacts produced by local deploy.
  const manifest = JSON.parse(fs.readFileSync(cfg.manifestPath, "utf8")) as {
    contracts: { fpc: string; credit_fpc?: string; accepted_asset: string };
    operator: { address: string };
    fpc_artifact?: { name?: string };
  };
  const creditFpcAddressRaw = manifest.contracts.credit_fpc;
  const deployedFpcArtifactName = manifest.fpc_artifact?.name ?? "";
  const manifestLooksCreditOnly =
    deployedFpcArtifactName === "CreditFPC" ||
    deployedFpcArtifactName === "BackedCreditFPC";
  if (!creditFpcAddressRaw && !manifestLooksCreditOnly) {
    throw new Error(
      `Manifest does not include contracts.credit_fpc. Run local deploy with FPC_VARIANT=both or credit, then retry. manifest=${cfg.manifestPath}`,
    );
  }
  const creditFpcAddress = AztecAddress.fromString(
    creditFpcAddressRaw ?? manifest.contracts.fpc,
  );
  const tokenAddress = AztecAddress.fromString(
    manifest.contracts.accepted_asset,
  );
  const operatorFromManifest = AztecAddress.fromString(
    manifest.operator.address,
  );
  assertCreditServiceConfigAlignment(cfg, creditFpcAddress, tokenAddress);

  const tokenArtifact = loadArtifact(cfg.tokenArtifactPath);
  const creditFpcArtifact = loadArtifact(cfg.creditFpcArtifactPath);
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
      return (
        await wallet.createSchnorrAccount(
          account.secret,
          account.salt,
          account.signingKey,
        )
      ).address;
    }),
  );
  if (!operator.equals(operatorFromManifest)) {
    throw new Error(
      `Operator mismatch. manifest=${operatorFromManifest} wallet=${operator}`,
    );
  }

  const token = await attachRegisteredContract(
    wallet,
    node,
    tokenAddress,
    tokenArtifact,
    "accepted_asset",
  );
  const creditFpc = await attachRegisteredContract(
    wallet,
    node,
    creditFpcAddress,
    creditFpcArtifact,
    "credit_fpc",
  );
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
    counter = await Contract.deploy(
      wallet,
      counterArtifact,
      [0n, user],
      "initialize",
    ).send({
      from: user,
    });
  }
  console.log(`counter=${counter.address.toString()}`);
  if (deployCounterOnly) {
    return;
  }

  // Step 2: compute a quoted credit amount for pay_and_mint.
  // CreditFPC now requires net minted credit (> 0), so requesting exactly
  // max_gas_cost causes net_credit=0 and reverts during finalization.
  const minFees = await node.getCurrentMinFees();
  const feePerDaGas = minFees.feePerDaGas;
  const feePerL2Gas = minFees.feePerL2Gas;
  const minFjCreditAmount =
    BigInt(cfg.daGasLimit) * feePerDaGas + BigInt(cfg.l2GasLimit) * feePerL2Gas;
  const requestedFjCreditAmount =
    minFjCreditAmount * cfg.creditMintMultiplier + cfg.creditMintBuffer;

  // Step 3: ensure CreditFPC has Fee Juice to sponsor this tx.
  // Local-network often needs tx activity to progress relay state, so while the
  // balance is still zero we periodically force a small number of extra blocks.
  const onZeroFeeJuicePoll =
    cfg.relayAdvanceBlocks > 0
      ? async (pollNumber: number) => {
          console.log(
            `[manual-credit-fpc] fee_juice_zero poll=${pollNumber}; advancing ${cfg.relayAdvanceBlocks} local block(s)`,
          );
          await advanceLocalNetworkBlocks(
            token,
            operator,
            user,
            cfg.relayAdvanceBlocks,
            "[manual-credit-fpc:block-advance]",
          );
        }
      : undefined;

  const creditFpcFeeJuiceBalance = await waitForFeeJuice(
    creditFpcAddress,
    node,
    cfg.feeJuiceWaitMs,
    cfg.feeJuicePollMs,
    requestedFjCreditAmount,
    onZeroFeeJuicePoll,
    cfg.relayAdvanceEveryPolls,
  );
  if (creditFpcFeeJuiceBalance < requestedFjCreditAmount) {
    throw new Error(
      `CreditFPC Fee Juice balance ${creditFpcFeeJuiceBalance} is below required ${requestedFjCreditAmount} at ${creditFpcAddress}. Ensure topup-credit is configured for this CreditFPC and auto-claim has completed, then retry.`,
    );
  }

  // Step 4: request quote from attestation service. This gives us:
  // - aa_payment_amount (token charge),
  // - valid_until,
  // - signature bound to (user, asset, fj_amount, aa_payment_amount, valid_until).
  const quote = await fetchQuote(
    cfg.quoteBaseUrl,
    user,
    tokenAddress,
    requestedFjCreditAmount,
  );
  console.log(
    `[manual-credit-fpc] attestation_quote_response=${JSON.stringify(quote)}`,
  );
  if (BigInt(quote.fj_amount) !== requestedFjCreditAmount) {
    throw new Error(
      `Quote fj_amount mismatch. requested=${requestedFjCreditAmount} quote=${quote.fj_amount}`,
    );
  }
  const quotedFjCreditAmount = BigInt(quote.fj_amount);
  const aaPaymentAmount = BigInt(quote.aa_payment_amount);
  const quoteSigBytes = Array.from(
    Buffer.from(quote.signature.replace(/^0x/, ""), "hex"),
  );

  // Step 5: fund user with:
  // - private token notes for CreditFPC payment transfer.
  // The app call is Counter.increment (private), so no public token balance is needed.
  await token.methods
    .mint_to_private(user, aaPaymentAmount + 1_000_000n)
    .send({ from: operator });

  // Step 6: create authwit that authorizes CreditFPC to call
  // Token.transfer_private_to_private(user -> operator, aa_payment_amount, nonce).
  const nonce = Fr.random();
  const transferCall = await token.methods
    .transfer_private_to_private(user, operator, aaPaymentAmount, nonce)
    .getFunctionCall();
  const transferAuthwit = await wallet.createAuthWit(user, {
    caller: creditFpcAddress,
    call: transferCall,
  });

  // Record balances before tx so we can prove token accounting after.
  const userPrivateBefore = BigInt(
    (
      await token.methods.balance_of_private(user).simulate({ from: user })
    ).toString(),
  );
  const operatorPrivateBefore = BigInt(
    (
      await token.methods
        .balance_of_private(operator)
        .simulate({ from: operator })
    ).toString(),
  );

  // Step 7: build the CreditFPC fee payload manually.
  // This is the critical piece that substitutes for a generic paymaster method.
  const payAndMintCall = await creditFpc.methods
    .pay_and_mint(
      tokenAddress,
      nonce,
      quotedFjCreditAmount,
      aaPaymentAmount,
      BigInt(quote.valid_until),
      quoteSigBytes,
    )
    .getFunctionCall();

  const paymentMethod = {
    getAsset: async () => ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new ExecutionPayload(
        [payAndMintCall],
        [transferAuthwit],
        [],
        [],
        creditFpcAddress,
      ),
    getFeePayer: async () => creditFpcAddress,
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
      fee_payer: creditFpcAddress.toString(),
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
      pay_and_mint_args: {
        accepted_asset: tokenAddress.toString(),
        nonce: nonce.toString(),
        fj_credit_amount: quotedFjCreditAmount.toString(),
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
  console.log(
    `[manual-credit-fpc] tx_payload_preview=${JSON.stringify(txPayloadPreview)}`,
  );

  // Step 8: send a normal user call `y.x()` while attaching the CreditFPC payment
  // payload. Here y = Counter and x = increment(owner).
  const counterBefore = BigInt(
    (
      await counter.methods.get_counter(user).simulate({ from: user })
    ).toString(),
  );
  const receipt = await counter.methods.increment(user).send({
    from: user,
    fee: {
      paymentMethod,
      gasSettings: { gasLimits, teardownGasLimits, maxFeesPerGas },
    },
    wait: { timeout: 180 },
  });
  const counterAfter = BigInt(
    (
      await counter.methods.get_counter(user).simulate({ from: user })
    ).toString(),
  );

  // Step 9: verify accounting and print a concise summary.
  const userPrivateAfter = BigInt(
    (
      await token.methods.balance_of_private(user).simulate({ from: user })
    ).toString(),
  );
  const operatorPrivateAfter = BigInt(
    (
      await token.methods
        .balance_of_private(operator)
        .simulate({ from: operator })
    ).toString(),
  );

  const userDebited = userPrivateBefore - userPrivateAfter;
  const operatorCredited = operatorPrivateAfter - operatorPrivateBefore;
  const creditBalanceAfter = BigInt(
    (
      await creditFpc.methods.balance_of(user).simulate({ from: user })
    ).toString(),
  );

  console.log(`operator=${operator}`);
  console.log(`user=${user}`);
  console.log(`token=${tokenAddress}`);
  console.log(`credit_fpc=${creditFpcAddress}`);
  console.log(`tx_hash=${receipt.txHash.toString()}`);
  console.log(`tx_fee_juice=${receipt.transactionFee}`);
  console.log(`expected_charge=${aaPaymentAmount}`);
  console.log(`user_debited=${userDebited}`);
  console.log(`operator_credited=${operatorCredited}`);
  console.log(`credit_balance_after=${creditBalanceAfter}`);
  console.log(`counter_before=${counterBefore}`);
  console.log(`counter_after=${counterAfter}`);
  console.log(
    "PASS: sponsored Counter.increment tx via CreditFPC pay_and_mint",
  );

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
    console.error(
      "HINT: stale embedded wallet state detected. Rerun with default ephemeral mode (EMBEDDED_WALLET_EPHEMERAL unset) or clear local pxe_data_*/wallet_data_* directories.",
    );
  }
  console.error(`FAIL: ${message}`);
  process.exit(1);
});

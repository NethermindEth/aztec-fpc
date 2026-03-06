import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";

const pinoLogger = pino();

import type { ContractArtifact } from "@aztec/aztec.js/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { ProtocolContractAddress } from "@aztec/aztec.js/protocol";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { loadContractArtifact, loadContractArtifactForPublic } from "@aztec/stdlib/abi";
import { Gas, GasFees } from "@aztec/stdlib/gas";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
import { ExecutionPayload } from "@aztec/stdlib/tx";
import { EmbeddedWallet } from "@aztec/wallets/embedded";

type QuoteResponse = {
  accepted_asset: string;
  fj_amount: string;
  aa_payment_amount: string;
  valid_until: string;
  signature: string;
};

type Config = {
  envFilePath: string;
  nodeUrl: string;
  quoteBaseUrl: string;
  manifestPath: string;
  tokenArtifactPath: string;
  fpcArtifactPath: string;
  faucetArtifactPath: string;
  counterArtifactPath: string;
  counterAddress: string | null;
  operatorSecretKey: string;
  userSecretKey: string;
  operatorSalt: string;
  userSalt: string;
  ephemeralWallet: boolean;
  daGasLimit: number;
  l2GasLimit: number;
  feeJuiceWaitMs: number;
  feeJuicePollMs: number;
};

type Manifest = {
  network?: {
    node_url?: string;
  };
  contracts?: {
    fpc?: string;
    accepted_asset?: string;
    faucet?: string;
    counter?: string;
  };
  operator?: {
    address?: string;
  };
  deployment_accounts?: {
    l2_deployer?: {
      private_key?: string;
    };
  };
};

const HEX_32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const UINT_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const ZERO_SALT_HEX = "0x0000000000000000000000000000000000000000000000000000000000000000";

function usage(): string {
  return [
    "Usage:",
    "  bunx tsx scripts/manual-fpc-sponsored-user-tx-devnet.ts \\",
    "    [--env-file <path>] \\",
    "    [--manifest <path>] \\",
    "    [--node-url <url>] \\",
    "    [--quote-base-url <url>] \\",
    "    [--counter-address <aztec_address>] \\",
    "    [--operator-secret-key <hex32>] \\",
    "    [--user-secret-key <hex32>] \\",
    "    [--operator-salt <hex32>] \\",
    "    [--user-salt <hex32>] \\",
    "    [--da-gas-limit <uint>] \\",
    "    [--l2-gas-limit <uint>] \\",
    "    [--fee-juice-wait-ms <uint>] \\",
    "    [--fee-juice-poll-ms <uint>]",
    "",
    "Defaults:",
    "  --env-file ./.env",
    "  --manifest ./deployments/devnet-manifest-v2.json",
    "  --node-url from AZTEC_NODE_URL or manifest.network.node_url",
    "  --quote-base-url http://localhost:3000",
    "  --operator-secret-key from FPC_DEVNET_OPERATOR_SECRET_KEY | OPERATOR_SECRET_KEY | manifest.deployment_accounts.l2_deployer.private_key",
    "  --user-secret-key from FPC_DEVNET_USER_SECRET_KEY | USER_SECRET_KEY | L2_PRIVATE_KEY | operator-secret-key",
    `  --operator-salt ${ZERO_SALT_HEX}`,
    `  --user-salt ${ZERO_SALT_HEX}`,
    "  --da-gas-limit 1000000",
    "  --l2-gas-limit 1000000",
    "  --fee-juice-wait-ms 120000",
    "  --fee-juice-poll-ms 2000",
    "",
    "Notes:",
    "  - This script targets live devnet deployments and does not force local block advances.",
    "  - It expects attestation/topup services to run locally (QUOTE_BASE_URL default).",
    "  - Counter address is read from manifest.contracts.counter unless overridden.",
  ].join("\n");
}

function parseOptionalEnv(name: string): string | null {
  const value = process.env[name];
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePositiveInt(name: string, raw: string): number {
  if (!UINT_DECIMAL_PATTERN.test(raw)) {
    throw new Error(`${name} must be an unsigned integer. Got: ${raw}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer. Got: ${raw}`);
  }
  return parsed;
}

function parseHttpUrl(name: string, raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a URL. Got: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be http(s). Got: ${raw}`);
  }
  return parsed.toString();
}

function normalizeHex32(name: string, raw: string): string {
  const trimmed = raw.trim();
  const prefixed = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!HEX_32_PATTERN.test(prefixed)) {
    throw new Error(`${name} must be 32-byte hex (0x + 64 hex chars). Got: ${raw}`);
  }
  return prefixed.toLowerCase();
}

function sameAddress(a: AztecAddress, b: AztecAddress): boolean {
  return a.toString().toLowerCase() === b.toString().toLowerCase();
}

function scanEnvFileArg(argv: string[]): string {
  let envFilePath = path.join(repoRoot, ".env");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--env-file") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --env-file");
      }
      envFilePath = path.resolve(value);
      i += 1;
    }
  }
  return envFilePath;
}

function loadDotEnvFileIfPresent(dotenvPath: string): void {
  if (!existsSync(dotenvPath)) {
    return;
  }

  const content = readFileSync(dotenvPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    const key = match[1];
    if (process.env[key] !== undefined) {
      continue;
    }

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function readConfig(argv: string[]): Config {
  if (argv.includes("--help") || argv.includes("-h")) {
    pinoLogger.info(usage());
    process.exit(0);
  }

  const envFilePath = scanEnvFileArg(argv);
  loadDotEnvFileIfPresent(envFilePath);

  let manifestPath =
    parseOptionalEnv("MANIFEST_PATH") ??
    path.join(repoRoot, "deployments", "devnet-manifest-v2.json");
  let nodeUrl = parseOptionalEnv("AZTEC_NODE_URL");
  let quoteBaseUrl = parseOptionalEnv("QUOTE_BASE_URL") ?? "http://localhost:3000";
  const tokenArtifactPath =
    parseOptionalEnv("TOKEN_ARTIFACT_PATH") ??
    path.join(repoRoot, "target", "token_contract-Token.json");
  const fpcArtifactPath =
    parseOptionalEnv("FPC_ARTIFACT_PATH") ??
    path.join(repoRoot, "target", "fpc-FPCMultiAsset.json");
  const faucetArtifactPath =
    parseOptionalEnv("FAUCET_ARTIFACT_PATH") ?? path.join(repoRoot, "target", "faucet-Faucet.json");
  const counterArtifactPath =
    parseOptionalEnv("COUNTER_ARTIFACT_PATH") ??
    path.join(repoRoot, "target", "mock_counter-Counter.json");
  let counterAddress = parseOptionalEnv("MOCK_COUNTER_ADDRESS");

  let operatorSecretKeyRaw =
    parseOptionalEnv("FPC_DEVNET_OPERATOR_SECRET_KEY") ?? parseOptionalEnv("OPERATOR_SECRET_KEY");
  let userSecretKeyRaw =
    parseOptionalEnv("FPC_DEVNET_USER_SECRET_KEY") ??
    parseOptionalEnv("USER_SECRET_KEY") ??
    parseOptionalEnv("L2_PRIVATE_KEY");
  let operatorSaltRaw = parseOptionalEnv("FPC_DEVNET_OPERATOR_SALT") ?? ZERO_SALT_HEX;
  let userSaltRaw = parseOptionalEnv("FPC_DEVNET_USER_SALT") ?? ZERO_SALT_HEX;

  let daGasLimitRaw = parseOptionalEnv("DA_GAS_LIMIT") ?? "1000000";
  let l2GasLimitRaw = parseOptionalEnv("L2_GAS_LIMIT") ?? "1000000";
  let feeJuiceWaitMsRaw = parseOptionalEnv("FEE_JUICE_WAIT_MS") ?? "120000";
  let feeJuicePollMsRaw = parseOptionalEnv("FEE_JUICE_POLL_MS") ?? "2000";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    const needNext = (): string => {
      if (!next || next.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      return next;
    };

    switch (arg) {
      case "--env-file":
        needNext();
        break;
      case "--manifest":
        manifestPath = path.resolve(needNext());
        break;
      case "--node-url":
        nodeUrl = needNext();
        break;
      case "--quote-base-url":
        quoteBaseUrl = needNext();
        break;
      case "--counter-address":
        counterAddress = needNext();
        break;
      case "--operator-secret-key":
        operatorSecretKeyRaw = needNext();
        break;
      case "--user-secret-key":
        userSecretKeyRaw = needNext();
        break;
      case "--operator-salt":
        operatorSaltRaw = needNext();
        break;
      case "--user-salt":
        userSaltRaw = needNext();
        break;
      case "--da-gas-limit":
        daGasLimitRaw = needNext();
        break;
      case "--l2-gas-limit":
        l2GasLimitRaw = needNext();
        break;
      case "--fee-juice-wait-ms":
        feeJuiceWaitMsRaw = needNext();
        break;
      case "--fee-juice-poll-ms":
        feeJuicePollMsRaw = needNext();
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }
  }

  const manifestRaw = JSON.parse(readFileSync(path.resolve(manifestPath), "utf8")) as Manifest;

  const resolvedNodeUrl = nodeUrl ?? manifestRaw.network?.node_url;
  if (!resolvedNodeUrl) {
    throw new Error(
      "Missing node URL. Set AZTEC_NODE_URL, pass --node-url, or ensure manifest.network.node_url exists.",
    );
  }

  if (!operatorSecretKeyRaw) {
    operatorSecretKeyRaw = manifestRaw.deployment_accounts?.l2_deployer?.private_key ?? null;
  }
  if (!operatorSecretKeyRaw) {
    throw new Error(
      "Missing operator secret key. Set FPC_DEVNET_OPERATOR_SECRET_KEY or OPERATOR_SECRET_KEY.",
    );
  }

  const operatorSecretKey = normalizeHex32("operator secret key", operatorSecretKeyRaw);
  const userSecretKey = normalizeHex32("user secret key", userSecretKeyRaw ?? operatorSecretKeyRaw);

  if (!userSecretKeyRaw) {
    pinoLogger.warn(
      "[manual-fpc-devnet] FPC_DEVNET_USER_SECRET_KEY not set; defaulting user to operator key",
    );
  }

  return {
    envFilePath: path.resolve(envFilePath),
    nodeUrl: parseHttpUrl("node URL", resolvedNodeUrl),
    quoteBaseUrl: parseHttpUrl("quote base URL", quoteBaseUrl),
    manifestPath: path.resolve(manifestPath),
    tokenArtifactPath: path.resolve(tokenArtifactPath),
    fpcArtifactPath: path.resolve(fpcArtifactPath),
    faucetArtifactPath: path.resolve(faucetArtifactPath),
    counterArtifactPath: path.resolve(counterArtifactPath),
    counterAddress,
    operatorSecretKey,
    userSecretKey,
    operatorSalt: normalizeHex32("operator salt", operatorSaltRaw),
    userSalt: normalizeHex32("user salt", userSaltRaw),
    ephemeralWallet: process.env.EMBEDDED_WALLET_EPHEMERAL !== "0",
    daGasLimit: parsePositiveInt("DA_GAS_LIMIT", daGasLimitRaw),
    l2GasLimit: parsePositiveInt("L2_GAS_LIMIT", l2GasLimitRaw),
    feeJuiceWaitMs: parsePositiveInt("FEE_JUICE_WAIT_MS", feeJuiceWaitMsRaw),
    feeJuicePollMs: parsePositiveInt("FEE_JUICE_POLL_MS", feeJuicePollMsRaw),
  };
}

function parseManifest(manifestPath: string): Manifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}

function requireManifestAddress(name: string, value: string | undefined): AztecAddress {
  if (!value) {
    throw new Error(`Manifest is missing required ${name}`);
  }
  return AztecAddress.fromString(value);
}

function loadArtifact(artifactPath: string): ContractArtifact {
  const parsed = JSON.parse(readFileSync(artifactPath, "utf8")) as NoirCompiledContract;
  try {
    return loadContractArtifact(parsed);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Contract's public bytecode has not been transpiled")
    ) {
      return loadContractArtifactForPublic(parsed);
    }
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFeeJuice(params: {
  fpcAddress: AztecAddress;
  node: ReturnType<typeof createAztecNodeClient>;
  waitMs: number;
  pollMs: number;
  minimumBalance: bigint;
}): Promise<bigint> {
  const deadline = Date.now() + params.waitMs;
  let balance = await getFeeJuiceBalance(params.fpcAddress, params.node);
  let polls = 0;

  while (balance < params.minimumBalance && Date.now() < deadline) {
    polls += 1;
    pinoLogger.info(
      `[manual-fpc-devnet] waiting for fee_juice. poll=${polls} balance=${balance} required=${params.minimumBalance}`,
    );
    await sleep(params.pollMs);
    balance = await getFeeJuiceBalance(params.fpcAddress, params.node);
  }

  return balance;
}

async function fetchQuote(
  quoteBaseUrl: string,
  user: AztecAddress,
  acceptedAsset: AztecAddress,
  fjAmount: bigint,
): Promise<QuoteResponse> {
  const quoteUrl = new URL(quoteBaseUrl);
  const normalizedPath = quoteUrl.pathname.replace(/\/+$/u, "");
  quoteUrl.pathname = normalizedPath.endsWith("/quote")
    ? normalizedPath
    : `${normalizedPath}/quote`;
  quoteUrl.searchParams.set("user", user.toString());
  quoteUrl.searchParams.set("accepted_asset", acceptedAsset.toString());
  quoteUrl.searchParams.set("fj_amount", fjAmount.toString());

  const response = await fetch(quoteUrl.toString());
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Quote request failed (${response.status}): ${body}`);
  }
  return (await response.json()) as QuoteResponse;
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

async function assertPublishedAccount(
  node: ReturnType<typeof createAztecNodeClient>,
  address: AztecAddress,
  label: string,
): Promise<void> {
  const account = await node.getContract(address);
  if (account) {
    return;
  }

  throw new Error(
    `${label} account ${address.toString()} is not published on node. Deploy/register this account first (or use operator as user).`,
  );
}

async function main() {
  const cfg = readConfig(process.argv.slice(2));
  const manifest = parseManifest(cfg.manifestPath);

  const fpcAddress = requireManifestAddress("contracts.fpc", manifest.contracts?.fpc);
  const tokenAddress = requireManifestAddress(
    "contracts.accepted_asset",
    manifest.contracts?.accepted_asset,
  );
  const faucetAddress = requireManifestAddress("contracts.faucet", manifest.contracts?.faucet);
  const counterAddress = requireManifestAddress(
    "counter address",
    cfg.counterAddress ?? manifest.contracts?.counter,
  );
  const operatorFromManifest = requireManifestAddress(
    "operator.address",
    manifest.operator?.address,
  );

  const tokenArtifact = loadArtifact(cfg.tokenArtifactPath);
  const fpcArtifact = loadArtifact(cfg.fpcArtifactPath);
  const faucetArtifact = loadArtifact(cfg.faucetArtifactPath);
  const counterArtifact = loadArtifact(cfg.counterArtifactPath);

  const node = createAztecNodeClient(cfg.nodeUrl);
  await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: cfg.ephemeralWallet,
    pxeConfig: { proverEnabled: true },
  });

  const operatorSecret = Fr.fromHexString(cfg.operatorSecretKey);
  const userSecret = Fr.fromHexString(cfg.userSecretKey);
  const operatorSalt = Fr.fromHexString(cfg.operatorSalt);
  const userSalt = Fr.fromHexString(cfg.userSalt);

  const [operatorAccount, userAccount] = await Promise.all([
    wallet.createSchnorrAccount(operatorSecret, operatorSalt, deriveSigningKey(operatorSecret)),
    wallet.createSchnorrAccount(userSecret, userSalt, deriveSigningKey(userSecret)),
  ]);

  const operator = operatorAccount.address;
  const user = userAccount.address;

  if (!sameAddress(operator, operatorFromManifest)) {
    throw new Error(
      `Operator mismatch. manifest=${operatorFromManifest.toString()} derived=${operator.toString()}. Use the matching operator key/salt.`,
    );
  }

  await assertPublishedAccount(node, operator, "operator");
  if (!sameAddress(user, operator)) {
    await assertPublishedAccount(node, user, "user");
  }

  const token = await attachRegisteredContract(
    wallet,
    node,
    tokenAddress,
    tokenArtifact,
    "accepted_asset",
  );
  const fpc = await attachRegisteredContract(wallet, node, fpcAddress, fpcArtifact, "fpc");
  const faucet = await attachRegisteredContract(
    wallet,
    node,
    faucetAddress,
    faucetArtifact,
    "faucet",
  );
  const counter = await attachRegisteredContract(
    wallet,
    node,
    counterAddress,
    counterArtifact,
    "counter",
  );

  const minFees = await node.getCurrentMinFees();
  const feePerDaGas = minFees.feePerDaGas;
  const feePerL2Gas = minFees.feePerL2Gas;
  const fjAmount = BigInt(cfg.daGasLimit) * feePerDaGas + BigInt(cfg.l2GasLimit) * feePerL2Gas;

  pinoLogger.info(`[manual-fpc-devnet] env_file=${cfg.envFilePath}`);
  pinoLogger.info(`[manual-fpc-devnet] node_url=${cfg.nodeUrl}`);
  pinoLogger.info(`[manual-fpc-devnet] quote_base_url=${cfg.quoteBaseUrl}`);
  pinoLogger.info(`[manual-fpc-devnet] manifest=${cfg.manifestPath}`);
  pinoLogger.info(`[manual-fpc-devnet] operator=${operator.toString()}`);
  pinoLogger.info(`[manual-fpc-devnet] user=${user.toString()}`);
  pinoLogger.info(`[manual-fpc-devnet] token=${tokenAddress.toString()}`);
  pinoLogger.info(`[manual-fpc-devnet] fpc=${fpcAddress.toString()}`);
  pinoLogger.info(`[manual-fpc-devnet] faucet=${faucetAddress.toString()}`);
  pinoLogger.info(`[manual-fpc-devnet] counter=${counter.address.toString()}`);

  const fpcFeeJuiceBalance = await waitForFeeJuice({
    fpcAddress,
    node,
    waitMs: cfg.feeJuiceWaitMs,
    pollMs: cfg.feeJuicePollMs,
    minimumBalance: fjAmount,
  });
  if (fpcFeeJuiceBalance < fjAmount) {
    throw new Error(
      `FPC FeeJuice balance ${fpcFeeJuiceBalance} is below required ${fjAmount}. Ensure topup service has bridged enough funds.`,
    );
  }

  const quote = await fetchQuote(cfg.quoteBaseUrl, user, tokenAddress, fjAmount);
  if (quote.accepted_asset.toLowerCase() !== tokenAddress.toString().toLowerCase()) {
    throw new Error(
      `Quote accepted_asset mismatch. quote=${quote.accepted_asset} manifest_token=${tokenAddress.toString()}`,
    );
  }
  if (BigInt(quote.fj_amount) !== fjAmount) {
    throw new Error(
      `Quote fj_amount mismatch. quote=${quote.fj_amount} expected=${fjAmount.toString()}`,
    );
  }

  const aaPaymentAmount = BigInt(quote.aa_payment_amount);
  const quoteSigBytes = Array.from(Buffer.from(quote.signature.replace(/^0x/, ""), "hex"));
  const minimumPrivateAcceptedAsset = aaPaymentAmount + 1_000_000n;

  let userPrivateBalance = BigInt(
    (await token.methods.balance_of_private(user).simulate({ from: user })).toString(),
  );

  for (let attempt = 1; userPrivateBalance < minimumPrivateAcceptedAsset; attempt += 1) {
    if (attempt > 3) {
      throw new Error(
        `Unable to reach required private accepted-asset balance after faucet attempts. required=${minimumPrivateAcceptedAsset} current=${userPrivateBalance}`,
      );
    }

    let userPublicBalance = BigInt(
      (await token.methods.balance_of_public(user).simulate({ from: user })).toString(),
    );

    if (userPublicBalance === 0n) {
      pinoLogger.info(
        `[manual-fpc-devnet] user private accepted_asset=${userPrivateBalance} (< ${minimumPrivateAcceptedAsset}); requesting faucet drip attempt=${attempt}`,
      );
      await faucet.methods.drip(user).send({ from: user });
      userPublicBalance = BigInt(
        (await token.methods.balance_of_public(user).simulate({ from: user })).toString(),
      );
    }

    if (userPublicBalance === 0n) {
      throw new Error(
        "Faucet drip did not credit user public balance; cannot shield funds for fee payment.",
      );
    }

    await token.methods
      .transfer_public_to_private(user, user, userPublicBalance, Fr.random())
      .send({ from: user });

    userPrivateBalance = BigInt(
      (await token.methods.balance_of_private(user).simulate({ from: user })).toString(),
    );
  }

  const nonce = Fr.random();
  const transferCall = await token.methods
    .transfer_private_to_private(user, operator, aaPaymentAmount, nonce)
    .getFunctionCall();
  const transferAuthwit = await wallet.createAuthWit(user, {
    caller: fpcAddress,
    call: transferCall,
  });

  const counterBefore = BigInt(
    (await counter.methods.get_counter(user).simulate({ from: user })).toString(),
  );

  const userPrivateBefore = BigInt(
    (await token.methods.balance_of_private(user).simulate({ from: user })).toString(),
  );
  const operatorPrivateBefore = BigInt(
    (await token.methods.balance_of_private(operator).simulate({ from: operator })).toString(),
  );

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

  const receipt = await counter.methods.increment(user).send({
    from: user,
    fee: {
      paymentMethod,
      gasSettings: { gasLimits, teardownGasLimits, maxFeesPerGas },
    },
    wait: { timeout: 180 },
  });

  const counterAfter = BigInt(
    (await counter.methods.get_counter(user).simulate({ from: user })).toString(),
  );
  const userPrivateAfter = BigInt(
    (await token.methods.balance_of_private(user).simulate({ from: user })).toString(),
  );
  const operatorPrivateAfter = BigInt(
    (await token.methods.balance_of_private(operator).simulate({ from: operator })).toString(),
  );

  const userDebited = userPrivateBefore - userPrivateAfter;
  const operatorCredited = operatorPrivateAfter - operatorPrivateBefore;

  pinoLogger.info(`tx_hash=${receipt.txHash.toString()}`);
  pinoLogger.info(`tx_fee_juice=${receipt.transactionFee}`);
  pinoLogger.info(`expected_charge=${aaPaymentAmount}`);
  pinoLogger.info(`user_debited=${userDebited}`);
  pinoLogger.info(`operator_credited=${operatorCredited}`);
  pinoLogger.info(`counter_before=${counterBefore}`);
  pinoLogger.info(`counter_after=${counterAfter}`);

  if (counterAfter !== counterBefore + 1n) {
    throw new Error(
      `Counter mismatch. expected_after=${counterBefore + 1n} actual_after=${counterAfter}`,
    );
  }

  if (!sameAddress(user, operator)) {
    if (userDebited !== aaPaymentAmount || operatorCredited !== aaPaymentAmount) {
      throw new Error(
        `Accounting mismatch. expected=${aaPaymentAmount} user_debited=${userDebited} operator_credited=${operatorCredited}`,
      );
    }
  } else {
    pinoLogger.info("[manual-fpc-devnet] user==operator; skipping debit/credit equality assertion");
  }

  pinoLogger.info(
    "PASS: sponsored Counter.increment tx via FPCMultiAsset fee_entrypoint on devnet",
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  pinoLogger.error(`FAIL: ${message}`);
  process.exit(1);
});

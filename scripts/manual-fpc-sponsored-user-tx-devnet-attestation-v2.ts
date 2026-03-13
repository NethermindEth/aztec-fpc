import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";

const pinoLogger = pino();

import { getSchnorrAccountContractAddress } from "@aztec/accounts/schnorr";
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
  attestationBaseUrl: string;
  manifestPath: string;
  tokenArtifactPath: string;
  fpcArtifactPath: string;
  faucetArtifactPath: string;
  counterArtifactPath: string;
  counterAddress: string | null;
  userAddress: AztecAddress;
  userSecretKey: string;
  walletAlias: string | null;
  userSalt: string;
  ephemeralWallet: boolean;
  daGasLimit: number;
  l2GasLimit: number;
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
};

const HEX_32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const UINT_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const ZERO_SALT_HEX = "0x0000000000000000000000000000000000000000000000000000000000000000";
const DEFAULT_ATTESTATION_BASE_URL = "https://aztec-fpc.staging-nethermind.xyz/v2";

function usage(): string {
  return [
    "Usage:",
    "  bunx tsx scripts/manual-fpc-sponsored-user-tx-devnet-attestation-v2.ts \\",
    "    [--env-file <path>] \\",
    "    [--manifest <path>] \\",
    "    [--node-url <url>] \\",
    "    [--attestation-base-url <url>] \\",
    "    [--counter-address <aztec_address>] \\",
    "    [--user-address <aztec_address>] \\",
    "    [--user-secret-key <hex32>] \\",
    "    [--wallet-alias <alias>] \\",
    "    [--user-salt <hex32>] \\",
    "    [--da-gas-limit <uint>] \\",
    "    [--l2-gas-limit <uint>]",
    "",
    "Defaults:",
    "  --env-file ./.env",
    "  --manifest ./deployments/devnet-manifest-v2.json",
    "  --node-url from AZTEC_NODE_URL or manifest.network.node_url",
    `  --attestation-base-url ${DEFAULT_ATTESTATION_BASE_URL}`,
    "  --user-address from L2_ADDRESS",
    "  --user-secret-key from L2_PRIVATE_KEY (fallback: FPC_DEVNET_USER_SECRET_KEY or USER_SECRET_KEY)",
    "  --wallet-alias from WALLET_ALIAS",
    `  --user-salt ${ZERO_SALT_HEX}`,
    "  --da-gas-limit 200000",
    "  --l2-gas-limit 1000000",
    "",
    "Notes:",
    "  - This script targets live devnet deployments.",
    "  - It only calls the attestation service (/quote) and does not interact with topup service APIs.",
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

function parseAztecAddress(name: string, raw: string): AztecAddress {
  try {
    return AztecAddress.fromString(raw);
  } catch {
    throw new Error(`${name} must be a valid Aztec address. Got: ${raw}`);
  }
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
  let attestationBaseUrl =
    parseOptionalEnv("ATTESTATION_BASE_URL") ??
    parseOptionalEnv("QUOTE_BASE_URL") ??
    DEFAULT_ATTESTATION_BASE_URL;
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

  let userAddressRaw = parseOptionalEnv("L2_ADDRESS");
  let userSecretKeyRaw =
    parseOptionalEnv("L2_PRIVATE_KEY") ??
    parseOptionalEnv("FPC_DEVNET_USER_SECRET_KEY") ??
    parseOptionalEnv("USER_SECRET_KEY");
  let walletAlias = parseOptionalEnv("WALLET_ALIAS");
  let userSaltRaw = parseOptionalEnv("FPC_DEVNET_USER_SALT") ?? ZERO_SALT_HEX;

  let daGasLimitRaw = parseOptionalEnv("DA_GAS_LIMIT") ?? "200000";
  let l2GasLimitRaw = parseOptionalEnv("L2_GAS_LIMIT") ?? "1000000";

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
      case "--attestation-base-url":
      case "--quote-base-url":
        attestationBaseUrl = needNext();
        break;
      case "--counter-address":
        counterAddress = needNext();
        break;
      case "--user-address":
        userAddressRaw = needNext();
        break;
      case "--user-secret-key":
        userSecretKeyRaw = needNext();
        break;
      case "--wallet-alias":
        walletAlias = needNext();
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

  if (!userAddressRaw) {
    throw new Error("Missing user address. Set L2_ADDRESS or pass --user-address.");
  }
  if (!userSecretKeyRaw) {
    throw new Error("Missing user secret key. Set L2_PRIVATE_KEY or pass --user-secret-key.");
  }

  return {
    envFilePath: path.resolve(envFilePath),
    nodeUrl: parseHttpUrl("node URL", resolvedNodeUrl),
    attestationBaseUrl: parseHttpUrl("attestation base URL", attestationBaseUrl),
    manifestPath: path.resolve(manifestPath),
    tokenArtifactPath: path.resolve(tokenArtifactPath),
    fpcArtifactPath: path.resolve(fpcArtifactPath),
    faucetArtifactPath: path.resolve(faucetArtifactPath),
    counterArtifactPath: path.resolve(counterArtifactPath),
    counterAddress,
    userAddress: parseAztecAddress("user address", userAddressRaw),
    userSecretKey: normalizeHex32("user secret key", userSecretKeyRaw),
    walletAlias,
    userSalt: normalizeHex32("user salt", userSaltRaw),
    ephemeralWallet: process.env.EMBEDDED_WALLET_EPHEMERAL !== "0",
    daGasLimit: parsePositiveInt("DA_GAS_LIMIT", daGasLimitRaw),
    l2GasLimit: parsePositiveInt("L2_GAS_LIMIT", l2GasLimitRaw),
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

async function stopWalletWithTimeout(wallet: EmbeddedWallet, timeoutMs: number): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      wallet.stop(),
      new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(() => {
          pinoLogger.warn(
            `[manual-fpc-devnet-v2] wallet.stop() timed out after ${timeoutMs}ms; forcing process exit`,
          );
          resolve();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function fetchQuote(
  attestationBaseUrl: string,
  user: AztecAddress,
  acceptedAsset: AztecAddress,
  fjAmount: bigint,
): Promise<QuoteResponse> {
  const quoteUrl = new URL(attestationBaseUrl);
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
    `${label} account ${address.toString()} is not published on node. Deploy/register this account first.`,
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
  const operatorAddress = requireManifestAddress("operator.address", manifest.operator?.address);

  const tokenArtifact = loadArtifact(cfg.tokenArtifactPath);
  const fpcArtifact = loadArtifact(cfg.fpcArtifactPath);
  const faucetArtifact = loadArtifact(cfg.faucetArtifactPath);
  const counterArtifact = loadArtifact(cfg.counterArtifactPath);

  const node = createAztecNodeClient(cfg.nodeUrl);
  await waitForNode(node);

  let wallet: EmbeddedWallet | null = null;
  try {
    wallet = await EmbeddedWallet.create(node, {
      ephemeral: cfg.ephemeralWallet,
      pxeConfig: { proverEnabled: true },
    });

    const userSecret = Fr.fromHexString(cfg.userSecretKey);
    const userSalt = Fr.fromHexString(cfg.userSalt);
    const userAddressFromSecret = await getSchnorrAccountContractAddress(userSecret, userSalt);
    if (!sameAddress(userAddressFromSecret, cfg.userAddress)) {
      throw new Error(
        `L2_ADDRESS does not match L2_PRIVATE_KEY/user-salt. expected=${cfg.userAddress.toString()} derived=${userAddressFromSecret.toString()}`,
      );
    }

    const userAccount = await wallet.createSchnorrAccount(
      userSecret,
      userSalt,
      deriveSigningKey(userSecret),
    );
    const user = userAccount.address;
    if (!sameAddress(user, cfg.userAddress)) {
      throw new Error(
        `Embedded wallet derived unexpected user address. expected=${cfg.userAddress.toString()} derived=${user.toString()}`,
      );
    }

    await assertPublishedAccount(node, user, "user");

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

    pinoLogger.info(`[manual-fpc-devnet-v2] env_file=${cfg.envFilePath}`);
    pinoLogger.info(`[manual-fpc-devnet-v2] node_url=${cfg.nodeUrl}`);
    pinoLogger.info(`[manual-fpc-devnet-v2] attestation_base_url=${cfg.attestationBaseUrl}`);
    if (cfg.walletAlias) {
      pinoLogger.info(`[manual-fpc-devnet-v2] wallet_alias=${cfg.walletAlias}`);
    }
    pinoLogger.info(`[manual-fpc-devnet-v2] manifest=${cfg.manifestPath}`);
    pinoLogger.info(`[manual-fpc-devnet-v2] user=${user.toString()}`);
    pinoLogger.info(`[manual-fpc-devnet-v2] operator=${operatorAddress.toString()}`);
    pinoLogger.info(`[manual-fpc-devnet-v2] token=${tokenAddress.toString()}`);
    pinoLogger.info(`[manual-fpc-devnet-v2] fpc=${fpcAddress.toString()}`);
    pinoLogger.info(`[manual-fpc-devnet-v2] faucet=${faucetAddress.toString()}`);
    pinoLogger.info(`[manual-fpc-devnet-v2] counter=${counter.address.toString()}`);

    const fpcFeeJuiceBalance = await getFeeJuiceBalance(fpcAddress, node);
    if (fpcFeeJuiceBalance < fjAmount) {
      throw new Error(
        `FPC FeeJuice balance ${fpcFeeJuiceBalance} is below required ${fjAmount}. Pre-fund FPC before running this script.`,
      );
    }

    const quote = await fetchQuote(cfg.attestationBaseUrl, user, tokenAddress, fjAmount);
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
    if (quoteSigBytes.length !== 64) {
      throw new Error(`Quote signature must be 64 bytes. got=${quoteSigBytes.length}`);
    }

    const minimumPrivateAcceptedAsset = aaPaymentAmount + 1_000_000n;
    let userPrivateBalance = BigInt(
      (await token.methods.balance_of_private(user).simulate({ from: user })).result.toString(),
    );

    for (let attempt = 1; userPrivateBalance < minimumPrivateAcceptedAsset; attempt += 1) {
      if (attempt > 3) {
        throw new Error(
          `Unable to reach required private accepted-asset balance after faucet attempts. required=${minimumPrivateAcceptedAsset} current=${userPrivateBalance}`,
        );
      }

      let userPublicBalance = BigInt(
        (await token.methods.balance_of_public(user).simulate({ from: user })).result.toString(),
      );

      if (userPublicBalance === 0n) {
        pinoLogger.info(
          `[manual-fpc-devnet-v2] user private accepted_asset=${userPrivateBalance} (< ${minimumPrivateAcceptedAsset}); requesting faucet drip attempt=${attempt}`,
        );
        await faucet.methods.drip(user).send({
          from: user,
          wait: { timeout: 180 },
        });
        userPublicBalance = BigInt(
          (await token.methods.balance_of_public(user).simulate({ from: user })).result.toString(),
        );
      }

      if (userPublicBalance === 0n) {
        throw new Error(
          "Faucet drip did not credit user public balance; cannot shield funds for fee payment.",
        );
      }

      await token.methods
        .transfer_public_to_private(user, user, userPublicBalance, Fr.random())
        .send({ from: user, wait: { timeout: 180 } });

      userPrivateBalance = BigInt(
        (await token.methods.balance_of_private(user).simulate({ from: user })).result.toString(),
      );
    }

    const nonce = Fr.random();
    const transferCall = await token.methods
      .transfer_private_to_private(user, operatorAddress, aaPaymentAmount, nonce)
      .getFunctionCall();
    const transferAuthwit = await wallet.createAuthWit(user, {
      caller: fpcAddress,
      call: transferCall,
    });

    const counterBefore = BigInt(
      (await counter.methods.get_counter(user).simulate({ from: user })).result.toString(),
    );
    const userPrivateBefore = BigInt(
      (await token.methods.balance_of_private(user).simulate({ from: user })).result.toString(),
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

    const { receipt } = await counter.methods.increment(user).send({
      from: user,
      fee: {
        paymentMethod,
        gasSettings: { gasLimits, teardownGasLimits, maxFeesPerGas },
      },
      wait: { timeout: 180 },
    });

    const counterAfter = BigInt(
      (await counter.methods.get_counter(user).simulate({ from: user })).result.toString(),
    );
    const userPrivateAfter = BigInt(
      (await token.methods.balance_of_private(user).simulate({ from: user })).result.toString(),
    );
    const userDebited = userPrivateBefore - userPrivateAfter;

    pinoLogger.info(`tx_hash=${receipt.txHash.toString()}`);
    pinoLogger.info(`tx_fee_juice=${receipt.transactionFee}`);
    pinoLogger.info(`expected_charge=${aaPaymentAmount}`);
    pinoLogger.info(`user_debited=${userDebited}`);
    pinoLogger.info(`counter_before=${counterBefore}`);
    pinoLogger.info(`counter_after=${counterAfter}`);

    if (counterAfter !== counterBefore + 1n) {
      throw new Error(
        `Counter mismatch. expected_after=${counterBefore + 1n} actual_after=${counterAfter}`,
      );
    }

    if (!sameAddress(user, operatorAddress) && userDebited !== aaPaymentAmount) {
      throw new Error(
        `Accounting mismatch. expected user_debited=${aaPaymentAmount} got=${userDebited}`,
      );
    }

    pinoLogger.info(
      "PASS: sponsored Counter.increment tx via FPCMultiAsset fee_entrypoint on devnet (attestation v2)",
    );
  } finally {
    if (wallet) {
      await stopWalletWithTimeout(wallet, 5_000);
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    pinoLogger.error(`FAIL: ${message}`);
    process.exit(1);
  });

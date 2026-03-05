import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getSchnorrAccountContractAddress } from "@aztec/accounts/schnorr";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import {
  executeSponsoredEntrypoint,
  firstEnv,
  loadEnvIfPresent,
  parseJsonArray,
  parsePositiveInt,
  requiredEnvGroup,
  sameAddress,
} from "../src/index.ts";
import { loadContractArtifactJson } from "../src/internal/node-utils.ts";

const DEFAULT_NODE_URL = "https://v4-devnet-2.aztec-labs.com/";
const DEFAULT_ATTESTATION_BASE_URL =
  "https://aztec-fpc.staging-nethermind.xyz/v2";
const DEFAULT_OPERATOR_ADDRESS =
  "0x18a15b90bea06cea7cbd06b3940533952aa9e5f94c157000c727321644d07af8";
const DEFAULT_FPC_ADDRESS =
  "0x24a735808258519dc1637f1833202ea2dc7c829a0a82c73f61bbd195fce4105b";
const DEFAULT_TARGET_ADDRESS =
  "0x226762b1e122bd46054de3fd21a19f0500ebe072aeac35fe0bb82d43b85f94fd";
const DEFAULT_TARGET_METHOD = "increment";
const ZERO_SALT_HEX =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const DEFAULT_TARGET_ARTIFACT_PATH = path.join(
  repoRoot,
  "target",
  "mock_counter-Counter.json",
);

function logResult(
  user: AztecAddress,
  targetAddress: AztecAddress,
  targetMethod: string,
  result: {
    txHash: string;
    txFeeJuice: bigint;
    expectedCharge: bigint;
    userDebited: bigint;
    fjAmount: bigint;
    quoteValidUntil: bigint;
  },
): void {
  console.log(`user=${user.toString()}`);
  console.log(`target=${targetAddress.toString()}`);
  console.log(`method=${targetMethod}`);
  console.log(`tx_hash=${result.txHash}`);
  console.log(`tx_fee_juice=${result.txFeeJuice}`);
  console.log(`expected_charge=${result.expectedCharge}`);
  console.log(`user_debited=${result.userDebited}`);
  console.log(`fj_amount=${result.fjAmount}`);
  console.log(`quote_valid_until=${result.quoteValidUntil}`);
}

async function run(): Promise<void> {
  const envFilePath =
    firstEnv("SDK_EXAMPLE_ENV_FILE") ?? path.join(repoRoot, ".env");
  loadEnvIfPresent(envFilePath);

  const nodeUrl = firstEnv("AZTEC_NODE_URL") ?? DEFAULT_NODE_URL;
  const attestationBaseUrl =
    firstEnv("ATTESTATION_BASE_URL", "QUOTE_BASE_URL") ??
    DEFAULT_ATTESTATION_BASE_URL;
  const operatorAddress =
    firstEnv("FPC_OPERATOR_ADDRESS", "OPERATOR_ADDRESS") ??
    DEFAULT_OPERATOR_ADDRESS;
  const fpcAddress =
    firstEnv("FPC_ADDRESS", "FPC_CONTRACT_ADDRESS") ?? DEFAULT_FPC_ADDRESS;
  const resolveFpcFromDiscovery = firstEnv("RESOLVE_FPC_FROM_DISCOVERY") === "1";
  const targetAddress = AztecAddress.fromString(
    firstEnv(
      "TARGET_CONTRACT_ADDRESS",
      "MOCK_COUNTER_ADDRESS",
      "COUNTER_ADDRESS",
    ) ?? DEFAULT_TARGET_ADDRESS,
  );
  const targetMethod = firstEnv("TARGET_METHOD") ?? DEFAULT_TARGET_METHOD;
  const targetArgs = parseJsonArray(
    "TARGET_ARGS_JSON",
    firstEnv("TARGET_ARGS_JSON") ?? "[]",
  );
  const appendUserToTargetArgs = firstEnv("TARGET_APPEND_USER") !== "0";
  const targetArtifactPath = path.resolve(
    firstEnv("TARGET_ARTIFACT_PATH") ?? DEFAULT_TARGET_ARTIFACT_PATH,
  );
  const targetArtifact = loadContractArtifactJson(targetArtifactPath);
  const explicitAcceptedAsset = firstEnv("ACCEPTED_ASSET_ADDRESS");
  const daGasLimitRaw = firstEnv("DA_GAS_LIMIT");
  const l2GasLimitRaw = firstEnv("L2_GAS_LIMIT");
  const txWaitTimeoutSecondsRaw = firstEnv("TX_WAIT_TIMEOUT_SECONDS");

  const configuredAddress = requiredEnvGroup(
    "user address",
    "L2_ADDRESS",
    "L2_ADDRESS_NEW",
  );
  const userAddress = AztecAddress.fromString(configuredAddress);
  const userSecret = Fr.fromHexString(
    requiredEnvGroup(
      "user secret",
      "L2_PRIVATE_KEY",
      "L2_PRIVATE_KEY_NEW",
      "FPC_DEVNET_USER_SECRET_KEY",
      "USER_SECRET_KEY",
    ),
  );
  const userSalt = Fr.fromHexString(
    firstEnv("FPC_DEVNET_USER_SALT") ?? ZERO_SALT_HEX,
  );

  const derivedAddress = await getSchnorrAccountContractAddress(
    userSecret,
    userSalt,
  );
  if (!sameAddress(derivedAddress, userAddress)) {
    throw new Error(
      `L2 address does not match secret+salt. configured=${userAddress.toString()} derived=${derivedAddress.toString()}`,
    );
  }

  const node = createAztecNodeClient(nodeUrl);
  await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: process.env.EMBEDDED_WALLET_EPHEMERAL !== "0",
    pxeConfig: { proverEnabled: true },
  });

  try {
    const account = await wallet.createSchnorrAccount(
      userSecret,
      userSalt,
      deriveSigningKey(userSecret),
    );
    const result = await executeSponsoredEntrypoint<unknown>({
      account: account.address,
      sponsorship: {
        attestationBaseUrl,
        daGasLimit: daGasLimitRaw
          ? parsePositiveInt("DA_GAS_LIMIT", daGasLimitRaw)
          : undefined,
        l2GasLimit: l2GasLimitRaw
          ? parsePositiveInt("L2_GAS_LIMIT", l2GasLimitRaw)
          : undefined,
        resolveFpcFromDiscovery,
        runtimeConfig: {
          acceptedAsset: {},
          fpc: {
            address: resolveFpcFromDiscovery ? undefined : fpcAddress,
          },
          nodeUrl,
          operatorAddress,
          targets: {
            target: {
              address: targetAddress,
              artifact: targetArtifact,
            },
          },
        },
        tokenSelection: explicitAcceptedAsset
          ? {
              explicitAcceptedAsset,
            }
          : undefined,
        txWaitTimeoutSeconds: txWaitTimeoutSecondsRaw
          ? parsePositiveInt("TX_WAIT_TIMEOUT_SECONDS", txWaitTimeoutSecondsRaw)
          : undefined,
      },
      target: {
        address: targetAddress,
        appendUserToArgs: appendUserToTargetArgs,
        args: targetArgs,
        artifact: targetArtifact,
        method: targetMethod,
      },
      wallet,
    });
    logResult(account.address, targetAddress, targetMethod, result);
  } finally {
    await Promise.race([
      wallet.stop(),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    if (error && typeof error === "object" && "code" in error) {
      const sdkError = error as {
        code: string;
        details?: unknown;
        message?: string;
      };
      console.error(
        `FAIL [${sdkError.code}]: ${sdkError.message ?? "Unknown SDK error"}`,
      );
      if (sdkError.details !== undefined) {
        console.error(`details=${JSON.stringify(sdkError.details)}`);
      }
      process.exit(1);
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL: ${message}`);
    console.error(
      "Hint: copy sdk/example/.env.example to .env and fill L2_ADDRESS + L2_PRIVATE_KEY.",
    );
    process.exit(1);
  });

import { getSchnorrAccountContractAddress } from "@aztec/accounts/schnorr";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import {
  createSponsoredCounterClient,
  type SponsoredIncrementResult,
} from "@aztec-fpc/sdk";

const DEFAULT_NODE_URL = "https://v4-devnet-2.aztec-labs.com/";
const ZERO_SALT_HEX =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function requiredEnvGroup(groupLabel: string, ...names: string[]): string {
  const value = firstEnv(...names);
  if (!value) {
    throw new Error(
      `Missing required env var (${groupLabel}): ${names.join(", ")}`,
    );
  }
  return value;
}

function loadEnvIfPresent(path = ".env"): void {
  const loadEnvFile = (
    process as typeof process & {
      loadEnvFile?: (path: string) => void;
    }
  ).loadEnvFile;
  if (!loadEnvFile) {
    return;
  }
  try {
    loadEnvFile(path);
  } catch (error) {
    const maybeErr = error as { code?: string };
    if (maybeErr.code !== "ENOENT") {
      throw error;
    }
  }
}

function isSameAddress(a: AztecAddress, b: AztecAddress): boolean {
  return a.toString().toLowerCase() === b.toString().toLowerCase();
}

function logResult(user: AztecAddress, result: SponsoredIncrementResult): void {
  console.log(`user=${user.toString()}`);
  console.log(`tx_hash=${result.txHash}`);
  console.log(`tx_fee_juice=${result.txFeeJuice}`);
  console.log(`expected_charge=${result.expectedCharge}`);
  console.log(`user_debited=${result.userDebited}`);
  console.log(`counter_before=${result.counterBefore}`);
  console.log(`counter_after=${result.counterAfter}`);
}

async function run(): Promise<void> {
  loadEnvIfPresent(".env");

  const nodeUrl = firstEnv("AZTEC_NODE_URL") ?? DEFAULT_NODE_URL;
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
  if (!isSameAddress(derivedAddress, userAddress)) {
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
    const client = await createSponsoredCounterClient({
      account: account.address,
      wallet,
    });
    logResult(account.address, await client.increment());
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
    process.exit(1);
  });

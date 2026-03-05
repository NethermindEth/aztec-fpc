import { existsSync, readFileSync } from "node:fs";

import { getSchnorrAccountContractAddress } from "@aztec/accounts/schnorr";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { createSponsoredCounterClient } from "@aztec-fpc/sponsored-counter-sdk";

const DEFAULT_NODE_URL = "https://v4-devnet-2.aztec-labs.com/";
const ZERO_SALT_HEX =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function loadDotEnvFileIfPresent(path = ".env"): void {
  if (!existsSync(path)) {
    return;
  }
  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
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

function sameAddress(a: AztecAddress, b: AztecAddress): boolean {
  return a.toString().toLowerCase() === b.toString().toLowerCase();
}

async function stopWalletWithTimeout(
  wallet: EmbeddedWallet,
  timeoutMs: number,
): Promise<void> {
  await Promise.race([
    wallet.stop(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    }),
  ]);
}

async function main() {
  loadDotEnvFileIfPresent(".env");

  const nodeUrl = process.env.AZTEC_NODE_URL ?? DEFAULT_NODE_URL;
  const userAddress = AztecAddress.fromString(
    process.env.L2_ADDRESS ?? requiredEnv("L2_ADDRESS_NEW"),
  );
  const userSecretHex =
    process.env.L2_PRIVATE_KEY ??
    process.env.L2_PRIVATE_KEY_NEW ??
    process.env.FPC_DEVNET_USER_SECRET_KEY ??
    process.env.USER_SECRET_KEY;

  if (!userSecretHex) {
    throw new Error(
      "Missing one of L2_PRIVATE_KEY, FPC_DEVNET_USER_SECRET_KEY, USER_SECRET_KEY",
    );
  }

  const userSecret = Fr.fromHexString(userSecretHex);
  const userSalt = Fr.fromHexString(
    process.env.FPC_DEVNET_USER_SALT ?? ZERO_SALT_HEX,
  );

  const expectedUser = await getSchnorrAccountContractAddress(
    userSecret,
    userSalt,
  );
  if (!sameAddress(expectedUser, userAddress)) {
    throw new Error(
      `L2_ADDRESS does not match secret+salt. expected=${userAddress.toString()} derived=${expectedUser.toString()}`,
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

    const result = await client.increment();

    console.log(`user=${account.address.toString()}`);
    console.log(`tx_hash=${result.txHash}`);
    console.log(`tx_fee_juice=${result.txFeeJuice}`);
    console.log(`expected_charge=${result.expectedCharge}`);
    console.log(`user_debited=${result.userDebited}`);
    console.log(`counter_before=${result.counterBefore}`);
    console.log(`counter_after=${result.counterAfter}`);
  } finally {
    await stopWalletWithTimeout(wallet, 5_000);
  }
}

main()
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

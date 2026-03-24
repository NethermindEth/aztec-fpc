import { beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import path from "node:path";

import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { L2AmountClaim } from "@aztec/aztec.js/ethereum";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import type { AztecNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { FpcClient } from "@aztec-fpc/sdk";
import pino from "pino";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { type AccountData, deriveAccount } from "../common/script-credentials.ts";
import {
  type CoreContracts,
  setup as commonSetup,
  registerCoreContracts,
  setupL1Infrastructure,
} from "../common/setup-helpers.ts";

const pinoLogger = pino();
const LABEL = "concurrent-e2e";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

type ConcurrentConfig = {
  nodeUrl: string;
  l1RpcUrl: string;
  attestationBaseUrl: string;
  manifestPath: string;
  testTokenManifestPath: string;
  concurrentN: number;
  claimAmount: bigint;
  messageTimeoutSeconds: number;
  proverEnabled: boolean;
  l1PrivateKey: Hex | null;
  l1DeployerKey: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value.trim();
}

function getConfig(): ConcurrentConfig {
  const concurrentNRaw = process.env.FPC_CONCURRENT_N?.trim();
  const concurrentN = concurrentNRaw ? Number(concurrentNRaw) : 10;
  if (!Number.isSafeInteger(concurrentN) || concurrentN < 1) {
    throw new Error(`Invalid FPC_CONCURRENT_N: ${concurrentNRaw}`);
  }

  const claimAmountRaw = process.env.FPC_COLD_START_CLAIM_AMOUNT?.trim();
  const claimAmount = claimAmountRaw ? BigInt(claimAmountRaw) : 10_000_000_000_000_000n;

  const timeoutRaw = process.env.FPC_SMOKE_MESSAGE_TIMEOUT_SECONDS?.trim();
  const messageTimeoutSeconds = timeoutRaw ? Number(timeoutRaw) : 120;

  const l1KeyRaw = process.env.FPC_L1_PRIVATE_KEY?.trim();

  return {
    nodeUrl: process.env.AZTEC_NODE_URL ?? "http://localhost:8080",
    l1RpcUrl: requireEnv("L1_RPC_URL"),
    attestationBaseUrl: requireEnv("FPC_ATTESTATION_URL"),
    manifestPath: requireEnv("FPC_COLD_START_MANIFEST"),
    testTokenManifestPath: requireEnv("FPC_TEST_TOKEN_MANIFEST"),
    concurrentN,
    claimAmount,
    messageTimeoutSeconds,
    proverEnabled:
      process.env.PXE_PROVER_ENABLED !== "0" && process.env.PXE_PROVER_ENABLED !== "false",
    l1PrivateKey: l1KeyRaw ? (l1KeyRaw as Hex) : null,
    l1DeployerKey: requireEnv("FPC_L1_DEPLOYER_KEY"),
  };
}

// ---------------------------------------------------------------------------
// L1 funding via anvil_setBalance
// ---------------------------------------------------------------------------

async function fundL1Account(l1RpcUrl: string, address: string): Promise<void> {
  const response = await fetch(l1RpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_setBalance",
      params: [address, "0xDE0B6B3A7640000"],
    }),
  });
  if (!response.ok) {
    throw new Error(`anvil_setBalance failed: HTTP ${response.status} ${response.statusText}`);
  }
  const result = (await response.json()) as { error?: { message: string } };
  if (result.error) {
    throw new Error(`anvil_setBalance RPC error: ${result.error.message}`);
  }
  pinoLogger.info(`[${LABEL}] funded L1 account ${address} with 1 ETH`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UserContext = {
  index: number;
  wallet: EmbeddedWallet;
  account: AccountData;
  contracts: CoreContracts;
  bridgeClaim: L2AmountClaim;
};

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

setDefaultTimeout(900_000);

let users: UserContext[];
let fpcClient: FpcClient;
let tokenAddress: AztecAddress;
let bridgeAddress: AztecAddress;
let node: AztecNode;

describe("fpc concurrent e2e", () => {
  beforeAll(async () => {
    const config = getConfig();
    const repoRoot = path.resolve(import.meta.dirname, "../..");

    pinoLogger.info(`[${LABEL}] N=${config.concurrentN} claimAmount=${config.claimAmount}`);

    // 1. Common setup — node, wallet, contracts, FPC FeeJuice wait
    const {
      manifest,
      testTokenManifest,
      node: sharedNode,
      wallet: sharedWallet,
      operator,
      contracts: sharedContracts,
    } = await commonSetup(
      {
        nodeUrl: config.nodeUrl,
        manifestPath: config.manifestPath,
        testTokenManifestPath: config.testTokenManifestPath,
        proverEnabled: config.proverEnabled,
        messageTimeoutSeconds: config.messageTimeoutSeconds,
      },
      repoRoot,
      LABEL,
    );

    node = sharedNode;

    tokenAddress = sharedContracts.token.address;
    bridgeAddress = sharedContracts.bridge.address;
    const fpcAddress = sharedContracts.fpc.address;

    // 2. L1 infrastructure
    let l1PrivateKey: Hex;
    if (config.l1PrivateKey) {
      l1PrivateKey = config.l1PrivateKey;
      pinoLogger.info(`[${LABEL}] using provided L1 private key`);
    } else {
      l1PrivateKey = generatePrivateKey();
      const l1Account = privateKeyToAccount(l1PrivateKey);
      await fundL1Account(config.l1RpcUrl, l1Account.address);
    }

    const { l1WalletClient, l1Erc20, portalManager } = await setupL1Infrastructure({
      l1RpcUrl: config.l1RpcUrl,
      l1PrivateKey,
      l1DeployerKey: config.l1DeployerKey,
      l1PortalAddress: testTokenManifest.l1_contracts.token_portal,
      l1Erc20Address: testTokenManifest.l1_contracts.erc20,
      node,
      loggerName: "concurrent-e2e:bridge",
    });

    // 3. Mint total ERC20 on L1
    const totalClaimAmount = config.claimAmount * BigInt(config.concurrentN);
    const mintHash = await l1Erc20.write.mint([l1WalletClient.account.address, totalClaimAmount]);
    await l1WalletClient.waitForTransactionReceipt({ hash: mintHash });
    pinoLogger.info(`[${LABEL}] minted ${totalClaimAmount} ERC20 on L1`);

    // 4. Derive N account addresses (using shared wallet) and bridge sequentially
    pinoLogger.info(`[${LABEL}] deriving accounts and bridging for ${config.concurrentN} users`);
    const secrets: Fr[] = [];
    const bridgeClaims: L2AmountClaim[] = [];
    for (let i = 0; i < config.concurrentN; i++) {
      const secret = Fr.random();
      const account = await deriveAccount(secret, sharedWallet);
      secrets.push(secret);

      const claim = await portalManager.bridgeTokensPrivate(
        account.address,
        config.claimAmount,
        false,
      );
      pinoLogger.info(
        `[${LABEL}] user[${i}] address=${account.address.toString()} messageHash=${claim.messageHash}`,
      );
      bridgeClaims.push(claim);
    }

    // 5. Concurrent L2 setup: per-user wallets, contract registration, account derivation, message wait
    pinoLogger.info(`[${LABEL}] starting concurrent L2 setup for ${config.concurrentN} users`);
    users = await Promise.all(
      secrets.map(async (secret, i) => {
        const wallet = await EmbeddedWallet.create(node, {
          ephemeral: true,
          pxeConfig: { proverEnabled: config.proverEnabled },
        });
        const contracts = await registerCoreContracts(
          repoRoot,
          manifest,
          testTokenManifest,
          node,
          wallet,
        );
        const account = await deriveAccount(secret, wallet);

        const msgHash = Fr.fromHexString(bridgeClaims[i].messageHash as string);
        await waitForL1ToL2MessageReady(node, msgHash, {
          timeoutSeconds: config.messageTimeoutSeconds,
        });
        pinoLogger.info(`[${LABEL}] user[${i}] L2 setup complete`);

        return { index: i, wallet, account, contracts, bridgeClaim: bridgeClaims[i] };
      }),
    );

    // 6. Create shared FpcClient
    fpcClient = new FpcClient({
      fpcAddress,
      operator,
      node,
      attestationBaseUrl: config.attestationBaseUrl,
    });

    pinoLogger.info(`[${LABEL}] setup complete — ${users.length} users ready`);
  });

  it(`${getConfig().concurrentN} concurrent cold starts`, async () => {
    pinoLogger.info(`[${LABEL}] starting ${users.length} concurrent cold starts`);

    const results = await Promise.all(
      users.map((u) =>
        fpcClient.executeColdStart({
          wallet: u.wallet,
          userAddress: u.account.address,
          tokenAddress,
          bridgeAddress,
          bridgeClaim: u.bridgeClaim,
        }),
      ),
    );

    for (const [i, r] of results.entries()) {
      pinoLogger.info(`[${LABEL}] user[${i}] cold-start tx=${r.txHash} fee=${r.txFee}`);
      expect(r.txHash).toBeTruthy();
      expect(r.txFee).toBeGreaterThan(0n);
    }
  });

  it(`${getConfig().concurrentN} concurrent account deployments`, async () => {
    pinoLogger.info(`[${LABEL}] starting ${users.length} concurrent account deployments`);

    const results = await Promise.all(
      users.map(async (u) => {
        const deployMethod = await u.account.accountManager.getDeployMethod();
        const { estimatedGas } = await deployMethod.simulate({
          from: AztecAddress.ZERO,
          fee: { estimateGas: true },
          skipClassPublication: true,
        });
        if (!estimatedGas) {
          throw new Error(`Failed to estimate gas for user[${u.index}] deploy`);
        }
        const pm = await fpcClient.createPaymentMethod({
          wallet: u.wallet,
          user: u.account.address,
          tokenAddress,
          estimatedGas,
        });
        const { receipt } = await deployMethod.send({
          from: AztecAddress.ZERO,
          fee: pm.fee,
          skipClassPublication: true,
        });
        return receipt.txHash;
      }),
    );

    for (const [i, txHash] of results.entries()) {
      pinoLogger.info(`[${LABEL}] user[${i}] account deployed tx=${txHash.toString()}`);
      expect(txHash).toBeTruthy();
    }
  });
});

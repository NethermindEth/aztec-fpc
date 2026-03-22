/**
 * Environment bootstrap for cold-start smoke tests.
 *
 * Connects to the Aztec node, registers accounts and contracts, waits for the
 * topup service to fund the FPC with FeeJuice, and exposes L1 infrastructure
 * so each test can bridge its own tokens independently.
 */

import path from "node:path";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { Contract } from "@aztec/aztec.js/contracts";
import type { L1ToL2TokenPortalManager } from "@aztec/aztec.js/ethereum";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { ExtendedViemWalletClient } from "@aztec/ethereum/types";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import pino from "pino";
import type { GetContractReturnType, Hex } from "viem";
import { resolveScriptAccounts } from "../common/script-credentials.ts";
import { setup as commonSetup, setupL1Infrastructure } from "../common/setup-helpers.ts";
import type { CliArgs } from "./cli.ts";

const pinoLogger = pino();

// ---------------------------------------------------------------------------
// TestContext — everything tests need
// ---------------------------------------------------------------------------

export type TestContext = {
  args: CliArgs;
  node: AztecNode;
  wallet: EmbeddedWallet;
  operator: AztecAddress;
  token: Contract;
  counter: Contract;
  fpcAddress: AztecAddress;
  tokenAddress: AztecAddress;
  bridgeAddress: AztecAddress;
  sponsoredFpcAddress: AztecAddress;
  l1WalletClient: ExtendedViemWalletClient;
  l1Erc20: GetContractReturnType;
  portalManager: L1ToL2TokenPortalManager;
};

// ---------------------------------------------------------------------------
// setup()
// ---------------------------------------------------------------------------

export async function setup(args: CliArgs): Promise<TestContext> {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const { manifest, node, wallet, operator, contracts, sponsoredFpcAddress } = await commonSetup(
    args,
    repoRoot,
    "cold-start-smoke",
  );

  const { token, fpc, counter, bridge } = contracts;

  if (!counter) {
    throw new Error("Manifest missing contracts.counter");
  }
  if (!bridge) {
    throw new Error("Manifest missing contracts.bridge");
  }
  if (!manifest.l1_contracts) {
    throw new Error("Manifest missing l1_contracts");
  }

  // Setup L1 accounts
  let l1PrivateKey: Hex;
  if (args.userL1PrivateKey) {
    l1PrivateKey = args.userL1PrivateKey as Hex;
    pinoLogger.info("[cold-start-smoke] using user-provided L1 private key");
  } else {
    ({ l1PrivateKey } = await resolveScriptAccounts(args.nodeUrl, args.l1RpcUrl, wallet, 0));
  }

  if (!args.l1DeployerKey) {
    throw new Error("Missing --l1-deployer-key or FPC_L1_DEPLOYER_KEY");
  }

  // Setup L1 infrastructure
  const { l1WalletClient, l1Erc20, portalManager } = await setupL1Infrastructure({
    l1RpcUrl: args.l1RpcUrl,
    l1PrivateKey,
    l1DeployerKey: args.l1DeployerKey,
    l1PortalAddress: manifest.l1_contracts.token_portal,
    l1Erc20Address: manifest.l1_contracts.erc20,
    node,
    loggerName: "cold-start:bridge",
  });

  return {
    args,
    node,
    wallet,
    operator,
    token,
    counter,
    fpcAddress: fpc.address,
    tokenAddress: token.address,
    bridgeAddress: bridge.address,
    sponsoredFpcAddress,
    l1WalletClient,
    l1Erc20,
    portalManager,
  };
}

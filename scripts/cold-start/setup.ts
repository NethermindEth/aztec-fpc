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
import { L1ToL2TokenPortalManager } from "@aztec/aztec.js/ethereum";
import type { AztecNode } from "@aztec/aztec.js/node";
import { createExtendedL1Client } from "@aztec/ethereum/client";
import type { ExtendedViemWalletClient } from "@aztec/ethereum/types";
import { EthAddress } from "@aztec/foundation/eth-address";
import { createLogger } from "@aztec/foundation/log";
import { TestERC20Abi } from "@aztec/l1-artifacts";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import pino from "pino";
import { type Chain, extractChain, type GetContractReturnType, getContract, type Hex } from "viem";
import * as viemChains from "viem/chains";
import { resolveScriptAccounts } from "../common/script-credentials.ts";
import { setup as commonSetup } from "../common/setup-helpers.ts";
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

  // Setup L1 infrastructure
  const l1PortalAddress = manifest.l1_contracts.token_portal;
  const l1Erc20Address = manifest.l1_contracts.erc20;

  const nodeInfo = await node.getNodeInfo();
  const l1Chain = extractChain({
    chains: Object.values(viemChains) as readonly Chain[],
    id: nodeInfo.l1ChainId,
  });
  const l1WalletClient = createExtendedL1Client([args.l1RpcUrl], l1PrivateKey, l1Chain);

  if (!args.l1DeployerKey) {
    throw new Error("Missing --l1-deployer-key or FPC_L1_DEPLOYER_KEY");
  }
  const l1MintClient = createExtendedL1Client([args.l1RpcUrl], args.l1DeployerKey, l1Chain);

  const l1Erc20 = getContract({
    address: l1Erc20Address as Hex,
    abi: TestERC20Abi,
    client: l1MintClient,
  });

  const portalManager = new L1ToL2TokenPortalManager(
    EthAddress.fromString(l1PortalAddress),
    EthAddress.fromString(l1Erc20Address),
    undefined,
    l1WalletClient,
    createLogger("cold-start:bridge"),
  );

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

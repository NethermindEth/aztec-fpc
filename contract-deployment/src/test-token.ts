import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract, type DeployOptions } from "@aztec/aztec.js/contracts";
import { L1ToL2TokenPortalManager } from "@aztec/aztec.js/ethereum";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import type { AztecNode } from "@aztec/aztec.js/node";
import { createExtendedL1Client } from "@aztec/ethereum/client";
import { EthAddress } from "@aztec/foundation/eth-address";
import { createLogger } from "@aztec/foundation/log";
import {
  TestERC20Abi,
  TestERC20Bytecode,
  TokenPortalAbi,
  TokenPortalBytecode,
} from "@aztec/l1-artifacts";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import pino from "pino";
import { type Chain, extractChain, type Hex } from "viem";
import * as viemChains from "viem/chains";
import { deployContract, loadArtifact, REQUIRED_ARTIFACTS } from "./deploy-utils.js";
import { type TestTokenManifest, writeTestTokenManifest } from "./test-token-manifest.js";

const logger = pino();

const DECIMAL_UINT_PATTERN = /^(0|[1-9][0-9]*)$/;
const HEX_FIELD_PATTERN = /^0x[0-9a-fA-F]+$/;

type FaucetEnvConfig = {
  dripAmount: bigint;
  cooldownSeconds: number;
  initialSupply: bigint;
};

function parseEnvPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}=${raw}. Expected a positive integer value.`);
  }
  return parsed;
}

function parseEnvPositiveBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (!DECIMAL_UINT_PATTERN.test(trimmed) && !HEX_FIELD_PATTERN.test(trimmed)) {
    throw new Error(`Invalid ${name}=${raw}. Expected a positive integer value.`);
  }
  const parsed = BigInt(trimmed);
  if (parsed <= 0n) {
    throw new Error(`Invalid ${name}=${raw}. Must be positive.`);
  }
  return parsed;
}

function readFaucetEnvConfig(): FaucetEnvConfig {
  const dripAmount = parseEnvPositiveBigInt(
    "FPC_FAUCET_DRIP_AMOUNT",
    1_000_000_000_000_000_000n, // 1 token (18 decimals)
  );

  const cooldownRaw = process.env.FPC_FAUCET_COOLDOWN_SECONDS;
  const cooldownSeconds = cooldownRaw
    ? ((): number => {
        const parsed = Number(cooldownRaw.trim());
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new Error(
            `FPC_FAUCET_COOLDOWN_SECONDS must be a non-negative integer, got ${cooldownRaw}`,
          );
        }
        return parsed;
      })()
    : 0;

  const initialSupply = process.env.FPC_FAUCET_INITIAL_SUPPLY
    ? parseEnvPositiveBigInt("FPC_FAUCET_INITIAL_SUPPLY", 0n)
    : dripAmount * 100n; // fund for 100 drips by default

  return { dripAmount, cooldownSeconds, initialSupply };
}

/**
 * Deploy a full test token stack: L1 ERC20 + TokenPortal, L2 TokenBridge +
 * Token + Faucet, and fund the faucet via the L1→L2 bridge.
 *
 * This is only used for testing/devnet — production deployments should provide
 * an existing --accepted-asset instead.
 */
export type TestTokenDeployDeps = {
  l1DeployerKey: string;
  l1RpcUrl: string;
  l1ChainId: number;
  l1RegistryAddress: string;
  wallet: EmbeddedWallet;
  node: AztecNode;
  operatorAddress: AztecAddress;
  deployOpts: DeployOptions;
};

export type TestTokenDeployParams = {
  name: string;
  symbol: string;
  decimals: number;
  outPath: string;
};

export async function deployTestToken(
  deps: TestTokenDeployDeps,
  params: TestTokenDeployParams,
): Promise<TestTokenManifest> {
  const l1WalletClient = createExtendedL1Client(
    [deps.l1RpcUrl],
    deps.l1DeployerKey as Hex,
    extractChain({ chains: Object.values(viemChains) as readonly Chain[], id: deps.l1ChainId }),
  );

  // ── Phase 0: Pre-compute all L2 addresses ──────────────────────────
  logger.info("[deploy-fpc-devnet] pre-computing L2 contract addresses");

  const tokenArtifact = loadArtifact(REQUIRED_ARTIFACTS.token);
  const bridgeArtifact = loadArtifact(REQUIRED_ARTIFACTS.tokenBridge);
  const bridgeDeploy = Contract.deploy(deps.wallet, bridgeArtifact, []);
  const bridgeInstance = await bridgeDeploy.getInstance();
  const bridgeAddress = bridgeInstance.address;

  const tokenDeploy = Contract.deploy(
    deps.wallet,
    tokenArtifact,
    [params.name, params.symbol, params.decimals, bridgeAddress, deps.operatorAddress],
    "constructor_with_minter",
  );
  const tokenInstance = await tokenDeploy.getInstance();
  const tokenAddress = tokenInstance.address;

  const faucetConfig = readFaucetEnvConfig();
  const faucetArtifact = loadArtifact(REQUIRED_ARTIFACTS.faucet);
  const faucetDeploy = Contract.deploy(deps.wallet, faucetArtifact, [
    tokenAddress,
    deps.operatorAddress,
    faucetConfig.dripAmount,
    faucetConfig.cooldownSeconds,
  ]);
  const faucetInstance = await faucetDeploy.getInstance();
  const faucetAddress = faucetInstance.address;

  const counterArtifact = loadArtifact(REQUIRED_ARTIFACTS.counter);
  const counterDeploy = Contract.deploy(
    deps.wallet,
    counterArtifact,
    [0, deps.operatorAddress],
    "initialize",
  );
  const counterInstance = await counterDeploy.getInstance();
  const counterAddress = counterInstance.address;

  logger.info(
    `[deploy-fpc-devnet] pre-computed: bridge=${bridgeAddress} token=${tokenAddress} faucet=${faucetAddress} counter=${counterAddress}`,
  );

  // ── Phase 1: L1 sequential (uses pre-computed addresses) ───────────

  // 1. Deploy L1 TestERC20
  const l1Erc20Hash = await l1WalletClient.deployContract({
    abi: TestERC20Abi,
    bytecode: TestERC20Bytecode as Hex,
    args: [params.name, params.symbol, l1WalletClient.account.address],
  });
  const l1Erc20Receipt = await l1WalletClient.waitForTransactionReceipt({ hash: l1Erc20Hash });
  if (!l1Erc20Receipt.contractAddress) {
    throw new Error("L1 TestERC20 deployment failed: no contract address in receipt");
  }
  const l1Erc20Address = l1Erc20Receipt.contractAddress;
  logger.info(`[deploy-fpc-devnet] l1_erc20 deployed. address=${l1Erc20Address}`);

  // 2. Deploy L1 TokenPortal
  const l1PortalHash = await l1WalletClient.deployContract({
    abi: TokenPortalAbi,
    bytecode: TokenPortalBytecode as Hex,
    args: [],
  });
  const l1PortalReceipt = await l1WalletClient.waitForTransactionReceipt({
    hash: l1PortalHash,
  });
  if (!l1PortalReceipt.contractAddress) {
    throw new Error("L1 TokenPortal deployment failed: no contract address in receipt");
  }
  const l1TokenPortalAddress = l1PortalReceipt.contractAddress;
  logger.info(`[deploy-fpc-devnet] l1_token_portal deployed. address=${l1TokenPortalAddress}`);

  // 3. Initialize L1 TokenPortal (uses pre-computed bridge address)
  const initHash = await l1WalletClient.writeContract({
    address: l1TokenPortalAddress as Hex,
    abi: TokenPortalAbi,
    functionName: "initialize",
    args: [deps.l1RegistryAddress as Hex, l1Erc20Address as Hex, bridgeAddress.toString() as Hex],
  });
  await l1WalletClient.waitForTransactionReceipt({ hash: initHash });
  logger.info("[deploy-fpc-devnet] l1 token portal initialized");

  // 4. Mint L1 ERC20
  const l1MintHash = await l1WalletClient.writeContract({
    address: l1Erc20Address as Hex,
    abi: TestERC20Abi,
    functionName: "mint",
    args: [l1WalletClient.account.address, faucetConfig.initialSupply],
  });
  await l1WalletClient.waitForTransactionReceipt({ hash: l1MintHash });

  // 5. Bridge tokens to L2 (uses pre-computed faucet address)
  logger.info(
    `[deploy-fpc-devnet] bridging tokens: bridgeTokensPublic(${faucetAddress}, ${faucetConfig.initialSupply})`,
  );
  const portalManager = new L1ToL2TokenPortalManager(
    EthAddress.fromString(l1TokenPortalAddress),
    EthAddress.fromString(l1Erc20Address),
    undefined,
    l1WalletClient,
    createLogger("deploy:bridge"),
  );
  const faucetBridgeClaim = await portalManager.bridgeTokensPublic(
    faucetAddress,
    faucetConfig.initialSupply,
  );

  // ── Phase 2: L2 batch 1 — bridge deploy + set_config (4 units) ────
  const bridgeContract = Contract.at(bridgeAddress, bridgeArtifact, deps.wallet);
  const bridgeDeployTxHash = await deployContract(
    deps.wallet,
    bridgeArtifact,
    bridgeDeploy,
    deps.deployOpts,
    [bridgeContract.methods.set_config(tokenAddress, EthAddress.fromString(l1TokenPortalAddress))],
  );
  logger.info("[deploy-fpc-devnet] L2 batch 1 completed (bridge deploy + set_config)");

  // ── Phase 3: L2 batch 2 — token deploy ─────────────────────────────
  const tokenDeployTxHash = await deployContract(
    deps.wallet,
    tokenArtifact,
    tokenDeploy,
    deps.deployOpts,
  );
  logger.info("[deploy-fpc-devnet] L2 batch 2 completed (token deploy)");

  // ── Phase 4: L2 batch 3 — counter deploy ───────────────────────────
  const counterDeployTxHash = await deployContract(
    deps.wallet,
    counterArtifact,
    counterDeploy,
    deps.deployOpts,
  );
  logger.info("[deploy-fpc-devnet] L2 batch 3 completed (counter deploy)");

  // ── Phase 5: Wait for L1→L2 message ───────────────────────────────
  const faucetMsgHash = Fr.fromHexString(faucetBridgeClaim.messageHash);
  await waitForL1ToL2MessageReady(deps.node, faucetMsgHash, {
    timeoutSeconds: parseEnvPositiveNumber("FPC_BRIDGE_TIMEOUT_SECONDS", 120),
  });
  logger.info("[deploy-fpc-devnet] L1→L2 message ready");

  // ── Phase 6: L2 batch 4 — faucet deploy + claim_public (4 units) ──
  const faucetDeployTxHash = await deployContract(
    deps.wallet,
    faucetArtifact,
    faucetDeploy,
    deps.deployOpts,
    [
      bridgeContract.methods.claim_public(
        faucetAddress,
        faucetBridgeClaim.claimAmount,
        faucetBridgeClaim.claimSecret,
        faucetBridgeClaim.messageLeafIndex,
      ),
    ],
  );
  logger.info(
    `[deploy-fpc-devnet] L2 batch 4 completed (faucet deploy + claim_public, ${faucetConfig.initialSupply} tokens)`,
  );

  const manifest: TestTokenManifest = {
    status: "deploy_ok",
    generated_at: new Date().toISOString(),
    contracts: {
      token: tokenAddress,
      faucet: faucetAddress,
      counter: counterAddress,
      bridge: bridgeAddress,
    },
    l1_contracts: {
      token_portal: EthAddress.fromString(l1TokenPortalAddress),
      erc20: EthAddress.fromString(l1Erc20Address),
    },
    faucet_config: {
      drip_amount: faucetConfig.dripAmount.toString(),
      cooldown_seconds: faucetConfig.cooldownSeconds,
      initial_supply: faucetConfig.initialSupply.toString(),
    },
    tx_hashes: {
      token_deploy: tokenDeployTxHash,
      bridge_deploy: bridgeDeployTxHash,
      counter_deploy: counterDeployTxHash,
      faucet_deploy: faucetDeployTxHash,
      l1_erc20_deploy: l1Erc20Hash,
      l1_token_portal_deploy: l1PortalHash,
    },
  };
  writeTestTokenManifest(params.outPath, manifest);
  logger.info(`[deploy-fpc-devnet] wrote test token manifest to ${params.outPath}`);

  return manifest;
}

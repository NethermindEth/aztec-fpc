import type { SponsoredRuntimeConfig } from "./types";

export const DEFAULT_NODE_URL = "https://v4-devnet-2.aztec-labs.com/";
export const DEFAULT_ATTESTATION_BASE_URL =
  "https://aztec-fpc.staging-nethermind.xyz/v2";
export const DEFAULT_TOKEN_ADDRESS =
  "0x10600e2f256b6500de5a79367d70b4c7d8121c408a2127dbcba995a1abc0d6f8";
export const DEFAULT_FPC_ADDRESS =
  "0x24a735808258519dc1637f1833202ea2dc7c829a0a82c73f61bbd195fce4105b";
export const DEFAULT_FAUCET_ADDRESS =
  "0x016fa39000902287772e653a9e6cc2026dbb0f97c08a4d1b2c51ebbad4a4b24f";
export const DEFAULT_COUNTER_ADDRESS =
  "0x226762b1e122bd46054de3fd21a19f0500ebe072aeac35fe0bb82d43b85f94fd";
export const DEFAULT_OPERATOR_ADDRESS =
  "0x18a15b90bea06cea7cbd06b3940533952aa9e5f94c157000c727321644d07af8";
export const DEFAULT_DA_GAS_LIMIT = 1_000_000;
export const DEFAULT_L2_GAS_LIMIT = 1_000_000;
export const DEFAULT_MINIMUM_PRIVATE_BALANCE_BUFFER = 1_000_000n;
export const DEFAULT_MAX_FAUCET_ATTEMPTS = 3;
export const DEFAULT_TX_WAIT_TIMEOUT_SECONDS = 180;

export const SDK_DEFAULTS = {
  nodeUrl: DEFAULT_NODE_URL,
  attestationBaseUrl: DEFAULT_ATTESTATION_BASE_URL,
  tokenAddress: DEFAULT_TOKEN_ADDRESS,
  fpcAddress: DEFAULT_FPC_ADDRESS,
  faucetAddress: DEFAULT_FAUCET_ADDRESS,
  counterAddress: DEFAULT_COUNTER_ADDRESS,
  operatorAddress: DEFAULT_OPERATOR_ADDRESS,
  daGasLimit: DEFAULT_DA_GAS_LIMIT,
  l2GasLimit: DEFAULT_L2_GAS_LIMIT,
  minimumPrivateBalanceBuffer: DEFAULT_MINIMUM_PRIVATE_BALANCE_BUFFER,
  maxFaucetAttempts: DEFAULT_MAX_FAUCET_ATTEMPTS,
  txWaitTimeoutSeconds: DEFAULT_TX_WAIT_TIMEOUT_SECONDS,
} as const;

export function createDevnetRuntimeConfig(): SponsoredRuntimeConfig {
  return {
    acceptedAsset: { address: SDK_DEFAULTS.tokenAddress },
    faucet: { address: SDK_DEFAULTS.faucetAddress },
    fpc: { address: SDK_DEFAULTS.fpcAddress },
    nodeUrl: SDK_DEFAULTS.nodeUrl,
    operatorAddress: SDK_DEFAULTS.operatorAddress,
    targets: {
      counter: { address: SDK_DEFAULTS.counterAddress },
    },
  };
}

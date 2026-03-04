export const SDK_DEFAULTS = {
  nodeUrl: "https://v4-devnet-2.aztec-labs.com/",
  attestationBaseUrl: "https://aztec-fpc.staging-nethermind.xyz/v2",
  tokenAddress:
    "0x10600e2f256b6500de5a79367d70b4c7d8121c408a2127dbcba995a1abc0d6f8",
  fpcAddress:
    "0x24a735808258519dc1637f1833202ea2dc7c829a0a82c73f61bbd195fce4105b",
  faucetAddress:
    "0x016fa39000902287772e653a9e6cc2026dbb0f97c08a4d1b2c51ebbad4a4b24f",
  counterAddress:
    "0x226762b1e122bd46054de3fd21a19f0500ebe072aeac35fe0bb82d43b85f94fd",
  operatorAddress:
    "0x18a15b90bea06cea7cbd06b3940533952aa9e5f94c157000c727321644d07af8",
  daGasLimit: 1_000_000,
  l2GasLimit: 1_000_000,
  minimumPrivateBalanceBuffer: 1_000_000n,
  maxFaucetAttempts: 3,
  txWaitTimeoutSeconds: 180,
} as const;

import type { NoirCompiledContract } from "@aztec/aztec.js/abi";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { Wallet as AccountWallet } from "@aztec/aztec.js/wallet";

export type CreateSponsoredCounterClientInput = {
  wallet: AccountWallet;
  account: AztecAddress | string;
};

export type SponsoredIncrementResult = {
  txHash: string;
  txFeeJuice: bigint;
  expectedCharge: bigint;
  userDebited: bigint;
  counterBefore: bigint;
  counterAfter: bigint;
  quoteValidUntil: bigint;
};

export type SponsoredCounterClient = {
  increment(): Promise<SponsoredIncrementResult>;
};

export type AttestationAcceptedAsset = {
  address: string;
  name: string;
};

export type ContractArtifactJson = NoirCompiledContract;

export type AttestationAcceptedAssetsResponse = AttestationAcceptedAsset[];

export type AttestationDiscoveryEndpoints = {
  accepted_assets?: string;
  asset?: string;
  discovery?: string;
  health?: string;
  quote?: string;
};

export type AttestationDiscoveryResponse = {
  attestation_api_version?: string;
  contract_variant?: string;
  discovery_version?: string;
  endpoints?: AttestationDiscoveryEndpoints;
  fpc_address?: string;
  network_id?: string;
  quote_base_url?: string;
  supported_assets?: AttestationAcceptedAsset[];
};

export type AcceptedAssetSelectionCallback = (
  supportedAssets: readonly AttestationAcceptedAsset[],
) =>
  | AttestationAcceptedAsset
  | AztecAddress
  | string
  | undefined
  | Promise<AttestationAcceptedAsset | AztecAddress | string | undefined>;

export type RuntimeContractConfig = {
  address?: AztecAddress | string;
  artifact?: ContractArtifactJson;
};

export type RuntimeFpcConfig = {
  address?: AztecAddress | string;
  artifact?: ContractArtifactJson;
};

export type SponsoredRuntimeConfig = {
  acceptedAsset: RuntimeContractConfig;
  faucet?: RuntimeContractConfig;
  fpc: RuntimeFpcConfig;
  nodeUrl: string;
  operatorAddress: AztecAddress | string;
  targets?: Record<string, RuntimeContractConfig>;
};

export type TokenSelectionConfig = {
  explicitAcceptedAsset?: AztecAddress | string;
  selector?: AcceptedAssetSelectionCallback;
};

export type SponsorshipConfig = {
  attestationBaseUrl: string;
  daGasLimit?: number;
  discoveryFpcAddress?: AztecAddress | string;
  fetchImpl?: typeof fetch;
  l2GasLimit?: number;
  maxFaucetAttempts?: number;
  minimumPrivateBalanceBuffer?: bigint;
  resolveFpcFromDiscovery?: boolean;
  runtimeConfig: SponsoredRuntimeConfig;
  tokenSelection?: TokenSelectionConfig;
  txWaitTimeoutSeconds?: number;
};

export type SponsoredCallContext = {
  acceptedAssetAddress: AztecAddress;
  contracts: {
    acceptedAsset: unknown;
    faucet?: unknown;
    fpc: unknown;
    node: unknown;
    targets: Record<string, unknown>;
  };
  user: AztecAddress;
};

export type SponsoredCallInteraction<TReceipt> = {
  send(args: {
    fee: {
      gasSettings: unknown;
      paymentMethod: unknown;
    };
    from: AztecAddress;
    wait: { timeout: number };
  }): Promise<TReceipt>;
};

export type SponsoredPostCheckContext<TReceipt> = {
  expectedCharge: bigint;
  fjAmount: bigint;
  receipt: TReceipt;
  user: AztecAddress;
  userDebited: bigint;
};

export type SponsoredExecutionResult<TReceipt> = {
  expectedCharge: bigint;
  fjAmount: bigint;
  quoteValidUntil: bigint;
  receipt: TReceipt;
  txFeeJuice: bigint;
  txHash: string;
  userDebited: bigint;
};

export type ExecuteSponsoredCallInput<TReceipt> = {
  account: AztecAddress | string;
  buildCall: (
    ctx: SponsoredCallContext,
  ) => Promise<SponsoredCallInteraction<TReceipt>>;
  postChecks?: (ctx: SponsoredPostCheckContext<TReceipt>) => Promise<void>;
  sponsorship: SponsorshipConfig;
  wallet: AccountWallet;
};

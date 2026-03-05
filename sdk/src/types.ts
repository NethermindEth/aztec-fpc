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

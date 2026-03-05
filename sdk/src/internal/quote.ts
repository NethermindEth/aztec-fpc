import { AztecAddress } from "@aztec/aztec.js/addresses";

import { QuoteValidationError } from "../errors";
import type {
  AcceptedAssetSelectionCallback,
  AttestationAcceptedAsset,
  AttestationDiscoveryResponse,
} from "../types";

export type QuoteResponse = {
  accepted_asset: string;
  fj_amount: string;
  aa_payment_amount: string;
  valid_until: string;
  signature: string;
};

export type ValidatedQuote = QuoteResponse & {
  aaPaymentAmount: bigint;
  fjAmount: bigint;
  signatureBytes: number[];
  validUntil: bigint;
};

export type ResolvedAcceptedAssets = {
  assets: AttestationAcceptedAsset[];
  discovery?: AttestationDiscoveryResponse;
  fpcAddress?: AztecAddress;
  source:
    | "accepted_assets_endpoint"
    | "discovery_supported_assets"
    | "legacy_asset_endpoint";
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseNonZeroAddress(raw: string): string {
  const parsed = AztecAddress.fromString(raw.trim());
  if (parsed.isZero()) {
    throw new Error("zero address");
  }
  return parsed.toString();
}

function parseAcceptedAssetCandidate(
  value: unknown,
): AttestationAcceptedAsset | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const address = value.address;
  const name = value.name;
  if (typeof address !== "string" || typeof name !== "string") {
    return undefined;
  }

  try {
    return {
      address: parseNonZeroAddress(address),
      name: name.trim(),
    };
  } catch {
    return undefined;
  }
}

function parseAcceptedAssetsPayload(
  payload: unknown,
): AttestationAcceptedAsset[] | undefined {
  if (!Array.isArray(payload)) {
    return undefined;
  }

  const assets = payload.map(parseAcceptedAssetCandidate);
  if (assets.some((asset) => asset === undefined)) {
    return undefined;
  }

  return assets as AttestationAcceptedAsset[];
}

function parseLegacyAssetPayload(
  payload: unknown,
): AttestationAcceptedAsset | undefined {
  return parseAcceptedAssetCandidate(payload);
}

function buildWellKnownDiscoveryUrl(attestationBaseUrl: string): string {
  const discoveryUrl = new URL(attestationBaseUrl);
  discoveryUrl.pathname = "/.well-known/fpc.json";
  discoveryUrl.search = "";
  discoveryUrl.hash = "";
  return discoveryUrl.toString();
}

function resolveEndpointUrl(
  attestationBaseUrl: string,
  endpointPath: string,
): string {
  const trimmedPath = endpointPath.trim();
  if (!trimmedPath) {
    throw new QuoteValidationError("Attestation endpoint path is empty.", {
      attestationBaseUrl,
      endpointPath,
    });
  }

  let absoluteUrl: URL | undefined;
  try {
    absoluteUrl = new URL(trimmedPath);
  } catch {
    absoluteUrl = undefined;
  }
  if (absoluteUrl) {
    return absoluteUrl.toString();
  }

  const endpointUrl = new URL(attestationBaseUrl);
  const basePath = endpointUrl.pathname.replace(/\/+$/u, "");
  endpointUrl.pathname = trimmedPath.startsWith("/")
    ? trimmedPath
    : `${basePath}/${trimmedPath}`;
  endpointUrl.search = "";
  endpointUrl.hash = "";
  return endpointUrl.toString();
}

async function fetchJsonPayload(input: {
  fetchImpl: typeof fetch;
  url: string;
}): Promise<unknown | undefined> {
  try {
    const response = await input.fetchImpl(input.url);
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function parseDiscoveryPayload(payload: unknown):
  | AttestationDiscoveryResponse
  | undefined {
  if (!isObject(payload)) {
    return undefined;
  }
  return payload as AttestationDiscoveryResponse;
}

export async function fetchAttestationDiscovery(input: {
  attestationBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<AttestationDiscoveryResponse | undefined> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const discoveryUrl = buildWellKnownDiscoveryUrl(input.attestationBaseUrl);
  const discoveryPayload = await fetchJsonPayload({
    fetchImpl,
    url: discoveryUrl,
  });
  return parseDiscoveryPayload(discoveryPayload);
}

export function resolveDiscoveryFpcAddress(input: {
  discovery?: AttestationDiscoveryResponse;
  required?: boolean;
}): AztecAddress | undefined {
  const required = input.required ?? false;
  const rawFpcAddress = input.discovery?.fpc_address?.trim();

  if (!rawFpcAddress) {
    if (required) {
      throw new QuoteValidationError(
        "Discovery payload is missing required fpc_address.",
      );
    }
    return undefined;
  }

  try {
    const parsed = AztecAddress.fromString(rawFpcAddress);
    if (parsed.isZero()) {
      throw new Error("zero address");
    }
    return parsed;
  } catch {
    if (required) {
      throw new QuoteValidationError("Discovery fpc_address is invalid.", {
        fpcAddress: rawFpcAddress,
      });
    }
    return undefined;
  }
}

export async function resolveAcceptedAssetsAndDiscovery(input: {
  attestationBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<ResolvedAcceptedAssets> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const discovery = await fetchAttestationDiscovery({
    attestationBaseUrl: input.attestationBaseUrl,
    fetchImpl,
  });

  const acceptedAssetsPath =
    discovery?.endpoints?.accepted_assets ?? "/accepted-assets";
  const acceptedAssetsUrl = resolveEndpointUrl(
    input.attestationBaseUrl,
    acceptedAssetsPath,
  );
  const acceptedAssetsPayload = await fetchJsonPayload({
    fetchImpl,
    url: acceptedAssetsUrl,
  });
  const acceptedAssets = parseAcceptedAssetsPayload(acceptedAssetsPayload);
  if (acceptedAssets && acceptedAssets.length > 0) {
    return {
      assets: acceptedAssets,
      discovery,
      fpcAddress: resolveDiscoveryFpcAddress({ discovery }),
      source: "accepted_assets_endpoint",
    };
  }

  const discoveryAssets = parseAcceptedAssetsPayload(discovery?.supported_assets);
  if (discoveryAssets && discoveryAssets.length > 0) {
    return {
      assets: discoveryAssets,
      discovery,
      fpcAddress: resolveDiscoveryFpcAddress({ discovery }),
      source: "discovery_supported_assets",
    };
  }

  const legacyAssetPath = discovery?.endpoints?.asset ?? "/asset";
  const legacyAssetUrl = resolveEndpointUrl(input.attestationBaseUrl, legacyAssetPath);
  const legacyAssetPayload = await fetchJsonPayload({
    fetchImpl,
    url: legacyAssetUrl,
  });
  const legacyAsset = parseLegacyAssetPayload(legacyAssetPayload);
  if (legacyAsset) {
    return {
      assets: [legacyAsset],
      discovery,
      fpcAddress: resolveDiscoveryFpcAddress({ discovery }),
      source: "legacy_asset_endpoint",
    };
  }

  throw new QuoteValidationError(
    "Unable to resolve accepted assets from attestation metadata.",
    {
      attestationBaseUrl: input.attestationBaseUrl,
    },
  );
}

function resolveSelectedAddress(input: {
  selection:
    | AttestationAcceptedAsset
    | AztecAddress
    | string
    | undefined;
}): string | undefined {
  const selection = input.selection;
  if (!selection) {
    return undefined;
  }

  if (typeof selection === "string") {
    return parseNonZeroAddress(selection);
  }
  if (selection instanceof AztecAddress) {
    if (selection.isZero()) {
      throw new QuoteValidationError("Selected accepted asset cannot be zero.");
    }
    return selection.toString();
  }
  return parseNonZeroAddress(selection.address);
}

function findSupportedAssetByAddress(input: {
  address: string;
  supportedAssets: readonly AttestationAcceptedAsset[];
}): AttestationAcceptedAsset | undefined {
  return input.supportedAssets.find(
    (asset) => asset.address.toLowerCase() === input.address.toLowerCase(),
  );
}

export async function selectAcceptedAsset(input: {
  explicitAcceptedAsset?: AztecAddress | string;
  selector?: AcceptedAssetSelectionCallback;
  supportedAssets: readonly AttestationAcceptedAsset[];
}): Promise<AztecAddress> {
  if (input.supportedAssets.length === 0) {
    throw new QuoteValidationError("Accepted asset list is empty.");
  }

  const explicitAddress = input.explicitAcceptedAsset
    ? resolveSelectedAddress({ selection: input.explicitAcceptedAsset })
    : undefined;
  if (explicitAddress) {
    const explicitAsset = findSupportedAssetByAddress({
      address: explicitAddress,
      supportedAssets: input.supportedAssets,
    });
    if (!explicitAsset) {
      throw new QuoteValidationError(
        "Explicit accepted asset is not supported by attestation.",
        {
          acceptedAsset: explicitAddress,
        },
      );
    }
    return AztecAddress.fromString(explicitAsset.address);
  }

  if (input.selector) {
    const selectedCandidate = await input.selector(input.supportedAssets);
    const selectedAddress = resolveSelectedAddress({ selection: selectedCandidate });
    if (!selectedAddress) {
      throw new QuoteValidationError(
        "Accepted asset selector did not return a selection.",
      );
    }

    const selectedAsset = findSupportedAssetByAddress({
      address: selectedAddress,
      supportedAssets: input.supportedAssets,
    });
    if (!selectedAsset) {
      throw new QuoteValidationError(
        "Accepted asset selector returned an unsupported asset.",
        {
          selectedAddress,
        },
      );
    }

    return AztecAddress.fromString(selectedAsset.address);
  }

  return AztecAddress.fromString(input.supportedAssets[0].address);
}

export function buildQuoteUrl(input: {
  acceptedAsset: AztecAddress;
  attestationBaseUrl: string;
  fjAmount: bigint;
  user: AztecAddress;
}): string {
  const quoteUrl = new URL(input.attestationBaseUrl);
  const normalizedPath = quoteUrl.pathname.replace(/\/+$/u, "");
  quoteUrl.pathname = normalizedPath.endsWith("/quote")
    ? normalizedPath
    : `${normalizedPath}/quote`;
  quoteUrl.searchParams.set("user", input.user.toString());
  quoteUrl.searchParams.set("accepted_asset", input.acceptedAsset.toString());
  quoteUrl.searchParams.set("fj_amount", input.fjAmount.toString());
  return quoteUrl.toString();
}

function decodeSignature(signatureHex: string): number[] {
  const normalized = signatureHex.startsWith("0x")
    ? signatureHex.slice(2)
    : signatureHex;
  if (!/^[0-9a-fA-F]*$/u.test(normalized)) {
    throw new QuoteValidationError("Quote signature is not valid hex.", {
      signature: signatureHex,
    });
  }
  if (normalized.length % 2 !== 0) {
    throw new QuoteValidationError("Quote signature hex has odd length.", {
      signature: signatureHex,
    });
  }
  const bytes = Array.from(Buffer.from(normalized, "hex"));
  if (bytes.length !== 64) {
    throw new QuoteValidationError("Quote signature must be 64 bytes.", {
      actualLength: bytes.length,
    });
  }
  return bytes;
}

export function validateQuote(input: {
  expectedAcceptedAsset: AztecAddress;
  expectedFjAmount: bigint;
  quote: QuoteResponse;
}): ValidatedQuote {
  if (
    input.quote.accepted_asset.toLowerCase() !==
    input.expectedAcceptedAsset.toString().toLowerCase()
  ) {
    throw new QuoteValidationError("Quote accepted_asset mismatch.", {
      expectedAcceptedAsset: input.expectedAcceptedAsset.toString(),
      gotAcceptedAsset: input.quote.accepted_asset,
    });
  }

  let fjAmount: bigint;
  try {
    fjAmount = BigInt(input.quote.fj_amount);
  } catch {
    throw new QuoteValidationError("Quote fj_amount is not a valid integer.", {
      value: input.quote.fj_amount,
    });
  }
  if (fjAmount !== input.expectedFjAmount) {
    throw new QuoteValidationError("Quote fj_amount mismatch.", {
      expectedFjAmount: input.expectedFjAmount.toString(),
      gotFjAmount: input.quote.fj_amount,
    });
  }

  let aaPaymentAmount: bigint;
  try {
    aaPaymentAmount = BigInt(input.quote.aa_payment_amount);
  } catch {
    throw new QuoteValidationError(
      "Quote aa_payment_amount is not a valid integer.",
      {
        value: input.quote.aa_payment_amount,
      },
    );
  }

  let validUntil: bigint;
  try {
    validUntil = BigInt(input.quote.valid_until);
  } catch {
    throw new QuoteValidationError(
      "Quote valid_until is not a valid integer.",
      {
        value: input.quote.valid_until,
      },
    );
  }

  const signatureBytes = decodeSignature(input.quote.signature);
  return {
    ...input.quote,
    aaPaymentAmount,
    fjAmount,
    signatureBytes,
    validUntil,
  };
}

export async function fetchAndValidateQuote(input: {
  acceptedAsset: AztecAddress;
  attestationBaseUrl: string;
  fetchImpl?: typeof fetch;
  fjAmount: bigint;
  user: AztecAddress;
}): Promise<ValidatedQuote> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = buildQuoteUrl({
    acceptedAsset: input.acceptedAsset,
    attestationBaseUrl: input.attestationBaseUrl,
    fjAmount: input.fjAmount,
    user: input.user,
  });

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new QuoteValidationError(
      `Quote request failed with status ${response.status}.`,
      {
        status: response.status,
        url,
      },
    );
  }

  const quote = (await response.json()) as QuoteResponse;
  return validateQuote({
    expectedAcceptedAsset: input.acceptedAsset,
    expectedFjAmount: input.fjAmount,
    quote,
  });
}

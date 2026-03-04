import { AztecAddress } from "@aztec/aztec.js/addresses";

import { QuoteValidationError } from "../errors";

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
    throw new QuoteValidationError("Quote valid_until is not a valid integer.", {
      value: input.quote.valid_until,
    });
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

/**
 * Quote signing using inline Schnorr signatures.
 *
 * The FPC contract verifies quote signatures directly using the operator's
 * stored public key — no cross-circuit authwit call is needed.
 *
 * Quote hash preimage (matches assert_valid_quote in main.nr):
 *   computeInnerAuthWitHash([DOMAIN_SEP, fpc_address, accepted_asset,
 *     fj_fee_amount, aa_payment_amount, valid_until, user_address])
 *
 * All quotes are user-specific: user_address = msg_sender (never zero).
 *
 * The operator signs quote_hash.toBuffer() with their Schnorr key. The
 * resulting 64-byte signature is returned to the user as a hex string and
 * included in the fee_entrypoint function arguments.
 */

import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { computeInnerAuthWitHash } from "@aztec/stdlib/auth-witness";

// Must match QUOTE_DOMAIN_SEPARATOR in main.nr ("FPC" = 0x465043)
const QUOTE_DOMAIN_SEPARATOR = Fr.fromHexString("0x465043");

export interface QuoteParams {
  fpcAddress: AztecAddress;
  acceptedAsset: AztecAddress;
  fjFeeAmount: bigint;
  aaPaymentAmount: bigint;
  validUntil: bigint;
  /** The user's Aztec address. Always non-zero — all quotes are user-specific. */
  userAddress: AztecAddress;
}

/** Signs a quote hash with Schnorr and returns the raw 64-byte signature as hex. */
export interface QuoteSchnorrSigner {
  signQuoteHash(quoteHash: Fr): Promise<string>;
}

/**
 * Compute the quote hash, matching the contract's hash computation.
 *
 * Uses computeInnerAuthWitHash for the poseidon2 hash with separator,
 * keeping the hash preimage format identical to the on-chain computation.
 */
export function computeQuoteHash(params: QuoteParams): Promise<Fr> {
  return computeInnerAuthWitHash([
    QUOTE_DOMAIN_SEPARATOR,
    params.fpcAddress.toField(),
    params.acceptedAsset.toField(),
    new Fr(params.fjFeeAmount),
    new Fr(params.aaPaymentAmount),
    new Fr(params.validUntil),
    params.userAddress.toField(),
  ]);
}

/**
 * Compute the quote hash and sign it with the operator's Schnorr key.
 * Returns the 64-byte signature as a hex string.
 */
export async function signQuote(
  signer: QuoteSchnorrSigner,
  params: QuoteParams,
): Promise<string> {
  const quoteHash = await computeQuoteHash(params);
  return signer.signQuoteHash(quoteHash);
}

// ── Backward-compatible aliases ──────────────────────────────────────────────
// Keep the old name available so existing imports don't break during migration.
export const computeQuoteInnerHash = computeQuoteHash;

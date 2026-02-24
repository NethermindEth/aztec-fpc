/**
 * Quote signing using the Aztec authwit mechanism.
 *
 * The FPC contract verifies quotes with assert_inner_hash_valid_authwit,
 * which checks that the operator account has approved a specific inner hash.
 *
 * Inner hash preimage (matches assert_valid_quote in main.nr):
 *   poseidon2([DOMAIN_SEP, fpc_address, accepted_asset, rate_num, rate_den, valid_until, user_address])
 *
 * All quotes are user-specific: user_address = msg_sender (never zero).
 *
 * The outer auth-witness message hash wraps this with chain context:
 *   poseidon2([consumer (= fpc_address), chain_id, version, inner_hash])
 *
 * The wallet signs the outer message hash. The resulting AuthWitness is returned
 * to the user as part of the quote response and included in their transaction's
 * authWitnesses array.
 */

import { AztecAddress, Fr } from '@aztec/aztec.js';
import { computeInnerAuthWitHash } from '@aztec/stdlib/auth-witness';
import type { AccountWallet } from '@aztec/aztec.js';

// Must match QUOTE_DOMAIN_SEPARATOR in main.nr ("FPC" = 0x465043)
const QUOTE_DOMAIN_SEPARATOR = Fr.fromHexString('0x465043');

export interface QuoteParams {
  fpcAddress: AztecAddress;
  acceptedAsset: AztecAddress;
  rateNum: bigint;
  rateDen: bigint;
  validUntil: bigint;
  /** The user's Aztec address. Always non-zero — all quotes are user-specific. */
  userAddress: AztecAddress;
}

/**
 * Compute the inner hash for a quote, matching the contract's
 * compute_inner_authwit_hash([DOMAIN_SEP, fpc, accepted_asset, rate_num, rate_den, valid_until, user]).
 */
export function computeQuoteInnerHash(params: QuoteParams): Fr {
  return computeInnerAuthWitHash([
    QUOTE_DOMAIN_SEPARATOR,
    params.fpcAddress.toField(),
    params.acceptedAsset.toField(),
    new Fr(params.rateNum),
    new Fr(params.rateDen),
    new Fr(params.validUntil),
    params.userAddress.toField(),
  ]);
}

/**
 * Sign a quote with the operator wallet and return the AuthWitness as a hex string.
 *
 * The witness is serialised to hex for HTTP transport. The user's SDK
 * deserialises it and adds it to their transaction's authWitnesses array.
 */
export async function signQuote(
  wallet: AccountWallet,
  params: QuoteParams,
): Promise<string> {
  const innerHash = computeQuoteInnerHash(params);

  const authwit = await wallet.createAuthWit(wallet.getAddress(), {
    consumer: params.fpcAddress,
    innerHash,
  });

  return authwit.toString();
}

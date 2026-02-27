use aztec::{
    authwit::auth::compute_inner_authwit_hash,
    context::PrivateContext,
    oracle::nullifiers::check_nullifier_exists,
    protocol::{address::AztecAddress, traits::ToField},
};
use std::embedded_curve_ops::EmbeddedCurvePoint;

pub global QUOTE_DOMAIN_SEPARATOR: Field = 0x465043; // "FPC"

/// Build the quote hash from its preimage.
///
/// Quote preimage:
///   poseidon2([DOMAIN_SEP, fpc_address, accepted_asset, rate_num, rate_den,
///              valid_until, user_address])
pub fn compute_quote_hash(
    fpc_address: AztecAddress,
    accepted_asset: AztecAddress,
    rate_num: u128,
    rate_den: u128,
    valid_until: u64,
    user_address: AztecAddress,
) -> Field {
    compute_inner_authwit_hash([
        QUOTE_DOMAIN_SEPARATOR,
        fpc_address.to_field(),
        accepted_asset.to_field(),
        rate_num as Field,
        rate_den as Field,
        valid_until as Field,
        user_address.to_field(),
    ])
}

/// Verify the operator's Schnorr signature over the quote, prevent replay,
/// and assert the quote has not expired.
///
/// Returns the anchor block timestamp so callers can apply additional checks
/// (e.g. an upper-bound TTL) without a second context read.
pub fn assert_valid_quote(
    context: &mut PrivateContext,
    operator_pubkey: EmbeddedCurvePoint,
    accepted_asset: AztecAddress,
    rate_num: u128,
    rate_den: u128,
    valid_until: u64,
    user_address: AztecAddress,
    quote_sig: [u8; 64],
) -> u64 {
    let quote_hash = compute_quote_hash(
        context.this_address(),
        accepted_asset,
        rate_num,
        rate_den,
        valid_until,
        user_address,
    );

    assert(
        schnorr::verify_signature(operator_pubkey, quote_sig, quote_hash.to_be_bytes::<32>()),
        "invalid quote signature",
    );

    // Safety: best-effort pre-check for a clearer replay error before the
    // canonical duplicate-nullifier protection.
    let quote_already_used = unsafe { check_nullifier_exists(quote_hash) };
    assert(!quote_already_used, "quote already used");

    // Prevent replay.
    context.push_nullifier(quote_hash);

    let anchor_ts = context.get_anchor_block_header().global_variables.timestamp;
    assert(anchor_ts <= valid_until, "quote expired");
    context.set_expiration_timestamp(valid_until);

    anchor_ts // returned so callers can add their own TTL upper-bound check
}

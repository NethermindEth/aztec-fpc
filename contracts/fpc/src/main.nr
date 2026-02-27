mod fee_math;
mod test;

use ::aztec::macros::aztec;

/// Fee Payment Contract -- Multi-Asset Variant
///
/// Unlike the standard FPC which hardcodes `accepted_asset` at deploy time,
/// this variant accepts the asset as a per-quote parameter. The user specifies
/// which asset they want to pay with when requesting a quote, the operator
/// signs a quote binding that asset+rate, and `fee_entrypoint` accepts the
/// asset as an argument.
///
/// Security is preserved because the quote hash includes the asset in its
/// preimage -- the operator's Schnorr signature binds the rate to a specific
/// asset.
///
/// ## Storage
///
/// - config            (PublicImmutable<Config>) -- packed immutable config
///                                                  containing operator address
///                                                  and operator signing key.
#[aztec]
pub contract FPCMultiAsset {
    use crate::fee_math::fee_juice_to_asset;
    use aztec::{
        authwit::auth::compute_inner_authwit_hash,
        context::PrivateContext,
        macros::{functions::{allow_phase_change, external, initializer}, storage::storage},
        oracle::nullifiers::check_nullifier_exists,
        protocol::{address::AztecAddress, traits::{Deserialize, Packable, Serialize, ToField}},
        state_vars::PublicImmutable,
    };
    use std::embedded_curve_ops::EmbeddedCurvePoint;
    use token::Token;

    global QUOTE_DOMAIN_SEPARATOR: Field = 0x465043;
    // Quotes must expire within this many seconds from the tx anchor timestamp.
    global MAX_QUOTE_TTL_SECONDS: u64 = 3600;

    /// Packed configuration stored as a single PublicImmutable slot.
    /// 3 fields (no accepted_asset -- that is now a per-quote parameter).
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct Config {
        operator: AztecAddress,
        /// Operator signing public key x coordinate.
        operator_pubkey_x: Field,
        /// Operator signing public key y coordinate.
        operator_pubkey_y: Field,
    }

    // =========================================================================
    // Storage
    // =========================================================================

    #[storage]
    struct Storage<Context> {
        config: PublicImmutable<Config, Context>,
    }

    // =========================================================================
    // Constructor
    // =========================================================================

    #[external("public")]
    #[initializer]
    fn constructor(
        operator: AztecAddress,
        operator_pubkey_x: Field,
        operator_pubkey_y: Field,
    ) {
        assert(!operator.is_zero(), "invalid operator");
        // Basic on-curve check: y^2 = x^3 - 17 (Grumpkin)
        assert(
            operator_pubkey_y * operator_pubkey_y
                == operator_pubkey_x * operator_pubkey_x * operator_pubkey_x - 17,
            "operator pubkey not on curve",
        );
        self.storage.config.initialize(
            Config { operator, operator_pubkey_x, operator_pubkey_y },
        );
    }

    // =========================================================================
    // Fee entrypoint
    //
    // Transfers the fee charge from the user's private balance directly to the
    // operator's private balance. The quote signature is verified inline using
    // the operator's stored public key -- no cross-circuit authwit call needed.
    // =========================================================================

    #[external("private")]
    #[allow_phase_change]
    fn fee_entrypoint(
        accepted_asset: AztecAddress,
        authwit_nonce: Field,
        rate_num: u128,
        rate_den: u128,
        valid_until: u64,
        quote_sig: [u8; 64],
    ) {
        let config = self.storage.config.read();
        let sender = self.msg_sender();
        assert(rate_num > (0 as u128), "rate_num must be > 0");

        assert_valid_quote(
            self.context,
            EmbeddedCurvePoint {
                x: config.operator_pubkey_x,
                y: config.operator_pubkey_y,
                is_infinite: false,
            },
            accepted_asset,
            rate_num,
            rate_den,
            valid_until,
            sender,
            quote_sig,
        );

        let charge = fee_juice_to_asset(
            get_max_gas_cost_no_teardown(self.context),
            rate_num,
            rate_den,
        );

        Token::at(accepted_asset)
            .transfer_private_to_private(sender, config.operator, charge, authwit_nonce)
            .call(self.context);

        self.context.set_as_fee_payer();
        if !self.context.in_revertible_phase() {
            self.context.end_setup();
        }
    }

    // =========================================================================
    // Internal helpers
    // =========================================================================

    /// Compute the quote hash and verify the operator's Schnorr signature
    /// inline. Pushes a nullifier to prevent replay.
    ///
    /// Quote preimage (hashed with compute_inner_authwit_hash for compatibility):
    ///   poseidon2([DOMAIN_SEP, fpc_address, accepted_asset, rate_num, rate_den,
    ///              valid_until, user_address])
    #[contract_library_method]
    fn assert_valid_quote(
        context: &mut PrivateContext,
        operator_pubkey: EmbeddedCurvePoint,
        accepted_asset: AztecAddress,
        rate_num: u128,
        rate_den: u128,
        valid_until: u64,
        user_address: AztecAddress,
        quote_sig: [u8; 64],
    ) {
        let quote_hash = compute_inner_authwit_hash([
            QUOTE_DOMAIN_SEPARATOR,
            context.this_address().to_field(),
            accepted_asset.to_field(),
            rate_num as Field,
            rate_den as Field,
            valid_until as Field,
            user_address.to_field(),
        ]);

        assert(
            schnorr::verify_signature(operator_pubkey, quote_sig, quote_hash.to_be_bytes::<32>()),
            "invalid quote signature",
        );

        // Safety: this is only used as a best-effort pre-check for a clearer
        // replay error before the canonical duplicate-nullifier protection.
        let quote_already_used = unsafe { check_nullifier_exists(quote_hash) };
        assert(!quote_already_used, "quote already used");

        // Prevent replay: the quote hash is unique per (fpc, asset, rate, expiry, user).
        context.push_nullifier(quote_hash);

        let anchor_ts = context.get_anchor_block_header().global_variables.timestamp;
        assert(anchor_ts <= valid_until, "quote expired");
        let quote_ttl = valid_until - anchor_ts;
        assert(quote_ttl <= MAX_QUOTE_TTL_SECONDS, "quote ttl too large");
        context.set_expiration_timestamp(valid_until);
    }

    /// Maximum possible fee for this tx excluding teardown gas.
    #[contract_library_method]
    fn get_max_gas_cost_no_teardown(context: &mut PrivateContext) -> u128 {
        let s = context.gas_settings();
        s.max_fees_per_gas.fee_per_da_gas * (s.gas_limits.da_gas as u128)
            + s.max_fees_per_gas.fee_per_l2_gas * (s.gas_limits.l2_gas as u128)
    }
}

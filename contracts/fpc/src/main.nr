mod fee_math;
mod test;

use ::aztec::macros::aztec;

/// Fee Payment Contract -- Multi-Asset Variant
///
/// Unlike the standard FPC which hardcodes `accepted_asset` at deploy time,
/// this variant accepts the asset as a per-quote parameter. The user specifies
/// which asset they want to pay with when requesting a quote, the operator
/// signs a quote binding that asset+exact amounts, and `fee_entrypoint` accepts the
/// asset as an argument.
///
/// Security is preserved because the quote hash includes the asset in its
/// preimage -- the operator's Schnorr signature binds the quoted amounts to a
/// specific asset.
///
/// ## Storage
///
/// - config            (PublicImmutable<Config>) -- packed immutable config
///                                                  containing operator address,
///                                                  operator signing key, and
///                                                  sponsor signing key.
#[aztec]
pub contract FPCMultiAsset {
    use aztec::{
        authwit::auth::compute_inner_authwit_hash,
        context::PrivateContext,
        macros::{functions::{allow_phase_change, external, initializer}, storage::storage},
        protocol::{address::AztecAddress, traits::{Deserialize, Packable, Serialize, ToField}},
        state_vars::PublicImmutable,
    };
    use std::embedded_curve_ops::EmbeddedCurvePoint;
    use token::Token;

    // "FPC" -- domain separator for paid quote hashes.
    global QUOTE_DOMAIN_SEPARATOR: Field = 0x465043;
    // "FPCS" -- domain separator for sponsored quote hashes.
    global SPONSORED_QUOTE_DOMAIN_SEPARATOR: Field = 0x46504353;
    // Quotes must expire within this many seconds from the tx anchor timestamp.
    global MAX_QUOTE_TTL_SECONDS: u64 = 3600;

    /// Packed configuration stored as a single PublicImmutable slot.
    /// 5 fields (no accepted_asset -- that is now a per-quote parameter).
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct Config {
        operator: AztecAddress,
        /// Operator signing public key x coordinate (paid quotes).
        operator_pubkey_x: Field,
        /// Operator signing public key y coordinate (paid quotes).
        operator_pubkey_y: Field,
        /// Sponsor signing public key x coordinate (sponsored quotes).
        sponsor_pubkey_x: Field,
        /// Sponsor signing public key y coordinate (sponsored quotes).
        sponsor_pubkey_y: Field,
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
        sponsor_pubkey_x: Field,
        sponsor_pubkey_y: Field,
    ) {
        assert(!operator.is_zero(), "invalid operator");
        assert(
            operator_pubkey_y * operator_pubkey_y
                == operator_pubkey_x * operator_pubkey_x * operator_pubkey_x - 17,
            "operator pubkey not on curve",
        );
        assert(
            sponsor_pubkey_y * sponsor_pubkey_y
                == sponsor_pubkey_x * sponsor_pubkey_x * sponsor_pubkey_x - 17,
            "sponsor pubkey not on curve",
        );
        self.storage.config.initialize(
            Config {
                operator,
                operator_pubkey_x,
                operator_pubkey_y,
                sponsor_pubkey_x,
                sponsor_pubkey_y,
            },
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
        fj_fee_amount: u128,
        aa_payment_amount: u128,
        valid_until: u64,
        quote_sig: [u8; 64],
    ) {
        let max_fees = self.context.gas_settings().max_fees_per_gas;
        let enforce_setup_phase = (max_fees.fee_per_da_gas > 0) | (max_fees.fee_per_l2_gas > 0);
        if enforce_setup_phase {
            assert(!self.context.in_revertible_phase(), "fee_entrypoint must run in setup phase");
        }

        let config = self.storage.config.read();
        let sender = self.msg_sender();

        assert_valid_quote(
            self.context,
            EmbeddedCurvePoint {
                x: config.operator_pubkey_x,
                y: config.operator_pubkey_y,
                is_infinite: false,
            },
            accepted_asset,
            fj_fee_amount,
            aa_payment_amount,
            valid_until,
            sender,
            quote_sig,
        );

        let max_fee = get_max_gas_cost_no_teardown(self.context);
        assert(fj_fee_amount == max_fee, "quoted fee amount mismatch");

        Token::at(accepted_asset)
            .transfer_private_to_private(sender, config.operator, aa_payment_amount, authwit_nonce)
            .call(self.context);

        self.context.set_as_fee_payer();
        if enforce_setup_phase | !self.context.in_revertible_phase() {
            self.context.end_setup();
        }
    }

    // =========================================================================
    // Sponsored fee entrypoint
    //
    // Covers the user's Fee Juice cost without any token transfer. The sponsor
    // key (separate from the operator key) must sign the sponsored quote.
    // =========================================================================

    #[external("private")]
    #[allow_phase_change]
    fn fee_entrypoint_sponsored(
        accepted_asset: AztecAddress,
        fj_fee_amount: u128,
        valid_until: u64,
        quote_sig: [u8; 64],
    ) {
        let max_fees = self.context.gas_settings().max_fees_per_gas;
        let enforce_setup_phase = (max_fees.fee_per_da_gas > 0) | (max_fees.fee_per_l2_gas > 0);
        if enforce_setup_phase {
            assert(
                !self.context.in_revertible_phase(),
                "fee_entrypoint_sponsored must run in setup phase",
            );
        }

        let config = self.storage.config.read();
        let sender = self.msg_sender();

        assert_valid_sponsored_quote(
            self.context,
            EmbeddedCurvePoint {
                x: config.sponsor_pubkey_x,
                y: config.sponsor_pubkey_y,
                is_infinite: false,
            },
            accepted_asset,
            fj_fee_amount,
            valid_until,
            sender,
            quote_sig,
        );

        let max_fee = get_max_gas_cost_no_teardown(self.context);
        assert(fj_fee_amount == max_fee, "quoted fee amount mismatch");

        self.context.set_as_fee_payer();
        if enforce_setup_phase | !self.context.in_revertible_phase() {
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
    ///   poseidon2([DOMAIN_SEP, fpc_address, accepted_asset, fj_fee_amount, aa_payment_amount,
    ///              valid_until, user_address])
    #[contract_library_method]
    fn assert_valid_quote(
        context: &mut PrivateContext,
        operator_pubkey: EmbeddedCurvePoint,
        accepted_asset: AztecAddress,
        fj_fee_amount: u128,
        aa_payment_amount: u128,
        valid_until: u64,
        user_address: AztecAddress,
        quote_sig: [u8; 64],
    ) {
        let quote_hash = compute_inner_authwit_hash([
            QUOTE_DOMAIN_SEPARATOR,
            context.this_address().to_field(),
            accepted_asset.to_field(),
            fj_fee_amount as Field,
            aa_payment_amount as Field,
            valid_until as Field,
            user_address.to_field(),
        ]);

        assert(
            schnorr::verify_signature(operator_pubkey, quote_sig, quote_hash.to_be_bytes::<32>()),
            "invalid quote signature",
        );

        context.push_nullifier(quote_hash);

        let anchor_ts = context.get_anchor_block_header().global_variables.timestamp;
        assert(anchor_ts <= valid_until, "quote expired");
        let quote_ttl = valid_until - anchor_ts;
        assert(quote_ttl <= MAX_QUOTE_TTL_SECONDS, "quote ttl too large");
        context.set_expiration_timestamp(valid_until);
    }

    /// Compute the sponsored quote hash and verify the sponsor's Schnorr
    /// signature inline. Pushes a nullifier to prevent replay.
    ///
    /// Sponsored quote preimage (uses SPONSORED_QUOTE_DOMAIN_SEPARATOR):
    ///   poseidon2([SPONSORED_DOMAIN_SEP, fpc_address, accepted_asset,
    ///              fj_fee_amount, valid_until, user_address])
    #[contract_library_method]
    fn assert_valid_sponsored_quote(
        context: &mut PrivateContext,
        sponsor_pubkey: EmbeddedCurvePoint,
        accepted_asset: AztecAddress,
        fj_fee_amount: u128,
        valid_until: u64,
        user_address: AztecAddress,
        quote_sig: [u8; 64],
    ) {
        let quote_hash = compute_inner_authwit_hash([
            SPONSORED_QUOTE_DOMAIN_SEPARATOR,
            context.this_address().to_field(),
            accepted_asset.to_field(),
            fj_fee_amount as Field,
            valid_until as Field,
            user_address.to_field(),
        ]);

        assert(
            schnorr::verify_signature(sponsor_pubkey, quote_sig, quote_hash.to_be_bytes::<32>()),
            "invalid sponsored quote signature",
        );

        context.push_nullifier(quote_hash);

        let anchor_ts = context.get_anchor_block_header().global_variables.timestamp;
        assert(anchor_ts <= valid_until, "sponsored quote expired");
        let quote_ttl = valid_until - anchor_ts;
        assert(quote_ttl <= MAX_QUOTE_TTL_SECONDS, "sponsored quote ttl too large");
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

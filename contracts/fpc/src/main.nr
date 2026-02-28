mod fee_math;
mod test;

use ::aztec::macros::aztec;

/// Fee Payment Contract (FPC)
///
/// A minimal single-asset FPC. Users pay transaction fees in one fixed token
/// via a private-to-private transfer to the operator. No public balance
/// accumulates in this contract.
///
/// ## Payment flow
///
/// 1. User requests a confidential quote from the attestation service, providing
///    their Aztec address.
/// 2. Attestation service returns a quote signed by the operator's Schnorr key,
///    binding exact fee/payment amounts and the user's address.
/// 3. User creates one authwit:
///    - Token transfer authwit -- authorises FPC to call
///      `transfer_private_to_private(user -> operator, charge, nonce)`
/// 4. User submits their tx with `fee_entrypoint` as the fee payment:
///    - Quote signature is verified inline against the operator's public key
///    - Quoted FeeJuice amount is checked against current gas settings
///    - Token transfers private: user -> operator
///    - FPC declares itself fee payer
///    - Setup completes; protocol deducts Fee Juice from FPC's balance
///
/// ## Storage
///
/// - config            (PublicImmutable<Config>) -- packed immutable config
///                                                  containing operator address,
///                                                  operator signing key, and
///                                                  accepted asset.
#[aztec]
pub contract FPC {
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
    /// Reduces the 4 separate Merkle membership proofs to one.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct Config {
        operator: AztecAddress,
        /// Operator signing public key x coordinate.
        operator_pubkey_x: Field,
        /// Operator signing public key y coordinate.
        operator_pubkey_y: Field,
        accepted_asset: AztecAddress,
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
        accepted_asset: AztecAddress,
    ) {
        assert(!operator.is_zero(), "invalid operator");
        assert(!accepted_asset.is_zero(), "invalid accepted asset");
        // Basic on-curve check: y^2 = x^3 - 17 (Grumpkin)
        assert(
            operator_pubkey_y * operator_pubkey_y
                == operator_pubkey_x * operator_pubkey_x * operator_pubkey_x - 17,
            "operator pubkey not on curve",
        );
        self.storage.config.initialize(
            Config { operator, operator_pubkey_x, operator_pubkey_y, accepted_asset },
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
        authwit_nonce: Field,
        fj_fee_amount: u128,
        aa_payment_amount: u128,
        valid_until: u64,
        quote_sig: [u8; 64],
    ) {
        let config = self.storage.config.read();
        let sender = self.msg_sender();

        assert_valid_quote(
            self.context,
            EmbeddedCurvePoint {
                x: config.operator_pubkey_x,
                y: config.operator_pubkey_y,
                is_infinite: false,
            },
            config.accepted_asset,
            fj_fee_amount,
            aa_payment_amount,
            valid_until,
            sender,
            quote_sig,
        );

        let expected_fj_fee_amount = get_max_gas_cost_no_teardown(self.context);
        assert(expected_fj_fee_amount == fj_fee_amount, "quoted fee amount mismatch");

        Token::at(config.accepted_asset)
            .transfer_private_to_private(sender, config.operator, aa_payment_amount, authwit_nonce)
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
    ///   poseidon2([DOMAIN_SEP, fpc_address, accepted_asset, fj_fee_amount,
    ///              aa_payment_amount, valid_until, user_address])
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

        // Safety: this is only used as a best-effort pre-check for a clearer
        // replay error before the canonical duplicate-nullifier protection.
        let quote_already_used = unsafe { check_nullifier_exists(quote_hash) };
        assert(!quote_already_used, "quote already used");

        // Prevent replay: the quote hash is unique per (fpc, asset, amounts, expiry, user).
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

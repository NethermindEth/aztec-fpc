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
///    binding the rate and the user's address.
/// 3. User creates one authwit:
///    - Token transfer authwit -- authorises FPC to call
///      `transfer_private_to_private(user -> operator, charge, nonce)`
/// 4. User submits their tx with `fee_entrypoint` as the fee payment:
///    - Quote signature is verified inline against the operator's public key
///    - Charge is computed from gas settings
///    - Token transfers private: user -> operator
///    - FPC declares itself fee payer
///    - Setup completes; protocol deducts Fee Juice from FPC's balance
///
/// ## Storage
///
/// - operator          (PublicImmutable) -- receives fee revenue as private notes.
///                                         Set once at construction.
/// - operator_pubkey_x (PublicImmutable) -- operator signing public key x coord.
/// - operator_pubkey_y (PublicImmutable) -- operator signing public key y coord.
/// - accepted_asset    (PublicImmutable) -- the one token contract this FPC accepts.
///                                         Enforced on every call.
#[aztec]
pub contract FPC {
    use crate::fee_math::fee_juice_to_asset;
    use aztec::{
        authwit::auth::compute_inner_authwit_hash,
        context::PrivateContext,
        macros::{functions::{allow_phase_change, external, initializer}, storage::storage},
        protocol::{address::AztecAddress, traits::ToField},
        state_vars::PublicImmutable,
    };
    use std::embedded_curve_ops::EmbeddedCurvePoint;
    use token::Token;

    global QUOTE_DOMAIN_SEPARATOR: Field = 0x465043;
    // Quotes must expire within this many seconds from the tx anchor timestamp.
    global MAX_QUOTE_TTL_SECONDS: u64 = 3600;

    // =========================================================================
    // Storage
    // =========================================================================

    #[storage]
    struct Storage<Context> {
        /// Operator address. Receives fee payments as private notes.
        operator: PublicImmutable<AztecAddress, Context>,
        /// Operator signing public key x coordinate.
        operator_pubkey_x: PublicImmutable<Field, Context>,
        /// Operator signing public key y coordinate.
        operator_pubkey_y: PublicImmutable<Field, Context>,
        /// The one token contract this FPC accepts. Immutable after deploy.
        accepted_asset: PublicImmutable<AztecAddress, Context>,
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
        self.storage.operator.initialize(operator);
        self.storage.operator_pubkey_x.initialize(operator_pubkey_x);
        self.storage.operator_pubkey_y.initialize(operator_pubkey_y);
        self.storage.accepted_asset.initialize(accepted_asset);
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
        rate_num: u128,
        rate_den: u128,
        valid_until: u64,
        quote_sig: [u8; 64],
    ) {
        let operator = self.storage.operator.read();
        let operator_pubkey_x = self.storage.operator_pubkey_x.read();
        let operator_pubkey_y = self.storage.operator_pubkey_y.read();
        let accepted_asset = self.storage.accepted_asset.read();
        let sender = self.msg_sender();
        assert(rate_num > (0 as u128), "rate_num must be > 0");

        assert_valid_quote(
            self.context,
            EmbeddedCurvePoint { x: operator_pubkey_x, y: operator_pubkey_y, is_infinite: false },
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
            .transfer_private_to_private(sender, operator, charge, authwit_nonce)
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

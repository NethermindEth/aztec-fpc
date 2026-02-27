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
/// - config            (PublicImmutable<Config>) -- packed immutable config
///                                                  containing operator address,
///                                                  operator signing key, and
///                                                  accepted asset.
#[aztec]
pub contract FPC {
    use crate::fee_math::fee_juice_to_asset;
    use aztec::{
        macros::{functions::{allow_phase_change, external, initializer}, storage::storage},
        protocol::{address::AztecAddress, traits::{Deserialize, Packable, Serialize, ToField}},
        state_vars::PublicImmutable,
    };
    use fpc_lib::{
        gas::get_max_gas_cost_no_teardown,
        quote::assert_valid_quote,
    };
    use std::embedded_curve_ops::EmbeddedCurvePoint;
    use token::Token;

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
        rate_num: u128,
        rate_den: u128,
        valid_until: u64,
        quote_sig: [u8; 64],
    ) {
        let config = self.storage.config.read();
        let sender = self.msg_sender();
        assert(rate_num > (0 as u128), "rate_num must be > 0");

        let anchor_ts = assert_valid_quote(
            self.context,
            EmbeddedCurvePoint {
                x: config.operator_pubkey_x,
                y: config.operator_pubkey_y,
                is_infinite: false,
            },
            config.accepted_asset,
            rate_num,
            rate_den,
            valid_until,
            sender,
            quote_sig,
        );

        // FPC-specific: cap how far in the future a quote may be valid.
        let quote_ttl = valid_until - anchor_ts;
        assert(quote_ttl <= MAX_QUOTE_TTL_SECONDS, "quote ttl too large");

        let charge = fee_juice_to_asset(
            get_max_gas_cost_no_teardown(self.context),
            rate_num,
            rate_den,
        );

        Token::at(config.accepted_asset)
            .transfer_private_to_private(sender, config.operator, charge, authwit_nonce)
            .call(self.context);

        self.context.set_as_fee_payer();
        if !self.context.in_revertible_phase() {
            self.context.end_setup();
        }
    }
}

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
/// 2. Attestation service returns a quote signed by `operator`, binding the rate
///    and the user's address.
/// 3. User creates two authwits:
///    a. Quote authwit  -- returned by the attestation service
///    b. Token transfer authwit -- authorises FPC to call
///       `transfer_private_to_private(user -> operator, charge, nonce)`
/// 4. User submits their tx with `fee_entrypoint` as the fee payment:
///    - Quote authwit is verified against `operator`
///    - Charge is computed from gas settings
///    - Token transfers private: user -> operator
///    - FPC declares itself fee payer
///    - Setup completes; protocol deducts Fee Juice from FPC's balance
///
/// ## Storage
///
/// - operator      (PublicImmutable) -- single key. Receives fee revenue as
///                                     private notes. Signs all quotes.
///                                     Set once at construction.
/// - accepted_asset (PublicImmutable) -- the one token contract this FPC accepts.
///                                     Enforced on every call.
#[aztec]
pub contract FPC {
    use crate::fee_math::fee_juice_to_asset;
    use aztec::{
        authwit::auth::{assert_inner_hash_valid_authwit, compute_inner_authwit_hash},
        context::PrivateContext,
        macros::{functions::{allow_phase_change, external, initializer}, storage::storage},
        protocol::{address::AztecAddress, traits::ToField},
        state_vars::PublicImmutable,
    };
    use token::Token;

    // Domain separator for quote hashes -- "FPC" as a field.
    global QUOTE_DOMAIN_SEPARATOR: Field = 0x465043;
    // Quotes must expire within this many seconds from the tx anchor timestamp.
    global MAX_QUOTE_TTL_SECONDS: u64 = 3600;

    // =========================================================================
    // Storage
    // =========================================================================

    #[storage]
    struct Storage<Context> {
        /// Single operator key. Receives fee payments and signs quotes.
        operator: PublicImmutable<AztecAddress, Context>,
        /// The one token contract this FPC accepts. Immutable after deploy.
        accepted_asset: PublicImmutable<AztecAddress, Context>,
    }

    // =========================================================================
    // Constructor
    // =========================================================================

    #[external("public")]
    #[initializer]
    fn constructor(operator: AztecAddress, accepted_asset: AztecAddress) {
        assert(!operator.is_zero(), "invalid operator");
        assert(!accepted_asset.is_zero(), "invalid accepted asset");
        self.storage.operator.initialize(operator);
        self.storage.accepted_asset.initialize(accepted_asset);
    }

    // =========================================================================
    // Fee entrypoint -- private source, private receipt (confidential)
    //
    // Transfers the fee charge from the user's private balance directly to the
    // operator's private balance. No tokens ever appear in this contract's
    // public balance. The quote is user-specific: it binds to msg_sender so
    // the operator knows which user paid and can track the private note.
    // =========================================================================

    #[external("private")]
    #[allow_phase_change]
    fn fee_entrypoint(authwit_nonce: Field, rate_num: u128, rate_den: u128, valid_until: u64) {
        let operator = self.storage.operator.read();
        let accepted_asset = self.storage.accepted_asset.read();
        let sender = self.msg_sender();

        // User-specific quote: binds to msg_sender so only this user can use it.
        // The operator signed acknowledging it will track private receipts
        // for this user via their viewing key.
        assert_valid_quote(
            self.context,
            operator,
            accepted_asset,
            rate_num,
            rate_den,
            valid_until,
            sender,
        );

        let charge = fee_juice_to_asset(
            get_max_gas_cost_no_teardown(self.context),
            rate_num,
            rate_den,
        );

        // Transfer user private -> operator private. Nothing is visible on-chain.
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

    /// Verify a quote signed by `signer` and enforce its expiry.
    ///
    /// Quote preimage:
    ///   poseidon2([DOMAIN_SEP, fpc_address, accepted_asset, rate_num, rate_den,
    ///              valid_until, user_address])
    ///
    /// user_address is always msg_sender for this FPC -- all quotes are
    /// user-specific (confidential).
    #[contract_library_method]
    fn assert_valid_quote(
        context: &mut PrivateContext,
        signer: AztecAddress,
        accepted_asset: AztecAddress,
        rate_num: u128,
        rate_den: u128,
        valid_until: u64,
        user_address: AztecAddress,
    ) {
        let inner_hash = compute_inner_authwit_hash([
            QUOTE_DOMAIN_SEPARATOR,
            context.this_address().to_field(),
            accepted_asset.to_field(),
            rate_num as Field,
            rate_den as Field,
            valid_until as Field,
            user_address.to_field(),
        ]);
        assert_inner_hash_valid_authwit(context, signer, inner_hash);

        let anchor_ts = context.get_anchor_block_header().global_variables.timestamp;
        assert(anchor_ts <= valid_until, "quote expired");
        let quote_ttl = valid_until - anchor_ts;
        assert(quote_ttl <= MAX_QUOTE_TTL_SECONDS, "quote ttl too large");
        context.set_expiration_timestamp(valid_until);
    }

    /// Maximum possible fee for this tx excluding teardown gas.
    /// (No teardown is scheduled so teardown limits are not included.)
    #[contract_library_method]
    fn get_max_gas_cost_no_teardown(context: &mut PrivateContext) -> u128 {
        let s = context.gas_settings();
        s.max_fees_per_gas.fee_per_da_gas * (s.gas_limits.da_gas as u128)
            + s.max_fees_per_gas.fee_per_l2_gas * (s.gas_limits.l2_gas as u128)
    }
}

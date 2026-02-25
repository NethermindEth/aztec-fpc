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
///       `transfer_in_private(user -> operator, charge, nonce)`
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
    use aztec::{
        authwit::auth::{assert_inner_hash_valid_authwit, compute_inner_authwit_hash},
        context::PrivateContext,
        macros::{
            functions::{external, initializer, nophasecheck},
            storage::storage,
        },
        protocol::{address::AztecAddress, traits::ToField},
        state_vars::PublicImmutable,
    };
    use token::Token;

    // Domain separator for quote hashes -- "FPC" as a field.
    global QUOTE_DOMAIN_SEPARATOR: Field = 0x465043;

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
    #[nophasecheck]
    fn fee_entrypoint(
        authwit_nonce: Field,
        rate_num: u128,
        rate_den: u128,
        valid_until: u64,
    ) {
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
        self.call(Token::at(accepted_asset).transfer_in_private(
            sender,
            operator,
            charge,
            authwit_nonce,
        ));

        self.context.set_as_fee_payer();
        self.context.end_setup();
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
        context.set_include_by_timestamp(valid_until);
    }

    /// Convert a fee-juice amount to payment-asset units using ceiling division.
    ///
    ///   payment_asset_amount = ceil(fee_juice_amount * rate_num / rate_den)
    ///
    /// Ceiling ensures the FPC always collects at least the actual fee cost.
    /// Overflow is checked explicitly since Noir does not panic on u128 overflow.
    #[contract_library_method]
    fn fee_juice_to_asset(fee_juice_amount: u128, rate_num: u128, rate_den: u128) -> u128 {
        assert(rate_den != 0, "invalid exchange rate denominator");
        let max_u128: u128 = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;

        if fee_juice_amount != 0 {
            assert(rate_num <= max_u128 / fee_juice_amount, "exchange rate overflow");
        }
        let product = fee_juice_amount * rate_num;

        // ceil(product / rate_den) = (product + rate_den - 1) / rate_den
        let addend = rate_den - 1;
        assert(product <= max_u128 - addend, "exchange rate overflow");
        (product + addend) / rate_den
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

/// Originally derived from defi-wonderland/aztec-fee-payment:
/// https://github.com/defi-wonderland/aztec-fee-payment/blob/dev/src/nr/metered_contract/src/main.nr
/// Licensed under MIT.
///
/// Key changes from upstream:
/// - Replaced authwit-delegated owner verification with operator Schnorr-signed quotes
/// - Added quote replay protection via nullifiers
/// - Replaced pay_fee / pay_fee_exact with pay_and_mint / pay_with_credit
/// - Packed config into single PublicImmutable slot (1 Merkle proof vs 4)
/// - Switched CreditFPC quotes to exact quoted credit/payment amounts

mod fee_math;
mod test;

use ::aztec::macros::aztec;

#[aztec]
pub contract CreditFPC {
    use aztec::{
        authwit::auth::compute_inner_authwit_hash,
        context::PrivateContext,
        macros::{
            functions::{allow_phase_change, external, initializer, only_self},
            storage::storage,
        },
        messages::message_delivery::MessageDelivery,
        oracle::nullifiers::check_nullifier_exists,
        protocol::{address::AztecAddress, traits::{Deserialize, Packable, Serialize, ToField}},
        state_vars::{Owned, PublicImmutable},
    };
    use balance_set::BalanceSet;
    use std::embedded_curve_ops::EmbeddedCurvePoint;
    use token::Token;
    use uint_note::PartialUintNote;

    global QUOTE_DOMAIN_SEPARATOR: Field = 0x465043;

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

    #[storage]
    struct Storage<Context> {
        config: PublicImmutable<Config, Context>,
        balances: Owned<BalanceSet<Context>, Context>,
    }

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

    #[external("private")]
    #[allow_phase_change]
    fn pay_and_mint(
        authwit_nonce: Field,
        fj_credit_amount: u128,
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
            fj_credit_amount,
            aa_payment_amount,
            valid_until,
            sender,
            quote_sig,
        );

        Token::at(config.accepted_asset)
            .transfer_private_to_private(sender, config.operator, aa_payment_amount, authwit_nonce)
            .call(self.context);

        let balance_set = self.storage.balances.at(sender);
        balance_set.add(fj_credit_amount).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

        let max_gas_cost = get_max_gas_cost_no_teardown(self.context);
        let subtracted = balance_set.try_sub(max_gas_cost, 1);
        assert(subtracted >= max_gas_cost, "minted credit too low for max fee");
        balance_set.add(subtracted - max_gas_cost).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

        self.context.set_as_fee_payer();
        if !self.context.in_revertible_phase() {
            self.context.end_setup();
        }
    }

    #[external("private")]
    #[allow_phase_change]
    fn pay_with_credit() {
        let sender = self.msg_sender();
        let max_gas_cost = get_max_gas_cost(self.context);

        let balance_set = self.storage.balances.at(sender);
        let subtracted = balance_set.try_sub(max_gas_cost, 1);
        assert(subtracted >= max_gas_cost, "Balance too low or note insufficient");
        balance_set.add(subtracted - max_gas_cost).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

        self.context.set_as_fee_payer();
        self.context.end_setup();
    }

    #[external("public")]
    #[only_self]
    fn _refund(max_gas_cost: u128, partial_note: PartialUintNote) {
        let transaction_fee = self.context.transaction_fee();
        let refund_amount = max_gas_cost - (transaction_fee as u128);
        partial_note.complete(self.context, self.address, refund_amount);
    }

    #[external("utility")]
    unconstrained fn balance_of(account: AztecAddress) -> u128 {
        self.storage.balances.at(account).balance_of()
    }

    #[external("utility")]
    unconstrained fn quote_used(
        fj_credit_amount: u128,
        aa_payment_amount: u128,
        valid_until: u64,
        user_address: AztecAddress,
    ) -> bool {
        let config = self.storage.config.read();
        let quote_hash = compute_inner_authwit_hash([
            QUOTE_DOMAIN_SEPARATOR,
            self.address.to_field(),
            config.accepted_asset.to_field(),
            fj_credit_amount as Field,
            aa_payment_amount as Field,
            valid_until as Field,
            user_address.to_field(),
        ]);
        check_nullifier_exists(quote_hash)
    }

    /// Test-only: mint credit via ONCHAIN_UNCONSTRAINED so the PXE can discover
    /// the note through standard encrypted-log scanning. ONCHAIN_CONSTRAINED notes
    /// may not be discoverable by the embedded PXE used in profiling.
    #[external("private")]
    fn dev_mint(amount: u128) {
        let sender = self.msg_sender();
        self.storage.balances.at(sender).add(amount).deliver(MessageDelivery.ONCHAIN_UNCONSTRAINED);
    }

    /// Compute the quote hash and verify the operator's Schnorr signature
    /// inline. Pushes a nullifier to prevent replay.
    ///
    /// Quote preimage (hashed with compute_inner_authwit_hash for compatibility):
    ///   poseidon2([DOMAIN_SEP, fpc_address, accepted_asset, fj_credit_amount,
    ///              aa_payment_amount, valid_until, user_address])
    #[contract_library_method]
    fn assert_valid_quote(
        context: &mut PrivateContext,
        operator_pubkey: EmbeddedCurvePoint,
        accepted_asset: AztecAddress,
        fj_credit_amount: u128,
        aa_payment_amount: u128,
        valid_until: u64,
        user_address: AztecAddress,
        quote_sig: [u8; 64],
    ) {
        let quote_hash = compute_inner_authwit_hash([
            QUOTE_DOMAIN_SEPARATOR,
            context.this_address().to_field(),
            accepted_asset.to_field(),
            fj_credit_amount as Field,
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
        context.set_expiration_timestamp(valid_until);
    }

    #[contract_library_method]
    pub fn get_max_gas_cost(context: &mut PrivateContext) -> u128 {
        let gas_settings = context.gas_settings();

        let l2_gas_limit = gas_settings.gas_limits.l2_gas;
        let da_gas_limit = gas_settings.gas_limits.da_gas;
        let l2_teardown_gas_limit = gas_settings.teardown_gas_limits.l2_gas;
        let da_teardown_gas_limit = gas_settings.teardown_gas_limits.da_gas;

        let max_fee_per_da_gas = gas_settings.max_fees_per_gas.fee_per_da_gas;
        let max_fee_per_l2_gas = gas_settings.max_fees_per_gas.fee_per_l2_gas;

        max_fee_per_da_gas * (da_gas_limit as u128 + da_teardown_gas_limit as u128)
            + max_fee_per_l2_gas * (l2_gas_limit as u128 + l2_teardown_gas_limit as u128)
    }

    #[contract_library_method]
    fn get_max_gas_cost_no_teardown(context: &mut PrivateContext) -> u128 {
        let s = context.gas_settings();
        s.max_fees_per_gas.fee_per_da_gas * (s.gas_limits.da_gas as u128)
            + s.max_fees_per_gas.fee_per_l2_gas * (s.gas_limits.l2_gas as u128)
    }
}

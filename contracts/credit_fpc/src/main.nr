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
/// - Switched CreditFPC to multi-asset pay_and_mint (asset chosen per quote)

mod fee_math;
mod test;

use ::aztec::macros::aztec;

#[aztec]
pub contract BackedCreditFPC {
    use aztec::{
        authwit::auth::compute_inner_authwit_hash,
        context::PrivateContext,
        macros::{
            functions::{allow_phase_change, external, initializer, only_self},
            storage::storage,
        },
        messages::message_delivery::MessageDelivery,
        oracle::nullifiers::check_nullifier_exists,
        protocol::{
            address::AztecAddress,
            constants::FEE_JUICE_ADDRESS,
            traits::{Deserialize, Packable, Serialize, ToField},
        },
        state_vars::{Owned, PublicImmutable, PublicMutable, StateVariable},
    };
    use balance_set::BalanceSet;
    use fee_juice_interface::FeeJuice;
    use std::embedded_curve_ops::EmbeddedCurvePoint;
    use token::Token;
    use uint_note::{PartialUintNote, UintNote};

    global QUOTE_DOMAIN_SEPARATOR: Field = 0x465043;
    global MAX_U128_VALUE: u128 = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;

    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct Config {
        operator: AztecAddress,
        operator_pubkey_x: Field,
        operator_pubkey_y: Field,
    }

    // ASSUMPTION: FeeJuice.balance_of_public() returns LIVE state within a block.
    // That is, if tx_1 pays fee_1 in block N, a subsequent tx_2 in the same block
    // reads the post-deduction balance (F - fee_1), not the start-of-block balance F.
    // The sequencer commits each tx's state (including fee deduction) before executing
    // the next tx's public calls. This is load-bearing for solvency: if balance_of_public()
    // were stale (start-of-block snapshot), concurrent pay_and_mint txs could collectively
    // overdraw the FPC's FeeJuice beyond what unspent_credits tracks.
    //
    // Invariant: fj_balance >= unspent_credits (after each tx's fee deduction).

    #[storage]
    struct Storage<Context> {
        config: PublicImmutable<Config, Context>,
        /// Sum of all net credits minted to users that have not yet been spent via
        /// pay_with_credit. The FPC's live FeeJuice balance must always be >= this value.
        unspent_credits: PublicMutable<u128, Context>,
        balances: Owned<BalanceSet<Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(operator: AztecAddress, operator_pubkey_x: Field, operator_pubkey_y: Field) {
        assert(!operator.is_zero(), "invalid operator");
        // Basic on-curve check: y^2 = x^3 - 17 (Grumpkin)
        assert(
            operator_pubkey_y * operator_pubkey_y
                == operator_pubkey_x * operator_pubkey_x * operator_pubkey_x - 17,
            "operator pubkey not on curve",
        );
        self.storage.config.initialize(Config { operator, operator_pubkey_x, operator_pubkey_y });
        // not sure about this write
        self.storage.unspent_credits.write(0);
    }

    #[external("private")]
    #[allow_phase_change]
    fn pay_and_mint(
        accepted_asset: AztecAddress,
        authwit_nonce: Field,
        fj_credit_amount: u128,
        aa_payment_amount: u128,
        valid_until: u64,
        quote_sig: [u8; 64],
    ) {
        let max_fees = self.context.gas_settings().max_fees_per_gas;
        let enforce_setup_phase = (max_fees.fee_per_da_gas > 0) | (max_fees.fee_per_l2_gas > 0);
        if enforce_setup_phase {
            assert(!self.context.in_revertible_phase(), "pay_and_mint must run in setup phase");
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
            fj_credit_amount,
            aa_payment_amount,
            valid_until,
            sender,
            quote_sig,
        );

        let max_fee = get_max_gas_cost(self.context);
        assert(fj_credit_amount >= max_fee, "minted credit too low for max fee");

        Token::at(accepted_asset)
            .transfer_private_to_private(sender, config.operator, aa_payment_amount, authwit_nonce)
            .call(self.context);

        let net_credit = fj_credit_amount - max_fee;
        let partial_note = UintNote::partial(
            sender,
            self.storage.balances.get_storage_slot(),
            self.context,
            sender,
            self.address,
        );

        self.context.set_as_fee_payer();
        if enforce_setup_phase | !self.context.in_revertible_phase() {
            self.context.end_setup();
        }

        self.enqueue_self._finalize_mint(fj_credit_amount, net_credit, partial_note);
    }

    /// Runs during the public (setup) phase of pay_and_mint, BEFORE this tx's fee is
    /// deducted. balance_of_public() reflects all prior txs' fee deductions (live accounting)
    /// but not the current tx's fee.
    ///
    /// We check against mint_amount (= net_credit + gas_cost) so that the
    /// gas_cost headroom absorbs this tx's fee:
    ///   post-tx fj_balance  = fj_balance - actual_fee
    ///   post-tx unspent     = unspent + net_credit
    ///   margin = (fj_balance - unspent - mint_amount) + (gas_cost - actual_fee)
    ///   both terms >= 0  =>  post-tx fj_balance >= post-tx unspent  (OK)

    #[external("public")]
    #[only_self]
    fn _finalize_mint(mint_amount: u128, net_credit: u128, partial_note: PartialUintNote) {
        // we can tighten up the accounting here with transaction_fee
        // adding right now is causing tests to fail

        let unspent_total_credits = self.storage.unspent_credits.read();
        let fj_balance = self.view(FeeJuice::at(FEE_JUICE_ADDRESS).balance_of_public(self.address));

        assert(mint_amount <= MAX_U128_VALUE - unspent_total_credits, "credits overflow");

        assert(fj_balance >= unspent_total_credits + mint_amount, "insufficient FeeJuice backing");

        self.storage.unspent_credits.write(unspent_total_credits + net_credit);
        partial_note.complete(self.context, self.address, net_credit);
    }

    #[external("private")]
    fn claim_fee_juice(amount: u128, claim_secret: Field, message_leaf_index: Field) {
        let config = self.storage.config.read();
        assert(self.msg_sender().eq(config.operator), "caller is not operator");

        FeeJuice::at(FEE_JUICE_ADDRESS)
            .claim(self.address, amount, claim_secret, message_leaf_index)
            .call(self.context);
    }

    #[external("private")]
    #[allow_phase_change]
    fn pay_with_credit() {
        let max_fees = self.context.gas_settings().max_fees_per_gas;
        let enforce_setup_phase = (max_fees.fee_per_da_gas > 0) | (max_fees.fee_per_l2_gas > 0);
        if enforce_setup_phase {
            assert(!self.context.in_revertible_phase(), "pay_with_credit must run in setup phase");
        }

        let sender = self.context.maybe_msg_sender().unwrap();
        let max_gas_cost = get_max_gas_cost(self.context);

        let balance_set = self.storage.balances.at(sender);
        let subtracted = balance_set.try_sub(max_gas_cost, 1);
        assert(subtracted >= max_gas_cost, "Balance too low or note insufficient");
        balance_set.add(subtracted - max_gas_cost).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

        self.context.set_as_fee_payer();
        if enforce_setup_phase | !self.context.in_revertible_phase() {
            self.context.end_setup();
        }

        self.enqueue_self._deduct_credits(max_gas_cost);
    }

    // creates an extra note per-usage compared to pay_with_credit,
    // more expensive than pay_with_credit()
    // may be appropriate for some users, especially if big diff between actual_fee and max_fee

    #[external("private")]
    #[allow_phase_change]
    fn pay_with_credit_exact() {
        let max_fees = self.context.gas_settings().max_fees_per_gas;
        let enforce_setup_phase = (max_fees.fee_per_da_gas > 0) | (max_fees.fee_per_l2_gas > 0);
        if enforce_setup_phase {
            assert(
                !self.context.in_revertible_phase(),
                "pay_with_credit_exact must run in setup phase",
            );
        }

        let sender = self.context.maybe_msg_sender().unwrap();
        let max_gas_cost = get_max_gas_cost(self.context);

        let balance_set = self.storage.balances.at(sender);
        let subtracted = balance_set.try_sub(max_gas_cost, 1);
        assert(subtracted >= max_gas_cost, "Balance too low or note insufficient");
        balance_set.add(subtracted - max_gas_cost).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

        let partial_note = UintNote::partial(
            sender,
            self.storage.balances.get_storage_slot(),
            self.context,
            sender,
            self.address,
        );

        self.context.set_as_fee_payer();
        if enforce_setup_phase | !self.context.in_revertible_phase() {
            self.context.end_setup();
        }

        self.enqueue_self._finalize_exact_credit_spend(max_gas_cost, partial_note);
    }

    /// Deducts max_gas_cost from unspent_credits. The protocol then deducts actual_fee
    /// (<= max_gas_cost) from the FJ balance. Since unspent_credits drops by more than
    /// fj_balance does, the invariant fj_balance >= unspent_credits is preserved.
    /// The difference (max_gas_cost - actual_fee) widens (fj_balance - unspent_credits),
    /// making that FJ available for future mints via _finalize_mint.
    #[external("public")]
    #[only_self]
    fn _deduct_credits(amount: u128) {
        let unspent = self.storage.unspent_credits.read();
        assert(unspent >= amount, "credit underflow");
        self.storage.unspent_credits.write(unspent - amount);
    }

    /// Settles a pay_with_credit_exact call by deducting max_fee from unspent credits and
    /// refunding the unused portion (max_fee - transaction_fee) back to the sender.
    #[external("public")]
    #[only_self]
    fn _finalize_exact_credit_spend(max_fee: u128, partial_note: PartialUintNote) {
        let unspent = self.storage.unspent_credits.read();
        let transaction_fee_u128 = self.context.transaction_fee() as u128;

        assert(unspent >= max_fee, "credit underflow");
        assert(max_fee >= transaction_fee_u128, "transaction fee greater than max fee");
        let refund = max_fee - transaction_fee_u128;

        // Net effect on unspent_credits is -transaction_fee.
        self.storage.unspent_credits.write(unspent - transaction_fee_u128);
        if refund > 0 {
            partial_note.complete(self.context, self.address, refund);
        }
    }

    #[external("utility")]
    unconstrained fn balance_of(account: AztecAddress) -> u128 {
        self.storage.balances.at(account).balance_of()
    }

    #[external("utility")]
    unconstrained fn totals() -> u128 {
        self.storage.unspent_credits.read()
    }

    #[external("utility")]
    unconstrained fn quote_used(
        accepted_asset: AztecAddress,
        fj_credit_amount: u128,
        aa_payment_amount: u128,
        valid_until: u64,
        user_address: AztecAddress,
    ) -> bool {
        let quote_hash = compute_inner_authwit_hash([
            QUOTE_DOMAIN_SEPARATOR,
            self.address.to_field(),
            accepted_asset.to_field(),
            fj_credit_amount as Field,
            aa_payment_amount as Field,
            valid_until as Field,
            user_address.to_field(),
        ]);
        check_nullifier_exists(quote_hash)
    }

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

        context.push_nullifier(quote_hash);

        let anchor_ts = context.get_anchor_block_header().global_variables.timestamp;
        assert(anchor_ts <= valid_until, "quote expired");
        context.set_expiration_timestamp(valid_until);
    }

    #[contract_library_method]
    fn get_max_gas_cost(context: &mut PrivateContext) -> u128 {
        let s = context.gas_settings();
        s.max_fees_per_gas.fee_per_da_gas * (s.gas_limits.da_gas as u128)
            + s.max_fees_per_gas.fee_per_l2_gas * (s.gas_limits.l2_gas as u128)
    }
}

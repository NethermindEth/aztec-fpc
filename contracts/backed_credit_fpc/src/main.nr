mod fee_math;

use ::aztec::macros::aztec;

#[aztec]
pub contract BackedCreditFPC {
    use crate::fee_math::fee_juice_to_asset;
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
    use fee_juice_contract::FeeJuice;
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
        accepted_asset: AztecAddress,
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
        self.storage.unspent_credits.write(0);
    }

    #[external("private")]
    #[allow_phase_change]
    fn pay_and_mint(
        authwit_nonce: Field,
        rate_num: u128,
        rate_den: u128,
        valid_until: u64,
        quote_sig: [u8; 64],
        mint_amount: u128,
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
            rate_num,
            rate_den,
            valid_until,
            sender,
            quote_sig,
        );

        let charge = fee_juice_to_asset(mint_amount, rate_num, rate_den);
        assert(mint_amount >= get_max_gas_cost_no_teardown(self.context), "minted credit too low for max fee");

        Token::at(config.accepted_asset)
            .transfer_private_to_private(sender, config.operator, charge, authwit_nonce)
            .call(self.context);

        let net_credit = mint_amount - get_max_gas_cost_no_teardown(self.context);
        let partial_note = UintNote::partial(
            sender,
            self.storage.balances.get_storage_slot(),
            self.context,
            sender,
            self.address,
        );
        self.enqueue_self._finalize_mint(mint_amount, net_credit, partial_note);

        self.context.set_as_fee_payer();
        if !self.context.in_revertible_phase() {
            self.context.end_setup();
        }
    }

    /// Runs during the public (setup) phase of pay_and_mint, BEFORE this tx's fee is
    /// deducted. balance_of_public() reflects all prior txs' fee deductions (live accounting)
    /// but not the current tx's fee.
    ///
    /// We check against mint_amount (= net_credit + gas_cost_no_teardown) so that the
    /// gas_cost_no_teardown headroom absorbs this tx's fee:
    ///   post-tx fj_balance  = fj_balance - actual_fee
    ///   post-tx unspent     = unspent + net_credit
    ///   margin = (fj_balance - unspent - mint_amount) + (gas_cost_no_teardown - actual_fee)
    ///   both terms >= 0  =>  post-tx fj_balance >= post-tx unspent  (OK)
    #[external("public")]
    #[only_self]
    fn _finalize_mint(mint_amount: u128, net_credit: u128, partial_note: PartialUintNote) {
        let unspent = self.storage.unspent_credits.read();
        let fj_balance = self.view(
            FeeJuice::at(FEE_JUICE_ADDRESS).balance_of_public(self.address),
        );

        assert(mint_amount <= MAX_U128_VALUE - unspent, "credits overflow");
        assert(fj_balance >= unspent + mint_amount, "insufficient FeeJuice backing");

        self.storage.unspent_credits.write(unspent + net_credit);
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
        let sender = self.context.maybe_msg_sender().unwrap();
        let max_gas_cost = get_max_gas_cost(self.context);

        let balance_set = self.storage.balances.at(sender);
        let subtracted = balance_set.try_sub(max_gas_cost, 1);
        assert(subtracted >= max_gas_cost, "Balance too low or note insufficient");
        balance_set.add(subtracted - max_gas_cost).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

        self.enqueue_self._deduct_credits(max_gas_cost);

        self.context.set_as_fee_payer();
        self.context.end_setup();
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
        rate_num: u128,
        rate_den: u128,
        valid_until: u64,
        user_address: AztecAddress,
    ) -> bool {
        let config = self.storage.config.read();
        let quote_hash = compute_inner_authwit_hash([
            QUOTE_DOMAIN_SEPARATOR,
            self.address.to_field(),
            config.accepted_asset.to_field(),
            rate_num as Field,
            rate_den as Field,
            valid_until as Field,
            user_address.to_field(),
        ]);
        check_nullifier_exists(quote_hash)
    }

    /// Test-only: mint credit via ONCHAIN_UNCONSTRAINED so the PXE can discover
    /// the note through standard encrypted-log scanning. ONCHAIN_CONSTRAINED notes
    /// may not be discoverable by the embedded PXE used in profiling.
    ///
    /// WARNING: bypasses unspent_credits accounting. Credits minted here are not
    /// tracked, so _deduct_credits will underflow if users spend dev-minted credit
    /// without a matching unspent_credits balance.
    #[external("private")]
    fn dev_mint(amount: u128) {
        let sender = self.msg_sender();
        self.storage.balances.at(sender).add(amount).deliver(MessageDelivery.ONCHAIN_UNCONSTRAINED);
    }

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

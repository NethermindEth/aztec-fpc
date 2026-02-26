use ::aztec::macros::aztec;

/// Mock variant of AltFPC for profiling pay_fee in isolation.
///
/// Identical pay_fee logic, but replaces pay_and_mint with a simple
/// mint_credit function that creates credit without token transfers
/// or quote verification. This lets us deploy and fund with .send()
/// (user pays fees) then profile pay_fee with .profile().
#[aztec]
pub contract AltFPCMock {
    use aztec::{
        context::PrivateContext,
        macros::{
            functions::{allow_phase_change, external, initializer, only_self},
            storage::storage,
        },
        messages::message_delivery::MessageDelivery,
        protocol::address::AztecAddress,
        state_vars::{Owned, PublicImmutable},
    };
    use balance_set::BalanceSet;
    use uint_note::PartialUintNote;

    #[storage]
    struct Storage<Context> {
        operator: PublicImmutable<AztecAddress, Context>,
        accepted_asset: PublicImmutable<AztecAddress, Context>,
        balances: Owned<BalanceSet<Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(operator: AztecAddress, accepted_asset: AztecAddress) {
        self.storage.operator.initialize(operator);
        self.storage.accepted_asset.initialize(accepted_asset);
    }

    /// Mint credit directly to msg_sender -- no token transfer, no quote.
    /// Used as preamble so pay_fee has a balance to deduct from.
    #[external("private")]
    fn mint_credit(amount: u128) {
        let sender = self.msg_sender();
        self.storage.balances.at(sender).add(amount).deliver(
            MessageDelivery.ONCHAIN_CONSTRAINED,
        );
    }

    // -- pay_fee: identical to AltFPC -------------------------------------------

    #[external("private")]
    #[allow_phase_change]
    fn pay_fee() {
        let sender = self.context.maybe_msg_sender().unwrap();
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
}

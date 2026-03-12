mod test;

use aztec::macros::aztec;

/// Mock counter contract based on the Aztec counter tutorial.
#[aztec]
pub contract Counter {
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        messages::message_delivery::MessageDelivery,
        oracle::logging::debug_log_format,
        protocol::{address::AztecAddress, traits::ToField},
        state_vars::Owned,
    };
    use balance_set::BalanceSet;

    #[storage]
    struct Storage<Context> {
        counters: Owned<BalanceSet<Context>, Context>,
    }

    #[initializer]
    #[external("private")]
    fn initialize(headstart: u64, owner: AztecAddress) {
        self.storage.counters.at(owner).add(headstart as u128).deliver(
            MessageDelivery.ONCHAIN_CONSTRAINED,
        );
    }

    #[external("private")]
    fn increment(owner: AztecAddress) {
        debug_log_format("Incrementing counter for owner {0}", [owner.to_field()]);
        self.storage.counters.at(owner).add(1).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
    }

    #[external("private")]
    fn always_revert() {
        self.enqueue_self._always_revert_public();
    }

    #[external("public")]
    fn _always_revert_public() {
        assert(self.context.this_address().is_zero(), "This function always reverts");
    }

    #[external("utility")]
    unconstrained fn get_counter(owner: AztecAddress) -> pub u128 {
        self.storage.counters.at(owner).balance_of()
    }
}

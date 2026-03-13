use crate::Counter;
use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};

pub unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let owner = env.create_contract_account();

    let initializer = Counter::interface().initialize(1, owner);
    let counter_address = env.deploy("Counter").with_private_initializer(owner, initializer);

    (env, counter_address, owner)
}

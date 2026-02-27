use crate::CreditFPC;
use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};

// Re-export shared helpers so test files keep their `utils::x` call sites.
pub use fpc_lib::test_utils::{
    max_gas_cost_no_teardown, private_balance, sign_quote, test_operator_pubkey,
};

/// Deploy Token + CreditFPC and return (env, credit_fpc_address, token_address, operator, user).
pub unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
    let (mut env, token_address, operator, user) = fpc_lib::test_utils::setup_base_env();

    let pk = test_operator_pubkey();
    let credit_fpc_initializer =
        CreditFPC::interface().constructor(operator, pk.x, pk.y, token_address);
    let credit_fpc_address =
        env.deploy("CreditFPC").with_public_initializer(operator, credit_fpc_initializer);

    (env, credit_fpc_address, token_address, operator, user)
}

/// Credit balance held by `account` inside this CreditFPC instance.
pub unconstrained fn credit_balance(
    env: TestEnvironment,
    credit_fpc_address: AztecAddress,
    account: AztecAddress,
) -> u128 {
    env.simulate_utility(CreditFPC::at(credit_fpc_address).balance_of(account))
}

use crate::{fee_math::fee_juice_to_asset, FPC};
use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};

// Re-export shared helpers so test files keep their `utils::x` call sites.
pub use fpc_lib::test_utils::{
    max_gas_cost_no_teardown, private_balance, sign_quote, test_operator_pubkey,
};

/// Deploy Token + FPC and return (env, fpc_address, token_address, operator, user).
pub unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
    let (mut env, token_address, operator, user) = fpc_lib::test_utils::setup_base_env();

    let pk = test_operator_pubkey();
    let fpc_initializer = FPC::interface().constructor(operator, pk.x, pk.y, token_address);
    let fpc_address = env.deploy("FPC").with_public_initializer(operator, fpc_initializer);

    (env, fpc_address, token_address, operator, user)
}

pub unconstrained fn expected_charge(env: TestEnvironment, rate_num: u128, rate_den: u128) -> u128 {
    fee_juice_to_asset(max_gas_cost_no_teardown(env), rate_num, rate_den)
}

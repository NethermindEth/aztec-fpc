use crate::{fee_math::fee_juice_to_asset, FPC};
use aztec::{
    authwit::auth::{compute_authwit_message_hash, compute_inner_authwit_hash},
    protocol::{address::AztecAddress, traits::ToField},
    test::helpers::{test_environment::TestEnvironment, txe_oracles},
};
use token::Token;

global QUOTE_DOMAIN_SEPARATOR: Field = 0x465043;

pub unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();

    // Use contract accounts because both quote and transfer flows rely on private authwit checks.
    let user = env.create_contract_account();
    let operator = env.create_contract_account();

    let token_initializer = Token::interface().constructor(
        operator,
        "TestToken0000000000000000000000",
        "TT00000000000000000000000000000",
        18,
    );
    let token_address =
        env.deploy("@token_contract/Token").with_public_initializer(operator, token_initializer);

    let fpc_initializer = FPC::interface().constructor(operator, token_address);
    let fpc_address = env.deploy("FPC").with_public_initializer(operator, fpc_initializer);

    (env, fpc_address, token_address, operator, user)
}

pub unconstrained fn max_gas_cost_no_teardown(env: TestEnvironment) -> u128 {
    env.private_context(|context| {
        let s = context.gas_settings();
        s.max_fees_per_gas.fee_per_da_gas * (s.gas_limits.da_gas as u128)
            + s.max_fees_per_gas.fee_per_l2_gas * (s.gas_limits.l2_gas as u128)
    })
}

pub unconstrained fn expected_charge(env: TestEnvironment, rate_num: u128, rate_den: u128) -> u128 {
    fee_juice_to_asset(max_gas_cost_no_teardown(env), rate_num, rate_den)
}

pub unconstrained fn add_quote_authwit(
    env: TestEnvironment,
    operator: AztecAddress,
    fpc_address: AztecAddress,
    accepted_asset: AztecAddress,
    rate_num: u128,
    rate_den: u128,
    valid_until: u64,
    user_address: AztecAddress,
) {
    let inner_hash = compute_inner_authwit_hash([
        QUOTE_DOMAIN_SEPARATOR,
        fpc_address.to_field(),
        accepted_asset.to_field(),
        rate_num as Field,
        rate_den as Field,
        valid_until as Field,
        user_address.to_field(),
    ]);
    let (chain_id, version) =
        env.utility_context(|context| (context.chain_id(), context.version()));
    let message_hash = compute_authwit_message_hash(fpc_address, chain_id, version, inner_hash);
    txe_oracles::add_authwit(operator, message_hash);
}

pub unconstrained fn private_balance(
    env: TestEnvironment,
    token_address: AztecAddress,
    account: AztecAddress,
) -> u128 {
    env.simulate_utility(Token::at(token_address).balance_of_private(account))
}

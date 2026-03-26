use crate::Faucet;
use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};
use token::Token;

pub global DEFAULT_DRIP_AMOUNT: u128 = 1_000_000_000_000_000_000;
pub global DEFAULT_COOLDOWN: u64 = 60;
pub global FAUCET_SUPPLY: u128 = 100_000_000_000_000_000_000;

pub unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
    setup_with_cooldown(DEFAULT_COOLDOWN)
}

pub unconstrained fn setup_no_cooldown() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
    setup_with_cooldown(0)
}

/// Deploy token + faucet and fund the faucet's public balance.
///
/// Returns (env, faucet_address, token_address, admin, user).
/// `admin` is both the token minter and the faucet admin.
pub unconstrained fn setup_with_cooldown(
    cooldown_seconds: u64,
) -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();

    let admin = env.create_contract_account();
    let user = env.create_contract_account();

    let token_initializer = Token::interface().constructor_with_minter(
        "TestToken0000000000000000000000",
        "TT00000000000000000000000000000",
        18,
        admin,
    );
    let token_address =
        env.deploy("@token_contract/Token").with_public_initializer(admin, token_initializer);

    let faucet_initializer = Faucet::interface().constructor(
        token_address,
        admin,
        DEFAULT_DRIP_AMOUNT,
        cooldown_seconds,
    );
    let faucet_address = env.deploy("Faucet").with_public_initializer(admin, faucet_initializer);

    env.call_public(admin, Token::at(token_address).mint_to_public(faucet_address, FAUCET_SUPPLY));

    (env, faucet_address, token_address, admin, user)
}

pub unconstrained fn public_balance(
    env: TestEnvironment,
    token_address: AztecAddress,
    account: AztecAddress,
) -> u128 {
    env.view_public(Token::at(token_address).balance_of_public(account))
}

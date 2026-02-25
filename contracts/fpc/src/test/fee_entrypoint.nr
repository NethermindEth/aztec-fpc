use crate::{FPC, test::utils};
use aztec::test::helpers::authwit::add_private_authwit_from_call;
use token::Token;

global TRANSFER_AUTHWIT_NONCE: Field = 42;
global TRANSFER_AUTHWIT_NONCE_2: Field = 43;

#[test]
unconstrained fn fee_entrypoint_happy_path_transfers_expected_charge() {
    let (mut env, fpc_address, token_address, operator, user) = utils::setup();
    let fpc = FPC::at(fpc_address);
    let token = Token::at(token_address);

    let rate_num = 1 as u128;
    let rate_den = 1 as u128;
    let charge = utils::expected_charge(env, rate_num, rate_den);
    let mint_amount = charge + (1000 as u128);
    env.call_private(operator, token.mint_to_private(user, mint_amount));

    let valid_until = env.last_block_timestamp() + 3600;
    utils::add_quote_authwit(
        env,
        operator,
        fpc_address,
        token_address,
        rate_num,
        rate_den,
        valid_until,
        user,
    );

    let transfer_call = token.transfer_in_private(user, operator, charge, TRANSFER_AUTHWIT_NONCE);
    add_private_authwit_from_call(env, user, fpc_address, transfer_call);

    let user_balance_before = utils::private_balance(env, token_address, user);
    let operator_balance_before = utils::private_balance(env, token_address, operator);

    env.call_private(
        user,
        fpc.fee_entrypoint(TRANSFER_AUTHWIT_NONCE, rate_num, rate_den, valid_until),
    );

    let user_balance_after = utils::private_balance(env, token_address, user);
    let operator_balance_after = utils::private_balance(env, token_address, operator);

    assert_eq(user_balance_after, user_balance_before - charge);
    assert_eq(operator_balance_after, operator_balance_before + charge);
}

#[test(should_fail_with = "Unknown auth witness for message hash")]
unconstrained fn fee_entrypoint_requires_fresh_transfer_authwit_each_call() {
    let (mut env, fpc_address, token_address, operator, user) = utils::setup();
    let fpc = FPC::at(fpc_address);
    let token = Token::at(token_address);

    let rate_num = 1 as u128;
    let rate_den = 1 as u128;
    let charge = utils::expected_charge(env, rate_num, rate_den);
    let mint_amount = charge * (2 as u128) + (1000 as u128);
    env.call_private(operator, token.mint_to_private(user, mint_amount));

    let valid_until = env.last_block_timestamp() + 3600;
    utils::add_quote_authwit(
        env,
        operator,
        fpc_address,
        token_address,
        rate_num,
        rate_den,
        valid_until,
        user,
    );

    let transfer_call = token.transfer_in_private(user, operator, charge, TRANSFER_AUTHWIT_NONCE);
    add_private_authwit_from_call(env, user, fpc_address, transfer_call);

    env.call_private(
        user,
        fpc.fee_entrypoint(TRANSFER_AUTHWIT_NONCE, rate_num, rate_den, valid_until),
    );

    let valid_until_2 = valid_until + 1;
    utils::add_quote_authwit(
        env,
        operator,
        fpc_address,
        token_address,
        rate_num,
        rate_den,
        valid_until_2,
        user,
    );

    // Intentionally do not add a second transfer authwit. The second payment attempt must fail.
    let _ = env.call_private(
        user,
        fpc.fee_entrypoint(TRANSFER_AUTHWIT_NONCE_2, rate_num, rate_den, valid_until_2),
    );
}

#[test(should_fail_with = "quote expired")]
unconstrained fn fee_entrypoint_rejects_expired_quote() {
    let (mut env, fpc_address, token_address, operator, user) = utils::setup();
    let fpc = FPC::at(fpc_address);

    let rate_num = 1 as u128;
    let rate_den = 1 as u128;
    let authwit_nonce = 99;

    let valid_until = env.last_block_timestamp();
    utils::add_quote_authwit(
        env,
        operator,
        fpc_address,
        token_address,
        rate_num,
        rate_den,
        valid_until,
        user,
    );

    // Private call anchor timestamps use the last mined block; mine one block in the future
    // so anchor_ts > valid_until deterministically.
    env.mine_block_at(valid_until + 1);

    let _ =
        env.call_private(user, fpc.fee_entrypoint(authwit_nonce, rate_num, rate_den, valid_until));
}

#[test(should_fail_with = "Unknown auth witness for message hash")]
unconstrained fn fee_entrypoint_rejects_quote_bound_to_another_user() {
    let (mut env, fpc_address, token_address, operator, user) = utils::setup();
    let fpc = FPC::at(fpc_address);
    let other_user = env.create_contract_account();

    let rate_num = 1 as u128;
    let rate_den = 1 as u128;
    let authwit_nonce = 7;
    let valid_until = env.last_block_timestamp() + 3600;

    utils::add_quote_authwit(
        env,
        operator,
        fpc_address,
        token_address,
        rate_num,
        rate_den,
        valid_until,
        user,
    );

    let _ = env.call_private(
        other_user,
        fpc.fee_entrypoint(authwit_nonce, rate_num, rate_den, valid_until),
    );
}

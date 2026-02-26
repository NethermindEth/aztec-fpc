use crate::{FPC, test::utils};
use aztec::protocol::address::AztecAddress;
use aztec::test::helpers::authwit::add_private_authwit_from_call;
use token::Token;

global TRANSFER_AUTHWIT_NONCE: Field = 42;
global TRANSFER_AUTHWIT_NONCE_2: Field = 43;

#[test(should_fail_with = "invalid operator")]
unconstrained fn constructor_rejects_zero_operator() {
    let (mut env, _, token_address, operator, _) = utils::setup();

    let pk = utils::test_operator_pubkey();
    let fpc_initializer =
        FPC::interface().constructor(AztecAddress::zero(), pk.x, pk.y, token_address);
    let _ = env.deploy("FPC").with_public_initializer(operator, fpc_initializer);
}

#[test(should_fail_with = "invalid accepted asset")]
unconstrained fn constructor_rejects_zero_accepted_asset() {
    let (mut env, _, _, operator, _) = utils::setup();

    let pk = utils::test_operator_pubkey();
    let fpc_initializer = FPC::interface().constructor(operator, pk.x, pk.y, AztecAddress::zero());
    let _ = env.deploy("FPC").with_public_initializer(operator, fpc_initializer);
}

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
    let quote_sig = utils::sign_quote(
        fpc_address,
        token_address,
        rate_num,
        rate_den,
        valid_until,
        user,
    );

    let transfer_call =
        token.transfer_private_to_private(user, operator, charge, TRANSFER_AUTHWIT_NONCE);
    add_private_authwit_from_call(env, user, fpc_address, transfer_call);

    let user_balance_before = utils::private_balance(env, token_address, user);
    let operator_balance_before = utils::private_balance(env, token_address, operator);

    env.call_private(
        user,
        fpc.fee_entrypoint(TRANSFER_AUTHWIT_NONCE, rate_num, rate_den, valid_until, quote_sig),
    );

    let user_balance_after = utils::private_balance(env, token_address, user);
    let operator_balance_after = utils::private_balance(env, token_address, operator);

    assert_eq(user_balance_after, user_balance_before - charge);
    assert_eq(operator_balance_after, operator_balance_before + charge);
}

#[test(should_fail_with = "rate_num must be > 0")]
unconstrained fn fee_entrypoint_rejects_zero_rate_numerator() {
    let (mut env, fpc_address, token_address, _operator, user) = utils::setup();
    let fpc = FPC::at(fpc_address);

    let rate_num = 0 as u128;
    let rate_den = 1 as u128;
    let authwit_nonce = 44;
    let valid_until = env.last_block_timestamp() + 3600;
    let quote_sig = utils::sign_quote(
        fpc_address,
        token_address,
        rate_num,
        rate_den,
        valid_until,
        user,
    );

    let _ = env.call_private(
        user,
        fpc.fee_entrypoint(authwit_nonce, rate_num, rate_den, valid_until, quote_sig),
    );
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
    let quote_sig = utils::sign_quote(
        fpc_address,
        token_address,
        rate_num,
        rate_den,
        valid_until,
        user,
    );

    let transfer_call =
        token.transfer_private_to_private(user, operator, charge, TRANSFER_AUTHWIT_NONCE);
    add_private_authwit_from_call(env, user, fpc_address, transfer_call);

    env.call_private(
        user,
        fpc.fee_entrypoint(TRANSFER_AUTHWIT_NONCE, rate_num, rate_den, valid_until, quote_sig),
    );

    // Use a fresh quote window for the second attempt so this test fails on
    // missing transfer authwit (the intended assertion), not quote TTL bounds.
    let valid_until_2 = env.last_block_timestamp() + 3600;
    let quote_sig_2 = utils::sign_quote(
        fpc_address,
        token_address,
        rate_num,
        rate_den,
        valid_until_2,
        user,
    );

    let _ = env.call_private(
        user,
        fpc.fee_entrypoint(TRANSFER_AUTHWIT_NONCE_2, rate_num, rate_den, valid_until_2, quote_sig_2),
    );
}

#[test(should_fail_with = "quote expired")]
unconstrained fn fee_entrypoint_rejects_expired_quote() {
    let (mut env, fpc_address, token_address, _operator, user) = utils::setup();
    let fpc = FPC::at(fpc_address);

    let rate_num = 1 as u128;
    let rate_den = 1 as u128;
    let authwit_nonce = 99;

    let valid_until = env.last_block_timestamp();
    let quote_sig = utils::sign_quote(
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

    let _ = env.call_private(
        user,
        fpc.fee_entrypoint(authwit_nonce, rate_num, rate_den, valid_until, quote_sig),
    );
}

#[test(should_fail_with = "quote ttl too large")]
unconstrained fn fee_entrypoint_rejects_overlong_quote_ttl() {
    let (mut env, fpc_address, token_address, _operator, user) = utils::setup();
    let fpc = FPC::at(fpc_address);

    let rate_num = 1 as u128;
    let rate_den = 1 as u128;
    let authwit_nonce = 100;

    // Contract bound is 3600 seconds from anchor timestamp.
    let valid_until = env.last_block_timestamp() + 3601;
    let quote_sig = utils::sign_quote(
        fpc_address,
        token_address,
        rate_num,
        rate_den,
        valid_until,
        user,
    );

    let _ = env.call_private(
        user,
        fpc.fee_entrypoint(authwit_nonce, rate_num, rate_den, valid_until, quote_sig),
    );
}

#[test(should_fail_with = "invalid quote signature")]
unconstrained fn fee_entrypoint_rejects_quote_bound_to_another_user() {
    let (mut env, fpc_address, token_address, operator, user) = utils::setup();
    let fpc = FPC::at(fpc_address);
    let token = Token::at(token_address);
    let other_user = env.create_contract_account();

    let rate_num = 1 as u128;
    let rate_den = 1 as u128;
    let authwit_nonce = 7;
    let valid_until = env.last_block_timestamp() + 3600;
    let charge = utils::expected_charge(env, rate_num, rate_den);

    env.call_private(operator, token.mint_to_private(other_user, charge + (100 as u128)));
    let transfer_call =
        token.transfer_private_to_private(other_user, operator, charge, authwit_nonce);
    add_private_authwit_from_call(env, other_user, fpc_address, transfer_call);

    // Sign the quote for `user`, but call from `other_user`. The quote hash
    // includes user_address = msg_sender, so the hash won't match and the
    // Schnorr signature will fail to verify.
    let quote_sig = utils::sign_quote(
        fpc_address,
        token_address,
        rate_num,
        rate_den,
        valid_until,
        user,
    );

    let _ = env.call_private(
        other_user,
        fpc.fee_entrypoint(authwit_nonce, rate_num, rate_den, valid_until, quote_sig),
    );
}

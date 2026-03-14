use crate::{FPCMultiAsset, test::utils};
use aztec::protocol::address::AztecAddress;
use aztec::test::helpers::authwit::add_private_authwit_from_call;
use token::Token;

global TRANSFER_AUTHWIT_NONCE: Field = 42;
global TRANSFER_AUTHWIT_NONCE_2: Field = 43;

#[test(should_fail_with = "invalid operator")]
unconstrained fn constructor_rejects_zero_operator() {
    let (mut env, _, _, _, operator, _) = utils::setup();

    let pk = utils::test_operator_pubkey();
    let fpc_initializer = FPCMultiAsset::interface().constructor(AztecAddress::zero(), pk.x, pk.y);
    let _ = env.deploy("FPCMultiAsset").with_public_initializer(operator, fpc_initializer);
}

#[test]
unconstrained fn fee_entrypoint_happy_path_transfers_expected_charge() {
    let (mut env, fpc_address, token_address, bridge_address, operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);
    let token = Token::at(token_address);

    let fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let aa_payment_amount = fj_fee_amount * (5 as u128) / (4 as u128) + (1 as u128);
    let mint_amount = aa_payment_amount + (1000 as u128);
    env.call_private(bridge_address, token.mint_to_private(user, mint_amount));

    let valid_until = env.last_block_timestamp() + 3600;
    let quote_sig = utils::sign_quote(
        fpc_address,
        token_address,
        fj_fee_amount,
        aa_payment_amount,
        valid_until,
        user,
    );

    let transfer_call = token.transfer_private_to_private(
        user,
        operator,
        aa_payment_amount,
        TRANSFER_AUTHWIT_NONCE,
    );
    add_private_authwit_from_call(env, user, fpc_address, transfer_call);

    let user_balance_before = utils::private_balance(env, token_address, user);
    let operator_balance_before = utils::private_balance(env, token_address, operator);

    env.call_private(
        user,
        fpc.fee_entrypoint(
            token_address,
            TRANSFER_AUTHWIT_NONCE,
            fj_fee_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );

    let user_balance_after = utils::private_balance(env, token_address, user);
    let operator_balance_after = utils::private_balance(env, token_address, operator);

    assert_eq(user_balance_after, user_balance_before - aa_payment_amount);
    assert_eq(operator_balance_after, operator_balance_before + aa_payment_amount);
}

#[test(should_fail_with = "quoted fee amount mismatch")]
unconstrained fn fee_entrypoint_rejects_mismatched_fj_fee_amount() {
    let (mut env, fpc_address, token_address, _bridge_address, _operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);

    let actual_fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let quoted_fj_fee_amount = actual_fj_fee_amount + (1 as u128);
    let aa_payment_amount = quoted_fj_fee_amount;
    let authwit_nonce = 44;
    let valid_until = env.last_block_timestamp() + 3600;
    let quote_sig = utils::sign_quote(
        fpc_address,
        token_address,
        quoted_fj_fee_amount,
        aa_payment_amount,
        valid_until,
        user,
    );

    let _ = env.call_private(
        user,
        fpc.fee_entrypoint(
            token_address,
            authwit_nonce,
            quoted_fj_fee_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );
}

#[test(should_fail_with = "Unknown auth witness for message hash")]
unconstrained fn fee_entrypoint_requires_fresh_transfer_authwit_each_call() {
    let (mut env, fpc_address, token_address, bridge_address, operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);
    let token = Token::at(token_address);

    let fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let aa_payment_amount = fj_fee_amount;
    let mint_amount = aa_payment_amount * (2 as u128) + (1000 as u128);
    env.call_private(bridge_address, token.mint_to_private(user, mint_amount));

    let valid_until = env.last_block_timestamp() + 3600;
    let quote_sig = utils::sign_quote(
        fpc_address,
        token_address,
        fj_fee_amount,
        aa_payment_amount,
        valid_until,
        user,
    );

    let transfer_call = token.transfer_private_to_private(
        user,
        operator,
        aa_payment_amount,
        TRANSFER_AUTHWIT_NONCE,
    );
    add_private_authwit_from_call(env, user, fpc_address, transfer_call);

    env.call_private(
        user,
        fpc.fee_entrypoint(
            token_address,
            TRANSFER_AUTHWIT_NONCE,
            fj_fee_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );

    // Use a fresh quote window for the second attempt so this test fails on
    // missing transfer authwit (the intended assertion), not quote replay/TTL.
    let valid_until_2 = env.last_block_timestamp() + 3000;
    let quote_sig_2 = utils::sign_quote(
        fpc_address,
        token_address,
        fj_fee_amount,
        aa_payment_amount,
        valid_until_2,
        user,
    );

    let _ = env.call_private(
        user,
        fpc.fee_entrypoint(
            token_address,
            TRANSFER_AUTHWIT_NONCE_2,
            fj_fee_amount,
            aa_payment_amount,
            valid_until_2,
            quote_sig_2,
        ),
    );
}

#[test(should_fail_with = "quote expired")]
unconstrained fn fee_entrypoint_rejects_expired_quote() {
    let (mut env, fpc_address, token_address, _bridge_address, _operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);

    let fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let aa_payment_amount = fj_fee_amount;
    let authwit_nonce = 99;

    let valid_until = env.last_block_timestamp();
    let quote_sig = utils::sign_quote(
        fpc_address,
        token_address,
        fj_fee_amount,
        aa_payment_amount,
        valid_until,
        user,
    );

    // Private call anchor timestamps use the last mined block; mine one block in the future
    // so anchor_ts > valid_until deterministically.
    env.mine_block_at(valid_until + 1);

    let _ = env.call_private(
        user,
        fpc.fee_entrypoint(
            token_address,
            authwit_nonce,
            fj_fee_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );
}

#[test(should_fail_with = "quote ttl too large")]
unconstrained fn fee_entrypoint_rejects_overlong_quote_ttl() {
    let (mut env, fpc_address, token_address, _bridge_address, _operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);

    let fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let aa_payment_amount = fj_fee_amount;
    let authwit_nonce = 100;

    // Contract bound is 3600 seconds from anchor timestamp.
    let valid_until = env.last_block_timestamp() + 3601;
    let quote_sig = utils::sign_quote(
        fpc_address,
        token_address,
        fj_fee_amount,
        aa_payment_amount,
        valid_until,
        user,
    );

    let _ = env.call_private(
        user,
        fpc.fee_entrypoint(
            token_address,
            authwit_nonce,
            fj_fee_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );
}

#[test(should_fail)]
unconstrained fn fee_entrypoint_rejects_quote_bound_to_another_user() {
    let (mut env, fpc_address, token_address, bridge_address, operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);
    let token = Token::at(token_address);
    let other_user = env.create_contract_account();

    let fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let aa_payment_amount = fj_fee_amount;
    let authwit_nonce = 7;
    let valid_until = env.last_block_timestamp() + 3600;

    env.call_private(
        bridge_address,
        token.mint_to_private(other_user, aa_payment_amount + (100 as u128)),
    );
    let transfer_call =
        token.transfer_private_to_private(other_user, operator, aa_payment_amount, authwit_nonce);
    add_private_authwit_from_call(env, other_user, fpc_address, transfer_call);

    // Sign the quote for `user`, but call from `other_user`. The quote hash
    // includes user_address = msg_sender, so the hash won't match and the
    // Schnorr signature will fail to verify.
    let quote_sig = utils::sign_quote(
        fpc_address,
        token_address,
        fj_fee_amount,
        aa_payment_amount,
        valid_until,
        user,
    );

    let _ = env.call_private(
        other_user,
        fpc.fee_entrypoint(
            token_address,
            authwit_nonce,
            fj_fee_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );
}

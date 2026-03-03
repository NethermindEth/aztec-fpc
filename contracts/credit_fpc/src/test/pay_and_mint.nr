use crate::{BackedCreditFPC, test::utils};
use aztec::protocol::address::AztecAddress;
use aztec::test::helpers::authwit::add_private_authwit_from_call;
use token::Token;

global TRANSFER_AUTHWIT_NONCE: Field = 42;
global TRANSFER_AUTHWIT_NONCE_2: Field = 43;

unconstrained fn quote_signature(
    credit_fpc_address: AztecAddress,
    accepted_asset: AztecAddress,
    fj_credit_amount: u128,
    aa_payment_amount: u128,
    valid_until: u64,
    user: AztecAddress,
) -> [u8; 64] {
    utils::sign_quote(
        credit_fpc_address,
        accepted_asset,
        fj_credit_amount,
        aa_payment_amount,
        valid_until,
        user,
    )
}

#[test]
unconstrained fn pay_and_mint_happy_path_transfers_charge_mints_credit_and_updates_totals() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let fj_credit_amount = max_gas_cost + (1000 as u128);
    let aa_payment_amount = fj_credit_amount;

    env.call_private(operator, token.mint_to_private(user, aa_payment_amount + (100 as u128)));

    let valid_until = env.last_block_timestamp() + 3600;
    let quote_sig = quote_signature(
        credit_fpc_address,
        token_address,
        fj_credit_amount,
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
    add_private_authwit_from_call(env, user, credit_fpc_address, transfer_call);

    let user_token_before = utils::private_balance(env, token_address, user);
    let operator_token_before = utils::private_balance(env, token_address, operator);
    let totals_before = utils::total_unspent_credits(env, credit_fpc_address);

    env.call_private(
        user,
        credit_fpc.pay_and_mint(
            token_address,
            TRANSFER_AUTHWIT_NONCE,
            fj_credit_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );

    let user_token_after = utils::private_balance(env, token_address, user);
    let operator_token_after = utils::private_balance(env, token_address, operator);
    let credit = utils::credit_balance(env, credit_fpc_address, user);
    let totals_after = utils::total_unspent_credits(env, credit_fpc_address);
    let net_credit = fj_credit_amount - max_gas_cost;

    assert_eq(user_token_after, user_token_before - aa_payment_amount);
    assert_eq(operator_token_after, operator_token_before + aa_payment_amount);
    assert_eq(credit, net_credit);
    assert_eq(totals_after, totals_before + net_credit);
}

#[test]
unconstrained fn pay_and_mint_supports_different_credit_and_payment_amounts() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let fj_credit_amount = max_gas_cost + (1000 as u128);
    let aa_payment_amount = fj_credit_amount * (5 as u128) / (4 as u128) + (1 as u128);

    env.call_private(operator, token.mint_to_private(user, aa_payment_amount + (100 as u128)));

    let valid_until = env.last_block_timestamp() + 3600;
    let quote_sig = quote_signature(
        credit_fpc_address,
        token_address,
        fj_credit_amount,
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
    add_private_authwit_from_call(env, user, credit_fpc_address, transfer_call);

    let user_token_before = utils::private_balance(env, token_address, user);
    let operator_token_before = utils::private_balance(env, token_address, operator);

    env.call_private(
        user,
        credit_fpc.pay_and_mint(
            token_address,
            TRANSFER_AUTHWIT_NONCE,
            fj_credit_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );

    let user_token_after = utils::private_balance(env, token_address, user);
    let operator_token_after = utils::private_balance(env, token_address, operator);
    let credit = utils::credit_balance(env, credit_fpc_address, user);

    assert_eq(user_token_after, user_token_before - aa_payment_amount);
    assert_eq(operator_token_after, operator_token_before + aa_payment_amount);
    assert_eq(credit, fj_credit_amount - max_gas_cost);
}

#[test(should_fail_with = "quote expired")]
unconstrained fn pay_and_mint_rejects_expired_quote() {
    let (mut env, credit_fpc_address, token_address, _operator, user) = utils::setup();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let fj_credit_amount = max_gas_cost + (1000 as u128);
    let aa_payment_amount = fj_credit_amount;
    let valid_until = env.last_block_timestamp();
    let quote_sig = quote_signature(
        credit_fpc_address,
        token_address,
        fj_credit_amount,
        aa_payment_amount,
        valid_until,
        user,
    );

    env.mine_block_at(valid_until + 1);

    let _ = env.call_private(
        user,
        credit_fpc.pay_and_mint(
            token_address,
            TRANSFER_AUTHWIT_NONCE,
            fj_credit_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );
}

#[test(should_fail_with = "invalid quote signature")]
unconstrained fn pay_and_mint_rejects_quote_bound_to_another_user() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);
    let other_user = env.create_contract_account();

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let fj_credit_amount = max_gas_cost + (1000 as u128);
    let aa_payment_amount = fj_credit_amount;
    let valid_until = env.last_block_timestamp() + 3600;

    env.call_private(operator, token.mint_to_private(other_user, aa_payment_amount + (100 as u128)));
    let transfer_call = token.transfer_private_to_private(
        other_user,
        operator,
        aa_payment_amount,
        TRANSFER_AUTHWIT_NONCE,
    );
    add_private_authwit_from_call(env, other_user, credit_fpc_address, transfer_call);

    let quote_sig = quote_signature(
        credit_fpc_address,
        token_address,
        fj_credit_amount,
        aa_payment_amount,
        valid_until,
        user,
    );

    let _ = env.call_private(
        other_user,
        credit_fpc.pay_and_mint(
            token_address,
            TRANSFER_AUTHWIT_NONCE,
            fj_credit_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );
}

#[test(should_fail_with = "invalid quote signature")]
unconstrained fn pay_and_mint_rejects_tampered_fj_credit_amount() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let quoted_fj_credit_amount = max_gas_cost + (1000 as u128);
    let tampered_fj_credit_amount = quoted_fj_credit_amount + (1 as u128);
    let aa_payment_amount = quoted_fj_credit_amount;
    let valid_until = env.last_block_timestamp() + 3600;

    env.call_private(operator, token.mint_to_private(user, aa_payment_amount + (100 as u128)));
    let transfer_call = token.transfer_private_to_private(
        user,
        operator,
        aa_payment_amount,
        TRANSFER_AUTHWIT_NONCE,
    );
    add_private_authwit_from_call(env, user, credit_fpc_address, transfer_call);

    let quote_sig = quote_signature(
        credit_fpc_address,
        token_address,
        quoted_fj_credit_amount,
        aa_payment_amount,
        valid_until,
        user,
    );

    let _ = env.call_private(
        user,
        credit_fpc.pay_and_mint(
            token_address,
            TRANSFER_AUTHWIT_NONCE,
            tampered_fj_credit_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );
}

#[test(should_fail_with = "invalid quote signature")]
unconstrained fn pay_and_mint_rejects_tampered_aa_payment_amount() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let fj_credit_amount = max_gas_cost + (1000 as u128);
    let quoted_aa_payment_amount = fj_credit_amount;
    let tampered_aa_payment_amount = quoted_aa_payment_amount - (1 as u128);
    let valid_until = env.last_block_timestamp() + 3600;

    env.call_private(operator, token.mint_to_private(user, quoted_aa_payment_amount + (100 as u128)));
    let transfer_call = token.transfer_private_to_private(
        user,
        operator,
        tampered_aa_payment_amount,
        TRANSFER_AUTHWIT_NONCE,
    );
    add_private_authwit_from_call(env, user, credit_fpc_address, transfer_call);

    let quote_sig = quote_signature(
        credit_fpc_address,
        token_address,
        fj_credit_amount,
        quoted_aa_payment_amount,
        valid_until,
        user,
    );

    let _ = env.call_private(
        user,
        credit_fpc.pay_and_mint(
            token_address,
            TRANSFER_AUTHWIT_NONCE,
            fj_credit_amount,
            tampered_aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );
}

#[test(should_fail_with = "Unknown auth witness for message hash")]
unconstrained fn pay_and_mint_requires_fresh_transfer_authwit_each_call() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let fj_credit_amount = max_gas_cost + (1000 as u128);
    let aa_payment_amount = fj_credit_amount;

    env.call_private(
        operator,
        token.mint_to_private(user, aa_payment_amount * (2 as u128) + (100 as u128)),
    );

    let valid_until = env.last_block_timestamp() + 3600;
    let quote_sig = quote_signature(
        credit_fpc_address,
        token_address,
        fj_credit_amount,
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
    add_private_authwit_from_call(env, user, credit_fpc_address, transfer_call);

    env.call_private(
        user,
        credit_fpc.pay_and_mint(
            token_address,
            TRANSFER_AUTHWIT_NONCE,
            fj_credit_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );

    let valid_until_2 = valid_until + 1;
    let quote_sig_2 = quote_signature(
        credit_fpc_address,
        token_address,
        fj_credit_amount,
        aa_payment_amount,
        valid_until_2,
        user,
    );

    let _ = env.call_private(
        user,
        credit_fpc.pay_and_mint(
            token_address,
            TRANSFER_AUTHWIT_NONCE_2,
            fj_credit_amount,
            aa_payment_amount,
            valid_until_2,
            quote_sig_2,
        ),
    );
}

#[test(should_fail_with = "invalid quote signature")]
unconstrained fn pay_and_mint_rejects_tampered_accepted_asset() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);

    let other_token_initializer = Token::interface().constructor_with_minter(
        "OtherToken000000000000000000000",
        "OT00000000000000000000000000000",
        18,
        operator,
        AztecAddress::zero(),
    );
    let other_token_address = env.deploy("@token_contract/Token").with_public_initializer(
        operator,
        other_token_initializer,
    );

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let fj_credit_amount = max_gas_cost + (1000 as u128);
    let aa_payment_amount = fj_credit_amount;
    let valid_until = env.last_block_timestamp() + 3600;

    let quote_sig = quote_signature(
        credit_fpc_address,
        token_address,
        fj_credit_amount,
        aa_payment_amount,
        valid_until,
        user,
    );

    let _ = env.call_private(
        user,
        credit_fpc.pay_and_mint(
            other_token_address,
            TRANSFER_AUTHWIT_NONCE,
            fj_credit_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );
}

#[test]
unconstrained fn pay_and_mint_credit_equals_fj_credit_amount_minus_max_gas_cost() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let fj_credit_amount = max_gas_cost + (500 as u128);
    let aa_payment_amount = fj_credit_amount;
    let valid_until = env.last_block_timestamp() + 3600;

    env.call_private(operator, token.mint_to_private(user, aa_payment_amount + (100 as u128)));
    let transfer_call = token.transfer_private_to_private(
        user,
        operator,
        aa_payment_amount,
        TRANSFER_AUTHWIT_NONCE,
    );
    add_private_authwit_from_call(env, user, credit_fpc_address, transfer_call);

    let quote_sig = quote_signature(
        credit_fpc_address,
        token_address,
        fj_credit_amount,
        aa_payment_amount,
        valid_until,
        user,
    );

    env.call_private(
        user,
        credit_fpc.pay_and_mint(
            token_address,
            TRANSFER_AUTHWIT_NONCE,
            fj_credit_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );

    let credit = utils::credit_balance(env, credit_fpc_address, user);
    assert_eq(credit, fj_credit_amount - max_gas_cost);
}

#[test]
unconstrained fn pay_and_mint_prevents_quote_replay() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let fj_credit_amount = max_gas_cost + (1000 as u128);
    let aa_payment_amount = fj_credit_amount;
    let valid_until = env.last_block_timestamp() + 3600;

    env.call_private(operator, token.mint_to_private(user, aa_payment_amount + (100 as u128)));
    let quote_sig = quote_signature(
        credit_fpc_address,
        token_address,
        fj_credit_amount,
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
    add_private_authwit_from_call(env, user, credit_fpc_address, transfer_call);

    env.call_private(
        user,
        credit_fpc.pay_and_mint(
            token_address,
            TRANSFER_AUTHWIT_NONCE,
            fj_credit_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );

    assert(
        env.simulate_utility(credit_fpc.quote_used(
            token_address,
            fj_credit_amount,
            aa_payment_amount,
            valid_until,
            user,
        )),
        "quote nullifier should exist",
    );
}

#[test(should_fail_with = "duplicate siloed nullifier")]
unconstrained fn pay_and_mint_rejects_same_quote_even_with_new_authwit_nonce() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let fj_credit_amount = max_gas_cost + (1000 as u128);
    let aa_payment_amount = fj_credit_amount;
    let valid_until = env.last_block_timestamp() + 3600;

    env.call_private(
        operator,
        token.mint_to_private(user, aa_payment_amount * (2 as u128) + (100 as u128)),
    );

    let quote_sig = quote_signature(
        credit_fpc_address,
        token_address,
        fj_credit_amount,
        aa_payment_amount,
        valid_until,
        user,
    );

    let transfer_call_1 = token.transfer_private_to_private(
        user,
        operator,
        aa_payment_amount,
        TRANSFER_AUTHWIT_NONCE,
    );
    add_private_authwit_from_call(env, user, credit_fpc_address, transfer_call_1);

    env.call_private(
        user,
        credit_fpc.pay_and_mint(
            token_address,
            TRANSFER_AUTHWIT_NONCE,
            fj_credit_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );

    let transfer_call_2 = token.transfer_private_to_private(
        user,
        operator,
        aa_payment_amount,
        TRANSFER_AUTHWIT_NONCE_2,
    );
    add_private_authwit_from_call(env, user, credit_fpc_address, transfer_call_2);

    let _ = env.call_private(
        user,
        credit_fpc.pay_and_mint(
            token_address,
            TRANSFER_AUTHWIT_NONCE_2,
            fj_credit_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );
}

#[test]
unconstrained fn pay_and_mint_accepts_quote_when_valid_until_equals_anchor_timestamp() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let fj_credit_amount = max_gas_cost + (1000 as u128);
    let aa_payment_amount = fj_credit_amount;
    let valid_until = env.last_block_timestamp();
    let quote_sig = quote_signature(
        credit_fpc_address,
        token_address,
        fj_credit_amount,
        aa_payment_amount,
        valid_until,
        user,
    );

    env.call_private(operator, token.mint_to_private(user, aa_payment_amount + (100 as u128)));
    let transfer_call = token.transfer_private_to_private(
        user,
        operator,
        aa_payment_amount,
        TRANSFER_AUTHWIT_NONCE,
    );
    add_private_authwit_from_call(env, user, credit_fpc_address, transfer_call);

    env.call_private(
        user,
        credit_fpc.pay_and_mint(
            token_address,
            TRANSFER_AUTHWIT_NONCE,
            fj_credit_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );
}

#[test(should_fail_with = "insufficient FeeJuice backing")]
unconstrained fn pay_and_mint_rejects_mint_when_fee_juice_backing_is_insufficient() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_gas_cost = utils::max_gas_cost(env);
    let fj_credit_amount = max_gas_cost + (1_000_000_001 as u128);
    let aa_payment_amount = fj_credit_amount;
    let valid_until = env.last_block_timestamp() + 3600;
    let quote_sig = quote_signature(
        credit_fpc_address,
        token_address,
        fj_credit_amount,
        aa_payment_amount,
        valid_until,
        user,
    );

    env.call_private(operator, token.mint_to_private(user, aa_payment_amount + (100 as u128)));
    let transfer_call = token.transfer_private_to_private(
        user,
        operator,
        aa_payment_amount,
        TRANSFER_AUTHWIT_NONCE,
    );
    add_private_authwit_from_call(env, user, credit_fpc_address, transfer_call);

    let _ = env.call_private(
        user,
        credit_fpc.pay_and_mint(
            token_address,
            TRANSFER_AUTHWIT_NONCE,
            fj_credit_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );
}

#[test(should_fail_with = "attempt to add with overflow")]
unconstrained fn pay_and_mint_rejects_when_unspent_credits_would_overflow() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_u128: u128 = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;
    utils::set_total_unspent_credits(env, credit_fpc_address, max_u128);

    let max_gas_cost = utils::max_gas_cost(env);
    let fj_credit_amount = max_gas_cost + (1 as u128);
    let aa_payment_amount = fj_credit_amount;
    let valid_until = env.last_block_timestamp() + 3600;
    let quote_sig = quote_signature(
        credit_fpc_address,
        token_address,
        fj_credit_amount,
        aa_payment_amount,
        valid_until,
        user,
    );

    env.call_private(operator, token.mint_to_private(user, aa_payment_amount + (100 as u128)));
    let transfer_call = token.transfer_private_to_private(
        user,
        operator,
        aa_payment_amount,
        TRANSFER_AUTHWIT_NONCE,
    );
    add_private_authwit_from_call(env, user, credit_fpc_address, transfer_call);

    let _ = env.call_private(
        user,
        credit_fpc.pay_and_mint(
            token_address,
            TRANSFER_AUTHWIT_NONCE,
            fj_credit_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );
}

use crate::{BackedCreditFPC, test::utils};
use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};
use aztec::test::helpers::authwit::add_private_authwit_from_call;
use token::Token;

global TRANSFER_AUTHWIT_NONCE: Field = 4242;

unconstrained fn setup_with_credit() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress, u128, u128, u128) {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_gas_cost_no_teardown = utils::max_gas_cost_no_teardown(env);
    let fj_credit_amount = max_gas_cost_no_teardown + (1000 as u128);
    let aa_payment_amount = fj_credit_amount;
    let valid_until = env.last_block_timestamp() + 3600;
    let quote_sig = utils::sign_quote(
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

    (
        env, credit_fpc_address, token_address, operator, user, fj_credit_amount,
        max_gas_cost_no_teardown, utils::max_gas_cost(env),
    )
}

#[test]
unconstrained fn pay_with_credit_decrements_credit_balance_and_totals() {
    let (mut env, credit_fpc_address, _token_address, _operator, user, fj_credit_amount, max_gas_cost_no_teardown, max_gas_cost) =
        setup_with_credit();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);

    let credit_before = utils::credit_balance(env, credit_fpc_address, user);
    let totals_before = utils::total_unspent_credits(env, credit_fpc_address);
    assert_eq(credit_before, fj_credit_amount - max_gas_cost_no_teardown);
    assert_eq(totals_before, credit_before);

    env.call_private(user, credit_fpc.pay_with_credit());

    let credit_after = utils::credit_balance(env, credit_fpc_address, user);
    let totals_after = utils::total_unspent_credits(env, credit_fpc_address);
    assert_eq(credit_after, credit_before - max_gas_cost);
    assert_eq(totals_after, totals_before - max_gas_cost);
}

#[test]
unconstrained fn pay_with_credit_does_not_transfer_payment_asset() {
    let (mut env, credit_fpc_address, token_address, operator, user, _, _, _) = setup_with_credit();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);

    let user_token_before = utils::private_balance(env, token_address, user);
    let operator_token_before = utils::private_balance(env, token_address, operator);

    env.call_private(user, credit_fpc.pay_with_credit());

    let user_token_after = utils::private_balance(env, token_address, user);
    let operator_token_after = utils::private_balance(env, token_address, operator);
    assert_eq(user_token_after, user_token_before);
    assert_eq(operator_token_after, operator_token_before);
}

#[test]
unconstrained fn pay_with_credit_exact_decrements_credit_and_totals_by_same_amount() {
    let (mut env, credit_fpc_address, _token_address, _operator, user, _, _, max_gas_cost) =
        setup_with_credit();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);

    let credit_before = utils::credit_balance(env, credit_fpc_address, user);
    let totals_before = utils::total_unspent_credits(env, credit_fpc_address);

    env.call_private(user, credit_fpc.pay_with_credit_exact());

    let credit_after = utils::credit_balance(env, credit_fpc_address, user);
    let totals_after = utils::total_unspent_credits(env, credit_fpc_address);
    let credit_delta = credit_before - credit_after;
    let totals_delta = totals_before - totals_after;

    // Exact settle path must keep per-user credit delta aligned with global totals delta.
    assert_eq(credit_delta, totals_delta);
    // Exact settle should never deduct more than max fee for the tx.
    assert(credit_delta <= max_gas_cost, "exact credit delta exceeds max fee");
}

#[test]
unconstrained fn pay_with_credit_exact_does_not_transfer_payment_asset() {
    let (mut env, credit_fpc_address, token_address, operator, user, _, _, _) = setup_with_credit();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);

    let user_token_before = utils::private_balance(env, token_address, user);
    let operator_token_before = utils::private_balance(env, token_address, operator);

    env.call_private(user, credit_fpc.pay_with_credit_exact());

    let user_token_after = utils::private_balance(env, token_address, user);
    let operator_token_after = utils::private_balance(env, token_address, operator);
    assert_eq(user_token_after, user_token_before);
    assert_eq(operator_token_after, operator_token_before);
}

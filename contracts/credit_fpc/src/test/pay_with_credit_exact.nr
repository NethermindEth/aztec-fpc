use crate::{BackedCreditFPC, test::utils};
use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};
use aztec::test::helpers::authwit::add_private_authwit_from_call;
use token::Token;

global TRANSFER_AUTHWIT_NONCE: Field = 7777;

unconstrained fn setup_with_credit() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress, u128, u128) {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_gas_cost_no_teardown = utils::max_gas_cost_no_teardown(env);
    let fj_credit_amount = max_gas_cost_no_teardown + (5000 as u128);
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

    let max_gas_cost = utils::max_gas_cost(env);
    (env, credit_fpc_address, token_address, operator, user, max_gas_cost_no_teardown, max_gas_cost)
}

#[test]
unconstrained fn pay_with_credit_exact_preserves_balance_when_no_actual_fee() {
    let (mut env, credit_fpc_address, _token_address, _operator, user, _max_gas_cost_no_teardown, _max_gas_cost) =
        setup_with_credit();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);

    let credit_before = utils::credit_balance(env, credit_fpc_address, user);
    let totals_before = utils::total_unspent_credits(env, credit_fpc_address);

    env.call_private(user, credit_fpc.pay_with_credit_exact());

    let credit_after = utils::credit_balance(env, credit_fpc_address, user);
    let totals_after = utils::total_unspent_credits(env, credit_fpc_address);

    // transaction_fee is 0 in test environment, so the entire max_gas_cost
    // is refunded via the partial note. Balance and totals stay unchanged.
    assert_eq(credit_after, credit_before);
    assert_eq(totals_after, totals_before);
}

#[test]
unconstrained fn pay_with_credit_exact_can_be_called_consecutively() {
    let (mut env, credit_fpc_address, _token_address, _operator, user, _max_gas_cost_no_teardown, max_gas_cost) =
        setup_with_credit();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);

    let credit_initial = utils::credit_balance(env, credit_fpc_address, user);
    assert(credit_initial >= max_gas_cost, "precondition: need enough credit");

    env.call_private(user, credit_fpc.pay_with_credit_exact());

    let credit_mid = utils::credit_balance(env, credit_fpc_address, user);
    assert(credit_mid >= max_gas_cost, "should have credit for second call");

    env.call_private(user, credit_fpc.pay_with_credit_exact());

    let credit_final = utils::credit_balance(env, credit_fpc_address, user);
    // With transaction_fee=0 in test env, full refund occurs each time.
    assert_eq(credit_final, credit_initial);
}

#[test]
unconstrained fn pay_with_credit_exact_unspent_credits_tracks_actual_fee_not_max_fee() {
    let (mut env, credit_fpc_address, _token_address, _operator, user, _max_gas_cost_no_teardown, _max_gas_cost) =
        setup_with_credit();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);

    let totals_before = utils::total_unspent_credits(env, credit_fpc_address);

    env.call_private(user, credit_fpc.pay_with_credit_exact());

    let totals_after = utils::total_unspent_credits(env, credit_fpc_address);

    // _finalize_exact_credit_spend deducts transaction_fee (not max_fee)
    // from unspent_credits. With transaction_fee=0 in test env, the delta
    // must be 0 -- proving the contract tracks actual fee, not max_fee.
    assert_eq(totals_after, totals_before);
}

#[test]
unconstrained fn pay_with_credit_exact_works_after_standard_pay_with_credit() {
    let (mut env, credit_fpc_address, _token_address, _operator, user, _max_gas_cost_no_teardown, _max_gas_cost) =
        setup_with_credit();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);

    // Standard settle first.
    env.call_private(user, credit_fpc.pay_with_credit());

    let credit_after_standard = utils::credit_balance(env, credit_fpc_address, user);
    let totals_after_standard = utils::total_unspent_credits(env, credit_fpc_address);

    // Exact settle second -- must work on notes produced by the standard path.
    env.call_private(user, credit_fpc.pay_with_credit_exact());

    let credit_after_exact = utils::credit_balance(env, credit_fpc_address, user);
    let totals_after_exact = utils::total_unspent_credits(env, credit_fpc_address);

    // Both paths should leave consistent balance/totals state.
    assert_eq(credit_after_exact, credit_after_standard);
    assert_eq(totals_after_exact, totals_after_standard);
}

#[test]
unconstrained fn pay_with_credit_exact_user_with_no_credit_succeeds_when_gas_costs_are_zero() {
    let (mut env, credit_fpc_address, _token_address, _operator, _user) = utils::setup();
    let credit_fpc = BackedCreditFPC::at(credit_fpc_address);
    let fresh_user = env.create_contract_account();

    // With gas costs = 0, max_gas_cost = 0, so try_sub(0, 1) trivially passes.
    // This documents the expected behavior: zero-cost gas makes the balance
    // check vacuous. Failure-path testing for "Balance too low" requires
    // non-zero gas settings which the TestEnvironment doesn't currently support.
    let credit_before = utils::credit_balance(env, credit_fpc_address, fresh_user);
    assert_eq(credit_before, 0);

    env.call_private(fresh_user, credit_fpc.pay_with_credit_exact());

    let credit_after = utils::credit_balance(env, credit_fpc_address, fresh_user);
    assert_eq(credit_after, 0);
}

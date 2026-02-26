use crate::{CreditFPC, test::utils};
use aztec::test::helpers::authwit::add_private_authwit_from_call;
use token::Token;

global TRANSFER_AUTHWIT_NONCE: Field = 42;

// Happy path: mint credit via dev_mint, then pay with it.
//
// NOTE: TXE uses zero gas prices so max_gas_cost is always 0. This means
// pay_with_credit deducts nothing and the balance is preserved. The test
// still exercises the full call path (storage read, try_sub, add change,
// set_as_fee_payer, end_setup).
#[test]
unconstrained fn pay_with_credit_happy_path() {
    let (mut env, credit_fpc_address, _, _, user) = utils::setup();
    let credit_fpc = CreditFPC::at(credit_fpc_address);

    let credit_amount = 1000 as u128;
    env.call_private(user, credit_fpc.dev_mint(credit_amount));

    let balance_before = utils::credit_balance(env, credit_fpc_address, user);
    assert_eq(balance_before, credit_amount);

    env.call_private(user, credit_fpc.pay_with_credit());

    let balance_after = utils::credit_balance(env, credit_fpc_address, user);
    assert_eq(balance_after, credit_amount);
}

// Full flow: pay_and_mint deposits tokens and creates credit, then
// pay_with_credit uses that credit to pay fees.
#[test]
unconstrained fn pay_with_credit_after_pay_and_mint() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = CreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let rate_num = 1 as u128;
    let rate_den = 1 as u128;
    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let mint_amount = max_gas_cost + (1000 as u128);
    let charge = mint_amount;

    env.call_private(operator, token.mint_to_private(user, charge + (100 as u128)));

    let valid_until = env.last_block_timestamp() + 3600;
    let quote_sig = utils::sign_quote(
        credit_fpc_address,
        token_address,
        rate_num,
        rate_den,
        valid_until,
        user,
    );

    let transfer_call =
        token.transfer_private_to_public(user, credit_fpc_address, charge, TRANSFER_AUTHWIT_NONCE);
    add_private_authwit_from_call(env, user, credit_fpc_address, transfer_call);

    env.call_private(
        user,
        credit_fpc.pay_and_mint(
            TRANSFER_AUTHWIT_NONCE,
            rate_num,
            rate_den,
            valid_until,
            quote_sig,
            mint_amount,
        ),
    );

    let credit_before = utils::credit_balance(env, credit_fpc_address, user);
    assert(credit_before > 0);

    env.call_private(user, credit_fpc.pay_with_credit());

    let credit_after = utils::credit_balance(env, credit_fpc_address, user);
    assert_eq(credit_after, credit_before);
}

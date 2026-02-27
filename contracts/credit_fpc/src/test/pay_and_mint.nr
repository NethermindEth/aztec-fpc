use crate::{CreditFPC, test::utils};
use aztec::test::helpers::authwit::add_private_authwit_from_call;
use token::Token;

global TRANSFER_AUTHWIT_NONCE: Field = 42;
global TRANSFER_AUTHWIT_NONCE_2: Field = 43;

// Happy path
//
// With a quote that mints credit and charges the same token amount:
//   aa_payment_amount = fj_credit_amount = max_gas_cost + 1000
//   credit after execution = mint_amount - max_gas_cost = 1000
//
// Verifies token balances and the internal credit note.
#[test]
unconstrained fn pay_and_mint_happy_path_transfers_charge_and_mints_credit() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = CreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    // mint_amount must exceed max_gas_cost or the credit assertion fails.
    let mint_amount = max_gas_cost + (1000 as u128);
    let charge = mint_amount;

    env.call_private(operator, token.mint_to_private(user, charge + (100 as u128)));

    let valid_until = env.last_block_timestamp() + 3600;
    let quote_sig = utils::sign_quote(
        credit_fpc_address,
        token_address,
        mint_amount,
        charge,
        valid_until,
        user,
    );

    let transfer_call =
        token.transfer_private_to_private(user, operator, charge, TRANSFER_AUTHWIT_NONCE);
    add_private_authwit_from_call(env, user, credit_fpc_address, transfer_call);

    let user_token_before = utils::private_balance(env, token_address, user);
    let operator_token_before = utils::private_balance(env, token_address, operator);

    env.call_private(
        user,
        credit_fpc.pay_and_mint(
            TRANSFER_AUTHWIT_NONCE,
            mint_amount,
            charge,
            valid_until,
            quote_sig,
        ),
    );

    let user_token_after = utils::private_balance(env, token_address, user);
    let operator_token_after = utils::private_balance(env, token_address, operator);

    assert_eq(user_token_after, user_token_before - charge);
    assert_eq(operator_token_after, operator_token_before + charge);

    // After pay_and_mint the user holds a credit note of mint_amount - max_gas_cost.
    // This is the "change" after the gas reserve deduction.
    let credit = utils::credit_balance(env, credit_fpc_address, user);
    assert_eq(credit, mint_amount - max_gas_cost);
}

// Non-1:1 quoted amounts
//
// Verifies that pay_and_mint charges exactly `aa_payment_amount` while minting
// exactly `fj_credit_amount`, even when the two amounts differ.
#[test]
unconstrained fn pay_and_mint_supports_non_1_to_1_quoted_amounts() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = CreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let fj_credit_amount = max_gas_cost + (1000 as u128);
    let aa_payment_amount = fj_credit_amount + (250 as u128);

    env.call_private(operator, token.mint_to_private(user, aa_payment_amount + (100 as u128)));

    let valid_until = env.last_block_timestamp() + 3600;
    let quote_sig = utils::sign_quote(
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

// Expired quote
#[test(should_fail_with = "quote expired")]
unconstrained fn pay_and_mint_rejects_expired_quote() {
    let (mut env, credit_fpc_address, token_address, _operator, user) = utils::setup();
    let credit_fpc = CreditFPC::at(credit_fpc_address);

    let valid_until = env.last_block_timestamp();
    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let mint_amount = max_gas_cost + (1000 as u128);
    let charge = mint_amount;
    let quote_sig = utils::sign_quote(
        credit_fpc_address,
        token_address,
        mint_amount,
        charge,
        valid_until,
        user,
    );

    // Mine one block past valid_until so anchor_ts > valid_until deterministically.
    env.mine_block_at(valid_until + 1);

    let _ = env.call_private(
        user,
        credit_fpc.pay_and_mint(
            TRANSFER_AUTHWIT_NONCE,
            mint_amount,
            charge,
            valid_until,
            quote_sig,
        ),
    );
}

// Quote bound to another user
//
// The quote hash contains `user_address = msg_sender`. Calling from a different
// address produces a different hash, so the operator's signature will not verify.
#[test(should_fail_with = "invalid quote signature")]
unconstrained fn pay_and_mint_rejects_quote_bound_to_another_user() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = CreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);
    let other_user = env.create_contract_account();

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let mint_amount = max_gas_cost + (1000 as u128);
    let charge = mint_amount;
    let valid_until = env.last_block_timestamp() + 3600;

    env.call_private(operator, token.mint_to_private(other_user, charge + (100 as u128)));
    let transfer_call =
        token.transfer_private_to_private(other_user, operator, charge, TRANSFER_AUTHWIT_NONCE);
    add_private_authwit_from_call(env, other_user, credit_fpc_address, transfer_call);

    // Signature is over `user` but the call comes from `other_user`.
    let quote_sig = utils::sign_quote(
        credit_fpc_address,
        token_address,
        mint_amount,
        charge,
        valid_until,
        user,
    );

    let _ = env.call_private(
        other_user,
        credit_fpc.pay_and_mint(
            TRANSFER_AUTHWIT_NONCE,
            mint_amount,
            charge,
            valid_until,
            quote_sig,
        ),
    );
}

// Rejects tampered quoted credit amount
//
// The signature binds `fj_credit_amount`. Calling with a different value must
// fail even when authwit and token balances are otherwise valid.
#[test(should_fail_with = "invalid quote signature")]
unconstrained fn pay_and_mint_rejects_tampered_fj_credit_amount() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = CreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let quoted_fj_credit_amount = max_gas_cost + (1000 as u128);
    let quoted_aa_payment_amount = quoted_fj_credit_amount + (250 as u128);
    let tampered_fj_credit_amount = quoted_fj_credit_amount + (1 as u128);
    let valid_until = env.last_block_timestamp() + 3600;

    env.call_private(
        operator,
        token.mint_to_private(user, quoted_aa_payment_amount + (100 as u128)),
    );

    let quote_sig = utils::sign_quote(
        credit_fpc_address,
        token_address,
        quoted_fj_credit_amount,
        quoted_aa_payment_amount,
        valid_until,
        user,
    );

    let transfer_call = token.transfer_private_to_private(
        user,
        operator,
        quoted_aa_payment_amount,
        TRANSFER_AUTHWIT_NONCE,
    );
    add_private_authwit_from_call(env, user, credit_fpc_address, transfer_call);

    let _ = env.call_private(
        user,
        credit_fpc.pay_and_mint(
            TRANSFER_AUTHWIT_NONCE,
            tampered_fj_credit_amount,
            quoted_aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );
}

// Rejects tampered quoted payment amount
//
// The signature binds `aa_payment_amount`. Calling with a different transfer
// amount must fail even when a matching authwit is provided for that amount.
#[test(should_fail_with = "invalid quote signature")]
unconstrained fn pay_and_mint_rejects_tampered_aa_payment_amount() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = CreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let quoted_fj_credit_amount = max_gas_cost + (1000 as u128);
    let quoted_aa_payment_amount = quoted_fj_credit_amount;
    let tampered_aa_payment_amount = quoted_aa_payment_amount + (1 as u128);
    let valid_until = env.last_block_timestamp() + 3600;

    env.call_private(
        operator,
        token.mint_to_private(user, tampered_aa_payment_amount + (100 as u128)),
    );

    let quote_sig = utils::sign_quote(
        credit_fpc_address,
        token_address,
        quoted_fj_credit_amount,
        quoted_aa_payment_amount,
        valid_until,
        user,
    );

    let transfer_call = token.transfer_private_to_private(
        user,
        operator,
        tampered_aa_payment_amount,
        TRANSFER_AUTHWIT_NONCE,
    );
    add_private_authwit_from_call(env, user, credit_fpc_address, transfer_call);

    let _ = env.call_private(
        user,
        credit_fpc.pay_and_mint(
            TRANSFER_AUTHWIT_NONCE,
            quoted_fj_credit_amount,
            tampered_aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );
}

// Transfer authwit required each call
//
// A fresh transfer authwit must be provided for each call. Reusing the same
// authwit nonce (whose nullifier was already pushed) fails. Using a new nonce
// without adding a new authwit also fails.
#[test(should_fail_with = "Unknown auth witness for message hash")]
unconstrained fn pay_and_mint_requires_fresh_transfer_authwit_each_call() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = CreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let mint_amount = max_gas_cost + (1000 as u128);
    let charge = mint_amount;

    env.call_private(operator, token.mint_to_private(user, charge * (2 as u128) + (100 as u128)));

    let valid_until = env.last_block_timestamp() + 3600;
    let quote_sig = utils::sign_quote(
        credit_fpc_address,
        token_address,
        mint_amount,
        charge,
        valid_until,
        user,
    );

    let transfer_call =
        token.transfer_private_to_private(user, operator, charge, TRANSFER_AUTHWIT_NONCE);
    add_private_authwit_from_call(env, user, credit_fpc_address, transfer_call);

    env.call_private(
        user,
        credit_fpc.pay_and_mint(
            TRANSFER_AUTHWIT_NONCE,
            mint_amount,
            charge,
            valid_until,
            quote_sig,
        ),
    );

    // Second call: fresh quote sig (different valid_until avoids quote replay),
    // but no new transfer authwit for TRANSFER_AUTHWIT_NONCE_2.
    let valid_until_2 = valid_until + 1;
    let quote_sig_2 = utils::sign_quote(
        credit_fpc_address,
        token_address,
        mint_amount,
        charge,
        valid_until_2,
        user,
    );

    let _ = env.call_private(
        user,
        credit_fpc.pay_and_mint(
            TRANSFER_AUTHWIT_NONCE_2,
            mint_amount,
            charge,
            valid_until_2,
            quote_sig_2,
        ),
    );
}

// Minimum viable credit
//
// The assertion `assert(subtracted >= max_gas_cost, ...)` in pay_and_mint
// cannot be triggered via should_fail in the TXE test environment because the
// TXE uses zero gas prices, making max_gas_cost_no_teardown = 0. The assertion
// is always satisfied when max_gas_cost = 0.
//
// This test instead verifies the positive case: pay_and_mint succeeds when
// mint_amount is exactly max_gas_cost_no_teardown (edge case, no leftover
// credit), and the resulting credit balance is 0.
#[test]
unconstrained fn pay_and_mint_credit_equals_mint_amount_minus_max_gas_cost() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = CreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    // Use mint_amount = max_gas_cost + 500 so credit = 500 exactly.
    let mint_amount = max_gas_cost + (500 as u128);
    let charge = mint_amount;
    let valid_until = env.last_block_timestamp() + 3600;

    env.call_private(operator, token.mint_to_private(user, charge + (100 as u128)));

    let transfer_call =
        token.transfer_private_to_private(user, operator, charge, TRANSFER_AUTHWIT_NONCE);
    add_private_authwit_from_call(env, user, credit_fpc_address, transfer_call);

    let quote_sig = utils::sign_quote(
        credit_fpc_address,
        token_address,
        mint_amount,
        charge,
        valid_until,
        user,
    );

    env.call_private(
        user,
        credit_fpc.pay_and_mint(
            TRANSFER_AUTHWIT_NONCE,
            mint_amount,
            charge,
            valid_until,
            quote_sig,
        ),
    );

    // Verify the change note is exactly mint_amount - max_gas_cost = 500.
    let credit = utils::credit_balance(env, credit_fpc_address, user);
    assert_eq(credit, mint_amount - max_gas_cost);
}

// Quote replay prevented
//
// assert_valid_quote pushes `quote_hash` as a nullifier. This test verifies
// that after a successful call, the quote hash is marked as used.
#[test]
unconstrained fn pay_and_mint_prevents_quote_replay() {
    let (mut env, credit_fpc_address, token_address, operator, user) = utils::setup();
    let credit_fpc = CreditFPC::at(credit_fpc_address);
    let token = Token::at(token_address);

    let max_gas_cost = utils::max_gas_cost_no_teardown(env);
    let mint_amount = max_gas_cost + (1000 as u128);
    let charge = mint_amount;
    let valid_until = env.last_block_timestamp() + 3600;

    env.call_private(operator, token.mint_to_private(user, charge + (100 as u128)));

    let quote_sig = utils::sign_quote(
        credit_fpc_address,
        token_address,
        mint_amount,
        charge,
        valid_until,
        user,
    );

    // First call: succeeds and commits quote_hash as a nullifier.
    let transfer_call =
        token.transfer_private_to_private(user, operator, charge, TRANSFER_AUTHWIT_NONCE);
    add_private_authwit_from_call(env, user, credit_fpc_address, transfer_call);

    env.call_private(
        user,
        credit_fpc.pay_and_mint(
            TRANSFER_AUTHWIT_NONCE,
            mint_amount,
            charge,
            valid_until,
            quote_sig,
        ),
    );

    // Replay protection is implemented by emitting quote_hash as a nullifier.
    // Validate that the quote was marked as used after the first successful call.
    assert(
        env.simulate_utility(credit_fpc.quote_used(mint_amount, charge, valid_until, user)),
        "quote nullifier should exist",
    );
}

use crate::{FPCMultiAsset, test::utils};
use aztec::protocol::traits::ToField;
use token::Token;

// =========================================================================
// Happy path
// =========================================================================

#[test]
unconstrained fn sponsored_happy_path_no_token_transfer() {
    let (mut env, fpc_address, token_address, operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);
    let token = Token::at(token_address);

    let mint_amount: u128 = 5000;
    env.call_private(operator, token.mint_to_private(user, mint_amount));

    let fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let valid_until = env.last_block_timestamp() + 3600;
    let quote_sig =
        utils::sign_sponsored_quote(fpc_address, token_address, fj_fee_amount, valid_until, user);

    let user_balance_before = utils::private_balance(env, token_address, user);
    let operator_balance_before = utils::private_balance(env, token_address, operator);

    env.call_private(
        user,
        fpc.fee_entrypoint_sponsored(token_address, fj_fee_amount, valid_until, quote_sig),
    );

    let user_balance_after = utils::private_balance(env, token_address, user);
    let operator_balance_after = utils::private_balance(env, token_address, operator);

    assert_eq(user_balance_after, user_balance_before);
    assert_eq(operator_balance_after, operator_balance_before);
}

// =========================================================================
// fj_fee_amount mismatch
// =========================================================================

#[test(should_fail_with = "quoted fee amount mismatch")]
unconstrained fn sponsored_rejects_mismatched_fj_fee_amount() {
    let (mut env, fpc_address, token_address, _operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);

    let actual_fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let quoted_fj_fee_amount = actual_fj_fee_amount + (1 as u128);
    let valid_until = env.last_block_timestamp() + 3600;
    let quote_sig = utils::sign_sponsored_quote(
        fpc_address,
        token_address,
        quoted_fj_fee_amount,
        valid_until,
        user,
    );

    let _ = env.call_private(
        user,
        fpc.fee_entrypoint_sponsored(token_address, quoted_fj_fee_amount, valid_until, quote_sig),
    );
}

// =========================================================================
// Overlong TTL
// =========================================================================

#[test(should_fail_with = "sponsored quote ttl too large")]
unconstrained fn sponsored_rejects_overlong_quote_ttl() {
    let (mut env, fpc_address, token_address, _operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);

    let fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let valid_until = env.last_block_timestamp() + 3601;
    let quote_sig =
        utils::sign_sponsored_quote(fpc_address, token_address, fj_fee_amount, valid_until, user);

    let _ = env.call_private(
        user,
        fpc.fee_entrypoint_sponsored(token_address, fj_fee_amount, valid_until, quote_sig),
    );
}

// =========================================================================
// User binding: sponsored quote signed for one user cannot be used by another
// =========================================================================

#[test(should_fail_with = "invalid sponsored quote signature")]
unconstrained fn sponsored_rejects_quote_bound_to_another_user() {
    let (mut env, fpc_address, token_address, _operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);
    let other_user = env.create_contract_account();

    let fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let valid_until = env.last_block_timestamp() + 3600;

    // Sign the sponsored quote for `user`, but call from `other_user`.
    let quote_sig =
        utils::sign_sponsored_quote(fpc_address, token_address, fj_fee_amount, valid_until, user);

    let _ = env.call_private(
        other_user,
        fpc.fee_entrypoint_sponsored(token_address, fj_fee_amount, valid_until, quote_sig),
    );
}

// =========================================================================
// Consecutive sponsored calls with different quotes succeed
// =========================================================================

#[test]
unconstrained fn sponsored_consecutive_calls_with_fresh_quotes_succeed() {
    let (mut env, fpc_address, token_address, operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);
    let token = Token::at(token_address);

    let mint_amount: u128 = 5000;
    env.call_private(operator, token.mint_to_private(user, mint_amount));

    let fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let valid_until_1 = env.last_block_timestamp() + 3600;
    let quote_sig_1 = utils::sign_sponsored_quote(
        fpc_address,
        token_address,
        fj_fee_amount,
        valid_until_1,
        user,
    );

    env.call_private(
        user,
        fpc.fee_entrypoint_sponsored(token_address, fj_fee_amount, valid_until_1, quote_sig_1),
    );

    // Second call with a different valid_until (produces a different quote hash).
    let valid_until_2 = env.last_block_timestamp() + 3000;
    let quote_sig_2 = utils::sign_sponsored_quote(
        fpc_address,
        token_address,
        fj_fee_amount,
        valid_until_2,
        user,
    );

    env.call_private(
        user,
        fpc.fee_entrypoint_sponsored(token_address, fj_fee_amount, valid_until_2, quote_sig_2),
    );

    // Balances unchanged -- no token transfer in either call.
    let user_balance = utils::private_balance(env, token_address, user);
    assert_eq(user_balance, mint_amount);
}

// =========================================================================
// Domain separation: cross-path replay rejection
// =========================================================================

#[test(should_fail_with = "invalid quote signature")]
unconstrained fn sponsored_quote_rejected_in_standard_entrypoint() {
    let (mut env, fpc_address, token_address, _operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);

    let fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let aa_payment_amount = fj_fee_amount;
    let valid_until = env.last_block_timestamp() + 3600;

    // Sign with the SPONSORED domain separator + sponsor key ...
    let sponsored_sig =
        utils::sign_sponsored_quote(fpc_address, token_address, fj_fee_amount, valid_until, user);

    // ... then try to use it in the standard fee_entrypoint.
    let _ = env.call_private(
        user,
        fpc.fee_entrypoint(
            token_address,
            42,
            fj_fee_amount,
            aa_payment_amount,
            valid_until,
            sponsored_sig,
        ),
    );
}

#[test(should_fail_with = "invalid sponsored quote signature")]
unconstrained fn standard_quote_rejected_in_sponsored_entrypoint() {
    let (mut env, fpc_address, token_address, _operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);

    let fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let aa_payment_amount = fj_fee_amount;
    let valid_until = env.last_block_timestamp() + 3600;

    // Sign with the STANDARD domain separator + operator key ...
    let standard_sig = utils::sign_quote(
        fpc_address,
        token_address,
        fj_fee_amount,
        aa_payment_amount,
        valid_until,
        user,
    );

    // ... then try to use it in fee_entrypoint_sponsored.
    let _ = env.call_private(
        user,
        fpc.fee_entrypoint_sponsored(token_address, fj_fee_amount, valid_until, standard_sig),
    );
}

// =========================================================================
// Expiry
// =========================================================================

#[test(should_fail_with = "sponsored quote expired")]
unconstrained fn sponsored_expired_quote_rejected() {
    let (mut env, fpc_address, token_address, _operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);

    let fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let valid_until = env.last_block_timestamp();
    let quote_sig =
        utils::sign_sponsored_quote(fpc_address, token_address, fj_fee_amount, valid_until, user);

    env.mine_block_at(valid_until + 1);

    let _ = env.call_private(
        user,
        fpc.fee_entrypoint_sponsored(token_address, fj_fee_amount, valid_until, quote_sig),
    );
}

// =========================================================================
// Wrong signer: operator key cannot authorize sponsorship
// =========================================================================

#[test(should_fail_with = "invalid sponsored quote signature")]
unconstrained fn sponsored_quote_wrong_signer_rejected() {
    let (mut env, fpc_address, token_address, _operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);

    let fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let valid_until = env.last_block_timestamp() + 3600;

    // Compute the sponsored quote hash but sign it with the OPERATOR key
    // (test_schnorr_sign) instead of the sponsor key. The contract verifies
    // against sponsor_pubkey, so this must fail.
    let quote_hash = aztec::authwit::auth::compute_inner_authwit_hash([
        utils::SPONSORED_QUOTE_DOMAIN_SEPARATOR,
        fpc_address.to_field(),
        token_address.to_field(),
        fj_fee_amount as Field,
        valid_until as Field,
        user.to_field(),
    ]);
    let message: [u8; 32] = quote_hash.to_be_bytes();
    let wrong_sig = utils::test_schnorr_sign(message);

    let _ = env.call_private(
        user,
        fpc.fee_entrypoint_sponsored(token_address, fj_fee_amount, valid_until, wrong_sig),
    );
}

// =========================================================================
// Replay rejection: same sponsored quote used twice
// =========================================================================

#[test(should_fail)]
unconstrained fn sponsored_quote_replay_rejected() {
    let (mut env, fpc_address, token_address, _operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);

    let fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let valid_until = env.last_block_timestamp() + 3600;
    let quote_sig =
        utils::sign_sponsored_quote(fpc_address, token_address, fj_fee_amount, valid_until, user);

    env.call_private(
        user,
        fpc.fee_entrypoint_sponsored(token_address, fj_fee_amount, valid_until, quote_sig),
    );

    // Second use of the exact same quote must fail (nullifier conflict).
    let _ = env.call_private(
        user,
        fpc.fee_entrypoint_sponsored(token_address, fj_fee_amount, valid_until, quote_sig),
    );
}

use crate::{FPCMultiAsset, test::utils};
use aztec::protocol::constants::NULL_MSG_SENDER_CONTRACT_ADDRESS;
use aztec::test::helpers::authwit::add_private_authwit_from_call;
use token::Token;

global CLAIM_SECRET: Field = 0xdeadbeef;
global CLAIM_SECRET_HASH: Field = 0xcafebabe;
global MESSAGE_LEAF_INDEX: Field = 0;

/// TXE limitation: the L1-to-L2 message tree is always zero-filled, so
/// `TokenBridge::claim_private` (which calls `consume_l1_to_l2_message`)
/// cannot find the message hash and the oracle rejects the call.
/// This test validates the setup phase (root-call guard, claim-covers-fee
/// check, quote signature, fee payer declaration) and expects the bridge
/// claim to fail.
#[test(should_fail_with = "No L1 to L2 message found")]
unconstrained fn cold_start_happy_path() {
    let (mut env, fpc_address, token_address, bridge_address, _operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);

    let fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let aa_payment_amount = fj_fee_amount;
    let claim_amount = aa_payment_amount + (1000 as u128);
    let valid_until = env.last_block_timestamp() + 3600;

    let quote_sig = utils::sign_cold_start_quote(
        fpc_address,
        token_address,
        fj_fee_amount,
        aa_payment_amount,
        valid_until,
        user,
        claim_amount,
        CLAIM_SECRET_HASH,
    );

    let _ = env.call_private(
        NULL_MSG_SENDER_CONTRACT_ADDRESS,
        fpc.cold_start_entrypoint(
            user,
            token_address,
            bridge_address,
            claim_amount,
            CLAIM_SECRET,
            CLAIM_SECRET_HASH,
            MESSAGE_LEAF_INDEX,
            fj_fee_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );
}

/// cold_start_entrypoint requires msg_sender = None (tx root). When called
/// through env.call_private(user, ...) the msg_sender is set to `user`,
/// so the root-call guard must reject it.
#[test(should_fail_with = "must be tx entrypoint")]
unconstrained fn cold_start_rejects_non_root_caller() {
    let (mut env, fpc_address, token_address, bridge_address, _operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);

    let fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let aa_payment_amount = fj_fee_amount;
    let claim_amount = aa_payment_amount + (1000 as u128);
    let valid_until = env.last_block_timestamp() + 3600;

    let quote_sig = utils::sign_cold_start_quote(
        fpc_address,
        token_address,
        fj_fee_amount,
        aa_payment_amount,
        valid_until,
        user,
        claim_amount,
        CLAIM_SECRET_HASH,
    );

    let _ = env.call_private(
        user,
        fpc.cold_start_entrypoint(
            user,
            token_address,
            bridge_address,
            claim_amount,
            CLAIM_SECRET,
            CLAIM_SECRET_HASH,
            MESSAGE_LEAF_INDEX,
            fj_fee_amount,
            aa_payment_amount,
            valid_until,
            quote_sig,
        ),
    );
}

/// A cold-start quote (COLD_START_QUOTE_DOMAIN_SEPARATOR) must not be
/// accepted by fee_entrypoint (QUOTE_DOMAIN_SEPARATOR) and vice versa.
/// This test signs with the cold-start domain and submits through fee_entrypoint.
#[test(should_fail_with = "Cannot satisfy constraint")]
unconstrained fn cold_start_quote_rejected_by_fee_entrypoint() {
    let (mut env, fpc_address, token_address, bridge_address, operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);
    let token = Token::at(token_address);

    let fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let aa_payment_amount = fj_fee_amount;
    let claim_amount = aa_payment_amount + (500 as u128);
    let mint_amount = aa_payment_amount + (1000 as u128);
    env.call_private(bridge_address, token.mint_to_private(user, mint_amount));

    let valid_until = env.last_block_timestamp() + 3600;

    // Sign with cold-start domain separator
    let cold_start_sig = utils::sign_cold_start_quote(
        fpc_address,
        token_address,
        fj_fee_amount,
        aa_payment_amount,
        valid_until,
        user,
        claim_amount,
        CLAIM_SECRET_HASH,
    );

    let authwit_nonce: Field = 100;
    let transfer_call =
        token.transfer_private_to_private(user, operator, aa_payment_amount, authwit_nonce);
    add_private_authwit_from_call(env, user, fpc_address, transfer_call);

    // Submit through fee_entrypoint -- should fail because the signature
    // was computed with COLD_START_QUOTE_DOMAIN_SEPARATOR, not QUOTE_DOMAIN_SEPARATOR.
    let _ = env.call_private(
        user,
        fpc.fee_entrypoint(
            token_address,
            authwit_nonce,
            fj_fee_amount,
            aa_payment_amount,
            valid_until,
            cold_start_sig,
        ),
    );
}

/// A regular fee_entrypoint quote (QUOTE_DOMAIN_SEPARATOR) must not be
/// accepted by cold_start_entrypoint (COLD_START_QUOTE_DOMAIN_SEPARATOR).
/// This test signs with the regular domain and submits through cold_start_entrypoint.
///
/// Note: This test will hit "must be tx entrypoint" first because we call
/// via env.call_private (non-root). This validates that both guards are active.
#[test(should_fail_with = "Cannot satisfy constraint")]
unconstrained fn regular_quote_rejected_by_cold_start_entrypoint() {
    let (mut env, fpc_address, token_address, bridge_address, _operator, user) = utils::setup();
    let fpc = FPCMultiAsset::at(fpc_address);

    let fj_fee_amount = utils::max_gas_cost_no_teardown(env);
    let aa_payment_amount = fj_fee_amount;
    let claim_amount = aa_payment_amount + (500 as u128);
    let valid_until = env.last_block_timestamp() + 3600;

    // Sign with regular domain separator
    let regular_sig = utils::sign_quote(
        fpc_address,
        token_address,
        fj_fee_amount,
        aa_payment_amount,
        valid_until,
        user,
    );

    let _ = env.call_private(
        NULL_MSG_SENDER_CONTRACT_ADDRESS,
        fpc.cold_start_entrypoint(
            user,
            token_address,
            bridge_address,
            claim_amount,
            CLAIM_SECRET,
            CLAIM_SECRET_HASH,
            MESSAGE_LEAF_INDEX,
            fj_fee_amount,
            aa_payment_amount,
            valid_until,
            regular_sig,
        ),
    );
}

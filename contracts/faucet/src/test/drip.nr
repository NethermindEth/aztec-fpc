use crate::{Faucet, test::utils};
use aztec::protocol::address::AztecAddress;

#[test]
unconstrained fn drip_transfers_drip_amount_to_recipient() {
    let (mut env, faucet_address, token_address, _admin, user) = utils::setup();

    let balance_before = utils::public_balance(env, token_address, user);

    env.call_public(user, Faucet::at(faucet_address).drip(user));

    let balance_after = utils::public_balance(env, token_address, user);
    assert_eq(balance_after, balance_before + utils::DEFAULT_DRIP_AMOUNT);
}

#[test(should_fail_with = "drip cooldown not elapsed")]
unconstrained fn drip_rejects_second_call_within_cooldown() {
    let (mut env, faucet_address, _token_address, _admin, user) = utils::setup();

    let t0 = env.last_block_timestamp() + 100;
    env.mine_block_at(t0);
    env.call_public(user, Faucet::at(faucet_address).drip(user));

    env.mine_block_at(t0 + 10);
    let _ = env.call_public(user, Faucet::at(faucet_address).drip(user));
}

#[test]
unconstrained fn drip_succeeds_after_cooldown_elapses() {
    let (mut env, faucet_address, token_address, _admin, user) = utils::setup();

    let t0 = env.last_block_timestamp() + 100;
    env.mine_block_at(t0);
    env.call_public(user, Faucet::at(faucet_address).drip(user));

    let balance_after_first = utils::public_balance(env, token_address, user);

    env.mine_block_at(t0 + utils::DEFAULT_COOLDOWN);
    env.call_public(user, Faucet::at(faucet_address).drip(user));

    let balance_after_second = utils::public_balance(env, token_address, user);
    assert_eq(balance_after_second, balance_after_first + utils::DEFAULT_DRIP_AMOUNT);
}

#[test]
unconstrained fn drip_allows_back_to_back_when_cooldown_disabled() {
    let (mut env, faucet_address, token_address, _admin, user) = utils::setup_no_cooldown();

    let balance_before = utils::public_balance(env, token_address, user);

    env.call_public(user, Faucet::at(faucet_address).drip(user));
    env.call_public(user, Faucet::at(faucet_address).drip(user));

    let balance_after = utils::public_balance(env, token_address, user);
    assert_eq(balance_after, balance_before + utils::DEFAULT_DRIP_AMOUNT * (2 as u128));
}

#[test(should_fail_with = "invalid recipient")]
unconstrained fn drip_rejects_zero_recipient() {
    let (mut env, faucet_address, _token_address, _admin, user) = utils::setup();

    let _ = env.call_public(user, Faucet::at(faucet_address).drip(AztecAddress::zero()));
}

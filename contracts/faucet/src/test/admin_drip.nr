use crate::{Faucet, test::utils};
use aztec::protocol::address::AztecAddress;

#[test]
unconstrained fn admin_drip_transfers_custom_amount() {
    let (mut env, faucet_address, token_address, admin, user) = utils::setup();

    let amount: u128 = 5_000_000_000_000_000_000;
    let balance_before = utils::public_balance(env, token_address, user);

    env.call_public(admin, Faucet::at(faucet_address).admin_drip(user, amount));

    let balance_after = utils::public_balance(env, token_address, user);
    assert_eq(balance_after, balance_before + amount);
}

#[test(should_fail_with = "not admin")]
unconstrained fn admin_drip_rejects_non_admin_caller() {
    let (mut env, faucet_address, _token_address, _admin, user) = utils::setup();

    let amount: u128 = 1_000_000_000_000_000_000;
    let _ = env.call_public(user, Faucet::at(faucet_address).admin_drip(user, amount));
}

#[test(should_fail_with = "invalid recipient")]
unconstrained fn admin_drip_rejects_zero_recipient() {
    let (mut env, faucet_address, _token_address, admin, _user) = utils::setup();

    let amount: u128 = 1_000_000_000_000_000_000;
    let _ =
        env.call_public(admin, Faucet::at(faucet_address).admin_drip(AztecAddress::zero(), amount));
}

#[test(should_fail_with = "amount must be positive")]
unconstrained fn admin_drip_rejects_zero_amount() {
    let (mut env, faucet_address, _token_address, admin, user) = utils::setup();

    let _ = env.call_public(admin, Faucet::at(faucet_address).admin_drip(user, 0));
}

/// admin_drip deliberately does not write to `last_drip`, so a regular drip
/// for the same recipient should still succeed immediately afterwards.
#[test]
unconstrained fn admin_drip_does_not_affect_regular_drip_cooldown() {
    let (mut env, faucet_address, token_address, admin, user) = utils::setup();

    let admin_amount: u128 = 5_000_000_000_000_000_000;
    env.call_public(admin, Faucet::at(faucet_address).admin_drip(user, admin_amount));

    env.call_public(user, Faucet::at(faucet_address).drip(user));

    let balance = utils::public_balance(env, token_address, user);
    assert_eq(balance, admin_amount + utils::DEFAULT_DRIP_AMOUNT);
}

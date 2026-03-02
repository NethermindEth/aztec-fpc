use crate::{Faucet, test::utils};
use aztec::protocol::address::AztecAddress;

#[test(should_fail_with = "invalid token")]
unconstrained fn constructor_rejects_zero_token() {
    let (mut env, _, _, admin, _) = utils::setup();

    let init = Faucet::interface().constructor(
        AztecAddress::zero(),
        admin,
        utils::DEFAULT_DRIP_AMOUNT,
        utils::DEFAULT_COOLDOWN,
    );
    let _ = env.deploy("Faucet").with_public_initializer(admin, init);
}

#[test(should_fail_with = "invalid admin")]
unconstrained fn constructor_rejects_zero_admin() {
    let (mut env, _, token_address, admin, _) = utils::setup();

    let init = Faucet::interface().constructor(
        token_address,
        AztecAddress::zero(),
        utils::DEFAULT_DRIP_AMOUNT,
        utils::DEFAULT_COOLDOWN,
    );
    let _ = env.deploy("Faucet").with_public_initializer(admin, init);
}

#[test(should_fail_with = "drip amount must be positive")]
unconstrained fn constructor_rejects_zero_drip_amount() {
    let (mut env, _, token_address, admin, _) = utils::setup();

    let init = Faucet::interface().constructor(token_address, admin, 0, utils::DEFAULT_COOLDOWN);
    let _ = env.deploy("Faucet").with_public_initializer(admin, init);
}

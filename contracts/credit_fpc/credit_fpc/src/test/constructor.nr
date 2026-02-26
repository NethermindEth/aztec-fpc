use crate::{CreditFPC, test::utils};
use aztec::protocol::address::AztecAddress;

#[test(should_fail_with = "invalid operator")]
unconstrained fn constructor_rejects_zero_operator() {
    let (mut env, _, token_address, operator, _) = utils::setup();

    let pk = utils::test_operator_pubkey();
    let init =
        CreditFPC::interface().constructor(AztecAddress::zero(), pk.x, pk.y, token_address);
    let _ = env.deploy("CreditFPC").with_public_initializer(operator, init);
}

#[test(should_fail_with = "invalid accepted asset")]
unconstrained fn constructor_rejects_zero_accepted_asset() {
    let (mut env, _, _, operator, _) = utils::setup();

    let pk = utils::test_operator_pubkey();
    let init =
        CreditFPC::interface().constructor(operator, pk.x, pk.y, AztecAddress::zero());
    let _ = env.deploy("CreditFPC").with_public_initializer(operator, init);
}

#[test(should_fail_with = "operator pubkey not on curve")]
unconstrained fn constructor_rejects_off_curve_pubkey() {
    let (mut env, _, token_address, operator, _) = utils::setup();

    let init = CreditFPC::interface().constructor(operator, 1, 1, token_address);
    let _ = env.deploy("CreditFPC").with_public_initializer(operator, init);
}

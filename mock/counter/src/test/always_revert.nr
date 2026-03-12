use crate::{Counter, test::utils};

#[test(should_fail_with = "This function always reverts")]
unconstrained fn always_revert_fails() {
    let (mut env, counter_address, owner) = utils::setup();

    let _ = env.call_private(owner, Counter::at(counter_address).always_revert());
}

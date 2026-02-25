use crate::fee_math::fee_juice_to_asset;

#[test]
unconstrained fn fee_math_zero_fee_returns_zero() {
    assert_eq(fee_juice_to_asset(0 as u128, 123 as u128, 10 as u128), 0 as u128);
}

#[test]
unconstrained fn fee_math_exact_division() {
    assert_eq(fee_juice_to_asset(10 as u128, 3 as u128, 5 as u128), 6 as u128);
}

#[test]
unconstrained fn fee_math_ceiling_division() {
    assert_eq(fee_juice_to_asset(10 as u128, 1 as u128, 3 as u128), 4 as u128);
}

#[test(should_fail_with = "invalid exchange rate denominator")]
unconstrained fn fee_math_denominator_zero_fails() {
    let _ = fee_juice_to_asset(1 as u128, 1 as u128, 0 as u128);
}

#[test(should_fail_with = "exchange rate overflow")]
unconstrained fn fee_math_multiplication_overflow_fails() {
    let max_u128: u128 = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;
    let _ = fee_juice_to_asset(max_u128, 2 as u128, 1 as u128);
}

#[test(should_fail_with = "exchange rate overflow")]
unconstrained fn fee_math_ceiling_addition_overflow_fails() {
    let max_u128: u128 = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;
    let _ = fee_juice_to_asset(max_u128, 1 as u128, 2 as u128);
}

/// Convert a fee-juice amount to payment-asset units using ceiling division.
///
/// payment_asset_amount = ceil(fee_juice_amount * rate_num / rate_den)
///
/// Ceiling ensures the FPC always collects at least the actual fee cost.
/// Overflow is checked explicitly since Noir does not panic on u128 overflow.
pub fn fee_juice_to_asset(fee_juice_amount: u128, rate_num: u128, rate_den: u128) -> u128 {
    assert(rate_den != 0, "invalid exchange rate denominator");
    let max_u128: u128 = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;

    if fee_juice_amount != 0 {
        assert(rate_num <= max_u128 / fee_juice_amount, "exchange rate overflow");
    }
    let product = fee_juice_amount * rate_num;

    // ceil(product / rate_den) = (product + rate_den - 1) / rate_den
    let addend = rate_den - 1;
    assert(product <= max_u128 - addend, "exchange rate overflow");
    (product + addend) / rate_den
}

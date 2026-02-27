use aztec::context::PrivateContext;

/// Maximum possible fee for this tx excluding teardown gas.
pub fn get_max_gas_cost_no_teardown(context: &mut PrivateContext) -> u128 {
    let s = context.gas_settings();
    s.max_fees_per_gas.fee_per_da_gas * (s.gas_limits.da_gas as u128)
        + s.max_fees_per_gas.fee_per_l2_gas * (s.gas_limits.l2_gas as u128)
}

/// Maximum possible fee for this tx including teardown gas.
/// Required for credit-based FPCs that must cover teardown costs up-front.
pub fn get_max_gas_cost(context: &mut PrivateContext) -> u128 {
    let s = context.gas_settings();
    s.max_fees_per_gas.fee_per_da_gas
        * (s.gas_limits.da_gas as u128 + s.teardown_gas_limits.da_gas as u128)
        + s.max_fees_per_gas.fee_per_l2_gas
            * (s.gas_limits.l2_gas as u128 + s.teardown_gas_limits.l2_gas as u128)
}

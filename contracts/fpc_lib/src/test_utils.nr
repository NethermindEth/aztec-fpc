use crate::quote::compute_quote_hash;
use aztec::{
    protocol::{address::AztecAddress, traits::ToField},
    test::helpers::test_environment::TestEnvironment,
};
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, multi_scalar_mul};
use token::Token;

// ── Grumpkin / Schnorr test constants ────────────────────────────────────────

/// Grumpkin generator point G1.
global G1: EmbeddedCurvePoint = EmbeddedCurvePoint {
    x: 1,
    y: 17631683881184975370165255887551781615748388533673675138860,
    is_infinite: false,
};

/// Fixed test signing key = 1.  Keeps the Schnorr math to a single modular
/// subtraction (s = k - e*1 = k - e mod Fq) with no big-integer multiply.
global TEST_SIGNING_KEY: Field = 1;

// Grumpkin group order (= BN254 Fq), split into two u128 halves.
// Fq = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47
global FQ_HI: u128 = 0x30644e72e131a029b85045b68181585d;
global FQ_LO: u128 = 0x97816a916871ca8d3c208c16d87cfd47;

// ── Key helpers ───────────────────────────────────────────────────────────────

pub unconstrained fn test_operator_pubkey() -> EmbeddedCurvePoint {
    multi_scalar_mul([G1], [EmbeddedCurveScalar::new(TEST_SIGNING_KEY, 0)])
}

/// Produce a valid Schnorr signature over `message` using TEST_SIGNING_KEY.
pub unconstrained fn test_schnorr_sign(message: [u8; 32]) -> [u8; 64] {
    let pk = test_operator_pubkey();

    let k: u128 = 0xdead_beef_1234;
    let r = multi_scalar_mul([G1], [EmbeddedCurveScalar::new(k as Field, 0)]);

    // e = blake2s(pedersen_hash(R.x, PK.x, PK.y) || message)
    let ped = std::hash::pedersen_hash([r.x, pk.x, pk.y]);
    let ped_bytes: [u8; 32] = ped.to_be_bytes();
    let mut hash_input: [u8; 64] = [0; 64];
    for i in 0..32 { hash_input[i] = ped_bytes[i]; }
    for i in 0..32 { hash_input[32 + i] = message[i]; }
    let e_bytes: [u8; 32] = std::hash::blake2s(hash_input);

    // s = k - e*sk (mod Fq); sk=1 so s = k - e mod Fq
    let s_bytes = sub_mod_fq(k, e_bytes);

    let mut sig: [u8; 64] = [0; 64];
    for i in 0..32 { sig[i] = s_bytes[i]; }
    for i in 0..32 { sig[32 + i] = e_bytes[i]; }
    sig
}

// ── Quote helpers ─────────────────────────────────────────────────────────────

/// Compute the quote hash and sign it with the test operator key.
pub unconstrained fn sign_quote(
    fpc_address: AztecAddress,
    accepted_asset: AztecAddress,
    rate_num: u128,
    rate_den: u128,
    valid_until: u64,
    user_address: AztecAddress,
) -> [u8; 64] {
    let hash = compute_quote_hash(fpc_address, accepted_asset, rate_num, rate_den, valid_until, user_address);
    test_schnorr_sign(hash.to_be_bytes())
}

// ── Environment helpers ───────────────────────────────────────────────────────

/// Create a TestEnvironment with a Token already deployed.
/// Returns (env, token_address, operator, user).
///
/// Each contract's own setup() calls this, then deploys its specific FPC on top.
pub unconstrained fn setup_base_env() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();

    let user = env.create_contract_account();
    let operator = env.create_contract_account();

    let token_initializer = Token::interface().constructor_with_minter(
        "TestToken0000000000000000000000",
        "TT00000000000000000000000000000",
        18,
        operator,
        AztecAddress::zero(),
    );
    let token_address =
        env.deploy("@token_contract/Token").with_public_initializer(operator, token_initializer);

    (env, token_address, operator, user)
}

pub unconstrained fn private_balance(
    env: TestEnvironment,
    token_address: AztecAddress,
    account: AztecAddress,
) -> u128 {
    env.simulate_utility(Token::at(token_address).balance_of_private(account))
}

pub unconstrained fn max_gas_cost_no_teardown(env: TestEnvironment) -> u128 {
    env.private_context(|context| {
        let s = context.gas_settings();
        s.max_fees_per_gas.fee_per_da_gas * (s.gas_limits.da_gas as u128)
            + s.max_fees_per_gas.fee_per_l2_gas * (s.gas_limits.l2_gas as u128)
    })
}

// ── 256-bit arithmetic for Schnorr mod-Fq ────────────────────────────────────

unconstrained fn sub_mod_fq(k: u128, e_bytes: [u8; 32]) -> [u8; 32] {
    let (mut e_hi, mut e_lo) = be_bytes_to_u128_pair(e_bytes);

    // Reduce e mod Fq (at most 6 subtractions needed for a 256-bit value).
    for _ in 0..6 {
        if gte_u256(e_hi, e_lo, FQ_HI, FQ_LO) {
            let (h, l) = sub_u256(e_hi, e_lo, FQ_HI, FQ_LO);
            e_hi = h;
            e_lo = l;
        }
    }

    // s = Fq + k - e_rem (add Fq first to avoid underflow, since k < e_rem)
    let (sum_hi, sum_lo) = add_u256(FQ_HI, FQ_LO, 0, k);
    let (mut s_hi, mut s_lo) = sub_u256(sum_hi, sum_lo, e_hi, e_lo);

    // Final reduction if s >= Fq.
    if gte_u256(s_hi, s_lo, FQ_HI, FQ_LO) {
        let (h, l) = sub_u256(s_hi, s_lo, FQ_HI, FQ_LO);
        s_hi = h;
        s_lo = l;
    }

    u128_pair_to_be_bytes(s_hi, s_lo)
}

unconstrained fn be_bytes_to_u128_pair(bytes: [u8; 32]) -> (u128, u128) {
    let mut hi: u128 = 0;
    let mut lo: u128 = 0;
    for i in 0..16 { hi = hi * 256 + bytes[i] as u128; }
    for i in 16..32 { lo = lo * 256 + bytes[i] as u128; }
    (hi, lo)
}

unconstrained fn u128_pair_to_be_bytes(hi: u128, lo: u128) -> [u8; 32] {
    let mut bytes: [u8; 32] = [0; 32];
    let mut h = hi;
    let mut l = lo;
    for i in 0..16 { bytes[31 - i] = (l % 256) as u8; l = l / 256; }
    for i in 0..16 { bytes[15 - i] = (h % 256) as u8; h = h / 256; }
    bytes
}

unconstrained fn gte_u256(a_hi: u128, a_lo: u128, b_hi: u128, b_lo: u128) -> bool {
    if a_hi != b_hi { a_hi > b_hi } else { a_lo >= b_lo }
}

unconstrained fn sub_u256(a_hi: u128, a_lo: u128, b_hi: u128, b_lo: u128) -> (u128, u128) {
    if a_lo >= b_lo {
        (a_hi - b_hi, a_lo - b_lo)
    } else {
        let result_lo = 0xffffffffffffffffffffffffffffffff - (b_lo - a_lo - 1);
        (a_hi - b_hi - 1, result_lo)
    }
}

unconstrained fn add_u256(a_hi: u128, a_lo: u128, b_hi: u128, b_lo: u128) -> (u128, u128) {
    if a_lo > 0xffffffffffffffffffffffffffffffff - b_lo {
        let complement = 0xffffffffffffffffffffffffffffffff - (b_lo - 1);
        (a_hi + b_hi + 1, a_lo - complement)
    } else {
        (a_hi + b_hi, a_lo + b_lo)
    }
}

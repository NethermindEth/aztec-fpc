use crate::CreditFPC;
use aztec::{
    authwit::auth::compute_inner_authwit_hash,
    protocol::{address::AztecAddress, traits::ToField},
    test::helpers::test_environment::TestEnvironment,
};
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, multi_scalar_mul};
use token::Token;

global QUOTE_DOMAIN_SEPARATOR: Field = 0x465043;

/// Grumpkin generator point.
global G1: EmbeddedCurvePoint = EmbeddedCurvePoint {
    x: 1,
    y: 17631683881184975370165255887551781615748388533673675138860,
    is_infinite: false,
};

/// Fixed test private key. Using 1 so that e*sk = e, avoiding the need
/// for big-integer multiplication (only subtraction mod Fq is required).
global TEST_SIGNING_KEY: Field = 1;

// Grumpkin group order (= BN254 base field Fq), split into u128 halves.
// Fq = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47
global FQ_HI: u128 = 0x30644e72e131a029b85045b68181585d;
global FQ_LO: u128 = 0x97816a916871ca8d3c208c16d87cfd47;

/// Derive the operator's Schnorr public key from TEST_SIGNING_KEY.
pub unconstrained fn test_operator_pubkey() -> EmbeddedCurvePoint {
    multi_scalar_mul([G1], [EmbeddedCurveScalar::new(TEST_SIGNING_KEY, 0)])
}

/// Compute a valid Schnorr signature over `message` using TEST_SIGNING_KEY.
///
/// Schnorr signing requires scalar arithmetic modulo the Grumpkin group order
/// (BN254_Fq), which differs from Noir's native Field (BN254_Fr). We use
/// u128-pair arithmetic to perform the modular subtraction correctly.
/// With TEST_SIGNING_KEY = 1, e*sk = e, so only subtraction is needed.
pub unconstrained fn test_schnorr_sign(message: [u8; 32]) -> [u8; 64] {
    let pk = test_operator_pubkey();

    let k: u128 = 0xdead_beef_1234;
    let r = multi_scalar_mul([G1], [EmbeddedCurveScalar::new(k as Field, 0)]);

    // e = blake2s(pedersen_hash(R.x, PK.x, PK.y) || message)
    let ped = std::hash::pedersen_hash([r.x, pk.x, pk.y]);
    let ped_bytes: [u8; 32] = ped.to_be_bytes();
    let mut hash_input: [u8; 64] = [0; 64];
    for i in 0..32 {
        hash_input[i] = ped_bytes[i];
    }
    for i in 0..32 {
        hash_input[32 + i] = message[i];
    }
    let e_bytes: [u8; 32] = std::hash::blake2s(hash_input);

    // s = k - e (mod Fq), since sk = 1
    let s_bytes = sub_mod_fq(k, e_bytes);

    let mut sig: [u8; 64] = [0; 64];
    for i in 0..32 {
        sig[i] = s_bytes[i];
    }
    for i in 0..32 {
        sig[32 + i] = e_bytes[i];
    }
    sig
}

/// Compute (k - e) mod Fq using u128-pair 256-bit arithmetic.
/// k must fit in u128; e_bytes is a 32-byte big-endian 256-bit value.
unconstrained fn sub_mod_fq(k: u128, e_bytes: [u8; 32]) -> [u8; 32] {
    let (mut e_hi, mut e_lo) = be_bytes_to_u128_pair(e_bytes);

    // Reduce e mod Fq.
    // For 256-bit e, floor((2^256 - 1) / Fq) = 5, so up to 5 subtractions
    // may be required in the worst case.
    for _ in 0..6 {
        if gte_u256(e_hi, e_lo, FQ_HI, FQ_LO) {
            let (h, l) = sub_u256(e_hi, e_lo, FQ_HI, FQ_LO);
            e_hi = h;
            e_lo = l;
        }
    }

    // s = Fq + k - e_rem (since k << e_rem, we add Fq first to avoid underflow)
    let (sum_hi, sum_lo) = add_u256(FQ_HI, FQ_LO, 0, k);
    let (mut s_hi, mut s_lo) = sub_u256(sum_hi, sum_lo, e_hi, e_lo);

    // Final reduction if s >= Fq
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
    for i in 0..16 {
        hi = hi * 256 + bytes[i] as u128;
    }
    for i in 16..32 {
        lo = lo * 256 + bytes[i] as u128;
    }
    (hi, lo)
}

unconstrained fn u128_pair_to_be_bytes(hi: u128, lo: u128) -> [u8; 32] {
    let mut bytes: [u8; 32] = [0; 32];
    let mut h = hi;
    let mut l = lo;
    for i in 0..16 {
        bytes[31 - i] = (l % 256) as u8;
        l = l / 256;
    }
    for i in 0..16 {
        bytes[15 - i] = (h % 256) as u8;
        h = h / 256;
    }
    bytes
}

unconstrained fn gte_u256(a_hi: u128, a_lo: u128, b_hi: u128, b_lo: u128) -> bool {
    if a_hi != b_hi {
        a_hi > b_hi
    } else {
        a_lo >= b_lo
    }
}

/// a - b for 256-bit numbers (caller must ensure a >= b).
/// Avoids u128 underflow by branching on the lo comparison.
unconstrained fn sub_u256(a_hi: u128, a_lo: u128, b_hi: u128, b_lo: u128) -> (u128, u128) {
    if a_lo >= b_lo {
        (a_hi - b_hi, a_lo - b_lo)
    } else {
        let result_lo = 0xffffffffffffffffffffffffffffffff - (b_lo - a_lo - 1);
        (a_hi - b_hi - 1, result_lo)
    }
}

/// a + b for 256-bit numbers (caller must ensure no 256-bit overflow).
/// Avoids u128 overflow by branching on the carry check.
unconstrained fn add_u256(a_hi: u128, a_lo: u128, b_hi: u128, b_lo: u128) -> (u128, u128) {
    if a_lo > 0xffffffffffffffffffffffffffffffff - b_lo {
        let complement = 0xffffffffffffffffffffffffffffffff - (b_lo - 1);
        (a_hi + b_hi + 1, a_lo - complement)
    } else {
        (a_hi + b_hi, a_lo + b_lo)
    }
}

pub unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
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

    let pk = test_operator_pubkey();
    let credit_fpc_initializer =
        CreditFPC::interface().constructor(operator, pk.x, pk.y, token_address);
    let credit_fpc_address =
        env.deploy("CreditFPC").with_public_initializer(operator, credit_fpc_initializer);

    (env, credit_fpc_address, token_address, operator, user)
}

pub unconstrained fn max_gas_cost_no_teardown(env: TestEnvironment) -> u128 {
    env.private_context(|context| {
        let s = context.gas_settings();
        s.max_fees_per_gas.fee_per_da_gas * (s.gas_limits.da_gas as u128)
            + s.max_fees_per_gas.fee_per_l2_gas * (s.gas_limits.l2_gas as u128)
    })
}

/// Compute the quote hash (same preimage as the contract) and return a valid
/// Schnorr signature for it using the test signing key.
pub unconstrained fn sign_quote(
    credit_fpc_address: AztecAddress,
    accepted_asset: AztecAddress,
    rate_num: u128,
    rate_den: u128,
    valid_until: u64,
    user_address: AztecAddress,
) -> [u8; 64] {
    let quote_hash = quote_hash(
        credit_fpc_address,
        accepted_asset,
        rate_num,
        rate_den,
        valid_until,
        user_address,
    );
    let message: [u8; 32] = quote_hash.to_be_bytes();
    test_schnorr_sign(message)
}

pub unconstrained fn quote_hash(
    credit_fpc_address: AztecAddress,
    accepted_asset: AztecAddress,
    rate_num: u128,
    rate_den: u128,
    valid_until: u64,
    user_address: AztecAddress,
) -> Field {
    compute_inner_authwit_hash([
        QUOTE_DOMAIN_SEPARATOR,
        credit_fpc_address.to_field(),
        accepted_asset.to_field(),
        rate_num as Field,
        rate_den as Field,
        valid_until as Field,
        user_address.to_field(),
    ])
}

pub unconstrained fn private_balance(
    env: TestEnvironment,
    token_address: AztecAddress,
    account: AztecAddress,
) -> u128 {
    env.simulate_utility(Token::at(token_address).balance_of_private(account))
}

pub unconstrained fn credit_balance(
    env: TestEnvironment,
    credit_fpc_address: AztecAddress,
    account: AztecAddress,
) -> u128 {
    env.simulate_utility(CreditFPC::at(credit_fpc_address).balance_of(account))
}

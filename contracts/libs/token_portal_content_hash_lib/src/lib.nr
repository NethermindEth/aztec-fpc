use aztec::protocol::{address::{AztecAddress, EthAddress}, hash::sha256_to_field, traits::ToField};

pub fn get_mint_to_public_content_hash(owner: AztecAddress, amount: u128) -> Field {
    let mut hash_bytes = [0; 68];
    let recipient_bytes: [u8; 32] = owner.to_field().to_be_bytes();
    let amount_bytes: [u8; 32] = (amount as Field).to_be_bytes();

    let selector =
        comptime { keccak256::keccak256("mint_to_public(bytes32,uint256)".as_bytes(), 31) };

    for i in 0..4 {
        hash_bytes[i] = selector[i];
    }

    for i in 0..32 {
        hash_bytes[i + 4] = recipient_bytes[i];
        hash_bytes[i + 36] = amount_bytes[i];
    }

    let content_hash = sha256_to_field(hash_bytes);
    content_hash
}

pub fn get_mint_to_private_content_hash(amount: u128) -> Field {
    let mut hash_bytes = [0; 36];
    let amount_bytes: [u8; 32] = (amount as Field).to_be_bytes();

    let selector = comptime { keccak256::keccak256("mint_to_private(uint256)".as_bytes(), 24) };

    for i in 0..4 {
        hash_bytes[i] = selector[i];
    }

    for i in 0..32 {
        hash_bytes[i + 4] = amount_bytes[i];
    }

    let content_hash = sha256_to_field(hash_bytes);
    content_hash
}

pub fn get_withdraw_content_hash(
    recipient: EthAddress,
    amount: u128,
    caller_on_l1: EthAddress,
) -> Field {
    let mut hash_bytes: [u8; 100] = [0; 100];
    let recipient_bytes: [u8; 32] = recipient.to_field().to_be_bytes();
    let amount_bytes: [u8; 32] = (amount as Field).to_be_bytes();
    let caller_on_l1_bytes: [u8; 32] = caller_on_l1.to_field().to_be_bytes();

    let selector =
        comptime { keccak256::keccak256("withdraw(address,uint256,address)".as_bytes(), 33) };

    for i in 0..4 {
        hash_bytes[i] = selector[i];
    }

    for i in 0..32 {
        hash_bytes[i + 4] = recipient_bytes[i];
        hash_bytes[i + 36] = amount_bytes[i];
        hash_bytes[i + 68] = caller_on_l1_bytes[i];
    }
    let content_hash = sha256_to_field(hash_bytes);
    content_hash
}

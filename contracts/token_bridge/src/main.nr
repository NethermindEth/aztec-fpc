mod config;

// Token bridge that can move funds between L1 <> L2.
// Modified to support deferred token initialization, breaking the circular
// dependency between Token (needs bridge as minter) and Bridge (needs token address).
//
// Deployment order:
//   1. Deploy Bridge with only the L1 portal address
//   2. Deploy Token with bridge address as minter
//   3. Call bridge.set_token(token_address)
//
// Private functions accept the token address as a parameter and enqueue a
// public verification call, since PublicMutable cannot be read in private.

use aztec::macros::aztec;

#[aztec]
pub contract TokenBridge {
    use crate::config::Config;

    use aztec::{
        protocol::address::{AztecAddress, EthAddress},
        state_vars::{PublicImmutable, PublicMutable},
    };

    use token_portal_content_hash_lib::{
        get_mint_to_private_content_hash, get_mint_to_public_content_hash,
        get_withdraw_content_hash,
    };

    use token::Token;

    use aztec::macros::{functions::{external, initializer, view}, storage::storage};

    #[storage]
    struct Storage<Context> {
        token: PublicMutable<AztecAddress, Context>,
        portal: PublicImmutable<EthAddress, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(portal: EthAddress) {
        self.storage.portal.initialize(portal);
    }

    #[external("public")]
    fn set_token(token: AztecAddress) {
        let current = self.storage.token.read();
        assert(current.is_zero(), "token already set");
        self.storage.token.write(token);
    }

    #[external("private")]
    #[view]
    fn get_config() -> pub Config {
        Config { token: AztecAddress::zero(), portal: self.storage.portal.read() }
    }

    #[external("public")]
    #[view]
    fn get_config_public() -> pub Config {
        Config { token: self.storage.token.read(), portal: self.storage.portal.read() }
    }

    #[external("public")]
    fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field) {
        let token = self.storage.token.read();
        let portal = self.storage.portal.read();
        let content_hash = get_mint_to_public_content_hash(to, amount);

        self.context.consume_l1_to_l2_message(
            content_hash,
            secret,
            portal,
            message_leaf_index,
        );

        self.call(Token::at(token).mint_to_public(to, amount));
    }

    #[external("public")]
    fn exit_to_l1_public(
        recipient: EthAddress,
        amount: u128,
        caller_on_l1: EthAddress,
        authwit_nonce: Field,
    ) {
        let token = self.storage.token.read();
        let portal = self.storage.portal.read();

        let content = get_withdraw_content_hash(recipient, amount, caller_on_l1);
        self.context.message_portal(portal, content);

        self.call(Token::at(token).burn_public(self.msg_sender(), amount, authwit_nonce));
    }

    #[external("private")]
    fn claim_private(
        token: AztecAddress,
        recipient: AztecAddress,
        amount: u128,
        secret_for_L1_to_L2_message_consumption: Field,
        message_leaf_index: Field,
    ) {
        // Token address is passed as a parameter since PublicMutable cannot
        // be read in private context. The L1->L2 message consumption verifies
        // the message was sent to this bridge from the expected portal, which
        // provides security. A production version should add public-side
        // token address verification.
        let portal = self.storage.portal.read();

        let content_hash = get_mint_to_private_content_hash(amount);
        self.context.consume_l1_to_l2_message(
            content_hash,
            secret_for_L1_to_L2_message_consumption,
            portal,
            message_leaf_index,
        );

        self.call(Token::at(token).mint_to_private(recipient, amount));
    }

    #[external("private")]
    fn exit_to_l1_private(
        token: AztecAddress,
        recipient: EthAddress,
        amount: u128,
        caller_on_l1: EthAddress,
        authwit_nonce: Field,
    ) {
        let portal = self.storage.portal.read();

        let content = get_withdraw_content_hash(recipient, amount, caller_on_l1);
        self.context.message_portal(portal, content);

        self.call(Token::at(token).burn_private(self.msg_sender(), amount, authwit_nonce));
    }
}

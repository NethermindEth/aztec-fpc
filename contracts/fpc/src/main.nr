mod test;

use ::aztec::macros::aztec;

/// Fee Payment Contract -- Multi-Asset Variant
///
/// Unlike the standard FPC which hardcodes `accepted_asset` at deploy time,
/// this variant accepts the asset as a per-quote parameter. The user specifies
/// which asset they want to pay with when requesting a quote, the operator
/// signs a quote binding that asset+exact amounts, and `fee_entrypoint` accepts the
/// asset as an argument.
///
/// Security is preserved because the quote hash includes the asset in its
/// preimage -- the operator's Schnorr signature binds the quoted amounts to a
/// specific asset.
///
/// ## Storage
///
/// - config            (PublicImmutable<Config>) -- packed immutable config
///                                                  containing operator address
///                                                  and operator signing key.
#[aztec]
pub contract FPCMultiAsset {
    use aztec::{
        authwit::auth::compute_inner_authwit_hash,
        context::PrivateContext,
        macros::{functions::{allow_phase_change, external, initializer}, storage::storage},
        protocol::{address::AztecAddress, traits::{Deserialize, Packable, Serialize, ToField}},
        state_vars::PublicImmutable,
    };
    use std::embedded_curve_ops::EmbeddedCurvePoint;
    use token::Token;
    use token_bridge_contract::TokenBridge;

    global QUOTE_DOMAIN_SEPARATOR: Field = 0x465043;
    // "FPCs" -- distinct domain separator for cold-start quotes to prevent
    // cross-entrypoint replay between fee_entrypoint and cold_start_entrypoint.
    global COLD_START_QUOTE_DOMAIN_SEPARATOR: Field = 0x46504373;
    // Quotes must expire within this many seconds from the tx anchor timestamp.
    global MAX_QUOTE_TTL_SECONDS: u64 = 3600;
    global GRUMPKIN_CURVE_B: Field = 17;

    /// Packed configuration stored as a single PublicImmutable slot.
    /// 3 fields (no accepted_asset -- that is now a per-quote parameter).
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct Config {
        operator: AztecAddress,
        /// Operator signing public key x coordinate.
        operator_pubkey_x: Field,
        /// Operator signing public key y coordinate.
        operator_pubkey_y: Field,
    }

    #[storage]
    struct Storage<Context> {
        config: PublicImmutable<Config, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(operator: AztecAddress, operator_pubkey_x: Field, operator_pubkey_y: Field) {
        assert(!operator.is_zero(), "invalid operator");
        // Basic on-curve check: y^2 = x^3 - 17 (Grumpkin)
        assert(
            operator_pubkey_y * operator_pubkey_y
                == operator_pubkey_x * operator_pubkey_x * operator_pubkey_x - GRUMPKIN_CURVE_B,
            "operator pubkey not on curve",
        );
        self.storage.config.initialize(Config { operator, operator_pubkey_x, operator_pubkey_y });
    }

    // Transfers the fee charge from the user's private balance directly to the
    // operator's private balance. The quote signature is verified inline using
    // the operator's stored public key -- no cross-circuit authwit call needed.

    #[external("private")]
    #[allow_phase_change]
    fn fee_entrypoint(
        accepted_asset: AztecAddress,
        authwit_nonce: Field,
        fj_fee_amount: u128,
        aa_payment_amount: u128,
        valid_until: u64,
        quote_sig: [u8; 64],
    ) {
        let max_fees = self.context.gas_settings().max_fees_per_gas;
        let enforce_setup_phase = (max_fees.fee_per_da_gas > 0) | (max_fees.fee_per_l2_gas > 0);
        if enforce_setup_phase {
            assert(!self.context.in_revertible_phase(), "fee_entrypoint must run in setup phase");
        }

        let config = self.storage.config.read();
        let sender = self.msg_sender();

        assert_valid_quote(
            self.context,
            EmbeddedCurvePoint {
                x: config.operator_pubkey_x,
                y: config.operator_pubkey_y,
                is_infinite: false,
            },
            accepted_asset,
            fj_fee_amount,
            aa_payment_amount,
            valid_until,
            sender,
            quote_sig,
        );

        let max_fee = get_max_gas_cost(self.context);
        assert(fj_fee_amount == max_fee, "quoted fee amount mismatch");

        Token::at(accepted_asset)
            .transfer_private_to_private(sender, config.operator, aa_payment_amount, authwit_nonce)
            .call(self.context);

        self.context.set_as_fee_payer();
        if enforce_setup_phase | !self.context.in_revertible_phase() {
            self.context.end_setup();
        }
    }

    /// Cold-start entrypoint: claim bridged tokens and pay gas in one tx.
    ///
    /// This function is the transaction root (msg_sender = None). There is no
    /// account entrypoint -- the FPC call is the kernel's sole initial call.
    /// This prevents batching of arbitrary reverting calls after setup.
    ///
    /// Flow:
    ///   Setup:  guard root call, verify claim covers fee, verify quote, set fee payer
    ///   App:    claim from bridge, transfer fee to operator
    #[external("private")]
    #[allow_phase_change]
    fn cold_start_entrypoint(
        user: AztecAddress,
        accepted_asset: AztecAddress,
        bridge: AztecAddress,
        claim_amount: u128,
        claim_secret: Field,
        claim_secret_hash: Field,
        message_leaf_index: Field,
        authwit_nonce: Field,
        fj_fee_amount: u128,
        aa_payment_amount: u128,
        valid_until: u64,
        quote_sig: [u8; 64],
    ) {
        // (a) Guard: this must be the transaction root.
        //
        // The Aztec kernel populates msg_sender as None only for the very first
        // private call frame. If any contract had called us -- including the
        // user's account entrypoint dispatching batched calls -- msg_sender would
        // be Some(caller). Therefore this assertion is a reliable, unforgeable
        // proof that no additional app logic exists in this transaction.
        assert(self.context.maybe_msg_sender().is_none(), "must be tx entrypoint");

        let max_fees = self.context.gas_settings().max_fees_per_gas;
        let enforce_setup_phase =
            (max_fees.fee_per_da_gas > 0) | (max_fees.fee_per_l2_gas > 0);
        if enforce_setup_phase {
            assert(
                !self.context.in_revertible_phase(),
                "cold_start_entrypoint must run in setup phase",
            );
        }

        let config = self.storage.config.read();

        // (b) Verify the claim is large enough to cover the fee.
        //     Checked here in setup so the app-phase transfer cannot fail.
        assert(claim_amount >= aa_payment_amount, "claim insufficient to cover fee");

        // (c) Verify operator quote.
        //
        //     The extended preimage includes claim_amount and claim_secret_hash,
        //     binding the operator's attestation to a specific bridge deposit.
        //     Using COLD_START_QUOTE_DOMAIN_SEPARATOR prevents cross-entrypoint replay.
        assert_valid_cold_start_quote(
            self.context,
            EmbeddedCurvePoint {
                x: config.operator_pubkey_x,
                y: config.operator_pubkey_y,
                is_infinite: false,
            },
            accepted_asset,
            fj_fee_amount,
            aa_payment_amount,
            valid_until,
            user,
            claim_amount,
            claim_secret_hash,
            quote_sig,
        );

        let max_fee = get_max_gas_cost(self.context);
        assert(fj_fee_amount == max_fee, "quoted fee amount mismatch");

        // (d) Declare fee payer and close the setup phase.
        //     All state changes from this point on are in the revertible phase,
        //     but since this function is the tx root (see (a)), there is nothing
        //     else that could revert and leave the FPC at a loss.
        self.context.set_as_fee_payer();
        if enforce_setup_phase | !self.context.in_revertible_phase() {
            self.context.end_setup();
        }

        // === Revertible (app) phase ===

        // (e) Claim tokens from the bridge into the user's private balance.
        //
        //     The operator's signature binds claim_secret_hash and claim_amount,
        //     so the operator has already verified off-chain that a valid pending
        //     deposit exists. If the claim fails despite a valid operator signature,
        //     it is an operator-side error, not a user attack.
        TokenBridge::at(bridge)
            .claim_private(
                user,
                claim_amount,
                claim_secret,
                message_leaf_index,
            )
            .call(self.context);

        // (f) Transfer the fee from the user's (freshly claimed) private balance
        //     to the operator. Cannot fail: claim_amount >= aa_payment_amount was
        //     asserted in setup, and the user pre-signed the authwit for this transfer.
        Token::at(accepted_asset)
            .transfer_private_to_private(
                user,
                config.operator,
                aa_payment_amount,
                authwit_nonce,
            )
            .call(self.context);
    }

    /// Compute the quote hash and verify the operator's Schnorr signature
    /// inline. Pushes a nullifier to prevent replay.
    ///
    /// Quote preimage (hashed with compute_inner_authwit_hash for compatibility):
    ///   poseidon2([DOMAIN_SEP, fpc_address, accepted_asset, fj_fee_amount, aa_payment_amount,
    ///              valid_until, user_address])
    #[contract_library_method]
    fn assert_valid_quote(
        context: &mut PrivateContext,
        operator_pubkey: EmbeddedCurvePoint,
        accepted_asset: AztecAddress,
        fj_fee_amount: u128,
        aa_payment_amount: u128,
        valid_until: u64,
        user_address: AztecAddress,
        quote_sig: [u8; 64],
    ) {
        let quote_hash = compute_inner_authwit_hash([
            QUOTE_DOMAIN_SEPARATOR,
            context.this_address().to_field(),
            accepted_asset.to_field(),
            fj_fee_amount as Field,
            aa_payment_amount as Field,
            valid_until as Field,
            user_address.to_field(),
        ]);

        schnorr::assert_valid_signature(operator_pubkey, quote_sig, quote_hash.to_be_bytes::<32>());

        context.push_nullifier(quote_hash);

        let anchor_ts = context.get_anchor_block_header().global_variables.timestamp;
        assert(anchor_ts <= valid_until, "quote expired");
        let quote_ttl = valid_until - anchor_ts;
        assert(quote_ttl <= MAX_QUOTE_TTL_SECONDS, "quote ttl too large");
        context.set_expiration_timestamp(valid_until);
    }

    /// Verify operator cold-start quote with extended preimage that binds
    /// the signature to a specific bridge deposit (claim_amount + claim_secret_hash).
    ///
    /// Uses COLD_START_QUOTE_DOMAIN_SEPARATOR to prevent cross-entrypoint replay.
    #[contract_library_method]
    fn assert_valid_cold_start_quote(
        context: &mut PrivateContext,
        operator_pubkey: EmbeddedCurvePoint,
        accepted_asset: AztecAddress,
        fj_fee_amount: u128,
        aa_payment_amount: u128,
        valid_until: u64,
        user_address: AztecAddress,
        claim_amount: u128,
        claim_secret_hash: Field,
        quote_sig: [u8; 64],
    ) {
        let quote_hash = compute_inner_authwit_hash([
            COLD_START_QUOTE_DOMAIN_SEPARATOR,
            context.this_address().to_field(),
            accepted_asset.to_field(),
            fj_fee_amount as Field,
            aa_payment_amount as Field,
            valid_until as Field,
            user_address.to_field(),
            claim_amount as Field,
            claim_secret_hash,
        ]);

        schnorr::assert_valid_signature(
            operator_pubkey,
            quote_sig,
            quote_hash.to_be_bytes::<32>(),
        );

        context.push_nullifier(quote_hash);

        let anchor_ts =
            context.get_anchor_block_header().global_variables.timestamp;
        assert(anchor_ts <= valid_until, "quote expired");
        let quote_ttl = valid_until - anchor_ts;
        assert(quote_ttl <= MAX_QUOTE_TTL_SECONDS, "quote ttl too large");
        context.set_expiration_timestamp(valid_until);
    }

    /// Maximum possible fee for this tx.
    #[contract_library_method]
    fn get_max_gas_cost(context: &mut PrivateContext) -> u128 {
        let s = context.gas_settings();
        s.max_fees_per_gas.fee_per_da_gas * (s.gas_limits.da_gas as u128)
            + s.max_fees_per_gas.fee_per_l2_gas * (s.gas_limits.l2_gas as u128)
    }
}

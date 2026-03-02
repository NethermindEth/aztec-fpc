mod test;

use ::aztec::macros::aztec;

/// Faucet: distributes accepted-asset tokens for FPC testing.
///
/// ## Setup
///
/// Deploy with `constructor(token, admin, drip_amount, cooldown_seconds)`.
/// After deployment the admin must fund the Faucet's public token balance by
/// calling `Token.mint_to_public(faucet_address, amount)` from the minter
/// account. The Faucet never holds Fee Juice; it only moves tokens.
///
/// ## User flow
///
/// ```
/// faucet.drip(recipient_address)
///   - checks per-recipient cooldown (public state)
///   - Token.transfer_public_to_public(faucet -> recipient, drip_amount)
///      tokens land in recipient's PUBLIC balance
/// ```
///
/// Recipients then shield tokens to private balance before using the FPC:
///   Token.transfer_public_to_private(recipient, amount, secret_hash)
///
/// ## Admin flow (bypasses cooldown, for CI / smoke tests)
///
/// ```
/// faucet.admin_drip(recipient_address, amount)
/// ```
///
/// ## Storage
///
/// - config      (PublicImmutable<Config>) - immutable: token, admin,
///                                           drip_amount, cooldown_seconds.
/// - last_drip   (Map<AztecAddress, PublicMutable<u64>>) - per-recipient
///               unix timestamp of last successful drip.
#[aztec]
pub contract Faucet {
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        protocol::{address::AztecAddress, traits::{Deserialize, Packable, Serialize}},
        state_vars::{Map, PublicImmutable, PublicMutable},
    };
    use token::Token;

    /// Immutable configuration written once at construction.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct Config {
        /// The accepted-asset token contract.
        token: AztecAddress,
        /// Account that may call admin_drip without cooldown.
        admin: AztecAddress,
        /// Tokens dispensed per drip (base units, e.g. 18-decimal).
        drip_amount: u128,
        /// Minimum seconds between successive drips for the same recipient.
        /// Set to 0 to disable rate-limiting (development only).
        cooldown_seconds: u64,
    }

    // =========================================================================
    // Storage
    // =========================================================================

    #[storage]
    struct Storage<Context> {
        config: PublicImmutable<Config, Context>,
        /// Per-recipient unix timestamp of the last successful drip.
        /// Uninitialized entries read as 0, so first drip is always allowed.
        last_drip: Map<AztecAddress, PublicMutable<u64, Context>, Context>,
    }

    // =========================================================================
    // Constructor
    // =========================================================================

    #[external("public")]
    #[initializer]
    fn constructor(
        token: AztecAddress,
        admin: AztecAddress,
        drip_amount: u128,
        cooldown_seconds: u64,
    ) {
        assert(!token.is_zero(), "invalid token");
        assert(!admin.is_zero(), "invalid admin");
        assert(drip_amount > 0, "drip amount must be positive");
        self.storage.config.initialize(Config { token, admin, drip_amount, cooldown_seconds });
    }

    // =========================================================================
    // Public drip (rate-limited)
    // =========================================================================

    /// Transfer `drip_amount` tokens from the Faucet's public balance to
    /// `recipient`. Enforces a per-recipient cooldown when cooldown_seconds > 0.
    ///
    /// Anyone may call this. The tokens land in the recipient's PUBLIC balance;
    /// recipients must shield them before using the FPC.
    #[external("public")]
    fn drip(recipient: AztecAddress) {
        assert(!recipient.is_zero(), "invalid recipient");

        let config = self.storage.config.read();

        if config.cooldown_seconds > 0 {
            let now = self.context.timestamp() as u64;
            let last = self.storage.last_drip.at(recipient).read();
            assert(now - last >= config.cooldown_seconds, "drip cooldown not elapsed");
            self.storage.last_drip.at(recipient).write(now);
        }

        // The Faucet is the sender; Token checks msg_sender == from, which
        // holds because this call originates from the Faucet contract itself.
        Token::at(config.token)
            .transfer_public_to_public(self.context.this_address(), recipient, config.drip_amount, 0
                )
            .call(self.context);
    }

    // =========================================================================
    // Admin drip (no cooldown, custom amount)
    // =========================================================================

    /// Transfer `amount` tokens to `recipient` without enforcing a cooldown.
    /// Only the admin may call this. Intended for deployment scripts and CI.
    ///
    /// Does not update `last_drip`, so an admin drip never interferes with
    /// the recipient's regular drip cooldown.
    #[external("public")]
    fn admin_drip(recipient: AztecAddress, amount: u128) {
        let config = self.storage.config.read();
        assert(self.context.maybe_msg_sender().unwrap() == config.admin, "not admin");
        assert(!recipient.is_zero(), "invalid recipient");
        assert(amount > 0, "amount must be positive");

        Token::at(config.token)
            .transfer_public_to_public(self.context.this_address(), recipient, amount, 0)
            .call(self.context);
    }

    // =========================================================================
    // Queries
    // =========================================================================

    #[external("utility")]
    unconstrained fn get_config() -> Config {
        self.storage.config.read()
    }

    #[external("utility")]
    unconstrained fn get_last_drip(recipient: AztecAddress) -> u64 {
        self.storage.last_drip.at(recipient).read()
    }
}

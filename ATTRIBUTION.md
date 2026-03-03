# Attribution

This project includes code derived from third-party sources.

## defi-wonderland/aztec-fee-payment

- **Repository**: https://github.com/defi-wonderland/aztec-fee-payment
- **License**: MIT
- **Description**: The FPC contract's operator-signed quote model was informed by
  patterns from Wonderland's `metered_contract`. The original credit-based fee model
  has been removed; the remaining FPC uses operator Schnorr-signed quotes,
  nullifier-based replay protection, and a packed single-slot config.

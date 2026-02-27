# Attribution

This project includes code derived from third-party sources.

## defi-wonderland/aztec-fee-payment

- **Repository**: https://github.com/defi-wonderland/aztec-fee-payment
- **License**: MIT
- **File**: `contracts/backed_credit_fpc/src/main.nr`
- **Original**: `src/nr/metered_contract/src/main.nr`
- **Description**: The BackedCreditFPC contract's private fee-credit model (balance tracking,
  gas-cost deduction, and teardown refund) was originally derived from Wonderland's
  `metered_contract`. It has since been adapted to use operator Schnorr-signed quotes,
  nullifier-based replay protection, and a packed single-slot config.

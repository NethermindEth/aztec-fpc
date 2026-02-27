/**
 * Stable interfaces for non-credit and credit FPC implementations.
 *
 * Tests and profiling scripts are written against these two interfaces.
 * Switching to a different underlying contract is a one-line change at the
 * call site (swap which impl class is instantiated); nothing else changes.
 *
 * Extending to a new implementation:
 *   - Non-credit variant: implement NonCreditFpc
 *   - Credit variant:     implement CreditFpc
 */

import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { GasSettings } from '@aztec/stdlib/gas';
import type { ExecutionPayload } from '@aztec/stdlib/tx';
import type { AuthWitness } from '@aztec/stdlib/auth-witness';

// ── Shared input for preparing any fee payment ────────────────────────────────

export interface PreparePaymentInput {
  /** Wallet / PXE handle that can create auth witnesses. */
  wallet: any;
  userAddress: AztecAddress;
  /** Operator's Schnorr instance (from @aztec/foundation/crypto/schnorr). */
  schnorr: any;
  /** Operator's Grumpkin private signing key. */
  operatorSigningKey: any;
  rateNum: bigint;
  rateDen: bigint;
  validUntil: bigint;
  gasSettings: GasSettings;
  /** Fresh nonce for the token-transfer auth witness. */
  authwitNonce: bigint;
}

// ── Minimal FeePaymentMethod shape (SDK duck-type) ───────────────────────────
//
// The SDK fee machinery calls these three methods. Implementations return a
// plain object or class instance that satisfies this shape.

export interface FpcPaymentMethod {
  getFeePayer(): Promise<AztecAddress>;
  getGasSettings(): GasSettings;
  getExecutionPayload(): Promise<ExecutionPayload>;
}

// ── Non-credit FPC ────────────────────────────────────────────────────────────
//
// User flow: one call — fee_entrypoint (or equivalent).
// The implementation handles signing the quote and building the authwit.

export interface NonCreditFpc {
  readonly fpcAddress: AztecAddress;
  readonly operatorAddress: AztecAddress;
  readonly tokenAddress: AztecAddress;

  /**
   * Sign the operator quote and build the FeePaymentMethod ready to attach to
   * any SDK call via `send({ fee: { paymentMethod: result } })`.
   *
   * All quote-specific logic (hash preimage, entrypoint selector, extra args)
   * lives inside this method — callers never see the details.
   */
  preparePayment(input: PreparePaymentInput): Promise<FpcPaymentMethod>;
}

// ── Credit FPC ────────────────────────────────────────────────────────────────
//
// User flow: two calls — top-up (pay_and_mint / equivalent), then spend credit
// (pay_with_credit / equivalent) for subsequent transactions.

export interface CreditFpc {
  readonly fpcAddress: AztecAddress;
  readonly operatorAddress: AztecAddress;
  readonly tokenAddress: AztecAddress;

  /**
   * Exchange tokens for on-chain credit (pay_and_mint / equivalent).
   * `mintAmount` is the credit to purchase; the token charge is derived from it
   * via the exchange rate.
   */
  prepareTopUp(
    input: PreparePaymentInput & { mintAmount: bigint },
  ): Promise<FpcPaymentMethod>;

  /**
   * Spend existing credit (pay_with_credit / equivalent).
   * No quote or authwit is needed — the credit note was already created.
   */
  prepareCreditPayment(gasSettings: GasSettings): FpcPaymentMethod;
}

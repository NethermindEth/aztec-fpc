# Optimization 1 — Inline Schnorr Quote Verification

## Summary

Replace the cross-circuit authwit call for quote verification with direct
Schnorr signature verification inside `fee_entrypoint`. This eliminates one
nested private function call, saving ~115k gates (14k function + 101k
`private_kernel_inner`).

**Expected gate reduction: ~583k → ~468k (3 nested calls instead of 4)**

## What changed

### Contract (`contracts/fpc/src/main.nr`)

**Before:** `assert_valid_quote` called `assert_inner_hash_valid_authwit(context,
operator, inner_hash)`, which performed a `static_call_private_function` to the
operator's account contract (`verify_private_authwit`). This added one full
nested circuit execution (14k gates) plus one `private_kernel_inner` (101k
gates).

**After:** `assert_valid_quote` verifies the operator's Schnorr signature
inline using `schnorr::verify_signature`. No cross-contract call occurs.

Specific changes:

1. **New dependency:** `schnorr = { tag = "v0.1.3", git = "..." }` in
   Nargo.toml.

2. **Storage:** Added `operator_pubkey_x` and `operator_pubkey_y` as
   `PublicImmutable<Field>` alongside the existing `operator` address.

3. **Constructor:** Now takes `(operator, operator_pubkey_x, operator_pubkey_y,
   accepted_asset)` and validates the pubkey is on the Grumpkin curve
   (`y² = x³ - 17`).

4. **`fee_entrypoint` signature:** Added `quote_sig: [u8; 64]` parameter —
   the raw Schnorr signature bytes are passed as function arguments.

5. **`assert_valid_quote`:** Computes the same quote hash as before (using
   `compute_inner_authwit_hash` for the poseidon2 hash). Verifies the
   signature with `schnorr::verify_signature(pubkey, sig, hash_bytes)`.
   Pushes `quote_hash` as a nullifier for replay prevention.

### Attestation service (`services/attestation/src/`)

The signer interface changed from `QuoteAuthwitSigner` (authwit-based) to
`QuoteSchnorrSigner` (raw Schnorr). The service now:

1. Signs `quoteHash.toBuffer()` directly with `Schnorr.constructSignature`.
2. Returns a hex-encoded 64-byte signature string (not an `AuthWitness`).
3. The `/quote` response field changed from `authwit` to `signature`.

Chain ID and version are no longer needed for signing (the authwit outer hash
wrapping is gone). The quote hash itself contains the FPC address, which makes
it deployment-specific.

### Profiling script (`profiling/profile-gates.mjs`)

Updated to deploy the FPC with pubkey, sign the quote inline, pass signature
bytes as function args, and use the new function selector
(`fee_entrypoint(Field,u128,u128,u64,[u8;64])`).

The `quoteAuthWit` is no longer included in `authWitnesses` — only the
transfer authwit remains.

### Tests (`contracts/fpc/src/test/`)

Test signing helper implemented in unconstrained Noir. The Grumpkin scalar
field equals BN254_Fr (Noir's native `Field`), so all signing arithmetic
(R = k·G, e = blake2s(pedersen(R, PK) || msg), s = k − e·sk) works directly
with Field operations. A fixed test keypair (`TEST_SIGNING_KEY = 0xbeef_cafe`)
and deterministic nonce produce valid signatures that `schnorr::verify_signature`
accepts in constrained mode.

---

## Validity analysis — concerns and responses

### Concern: Nullifier space / replay prevention

> `assert_inner_hash_valid_authwit` computes a nullifier via
> `compute_authwit_nullifier(on_behalf_of, inner_hash)` and pushes it through
> `context.push_nullifier()`. This nullifier is in the operator's account
> contract's nullifier tree. Inline verification can't emit nullifiers on
> behalf of the operator's account.

**This is incorrect.** The nullifier is pushed from the FPC's execution
context, not the operator's:

```
// aztec-nr/aztec/src/authwit/auth.nr:268-283
pub fn assert_inner_hash_valid_authwit(
    context: &mut PrivateContext,   // ← FPC's context
    on_behalf_of: AztecAddress,
    inner_hash: Field,
) {
    let result = context.static_call_private_function(on_behalf_of, ...);
    assert(result == IS_VALID_SELECTOR, ...);
    let nullifier = compute_authwit_nullifier(on_behalf_of, inner_hash);
    context.push_nullifier(nullifier);  // ← pushed from FPC's context
}
```

The `static_call_private_function` to the operator's account only verifies
the signature (returns IS_VALID_SELECTOR). It does **not** emit any
nullifiers — static calls cannot have side effects. The nullifier is pushed
by the FPC contract, siloed under the FPC's address.

The inline approach pushes `quote_hash` as a nullifier from the same FPC
context. Different hash value, same silo, equivalent replay protection.

The `compute_authwit_nullifier` nullifier is
`poseidon2([operator_address, inner_hash], DOM_SEP__AUTHWIT_NULLIFIER)`.
Our nullifier is `inner_hash` directly (the quote hash). Both are unique per
(fpc, asset, rate, expiry, user) and both live in the FPC's nullifier tree.

### Concern: Coupling to Schnorr (scheme agnosticism)

> The authwit abstraction is signature-scheme-agnostic. The operator could
> use ECDSA, multisig, social recovery, etc. Hardcoding Schnorr couples the
> FPC to a specific account contract implementation.

**This is a real tradeoff, accepted for this use case.** The FPC operator is
a single known entity — the same party that:

- Deploys the FPC contract
- Runs the attestation service
- Manages the Fee Juice balance
- Configures the signing key

This is not an arbitrary user interacting with a generic protocol. The
operator controls the full signing stack (attestation service → Schnorr key →
FPC pubkey). Coupling to Schnorr is no more restrictive than coupling to the
operator's address (which is already `PublicImmutable`).

If scheme agnosticism becomes necessary (e.g., multisig operators), the FPC
could be extended to support multiple verification modes behind a trait. For
the current single-operator design, this complexity is unwarranted.

### Concern: Key rotation becomes impossible

> Storing (x, y) in `PublicImmutable` freezes the signing key at deploy time.
> The operator can't rotate keys without redeploying the FPC.

**Valid limitation, but consistent with existing constraints.** The operator
address is already `PublicImmutable` — changing the operator requires
redeployment. Key rotation within the same operator address (e.g., rotating
the Schnorr key inside the account contract) was possible before but is now
lost.

Mitigations if rotation is needed:

- **`SharedMutable` storage for pubkey** — allows the operator to update
  their signing key via a public function call. Adds a few k gates for the
  mutable read pattern (vs immutable historical read), but enables rotation
  without redeployment. Not implemented yet.
- **Accept redeployment** — same operational model as the current operator
  address constraint. Requires migrating the Fee Juice balance.

### Concern: Kernel overhead reduction may be smaller than expected

> The "101k for the kernel" cost isn't purely from the static call. The kernel
> still needs to process the FPC's own execution, validate the nullifier, etc.
> The overall reduction may be smaller than predicted.

**The profiling data directly contradicts this.** Each entry in the gate count
trace is one circuit execution:

```
Step                                    Own gates   kernel_inner
────────────────────────────────────────────────────────────────
A. FPC:fee_entrypoint                    14,498     101,237
B. verify_private_authwit (quote)        14,328     101,237  ← removed
C. Token:transfer_private_to_private     34,237     101,237
D. verify_private_authwit (transfer)     14,328     101,237
```

Removing the static call to `verify_private_authwit` (step B) removes one
entire kernel iteration: 14,328 + 101,237 = 115,565 gates. The FPC's own
kernel (step A) is unaffected — it's a separate iteration that remains.

The inline Schnorr verification adds ~14k gates to the FPC's own circuit
(step A). Net saving: ~115k − ~14k ≈ ~101k gates. This reduces the nested
call count from 4 to 3.

(The actual savings need profiling to confirm. The Schnorr verification
itself may cost slightly more or less than 14k when inlined, and the 64-byte
signature in the function args adds a few k gates for args hashing.)

---

## Files modified

| File | Change |
|------|--------|
| `contracts/fpc/Nargo.toml` | Added `schnorr` dependency |
| `contracts/fpc/src/main.nr` | Inline Schnorr verification, new constructor params, `quote_sig` arg |
| `contracts/fpc/src/test/utils.nr` | Test signing helper, updated setup |
| `contracts/fpc/src/test/fee_entrypoint.nr` | Updated all tests for new interface |
| `services/attestation/src/signer.ts` | `QuoteSchnorrSigner` interface, `computeQuoteHash` |
| `services/attestation/src/server.ts` | Uses new signer, returns `signature` field |
| `services/attestation/src/index.ts` | Raw Schnorr signing, no authwit provider |
| `services/attestation/test/signer.test.ts` | Updated for new interface |
| `services/attestation/test/server.test.ts` | Updated mock signer, response field |
| `services/attestation/test/fee-entrypoint-devnet-smoke.ts` | Inline Schnorr signing |
| `scripts/services/fpc-services-smoke.ts` | Updated FPC deploy, quote handling |
| `profiling/profile-gates.mjs` | New deploy args, inline signing, new selector |

## Test signing: Fq vs Fr subtlety

The original `test_schnorr_sign` implementation computed `s = k - e * sk` using
Noir's native `Field` arithmetic (mod BN254_Fr). This is **incorrect** because
Schnorr signatures on Grumpkin require scalar arithmetic modulo the Grumpkin
group order, which is BN254_Fq (not Fr). These are close but distinct primes:

- Fr = `0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001`
- Fq = `0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47`

When `k - e*sk` wraps mod Fr, it adds a multiple of Fr, but the verifier's
`multi_scalar_mul` operates mod Fq. Since Fr != 0 mod Fq, the wrapped value
produces an incorrect R' point and the signature fails to verify.

**Fix**: Use `TEST_SIGNING_KEY = 1` (so `e*sk = e`, avoiding big-integer
multiplication) and implement 256-bit subtraction modulo Fq using u128-pair
arithmetic. The helper functions (`sub_u256`, `add_u256`, `gte_u256`) avoid
Noir's u128 overflow panics by branching rather than relying on wrapping.

This only affects test code; the contract and attestation service (which uses
the Aztec.js `Schnorr` class) are unaffected.

## Next steps

- **Profile** the modified contract to confirm actual gate savings.
- **Consider `SharedMutable` for pubkey** if key rotation is a requirement.
- **Optimization 2** targets eliminating the transfer authwit (step D) for
  a further ~101k savings. See `optimizations.md` for the full roadmap.

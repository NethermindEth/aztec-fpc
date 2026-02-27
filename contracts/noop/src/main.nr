use aztec::macros::aztec;

/// Minimal no-op contract used as a placeholder app transaction when profiling
/// FPC gate counts. Produces the smallest possible private function circuit.
#[aztec]
pub contract Noop {
    use aztec::macros::functions::external;

    #[external("private")]
    fn noop() {}
}

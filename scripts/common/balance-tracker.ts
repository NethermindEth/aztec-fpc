import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { Contract } from "@aztec/aztec.js/contracts";
import pino from "pino";

const pinoLogger = pino();

export class PrivateBalanceTracker {
  constructor(
    private readonly token: Contract,
    readonly address: AztecAddress,
    private readonly label: string,
    private expected: bigint,
    private readonly mode: "exact" | "atLeast" = "exact",
  ) {}

  async change(delta: bigint): Promise<void> {
    this.expected += delta;
    const { result } = await this.token.methods
      .balance_of_private(this.address)
      .simulate({ from: this.address });
    const actual = BigInt(result.toString());
    const expectStr = this.mode === "atLeast" ? `>=${this.expected}` : `${this.expected}`;
    pinoLogger.info(`${this.label}: private_balance=${actual} expected=${expectStr}`);
    if (this.mode === "exact" && actual !== this.expected) {
      throw new Error(
        `${this.label} private balance mismatch: expected=${this.expected} got=${actual}`,
      );
    }
    if (this.mode === "atLeast" && actual < this.expected) {
      throw new Error(
        `${this.label} private balance too low: expected>=${this.expected} got=${actual}`,
      );
    }
  }
}

import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { Contract } from "@aztec/aztec.js/contracts";
import pino from "pino";

const pinoLogger = pino();

abstract class BalanceTracker {
  constructor(
    protected readonly token: Contract,
    readonly address: AztecAddress,
    protected readonly label: string,
    protected expected: bigint,
    protected readonly mode: "exact" | "atLeast" = "exact",
  ) {}

  protected abstract balanceKind: string;

  protected abstract fetchBalance(): Promise<bigint>;

  async change(delta: bigint): Promise<void> {
    this.expected += delta;
    const actual = await this.fetchBalance();
    const expectStr = this.mode === "atLeast" ? `>=${this.expected}` : `${this.expected}`;
    pinoLogger.info(`${this.label}: ${this.balanceKind}=${actual} expected=${expectStr}`);
    if (this.mode === "exact" && actual !== this.expected) {
      throw new Error(
        `${this.label} ${this.balanceKind} mismatch: expected=${this.expected} got=${actual}`,
      );
    }
    if (this.mode === "atLeast" && actual < this.expected) {
      throw new Error(
        `${this.label} ${this.balanceKind} too low: expected>=${this.expected} got=${actual}`,
      );
    }
  }
}

export class PrivateBalanceTracker extends BalanceTracker {
  protected balanceKind = "private_balance";

  protected async fetchBalance(): Promise<bigint> {
    const { result } = await this.token.methods
      .balance_of_private(this.address)
      .simulate({ from: this.address });
    return BigInt(result.toString());
  }
}

export class PublicBalanceTracker extends BalanceTracker {
  protected balanceKind = "public_balance";

  protected async fetchBalance(): Promise<bigint> {
    const { result } = await this.token.methods
      .balance_of_public(this.address)
      .simulate({ from: this.address });
    return BigInt(result.toString());
  }
}

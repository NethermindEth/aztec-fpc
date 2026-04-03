import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { ContractFunctionInteraction } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import pino from "pino";

const pinoLogger = pino();

/** Minimal interface satisfied by both untyped Contract and codegen typed classes. */
type TokenLike = {
  readonly address: AztecAddress;
  methods: {
    balance_of_private: (owner: AztecAddress) => ContractFunctionInteraction;
    balance_of_public: (owner: AztecAddress) => ContractFunctionInteraction;
  };
};

abstract class BalanceTracker {
  constructor(
    protected readonly token: TokenLike,
    readonly address: AztecAddress,
    protected readonly label: string,
    protected expected = 0n,
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

  private constructor(
    token: TokenLike,
    address: AztecAddress,
    label: string,
    expected = 0n,
    mode: "exact" | "atLeast" = "exact",
  ) {
    super(token, address, label, expected, mode);
  }

  static async create(
    token: TokenLike,
    wallet: EmbeddedWallet,
    secretKey: Fr,
    label: string,
    expected = 0n,
    mode: "exact" | "atLeast" = "exact",
  ): Promise<PrivateBalanceTracker> {
    const account = await wallet.createSchnorrAccount(secretKey, Fr.ZERO);
    return new PrivateBalanceTracker(token, account.address, label, expected, mode);
  }

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

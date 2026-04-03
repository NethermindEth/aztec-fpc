import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { type AztecNode, createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { TokenContract } from "../../../codegen/Token.js";
import type { Config } from "./config.js";
import { normalizeAztecAddress } from "./config.js";

interface TreasuryContext {
  node: AztecNode;
  operatorAddress: AztecAddress;
  wallet: EmbeddedWallet;
}

export interface SweepResult {
  acceptedAsset: string;
  destination: string;
  sweptAmount: string;
  balanceBefore: string;
  balanceAfter: string;
  txHash: string;
}

export interface OperatorTreasuryPort {
  registerSender(address: AztecAddress): Promise<void>;
  getPrivateBalances(
    assetAddresses: string[],
  ): Promise<Array<{ address: string; balance: string }>>;
  sweep(args: {
    acceptedAsset: string;
    amount?: bigint;
    destination: string;
  }): Promise<SweepResult>;
  stop(): Promise<void>;
}

export class OperatorTreasury implements OperatorTreasuryPort {
  private readonly senderAliases = new Set<string>();
  private initPromise?: Promise<TreasuryContext>;
  private readonly operatorSalt: Fr;

  constructor(private readonly config: Config) {
    this.operatorSalt = config.operator_account_salt
      ? Fr.fromHexString(config.operator_account_salt)
      : Fr.ZERO;
  }

  async registerSender(address: AztecAddress): Promise<void> {
    if (!this.config.pxe_data_directory) {
      return;
    }

    const normalized = normalizeAztecAddress(address.toString());
    if (this.senderAliases.has(normalized)) {
      return;
    }

    const context = await this.getContext();
    await context.wallet.registerSender(address, normalized);
    this.senderAliases.add(normalized);
  }

  async getPrivateBalances(
    assetAddresses: string[],
  ): Promise<Array<{ address: string; balance: string }>> {
    const uniqueAddresses = Array.from(
      new Set(assetAddresses.map((value) => normalizeAztecAddress(value))),
    );
    const context = await this.getContext();
    const balances = await Promise.all(
      uniqueAddresses.map(async (address) => {
        const token = await this.attachTokenContract(context, address);
        const { result: balanceRaw } = await token.methods
          .balance_of_private(context.operatorAddress)
          .simulate({
            from: context.operatorAddress,
          });
        const balance = BigInt(balanceRaw.toString());
        return {
          address,
          balance: balance.toString(),
        };
      }),
    );

    return balances;
  }

  async sweep(args: {
    acceptedAsset: string;
    amount?: bigint;
    destination: string;
  }): Promise<SweepResult> {
    const context = await this.getContext();
    const acceptedAsset = normalizeAztecAddress(args.acceptedAsset);
    const destination = AztecAddress.fromString(args.destination);
    if (destination.isZero()) {
      throw new Error("destination must be a non-zero Aztec address");
    }

    const token = await this.attachTokenContract(context, acceptedAsset);
    const { result: balanceBeforeRaw } = await token.methods
      .balance_of_private(context.operatorAddress)
      .simulate({
        from: context.operatorAddress,
      });
    const balanceBefore = BigInt(balanceBeforeRaw.toString());
    const amount = args.amount ?? balanceBefore;
    if (amount <= 0n) {
      throw new Error("sweep amount must be greater than zero");
    }
    if (amount > balanceBefore) {
      throw new Error(
        `sweep amount ${amount.toString()} exceeds operator private balance ${balanceBefore.toString()}`,
      );
    }

    const { receipt } = await token.methods
      .transfer_private_to_private(context.operatorAddress, destination, amount, Fr.random())
      .send({
        from: context.operatorAddress,
        wait: { timeout: 180 },
      });

    const { result: balanceAfterRaw } = await token.methods
      .balance_of_private(context.operatorAddress)
      .simulate({
        from: context.operatorAddress,
      });
    const balanceAfter = BigInt(balanceAfterRaw.toString());

    return {
      acceptedAsset,
      destination: destination.toString(),
      sweptAmount: amount.toString(),
      balanceBefore: balanceBefore.toString(),
      balanceAfter: balanceAfter.toString(),
      txHash: receipt.txHash.toString(),
    };
  }

  async stop(): Promise<void> {
    if (!this.initPromise) {
      return;
    }
    const context = await this.initPromise;
    await context.wallet.stop();
  }

  private getContext(): Promise<TreasuryContext> {
    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }
    return this.initPromise;
  }

  private async initialize(): Promise<TreasuryContext> {
    const node = createAztecNodeClient(this.config.aztec_node_url);
    await waitForNode(node);
    const wallet = await EmbeddedWallet.create(node, {
      ephemeral: !this.config.pxe_data_directory,
      pxeConfig: {
        proverEnabled: true,
        syncChainTip: "checkpointed",
        ...(this.config.pxe_data_directory
          ? { dataDirectory: this.config.pxe_data_directory }
          : {}),
      },
    });

    const secret = Fr.fromHexString(this.config.operator_secret_key);
    const signingKey = deriveSigningKey(secret);
    const account = await wallet.createSchnorrAccount(
      secret,
      this.operatorSalt,
      signingKey,
      "attestation-operator",
    );

    if (
      this.config.operator_address &&
      normalizeAztecAddress(account.address.toString()) !==
        normalizeAztecAddress(this.config.operator_address)
    ) {
      throw new Error(
        `Configured operator_address ${this.config.operator_address} does not match reconstructed operator account ${account.address.toString()}. Set operator_account_salt to the deployed account salt.`,
      );
    }

    return {
      node,
      operatorAddress: account.address,
      wallet,
    };
  }

  private async attachTokenContract(
    context: TreasuryContext,
    address: string,
  ): Promise<TokenContract> {
    const tokenAddress = AztecAddress.fromString(address);
    const instance = await context.node.getContract(tokenAddress);
    if (!instance) {
      throw new Error(`Token contract not found at ${tokenAddress.toString()}`);
    }
    await context.wallet.registerContract(instance, TokenContract.artifact);
    return TokenContract.at(tokenAddress, context.wallet);
  }
}

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NoirCompiledContract } from "@aztec/aztec.js/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { type AztecNode, createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import {
  type ContractArtifact,
  loadContractArtifact,
  loadContractArtifactForPublic,
} from "@aztec/stdlib/abi";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { Config } from "./config.js";
import { normalizeAztecAddress } from "./config.js";

const currentDir =
  typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

function resolveRepoRoot(): string {
  return path.resolve(currentDir, "..", "..", "..");
}

function loadArtifact(artifactPath: string): ContractArtifact {
  const parsed = JSON.parse(readFileSync(artifactPath, "utf8")) as NoirCompiledContract;
  try {
    return loadContractArtifact(parsed);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Contract's public bytecode has not been transpiled")
    ) {
      return loadContractArtifactForPublic(parsed);
    }
    throw error;
  }
}

function resolveTokenArtifactPath(): string {
  const explicit = process.env.ATTESTATION_TOKEN_ARTIFACT_PATH?.trim();
  const repoRoot = resolveRepoRoot();
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [path.join(repoRoot, "target", "token_contract-Token.json")];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Token artifact not found. Searched: ${candidates.join(", ")}`);
}

interface TreasuryContext {
  node: AztecNode;
  operatorAddress: AztecAddress;
  tokenArtifact: ContractArtifact;
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
      tokenArtifact: loadArtifact(resolveTokenArtifactPath()),
      wallet,
    };
  }

  private async attachTokenContract(context: TreasuryContext, address: string): Promise<Contract> {
    const tokenAddress = AztecAddress.fromString(address);
    const instance = await context.node.getContract(tokenAddress);
    if (!instance) {
      throw new Error(`Token contract not found at ${tokenAddress.toString()}`);
    }
    await context.wallet.registerContract(instance, context.tokenArtifact);
    return Contract.at(tokenAddress, context.tokenArtifact, context.wallet);
  }
}

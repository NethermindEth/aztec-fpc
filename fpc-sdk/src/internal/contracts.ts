import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadContractArtifact,
  loadContractArtifactForPublic,
  type ContractArtifact,
  type NoirCompiledContract,
} from "@aztec/aztec.js/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import { createAztecNodeClient, type AztecNode, waitForNode } from "@aztec/aztec.js/node";
import type { Wallet as AccountWallet } from "@aztec/aztec.js/wallet";

import { SDK_DEFAULTS } from "../defaults";
import { PublishedAccountRequiredError, SponsoredTxFailedError } from "../errors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const artifactsDir = path.resolve(__dirname, "..", "..", "artifacts");

type ArtifactDescriptor = {
  filename: string;
  label: "token" | "fpc" | "faucet" | "counter";
};

const ARTIFACTS: readonly ArtifactDescriptor[] = [
  { filename: "token_contract-Token.json", label: "token" },
  { filename: "fpc-FPCMultiAsset.json", label: "fpc" },
  { filename: "faucet-Faucet.json", label: "faucet" },
  { filename: "mock_counter-Counter.json", label: "counter" },
] as const;

type LoadedArtifacts = Record<ArtifactDescriptor["label"], ContractArtifact>;

export type RuntimeAddresses = {
  counter: AztecAddress;
  faucet: AztecAddress;
  fpc: AztecAddress;
  operator: AztecAddress;
  token: AztecAddress;
  user: AztecAddress;
};

export type AttachedContracts = {
  addresses: RuntimeAddresses;
  counter: Contract;
  faucet: Contract;
  fpc: Contract;
  node: AztecNode;
  token: Contract;
};

function parseAddress(name: string, raw: string): AztecAddress {
  try {
    return AztecAddress.fromString(raw);
  } catch {
    throw new SponsoredTxFailedError(`Invalid ${name} address in SDK defaults.`, {
      address: raw,
      name,
    });
  }
}

export function parseAccountAddress(account: AztecAddress | string): AztecAddress {
  if (typeof account !== "string") {
    return account;
  }
  try {
    return AztecAddress.fromString(account);
  } catch {
    throw new SponsoredTxFailedError("Invalid account address input.", {
      account,
    });
  }
}

export function resolveRuntimeAddresses(account: AztecAddress | string): RuntimeAddresses {
  return {
    counter: parseAddress("counter", SDK_DEFAULTS.counterAddress),
    faucet: parseAddress("faucet", SDK_DEFAULTS.faucetAddress),
    fpc: parseAddress("fpc", SDK_DEFAULTS.fpcAddress),
    operator: parseAddress("operator", SDK_DEFAULTS.operatorAddress),
    token: parseAddress("token", SDK_DEFAULTS.tokenAddress),
    user: parseAccountAddress(account),
  };
}

function loadArtifact(filename: string, label: string): ContractArtifact {
  const artifactPath = path.join(artifactsDir, filename);
  if (!existsSync(artifactPath)) {
    throw new SponsoredTxFailedError(`Missing ${label} artifact.`, {
      artifactPath,
      label,
    });
  }

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
    throw new SponsoredTxFailedError(`Failed to load ${label} artifact.`, {
      artifactPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function loadArtifacts(): LoadedArtifacts {
  return ARTIFACTS.reduce<LoadedArtifacts>((acc, item) => {
    acc[item.label] = loadArtifact(item.filename, item.label);
    return acc;
  }, {} as LoadedArtifacts);
}

async function attachRegisteredContract(
  wallet: AccountWallet,
  node: AztecNode,
  address: AztecAddress,
  artifact: ContractArtifact,
  label: string,
): Promise<Contract> {
  const instance = await node.getContract(address);
  if (!instance) {
    throw new SponsoredTxFailedError(`Missing ${label} contract instance on node.`, {
      address: address.toString(),
      label,
    });
  }

  await wallet.registerContract(instance, artifact);
  return Contract.at(address, artifact, wallet);
}

export async function assertPublishedAccount(
  node: AztecNode,
  address: AztecAddress,
): Promise<void> {
  const account = await node.getContract(address);
  if (!account) {
    throw new PublishedAccountRequiredError(
      `Account ${address.toString()} is not published on node.`,
      {
        account: address.toString(),
      },
    );
  }
}

export async function connectAndAttachContracts(input: {
  account: AztecAddress | string;
  wallet: AccountWallet;
}): Promise<AttachedContracts> {
  const addresses = resolveRuntimeAddresses(input.account);
  const artifacts = loadArtifacts();
  const node = createAztecNodeClient(SDK_DEFAULTS.nodeUrl);
  await waitForNode(node);
  await assertPublishedAccount(node, addresses.user);

  const [token, fpc, faucet, counter] = await Promise.all([
    attachRegisteredContract(
      input.wallet,
      node,
      addresses.token,
      artifacts.token,
      "accepted_asset",
    ),
    attachRegisteredContract(input.wallet, node, addresses.fpc, artifacts.fpc, "fpc"),
    attachRegisteredContract(
      input.wallet,
      node,
      addresses.faucet,
      artifacts.faucet,
      "faucet",
    ),
    attachRegisteredContract(
      input.wallet,
      node,
      addresses.counter,
      artifacts.counter,
      "counter",
    ),
  ]);

  return {
    addresses,
    counter,
    faucet,
    fpc,
    node,
    token,
  };
}

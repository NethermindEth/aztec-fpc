import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ContractArtifact,
  loadContractArtifact,
  loadContractArtifactForPublic,
  type NoirCompiledContract,
} from "@aztec/aztec.js/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import {
  type AztecNode,
  createAztecNodeClient,
  waitForNode,
} from "@aztec/aztec.js/node";
import type { Wallet as AccountWallet } from "@aztec/aztec.js/wallet";

import {
  PublishedAccountRequiredError,
  SponsoredTxFailedError,
} from "../errors";
import type { RuntimeContractConfig, SponsoredRuntimeConfig } from "../types";

const currentDir =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

type DefaultArtifactLabel = "token" | "fpc" | "faucet" | "counter";

const DEFAULT_ARTIFACT_FILENAMES: Record<DefaultArtifactLabel, string> = {
  counter: "mock_counter-Counter.json",
  faucet: "faucet-Faucet.json",
  fpc: "fpc-FPCMultiAsset.json",
  token: "token_contract-Token.json",
};

const defaultArtifactCache: Partial<
  Record<DefaultArtifactLabel, ContractArtifact>
> = {};

function resolveArtifactSearchDirs(): string[] {
  const dirs = [
    // sdk/src/internal -> sdk/artifacts
    path.resolve(currentDir, "..", "..", "artifacts"),
    // sdk/dist/internal -> sdk/dist/artifacts
    path.resolve(currentDir, "..", "artifacts"),
    // repo root target from source-layout path
    path.resolve(currentDir, "..", "..", "..", "target"),
    // repo root target from dist-layout path
    path.resolve(currentDir, "..", "..", "..", "..", "target"),
    // runtime cwd fallback
    path.resolve(process.cwd(), "target"),
  ];

  return Array.from(new Set(dirs));
}

export type RuntimeAddresses = {
  acceptedAsset: AztecAddress;
  faucet?: AztecAddress;
  fpc: AztecAddress;
  operator: AztecAddress;
  targets: Record<string, AztecAddress>;
  user: AztecAddress;
};

export type AttachedContracts = {
  acceptedAsset: Contract;
  addresses: RuntimeAddresses;
  counter?: Contract;
  faucet?: Contract;
  fpc: Contract;
  node: AztecNode;
  targets: Record<string, Contract>;
  token: Contract;
};

function parseAddress(
  name: string,
  raw: AztecAddress | string | undefined,
): AztecAddress {
  try {
    if (!raw) {
      throw new Error("missing address");
    }
    const parsed = typeof raw === "string" ? AztecAddress.fromString(raw) : raw;
    if (parsed.isZero()) {
      throw new Error("zero address");
    }
    return parsed;
  } catch {
    throw new SponsoredTxFailedError(`Invalid ${name} address input.`, {
      address: raw ? (typeof raw === "string" ? raw : raw.toString()) : raw,
      name,
    });
  }
}

function loadArtifactFromPath(
  artifactPath: string,
  label: string,
): ContractArtifact {
  const parsed = JSON.parse(
    readFileSync(artifactPath, "utf8"),
  ) as NoirCompiledContract;

  return loadArtifactFromCompiledJson(parsed, label, artifactPath);
}

function loadArtifactFromCompiledJson(
  parsed: NoirCompiledContract,
  label: string,
  artifactPath?: string,
): ContractArtifact {
  try {
    return loadContractArtifact(parsed);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes(
        "Contract's public bytecode has not been transpiled",
      )
    ) {
      return loadContractArtifactForPublic(parsed);
    }
    throw new SponsoredTxFailedError(`Failed to load ${label} artifact.`, {
      artifactPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function resolveDefaultArtifactPath(
  label: DefaultArtifactLabel,
): string | undefined {
  const filename = DEFAULT_ARTIFACT_FILENAMES[label];
  for (const dir of resolveArtifactSearchDirs()) {
    const candidatePath = path.join(dir, filename);
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return undefined;
}

function requireDefaultArtifact(label: DefaultArtifactLabel): ContractArtifact {
  const cached = defaultArtifactCache[label];
  if (cached) {
    return cached;
  }

  const artifactPath = resolveDefaultArtifactPath(label);
  if (!artifactPath) {
    throw new SponsoredTxFailedError(`Missing ${label} artifact.`, {
      filename: DEFAULT_ARTIFACT_FILENAMES[label],
      searchedDirs: resolveArtifactSearchDirs(),
    });
  }

  const artifact = loadArtifactFromPath(artifactPath, label);
  defaultArtifactCache[label] = artifact;
  return artifact;
}

function resolveArtifact(input: {
  artifact?: NoirCompiledContract;
  defaultLabel?: DefaultArtifactLabel;
  label: string;
}): ContractArtifact {
  if (input.artifact) {
    return loadArtifactFromCompiledJson(input.artifact, input.label);
  }
  if (input.defaultLabel) {
    return requireDefaultArtifact(input.defaultLabel);
  }
  throw new SponsoredTxFailedError(
    `Missing artifact for required contract: ${input.label}.`,
    {
      label: input.label,
    },
  );
}

export function parseAccountAddress(
  account: AztecAddress | string,
): AztecAddress {
  if (typeof account !== "string") {
    if (account.isZero()) {
      throw new SponsoredTxFailedError("Invalid account address input.", {
        account: account.toString(),
      });
    }
    return account;
  }
  try {
    const parsed = AztecAddress.fromString(account);
    if (parsed.isZero()) {
      throw new Error("zero address");
    }
    return parsed;
  } catch {
    throw new SponsoredTxFailedError("Invalid account address input.", {
      account,
    });
  }
}

export function resolveFpcAddress(input: {
  discoveryFpcAddress?: AztecAddress | string;
  explicitFpcAddress?: AztecAddress | string;
}): AztecAddress {
  const explicit = input.explicitFpcAddress
    ? parseAddress("fpc", input.explicitFpcAddress)
    : undefined;
  const discovery = input.discoveryFpcAddress
    ? parseAddress("discovery fpc", input.discoveryFpcAddress)
    : undefined;

  if (explicit && discovery) {
    if (
      explicit.toString().toLowerCase() !== discovery.toString().toLowerCase()
    ) {
      throw new SponsoredTxFailedError(
        "FPC address mismatch between runtime config and attestation discovery.",
        {
          discoveryFpcAddress: discovery.toString(),
          explicitFpcAddress: explicit.toString(),
        },
      );
    }
    return explicit;
  }

  if (explicit) {
    return explicit;
  }
  if (discovery) {
    return discovery;
  }

  throw new SponsoredTxFailedError(
    "Missing FPC address. Provide runtime fpc.address or discovery-resolved fpc_address.",
  );
}

export function resolveRuntimeAddresses(input: {
  account: AztecAddress | string;
  discoveryFpcAddress?: AztecAddress | string;
  runtimeConfig: SponsoredRuntimeConfig;
}): RuntimeAddresses {
  const targets = Object.fromEntries(
    Object.entries(input.runtimeConfig.targets ?? {}).map(([label, config]) => [
      label,
      parseAddress(`target:${label}`, config.address),
    ]),
  );

  return {
    acceptedAsset: parseAddress(
      "accepted_asset",
      input.runtimeConfig.acceptedAsset.address,
    ),
    faucet: input.runtimeConfig.faucet
      ? parseAddress("faucet", input.runtimeConfig.faucet.address)
      : undefined,
    fpc: resolveFpcAddress({
      discoveryFpcAddress: input.discoveryFpcAddress,
      explicitFpcAddress: input.runtimeConfig.fpc.address,
    }),
    operator: parseAddress("operator", input.runtimeConfig.operatorAddress),
    targets,
    user: parseAccountAddress(input.account),
  };
}

async function attachRegisteredContract(input: {
  address: AztecAddress;
  artifact: ContractArtifact;
  label: string;
  node: AztecNode;
  wallet: AccountWallet;
}): Promise<Contract> {
  const instance = await input.node.getContract(input.address);
  if (!instance) {
    throw new SponsoredTxFailedError(
      `Missing ${input.label} contract instance on node.`,
      {
        address: input.address.toString(),
        label: input.label,
      },
    );
  }

  await input.wallet.registerContract(instance, input.artifact);
  return Contract.at(input.address, input.artifact, input.wallet);
}

function resolveTargetArtifact(input: {
  config: RuntimeContractConfig;
  label: string;
}): ContractArtifact {
  if (input.config.artifact) {
    return loadArtifactFromCompiledJson(
      input.config.artifact,
      `target:${input.label}`,
    );
  }
  if (input.label === "counter") {
    return requireDefaultArtifact("counter");
  }
  throw new SponsoredTxFailedError(
    `Missing artifact for required contract: target:${input.label}.`,
    {
      label: input.label,
    },
  );
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
  discoveryFpcAddress?: AztecAddress | string;
  runtimeConfig: SponsoredRuntimeConfig;
  wallet: AccountWallet;
}): Promise<AttachedContracts> {
  const addresses = resolveRuntimeAddresses({
    account: input.account,
    discoveryFpcAddress: input.discoveryFpcAddress,
    runtimeConfig: input.runtimeConfig,
  });

  const node = createAztecNodeClient(input.runtimeConfig.nodeUrl);
  await waitForNode(node);
  await assertPublishedAccount(node, addresses.user);

  const acceptedAssetArtifact = resolveArtifact({
    artifact: input.runtimeConfig.acceptedAsset.artifact,
    defaultLabel: "token",
    label: "accepted_asset",
  });
  const fpcArtifact = resolveArtifact({
    artifact: input.runtimeConfig.fpc.artifact,
    defaultLabel: "fpc",
    label: "fpc",
  });

  const [acceptedAsset, fpc] = await Promise.all([
    attachRegisteredContract({
      address: addresses.acceptedAsset,
      artifact: acceptedAssetArtifact,
      label: "accepted_asset",
      node,
      wallet: input.wallet,
    }),
    attachRegisteredContract({
      address: addresses.fpc,
      artifact: fpcArtifact,
      label: "fpc",
      node,
      wallet: input.wallet,
    }),
  ]);

  const faucet =
    addresses.faucet && input.runtimeConfig.faucet
      ? await attachRegisteredContract({
          address: addresses.faucet,
          artifact: resolveArtifact({
            artifact: input.runtimeConfig.faucet.artifact,
            defaultLabel: "faucet",
            label: "faucet",
          }),
          label: "faucet",
          node,
          wallet: input.wallet,
        })
      : undefined;

  const targetPairs = await Promise.all(
    Object.entries(input.runtimeConfig.targets ?? {}).map(
      async ([label, targetConfig]) => {
        const contract = await attachRegisteredContract({
          address: addresses.targets[label] as AztecAddress,
          artifact: resolveTargetArtifact({ config: targetConfig, label }),
          label: `target:${label}`,
          node,
          wallet: input.wallet,
        });
        return [label, contract] as const;
      },
    ),
  );
  const targets = Object.fromEntries(targetPairs);

  return {
    acceptedAsset,
    addresses,
    counter: targets.counter,
    faucet,
    fpc,
    node,
    targets,
    token: acceptedAsset,
  };
}

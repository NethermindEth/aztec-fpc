import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ContractArtifact,
  loadContractArtifact,
  loadContractArtifactForPublic,
  type NoirCompiledContract,
} from "@aztec/aztec.js/abi";

const currentDir =
  typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

type DefaultArtifactLabel = "token" | "fpc" | "bridge";

const DEFAULT_ARTIFACT_FILENAMES: Record<DefaultArtifactLabel, string> = {
  fpc: "fpc-FPCMultiAsset.json",
  token: "token_contract-Token.json",
  bridge: "token_bridge_contract-TokenBridge.json",
};

const defaultArtifactCache: Partial<Record<DefaultArtifactLabel, ContractArtifact>> =
  Object.create(null);

function resolveArtifactSearchDirs(): string[] {
  const dirs = [
    path.resolve(currentDir, "..", "..", "artifacts"),
    path.resolve(currentDir, "..", "artifacts"),
    path.resolve(currentDir, "..", "..", "..", "target"),
    path.resolve(currentDir, "..", "..", "..", "..", "target"),
    path.resolve(process.cwd(), "target"),
  ];

  return Array.from(new Set(dirs));
}

function loadArtifactFromPath(artifactPath: string, label: DefaultArtifactLabel): ContractArtifact {
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
    throw new Error(
      `Failed to load ${label} artifact from ${artifactPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function resolveDefaultArtifactPath(label: DefaultArtifactLabel): string | undefined {
  const filename = DEFAULT_ARTIFACT_FILENAMES[label];
  for (const dir of resolveArtifactSearchDirs()) {
    const candidatePath = path.join(dir, filename);
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return undefined;
}

export function requireDefaultArtifact(label: DefaultArtifactLabel): ContractArtifact {
  const cached = defaultArtifactCache[label];
  if (cached) {
    return cached;
  }

  const artifactPath = resolveDefaultArtifactPath(label);
  if (!artifactPath) {
    throw new Error(
      `Missing ${label} artifact ${DEFAULT_ARTIFACT_FILENAMES[label]}. Searched: ${resolveArtifactSearchDirs().join(", ")}`,
    );
  }

  const artifact = loadArtifactFromPath(artifactPath, label);
  defaultArtifactCache[label] = artifact;
  return artifact;
}

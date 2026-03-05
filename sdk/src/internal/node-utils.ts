import { readFileSync } from "node:fs";

import type { ContractArtifactJson } from "../types";

export function loadContractArtifactJson(artifactPath: string): ContractArtifactJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed reading/parsing target artifact at ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Target artifact at ${artifactPath} is not a JSON object.`);
  }
  return parsed as ContractArtifactJson;
}

/**
 * Contract deployment utilities for parallel script execution.
 *
 * When multiple scripts deploy contracts from the same artifact simultaneously,
 * they race on contract class publication — the first to publish wins and the
 * rest get NULLIFIER_CONFLICT. This wrapper catches that specific error and
 * retries the deployment with `skipClassPublication: true`.
 */

import { Contract } from "@aztec/aztec.js/contracts";

type DeployParams = Parameters<typeof Contract.deploy>;

/**
 * Deploy a contract with automatic retry on class publication races.
 *
 * @param wallet   - Wallet instance to deploy with
 * @param artifact - Contract artifact
 * @param args     - Constructor arguments
 * @param sendOptions - Options forwarded to `.send()` (`from`, `fee`, etc.)
 * @param constructorName - Optional non-default constructor name
 */
export async function deployContract(
  wallet: DeployParams[0],
  artifact: DeployParams[1],
  args: DeployParams[2],
  sendOptions: Record<string, unknown> = {},
  constructorName?: DeployParams[3],
) {
  try {
    return await Contract.deploy(wallet, artifact, args, constructorName).send(
      sendOptions as Parameters<ReturnType<typeof Contract.deploy>["send"]>[0],
    );
  } catch (error) {
    if (isClassPublicationRace(error)) {
      console.log(
        "[deploy] Contract class publication race detected, waiting for sync before retry",
      );
      // Give the PXE time to sync the block containing the class publication
      // from the winning script before retrying with skipClassPublication.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return await Contract.deploy(wallet, artifact, args, constructorName).send({
        ...sendOptions,
        skipClassPublication: true,
      } as Parameters<ReturnType<typeof Contract.deploy>["send"]>[0]);
    }
    throw error;
  }
}

function isClassPublicationRace(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("NULLIFIER_CONFLICT") || msg.includes("Nullifier conflict");
}

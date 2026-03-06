/**
 * Contract deployment utilities for parallel script execution.
 *
 * When multiple scripts deploy contracts from the same artifact simultaneously,
 * they race on contract class publication — the first to publish wins and the
 * rest get NULLIFIER_CONFLICT. This wrapper catches that specific error and
 * retries the deployment, querying the PXE to determine whether the class is
 * already published before each attempt.
 */

import { Contract, getContractClassFromArtifact } from "@aztec/aztec.js/contracts";
import pino from "pino";

const pinoLogger = pino();

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

type DeployParams = Parameters<typeof Contract.deploy>;
type SendOptions = Parameters<ReturnType<typeof Contract.deploy>["send"]>[0];

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
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const opts = { ...sendOptions };

      if (attempt > 0) {
        const classId = getContractClassFromArtifact(artifact).id;
        const metadata = await wallet.getContractClassMetadata(classId);
        if (metadata.isContractClassPubliclyRegistered) {
          pinoLogger.info("Contract class already publicly registered, skipping class publication");
          opts.skipClassPublication = true;
        }
      }

      return await Contract.deploy(wallet, artifact, args, constructorName).send(
        opts as SendOptions,
      );
    } catch (error) {
      if (isClassPublicationRace(error) && attempt < MAX_RETRIES) {
        pinoLogger.info(
          `Contract class publication race detected (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying after ${RETRY_DELAY_MS}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      throw error;
    }
  }

  throw new Error("Unreachable: deployment loop exited without returning or throwing");
}

function isClassPublicationRace(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("Nullifier conflict") ||
    msg.includes("Existing nullifier") ||
    msg.includes("dropped by P2P node")
  );
}

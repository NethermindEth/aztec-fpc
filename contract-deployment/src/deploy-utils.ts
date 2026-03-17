/**
 * Contract deployment utilities for parallel script execution.
 *
 * When multiple scripts deploy contracts from the same artifact simultaneously,
 * they race on contract class publication — the first to publish wins and the
 * rest get NULLIFIER_CONFLICT. This wrapper catches that specific error and
 * retries the deployment, querying the PXE to determine whether the class is
 * already published before each attempt.
 */

import type { ContractArtifact } from "@aztec/aztec.js/abi";
import {
  BatchCall,
  type Contract,
  type ContractFunctionInteraction,
  type DeployMethod,
  type DeployOptions,
  getContractClassFromArtifact,
} from "@aztec/aztec.js/contracts";
import type { Wallet } from "@aztec/aztec.js/wallet";
import pino from "pino";

const pinoLogger = pino();

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

/**
 * Deploy a contract with automatic retry on class publication races.
 *
 * @param wallet       - Wallet instance to deploy with
 * @param artifact     - Contract artifact
 * @param deployMethod - Pre-built deploy method (from Contract.deploy or Contract.deployWithPublicKeys)
 * @param sendOptions  - Options forwarded to `.send()` (`from`, `fee`, etc.)
 * @param extraCalls   - Optional extra calls to batch with the deploy via BatchCall
 */
export async function deployContract(
  wallet: Wallet,
  artifact: ContractArtifact,
  deployMethod: DeployMethod<Contract>,
  sendOptions: DeployOptions,
  extraCalls?: ContractFunctionInteraction[],
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const opts = { ...sendOptions };

      const classId = (await getContractClassFromArtifact(artifact)).id;
      const metadata = await wallet.getContractClassMetadata(classId);
      if (metadata.isContractClassPubliclyRegistered) {
        pinoLogger.info("Contract class already publicly registered, skipping class publication");
        opts.skipClassPublication = true;
      }

      if (extraCalls && extraCalls.length > 0) {
        const batch = new BatchCall(wallet, [deployMethod, ...extraCalls]);
        await batch.send(opts);
        return;
      }

      await deployMethod.send(opts);
      return;
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

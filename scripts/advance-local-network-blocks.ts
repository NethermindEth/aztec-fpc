import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import type { ContractArtifact } from "@aztec/aztec.js/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import {
  loadContractArtifact,
  loadContractArtifactForPublic,
} from "@aztec/stdlib/abi";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
import { EmbeddedWallet } from "@aztec/wallets/embedded";

/**
 * Sends `blocks` lightweight L2 transactions so local-network produces new blocks.
 *
 * This is useful for local relays where L1->L2 FeeJuice/topup state can require
 * additional L2 block progression before balances become visible/claimable.
 */
export async function advanceLocalNetworkBlocks(
  token: Contract,
  operator: AztecAddress,
  user: AztecAddress,
  blocks: number,
  logPrefix = "[advance-blocks]",
): Promise<void> {
  for (let i = 0; i < blocks; i++) {
    // Minting a tiny public amount is cheap and deterministic.
    await token.methods.mint_to_public(user, 1n).send({
      from: operator,
      wait: { timeout: 180 },
    });
    console.log(`${logPrefix} advanced=${i + 1}/${blocks}`);
  }
}

function loadArtifact(artifactPath: string): ContractArtifact {
  const parsed = JSON.parse(
    fs.readFileSync(artifactPath, "utf8"),
  ) as NoirCompiledContract;
  try {
    return loadContractArtifact(parsed);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes("Contract's public bytecode has not been transpiled")
    ) {
      return loadContractArtifactForPublic(parsed);
    }
    throw err;
  }
}

async function main() {
  const thisFile = fileURLToPath(import.meta.url);
  const scriptsDir = path.dirname(thisFile);
  const repoRoot = path.resolve(scriptsDir, "..");

  const nodeUrl = process.env.AZTEC_NODE_URL ?? "http://localhost:8080";
  const manifestPath =
    process.env.MANIFEST_PATH ??
    path.join(repoRoot, "deployments", "manifest.json");
  const tokenArtifactPath =
    process.env.TOKEN_ARTIFACT_PATH ??
    path.join(repoRoot, "target", "token_contract-Token.json");
  const blocks = Number(process.env.RELAY_ADVANCE_BLOCKS ?? "2");
  const ephemeralWallet = process.env.EMBEDDED_WALLET_EPHEMERAL !== "0";

  if (!Number.isInteger(blocks) || blocks <= 0) {
    throw new Error(
      `RELAY_ADVANCE_BLOCKS must be a positive integer. Got: ${blocks}`,
    );
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    contracts: { accepted_asset: string };
    operator: { address: string };
  };
  const tokenAddress = AztecAddress.fromString(
    manifest.contracts.accepted_asset,
  );
  const operatorFromManifest = AztecAddress.fromString(
    manifest.operator.address,
  );

  const node = createAztecNodeClient(nodeUrl);
  await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: ephemeralWallet,
  });

  const testAccounts = await getInitialTestAccountsData();
  const [operator, user] = await Promise.all(
    testAccounts.slice(0, 2).map(async (account) => {
      return (
        await wallet.createSchnorrAccount(
          account.secret,
          account.salt,
          account.signingKey,
        )
      ).address;
    }),
  );
  if (!operator.equals(operatorFromManifest)) {
    throw new Error(
      `Operator mismatch. manifest=${operatorFromManifest} wallet=${operator}`,
    );
  }

  const tokenArtifact = loadArtifact(tokenArtifactPath);
  const tokenInstance = await node.getContract(tokenAddress);
  if (!tokenInstance) {
    throw new Error(
      `Missing accepted_asset contract instance on node at ${tokenAddress.toString()}`,
    );
  }
  await wallet.registerContract(tokenInstance, tokenArtifact);
  const token = await Contract.at(tokenAddress, tokenArtifact, wallet);
  await advanceLocalNetworkBlocks(token, operator, user, blocks);
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FAIL: ${message}`);
    process.exit(1);
  });
}

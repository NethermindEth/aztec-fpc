/**
 * One-shot FPC gate profiler.
 *
 * Profiles `FPCMultiAsset.fee_entrypoint` on a running local network without
 * going through `pxe.profileTx()`. The stock profiling path currently trips on
 * an include-by timestamp bug in this environment, so we instead:
 *   1. build a normal authenticated tx request,
 *   2. simulate it with a no-op contract override to force PXE to skip kernels,
 *   3. reconstruct the execution steps locally, and
 *   4. compute gate counts per circuit from the returned bytecode.
 *
 * Output:
 *   profiling/benchmarks/fpc.benchmark.json
 */

import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import { Contract } from "@aztec/aztec.js/contracts";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { BBLazyPrivateKernelProver } from "@aztec/bb-prover/client/lazy";
import { Fr } from "@aztec/foundation/curves/bn254";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import { generateSimulatedProvingResult } from "@aztec/pxe/simulator";
import { createPXE, getPXEConfig } from "@aztec/pxe/server";
import { WASMSimulator } from "@aztec/simulator/client";
import { loadContractArtifact } from "@aztec/stdlib/abi";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Gas, GasFees, GasSettings } from "@aztec/stdlib/gas";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { SimulationOverrides } from "@aztec/stdlib/tx";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFpcSteps, findArtifact, signQuote, SimpleWallet } from "./profile-utils.mjs";

const NODE_URL = process.env.AZTEC_NODE_URL || "http://127.0.0.1:8080";
const PXE_DATA_DIR = "/tmp/profile-fpc-pxe";
const QUOTE_TTL_SECONDS = 3500n;
const QUOTE_DOMAIN_SEP = 0x465043n;
const FPC_CONTRACT_NAMES = ["FPCMultiAsset", "FPC"];
const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "benchmarks");
const OUTPUT_PATH = join(OUTPUT_DIR, "fpc.benchmark.json");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function numFmt(value) {
  return Number(value).toLocaleString();
}

async function waitForAcceptedAsset(fpc, tokenAddress, operatorAddress, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const isAccepted = await fpc.methods.is_accepted_asset(tokenAddress).simulate({ from: operatorAddress });
    if (isAccepted === true || isAccepted === 1 || isAccepted === "1") {
      return;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for accepted asset ${tokenAddress.toString()}`);
}

function printTable(title, rows) {
  console.log(`\n=== ${title} ===\n`);
  console.log(`${"Function".padEnd(60)}${"Own gates".padEnd(14)}Subtotal`);
  console.log("─".repeat(88));
  let subtotal = 0;
  for (const row of rows) {
    subtotal += row.gateCount ?? 0;
    console.log(
      `${String(row.functionName ?? "(unknown)").padEnd(60)}${numFmt(row.gateCount ?? 0).padEnd(14)}${numFmt(subtotal)}`,
    );
  }
  console.log("─".repeat(88));
  console.log(`${"TOTAL".padEnd(60)}${"".padEnd(14)}${numFmt(subtotal)}`);
}

async function profileInteractionGates({ wallet, node, interaction, from, authWitnesses, gasSettings, scopes, overrides }) {
  const executionPayload = await interaction.request({ authWitnesses });
  const feeOptions = await wallet.completeFeeOptions(from, executionPayload.feePayer, gasSettings);
  const txRequest = await wallet.createTxExecutionRequestFromPayloadAndFee(executionPayload, from, feeOptions);

  const simulatedTx = await wallet.pxe.simulateTx(txRequest, {
    simulatePublic: false,
    skipTxValidation: true,
    skipFeeEnforcement: true,
    overrides,
    scopes,
  });

  const provingResult = await generateSimulatedProvingResult(
    simulatedTx.privateExecutionResult,
    (contractAddress, selector) => wallet.pxe.contractStore.getDebugFunctionName(contractAddress, selector),
    node,
  );

  const prover = new BBLazyPrivateKernelProver(new WASMSimulator());
  const fullTrace = [];
  for (const step of provingResult.executionSteps) {
    const gateCount = await prover.computeGateCountForCircuit(step.bytecode, step.functionName);
    fullTrace.push({
      functionName: step.functionName ?? "(unknown)",
      gateCount,
      witgenMs: step.timings?.witgen ?? 0,
    });
  }

  return fullTrace;
}

async function main() {
  let wallet;

  try {
    console.log("=== FPC Gate Profiler ===\n");

    const node = createAztecNodeClient(NODE_URL);
    console.log("Connected to node at", NODE_URL);

    rmSync(PXE_DATA_DIR, { recursive: true, force: true });
    mkdirSync(PXE_DATA_DIR, { recursive: true });
    mkdirSync(OUTPUT_DIR, { recursive: true });

    const pxe = await createPXE(node, {
      ...getPXEConfig(),
      dataDirectory: PXE_DATA_DIR,
      l1Contracts: await node.getL1ContractAddresses(),
    });
    console.log("PXE started");

    wallet = new SimpleWallet(pxe, node);
    const [userData, operatorData] = await getInitialTestAccountsData();
    const userAddress = await wallet.addSchnorrAccount(userData.secret, userData.salt);
    const operatorAddress = await wallet.addSchnorrAccount(operatorData.secret, operatorData.salt);
    console.log("user:    ", userAddress.toString());
    console.log("operator:", operatorAddress.toString());

    const schnorr = new Schnorr();
    const operatorSigningKey = deriveSigningKey(operatorData.secret);
    const operatorPubKey = await schnorr.computePublicKey(operatorSigningKey);

    const tokenArtifact = loadContractArtifact(JSON.parse(readFileSync(findArtifact("Token"), "utf8")));
    const fpcArtifact = loadContractArtifact(JSON.parse(readFileSync(findArtifact("FPC"), "utf8")));

    console.log("\nDeploying Token...");
    const tokenDeploy = await Contract.deploy(
      wallet,
      tokenArtifact,
      ["TestToken", "TST", 18, userAddress, AztecAddress.ZERO],
      "constructor_with_minter",
    ).send({ from: userAddress });
    const token = Contract.at(tokenDeploy.address, tokenArtifact, wallet);
    console.log("Token:", token.address.toString());

    console.log("Deploying FPC...");
    const fpcDeploy = await Contract.deploy(wallet, fpcArtifact, [
      operatorAddress,
      operatorPubKey.x,
      operatorPubKey.y,
    ]).send({ from: userAddress });
    const fpc = Contract.at(fpcDeploy.address, fpcArtifact, wallet);
    console.log("FPC:  ", fpc.address.toString());

    console.log("Initializing allowlist...");
    await fpc.methods.add_accepted_asset(token.address).send({
      from: operatorAddress,
      wait: { timeout: 180 },
    });
    await waitForAcceptedAsset(fpc, token.address, operatorAddress);
    console.log("Allowlist initialized.");

    const aaPaymentAmount = 1n;
    console.log("\nMinting tokens to user...");
    await token.methods.mint_to_private(userAddress, aaPaymentAmount + 1000n).send({ from: userAddress });
    console.log("Minted.");

    const latestHeader = await node.getBlockHeader("latest");
    const validUntil = latestHeader.globalVariables.timestamp + QUOTE_TTL_SECONDS;
    const transferNonce = Fr.random();
    const transferCall = token.methods.transfer_private_to_private(
      userAddress,
      operatorAddress,
      aaPaymentAmount,
      transferNonce,
    );
    const transferAuthWit = await wallet.createAuthWit(userAddress, {
      caller: fpc.address,
      action: transferCall,
    });
    const quoteSig = await signQuote(
      schnorr,
      operatorSigningKey,
      fpc.address,
      token.address,
      0n,
      aaPaymentAmount,
      validUntil,
      userAddress,
      QUOTE_DOMAIN_SEP,
    );

    const gasSettings = GasSettings.default({
      gasLimits: new Gas(1_000_000, 1_000_000),
      teardownGasLimits: new Gas(0, 0),
      maxFeesPerGas: new GasFees(0n, 0n),
    });

    const fpcInstance = await wallet.pxe.getContractInstance(fpc.address);
    if (!fpcInstance) {
      throw new Error(`FPC instance not registered in PXE: ${fpc.address.toString()}`);
    }
    const overrides = new SimulationOverrides({
      [fpc.address.toString()]: {
        instance: fpcInstance,
        artifact: fpcArtifact,
      },
    });

    console.log("\nProfiling fee_entrypoint...");
    const fullTrace = await profileInteractionGates({
      wallet,
      node,
      interaction: fpc.methods.fee_entrypoint(token.address, transferNonce, 0n, aaPaymentAmount, validUntil, quoteSig),
      from: userAddress,
      authWitnesses: [transferAuthWit],
      gasSettings,
      scopes: [userAddress, operatorAddress],
      overrides,
    });

    const fpcTrace = extractFpcSteps(fullTrace, FPC_CONTRACT_NAMES);
    const fpcTotalGateCount = fpcTrace.reduce((sum, step) => sum + (step.gateCount ?? 0), 0);

    printTable("Full Trace", fullTrace);
    printTable("FPC Trace", fpcTrace);

    const report = {
      summary: { fee_entrypoint: fpcTotalGateCount },
      results: [
        {
          name: "fee_entrypoint",
          totalGateCount: fpcTotalGateCount,
          provingTime: 0,
          fullTrace,
          fpcGateCounts: fpcTrace,
          fpcTotalGateCount,
        },
      ],
      gasSummary: { fee_entrypoint: 0 },
      provingTimeSummary: { fee_entrypoint: 0 },
    };

    writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
    console.log(`\nSaved report to ${OUTPUT_PATH}`);
  } finally {
    rmSync(PXE_DATA_DIR, { recursive: true, force: true });
    if (wallet) {
      void wallet.stop().catch(() => {});
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });

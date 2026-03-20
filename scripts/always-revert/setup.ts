/**
 * Environment bootstrap for always-revert smoke tests.
 *
 * Connects to the Aztec node, registers accounts and contracts, and waits for
 * the topup service to fund the FPC with FeeJuice. Unlike the cold-start setup,
 * this flow uses a faucet instead of an L1 bridge — no L1 token infrastructure
 * is needed.
 */

import path from "node:path";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { Contract } from "@aztec/aztec.js/contracts";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import { FpcClient } from "@aztec-fpc/sdk";
import { setup as commonSetup } from "../common/setup-helpers.ts";
import type { CliArgs } from "./cli.ts";

// ---------------------------------------------------------------------------
// TestContext — everything tests need
// ---------------------------------------------------------------------------

export type TestContext = {
  args: CliArgs;
  node: AztecNode;
  wallet: EmbeddedWallet;
  operator: AztecAddress;
  fpcClient: FpcClient;
  fpcAddress: AztecAddress;
  tokenAddress: AztecAddress;
  token: Contract;
  faucet: Contract;
  counter: Contract;
  sponsoredFeePayment: SponsoredFeePaymentMethod;
};

// ---------------------------------------------------------------------------
// setup()
// ---------------------------------------------------------------------------

export async function setup(args: CliArgs): Promise<TestContext> {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const { node, wallet, operator, contracts, sponsoredFpcAddress } = await commonSetup(
    args,
    repoRoot,
    "always-revert",
  );

  const { token, fpc, counter, faucet } = contracts;

  if (!counter) {
    throw new Error("Manifest missing contracts.counter (required for always-revert)");
  }
  if (!faucet) {
    throw new Error("Manifest missing contracts.faucet (required for always-revert)");
  }

  const fpcClient = new FpcClient({
    fpcAddress: fpc.address,
    operator,
    node,
    attestationBaseUrl: args.attestationUrl,
  });

  return {
    args,
    node,
    wallet,
    operator,
    fpcClient,
    fpcAddress: fpc.address,
    tokenAddress: token.address,
    token,
    faucet,
    counter,
    sponsoredFeePayment: new SponsoredFeePaymentMethod(sponsoredFpcAddress),
  };
}

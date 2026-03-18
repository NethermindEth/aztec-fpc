/**
 * Minimal standalone example: cold-start + FPC-paid transfer.
 *
 * Edit the constants below to match your deployment, then run:
 *   bunx tsx examples/fpc-full-flow.ts
 *
 * Requires: Aztec node, L1 (Anvil), attestation server, topup service.
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { L1ToL2TokenPortalManager } from "@aztec/aztec.js/ethereum";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { createExtendedL1Client } from "@aztec/ethereum/client";
import { EthAddress } from "@aztec/foundation/eth-address";
import { createLogger } from "@aztec/foundation/log";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { FpcClient } from "@aztec-fpc/sdk";
import { type Chain, extractChain } from "viem";
import * as viemChains from "viem/chains";

// =============================================================================
// Constants — edit these to match your deployment
// =============================================================================

// --- L2 user secret ---
const userSecret = Fr.random();

// --- L1 private keys ---
// If using your own key or the address runs out of L1 test tokens, mint more with:
//   cast send 0xf49de848d9c00c4dfb088b2e6ba2dac81e34aa5d \
//     "mint(address,uint256)()" <YOUR_L1_ADDRESS> 1000000000000000000000000000000000000 \
//     --rpc-url https://ethereum-sepolia-rpc.publicnode.com \
//     --private-key 0xcc49e1d22f5ee1618c30446bc2e415c7e504e6409ac690205c7bf12d052ae088
const L1_USER_KEY = "0x43b45bae4115cda0e584e6aae8edfa023973ddb97409d6688549ffdaf904747c";

// --- Network ---
const NODE_URL = "https://rpc.testnet.aztec-labs.com/";
const L1_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const ATTESTATION_URL = "https://aztec-fpc-testnet.staging-nethermind.xyz/";

// --- L2 contract addresses ---
const FPC_ADDRESS = "0x1be2cae678e1eddd712682948119b3fe2c3ff3f381d78ebea06162f21487d60f";
const TOKEN_ADDRESS = "0x07348d12aae72d1c2ff67cb2bf6b0e54f2ac39484f21cad7247d4e27b4822afb";
const BRIDGE_ADDRESS = "0x19b200d772d3e9068921e6f5df7530271229e958acc9efc2c637afe64db9763f";
const OPERATOR_ADDRESS = "0x0aa818ff7e9bb59334e0106eeeacc5ce8d32610d34917b213f305a30a87cf974";

// --- L1 contract addresses (Sepolia) ---
const L1_PORTAL_ADDRESS = "0x57a426552a472e953ecc1342f25b17cc192326be";
const L1_ERC20_ADDRESS = "0xf49de848d9c00c4dfb088b2e6ba2dac81e34aa5d";

// --- Amounts ---
const CLAIM_AMOUNT = 10_000_000_000_000_000n;

// --- PXE ---
const MESSAGE_TIMEOUT_SECONDS = 300;

// =============================================================================
// Main
// =============================================================================

async function main() {
  // =========================================================================
  // Phase 0: Setup — connect to node, derive accounts, create clients
  // =========================================================================
  console.log("--- Phase 0: Setup ---");

  console.log("Node URL: ", NODE_URL);
  console.log("L1 RPC URL: ", L1_RPC_URL);
  console.log("Attestation URL: ", ATTESTATION_URL);

  console.log("\nL2 contract addresses:");
  console.log("FPC address: ", FPC_ADDRESS);
  console.log("Token address: ", TOKEN_ADDRESS);
  console.log("Bridge address: ", BRIDGE_ADDRESS);
  console.log("Operator address: ", OPERATOR_ADDRESS);

  console.log("\nL1 contract addresses:");
  console.log("Portal address: ", L1_PORTAL_ADDRESS);
  console.log("ERC20 address: ", L1_ERC20_ADDRESS);

  const fpcAddress = AztecAddress.fromString(FPC_ADDRESS);
  const tokenAddress = AztecAddress.fromString(TOKEN_ADDRESS);
  const bridgeAddress = AztecAddress.fromString(BRIDGE_ADDRESS);
  const operatorAddress = AztecAddress.fromString(OPERATOR_ADDRESS);

  console.log("Connecting to Aztec node...");
  const node = createAztecNodeClient(NODE_URL);
  await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxeConfig: { proverEnabled: true },
  });
  console.log("Connected.");

  const userAccount = await wallet.createSchnorrAccount(userSecret, Fr.ZERO);
  const userAddress = userAccount.address;
  console.log(`Generated user key:     ${userSecret}`);
  console.log(`Generated user address: ${userAddress}`);

  const nodeInfo = await node.getNodeInfo();
  const l1Chain = extractChain({
    chains: Object.values(viemChains) as readonly Chain[],
    id: nodeInfo.l1ChainId,
  });
  const l1WalletClient = createExtendedL1Client([L1_RPC_URL], L1_USER_KEY, l1Chain);
  console.log("L1 client ready.");

  const fpcClient = new FpcClient({
    fpcAddress,
    operator: operatorAddress,
    node,
    attestationBaseUrl: ATTESTATION_URL,
  });
  console.log("FpcClient ready.");

  // =========================================================================
  // Phase 1: Cold-start — bridge L1->L2, claim + pay FPC fee in one tx
  // =========================================================================
  console.log("\n--- Phase 1: Cold-start ---");

  const portalManager = new L1ToL2TokenPortalManager(
    EthAddress.fromString(L1_PORTAL_ADDRESS),
    EthAddress.fromString(L1_ERC20_ADDRESS),
    undefined,
    l1WalletClient,
    createLogger("bridge"),
  );

  const bridgeClaim = await portalManager.bridgeTokensPrivate(userAddress, CLAIM_AMOUNT, false);
  await waitForL1ToL2MessageReady(node, Fr.fromHexString(bridgeClaim.messageHash as string), {
    timeoutSeconds: MESSAGE_TIMEOUT_SECONDS,
  });
  console.log(`Tokens bridged. message_hash=${bridgeClaim.messageHash}`);

  // Execute cold-start
  const coldStartResult = await fpcClient.executeColdStart({
    wallet,
    userAddress,
    tokenAddress,
    bridgeAddress,
    bridgeClaim,
  });
  console.log(`Cold-start confirmed. tx_hash=${coldStartResult.txHash}`);
  console.log(`  fee=${coldStartResult.txFee} aa_payment=${coldStartResult.aaPaymentAmount}`);

  // =========================================================================
  // Phase 2: Deploy user account via FPC fee_entrypoint
  // =========================================================================
  console.log("\n--- Phase 2: Deploy account via FPC ---");

  const deployMethod = await userAccount.getDeployMethod();
  const { estimatedGas } = await deployMethod.simulate({
    from: AztecAddress.ZERO,
    fee: { estimateGas: true },
    skipClassPublication: true,
  });
  if (!estimatedGas) {
    throw new Error("Failed to estimate gas for deploy method");
  }

  const deployPayment = await fpcClient.createPaymentMethod({
    wallet,
    user: userAddress,
    tokenAddress,
    estimatedGas,
  });

  await deployMethod.send({
    from: AztecAddress.ZERO,
    fee: deployPayment.fee,
    skipClassPublication: true,
  });
  console.log(`Account deployed. aa_payment=${deployPayment.quote.aa_payment_amount}`);
}

main()
  .then(() => {
    console.log("\nDone.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("FAILED:", err);
    process.exit(1);
  });

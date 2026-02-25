/**
 * L1 → L2 Fee Juice bridge.
 *
 * Fee Juice is bridged by calling depositToAztecPublic on the L1 FeeJuicePortal
 * contract. The portal locks ETH on L1 and sends a message to L2; the Aztec
 * sequencer mints the equivalent Fee Juice to the recipient address on L2.
 *
 * Bridge latency: typically 1-3 L1 blocks (12-36 seconds on mainnet) plus one
 * Aztec L2 block for the L1→L2 message to be processed. Configure your
 * threshold high enough to absorb this delay.
 *
 * ABI: FeeJuicePortal.depositToAztecPublic(bytes32 to, uint256 amount, bytes32 secretHash)
 *   to         — L2 recipient address (the FPC address, left-padded to 32 bytes)
 *   amount     — wei amount of ETH to bridge as Fee Juice
 *   secretHash — keccak256 of a secret; used to claim the message on L2.
 *                For automated top-up, the secret can be Fr.ZERO and the claim
 *                is handled automatically by the L2 protocol.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Minimal ABI — only the deposit function we need.
// Full ABI available in @aztec/l1-artifacts if the package is present.
const FEE_JUICE_PORTAL_ABI = parseAbi([
  "function depositToAztecPublic(bytes32 to, uint256 amount, bytes32 secretHash) payable returns (bytes32)",
]);

export interface BridgeResult {
  l1TxHash: Hex;
  amount: bigint;
}

/**
 * Bridge `amount` wei of ETH from L1 to the FPC's L2 Fee Juice balance.
 *
 * @param l1RpcUrl       - L1 Ethereum RPC endpoint
 * @param privateKey     - L1 operator private key (hex, TODO: use KMS in production)
 * @param portalAddress  - Deployed FeeJuicePortal contract address on L1
 * @param fpcL2Address   - The FPC's L2 address (recipient of Fee Juice on L2)
 * @param amount         - Amount in wei to bridge
 */
export async function bridgeFeeJuice(
  l1RpcUrl: string,
  privateKey: Hex,
  portalAddress: Hex,
  fpcL2Address: string,
  amount: bigint,
): Promise<BridgeResult> {
  const account = privateKeyToAccount(privateKey);

  const publicClient = createPublicClient({
    transport: http(l1RpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    transport: http(l1RpcUrl),
  });

  // Convert L2 address to bytes32 (left-padded)
  const recipientBytes32 =
    `0x${fpcL2Address.replace("0x", "").padStart(64, "0")}` as Hex;

  // secretHash = 0x0 lets the L2 protocol auto-claim the message
  const secretHash = `0x${"00".repeat(32)}` as Hex;

  const hash = await walletClient.writeContract({
    chain: undefined,
    address: portalAddress,
    abi: FEE_JUICE_PORTAL_ABI,
    functionName: "depositToAztecPublic",
    args: [recipientBytes32, amount, secretHash],
    value: amount, // ETH sent along with the call
  });

  // Wait for L1 confirmation
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`L1 bridge transaction reverted: ${hash}`);
  }

  return { l1TxHash: hash, amount };
}

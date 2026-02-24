/**
 * L2 Fee Juice balance monitor.
 *
 * Fee Juice is Aztec's native gas token, held in a dedicated protocol contract.
 * The FPC pays transaction fees from this balance; the protocol deducts directly
 * from it after each transaction.
 *
 * We read the balance using the node's public storage API.
 */

import { AztecAddress, createPXEClient } from '@aztec/aztec.js';
import type { PXE } from '@aztec/aztec.js';

// The Fee Juice contract address is a protocol constant.
// Import from @aztec/protocol-contracts or read from node deployment info.
// We fetch it from the node at startup so the service works across deployments.
let feeJuiceAddress: AztecAddress | null = null;

async function getFeeJuiceAddress(pxe: PXE): Promise<AztecAddress> {
  if (feeJuiceAddress) return feeJuiceAddress;
  const info = await pxe.getNodeInfo();
  feeJuiceAddress = info.l1ContractAddresses
    ? AztecAddress.fromString((info as any).protocolContractAddresses?.feeJuice ?? '0x')
    : AztecAddress.ZERO;
  return feeJuiceAddress;
}

/**
 * Read the FPC contract's Fee Juice balance from L2.
 *
 * Fee Juice balances are stored in the FeeJuice contract's public storage as a
 * simple mapping: address → u128 balance. We query via getPublicStorageAt using
 * the derivable storage slot for the fpc_address key.
 *
 * Note: The exact storage slot derivation depends on the FeeJuice contract's
 * storage layout. Check @aztec/protocol-contracts for the canonical approach.
 * For MVP we use the node's getBalance helper if available.
 */
export async function getFeeJuiceBalance(
  pxe: PXE,
  fpcAddress: AztecAddress,
): Promise<bigint> {
  // The node exposes getBalance(address, tokenAddress) for public token balances.
  // Fee Juice is a special token — use the protocol helper if available.
  const feeJuice = await getFeeJuiceAddress(pxe);

  try {
    // Try the standard public balance API first
    const balance = await (pxe as any).getBalance(fpcAddress, feeJuice);
    return BigInt(balance.toString());
  } catch {
    // Fallback: read raw storage slot
    // The FeeJuice contract stores balances at H(slot_index, address)
    // This is a known storage layout — verify against your aztec-packages version
    throw new Error(
      'Could not read Fee Juice balance. Verify getBalance API for your aztec.js version.',
    );
  }
}

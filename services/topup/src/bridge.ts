/**
 * L1 → L2 Fee Juice bridge.
 *
 * Uses the canonical L1FeeJuicePortalManager from @aztec/aztec.js which
 * handles ERC20 approval, deposit, event extraction, and claim secret
 * generation. Portal/token/handler addresses are fetched from the Aztec node.
 */

import {
  L1FeeJuicePortalManager,
  type L2AmountClaim,
} from "@aztec/aztec.js/ethereum";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { createEthereumChain } from "@aztec/ethereum/chain";
import { createExtendedL1Client } from "@aztec/ethereum/client";
import { createLogger } from "@aztec/foundation/log";

export type { L2AmountClaim };

const logger = createLogger("topup:bridge");

/**
 * Bridge `amount` of Fee Juice from L1 to the given L2 address.
 *
 * @param node          - Aztec node client (used to fetch L1 contract addresses and chain id)
 * @param l1RpcUrl      - L1 Ethereum RPC endpoint
 * @param privateKey    - L1 operator private key (hex, TODO: use KMS in production)
 * @param fpcL2Address  - The FPC's L2 address (recipient of Fee Juice on L2)
 * @param amount        - Amount to bridge (in token smallest unit)
 */
export async function bridgeFeeJuice(
  node: AztecNode,
  l1RpcUrl: string,
  privateKey: string,
  fpcL2Address: AztecAddress,
  amount: bigint,
): Promise<L2AmountClaim> {
  const { l1ChainId } = await node.getNodeInfo();
  const chain = createEthereumChain([l1RpcUrl], l1ChainId);
  const client = createExtendedL1Client(
    chain.rpcUrls,
    privateKey,
    chain.chainInfo,
  );

  const portal = await L1FeeJuicePortalManager.new(node, client, logger);
  return portal.bridgeTokensPublic(fpcL2Address, amount);
}

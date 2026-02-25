import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode, NodeInfo } from "@aztec/aztec.js/node";
import { getFeeJuiceBalance as getSdkFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { deriveStorageSlotInMap } from "@aztec/stdlib/hash";

const FEE_JUICE_BALANCES_STORAGE_SLOT = new Fr(1);

type FeeJuiceAddressSource = "node_info";

export interface FeeJuiceBalanceReader {
  feeJuiceAddress: AztecAddress;
  addressSource: FeeJuiceAddressSource;
  getBalance(owner: AztecAddress): Promise<bigint>;
}

function getFeeJuiceFromNodeInfo(nodeInfo: NodeInfo): AztecAddress {
  const feeJuiceAddress = nodeInfo.protocolContractAddresses.feeJuice;
  if (feeJuiceAddress.isZero()) {
    throw new Error(
      `Node info returned zero protocolContractAddresses.feeJuice (nodeVersion=${nodeInfo.nodeVersion}, rollupVersion=${nodeInfo.rollupVersion})`,
    );
  }

  return feeJuiceAddress;
}

async function readFeeJuiceBalanceFromStorage(
  owner: AztecAddress,
  node: AztecNode,
  feeJuiceAddress: AztecAddress,
): Promise<bigint> {
  const slot = await deriveStorageSlotInMap(
    FEE_JUICE_BALANCES_STORAGE_SLOT,
    owner,
  );
  const value = await node.getPublicStorageAt("latest", feeJuiceAddress, slot);
  return value.toBigInt();
}

export async function resolveFeeJuiceAddress(node: AztecNode): Promise<{
  address: AztecAddress;
  source: FeeJuiceAddressSource;
  nodeInfo: NodeInfo;
}> {
  const nodeInfo = await node.getNodeInfo();
  return {
    address: getFeeJuiceFromNodeInfo(nodeInfo),
    source: "node_info",
    nodeInfo,
  };
}

export async function createFeeJuiceBalanceReader(
  node: AztecNode,
): Promise<FeeJuiceBalanceReader> {
  const resolution = await resolveFeeJuiceAddress(node);
  let sdkPathEnabled = true;

  return {
    feeJuiceAddress: resolution.address,
    addressSource: resolution.source,
    async getBalance(owner: AztecAddress): Promise<bigint> {
      if (sdkPathEnabled) {
        try {
          return await getSdkFeeJuiceBalance(owner, node);
        } catch (error) {
          sdkPathEnabled = false;
          const nodeInfoSummary = `nodeVersion=${resolution.nodeInfo.nodeVersion}, rollupVersion=${resolution.nodeInfo.rollupVersion}`;
          console.warn(
            `aztec.js getFeeJuiceBalance failed; falling back to direct storage reads (${nodeInfoSummary})`,
            error,
          );
        }
      }

      try {
        return await readFeeJuiceBalanceFromStorage(
          owner,
          node,
          resolution.address,
        );
      } catch (error) {
        throw new Error(
          `Unable to read Fee Juice balance from L2 storage at ${resolution.address.toString()}`,
          { cause: error },
        );
      }
    },
  };
}

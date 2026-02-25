import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode, NodeInfo } from "@aztec/aztec.js/node";
import { getFeeJuiceBalance as getSdkFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { deriveStorageSlotInMap } from "@aztec/stdlib/hash";
import type { Config } from "./config.js";

const FEE_JUICE_BALANCES_STORAGE_SLOT = new Fr(1);

type FeeJuiceAddressSource = "config" | "node_info";

export interface FeeJuiceBalanceReader {
  feeJuiceAddress: AztecAddress;
  addressSource: FeeJuiceAddressSource;
  getBalance(owner: AztecAddress): Promise<bigint>;
}

function parseConfiguredFeeJuiceAddress(config: Config): AztecAddress | null {
  if (!config.fee_juice_address) {
    return null;
  }

  try {
    const address = AztecAddress.fromString(config.fee_juice_address);
    if (address.isZero()) {
      throw new Error("fee_juice_address must not be zero");
    }
    return address;
  } catch (error) {
    throw new Error(
      `Invalid fee_juice_address config value: ${config.fee_juice_address}`,
      { cause: error },
    );
  }
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

export async function resolveFeeJuiceAddress(
  config: Config,
  node: AztecNode,
): Promise<{
  address: AztecAddress;
  source: FeeJuiceAddressSource;
  nodeInfo?: NodeInfo;
}> {
  const configuredAddress = parseConfiguredFeeJuiceAddress(config);
  if (configuredAddress) {
    return { address: configuredAddress, source: "config" };
  }

  const nodeInfo = await node.getNodeInfo();
  return {
    address: getFeeJuiceFromNodeInfo(nodeInfo),
    source: "node_info",
    nodeInfo,
  };
}

export async function createFeeJuiceBalanceReader(
  config: Config,
  node: AztecNode,
): Promise<FeeJuiceBalanceReader> {
  const resolution = await resolveFeeJuiceAddress(config, node);
  let sdkPathEnabled = resolution.source === "node_info";

  return {
    feeJuiceAddress: resolution.address,
    addressSource: resolution.source,
    async getBalance(owner: AztecAddress): Promise<bigint> {
      if (sdkPathEnabled) {
        try {
          return await getSdkFeeJuiceBalance(owner, node);
        } catch (error) {
          sdkPathEnabled = false;
          const nodeInfoSummary = resolution.nodeInfo
            ? `nodeVersion=${resolution.nodeInfo.nodeVersion}, rollupVersion=${resolution.nodeInfo.rollupVersion}`
            : "node info unavailable";
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

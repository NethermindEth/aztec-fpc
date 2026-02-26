import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { ABIParameter, FunctionAbi } from "@aztec/stdlib/abi";
import { FunctionType } from "@aztec/stdlib/abi";
import { computeInitializationHash } from "@aztec/stdlib/contract";

const AZTEC_ADDRESS_TYPE: ABIParameter["type"] = {
  kind: "struct",
  path: "aztec::protocol_types::address::aztec_address::AztecAddress",
  fields: [{ name: "inner", type: { kind: "field" } }],
};

const FPC_CONSTRUCTOR_ABI: FunctionAbi = {
  name: "constructor",
  functionType: FunctionType.PUBLIC,
  isOnlySelf: false,
  isStatic: false,
  isInitializer: true,
  parameters: [
    {
      name: "operator",
      type: AZTEC_ADDRESS_TYPE,
      visibility: "private",
    },
    {
      name: "operator_pubkey_x",
      type: { kind: "field" },
      visibility: "private",
    },
    {
      name: "operator_pubkey_y",
      type: { kind: "field" },
      visibility: "private",
    },
    {
      name: "accepted_asset",
      type: AZTEC_ADDRESS_TYPE,
      visibility: "private",
    },
  ],
  returnTypes: [],
  errorTypes: {},
};

export type FpcImmutableVerificationReason =
  | "CONTRACT_QUERY_FAILED"
  | "CONTRACT_NOT_FOUND"
  | "IMMUTABLE_MISMATCH";

export class FpcImmutableVerificationError extends Error {
  constructor(
    readonly reason: FpcImmutableVerificationReason,
    message: string,
  ) {
    super(message);
    this.name = "FpcImmutableVerificationError";
  }
}

export interface FpcImmutableInputs {
  fpcAddress: AztecAddress;
  acceptedAsset: AztecAddress;
  operatorAddress: AztecAddress;
  operatorPubkeyX: Fr;
  operatorPubkeyY: Fr;
}

export async function computeExpectedFpcInitializationHash(
  inputs: Pick<
    FpcImmutableInputs,
    "acceptedAsset" | "operatorAddress" | "operatorPubkeyX" | "operatorPubkeyY"
  >,
): Promise<Fr> {
  return await computeInitializationHash(FPC_CONSTRUCTOR_ABI, [
    inputs.operatorAddress,
    inputs.operatorPubkeyX,
    inputs.operatorPubkeyY,
    inputs.acceptedAsset,
  ]);
}

export async function verifyFpcImmutablesOnStartup(
  node: Pick<AztecNode, "getContract">,
  inputs: FpcImmutableInputs,
): Promise<void> {
  let deployed: Awaited<ReturnType<AztecNode["getContract"]>>;
  try {
    deployed = await node.getContract(inputs.fpcAddress);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new FpcImmutableVerificationError(
      "CONTRACT_QUERY_FAILED",
      `[startup] on-chain FPC immutable verification failed: could not query contract ${inputs.fpcAddress.toString()} (${details})`,
    );
  }

  if (!deployed) {
    throw new FpcImmutableVerificationError(
      "CONTRACT_NOT_FOUND",
      `[startup] on-chain FPC immutable verification failed: contract not found at ${inputs.fpcAddress.toString()}`,
    );
  }

  const expectedInitializationHash =
    await computeExpectedFpcInitializationHash(inputs);
  const onChainInitializationHash = deployed.initializationHash;

  if (!onChainInitializationHash.equals(expectedInitializationHash)) {
    const currentClassId =
      deployed.currentContractClassId?.toString() ?? "unknown";
    const originalClassId =
      deployed.originalContractClassId?.toString() ?? "unknown";
    throw new FpcImmutableVerificationError(
      "IMMUTABLE_MISMATCH",
      `[startup] on-chain FPC immutable mismatch: expected accepted_asset=${inputs.acceptedAsset.toString()} and operator=${inputs.operatorAddress.toString()} (pubkey_x=${inputs.operatorPubkeyX.toString()}, pubkey_y=${inputs.operatorPubkeyY.toString()}) for contract ${inputs.fpcAddress.toString()}, but deployment initialization_hash differs (expected=${expectedInitializationHash.toString()}, on_chain=${onChainInitializationHash.toString()}, current_class_id=${currentClassId}, original_class_id=${originalClassId})`,
    );
  }
}

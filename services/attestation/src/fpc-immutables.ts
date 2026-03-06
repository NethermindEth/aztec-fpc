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

const FPC_CONSTRUCTOR_ABI_BASE: Omit<FunctionAbi, "parameters"> = {
  name: "constructor",
  functionType: FunctionType.PUBLIC,
  isOnlySelf: false,
  isStatic: false,
  isInitializer: true,
  returnTypes: [],
  errorTypes: {},
};

const OPERATOR_PARAMS: ABIParameter[] = [
  { name: "operator", type: AZTEC_ADDRESS_TYPE, visibility: "private" },
  { name: "operator_pubkey_x", type: { kind: "field" }, visibility: "private" },
  { name: "operator_pubkey_y", type: { kind: "field" }, visibility: "private" },
];

const SPONSOR_PARAMS: ABIParameter[] = [
  { name: "sponsor_pubkey_x", type: { kind: "field" }, visibility: "private" },
  { name: "sponsor_pubkey_y", type: { kind: "field" }, visibility: "private" },
];

const FPC_CONSTRUCTOR_ABI_V3: FunctionAbi = {
  ...FPC_CONSTRUCTOR_ABI_BASE,
  parameters: [...OPERATOR_PARAMS, ...SPONSOR_PARAMS],
};

const FPC_CONSTRUCTOR_ABI_V2: FunctionAbi = {
  ...FPC_CONSTRUCTOR_ABI_BASE,
  parameters: [...OPERATOR_PARAMS],
};

const FPC_CONSTRUCTOR_ABI_LEGACY: FunctionAbi = {
  ...FPC_CONSTRUCTOR_ABI_BASE,
  parameters: [
    ...OPERATOR_PARAMS,
    { name: "accepted_asset", type: AZTEC_ADDRESS_TYPE, visibility: "private" },
  ],
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
  sponsorPubkeyX?: Fr;
  sponsorPubkeyY?: Fr;
}

export async function computeExpectedFpcInitializationHash(
  inputs: Pick<
    FpcImmutableInputs,
    "operatorAddress" | "operatorPubkeyX" | "operatorPubkeyY" | "sponsorPubkeyX" | "sponsorPubkeyY"
  >,
): Promise<Fr> {
  if (inputs.sponsorPubkeyX && inputs.sponsorPubkeyY) {
    return await computeInitializationHash(FPC_CONSTRUCTOR_ABI_V3, [
      inputs.operatorAddress,
      inputs.operatorPubkeyX,
      inputs.operatorPubkeyY,
      inputs.sponsorPubkeyX,
      inputs.sponsorPubkeyY,
    ]);
  }
  return await computeInitializationHash(FPC_CONSTRUCTOR_ABI_V2, [
    inputs.operatorAddress,
    inputs.operatorPubkeyX,
    inputs.operatorPubkeyY,
  ]);
}

async function computeExpectedLegacyFpcInitializationHash(
  inputs: Pick<
    FpcImmutableInputs,
    "acceptedAsset" | "operatorAddress" | "operatorPubkeyX" | "operatorPubkeyY"
  >,
): Promise<Fr> {
  return await computeInitializationHash(FPC_CONSTRUCTOR_ABI_LEGACY, [
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

  const expectedInitializationHash = await computeExpectedFpcInitializationHash(inputs);
  const expectedLegacyInitializationHash = await computeExpectedLegacyFpcInitializationHash(inputs);
  const onChainInitializationHash = deployed.initializationHash;

  const expectedV2NoSponsorHash =
    inputs.sponsorPubkeyX && inputs.sponsorPubkeyY
      ? await computeInitializationHash(FPC_CONSTRUCTOR_ABI_V2, [
          inputs.operatorAddress,
          inputs.operatorPubkeyX,
          inputs.operatorPubkeyY,
        ])
      : undefined;

  if (
    !onChainInitializationHash.equals(expectedInitializationHash) &&
    !onChainInitializationHash.equals(expectedLegacyInitializationHash) &&
    !(
      expectedV2NoSponsorHash &&
      onChainInitializationHash.equals(expectedV2NoSponsorHash)
    )
  ) {
    const currentClassId = deployed.currentContractClassId?.toString() ?? "unknown";
    const originalClassId = deployed.originalContractClassId?.toString() ?? "unknown";
    throw new FpcImmutableVerificationError(
      "IMMUTABLE_MISMATCH",
      `[startup] on-chain FPC immutable mismatch: expected operator=${inputs.operatorAddress.toString()} (pubkey_x=${inputs.operatorPubkeyX.toString()}, pubkey_y=${inputs.operatorPubkeyY.toString()}) for contract ${inputs.fpcAddress.toString()}, but deployment initialization_hash differs (expected_v2=${expectedInitializationHash.toString()}, expected_legacy=${expectedLegacyInitializationHash.toString()}, on_chain=${onChainInitializationHash.toString()}, current_class_id=${currentClassId}, original_class_id=${originalClassId})`,
    );
  }
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode } from "@aztec/aztec.js/node";
import {
  computeExpectedFpcInitializationHash,
  FpcImmutableVerificationError,
  verifyFpcImmutablesOnStartup,
} from "../src/fpc-immutables.js";

const TEST_FPC_ADDRESS = AztecAddress.fromString(
  "0x27e0f62fe6edf34f850dd7c1cc7cd638f7ec38ed3eb5ae4bd8c0c941c78e67ac",
);
const TEST_ACCEPTED_ASSET = AztecAddress.fromString(
  "0x0000000000000000000000000000000000000000000000000000000000000002",
);
const TEST_OPERATOR = AztecAddress.fromString(
  "0x089323ce9a610e9f013b661ce80dde444b554e9f6ed9f5167adb234668f0af72",
);
const TEST_OPERATOR_PUBKEY_X = Fr.fromString(
  "0x0896d0dbea3a3e52aff21c683f7053b1372bb4994d2f98a5616aba4fe82599ce",
);
const TEST_OPERATOR_PUBKEY_Y = Fr.fromString(
  "0x11a52a7b2c2204b54279a2a2d2620b0270265874efeda28b747f92ecb4f74aff",
);

function mockNodeWithInitializationHash(
  initializationHash: Fr | undefined,
): Pick<AztecNode, "getContract"> {
  return {
    getContract: async () => {
      if (!initializationHash) {
        return undefined;
      }

      return {
        initializationHash,
        currentContractClassId: Fr.fromString("0x02"),
        originalContractClassId: Fr.fromString("0x02"),
      } as Awaited<ReturnType<AztecNode["getContract"]>>;
    },
  };
}

function mockNodeGetContractThrows(
  message: string,
): Pick<AztecNode, "getContract"> {
  return {
    getContract: async () => {
      throw new Error(message);
    },
  };
}

describe("fpc immutable startup verification", () => {
  it("passes when on-chain immutables match expected config and signer", async () => {
    const expectedHash = await computeExpectedFpcInitializationHash({
      acceptedAsset: TEST_ACCEPTED_ASSET,
      operatorAddress: TEST_OPERATOR,
      operatorPubkeyX: TEST_OPERATOR_PUBKEY_X,
      operatorPubkeyY: TEST_OPERATOR_PUBKEY_Y,
    });
    const node = mockNodeWithInitializationHash(expectedHash);

    await verifyFpcImmutablesOnStartup(node, {
      fpcAddress: TEST_FPC_ADDRESS,
      acceptedAsset: TEST_ACCEPTED_ASSET,
      operatorAddress: TEST_OPERATOR,
      operatorPubkeyX: TEST_OPERATOR_PUBKEY_X,
      operatorPubkeyY: TEST_OPERATOR_PUBKEY_Y,
    });
  });

  it("fails when no contract exists at configured FPC address", async () => {
    const node = mockNodeWithInitializationHash(undefined);

    await assert.rejects(
      verifyFpcImmutablesOnStartup(node, {
        fpcAddress: TEST_FPC_ADDRESS,
        acceptedAsset: TEST_ACCEPTED_ASSET,
        operatorAddress: TEST_OPERATOR,
        operatorPubkeyX: TEST_OPERATOR_PUBKEY_X,
        operatorPubkeyY: TEST_OPERATOR_PUBKEY_Y,
      }),
      (error: unknown) => {
        assert.equal(error instanceof FpcImmutableVerificationError, true);
        if (!(error instanceof FpcImmutableVerificationError)) {
          return false;
        }
        assert.equal(error.reason, "CONTRACT_NOT_FOUND");
        assert.match(error.message, /contract not found/);
        return true;
      },
    );
  });

  it("fails when contract query itself fails", async () => {
    const node = mockNodeGetContractThrows("rpc unavailable");

    await assert.rejects(
      verifyFpcImmutablesOnStartup(node, {
        fpcAddress: TEST_FPC_ADDRESS,
        acceptedAsset: TEST_ACCEPTED_ASSET,
        operatorAddress: TEST_OPERATOR,
        operatorPubkeyX: TEST_OPERATOR_PUBKEY_X,
        operatorPubkeyY: TEST_OPERATOR_PUBKEY_Y,
      }),
      (error: unknown) => {
        assert.equal(error instanceof FpcImmutableVerificationError, true);
        if (!(error instanceof FpcImmutableVerificationError)) {
          return false;
        }
        assert.equal(error.reason, "CONTRACT_QUERY_FAILED");
        assert.match(error.message, /could not query contract/);
        assert.match(error.message, /rpc unavailable/);
        return true;
      },
    );
  });

  it("fails when on-chain initialization hash mismatches expected immutables", async () => {
    const node = mockNodeWithInitializationHash(Fr.fromString("0x01"));

    await assert.rejects(
      verifyFpcImmutablesOnStartup(node, {
        fpcAddress: TEST_FPC_ADDRESS,
        acceptedAsset: TEST_ACCEPTED_ASSET,
        operatorAddress: TEST_OPERATOR,
        operatorPubkeyX: TEST_OPERATOR_PUBKEY_X,
        operatorPubkeyY: TEST_OPERATOR_PUBKEY_Y,
      }),
      (error: unknown) => {
        assert.equal(error instanceof FpcImmutableVerificationError, true);
        if (!(error instanceof FpcImmutableVerificationError)) {
          return false;
        }
        assert.equal(error.reason, "IMMUTABLE_MISMATCH");
        assert.match(error.message, /accepted_asset=/);
        assert.match(error.message, /operator=/);
        assert.match(error.message, /initialization_hash/);
        assert.match(error.message, /current_class_id=/);
        return true;
      },
    );
  });
});

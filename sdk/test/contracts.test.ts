import type { ContractArtifact } from "@aztec/aztec.js/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  connectAndAttachContracts,
  resolveFpcAddress,
  resolveRuntimeAddresses,
} from "../src/internal/contracts";
import { SponsoredTxFailedError } from "../src/errors";
import type { SponsoredRuntimeConfig } from "../src/types";

const { contractAtMock, getContractMock, waitForNodeMock } = vi.hoisted(() => ({
  contractAtMock: vi.fn(
    (address: AztecAddress, artifact: ContractArtifact) => ({
      address,
      artifact,
    }),
  ),
  getContractMock: vi.fn(async () => ({ mocked: true })),
  waitForNodeMock: vi.fn(async () => undefined),
}));

vi.mock("@aztec/aztec.js/node", () => ({
  createAztecNodeClient: vi.fn(() => ({
    getContract: getContractMock,
  })),
  waitForNode: waitForNodeMock,
}));

vi.mock("@aztec/aztec.js/contracts", () => ({
  Contract: {
    at: contractAtMock,
  },
}));

const USER =
  "0x21ebdcefd5de2700314f50cbf3fb67b988cb0ed3e0f3e9e0726f1f2e7f58b6a1";
const TOKEN =
  "0x0000000000000000000000000000000000000000000000000000000000000011";
const FPC_EXPLICIT =
  "0x0000000000000000000000000000000000000000000000000000000000000012";
const FPC_DISCOVERY =
  "0x0000000000000000000000000000000000000000000000000000000000000013";
const OPERATOR =
  "0x0000000000000000000000000000000000000000000000000000000000000014";
const FAUCET =
  "0x0000000000000000000000000000000000000000000000000000000000000015";
const TARGET =
  "0x0000000000000000000000000000000000000000000000000000000000000016";

function runtimeConfig(overrides: Partial<SponsoredRuntimeConfig> = {}): SponsoredRuntimeConfig {
  return {
    acceptedAsset: {
      address: TOKEN,
      artifact: { name: "token-artifact" } as ContractArtifact,
    },
    faucet: {
      address: FAUCET,
      artifact: { name: "faucet-artifact" } as ContractArtifact,
    },
    fpc: {
      address: FPC_EXPLICIT,
      artifact: { name: "fpc-artifact" } as ContractArtifact,
    },
    nodeUrl: "http://node.example:8080",
    operatorAddress: OPERATOR,
    targets: {
      custom: {
        address: TARGET,
        artifact: { name: "custom-artifact" } as ContractArtifact,
      },
    },
    ...overrides,
  };
}

describe("runtime address resolution", () => {
  it("uses caller-provided runtime addresses without forcing SDK defaults", () => {
    const out = resolveRuntimeAddresses({
      account: USER,
      runtimeConfig: runtimeConfig(),
    });

    expect(out.user.toString()).toBe(USER);
    expect(out.acceptedAsset.toString()).toBe(TOKEN);
    expect(out.fpc.toString()).toBe(FPC_EXPLICIT);
    expect(out.operator.toString()).toBe(OPERATOR);
    expect(out.faucet?.toString()).toBe(FAUCET);
    expect(out.targets.custom?.toString()).toBe(TARGET);
  });

  it("uses discovery fpc address when explicit fpc address is absent", () => {
    const out = resolveRuntimeAddresses({
      account: USER,
      discoveryFpcAddress: FPC_DISCOVERY,
      runtimeConfig: runtimeConfig({ fpc: { artifact: { name: "fpc" } as ContractArtifact } }),
    });

    expect(out.fpc.toString()).toBe(FPC_DISCOVERY);
  });

  it("throws on explicit/discovery fpc mismatch", () => {
    expect(() =>
      resolveFpcAddress({
        discoveryFpcAddress: FPC_DISCOVERY,
        explicitFpcAddress: FPC_EXPLICIT,
      }),
    ).toThrow(SponsoredTxFailedError);
  });
});

describe("contract attachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getContractMock.mockResolvedValue({ mocked: true });
  });

  it("attaches contracts using runtime-provided artifacts", async () => {
    const wallet = {
      registerContract: vi.fn(async () => undefined),
    };

    await connectAndAttachContracts({
      account: USER,
      runtimeConfig: runtimeConfig(),
      wallet: wallet as never,
    });

    expect(waitForNodeMock).toHaveBeenCalledTimes(1);
    expect(wallet.registerContract).toHaveBeenCalledTimes(4);
    expect(contractAtMock).toHaveBeenCalledWith(
      AztecAddress.fromString(TOKEN),
      expect.objectContaining({ name: "token-artifact" }),
      wallet,
    );
    expect(contractAtMock).toHaveBeenCalledWith(
      AztecAddress.fromString(FPC_EXPLICIT),
      expect.objectContaining({ name: "fpc-artifact" }),
      wallet,
    );
    expect(contractAtMock).toHaveBeenCalledWith(
      AztecAddress.fromString(FAUCET),
      expect.objectContaining({ name: "faucet-artifact" }),
      wallet,
    );
    expect(contractAtMock).toHaveBeenCalledWith(
      AztecAddress.fromString(TARGET),
      expect.objectContaining({ name: "custom-artifact" }),
      wallet,
    );
  });

  it("throws when fpc address is absent in runtime and discovery", async () => {
    await expect(
      connectAndAttachContracts({
        account: USER,
        runtimeConfig: runtimeConfig({
          fpc: { artifact: { name: "fpc-artifact" } as ContractArtifact },
        }),
        wallet: {
          registerContract: vi.fn(async () => undefined),
        } as never,
      }),
    ).rejects.toBeInstanceOf(SponsoredTxFailedError);
  });
});

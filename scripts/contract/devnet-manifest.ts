import { validateDevnetDeployManifest } from "@aztec-fpc/contract-deployment/src/devnet-manifest.ts";
import pino from "pino";

export {
  type DevnetDeployManifest,
  validateDevnetDeployManifest,
} from "@aztec-fpc/contract-deployment/src/devnet-manifest.ts";

const pinoLogger = pino();

function buildSelfCheckFixture() {
  return {
    status: "deploy_ok",
    generated_at: "2026-03-02T00:00:00.000Z",
    network: {
      node_url: "https://v4-devnet-2.aztec-labs.com/",
      node_version: "4.0.0-devnet.2-patch.3",
      l1_chain_id: 11155111,
      rollup_version: 615022430,
    },
    aztec_required_addresses: {
      l1_contract_addresses: {
        registryAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        rollupAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        inboxAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
        outboxAddress: "0xdddddddddddddddddddddddddddddddddddddddd",
        feeJuiceAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        feeJuicePortalAddress: "0xffffffffffffffffffffffffffffffffffffffff",
        feeAssetHandlerAddress: "0x1111111111111111111111111111111111111111",
      },
      protocol_contract_addresses: {
        instanceRegistry: "0x0000000000000000000000000000000000000000000000000000000000000002",
        classRegistry: "0x0000000000000000000000000000000000000000000000000000000000000003",
        multiCallEntrypoint: "0x0000000000000000000000000000000000000000000000000000000000000004",
        feeJuice: "0x0000000000000000000000000000000000000000000000000000000000000005",
      },
      sponsored_fpc_address: "0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2",
    },
    deployment_accounts: {
      l2_deployer: {
        alias: "my-wallet",
        address: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        private_key_ref: "secret-manager://devnet/l2-deployer",
      },
    },
    contracts: {
      accepted_asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      fpc: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      counter: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    },
    fpc_artifact: {
      name: "FPCMultiAsset",
      path: "./target/fpc-FPCMultiAsset.json",
    },
    operator: {
      address: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      pubkey_x: "123456789",
      pubkey_y: "987654321",
    },
    tx_hashes: {
      accepted_asset_deploy: "0x1111111111111111111111111111111111111111111111111111111111111111",
      fpc_deploy: "0x2222222222222222222222222222222222222222222222222222222222222222",
      counter_deploy: "0x3333333333333333333333333333333333333333333333333333333333333333",
    },
    payment_mode: "fpc-sponsored",
  };
}

function expectThrow(description: string, fn: () => void): void {
  let didThrow = false;
  try {
    fn();
  } catch {
    didThrow = true;
  }
  if (!didThrow) {
    throw new Error(`Self-check expected failure did not occur: ${description}`);
  }
}

function runSelfCheck(): void {
  const validFixture = buildSelfCheckFixture();
  const validated = validateDevnetDeployManifest(validFixture);

  if (validated.contracts.fpc !== validFixture.contracts.fpc) {
    throw new Error("Self-check failed: contracts.fpc mismatch");
  }

  expectThrow("missing contracts.fpc", () => {
    const broken = buildSelfCheckFixture() as unknown as Record<string, unknown>;
    const contracts = broken.contracts as Record<string, unknown>;
    delete contracts.fpc;
    validateDevnetDeployManifest(broken);
  });

  expectThrow("l2_deployer missing private_key/private_key_ref", () => {
    const broken = buildSelfCheckFixture() as unknown as Record<string, unknown>;
    const deploymentAccounts = broken.deployment_accounts as Record<string, unknown>;
    const l2Deployer = deploymentAccounts.l2_deployer as Record<string, unknown>;
    delete l2Deployer.private_key;
    delete l2Deployer.private_key_ref;
    validateDevnetDeployManifest(broken);
  });

  pinoLogger.info("[devnet-manifest] self-check passed");
}

function usage(): string {
  return [
    "Usage:",
    "  bunx tsx scripts/contract/devnet-manifest.ts --self-check",
    "",
    "Exports (re-exported from @aztec-fpc/contract-deployment):",
    "  - validateDevnetDeployManifest(input)",
    "  - DevnetDeployManifest (type)",
  ].join("\n");
}

function main(argv: string[]): void {
  if (argv.includes("--self-check")) {
    runSelfCheck();
    return;
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    pinoLogger.info(usage());
    return;
  }

  pinoLogger.error('No command provided. Use "--self-check" to run validator sanity checks.');
  pinoLogger.error(usage());
  process.exit(1);
}

main(process.argv.slice(2));

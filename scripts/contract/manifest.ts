import { validateDeployManifest } from "@aztec-fpc/contract-deployment/src/manifest.ts";
import pino from "pino";

export {
  type DeployManifest,
  readDeployManifest,
  validateDeployManifest,
} from "@aztec-fpc/contract-deployment/src/manifest.ts";

const pinoLogger = pino();

function buildSelfCheckFixture() {
  return {
    status: "deploy_ok",
    generated_at: "2026-03-02T00:00:00.000Z",
    network: {
      node_url: "https://v4-devnet-2.aztec-labs.com/",
      node_version: "4.1.0-nightly.20260312.2",
      l1_chain_id: 11155111,
      rollup_version: 615022430,
    },
    aztec_required_addresses: {
      sponsored_fpc_address: "0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2",
    },
    deployer_address: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    contracts: {
      fpc: "0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b",
    },
    operator: {
      address: "0x0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d",
      pubkey_x: "123456789",
      pubkey_y: "987654321",
    },
    tx_hashes: {
      fpc_deploy: "0x2222222222222222222222222222222222222222222222222222222222222222",
    },
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
  const validated = validateDeployManifest(validFixture);

  if (validated.contracts.fpc.toString() !== validFixture.contracts.fpc) {
    throw new Error("Self-check failed: contracts.fpc mismatch");
  }

  expectThrow("missing contracts.fpc", () => {
    const broken = buildSelfCheckFixture() as unknown as Record<string, unknown>;
    const contracts = broken.contracts as Record<string, unknown>;
    delete contracts.fpc;
    validateDeployManifest(broken);
  });

  pinoLogger.info("[manifest] self-check passed");
}

function usage(): string {
  return [
    "Usage:",
    "  bunx tsx scripts/contract/manifest.ts --self-check",
    "",
    "Exports (re-exported from @aztec-fpc/contract-deployment):",
    "  - validateDeployManifest(input)",
    "  - readDeployManifest(filePath)",
    "  - DeployManifest (type)",
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

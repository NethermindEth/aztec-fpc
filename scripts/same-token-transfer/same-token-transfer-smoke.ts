/**
 * Same-token-transfer E2E smoke test entrypoint.
 *
 * Exercises the full lifecycle: faucet drip -> shield -> FPC transfer.
 * A brand-new user gets tokens from the faucet (public), shields them
 * (private), then uses the real FPC for fee payment — no L1 bridging needed.
 *
 * Assumes contracts are already deployed.
 *
 * CLI arguments are the same as cold-start-smoke (parsed by ./cli.ts).
 */

import pino from "pino";
import { CliError, parseCliArgs, usage } from "./cli.ts";
import { setup } from "./setup.ts";
import { testSameTokenTransfer } from "./test-same-token-transfer.ts";

const pinoLogger = pino();

async function main() {
  const result = parseCliArgs(process.argv.slice(2));
  if (result.kind === "help") return;

  const ctx = await setup(result.args);
  await testSameTokenTransfer(ctx);

  pinoLogger.info("[same-token-transfer] PASS: same-token-transfer E2E smoke test succeeded");
  process.exit(0);
}

main().catch((error) => {
  if (error instanceof CliError) {
    pinoLogger.error(`[same-token-transfer] ERROR: ${error.message}`);
    pinoLogger.error("");
    pinoLogger.error(usage());
  } else {
    pinoLogger.error(
      `[same-token-transfer] Unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
  process.exit(1);
});

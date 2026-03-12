/**
 * Always-revert E2E smoke test entrypoint.
 *
 * Exercises the FPC fee payment mechanism when app logic reverts.
 * A brand-new user gets tokens from the faucet (public), shields them
 * (private), then calls always_revert() via FPC — verifying that fees
 * are still collected even when app logic fails.
 *
 * Assumes contracts are already deployed (handled by always-revert-smoke.sh).
 *
 * CLI arguments are the same as same-token-transfer (parsed by ./cli.ts),
 * with an additional --iterations flag.
 */

import pino from "pino";
import { CliError, parseCliArgs, usage } from "./cli.ts";
import { setup } from "./setup.ts";
import { testAlwaysRevert } from "./test-always-revert.ts";

const pinoLogger = pino();

async function main() {
  const result = parseCliArgs(process.argv.slice(2));
  if (result.kind === "help") return;

  const ctx = await setup(result.args);
  await testAlwaysRevert(ctx);

  pinoLogger.info("[always-revert] PASS: always-revert E2E smoke test succeeded");
  process.exit(0);
}

main().catch((error) => {
  if (error instanceof CliError) {
    pinoLogger.error(`[always-revert] ERROR: ${error.message}`);
    pinoLogger.error("");
    pinoLogger.error(usage());
  } else {
    pinoLogger.error(
      `[always-revert] Unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
  process.exit(1);
});

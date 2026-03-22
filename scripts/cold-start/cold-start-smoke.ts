/**
 * Cold-start entrypoint E2E smoke test.
 *
 * Exercises the full cold_start_entrypoint flow: a user claims bridged tokens
 * and pays gas in a single transaction without going through an account
 * entrypoint (msg_sender = None).
 *
 * Assumes contracts are already deployed.
 *
 * All arguments are optional. CLI args take precedence over env vars.
 *
 *   --node-url <url>                 Aztec node URL [env: AZTEC_NODE_URL] (default: http://localhost:8080)
 *   --l1-rpc-url <url>               L1 RPC URL (required) [env: L1_RPC_URL]
 *   --attestation-url <url>          Attestation server base URL (required) [env: FPC_ATTESTATION_URL]
 *   --manifest <path>                Deployment manifest path (required) [env: FPC_COLD_START_MANIFEST]
 *   --operator-secret-key <hex32>    Operator secret key (required) [env: FPC_OPERATOR_SECRET_KEY]
 *   --l1-deployer-key <hex32>        L1 deployer private key (ERC20 owner, for minting) [env: FPC_L1_DEPLOYER_KEY]
 *   --claim-amount <uint>            Claim amount (default: 10000000000000) [env: FPC_COLD_START_CLAIM_AMOUNT]
 *   --aa-payment-amount <uint>       AA payment amount (default: 1000000000) [env: FPC_COLD_START_AA_PAYMENT_AMOUNT]
 *   --quote-ttl-seconds <uint>       Quote TTL in seconds (default: 3600) [env: FPC_SMOKE_QUOTE_TTL_SECONDS]
 *   --message-timeout <uint>         L1→L2 message wait timeout seconds (default: 120) [env: FPC_SMOKE_MESSAGE_TIMEOUT_SECONDS]
 *   --help, -h                       Show this help
 */

import pino from "pino";
import { CliError, parseCliArgs, usage } from "./cli.ts";
import { setup } from "./setup.ts";
import { testHappyPath } from "./test-happy-path.ts";
import { testInsufficientClaim } from "./test-insufficient-claim.ts";

const pinoLogger = pino();

async function main() {
  const result = parseCliArgs(process.argv.slice(2));
  if (result.kind === "help") return;

  const ctx = await setup(result.args);
  await testHappyPath(ctx);
  await testInsufficientClaim(ctx);

  pinoLogger.info("[cold-start-smoke] PASS: cold_start_entrypoint E2E smoke test succeeded");
  process.exit(0);
}

main().catch((error) => {
  if (error instanceof CliError) {
    pinoLogger.error(`[cold-start-smoke] ERROR: ${error.message}`);
    pinoLogger.error("");
    pinoLogger.error(usage());
  } else {
    pinoLogger.error(
      `[cold-start-smoke] Unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
  process.exit(1);
});

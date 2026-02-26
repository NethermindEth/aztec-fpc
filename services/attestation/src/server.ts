import { AztecAddress } from "@aztec/aztec.js/addresses";
import Fastify from "fastify";
import type { Config } from "./config.js";
import { computeFinalRate } from "./config.js";
import type { QuoteSchnorrSigner } from "./signer.js";
import { signQuote } from "./signer.js";

function badRequest(message: string) {
  return { error: { code: "BAD_REQUEST", message } };
}

export interface QuoteClock {
  nowUnixSeconds?: () => Promise<bigint> | bigint;
}

export function buildServer(
  config: Config,
  quoteSigner: QuoteSchnorrSigner,
  clock: QuoteClock = {},
) {
  const app = Fastify({ logger: true });
  const fpcAddress = AztecAddress.fromString(config.fpc_address);
  const acceptedAsset = AztecAddress.fromString(config.accepted_asset_address);

  const nowUnixSeconds =
    clock.nowUnixSeconds ?? (() => BigInt(Math.floor(Date.now() / 1000)));

  async function validUntil(): Promise<bigint> {
    return (
      BigInt(await nowUnixSeconds()) + BigInt(config.quote_validity_seconds)
    );
  }

  // ── GET /health ─────────────────────────────────────────────────────────────

  app.get("/health", async () => ({ status: "ok" }));

  // ── GET /asset ───────────────────────────────────────────────────────────────

  app.get("/asset", async () => ({
    name: config.accepted_asset_name,
    address: config.accepted_asset_address,
  }));

  // ── GET /quote?user=<address> ─────────────────────────────────────────────

  app.get<{ Querystring: { user?: string } }>("/quote", async (req, reply) => {
    const userAddress = req.query.user?.trim();
    if (!userAddress) {
      return reply
        .code(400)
        .send(badRequest("Missing required query param: user"));
    }
    let parsedUserAddress: AztecAddress;
    try {
      parsedUserAddress = AztecAddress.fromString(userAddress);
    } catch {
      return reply.code(400).send(badRequest("Invalid user address"));
    }

    try {
      const { rate_num, rate_den } = computeFinalRate(config);
      const expiry = await validUntil();

      const signature = await signQuote(quoteSigner, {
        fpcAddress,
        acceptedAsset,
        rateNum: rate_num,
        rateDen: rate_den,
        validUntil: expiry,
        userAddress: parsedUserAddress,
      });

      req.log.info(
        {
          event: "quote_issued",
          user: parsedUserAddress.toString(),
          valid_until: expiry.toString(),
          rate_num: rate_num.toString(),
          rate_den: rate_den.toString(),
        },
        "Quote issued",
      );

      return {
        accepted_asset: config.accepted_asset_address,
        rate_num: rate_num.toString(),
        rate_den: rate_den.toString(),
        valid_until: expiry.toString(),
        signature,
      };
    } catch (error) {
      req.log.error(
        {
          err: error,
          user: parsedUserAddress.toString(),
        },
        "Failed to issue quote",
      );
      return reply.code(500).send({
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error",
        },
      });
    }
  });

  return app;
}

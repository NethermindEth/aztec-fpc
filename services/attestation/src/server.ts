import Fastify from 'fastify';
import { AztecAddress } from '@aztec/aztec.js';
import type { AccountWallet } from '@aztec/aztec.js';
import type { Config } from './config.js';
import { computeFinalRate } from './config.js';
import { signQuote } from './signer.js';

export function buildServer(config: Config, wallet: AccountWallet) {
  const app = Fastify({ logger: true });
  const fpcAddress = AztecAddress.fromString(config.fpc_address);
  const acceptedAsset = AztecAddress.fromString(config.accepted_asset_address);

  function validUntil(): bigint {
    return BigInt(Math.floor(Date.now() / 1000) + config.quote_validity_seconds);
  }

  // ── GET /health ─────────────────────────────────────────────────────────────

  app.get('/health', async () => ({ status: 'ok' }));

  // ── GET /asset ───────────────────────────────────────────────────────────────
  // Returns the single accepted asset name and address.

  app.get('/asset', async () => ({
    name: config.accepted_asset_name,
    address: config.accepted_asset_address,
  }));

  // ── GET /quote?user=<address> ─────────────────────────────────────────────
  // Returns a user-specific (confidential) quote for the given user address.
  // The quote binds to `user` — the operator signs acknowledging it knows this
  // user's address and will track private note receipts via their viewing key.

  app.get<{ Querystring: { user: string } }>('/quote', async (req, reply) => {
    const { user: userAddress } = req.query;
    if (!userAddress) {
      return reply.code(400).send({ error: 'Missing required query param: user' });
    }

    const { rate_num, rate_den } = computeFinalRate(config);
    const expiry = validUntil();

    const authwit = await signQuote(wallet, {
      fpcAddress,
      acceptedAsset,
      rateNum: rate_num,
      rateDen: rate_den,
      validUntil: expiry,
      userAddress: AztecAddress.fromString(userAddress),
    });

    return {
      accepted_asset: config.accepted_asset_address,
      rate_num: rate_num.toString(),
      rate_den: rate_den.toString(),
      valid_until: expiry.toString(),
      authwit,
    };
  });

  return app;
}

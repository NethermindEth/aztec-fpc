# Run an FPC Operator

Production deployment of the FPC operator stack: keys, services, reverse proxy, monitoring.

> [!WARNING]
> Production guide. For local development, see [Quick Start](../quick-start.md).

> [!NOTE]
> Wallet teams typically run their own FPC as both operator and integrator. If that's you, this guide and [Integrate in a Wallet](./integrate-wallet.md) together cover your full deployment.

## Prerequisites

- An Aztec node you control or trust
- L1 RPC endpoint (Ethereum mainnet for production)
- KMS or HSM for key management
- Monitoring stack (Prometheus, Grafana)
- Domain with HTTPS for the attestation service

## Steps

### 1. Generate operator keys

The FPC contract stores the operator's Schnorr public key as `PublicImmutable`. There is no on-chain key rotation. Compromise = redeploy.

Generate the keypair in your KMS. Record the public key (X, Y coordinates) for deployment. The private key never leaves the KMS.

### 2. Set up the L1 operator account

Fund an L1 account with ETH (L1 transaction fees) and the Fee Juice ERC-20 (the token bridged to L2). Store the L1 key in your KMS.

> [!TIP]
> Budget for ~10x expected daily bridge transactions to handle spikes and L1 fee volatility.

### 3. Deploy the FPC

```bash
export FPC_DEPLOYER_SECRET_KEY=0x<deployer_hex32>
export FPC_OPERATOR_SECRET_KEY=0x<operator_hex32>

docker run \
  -e AZTEC_NODE_URL=https://your-aztec-node.com \
  -e FPC_DEPLOYER_SECRET_KEY \
  -e FPC_OPERATOR_SECRET_KEY \
  -v ./deployments:/app/deployments \
  nethermind/aztec-fpc-contract-deployment:local
```

Writes `deployments/manifest.json` (treat as secret). If `fpc-config.yaml` exists in `deployments/`, per-service configs are auto-generated.

### 4. Configure the attestation service

```yaml title="attestation-config.yaml"
runtime_profile: production         # Rejects plaintext config secrets, requires auth
network_id: "aztec-testnet"         # String identifier
fpc_address: "0x..."                # From deployment manifest
contract_variant: "fpc-v1"
aztec_node_url: "https://your-aztec-node.com"

operator_secret_provider: kms       # Production: never plaintext

quote_validity_seconds: 300
quote_auth_mode: api_key            # "disabled" rejected when production
# QUOTE_AUTH_API_KEY supplied via env var

quote_rate_limit_enabled: true
quote_rate_limit_max_requests: 60
quote_rate_limit_window_seconds: 60

quote_base_url: "https://fpc.example.com"   # Public URL when behind reverse proxy
pxe_data_directory: "/var/fpc/attestation-pxe"
asset_policy_state_path: "/var/fpc/attestation-data"

supported_assets:
  - { address: "0x...", name: "humanUSDC", market_rate_num: 1, market_rate_den: 1000, fee_bips: 200 }
```

If `quote_base_url` is unset and you're behind a reverse proxy, `/.well-known/fpc.json` will derive its URL from request headers, which may be wrong.

### 5. Configure the top-up service

```yaml title="topup-config.yaml"
runtime_profile: production
fpc_address: "0x..."
aztec_node_url: "https://your-aztec-node.com"
l1_rpc_url: "https://mainnet.infura.io/v3/..."

threshold: "1000000000000000000"           # Bridge when below this (Fee Juice base units, 18 decimals)
top_up_amount: "5000000000000000000"        # Amount per bridge (Fee Juice base units, 18 decimals)

data_dir: "/var/fpc/topup-data"             # LMDB for in-flight bridge state
check_interval_ms: 60000
confirmation_timeout_ms: 180000

l1_operator_secret_provider: kms
```

Auto-claim is enabled by default. In production, set `TOPUP_AUTOCLAIM_SECRET_KEY` to an explicit L2 claimer key. Use `TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS` to pay claim-tx fees via a sponsored FPC.

### 6. Reverse proxy with HTTPS

```nginx
server {
  listen 443 ssl http2;
  server_name fpc.example.com;

  ssl_certificate     /etc/letsencrypt/live/fpc.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/fpc.example.com/privkey.pem;

  location / {
    proxy_pass http://localhost:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }

  location /admin/ {
    allow 10.0.0.0/8;        # Internal network only
    deny all;
    proxy_pass http://localhost:3000;
  }
}
```

### 7. Register supported assets

See [Add a Supported Asset](./add-supported-asset.md) for full details.

```bash
curl -X PUT https://fpc.example.com/admin/asset-policies/0xTOKEN \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "humanUSDC", "market_rate_num": 1, "market_rate_den": 1000, "fee_bips": 200}'
```

Admin endpoints are disabled unless `ADMIN_API_KEY` is set.

### 8. Monitoring

Scrape `/metrics` on both services with Prometheus. See [Metrics](../reference/metrics.md) for the full list.

Key signals to track:

- **Attestation:** `attestation_quote_requests_total{outcome}` (success/bad_request/unauthorized/rate_limited/internal_error), `attestation_quote_latency_seconds{outcome}`.
- **Top-up:** `topup_bridge_events_total{event}` (submitted/confirmed/timeout/aborted/failed), `topup_readiness_status` (1=ready, 0=not).

Critical alerts:

- `topup_readiness_status == 0` for > 5 minutes (FPC balance low)
- `rate(topup_bridge_events_total{event="failed"}[1h]) > 0`
- Quote error rate > 5%
- Health endpoint non-200

### 9. Verify

```bash
curl https://fpc.example.com/health
curl https://fpc.example.com/.well-known/fpc.json
curl https://fpc.example.com/accepted-assets

curl http://localhost:3001/health
curl http://localhost:3001/ready    # 200 = ready, 503 = not
curl http://localhost:3001/metrics

bun run smoke:services:compose
```

## Production Checklist

- [ ] Operator key in KMS or HSM
- [ ] `runtime_profile: production` on both services
- [ ] HTTPS with valid certificate
- [ ] `quote_base_url` set explicitly
- [ ] Admin endpoints restricted to internal network
- [ ] Rate limiting enabled
- [ ] Prometheus scraping both services
- [ ] Alerts configured
- [ ] LMDB data dirs backed up regularly
- [ ] L1 operator funded (ETH + Fee Juice ERC-20)
- [ ] `TOPUP_AUTOCLAIM_SECRET_KEY` set
- [ ] Smoke test passing

## Backups

Both services persist state in LMDB:
- Attestation: `asset_policy_state_path` (asset pricing).
- Top-up: `data_dir` (in-flight bridge metadata).

Loss of the top-up `data_dir` can leave bridges untracked. Daily backups minimum, verify restores.

## Next Steps

- [Add a Supported Asset](./add-supported-asset.md)
- [Deployment Reference](../operations/deployment.md)
- [Configuration Reference](../operations/configuration.md)
- [Metrics](../reference/metrics.md)
- [Security Model](../security.md)

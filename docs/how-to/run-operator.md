# Run an FPC Operator

This guide covers production deployment of the FPC operator stack: key management, service configuration, reverse proxy setup, and monitoring.

> [!WARNING]
> **Production guide**
>
> For local development, see [Quick Start](../quick-start.md) instead.

> [!NOTE]
> **Who runs their own FPC today**
>
> Wallet teams typically run their own FPC as both operator and integrator. If that is you, this guide and [Integrate in a Wallet](../how-to/integrate-wallet.md) together cover your full deployment.

## Prerequisites

- An Aztec node you control or trust
- An L1 RPC endpoint (Ethereum mainnet for production)
- KMS or HSM access for key management
- Monitoring stack (Prometheus, Grafana)
- A domain with HTTPS for the attestation service

## Steps

### Generate operator keys securely

Never generate production keys on a shared machine.

```bash
# Generate Schnorr keypair in your KMS
# Record the public key (X, Y coordinates) for deployment
# The private key never leaves the KMS
```

The FPC contract stores the operator's Schnorr public key as an immutable config. There is no on-chain key rotation. If the operator key is compromised, the contract must be redeployed.

### Set up the L1 operator account

Fund an L1 account with ETH (for L1 transaction fees) and Fee Juice tokens (the ERC-20 that gets bridged to L2). This key will be stored in the top-up service's KMS.

> [!TIP]
> **Sizing**
>
> Budget for roughly 10x expected daily bridge transactions to handle spikes and L1 fee volatility.

### Deploy the FPC contract

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

This deploys the `FPCMultiAsset` contract and writes a deployment manifest to `deployments/manifest.json`. Save this manifest. It contains the FPC address, operator details, and raw key material. Treat it as secret.

If a `fpc-config.yaml` file exists in the `deployments/` directory before deploying, the container auto-generates per-service configs (`attestation/config.yaml` and `topup/config.yaml`). See [Configuration](../operations/configuration.md) for the master config reference.

### Configure the attestation service

[Source: `services/attestation/src/config.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/config.ts#L499)

```yaml title="attestation-config.yaml"
runtime_profile: production     # Rejects plaintext config secrets, requires auth
network_id: "aztec-testnet"     # String identifier, not a number
fpc_address: "0x..."            # From deployment manifest
contract_variant: "fpc-v1"
aztec_node_url: "https://your-aztec-node.com"

# Key: KMS in production, never plaintext
operator_secret_provider: kms

quote_validity_seconds: 300
quote_auth_mode: api_key        # "disabled" is rejected when runtime_profile=production
# quote_auth_api_key: provide via QUOTE_AUTH_API_KEY env var

# Rate limiting: enable in all environments
quote_rate_limit_enabled: true
quote_rate_limit_max_requests: 60
quote_rate_limit_window_seconds: 60

# Public base URL when behind a reverse proxy (otherwise derived from request headers)
quote_base_url: "https://fpc.example.com"

# PXE data directory for operator note persistence
pxe_data_directory: "/var/fpc/attestation-pxe"

supported_assets:
  - address: "0x..."
    name: "humanUSDC"
    market_rate_num: 1
    market_rate_den: 1000
    fee_bips: 200

asset_policy_state_path: "/var/fpc/attestation-data"
```

> [!NOTE]
> If `quote_base_url` is not set and the service is behind a reverse proxy, the `/.well-known/fpc.json` response derives its base URL from request headers. This may not reflect the external hostname.

### Configure the top-up service

```yaml title="topup-config.yaml"
runtime_profile: production
fpc_address: "0x..."
aztec_node_url: "https://your-aztec-node.com"
l1_rpc_url: "https://mainnet.infura.io/v3/..."

threshold: "1000000000000000000"    # 1 Fee Juice (wei), bridge when below
top_up_amount: "5000000000000000000" # 5 Fee Juice (wei), amount bridged each time

data_dir: "/var/fpc/topup-data"     # LMDB for in-flight bridge state

check_interval_ms: 60000
confirmation_timeout_ms: 180000     # Max wait for L2 settlement after bridge tx

l1_operator_secret_provider: kms
```

Auto-claim is enabled by default (`TOPUP_AUTOCLAIM_ENABLED=1`). In production, set `TOPUP_AUTOCLAIM_SECRET_KEY` to an explicit L2 claimer key. The `development` profile falls back to the first `@aztec/accounts/testing` account.

Use `TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS` to pay the claim transaction's fees via a sponsored FPC (recommended, avoids needing Fee Juice on the claimer account).

### Deploy behind a reverse proxy

Use nginx, Caddy, or similar for HTTPS termination.

```nginx
server {
  listen 443 ssl http2;
  server_name fpc.example.com;

  ssl_certificate /etc/letsencrypt/live/fpc.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/fpc.example.com/privkey.pem;

  # Public quote endpoints
  location / {
    proxy_pass http://localhost:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }

  # Block admin endpoints from public access
  location /admin/ {
    allow 10.0.0.0/8;  # Internal network only
    deny all;
    proxy_pass http://localhost:3000;
  }
}
```

### Register supported assets

See [Add a Supported Asset](../how-to/add-supported-asset.md) for full details. All fields (`name`, `market_rate_num`, `market_rate_den`, `fee_bips`) are required on each PUT request.

```bash
curl -X PUT https://fpc.example.com/admin/asset-policies/0xTOKEN \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "humanUSDC", "market_rate_num": 1, "market_rate_den": 1000, "fee_bips": 200}'
```

Admin endpoints are disabled unless the `ADMIN_API_KEY` env var is set.

### Set up monitoring

Scrape the `/metrics` endpoints with Prometheus.

```yaml title="prometheus.yml"
scrape_configs:
  - job_name: 'fpc-attestation'
    static_configs:
      - targets: ['attestation:3000']
    metrics_path: /metrics

  - job_name: 'fpc-topup'
    static_configs:
      - targets: ['topup:3001']
    metrics_path: /metrics
```

Key metrics to track:

**Attestation service:**
- `attestation_quote_requests_total{outcome}` (counter): total `/quote` requests, grouped by `success`, `bad_request`, `unauthorized`, `rate_limited`, `internal_error`
- `attestation_quote_errors_total{error_type}` (counter): failed requests by error type
- `attestation_quote_latency_seconds{outcome}` (histogram): quote signing latency

**Top-up service:**
- `topup_bridge_events_total{event}` (counter): bridge lifecycle (`submitted`, `confirmed`, `timeout`, `aborted`, `failed`)
- `topup_balance_checks_total{outcome}` (counter): balance check results (`success`, `error`)
- `topup_readiness_status` (gauge): `1` = ready, `0` = not ready

### Set critical alerts

> [!CAUTION]
> **Must-have alerts**
>
> - **FPC balance low**: `topup_readiness_status == 0` for > 5 minutes
> - **Bridge failures**: `rate(topup_bridge_events_total{event="failed"}[1h]) > 0`
> - **High quote error rate**: error rate exceeds 5%
> - **Service down**: health endpoint returns non-200

### Verify the deployment

Health checks for both services:

```bash
# Attestation
curl http://localhost:3000/health
curl http://localhost:3000/.well-known/fpc.json
curl http://localhost:3000/accepted-assets

# Top-up
curl http://localhost:3001/health
curl http://localhost:3001/ready    # 200 = ready, 503 = not ready
curl http://localhost:3001/metrics
```

Run the post-deploy smoke test:

```bash
bun run smoke:services:compose
```

## Production Checklist

| Item | Status |
|------|--------|
| Operator key stored in KMS or HSM | |
| `runtime_profile: production` set on both services | |
| HTTPS with valid certificate | |
| `quote_base_url` set to external hostname | |
| Admin endpoints restricted to internal network | |
| Rate limiting enabled on quote endpoint | |
| Prometheus scraping both services | |
| Alerts configured for balance, bridge, service health | |
| Backup strategy for LMDB data dirs | |
| L1 operator account funded with ETH + Fee Juice tokens | |
| Auto-claim configured (`TOPUP_AUTOCLAIM_SECRET_KEY` set) | |
| Smoke test passing | |

## Backups

Both services persist state in LMDB directories. Back these up regularly:

- `asset_policy_state_path` (attestation): asset pricing policies
- `data_dir` (top-up): in-flight bridge metadata and crash recovery state

> [!TIP]
>
> Loss of the top-up `data_dir` can leave in-flight bridges untracked. At minimum, keep daily backups and verify restores.

## Next Steps

- [Add a Supported Asset](./add-supported-asset.md): register tokens after deployment
- [Deployment](../operations/deployment.md): Docker-based and bare-metal deployment workflows
- [Configuration Reference](../operations/configuration.md): all config keys and env vars
- [Metrics Reference](../reference/metrics.md): every Prometheus metric with labels and types
- [Security Model](../security.md): trust assumptions and threat matrix

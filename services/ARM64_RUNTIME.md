# ARM64 Runtime: Node.js fallback

Services use **Bun** on amd64 and **Node.js** on arm64.

## Why

Bun has an unresolved NAPI crash on ARM64 (`Segmentation fault at address 0x0` in
`NapiClass.cpp` during microtask queue draining). The crash occurs during ClientIVC
proof generation with both the native socket backend and the WASM backend, ruling out
barretenberg-specific causes. Upgrading Bun versions did not fix it.

## How it works

### Build target (`--target`)

Each service's `bun build` script reads `BUILD_TARGET` to select the bundle target:

```
--target=${BUILD_TARGET:-bun}
```

`Dockerfile.common` sets this per platform using conditional build stages:

```dockerfile
FROM build-src AS build-amd64
ENV BUILD_TARGET=bun          # Bun-optimised bundle

FROM build-src AS build-arm64
ENV BUILD_TARGET=node          # Node.js-compatible bundle
```

Docker only executes the stage matching `TARGETARCH`. The default (`bun`) is used
for local development outside Docker.

### Runtime image

The final image uses a platform-specific base:

| Platform | Base image              | JS runtime |
|----------|-------------------------|------------|
| amd64    | `oven/bun:1.3.11-slim`  | Bun        |
| arm64    | `node:24-trixie-slim`   | Node.js    |

A symlink `/usr/local/bin/entrypoint` points to whichever runtime is available.
Service Dockerfiles and healthchecks use `entrypoint` instead of `bun` or `node`
directly.

### `ordered-binary` must be external

When `bun build --target=node` bundles the `ordered-binary` package (used by
`@aztec/kv-store` for LMDB key encoding), the bundler transforms the code in a way
that breaks key deserialization at runtime — `readKey2` throws
`RangeError: Invalid array length`. This happens on **both** amd64 and arm64 when
running under Node.js.

Externalising `ordered-binary` (and `lmdb` which depends on it) via `--external`
keeps the original module code intact and resolves the issue. Both packages are listed
in `services/external-deps.json` so they're available at runtime.

### Shell entrypoints

`scripts/contract/deploy-fpc.sh` detects the runtime at startup:

```bash
if command -v bun &>/dev/null; then
  ENTRYPOINT=bun
else
  ENTRYPOINT=node
fi
```

## Removing this workaround

If Bun fixes the ARM64 NAPI crash, revert to a single `oven/bun` runtime image:

1. Remove the `build-amd64`/`build-arm64` conditional stages in `Dockerfile.common`
2. Remove the `runtime-amd64`/`runtime-arm64` stages and use `oven/bun` directly
3. Remove the `entrypoint` symlink; use `bun` directly in service Dockerfiles
4. Optionally remove `--external ordered-binary` and `--external lmdb` if no longer needed
5. Remove `ordered-binary` and `lmdb` from `services/external-deps.json`

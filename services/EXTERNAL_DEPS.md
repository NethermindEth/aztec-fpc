# External Dependencies

`external-deps.json` lists packages excluded from `bun build` via `--external` flags.

These packages can't be bundled because they need runtime filesystem access:

- **`@aztec/bb.js`** — loads `.wasm.gz` binaries and worker scripts via `__dirname`
- **`pino`** — spawns worker threads (`thread-stream`) that load transport modules dynamically
- **`pino-pretty`** — loaded by pino's worker thread via `require('pino-pretty')`

The Dockerfile copies this file as `package.json` into the `external-deps` stage to install
only these packages into the final image (instead of the full ~840 MB `node_modules`).

When adding a new `--external` flag to a service build script, add the package here too.

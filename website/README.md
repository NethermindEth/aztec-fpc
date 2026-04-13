# website

[Vocs](https://vocs.dev) documentation site for `aztec-fpc`.

## Develop

```bash
cd website
bun install
bunx vocs dev
```

## Build

```bash
bunx vocs build  # outputs to website/dist
```

## Layout

```
website/
├── docs/
│   ├── pages/      MDX content
│   ├── public/     logos, favicon
│   └── styles.css
├── info/           source-of-truth notes (not built)
└── vocs.config.ts
```

Engineering reference docs (deployer guide, ops runbooks, protocol spec) live separately at the repo root under [`/docs/`](../docs/).

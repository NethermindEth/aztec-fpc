FROM node:18-alpine AS builder

ARG SERVICE=attestation

ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY services ./services

RUN pnpm install --frozen-lockfile --filter "@aztec-fpc/${SERVICE}..."
RUN pnpm --filter "@aztec-fpc/${SERVICE}" run build

FROM node:18-alpine AS runtime

ARG SERVICE=attestation

ENV NODE_ENV=production
ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services ./services

RUN pnpm install --frozen-lockfile --prod --filter "@aztec-fpc/${SERVICE}..."

COPY --from=builder /app/services/${SERVICE}/dist /app/services/${SERVICE}/dist

WORKDIR /app/services/${SERVICE}

CMD ["node", "dist/index.js"]

# LiveRead API / worker image (monorepo-aware, pnpm)
FROM node:22-bookworm-slim AS build
# openssl must be present when `prisma generate` runs, otherwise the client is
# generated for openssl-1.1.x and cannot find its engine at runtime (3.0.x)
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.13.0
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
# the schema must land BEFORE install: apps/api has a `postinstall: prisma
# generate` hook (so a fresh clone builds without a manual step), and it needs
# the schema present. Copied separately to keep install layer-cached.
COPY apps/api/prisma apps/api/prisma
RUN pnpm install --frozen-lockfile --filter @liveread/shared --filter @liveread/api
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @liveread/shared build \
  && cd apps/api && npx prisma generate \
  && cd /app && pnpm --filter @liveread/api build

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# non-root runtime
RUN useradd -r -u 10001 liveread
WORKDIR /app
COPY --from=build --chown=liveread:liveread /app /app
WORKDIR /app/apps/api
USER liveread
EXPOSE 4000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]

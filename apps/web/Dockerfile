# LiveRead web image (Next.js standalone output)
FROM node:22-bookworm-slim AS build
RUN npm install -g pnpm@11.13.0
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @liveread/shared --filter @liveread/web
COPY packages/shared packages/shared
COPY apps/web apps/web
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm --filter @liveread/shared build \
  && pnpm --filter @liveread/web build

FROM node:22-bookworm-slim
RUN useradd -r -u 10001 liveread
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
USER liveread
EXPOSE 3000
ENV HOSTNAME=0.0.0.0 PORT=3000
CMD ["node", "apps/web/server.js"]

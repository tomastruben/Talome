# ── Stage 1: build dashboard ──────────────────────────────────────────────────
FROM node:22-alpine AS dashboard-builder
WORKDIR /app

RUN apk add --no-cache python3 make g++ linux-headers
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/core/package.json ./apps/core/
COPY packages/ ./packages/

RUN pnpm install --frozen-lockfile

COPY apps/dashboard ./apps/dashboard
COPY packages ./packages

RUN pnpm --filter dashboard build

# ── Stage 2: build core ───────────────────────────────────────────────────────
FROM node:22-alpine AS core-builder
WORKDIR /app

RUN apk add --no-cache python3 make g++ linux-headers
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/core/package.json ./apps/core/
COPY packages/ ./packages/

RUN pnpm install --frozen-lockfile

COPY apps/core ./apps/core
COPY packages ./packages

RUN pnpm --filter @talome/core build

# Deploy: create a self-contained directory with production deps only
RUN pnpm deploy --filter @talome/core --prod --legacy /app/core-deploy

# ── Stage 3: runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache docker-cli tini curl git

# Core: self-contained deploy with all production deps resolved
COPY --from=core-builder /app/core-deploy ./core
COPY --from=core-builder /app/apps/core/dist ./core/dist

# Core prompts (needed at runtime for AI)
COPY --from=core-builder /app/apps/core/prompts ./core/prompts

# Dashboard standalone build
COPY --from=dashboard-builder /app/apps/dashboard/.next/standalone ./dashboard
COPY --from=dashboard-builder /app/apps/dashboard/.next/static ./dashboard/.next/static
COPY --from=dashboard-builder /app/apps/dashboard/public ./dashboard/public

# App store definitions
COPY app-store ./core/app-store

ENV CORE_PORT=4000
ENV DASHBOARD_PORT=3000
ENV NODE_ENV=production
ENV TALOME_WATCHDOG=true

EXPOSE 4000 4001 3000

COPY scripts/docker-start.sh /app/start.sh
RUN chmod +x /app/start.sh

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/start.sh"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -sf http://localhost:4000/api/health || exit 1

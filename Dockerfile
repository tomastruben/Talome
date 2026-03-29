# ── Stage 1: build dashboard ──────────────────────────────────────────────────
FROM node:22-alpine AS dashboard-builder
WORKDIR /app

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

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/core/package.json ./apps/core/
COPY packages/ ./packages/

RUN pnpm install --frozen-lockfile

COPY apps/core ./apps/core
COPY packages ./packages

RUN pnpm --filter @talome/core build

# ── Stage 3: runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache docker-cli tini curl

# Core compiled output + production deps
COPY --from=core-builder /app/apps/core/dist ./core/dist
COPY --from=core-builder /app/apps/core/package.json ./core/
COPY --from=core-builder /app/apps/core/node_modules ./core/node_modules

# Dashboard standalone build
COPY --from=dashboard-builder /app/apps/dashboard/.next/standalone ./dashboard
COPY --from=dashboard-builder /app/apps/dashboard/.next/static ./dashboard/.next/static
COPY --from=dashboard-builder /app/apps/dashboard/public ./dashboard/public

# App store definitions
COPY --from=core-builder /app/apps/core/app-store ./core/app-store 2>/dev/null || true

ENV CORE_PORT=4000
ENV DASHBOARD_PORT=3000
ENV NODE_ENV=production
# In production, Docker/compose restart policy handles crash recovery.
# Setting TALOME_WATCHDOG=true tells apply_change that a safety net is active.
ENV TALOME_WATCHDOG=true

EXPOSE 4000 3000

# Use tini as PID 1 for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "core/dist/index.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -sf http://localhost:4000/api/health || exit 1

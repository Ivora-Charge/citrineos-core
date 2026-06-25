# SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
#
# SPDX-License-Identifier: Apache-2.0

# Build context is the monorepo root.

FROM --platform=${BUILDPLATFORM:-linux/amd64} node:24.16.0 AS builder

RUN corepack enable

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile

# NEXT_PUBLIC_* values are inlined into the client bundle by `next build`, so
# the public-facing backend URLs must be present *before* the build runs —
# setting them only at container runtime is too late for browser code.
# Defaults are empty, so omitting these args reproduces the previous behavior
# (config.ts falls back to its localhost defaults).
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_CITRINE_CORE_URL
ARG NEXT_PUBLIC_PAYMENT_SERVICE_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}
ENV NEXT_PUBLIC_CITRINE_CORE_URL=${NEXT_PUBLIC_CITRINE_CORE_URL}
ENV NEXT_PUBLIC_PAYMENT_SERVICE_URL=${NEXT_PUBLIC_PAYMENT_SERVICE_URL}

RUN pnpm --filter "@citrineos/operator-ui..." build

FROM node:24.16.0-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# Next.js standalone output is rooted at outputFileTracingRoot (monorepo root),
# so server.js lives at apps/operator-ui/server.js within the standalone tree.
COPY --from=builder --chown=nextjs:nodejs /app/apps/operator-ui/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/operator-ui/.next/static ./apps/operator-ui/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/operator-ui/public ./apps/operator-ui/public

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/operator-ui/server.js"]

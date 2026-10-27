# syntax=docker/dockerfile:1
# Imaginea FINET (serviciile finet-web și finet-worker). Build în trei etape:
# deps (dependențe) → build (next build, ieșire standalone) → runner (doar ce rulează, user non-root).
# Ținta separată `tools` (finet:tools, serviciul finet-migrate): runner-ul de migrații și, din F1-B,
# uneltele CLI; se construiește cu `--target tools` și nu rulează `next build`.
# `runner` rămâne ULTIMA etapă: un `docker build` fără `--target` produce imaginea web.
# Nicio variabilă secretă nu intră în imagine: configurația vine la rulare, din mediul containerului.

ARG NODE_IMAGE=node:24.22.1-bookworm-slim

# --- deps ---------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# --- build --------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV COREPACK_HOME=/opt/corepack \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=1536
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# --- prod-deps (doar pentru `tools`) --------------------------------------------------------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# --- tools-build: împachetează uneltele (scripts/build-tools.mjs → dist/tools/*.mjs) ---------
FROM ${NODE_IMAGE} AS tools-build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY scripts/build-tools.mjs ./scripts/
COPY src ./src
RUN node scripts/build-tools.mjs

# --- tools --------------------------------------------------------------------------------
# Rulează ca `node` (uid 1000); fișierele aparțin lui root, deci procesul nu le poate modifica.
# Migrațiile se citesc din /app/src/db/migrations (FINET_MIGRATIONS_DIR le poate muta).
FROM ${NODE_IMAGE} AS tools
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=tools-build /app/dist/tools ./dist/tools
COPY src/db/migrations ./src/db/migrations
USER node
# One-shot, fără server HTTP.
HEALTHCHECK NONE
CMD ["node", "dist/tools/migrate.mjs"]

# --- runner -------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

# Utilizatorul `node` (uid 1000) există deja în imaginea oficială; aplicația nu rulează ca root.
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3000

# Imaginea slim nu are curl: verificarea folosește fetch din Node.
# Liveness-ul /api/health/live (doar 200, fără detalii) e lăsat de src/proxy.ts fără JWT Access
# numai pentru cereri locale (Host 127.0.0.1); /api/health detaliat cere Access sau HEALTH_TOKEN.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]

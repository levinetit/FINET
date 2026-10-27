# syntax=docker/dockerfile:1
# Imaginea FINET (serviciile finet-web și finet-worker). Build în trei etape:
# deps (dependențe) → build (next build, ieșire standalone) → runner (doar ce rulează, user non-root).
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
# /api/health e deocamdată un stub (T1), înlocuit în T3 de verificarea reală.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]

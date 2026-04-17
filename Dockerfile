# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/dashboard/package.json packages/dashboard/

RUN npm ci

COPY packages/backend packages/backend
COPY packages/mcp-server packages/mcp-server

RUN npm run build --workspace=packages/backend \
  && npm run build --workspace=packages/mcp-server

RUN npm prune --omit=dev --workspace=packages/backend --workspace=packages/mcp-server

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

RUN groupadd --system --gid 1001 teammemory \
  && useradd --system --uid 1001 --gid 1001 --home-dir /app --shell /usr/sbin/nologin teammemory \
  && mkdir -p /data \
  && chown -R teammemory:teammemory /data

ENV NODE_ENV=production
ENV PORT=3456
ENV TEAM_MEMORY_DB=/data/team-memory.db

COPY --from=build --chown=teammemory:teammemory /app/node_modules ./node_modules
COPY --from=build --chown=teammemory:teammemory /app/packages/backend/dist ./packages/backend/dist
COPY --from=build --chown=teammemory:teammemory /app/packages/backend/package.json ./packages/backend/
COPY --from=build --chown=teammemory:teammemory /app/packages/mcp-server/dist ./packages/mcp-server/dist
COPY --from=build --chown=teammemory:teammemory /app/packages/mcp-server/package.json ./packages/mcp-server/
COPY --from=build --chown=teammemory:teammemory /app/package.json /app/package-lock.json ./

USER teammemory
VOLUME ["/data"]
EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||3456) +'/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "packages/backend/dist/index.js"]

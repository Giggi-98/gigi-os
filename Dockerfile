# Immagine unica per gigi-api e gigi-agent (cambia solo il comando); variante "media" con ffprobe per gigi-media.
# Build multi-stage, runtime non-root.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/agent/package.json apps/agent/
COPY apps/api/package.json apps/api/
COPY apps/media/package.json apps/media/
COPY apps/files/package.json apps/files/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY apps apps
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/agent/package.json apps/agent/
COPY apps/api/package.json apps/api/
COPY apps/media/package.json apps/media/
COPY apps/files/package.json apps/files/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund -w apps/agent -w apps/api --include-workspace-root=false

FROM node:22-alpine AS runtime
ARG GIGI_VERSION=0.0.0
ENV NODE_ENV=production NODE_NO_WARNINGS=1
WORKDIR /app
COPY --from=deps /src/node_modules ./node_modules
COPY --from=build /src/apps/agent/package.json apps/agent/package.json
COPY --from=build /src/apps/agent/dist apps/agent/dist
COPY --from=build /src/apps/api/package.json apps/api/package.json
COPY --from=build /src/apps/api/dist apps/api/dist
COPY --from=build /src/apps/media/package.json apps/media/package.json
COPY --from=build /src/apps/media/dist apps/media/dist
COPY --from=build /src/apps/files/package.json apps/files/package.json
COPY --from=build /src/apps/files/dist apps/files/dist
COPY --from=build /src/apps/web/dist apps/web/dist
COPY package.json ./
# ping e tracepath per la diagnostica di rete di gigi-api (ICMP non privilegiato, nessuna capability)
RUN apk add --no-cache iputils-ping iputils-tracepath
# /run/gigi ospita i socket agent/media ↔ api: il volume nominato eredita questi permessi al primo avvio.
RUN mkdir -p /run/gigi /data && chown node:node /run/gigi /data && chmod 750 /run/gigi
USER node
LABEL org.opencontainers.image.title="GIGI OS" \
      org.opencontainers.image.version="${GIGI_VERSION}" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.description="Homelab control center self-hosted"
CMD ["node", "apps/api/dist/index.js"]

# Binario ufficiale di Docker Compose (Apache-2.0) per gli stack creati dal wizard (D-025).
FROM docker/compose-bin:v5.6.0 AS compose

# Agent: Debian trixie per avere journalctl compatibile con il journal dell'host (systemd ≥ 257).
# Dipendenze di produzione installate qui (glibc), non riusate dallo stage Alpine.
FROM node:22-trixie-slim AS agent
ARG GIGI_VERSION=0.0.0
LABEL org.opencontainers.image.title="GIGI OS agent" org.opencontainers.image.version="${GIGI_VERSION}" org.opencontainers.image.licenses="AGPL-3.0-only"
RUN apt-get update && apt-get install -y --no-install-recommends systemd && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NODE_NO_WARNINGS=1
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/agent/package.json apps/agent/
COPY apps/api/package.json apps/api/
COPY apps/media/package.json apps/media/
COPY apps/files/package.json apps/files/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund -w apps/agent --include-workspace-root=false && npm cache clean --force
COPY --from=build /src/apps/agent/dist apps/agent/dist
COPY --from=compose /docker-compose /usr/local/bin/docker-compose
RUN mkdir -p /run/gigi && chown node:node /run/gigi && chmod 750 /run/gigi
USER node
CMD ["node", "apps/agent/dist/index.js"]

# Worker media: aggiunge solo ffprobe (pacchetto ffmpeg di Alpine).
FROM runtime AS media
USER root
RUN apk add --no-cache ffmpeg && ffprobe -version | head -1
USER node
CMD ["node", "apps/media/dist/index.js"]

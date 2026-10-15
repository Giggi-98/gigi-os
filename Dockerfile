# Immagine unica per gigi-api e gigi-agent (cambia solo il comando). Build multi-stage, runtime non-root.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/agent/package.json apps/agent/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY apps apps
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/agent/package.json apps/agent/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund -w apps/agent -w apps/api --include-workspace-root=false

FROM node:22-alpine
ENV NODE_ENV=production NODE_NO_WARNINGS=1
WORKDIR /app
COPY --from=deps /src/node_modules ./node_modules
COPY --from=build /src/apps/agent/package.json apps/agent/package.json
COPY --from=build /src/apps/agent/dist apps/agent/dist
COPY --from=build /src/apps/api/package.json apps/api/package.json
COPY --from=build /src/apps/api/dist apps/api/dist
COPY --from=build /src/apps/web/dist apps/web/dist
COPY package.json ./
# /run/gigi ospita il socket agent↔api: il volume nominato eredita questi permessi al primo avvio.
RUN mkdir -p /run/gigi /data && chown node:node /run/gigi /data && chmod 750 /run/gigi
USER node
LABEL org.opencontainers.image.title="GIGI OS" org.opencontainers.image.version="0.1.0"
CMD ["node", "apps/api/dist/index.js"]

# ---- Build the web UI ----
FROM node:25-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./web
RUN npm run build

# ---- Runtime (no npm dependencies needed: the server uses only Node built-ins) ----
FROM node:25-alpine
RUN apk add --no-cache su-exec tzdata
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    PUID=1000 \
    PGID=1000

COPY package.json ./
COPY src ./src
COPY --from=build /app/web/dist ./web/dist
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /data

VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]

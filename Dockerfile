FROM oven/bun:1.3.14-alpine AS builder
WORKDIR /app

ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:1.3.14-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NODE_USE_SYSTEM_CA=1 \
    COPILOT_API_HOME=/data \
    COPILOT_API_HEALTHCHECK_FILE=/tmp/copilot-api/healthcheck-url \
    PORT=4141

RUN apk add --no-cache curl

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts --no-cache

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/pages ./pages
COPY entrypoint.sh /entrypoint.sh
COPY healthcheck.sh /healthcheck.sh

RUN chmod +x /entrypoint.sh /healthcheck.sh && \
    mkdir -p /data && \
    chown bun:bun /data && \
    chmod 700 /data

USER bun
VOLUME ["/data"]
EXPOSE 4141

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["/healthcheck.sh"]

ENTRYPOINT ["/entrypoint.sh"]

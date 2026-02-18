FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/admin-server/package.json apps/admin-server/package.json
COPY apps/admin-web/package.json apps/admin-web/package.json
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV DATA_DIR=/data/admin
ENV LOG_FILE_MAX_MB=20
ENV DISABLE_STDOUT_LOG=1
ENV WEB_DIST_DIR=/app/apps/admin-web/dist

COPY package.json package-lock.json ./
COPY apps/admin-server/package.json apps/admin-server/package.json
COPY apps/admin-web/package.json apps/admin-web/package.json
RUN npm ci --omit=dev --no-audit --no-fund

COPY --from=builder /app/apps/admin-server/dist ./apps/admin-server/dist
COPY --from=builder /app/apps/admin-web/dist ./apps/admin-web/dist
COPY --from=builder /app/gameConfig ./gameConfig
COPY --from=builder /app/tools ./tools
COPY --from=builder /app/src ./src
COPY --from=builder /app/proto ./proto
COPY --from=builder /app/client.js ./client.js
COPY --from=builder /app/share.txt ./share.txt

RUN mkdir -p /data/admin
VOLUME ["/data"]

EXPOSE 8080
CMD ["node", "apps/admin-server/dist/index.js"]

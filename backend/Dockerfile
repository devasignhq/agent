FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .
USER node

# Cloud Run injects PORT (8080); config.ts reads it.
EXPOSE 8080

# Exec node directly, not `npm start`: npm doesn't reliably forward SIGTERM, which would skip the shutdown flush.
CMD ["node", "--enable-source-maps", "--import", "tsx/esm", "src/server.ts"]

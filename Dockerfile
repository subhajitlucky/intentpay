# IntentPay — single-container deployment.
#
# Stage 1 builds the React client with a same-origin API base, so the container
# serves both the UI and the API on one port and CORS never comes into play.
# Stage 2 installs production dependencies only.
# Stage 3 is the runtime: non-root, with /app/data ready for a mounted volume.

# ---- 1. build the client ---------------------------------------------------
FROM node:22-bookworm-slim AS client
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
ENV VITE_API_BASE=/api
RUN npm run build

# ---- 2. production dependencies -------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- 3. runtime ------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    INTENTPAY_DATA_DIR=/app/data
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ai-agent.js wallet-manager.js ./
COPY --from=client /app/frontend/dist ./frontend/dist

# The JSON keystore lives here. Mount a volume on this path or every restart
# takes the wallets with it.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

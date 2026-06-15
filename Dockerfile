# ---- Stage 1: Build ----
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build
RUN npm run build:server

# ---- Stage 2: Runtime ----
FROM node:20-alpine AS runtime

# Install Python 3 + pip for ucc-gen
RUN apk add --no-cache python3 py3-pip && \
    pip3 install --break-system-packages splunk-add-on-ucc-framework

WORKDIR /app

# Copy production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy built frontend
COPY --from=builder /app/dist ./dist

# Copy built server
COPY --from=builder /app/dist-server ./dist-server

# Copy vendor specs (needed at runtime for conf validation)
COPY vendor ./vendor

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

CMD ["node", "dist-server/index.js"]

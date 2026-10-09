# syntax=docker/dockerfile:1.7

# ============================================================
# Builder stage
# ============================================================
FROM node:22-slim AS builder

WORKDIR /app

# Copy only the manifests first so Docker can cache npm ci across
# source-only changes.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the build configuration and the source.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN npm run build

# ============================================================
# Runtime stage
# ============================================================
FROM node:22-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Install only production dependencies. The image ships dist/ plus the
# runtime node_modules; no TypeScript, no test runner, no tsx.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The build output.
COPY --from=builder /app/dist ./dist

# The image has no shell user; the base image ships a "node" user
# (uid 1000). Run as it, never as root.
USER node

# API port. The metrics server uses METRICS_PORT (default 9464).
EXPOSE 3000

# main.ts and maintenance-runner.ts both guard on isDirectRun and only
# bootstrap when argv[1] ends with their filename.
CMD ["node", "dist/main.js"]

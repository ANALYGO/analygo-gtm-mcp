FROM node:22-slim AS builder

WORKDIR /app

# Copy EVERYTHING first — npm ci needs source for postinstall (tsc build)
# AND Cloudflare packages need scripts enabled to download workerd binary
COPY . .

# Install ALL dependencies with scripts enabled
# postinstall runs tsc → dist/, and wrangler's postinstall downloads workerd
RUN npm ci

# ============================================================
# Runtime stage — Debian (not Alpine!) because workerd is a glibc binary
# ============================================================
FROM node:22-slim AS runtime

WORKDIR /app

# Copy everything from builder (node_modules, dist/, src/)
COPY --from=builder /app /app

# Entrypoint script writes env vars to .dev.vars for wrangler
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/docker-entrypoint.sh"]

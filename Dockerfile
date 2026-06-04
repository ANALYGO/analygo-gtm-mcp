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

# openssl needed by entrypoint to generate self-signed HTTPS cert
# ca-certificates needed by workerd for outbound TLS (Google OAuth token exchange)
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy everything from builder (node_modules, dist/, src/)
COPY --from=builder /app /app

# Entrypoint script writes env vars to .dev.vars for wrangler
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 3000

ARG BUILD_SHA
ARG BUILD_DATE
ARG BUILD_SOURCE

ENV BUILD_SHA=${BUILD_SHA:-unknown} \
    BUILD_DATE=${BUILD_DATE:-unknown} \
    BUILD_SOURCE=${BUILD_SOURCE:-unknown}

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3000/ || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]

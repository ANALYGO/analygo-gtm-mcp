#!/bin/sh
# wrangler dev does not automatically inherit container environment
# variables.  This script writes them into .dev.vars (the standard
# wrangler mechanism for local dev secrets) before starting the
# dev server.
#
# Also generates a self-signed TLS cert so wrangler dev serves HTTPS,
# which is required for OAuth issuer metadata behind a reverse proxy.
set -eu

DEV_VARS="${DEV_VARS_FILE:-/app/.dev.vars}"

# wrangler reads .dev.vars automatically.  Only write vars that
# are actually set.
: > "$DEV_VARS"

if [ -n "${GOOGLE_CLIENT_ID:-}" ]; then
  echo "GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}" >> "$DEV_VARS"
fi
if [ -n "${GOOGLE_CLIENT_SECRET:-}" ]; then
  echo "GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}" >> "$DEV_VARS"
fi
if [ -n "${COOKIE_ENCRYPTION_KEY:-}" ]; then
  echo "COOKIE_ENCRYPTION_KEY=${COOKIE_ENCRYPTION_KEY}" >> "$DEV_VARS"
fi
if [ -n "${GTM_API_KEY:-}" ]; then
  echo "GTM_API_KEY=${GTM_API_KEY}" >> "$DEV_VARS"
fi
if [ -n "${GTM_REFRESH_TOKEN:-}" ]; then
  echo "GTM_REFRESH_TOKEN=${GTM_REFRESH_TOKEN}" >> "$DEV_VARS"
fi
if [ -n "${HOSTED_DOMAIN:-}" ]; then
  echo "HOSTED_DOMAIN=${HOSTED_DOMAIN}" >> "$DEV_VARS"
fi
if [ -n "${WORKER_HOST:-}" ]; then
  echo "WORKER_HOST=${WORKER_HOST}" >> "$DEV_VARS"
fi

# Generate self-signed TLS cert so wrangler dev serves HTTPS.
# This ensures the OAuth issuer metadata uses https:// scheme,
# which mcp-remote requires for client registration.
CERT_DIR="/tmp/certs"
mkdir -p "$CERT_DIR"
if [ ! -f "$CERT_DIR/server.crt" ]; then
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout "$CERT_DIR/server.key" \
    -out "$CERT_DIR/server.crt" \
    -subj "/CN=localhost" 2>/dev/null
fi

exec npx wrangler dev \
  --ip "0.0.0.0" \
  --port "3000" \
  --local-protocol https \
  --remote=false \
  --persist-to "/data" \
  --https-cert-path "$CERT_DIR/server.crt" \
  --https-key-path "$CERT_DIR/server.key" \
  "$@"

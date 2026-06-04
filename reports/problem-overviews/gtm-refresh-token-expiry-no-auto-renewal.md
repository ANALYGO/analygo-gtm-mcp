---
title: "GTM MCP REST endpoints fail after Google refresh token expires — no automated renewal"
type: problem-overview
severity: high
confidence: confirmed
status: proposed
date: 2026-06-04
last_updated: 2026-06-04
domain:
  - infra
  - backend
tags:
  - gtm-mcp
  - google-oauth
  - refresh-token
  - aegis
  - expiry
related:
  - "../initiatives/_cross/2026-06-02-active-gtm-audit-remediation-mcp-plugin"
  - "../../analygo-aegis/.claude/plans/rewire-gtm-tools-mcp-rest.plan.md"
  - "../../analygo-gtm-mcp/.claude/plans/gtm-rest-api.plan.md"
  - "../../analygo-gtm-mcp/.claude/plans/gtm-cicd-pipeline.plan.md"
---

# GTM MCP REST endpoints fail after Google refresh token expires — no automated renewal

## Problem

### What's Happening

Aegis agents cannot query GTM data because the GTM MCP server's REST endpoints
(`/api/gtm/*`) return HTTP 500 after the Google OAuth refresh token expires.
The token is stored as a static env var (`GTM_REFRESH_TOKEN`) in Coolify and must
be manually refreshed by extracting a new token from the MCP OAuth state after
re-authenticating via `npx mcp-remote`. This has failed twice in 24 hours —
the token extracted from OAuth state was already expired on first use, and the
fresh token from re-authentication now shows the same `invalid_grant` error.

### Evidence

```bash
# Endpoint responds but Google auth fails:
curl -sk -H "X-Internal-Auth: aegis-internal-key" https://gtm-mcp.analygo.co/api/gtm/accounts
# → {"error":"Failed to refresh Google access token using GTM_REFRESH_TOKEN"}

# Direct Google API call confirms invalid_grant:
curl -X POST https://oauth2.googleapis.com/token \
  -d "client_id=..." -d "client_secret=..." \
  -d "refresh_token=<extracted_token>" -d "grant_type=refresh_token"
# → {"error": "invalid_grant", "error_description": "Bad Request"}
```

Every deploy via the CI/CD pipeline overwrites manually-set values because
Coolify regenerates `.env` from its database, so a token set via SSH into
`.env` will vanish on the next redeploy.

## Root Cause

The GTM MCP server's REST endpoints use a **single static refresh token** stored
as an env var (`GTM_REFRESH_TOKEN`). This token has a finite lifetime — Google
invalidates it when:

1. The user changes their Google password
2. The OAuth consent screen is updated
3. A new refresh token is issued (each OAuth flow issues a NEW refresh token,
   invalidating the previous one)
4. The token is unused for 6 months

The server has no mechanism to automatically renew or rotate this token. Compare
with the **MCP protocol path** (`/mcp`, `/sse`), where the Cloudflare Workers
OAuth Provider automatically handles token refresh via `handleTokenExchangeCallback`
in `authorizeUtils.ts`. The REST path bypasses this entirely.

**Confidence:** confirmed

**Why this, not something else:**

- Not a credentials issue — `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are
  correct (MCP protocol path works with same credentials)
- Not a network issue — the endpoint is reachable, Google's token endpoint is reachable
- Not a code bug in `refreshUpstreamAuthToken` — the function works correctly,
  Google explicitly rejects the token as `invalid_grant`
- Not a scope mismatch — same scopes work for the MCP protocol path

## Files Involved

### Root Cause Files

- `analygo-gtm-mcp/src/utils/getServerTagManagerClient.ts:4-23` — `getAccessToken()`
  function that reads `GTM_REFRESH_TOKEN` from env and passes it to Google's
  token endpoint. No automatic renewal, no fallback to user OAuth tokens.
- `analygo-gtm-mcp/docker-entrypoint.sh:15-16` — writes `GTM_REFRESH_TOKEN` to
  `.dev.vars` from Coolify env. Token lives as long as the env var value.

### Affected Files

- `analygo-gtm-mcp/src/utils/apisHandler.ts:219-280` — REST routes that call
  `getServerTagManagerClient(env)`, which fails when token is expired
- `analygo-aegis/backend/app/domains/intelligence/tools/_lib/gtm.py` — Aegis
  GTM helper that calls the REST endpoints; receives 500 errors

### Fix Target Files

- `analygo-gtm-mcp/src/utils/getServerTagManagerClient.ts` — add fallback to
  user OAuth tokens when server token fails, or implement auto-refresh
- `analygo-gtm-mcp/src/utils/authorizeUtils.ts` — reuse existing
  `handleTokenExchangeCallback` refresh logic for REST path

### Reference Files (read-only)

- `analygo-gtm-mcp/src/index.ts:67-81` — OAuthProvider setup that auto-refreshes
  MCP user tokens via `handleTokenExchangeCallback`
- `analygo-gtm-mcp/src/utils/authorizeUtils.ts:171-225` —
  `handleTokenExchangeCallback` that successfully refreshes Google tokens for MCP
  sessions — this is the pattern to reuse

## Recommendation

### What to Do

Replace the static `GTM_REFRESH_TOKEN` env var with automatic token acquisition
from the OAuth Provider's stored user tokens. The server already stores valid
Google refresh tokens from `mcp-remote` authentications in the OAuth Provider's
KV/Durable Objects. The REST path should look up the most recent authenticated
user's tokens instead of using a separate env var.

### Implementation Approach

```
1. In getServerTagManagerClient.ts, instead of reading GTM_REFRESH_TOKEN from env:
   - Use c.env.OAUTH_PROVIDER.listUserGrants() to find a recently authenticated user
   - Get their Props (accessToken, refreshToken, expiresAt) from the OAuth provider
   - Use refreshUpstreamAuthToken with that user's refresh token
   - Cache the result like the current in-memory cache

2. If no user has authenticated (first deploy, no mcp-remote connections):
   - Return a clear 503 error: "No authenticated GTM users. Run npx mcp-remote first."
   - This is better than a silent 500 from an expired token

3. Remove GTM_REFRESH_TOKEN from env vars, docker-entrypoint.sh, and global.d.ts

4. Keep GTM_API_KEY for Aegis auth (still needed)
```

### Estimated Effort

~3 hours (1 file substantially changed, 2 files cleaned up, deployment + verification)

### Rollback Plan

Revert commit. Keep `GTM_REFRESH_TOKEN` configured for fallback during transition.
The env var can be removed in a follow-up once user-token-based auth is stable.

## Rationale

### Why This Approach

The OAuth Provider already maintains valid Google tokens — it refreshes them
automatically via `handleTokenExchangeCallback` every 15 minutes. Using these
tokens instead of a separate static one means:

1. **Zero maintenance** — as long as someone authenticates via `npx mcp-remote`
   at least once, the REST path works indefinitely
2. **Same code path** — reuses `refreshUpstreamAuthToken` which is battle-tested
   in the MCP protocol path
3. **No new credentials** — no OAuth playground, no manual token extraction
4. **Self-healing** — if token expires, next `mcp-remote` auth refreshes it

### Alternatives Considered

| Alternative | Why Rejected |
|-------------|-------------|
| Keep static token, add alerting when it fails | Only tells you it's broken, doesn't fix it. Still needs manual intervention. |
| Use Google service account instead of OAuth | Service accounts can't access GTM API — GTM requires OAuth user consent. |
| Have Aegis call MCP protocol instead of REST | Aegis backend can't do browser OAuth. MCP protocol over SSE adds complexity for server-to-server. |
| Store the token in Coolify and rotate manually on schedule | Same problem with less frequency — still a manual process, still fragile. |

### Risks & Side Effects

- **First-deploy scenario:** If no user has authenticated via `mcp-remote`, the
  REST path has no tokens to borrow. Mitigation: clear error message guides the
  operator to run `npx mcp-remote` once.
- **Token ownership:** The REST path uses a user's token, so API calls appear as
  that user in Google audit logs. This is acceptable — the same user already
  authenticates for Claude Code.
- **Performance:** `listUserGrants()` is a KV lookup, negligible compared to
  Google API latency.

### Success Criteria

- [ ] `GET /api/gtm/accounts` returns GTM data within 30s of `npx mcp-remote` auth
- [ ] Endpoint returns clear 503 (not 500) when no user has authenticated
- [ ] No `GTM_REFRESH_TOKEN` env var required
- [ ] Token survives CI/CD redeploy (no manual intervention after deploy)
- [ ] Aegis agents can query GTM containers via Aegis Chat

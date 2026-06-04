---
name: Add REST API Endpoints to GTM MCP Server
repo: analygo-gtm-mcp
overview: |
  Add /api/gtm/* REST routes alongside existing MCP routes so Aegis backend can
  query GTM metadata via HTTP with a shared-secret header. Reuses existing
  googleapis integration. No OAuth dance — server-to-server auth via API key.
waves:
  - id: wave-1
    surfaces: [A, B]
    parallel: false
todos:
  - id: user-coordinate
    content: "[USER] / — / Coordinate execution of surfaces according to wave dependencies"
    status: completed
  - id: agent-1-config
    content: "[AGENT-1] / A / Add GTM_API_KEY and GTM_REFRESH_TOKEN env vars, update worker types and docker-entrypoint"
    status: completed
  - id: agent-1-commit
    content: "[AGENT-1] / A / Commit Surface A changes"
    status: completed
  - id: agent-2-routes
    content: "[AGENT-2] / B / Implement /api/gtm/* REST routes in Hono app using server-level Google auth"
    status: completed
  - id: agent-2-commit
    content: "[AGENT-2] / B / Commit Surface B changes"
    status: completed
  - id: agent-r-review
    content: "[AGENT-R] / REVIEW / Typecheck, build Docker image, deploy to Coolify, verify endpoints respond"
    status: completed
agents:
  - id: agent-1-config
    name: "Surface A — Config"
    branch: "feature/gtm-rest-api"
    surface: "A"
    wave: 1
    worktree: "../worktrees/A-gtm-rest-api"
  - id: agent-2-routes
    name: "Surface B — REST Routes"
    branch: "feature/gtm-rest-api"
    surface: "B"
    wave: 1
    worktree: "../worktrees/B-gtm-rest-api"
  - id: agent-r-review
    name: "Review Agent"
    branch: "feature/gtm-rest-api"
    surface: "REVIEW"
    wave: 2
    worktree: "../worktrees/R-review-gtm-rest-api"
isProject: false
---

# 1. Overview

The GTM MCP server at `gtm-mcp.analygo.co` has working Google OAuth and GTM API integration, but only exposes MCP protocol endpoints (`/mcp`, `/sse`). Aegis agents run on the Aegis backend — they can't speak MCP over SSE.

**This plan adds plain REST endpoints** alongside the existing MCP routes. Aegis calls `GET /api/gtm/accounts` with an `X-Internal-Auth` header. The server validates the key, uses a stored Google refresh token to call the GTM API, and returns JSON.

## Architecture

```
gtm-mcp.analygo.co
├── /authorize, /callback, /token, /register   ← existing (OAuth for mcp-remote)
├── /mcp, /sse                                  ← existing (MCP for Claude Code)
│
└── /api/gtm/                                   ← NEW (REST for Aegis)
    ├── GET  accounts                           → tagmanager.accounts.list()
    ├── GET  accounts/:id/containers            → tagmanager.accounts.containers.list()
    ├── GET  accounts/:aid/containers/:cid/workspaces → .workspaces.list()
    ├── GET  .../tags                           → .workspaces.tags.list()
    ├── GET  .../triggers                       → .workspaces.triggers.list()
    └── GET  .../variables                      → .workspaces.variables.list()
```

Auth for `/api/*`: the `X-Internal-Auth` header must match `GTM_API_KEY` env var. Same pattern as Platform's Aegis bypass. No OAuth, no browser, no session state.

Google auth for REST calls: the server uses `GTM_REFRESH_TOKEN` + `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` to obtain access tokens. This is a server-level credential, not per-user.

## Auth Flow

```
Aegis backend
  │
  │  GET /api/gtm/accounts
  │  X-Internal-Auth: <GTM_API_KEY>
  ▼
Hono route handler
  │
  ├── Header matches GTM_API_KEY? → No → 401
  │
  ▼ Yes
  │
  │  Exchange GTM_REFRESH_TOKEN for Google access token
  │  (using GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET)
  ▼
  │  google.tagmanager({ version: "v2" })
  │  → accounts.list()
  ▼
  │  Return JSON response
```

# 2. Success Criteria

- [ ] `GET /api/gtm/accounts` returns JSON list of GTM accounts when valid API key provided
- [ ] `GET /api/gtm/accounts/:id/containers` returns container list
- [ ] `GET /api/gtm/accounts/:aid/containers/:cid/workspaces` returns workspace list
- [ ] `GET /api/gtm/.../tags`, `/triggers`, `/variables` return entity lists
- [ ] Invalid or missing `X-Internal-Auth` returns 401
- [ ] Missing `GTM_REFRESH_TOKEN` env var returns clear 500 error message
- [ ] Existing MCP routes (`/mcp`, `/sse`, OAuth flow) continue to work unchanged
- [ ] Docker image builds and deploys to Coolify
- [ ] Endpoints respond at `https://gtm-mcp.analygo.co/api/gtm/accounts`

# 3. File Boundaries

## Surface A — Config (`agent-1-config`)

| Allowed (r/w) | Purpose |
|---|---|
| `global.d.ts` | Add `GTM_API_KEY` and `GTM_REFRESH_TOKEN` to `Cloudflare.Env` interface |
| `docker-entrypoint.sh` | Add new env vars to `.dev.vars` generation |

| Read-only (r/o) | Purpose |
|---|---|
| `wrangler.jsonc` | Reference existing env var bindings |
| `Dockerfile` | Understand image build |
| `docker-compose.yml` | Understand Coolify deployment |

## Surface B — REST Routes (`agent-2-routes`)

| Allowed (r/w) | Purpose |
|---|---|
| `src/utils/apisHandler.ts` | Add `/api/gtm/*` Hono routes |
| `src/utils/getTagManagerClient.ts` | Add `getServerTagManagerClient(env)` for server-level auth (or create `src/utils/getServerTagManagerClient.ts`) |

| Read-only (r/o) | Purpose |
|---|---|
| `src/index.ts` | Understand OAuthProvider + defaultHandler routing |
| `src/tools/containerActions.ts` | Reference GTM API call patterns |
| `src/tools/accountActions.ts` | Reference account listing pattern |
| `src/tools/workspaceActions.ts` | Reference workspace listing pattern |
| `src/utils/authorizeUtils.ts` | Reference token exchange logic (`fetchUpstreamAuthToken`) |

# 4. Agent Assignments and Worktree Paths

| Agent | Surface | Wave | Worktree |
|-------|---------|------|----------|
| `agent-1-config` | A — Config | 1 | `../worktrees/A-gtm-rest-api` |
| `agent-2-routes` | B — REST Routes | 1 | `../worktrees/B-gtm-rest-api` |
| `agent-r-review` | REVIEW | 2 | `../worktrees/R-review-gtm-rest-api` |

# 5. Dependencies and Wave Graph

```
Surface A (config) ──→ Surface B (routes) depends on A (env var types)
                              │
                              ▼
                         AGENT-R (Wave 2, deploy + verify)
```

Surface B CANNOT start until Surface A completes because B needs the env var types defined.

# 6. Implementation Steps

## Surface A — Config

### A.1 Add env var types

Add to `global.d.ts` Cloudflare.Env interface:
```typescript
GTM_API_KEY: string;
GTM_REFRESH_TOKEN: string;
```

### A.2 Wire into docker-entrypoint

Add to `docker-entrypoint.sh` `.dev.vars` generation block:
```bash
echo "GTM_API_KEY=${GTM_API_KEY}" >> /data/.dev.vars
echo "GTM_REFRESH_TOKEN=${GTM_REFRESH_TOKEN}" >> /data/.dev.vars
```

The Coolify docker-compose already injects env vars. No compose changes needed — just reference the new vars in the entrypoint.

## Surface B — REST Routes

### B.1 Server-level Google client

Create `src/utils/getServerTagManagerClient.ts`:

```typescript
import { google } from "googleapis";
import { fetchUpstreamAuthToken } from "./authorizeUtils";

export async function getServerTagManagerClient(env: Env) {
  if (!env.GTM_REFRESH_TOKEN) {
    throw new Error("GTM_REFRESH_TOKEN not configured");
  }

  const [tokenResult, errResponse] = await fetchUpstreamAuthToken({
    upstreamUrl: "https://oauth2.googleapis.com/token",
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    refreshToken: env.GTM_REFRESH_TOKEN,
    grantType: "refresh_token",
  });

  if (errResponse || !tokenResult) {
    throw new Error("Failed to refresh Google access token");
  }

  return google.tagmanager({
    version: "v2",
    headers: { Authorization: `Bearer ${tokenResult.access_token}` },
  });
}
```

### B.2 API key auth middleware

Add to `src/utils/apisHandler.ts`:

```typescript
function requireApiKey(c: Context) {
  const auth = c.req.header("X-Internal-Auth") || "";
  if (!auth || auth !== c.env.GTM_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
}
```

### B.3 REST routes

Add to `src/utils/apisHandler.ts` Hono app:

```typescript
// GET /api/gtm/accounts
app.get("/api/gtm/accounts", async (c) => {
  const authErr = requireApiKey(c);
  if (authErr) return authErr;
  try {
    const service = await getServerTagManagerClient(c.env);
    const res = await service.accounts().list();
    return c.json(res.data);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /api/gtm/accounts/:accountId/containers
app.get("/api/gtm/accounts/:accountId/containers", async (c) => {
  const authErr = requireApiKey(c);
  if (authErr) return authErr;
  try {
    const service = await getServerTagManagerClient(c.env);
    const res = await service.accounts().containers().list({
      parent: `accounts/${c.req.param("accountId")}`,
    });
    return c.json(res.data);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// ... same pattern for workspaces, tags, triggers, variables
```

Parameters map to GTM API paths:
| REST route | GTM API call |
|---|---|
| `/api/gtm/accounts` | `accounts().list()` |
| `/api/gtm/accounts/:aid/containers` | `accounts().containers().list({parent: "accounts/:aid"})` |
| `/api/gtm/accounts/:aid/containers/:cid/workspaces` | `accounts().containers().workspaces().list({parent: "accounts/:aid/containers/:cid"})` |
| `/api/gtm/accounts/:aid/containers/:cid/workspaces/:wid/tags` | `accounts().containers().workspaces().tags().list({parent: "..."})` |

### B.4 Token caching (in-memory)

Google access tokens from `fetchUpstreamAuthToken` should be cached for their `expires_in` duration (typically 3600s) to avoid refreshing on every request. A module-level cache is sufficient for single-process wrangler:

```typescript
let cachedToken: { access_token: string; expiresAt: number } | null = null;

async function getAccessToken(env: Env): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 300_000) {
    return cachedToken.access_token;
  }
  const [result] = await fetchUpstreamAuthToken({...});
  cachedToken = {
    access_token: result.access_token,
    expiresAt: Date.now() + (result.expires_in ?? 3600) * 1000,
  };
  return cachedToken.access_token;
}
```

# 7. Prerequisite: Google Refresh Token

The `GTM_REFRESH_TOKEN` must be obtained once. Two options:

**Option A — OAuth Playground (recommended):**
1. Go to https://developers.google.com/oauthplayground
2. Configure with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (same as MCP server)
3. Select `https://www.googleapis.com/auth/tagmanager.readonly` scope
4. Exchange auth code → copy Refresh token
5. Add to Coolify service env vars as `GTM_REFRESH_TOKEN`

**Option B — Extract from existing MCP auth:**
The MCP server stores refresh tokens from OAuth flows. These are accessible via `c.env.OAUTH_PROVIDER`. During review, check if we can extract a token programmatically instead of requiring manual OAuth playground setup.

# 8. Todo List

- [ ] [USER] / — / Coordinate execution of surfaces according to wave dependencies
- [ ] [AGENT-1] / A / Add GTM_API_KEY and GTM_REFRESH_TOKEN env vars, update worker types and docker-entrypoint
- [ ] [AGENT-1] / A / Commit Surface A changes
- [ ] [AGENT-2] / B / Implement /api/gtm/* REST routes in Hono app using server-level Google auth
- [ ] [AGENT-2] / B / Commit Surface B changes
- [ ] [AGENT-R] / REVIEW / Typecheck, build Docker image, deploy to Coolify, verify endpoints respond

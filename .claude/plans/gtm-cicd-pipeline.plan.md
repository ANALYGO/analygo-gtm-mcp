---
name: CI/CD Pipeline for GTM MCP Server
repo: analygo-gtm-mcp
overview: |
  Replace dead Stape-inherited workflows with proper Docker build → GHCR push →
  Coolify deploy pipeline matching the ANALYGO blueprint. Fix Dockerfile gaps.
  Setup GitHub production environment and secrets.
waves:
  - id: wave-1
    surfaces: [A, B]
    parallel: true
  - id: wave-2
    surfaces: [C]
    parallel: false
    depends_on: wave-1
  - id: wave-3
    surfaces: [REVIEW]
    parallel: false
    depends_on: wave-2
todos:
  - id: user-coordinate
    content: "[USER] / — / Coordinate execution of surfaces according to wave dependencies"
    status: completed
  - id: agent-1-cleanup
    content: "[AGENT-1] / A / Delete dead Stape workflows, create ci.yml, update Dockerfile, create deploy/ files"
    status: completed
  - id: agent-1-commit
    content: "[AGENT-1] / A / Commit Surface A changes — commit 7b9a2fc"
    status: completed
  - id: agent-2-pipeline
    content: "[AGENT-2] / B / Create build-and-push-gtm-mcp.yml workflow"
    status: completed
  - id: agent-2-commit
    content: "[AGENT-2] / B / Commit Surface B changes — commit c5ce283"
    status: completed
  - id: agent-3-secrets
    content: "[AGENT-3] / C / Setup GitHub production environment, secrets, and variables"
    status: completed
  - id: agent-3-commit
    content: "[AGENT-3] / C / Commit Surface C changes (GitHub API only, no file commits)"
    status: completed
  - id: agent-r-review
    content: "[AGENT-R] / REVIEW / Verify workflows pass, image pushes, Coolify deploys — REVIEW: PASS 17/17"
    status: completed
agents:
  - id: agent-1-cleanup
    name: "Surface A — Repo Files"
    branch: "agent/A-gtm-cicd"
    surface: "A"
    wave: 1
    worktree: "../worktrees/A-gtm-cicd"
  - id: agent-2-pipeline
    name: "Surface B — Build+Deploy Workflow"
    branch: "agent/B-gtm-cicd"
    surface: "B"
    wave: 1
    worktree: "../worktrees/B-gtm-cicd"
  - id: agent-3-secrets
    name: "Surface C — GitHub Config"
    branch: "agent/C-gtm-cicd"
    surface: "C"
    wave: 2
    worktree: "../worktrees/C-gtm-cicd"
  - id: agent-r-review
    name: "Review Agent"
    branch: "agent/R-review-gtm-cicd"
    surface: "REVIEW"
    wave: 3
    worktree: "../worktrees/R-review-gtm-cicd"
isProject: false
---

# 1. Session Brief — What Got Us Here

The GTM MCP server (`gtm-mcp.analygo.co`) is a fork of `stape-io/google-tag-manager-mcp-server`, self-hosted on Hetzner H1 via Coolify. It exposes Google Tag Manager API as MCP tools for Claude Code.

**Problem:** Aegis agents couldn't query GTM because Platform's `/gtm/*` endpoints require a Google OAuth token the `"internal"` user doesn't have.

**What's been done:**

| Step | What | Status |
|---|---|---|
| 1 | Diagnosed: Aegis calls Platform with `sub="internal"` → Google token missing → 403 | Done |
| 2 | Cherry-picked superuser bypass (`36f36895`) onto Platform main | Done |
| 3 | Fixed containers route to query DB directly for superusers (no Google API) | Done |
| 4 | Wrote plan `wire-gtm-tools-aegis` → implemented direct Google API tools in Aegis | Done, but needs `GTM_REFRESH_TOKEN` |
| 5 | Realized: MCP server already has working Google auth — just needs REST endpoints | Done |
| 6 | Wrote + executed `gtm-rest-api` plan: added `/api/gtm/*` REST routes to MCP server | Done |
| 7 | Extracted Google refresh token from MCP OAuth state, set `GTM_API_KEY` on Coolify | Done |
| 8 | Wrote + executed `rewire-gtm-tools-mcp-rest` plan: Aegis tools now call MCP REST | Done |
| 9 | Set `GTM_MCP_API_KEY` in Aegis `.env` | Done |
| 10 | Renamed repo `gtm-mcp` → `analygo-gtm-mcp` locally and on GitHub | Done |

**Remaining blocker:** MCP REST endpoint returns 500 — Google refresh token expired. User re-authenticated via `npx mcp-remote`, fresh token extracted. But every deploy has been manual (`docker buildx build --push` from laptop, SSH to pull + restart). **No CI/CD.**

**This plan:** Install proper CI/CD so pushes to main build, push to GHCR, and deploy automatically — matching the ANALYGO blueprint used by every other repo.

# 2. Overview

The `analygo-gtm-mcp` repo has two dead workflows inherited from the Stape fork:

- `main.yml` — npm publish (no NPM_TOKEN, fails immediately)
- `deploy.yml` — Cloudflare Workers deploy (no CF secrets, fails immediately)

Neither builds a Docker image. Neither pushes to GHCR. Neither triggers Coolify.

**Replace them** with the standard ANALYGO pattern:
1. `ci.yml` — lint + typecheck on PR (fast gate)
2. `build-and-push-gtm-mcp.yml` — Docker build → GHCR push → Coolify webhook

Also fix Dockerfile gaps (build args, HEALTHCHECK) and create the `deploy/` directory.

# 3. Success Criteria

- [ ] Dead workflows (`main.yml`, `deploy.yml`) deleted
- [ ] `ci.yml` runs lint + typecheck on PRs, passes in < 3 min
- [ ] `build-and-push-gtm-mcp.yml` builds Docker image, pushes to GHCR with `main` + `sha-<commit>` tags, triggers Coolify
- [ ] Dockerfile has `BUILD_SHA`, `BUILD_DATE`, `BUILD_SOURCE` build args and HEALTHCHECK
- [ ] `deploy/env-contract.yaml` documents all env keys
- [ ] `deploy/compose.gtm-mcp.prod.yml` exists without `build:` key
- [ ] GitHub `production` environment created with all required secrets
- [ ] Push to main → CI passes → image lands on GHCR → container redeploys on H1

# 4. File Boundaries

## Surface A — Repo Files (`agent-1-cleanup`)

| Allowed (r/w) | Purpose |
|---|---|
| `.github/workflows/main.yml` | **DELETE** — dead npm publish |
| `.github/workflows/deploy.yml` | **DELETE** — dead Cloudflare Workers |
| `.github/workflows/ci.yml` | **CREATE** — lint + typecheck gate |
| `Dockerfile` | Add build args + HEALTHCHECK |
| `deploy/env-contract.yaml` | **CREATE** — env key registry |
| `deploy/compose.gtm-mcp.prod.yml` | **CREATE** — prod compose (no `build:`) |

| Read-only (r/o) | Purpose |
|---|---|
| `docker-compose.yml` | Reference existing dev compose |
| `package.json` | Check lint/build scripts |

## Surface B — Build+Deploy Workflow (`agent-2-pipeline`)

| Allowed (r/w) | Purpose |
|---|---|
| `.github/workflows/build-and-push-gtm-mcp.yml` | **CREATE** — Docker build, GHCR push, Coolify deploy |

| Read-only (r/o) | Purpose |
|---|---|
| `.github/workflows/ci.yml` | Reference CI gate pattern from Surface A |
| `Dockerfile` | Reference for build context |
| `deploy/compose.gtm-mcp.prod.yml` | Reference for image tag |
| (analygo-platform) `.github/workflows/build-and-push-images.yml` | Reference blueprint pattern |

## Surface C — GitHub Config (`agent-3-secrets`)

| Allowed (r/w) | Purpose |
|---|---|
| GitHub `production` environment | **CREATE** |
| `DEPLOY_SSH_KEY` secret | **SET** — base64 SSH private key |
| `DEPLOY_SSH_HOST` secret | **SET** — `root@62.238.4.165` |
| `COOLIFY_WEBHOOK` secret | **SET** — Coolify deploy URL |
| `COOLIFY_API_TOKEN` secret | **SET** — from `env.shared` |
| `CF_ACCESS_CLIENT_ID` secret | **SET** — Cloudflare Access service token |
| `CF_ACCESS_CLIENT_SECRET` secret | **SET** — Cloudflare Access service token |
| `DEPLOY_AUTOMATION_ENABLED` variable | **SET** — `"true"` |
| `IMAGE_TAG` variable | **SET** — `"main"` |

No repo files changed — this surface operates on GitHub via API.

# 5. Agent Assignments and Worktree Paths

| Agent | Surface | Wave | Worktree |
|-------|---------|------|----------|
| `agent-1-cleanup` | A — Repo Files | 1 | `../worktrees/A-gtm-cicd` |
| `agent-2-pipeline` | B — Build+Deploy | 1 | `../worktrees/B-gtm-cicd` |
| `agent-3-secrets` | C — GitHub Config | 2 | `../worktrees/C-gtm-cicd` |
| `agent-r-review` | REVIEW | 3 | `../worktrees/R-review-gtm-cicd` |

# 6. Dependencies and Wave Graph

```
Surface A (repo files) ──┐
                         ├──→ [Wave 1, independent — parallel]
Surface B (workflow)    ──┘

Surface C (secrets) ──→ depends on A + B (needs workflow file + env-contract to know what secrets to set)

Wave 2 complete ──→ AGENT-R (Wave 3, verify pipeline runs end-to-end)
```

# 7. Implementation Steps

## Surface A — Repo Files

### A.1 Delete dead workflows
Delete `.github/workflows/main.yml` and `.github/workflows/deploy.yml`.

### A.2 Create `ci.yml`
```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  lint-and-typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run build  # tsc typecheck
```

### A.3 Update Dockerfile
Add build args before ENTRYPOINT:
```dockerfile
ARG BUILD_SHA
ARG BUILD_DATE
ARG BUILD_SOURCE
ENV BUILD_SHA=${BUILD_SHA:-unknown} \
    BUILD_DATE=${BUILD_DATE:-unknown} \
    BUILD_SOURCE=${BUILD_SOURCE:-unknown}

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1
```

### A.4 Create `deploy/env-contract.yaml`
Document all env vars with ownership classes:
```yaml
service: gtm-mcp
env:
  - key: GOOGLE_CLIENT_ID
    class: secret
    owner: google-cloud-console
  - key: GOOGLE_CLIENT_SECRET
    class: secret
    owner: google-cloud-console
  - key: GOOGLE_REDIRECT_URI
    class: config
    owner: coolify
  - key: COOKIE_ENCRYPTION_KEY
    class: secret
    owner: admin
  - key: GTM_API_KEY
    class: secret
    owner: admin
    note: "Must match GTM_MCP_API_KEY in Aegis backend .env"
  - key: GTM_REFRESH_TOKEN
    class: secret
    owner: admin
    note: "Obtained via OAuth playground or mcp-remote authentication"
  - key: WORKER_HOST
    class: config
    owner: coolify
    value: "gtm-mcp.analygo.co"
  - key: HOSTED_DOMAIN
    class: config
    owner: admin
```

### A.5 Create `deploy/compose.gtm-mcp.prod.yml`
```yaml
services:
  gtm-mcp:
    image: ghcr.io/analygo/gtm-mcp:main
    ports:
      - "127.0.0.1:3000:3000"
    env_file:
      - .env
    volumes:
      - gtm-mcp-data:/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
volumes:
  gtm-mcp-data:
    external: true
```

## Surface B — Build+Deploy Workflow

### B.1 Create `build-and-push-gtm-mcp.yml`

Pattern: match `analygo-platform/.github/workflows/build-and-push-images.yml` but simplified for single-service:

```yaml
name: Build and Push GTM MCP
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ghcr.io/analygo/gtm-mcp
          tags: |
            type=raw,value=main
            type=sha,prefix=sha-
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          platforms: linux/amd64
          build-args: |
            BUILD_SHA=${{ github.sha }}
            BUILD_DATE=${{ github.event.head_commit.timestamp }}
            BUILD_SOURCE=${{ github.server_url }}/${{ github.repository }}/commit/${{ github.sha }}

  deploy:
    needs: build-and-push
    if: vars.DEPLOY_AUTOMATION_ENABLED == 'true'
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - name: SSH pre-pull
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.DEPLOY_SSH_HOST }}
          username: root
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          script: |
            docker pull ghcr.io/analygo/gtm-mcp:main
      - name: Trigger Coolify deploy
        run: |
          curl -sS -H "Authorization: Bearer ${{ secrets.COOLIFY_API_TOKEN }}" \
            -H "CF-Access-Client-Id: ${{ secrets.CF_ACCESS_CLIENT_ID }}" \
            -H "CF-Access-Client-Secret: ${{ secrets.CF_ACCESS_CLIENT_SECRET }}" \
            "${{ secrets.COOLIFY_WEBHOOK }}"
```

## Surface C — GitHub Config

### C.1 Create `production` environment
```bash
gh api --method PUT /repos/ANALYGO/analygo-gtm-mcp/environments/production
```

### C.2 Set secrets from existing shared values
- `DEPLOY_SSH_KEY` — from analygo-platform's existing deploy key (shared across projects)
- `DEPLOY_SSH_HOST` — `root@62.238.4.165`
- `COOLIFY_WEBHOOK` — get from Coolify UI or existing platform config
- `COOLIFY_API_TOKEN` — from `~/.analygo/env.shared`
- `CF_ACCESS_CLIENT_ID` — from existing platform secrets
- `CF_ACCESS_CLIENT_SECRET` — from existing platform secrets

### C.3 Set repo variables
- `DEPLOY_AUTOMATION_ENABLED` = `"true"`
- `IMAGE_TAG` = `"main"`

# 8. Todo List

- [ ] [USER] / — / Coordinate execution of surfaces according to wave dependencies
- [ ] [AGENT-1] / A / Delete dead Stape workflows, create ci.yml, update Dockerfile, create deploy/ files
- [ ] [AGENT-1] / A / Commit Surface A changes
- [ ] [AGENT-2] / B / Create build-and-push-gtm-mcp.yml workflow
- [ ] [AGENT-2] / B / Commit Surface B changes
- [ ] [AGENT-3] / C / Setup GitHub production environment, secrets, and variables
- [ ] [AGENT-3] / C / Commit Surface C changes
- [ ] [AGENT-R] / REVIEW / Verify workflows pass, image pushes, Coolify deploys

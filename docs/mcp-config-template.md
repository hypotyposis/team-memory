# MCP Config Template for Team Memory

This document provides ready-to-use configuration snippets for connecting an agent to the Team Memory MCP server.

## Prerequisites

1. The Team Memory backend is running (default: `http://localhost:3456`). The easiest way is the pre-built Docker image — see **[Docker self-host](#docker-self-host)** below.
2. The MCP server package is built: `cd packages/mcp-server && npm install && npm run build`
3. **Node.js 22** — the `command` in your MCP config must use the same Node version that built `better-sqlite3`. If you have multiple Node versions (e.g., nvm), use an absolute path to avoid ABI mismatch crashes. Or skip this entire class of problem by running the backend via the Docker image below.

## Docker self-host

A pinned image (`node:22-bookworm-slim` + `better-sqlite3` compiled against Node 22) is published on every push to `main`. Using it avoids the `better-sqlite3` ABI-mismatch class of boot-time crashes entirely — host Node version becomes irrelevant.

### Quick start — `docker run`

```bash
docker run -d \
  --name team-memory \
  -p 3456:3456 \
  -v team-memory-data:/data \
  -e EMBEDDING_API_KEY=sk-...           # optional; unset → embedding degrades gracefully \
  ghcr.io/hypotyposis/team-memory:latest
```

Then verify:

```bash
curl http://localhost:3456/health   # → {"status":"ok"}
```

Point your MCP config's `TEAM_MEMORY_URL` at `http://localhost:3456` exactly as in the snippets above — only the backend runtime changed, the MCP server still runs locally from your cloned repo.

### `docker compose` (recommended for teams)

A reference `docker-compose.yml` lives at the repo root. From a clone:

```bash
cp .env.example .env   # optional — override PORT / embedding config here
docker compose up -d
docker compose logs -f backend
```

The compose file defines a named volume `team-memory-data` mounted at `/data`, so the SQLite database persists across container restarts. Stop with `docker compose down`; to wipe the DB, `docker compose down -v`.

### Image tags

| Tag | Meaning |
|-----|---------|
| `:latest` | Latest successful build on `main` |
| `:sha-<commit>` | Immutable build for a specific `main` commit — pin this for pilot teams who need reproducibility |

Only `linux/amd64` is published in the initial release. ARM builds and Kubernetes manifests are deliberately out of scope; add later if adoption warrants.

### Environment variables

The image honors the same env vars as a local `node` process. Override any of the ones in [Environment Variables](#environment-variables) via `-e` / `--env-file`. The two most commonly set:

| Variable | Default in image | When to override |
|----------|------------------|------------------|
| `TEAM_MEMORY_DB` | `/data/team-memory.db` | Usually leave as-is — mount a volume at `/data` to persist. |
| `PORT` | `3456` | Change if `3456` is occupied on the host, and update your `TEAM_MEMORY_URL` accordingly. |

### API keys inside Docker

The backend CLI (`npm run keys create <owner>`) works the same way inside the container:

```bash
docker exec -it team-memory node packages/backend/dist/cli.js create my-agent-name
```

Copy the printed `tm_...` key into `TEAM_MEMORY_API_KEY` in your MCP config.

## Claude Code (claude_desktop_config.json)

Add this entry to your `mcpServers` configuration:

```json
{
  "mcpServers": {
    "team-memory": {
      "command": "node",
      "args": ["/absolute/path/to/team-memory/packages/mcp-server/dist/index.js"],
      "env": {
        "TEAM_MEMORY_URL": "http://localhost:3456",
        "TEAM_MEMORY_API_KEY": "<your-api-key>"
      }
    }
  }
}
```

Replace `/absolute/path/to/team-memory` with the actual path to your cloned repo, and `<your-api-key>` with the key generated for your agent (see M2 auth setup).

> **Multi-Node environments:** This only affects the MCP server process, not the backend. If your system has multiple Node versions, replace `"node"` with the absolute path to Node 22 (e.g., `/Users/you/.nvm/versions/node/v22.22.0/bin/node`) to prevent `better-sqlite3` ABI mismatch errors on the MCP server side. For the backend itself, prefer the [Docker image](#docker-self-host) — it sidesteps this class of problem entirely.

## Claude Code (project-scoped .mcp.json)

Place this file at the root of your project as `.mcp.json`:

```json
{
  "mcpServers": {
    "team-memory": {
      "command": "node",
      "args": ["./packages/mcp-server/dist/index.js"],
      "env": {
        "TEAM_MEMORY_URL": "http://localhost:3456",
        "TEAM_MEMORY_API_KEY": "<your-api-key>"
      }
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TEAM_MEMORY_URL` | `http://localhost:3456` | Backend API base URL |
| `TEAM_MEMORY_API_KEY` | (none) | API key for authentication. Owner is derived from the key. Required once M2 auth is enabled. |

## Available Tools After Connection

Once connected, your agent will have access to:

| Tool | Purpose |
|------|---------|
| `publish_knowledge` | Share a finding with the team |
| `query_knowledge` | Search knowledge by keywords (FTS5). Each call writes one first-class `query` event (with raw `query_text`, `result_count`, `project`, `search_mode`) and one `exposure` event per returned item — all sharing the same `request_id`. 0-hit searches still write the `query` row so they remain observable |
| `semantic_search` | Search knowledge by meaning using vector similarity — finds conceptually related items even when exact words differ. Same event semantics as `query_knowledge`. Failed embedding generation still writes a `query` row with `result_count=0` and `search_mode='semantic'` so the attempt is not silently dropped |
| `list_knowledge` | Browse knowledge by project/tags |
| `get_knowledge` | Read full detail of a knowledge item — produces a `view` event (carries the item's `project`). Pass optional `query_context` to label why you opened it |
| `reuse_feedback` | After using an item, report `useful` / `not_useful` / `outdated`. This is the **strong reuse signal** that drives the team's north-star metric |
| `update_knowledge` | Update metadata (tags, confidence, staleness, related_to) |

> **Reuse tracking requires an authenticated API key.** Unauthenticated reads still work, but the backend cannot attribute `query` / `exposure` / `view` events to a specific agent, so those interactions won't appear in reuse reports. Always configure `TEAM_MEMORY_API_KEY` to be counted.

> **Terminology — 4 first-class tracked interactions, but not 4 `event_type` values.** The schema has 3 event types in `usage_events` (`query` / `exposure` / `view`) plus a separate first-class `reuse_feedback` table. Please use "four first-class tracked interactions" (or list the names) rather than "four event types".

## Verification

After configuring, verify the connection by asking your agent:

> "List all knowledge items in the team-memory project."

If the agent successfully calls `list_knowledge`, the integration is working.

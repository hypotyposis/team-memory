# MCP Config Template for Team Memory

This document provides ready-to-use configuration snippets for connecting an agent to the Team Memory MCP server.

## Prerequisites

1. The Team Memory backend is running (default: `http://localhost:3456`)
2. The MCP server package is built: `cd packages/mcp-server && npm install && npm run build`
3. **Node.js 22** — the `command` in your MCP config must use the same Node version that built `better-sqlite3`. If you have multiple Node versions (e.g., nvm), use an absolute path to avoid ABI mismatch crashes.

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

> **Multi-Node environments:** If your system has multiple Node versions, replace `"node"` with the absolute path to Node 22 (e.g., `/Users/you/.nvm/versions/node/v22.22.0/bin/node`) to prevent `better-sqlite3` ABI mismatch errors.

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

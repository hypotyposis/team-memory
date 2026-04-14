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
| `query_knowledge` | Search knowledge by keywords (FTS5) |
| `list_knowledge` | Browse knowledge by project/tags |
| `get_knowledge` | Read full detail of a knowledge item |
| `update_knowledge` | Update metadata (tags, confidence, staleness, related_to) |

## Verification

After configuring, verify the connection by asking your agent:

> "List all knowledge items in the team-memory project."

If the agent successfully calls `list_knowledge`, the integration is working.

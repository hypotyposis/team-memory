# Team Memory

Team Memory is a shared knowledge layer for agent teams.

Instead of every agent keeping private notes and repeating the same repo analysis, agents publish structured knowledge items, other agents query them before starting work, and humans inspect the same knowledge through a read-only dashboard.

## What Problem It Solves

- Duplicate research: Agent B should not redo what Agent A already verified.
- Knowledge sunk in chat: findings become queryable records, not long message history.
- Slow cold start: new agents can browse existing project knowledge instead of starting from zero.
- Weak handoff: agents can cite a knowledge item ID or claim instead of re-explaining context.

## What This Repo Contains

Phase 1 ships four pieces:

```text
Agent / CLI
    |
    v
packages/mcp-server      MCP tools for agents
    |
    v
packages/backend         REST API + SQLite + FTS5 knowledge store
    |
    +--> packages/dashboard   Read-only web UI for humans
    |
    +--> e2e/scripts          Validation scripts for the main reuse flow
```

### Packages

| Path | Purpose |
| --- | --- |
| `packages/backend` | Hono API server, SQLite storage, FTS5 search, append-only supersede model |
| `packages/mcp-server` | 5 MCP tools that proxy agent calls to the backend |
| `packages/dashboard` | Read-only dashboard for browsing, filtering, and inspecting knowledge items |
| `e2e/scripts` | Demo and smoke scripts that validate publish -> query -> get flows |
| `CONTRIBUTING.md` | GitHub workflow, branch naming, review expectations |

## Core Concept: Knowledge Items

Each knowledge item is a structured claim, not an unstructured note dump.

Required fields:

- `claim`: one falsifiable conclusion
- `source[]`: where that conclusion came from
- `project`: which project it applies to
- `tags[]`: how to find it again
- `confidence`: `high | medium | low`
- `staleness_hint`: when to re-verify it
- `owner`: who published it

Important behavior:

- Core facts are append-only.
- If a fact changes, publish a new item and point `supersedes` at the old one.
- Search/list hide superseded entries by default.
- Agents are expected to `query_knowledge` before work and `publish_knowledge` after work.

## MCP Tools

The MCP bridge exposes five tools:

1. `publish_knowledge`
2. `query_knowledge`
3. `list_knowledge`
4. `get_knowledge`
5. `update_knowledge`

`update_knowledge` is metadata-only. If the actual claim changes, publish a new item instead of mutating history.

## REST API

The backend exposes five endpoints under `/api`:

- `POST /api/knowledge`
- `GET /api/knowledge/search?q=...`
- `GET /api/knowledge`
- `GET /api/knowledge/:id`
- `PATCH /api/knowledge/:id`

The model is intentionally small: publish, browse/search, inspect, and update metadata.

## Quick Start

### Prerequisites

- **Node.js 22** (pinned in `.nvmrc`). Run `nvm use` to switch automatically.
- `npm`
- macOS/Linux environment where `better-sqlite3` can build native deps

> **Node version matters:** `better-sqlite3` compiles native bindings tied to a specific Node ABI. If you install with one Node major version and run with another, you'll get an ABI mismatch crash. Use the same Node version for both `npm install` and runtime.

### 1. Start the backend

The backend defaults to port `3456`, but the current dashboard client points at `http://localhost:3457/api`.

The backend SQLite file also defaults to `<current working directory>/team-memory.db`. That is fine for quick local demos, but for any shared or long-running instance you should set `TEAM_MEMORY_DB` explicitly so the database location does not drift with the shell's CWD.

If you want the dashboard to work without editing source, run the backend on `3457`:

```bash
cd packages/backend
npm install
PORT=3457 TEAM_MEMORY_DB=/absolute/path/to/team-memory.db npm run dev
```

Health check:

```bash
curl http://localhost:3457/health
```

If you are running a shared backend for multiple agents, use an absolute path, for example:

```bash
TEAM_MEMORY_DB=/Users/you/.slock/shared/team-memory/team-memory.db
```

The backend key-management CLI uses the same env var, so point it at the same DB before creating or revoking keys:

```bash
TEAM_MEMORY_DB=/absolute/path/to/team-memory.db \
npm run keys --workspace=packages/backend -- create <owner>
```

### 2. Start the MCP server

Point it at the same backend URL:

```bash
cd packages/mcp-server
npm install
TEAM_MEMORY_URL=http://localhost:3457 npm run dev
```

### 3. Start the dashboard

```bash
cd packages/dashboard
npm install
npm run dev
```

Open `http://localhost:5173`.

### 4. Seed a sample knowledge item

```bash
curl -X POST http://localhost:3457/api/knowledge \
  -H "Content-Type: application/json" \
  -d '{
    "claim": "Infer monorepo uses dual deploy modes: control and inference",
    "source": ["infer/app.py", "infer/main.py"],
    "project": "infer-monorepo",
    "module": "core/deploy",
    "tags": ["architecture", "deploy-mode"],
    "confidence": "high",
    "staleness_hint": "Recheck if DEPLOY_MODE logic changes",
    "owner": "Jet"
  }'
```

### 5. Query it back

```bash
curl "http://localhost:3457/api/knowledge/search?q=deploy&project=infer-monorepo"
```

## How To Use It

### For agents

Recommended workflow:

1. Before starting work, call `query_knowledge` or `list_knowledge`.
2. Read the best match with `get_knowledge`.
3. Reuse that context in the new task instead of redoing the same analysis.
4. After finishing, `publish_knowledge` for any reusable finding.

The MVP success condition for this project is simple: Agent B should query Agent A's published knowledge and skip one round of repeated research.

### For humans

Use the dashboard to:

- browse by project, owner, and tag
- search claims by keyword
- inspect detail, sources, confidence, staleness, and supersede links

This is intentionally read-only in Phase 1.

## E2E Validation

The repo includes scripts for validating the main flow:

- HTTP path: publish -> search -> get
- MCP path: `publish_knowledge` -> `query_knowledge` -> `get_knowledge`

See `e2e/scripts/` for the current demo and smoke scripts.

## Current Phase 1 Status

Implemented:

- backend knowledge store + REST API
- MCP bridge with 5 tools
- read-only dashboard
- E2E validation scripts

Still intentionally limited:

- no auth or RBAC
- no vector search
- no subscription/notification layer
- no workflow engine or task management
- no repo-root dev orchestration yet

## Collaboration Workflow

Code collaboration now happens in GitHub, not in chat:

- changes go through PRs
- discussion goes in review comments
- problems and follow-ups go in issues
- branch names follow `<role>/<description>`

See `CONTRIBUTING.md` for the current workflow and CI expectations.

## Team

Current role map:

- `@zooey` — Team Lead
- `@Faye` — PM
- `@Spike` — Architect
- `@Jet` — Memory Keeper
- `@Ed` — Frontend Dev
- `@Ein` — Backend Dev
- `@umiri` — DevOps

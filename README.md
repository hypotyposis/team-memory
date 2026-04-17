# Team Memory

Team Memory is a shared knowledge layer for agent teams.

Instead of every agent keeping private notes and repeating the same repo analysis, agents publish structured knowledge items, other agents query them before starting work, and humans inspect the same knowledge through a read-only dashboard.

## What Problem It Solves

- Duplicate research: Agent B should not redo what Agent A already verified.
- Knowledge sunk in chat: findings become queryable records, not long message history.
- Slow cold start: new agents can browse existing project knowledge instead of starting from zero.
- Weak handoff: agents can cite a knowledge item ID or claim instead of re-explaining context.

## What This Repo Contains

```text
Agent / CLI
    |
    v
packages/mcp-server      MCP tools for agents (publish / query / semantic / reuse_feedback / start_task / end_task / ...)
    |
    v
packages/backend         REST API + SQLite + FTS5 + provider-agnostic semantic search
                         task sessions, reuse tracking, append-only supersede model
    |
    +--> packages/dashboard   Read-only web UI for humans, including a Reuse tab
    |
    +--> e2e/scripts          Validation scripts for the main reuse flow
```

### Packages

| Path | Purpose |
| --- | --- |
| `packages/backend` | Hono API server, SQLite storage, FTS5 + vector-hybrid search, task sessions, reuse tracking, append-only supersede model, admin key CLI |
| `packages/mcp-server` | MCP tools that proxy agent calls to the backend (see [MCP Tools](#mcp-tools) below) |
| `packages/dashboard` | Read-only dashboard for browsing, filtering, and inspecting knowledge items; includes a Reuse tab for team reuse metrics |
| `e2e/scripts` | Demo and smoke scripts that validate publish -> query -> get -> feedback flows |
| `docs/` | Agent behavior protocol, MCP config template, API reference (`docs/api.md`) |
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
- Agents are expected to query the team's memory before starting work (via `start_task` or `query_knowledge` / `semantic_search`) and publish any reusable finding after it (via `end_task({ findings })` or `publish_knowledge`).
- Reading and writing are both measurable: `view` and `reuse_feedback` records feed the reuse report.

## MCP Tools

The MCP bridge exposes nine tools, grouped by purpose:

**Knowledge reads**

1. `query_knowledge` — FTS5 keyword search
2. `semantic_search` — embedding-based similarity search
3. `list_knowledge` — browse by project / owner / tag
4. `get_knowledge` — open a specific item (emits a `view` event; accepts optional `query_context` and `task_id`)

**Knowledge writes**

5. `publish_knowledge` — publish a structured claim (supports `supersedes` for facts that change)
6. `update_knowledge` — metadata-only update (tags, confidence, staleness_hint, related_to). If a claim's meaning changes, publish a new item and point `supersedes` at the old one — do not mutate history.

**Reuse signal**

7. `reuse_feedback` — after opening an item, tell the system whether it was `useful`, `not_useful`, or `outdated`. This is the strong reuse signal that reports prioritize over raw views.

**Task sessions** (framework-neutral measurement primitive)

8. `start_task` — open a task session, run a hybrid search on the description, return `task_id` + matches. Even 0-hit sessions return a `task_id`.
9. `end_task` — close a task session; optionally accepts `findings[]` and publishes each as a knowledge item linked to the task via `task_publications`.

Once a task is open, agents can pass its `task_id` to any knowledge-read or feedback call to tie that interaction to the session. `completed` / `abandoned` task ids remain valid linkage targets for follow-up reads.

## REST API

The backend exposes the surface under `/api`:

- Knowledge: `POST /api/knowledge`, `GET /api/knowledge`, `GET /api/knowledge/:id`, `PATCH /api/knowledge/:id`, `GET /api/knowledge/search`, `GET /api/knowledge/semantic-search`
- Reuse feedback: `POST /api/knowledge/:id/feedback`
- Task sessions: `POST /api/tasks/start`, `POST /api/tasks/:task_id/end`
- Reports: `GET /api/reports/reuse`
- Health: `GET /health`

See [`docs/api.md`](docs/api.md) for the full request/response reference, query parameters, error codes, and the `task_id?` passthrough semantics.

## Quick Start

### Prerequisites

- **Node.js 22** (pinned in `.nvmrc`). Run `nvm use` to switch automatically.
- `npm`
- macOS/Linux environment where `better-sqlite3` can build native deps

> **Node version matters:** `better-sqlite3` compiles native bindings tied to a specific Node ABI. If you install with one Node major version and run with another, you'll get an ABI mismatch crash. Use the same Node version for both `npm install` and runtime.

Use `.env.example` as the canonical list of runtime variables. The repo does not auto-load that file for you, so either export variables in your shell or prefix them inline in the commands below.

### 1. Start the backend

The backend defaults to port `3456`. If that port is occupied, choose another one with `PORT`.

The backend SQLite file also defaults to `<current working directory>/team-memory.db`. That is fine for quick local demos, but for any shared or long-running instance you should set `TEAM_MEMORY_DB` explicitly so the database location does not drift with the shell's CWD.

Example using `3460`:

```bash
cd packages/backend
npm install
PORT=3460 npm run dev
```

Health check:

```bash
curl http://localhost:3460/health
```

If you are running a shared backend for multiple agents, use an absolute path, for example:

```bash
PORT=3460 \
TEAM_MEMORY_DB=/Users/you/.slock/shared/team-memory/team-memory.db \
npm run dev
```

The backend key-management CLI uses the same env var, so point it at the same DB before creating or revoking keys:

```bash
TEAM_MEMORY_DB=/absolute/path/to/team-memory.db \
npm run keys --workspace=packages/backend -- create <owner>
```

### 2. Start the MCP server

Point it at the same backend URL. If you customized `PORT`, update `TEAM_MEMORY_URL` to match:

```bash
cd packages/mcp-server
npm install
TEAM_MEMORY_URL=http://localhost:3460 npm run dev
```

### 3. Start the dashboard

Point the dashboard at the same backend URL with `VITE_API_BASE`:

```bash
cd packages/dashboard
npm install
VITE_API_BASE=http://localhost:3460/api npm run dev
```

Open `http://localhost:5173`.

### Port customization summary

If the default backend port is unavailable:

1. Pick any free port, for example `3460`
2. Start the backend with `PORT=<your-port>`
3. If the backend should not depend on shell CWD, also set `TEAM_MEMORY_DB=/absolute/path/to/team-memory.db`
4. Point the MCP server at `TEAM_MEMORY_URL=http://localhost:<your-port>`
5. Point the dashboard at `VITE_API_BASE=http://localhost:<your-port>/api`

The backend port, MCP URL, and dashboard API base must stay aligned.

### 4. Seed a sample knowledge item

```bash
curl -X POST http://localhost:3460/api/knowledge \
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
curl "http://localhost:3460/api/knowledge/search?q=deploy&project=infer-monorepo"
```

## How To Use It

### For agents

Recommended workflow (see [`docs/agent-protocol.md`](docs/agent-protocol.md) for the canonical version):

1. Before starting a task, call `start_task({ description, project })`. The response carries a `task_id` plus the best existing matches for your task.
2. If a match looks relevant, open it with `get_knowledge({ id, task_id, query_context })`.
3. After you know whether the item helped, call `reuse_feedback({ knowledge_id, verdict, task_id })` — `useful` / `not_useful` / `outdated`.
4. When done, call `end_task({ task_id, status, findings? })`. Any reusable conclusions you pass in `findings[]` get published as knowledge items linked to this task via `task_publications`.

`start_task` / `end_task` are a framework-neutral **measurement primitive**, not a workflow engine — they exist so reports can count "how often did querying the team's memory before work actually save a round of re-analysis?". Agents that don't open sessions still use `query_knowledge` / `semantic_search` / `get_knowledge` / `publish_knowledge` / `reuse_feedback` directly.

The success condition for this project is simple: Agent B should query Agent A's published knowledge and skip one round of repeated research — and the team should be able to see that happen in the Reuse tab.

### For humans

Use the dashboard to:

- browse by project, owner, and tag
- search claims by keyword
- inspect detail, sources, confidence, staleness, and supersede links

This is intentionally read-only in Phase 1.

## E2E Validation

The repo includes scripts for validating the main flow:

- HTTP path: publish → search → get → feedback
- MCP path: `publish_knowledge` → `query_knowledge` → `get_knowledge` → `reuse_feedback`
- Reuse loop: `e2e/scripts/reuse-loop.ts` exercises the end-to-end `start_task` → `get_knowledge` → `reuse_feedback` → `end_task` sequence and asserts the report surface

See `e2e/scripts/` for the current demo and smoke scripts.

## Current Status

Implemented:

- backend knowledge store + REST API
- MCP bridge (9 tools)
- read-only dashboard with Reuse tab
- E2E validation scripts (publish / query / view / feedback / task-session loops)
- API-key authentication and key-management CLI
- Hybrid search: FTS5 + provider-agnostic semantic embeddings (`EMBEDDING_API_KEY` / `EMBEDDING_API_BASE` / `EMBEDDING_MODEL`)
- Duplicate detection at publish time (configurable thresholds)
- Reuse tracking: `query` / `exposure` / `view` events plus first-class `reuse_feedback`; reuse report at `GET /api/reports/reuse`
- Task sessions: `start_task` / `end_task` primitive, `task_id?` passthrough on reads + feedback, `task_publications` provenance

Still intentionally limited:

- no subscription/notification layer
- no workflow engine — task sessions are a measurement primitive, not an orchestration runtime
- no repo-root dev orchestration beyond the quick-start scripts

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

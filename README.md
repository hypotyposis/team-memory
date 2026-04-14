# Team Memory

A shared knowledge layer for AI agent teams. Agents publish verified findings as knowledge items, and other agents can search, query, and reuse them — eliminating duplicate analysis.

## Architecture

```
packages/
├── backend/        # REST API server (Hono + SQLite + FTS5)
├── mcp-server/     # MCP bridge (5 tools → backend HTTP)
└── dashboard/      # Read-only web dashboard (React + Vite)
e2e/                # E2E validation scripts
docs/               # API contract and specs
```

## Quick Start

### Backend
```bash
cd packages/backend
npm install
npm run dev    # starts on http://localhost:3456
```

### Dashboard
```bash
cd packages/dashboard
npm install
npm run dev    # starts on http://localhost:5173
```

## Knowledge Item Schema

Each knowledge item has:
- **claim** — one verifiable statement
- **detail** — optional markdown elaboration
- **source** — array of evidence sources
- **project** / **module** — scoping
- **tags** — categorization
- **confidence** — high / medium / low
- **staleness_hint** — when to re-verify
- **owner** — who published it

Core fields (claim, detail, source, project, owner) are immutable. Knowledge evolves via `supersedes` — new items replace old ones, old items are auto-filtered from results.

## API

See [docs/api-contract.md](docs/api-contract.md) for the full REST API specification.

## Team

Built during the Team Memory hackathon (2026-04-14) by:
- @Spike (Architect) + @Jet (Memory Keeper) — Backend
- @Ed (Frontend Dev) — MCP Server + Dashboard
- @Ein (Backend Dev) — E2E Validation
- @Faye (PM) — Dashboard + Coordination
- @umiri (DevOps) — Repo Management

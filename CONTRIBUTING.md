# Contributing

## Branch Strategy

- **`main`** — Production-ready code. Protected branch. All changes via PR.
- **Feature branches** — Named `<role>/<description>`, e.g. `backend/add-pagination`, `frontend/search-ui`, `devops/ci-setup`.
- **Bugfix branches** — Named `fix/<description>`.

## Workflow

1. Create a feature branch from `main`
2. Make changes and push
3. Open a PR against `main`
4. CI must pass (build + lint + E2E)
5. Get review approval
6. Merge via squash merge

## CI

GitHub Actions runs on every push to `main` and every PR:
- **Build**: all 3 packages (backend, mcp-server, dashboard)
- **Lint**: dashboard ESLint
- **E2E**: starts backend, runs HTTP integration tests

## Packages

| Package | Directory | Dev Server | Build |
|---------|-----------|-----------|-------|
| Backend | `packages/backend` | `npm run dev` (port 3456) | `npm run build` |
| MCP Server | `packages/mcp-server` | `npm run dev` | `npm run build` |
| Dashboard | `packages/dashboard` | `npm run dev` (port 5173) | `npm run build` |

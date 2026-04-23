# Team Memory Quickstart

This is the 5-minute path for standing up one Team Memory instance with Docker, checking that it is healthy, minting an agent key, and publishing the first knowledge item.

For local source development instead of self-hosting, use the development notes in the root [`README.md`](../README.md#quick-start).

## Prerequisites

- Docker with the Compose v2 plugin (`docker compose ...`)
- `curl`
- A shell with `awk` for the key-capture one-liner below

No host Node.js install is required for the backend when using Docker. The image already includes Node 22 and native `better-sqlite3` bindings.

## Deployment model

Run one Team Memory instance per team. The instance has its own backend process and SQLite database. Inside that team instance, mint separate API keys for each agent or automation lane so writes keep attribution and optional project scoping.

Team Memory does not add a tenant layer inside one shared database. If you need isolation between teams, run another instance with a separate volume or database path.

## 1. Prepare environment

From the repo root:

```bash
cp .env.example .env
```

The defaults are enough for a local first run:

- Backend URL: `http://localhost:3456`
- SQLite data: Docker named volume `team-memory-data`, mounted at `/data/team-memory.db`
- Embeddings: disabled unless you set `EMBEDDING_API_KEY`

If port `3456` is occupied, edit `.env` and set `PORT=<free-port>` before starting the service.

## 2. Start the backend

```bash
docker compose up -d
```

Follow logs if startup fails:

```bash
docker compose logs -f backend
```

## 3. Check health

```bash
curl -s http://localhost:3456/health
```

Expected shape:

```json
{"status":"ok","primitive_batch":null}
```

`primitive_batch` is a string such as `"1"` for published primitive-batch images, and `null` for local builds or untagged images. Use this field to diagnose backend/MCP API skew when integrating against a Docker image.

## 4. Mint an agent key

Team Memory write endpoints require a Bearer token. Mint a scoped key inside the running container:

```bash
export TEAM_MEMORY_API_KEY="$(
  docker compose exec -T backend \
    node packages/backend/dist/cli.js create quickstart-agent --projects quickstart \
    | awk -F= '/^key=/{print $2}'
)"
```

Confirm the shell captured it:

```bash
test -n "$TEAM_MEMORY_API_KEY" && echo "key captured"
```

The CLI requires an explicit scope posture. Use `--projects <names>` for normal team usage. Use `--unscoped` only when you intentionally want no project restriction.

## 5. Publish first knowledge

```bash
curl -sS -X POST http://localhost:3456/api/knowledge \
  -H "Authorization: Bearer $TEAM_MEMORY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "claim": "Team Memory Docker quickstart can publish and search a first knowledge item.",
    "source": ["docs/quickstart.md"],
    "project": "quickstart",
    "tags": ["quickstart", "docker"],
    "confidence": "high",
    "staleness_hint": "Recheck when docker-compose.yml or the publish API changes."
  }'
```

The response body should include an `id`.

Common mistake: `source` and `tags` are arrays, not strings.

## 6. Search it back

```bash
curl -sS "http://localhost:3456/api/knowledge/search?q=docker&project=quickstart" \
  -H "Authorization: Bearer $TEAM_MEMORY_API_KEY"
```

Expected shape:

```json
{
  "items": [
    {
      "claim": "Team Memory Docker quickstart can publish and search a first knowledge item."
    }
  ],
  "total": 1
}
```

The real response includes additional fields such as `id`, `project`, `tags`, and `created_at`.

## 7. Connect an agent

Point your MCP client at the same backend:

```text
TEAM_MEMORY_URL=http://localhost:3456
TEAM_MEMORY_API_KEY=<the tm_... key you minted above>
```

Use [`docs/mcp-config-template.md`](mcp-config-template.md) for Claude, project `.mcp.json`, Codex, and wrapper-based per-agent key delegation examples.

## Stop or reset

Stop without deleting data:

```bash
docker compose down
```

Delete the local quickstart database too:

```bash
docker compose down -v
```

## Optional: admin key provisioning

The quickstart uses the container CLI because it works without enabling the dark admin surface.

If your launcher or orchestrator needs to mint keys over HTTP, set `TEAM_MEMORY_ADMIN_KEY` in `.env` before `docker compose up -d`, then call `POST /api/admin/keys` with:

```http
Authorization: Bearer <TEAM_MEMORY_ADMIN_KEY>
```

See [`docs/api.md#admin-key-management`](api.md#admin-key-management) for the exact request and response contract.

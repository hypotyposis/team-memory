# Per-Agent Key Delegation

Per-agent key delegation gives each agent in a team its own `TEAM_MEMORY_API_KEY`, so every write carries correct `owner` attribution and every read is scoped to the team's project namespace. This operates within a **single shared TM instance per team** — it is not multi-tenancy.

## How it works

```
Agent process (CWD contains agent UUID)
  └─► Wrapper shim (reads UUID → lane → key from mapping files)
        └─► Sets TEAM_MEMORY_API_KEY in env
              └─► Starts real MCP server (packages/mcp-server/dist/index.js)
                    └─► MCP server reads TEAM_MEMORY_API_KEY, sends Bearer token
                          └─► Backend attributes events to key's owner
```

The wrapper runs **at MCP-server launch time**, before the real MCP server process starts. It resolves the spawning agent's identity from the filesystem and injects the corresponding API key as an environment variable. The MCP server itself is unmodified.

## Env-injection contract

| Variable | Set by | Consumed by | Purpose |
|----------|--------|-------------|---------|
| `TEAM_MEMORY_API_KEY` | Wrapper or native launcher | MCP server (`packages/mcp-server/src/index.ts`) | Bearer token for all backend requests |
| `TEAM_MEMORY_URL` | MCP config (unchanged) | MCP server | Backend base URL (default `http://localhost:3456`) |

The wrapper **must not** set `TEAM_MEMORY_API_KEY` if the variable is already present in the environment. An explicitly-set key takes precedence — this allows per-invocation overrides for testing or migration.

## Mapping files

Two JSON files, co-located in the deployment directory:

### `agent-uuid-to-lane.json`

Maps agent runtime UUIDs to human-readable lane names. Changes when team topology changes (agents added/removed).

```json
{
  "041677cc-323f-4e9b-ad48-89f3e16d91d5": "@dev-2",
  "dab7b9d2-14c4-4182-8e47-05c979e5d2bd": "@dev-ops-1",
  "82159c8d-7e09-4b9e-895e-6cb727ba7cb6": "@dev-1"
}
```

**Schema:** `Record<string, string>` — keys are UUIDv4, values are lane names (by convention prefixed with `@`).

### `per-lane-keys.json`

Maps lane names to TM API keys. Changes when keys are rotated or new lanes are provisioned.

```json
{
  "@dev-2": "tm_abc123...",
  "@dev-ops-1": "tm_def456...",
  "@dev-1": "tm_ghi789..."
}
```

**Schema:** `Record<string, string>` — keys are lane names (matching values in `agent-uuid-to-lane.json`), values are `tm_*` API key secrets.

### Why two files

UUID-to-lane mapping is **deployment-mechanical** (changes per team topology). Lane-to-key mapping is **auth-mechanical** (changes on key rotation). Separating them means key rotation does not touch the topology file, and adding an agent does not touch the secrets file.

## Agent identity resolution

The wrapper resolves identity from the spawning process's working directory:

```javascript
const uuidMatch = process.cwd().match(/\/\.slock\/agents\/([0-9a-f-]{36})(?:\/|$)/);
```

This works for any launcher that starts MCP server processes from within agent workspace directories (the standard Slock agent layout: `~/.slock/agents/<uuid>/...`).

For non-Slock deployments, the UUID source can be adapted — the contract is: "the wrapper must be able to determine the agent's identity at startup and map it to an API key." Common alternatives:
- Environment variable (`AGENT_ID` or `AGENT_UUID`) set by the launcher
- Command-line argument passed by the launcher
- Filesystem convention specific to the deployment platform

## Fall-through behavior

If any step in the resolution chain fails, the wrapper falls through to **anonymous mode**:

| Failure | Behavior |
|---------|----------|
| UUID not extractable from CWD | No key injected → anonymous MCP |
| UUID not in `agent-uuid-to-lane.json` | No key injected → anonymous MCP |
| Lane not in `per-lane-keys.json` | No key injected → anonymous MCP |
| Mapping file missing or unreadable | No key injected → anonymous MCP |
| `TEAM_MEMORY_API_KEY` already set | Existing key preserved (no override) |

Anonymous mode preserves unauthenticated read functionality (`query_knowledge`, `semantic_search`, `list_knowledge`, `get_knowledge`). Operations that require auth — all writes (`publish_knowledge`, `update_knowledge`, `reuse_feedback`) and task sessions (`start_task`, `end_task`) — will fail with 401. This is the correct signal that key provisioning is incomplete.

### Startup logging

The wrapper **must** log its resolution outcome to stderr at startup. This is always-on, not gated behind a debug flag — silent fall-through caused delayed diagnosis in the pilot (discovered via missing `By:` attribution, not via logs).

**Log format:**

```
[tm-mcp-wrapper] lane=@dev-1 mode=keyed key=tm_abc12...
```

On fall-through:

```
[tm-mcp-wrapper] lane=<unresolved> mode=anonymous reason=no-uuid-in-cwd
[tm-mcp-wrapper] lane=<unresolved> mode=anonymous reason=uuid-not-in-mapping
[tm-mcp-wrapper] lane=@dev-1 mode=anonymous reason=lane-has-no-key
[tm-mcp-wrapper] lane=<unresolved> mode=anonymous reason=ENOENT
```

On explicit key (pre-set in env):

```
[tm-mcp-wrapper] mode=explicit key=tm_def45...
```

The `key=` field shows the first 8 characters only — enough to identify which key without leaking the full secret. The `reason=` field on anonymous mode maps directly to the resolution chain failure point.

## Reference implementation

The reference implementation lives at `examples/tm-mcp-wrapper.mjs`. See the file directly for the full source — it implements the resolution chain, fall-through behavior, and startup logging described in this spec.

### MCP config using the wrapper

Point your MCP config `args` at the wrapper instead of the MCP server directly:

```json
{
  "mcpServers": {
    "team-memory": {
      "command": "node",
      "args": ["/path/to/deploy/examples/tm-mcp-wrapper.mjs"],
      "env": {
        "TEAM_MEMORY_URL": "http://localhost:3456",
        "TM_DEPLOY_DIR": "/path/to/deploy"
      }
    }
  }
}
```

For Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.team-memory]
command = "node"
args = ["/path/to/deploy/examples/tm-mcp-wrapper.mjs"]

[mcp_servers.team-memory.env]
TEAM_MEMORY_URL = "http://localhost:3456"
TM_DEPLOY_DIR = "/path/to/deploy"
```

## Provisioning keys

Before the wrapper can delegate, each agent needs a key in the backend:

```bash
# Via CLI (direct DB access, from packages/backend)
cd packages/backend
npm run keys -- create "@dev-1" --projects my-team

# Via admin API (remote)
curl -X POST http://localhost:3456/api/admin/keys \
  -H "Authorization: Bearer $TEAM_MEMORY_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"owner": "@dev-1", "default_projects": ["my-team"]}'
```

Then add the UUID mapping and key to the mapping files. See the field table in [mcp-config-template.md](mcp-config-template.md#environment-variables) for what `TEAM_MEMORY_API_KEY` does when omitted.

## Native launcher injection (future)

When the host launcher natively supports per-agent env injection (e.g., Slock daemon's `-c mcp_servers.team_memory.env.TEAM_MEMORY_API_KEY="<key>"`), the wrapper becomes unnecessary:

1. Remove the wrapper from MCP config `args` — point directly at `packages/mcp-server/dist/index.js`
2. Delete `agent-uuid-to-lane.json` and `per-lane-keys.json` (the launcher manages the mapping)
3. Delete the wrapper file

The MCP server and backend require **zero changes** — they only see `TEAM_MEMORY_API_KEY` in the environment regardless of how it got there. The wrapper is explicitly designed to be deletable in one config change.

## Scope clarification

- This pattern is **per-agent attribution within a single team**, not multi-tenancy across teams
- Each team runs its own TM instance; this pattern handles key-per-agent within that instance
- The `default_projects` on each key scopes reads to the team's namespace (see [A2 namespace inheritance](api.md))
- An agent with an unscoped key sees all projects in the instance — use scoped keys for isolation

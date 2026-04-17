# Team Memory REST API Reference

This document is the canonical reference for the HTTP surface exposed by `packages/backend`. The MCP bridge in `packages/mcp-server` ultimately calls these endpoints — reading this doc is equivalent to reading the wire contract for every agent tool.

For recommended agent workflows (when to publish, when to call `reuse_feedback`, when to open a task session), see [`agent-protocol.md`](agent-protocol.md).

---

## Base URL and conventions

- All endpoints are mounted under `/api` (health is under `/health`, not `/api/health`).
- Request and response bodies are JSON, UTF-8 encoded.
- Timestamps are ISO-8601 strings (`2026-04-17T18:42:25.123Z`).
- `id` values are UUIDv4 strings.
- Unknown query parameters are ignored.
- Error responses have the shape `{ "error": string }` for legacy endpoints and `{ "error": string, "code": string }` for the task-session and task-trace surfaces. The `code` is stable; `error` is human-readable and may be reworded.

## Authentication

The backend uses a simple Bearer token model. Agent keys are minted either with the admin CLI (`npm run keys --workspace=packages/backend -- create <owner> (--projects alpha,beta | --unscoped)`) or programmatically via `POST /api/admin/keys` when `TEAM_MEMORY_ADMIN_KEY` is enabled. Each key identifies an owner plus an explicit scope posture: either a default-project namespace (`default_projects`: a non-empty `string[]`) when minted with `--projects <names>` / `default_projects`, or no project restriction (`default_projects` is `null`) when minted with `--unscoped` / `unscoped: true`. The CLI `create` and `update-key` subcommands require one of those two scope flags; there is no silent default.

Three auth postures show up below:

| Posture | Behavior |
|---|---|
| **Required** | Missing/invalid `Authorization` header returns `401`. The caller's owner is used for writes and event attribution. |
| **Optional (read tracking)** | The endpoint serves requests without auth. Providing a valid `Authorization: Bearer <api_key>` header causes the read to be logged as a `view` / `exposure` / `query` event for reuse tracking. |
| **Optional (passthrough)** | Same as "optional (read tracking)", but the endpoint additionally accepts a `task_id` (query or body). If `task_id` is provided, auth becomes effectively required: `401` on missing auth, `403` on foreign task owner, `404` on unknown task id. |

The task-session endpoints (`/api/tasks/*`) always require auth.

Header format:

```
Authorization: Bearer <api_key>
```

---

## Admin key management

The `/api/admin/*` surface is a framework-neutral provisioning primitive for orchestrators, launchers, and CI that need to mint or revoke Team Memory API keys without shelling into the backend host.

Admin routes are **dark by default**:

- If `TEAM_MEMORY_ADMIN_KEY` is unset, all `/api/admin/*` routes return `404`.
- If the admin bearer token is missing or wrong, all `/api/admin/*` routes also return `404`.
- This is intentional: the admin surface does not advertise its existence to unauthenticated probing.

Admin header format:

```http
Authorization: Bearer <TEAM_MEMORY_ADMIN_KEY>
```

### `POST /api/admin/keys`

Mint a new API key. **Admin auth required.**

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `owner` | string | yes | Non-empty string. Becomes the owner attached to writes and observability rows. |
| `default_projects` | string[] | conditional | Required unless `unscoped` is `true`. Must be a non-empty array of non-empty strings. `[]` and `["*"]` are invalid — use `unscoped: true` for an explicit opt-out. |
| `unscoped` | boolean | conditional | Must be `true` when you want no default-project restriction. Cannot be combined with `default_projects`. |
| `description` | string | no | Optional operator note. Blank strings normalize to `null`. |
| `expires_at` | string | no | Optional ISO-8601 timestamp. Past timestamps are accepted; the key simply expires immediately. |

**Scoped request example**

```json
{
  "owner": "release-bot",
  "default_projects": ["hackathon"],
  "description": "pilot key for release automation",
  "expires_at": "2026-04-24T23:59:59Z"
}
```

**Explicit unscoped request example**

```json
{
  "owner": "release-bot",
  "unscoped": true,
  "description": "cross-project break-glass key"
}
```

**Response — 201**

```json
{
  "id": "key_abc123",
  "key": "tm_xxxxxxxxxxxxxxxxxxxxxxxx",
  "owner": "release-bot",
  "default_projects": ["hackathon"],
  "unscoped": false,
  "description": "pilot key for release automation",
  "created_at": "2026-04-17T19:00:00.000Z",
  "expires_at": "2026-04-24T23:59:59.000Z",
  "last_used_at": null,
  "revoked_at": null
}
```

`key` is returned **once** at creation time. Later list/update endpoints never echo the secret back.

**Errors**

| Status | Code / shape | Condition |
|---|---|---|
| 400 | `admin_owner_required` | `owner` omitted |
| 400 | `admin_owner_invalid` | `owner` not a non-empty string |
| 400 | `admin_default_projects_required` | neither `default_projects` nor `unscoped: true` provided |
| 400 | `admin_default_projects_invalid` | `default_projects` is not a non-empty string array |
| 400 | `admin_unscoped_invalid` | `unscoped` provided but not boolean |
| 400 | `admin_scope_conflict` | `default_projects` combined with `unscoped: true` |
| 400 | `admin_description_invalid` | `description` provided but not string/null |
| 400 | `admin_expires_at_invalid` | `expires_at` provided but not ISO-8601 |
| 404 | `{ "error": "Not found" }` | `TEAM_MEMORY_ADMIN_KEY` unset, missing admin bearer, or wrong admin bearer |

### `GET /api/admin/keys`

List minted API keys. **Admin auth required.**

**Response — 200**

```json
{
  "items": [
    {
      "id": "key_abc123",
      "owner": "release-bot",
      "default_projects": ["hackathon"],
      "unscoped": false,
      "description": "pilot key for release automation",
      "created_at": "2026-04-17T19:00:00.000Z",
      "expires_at": "2026-04-24T23:59:59.000Z",
      "last_used_at": "2026-04-17T19:10:00.000Z",
      "revoked_at": null
    }
  ]
}
```

The secret `key` field is intentionally omitted.

### `PATCH /api/admin/keys/:id`

Update a key's scope metadata. **Admin auth required.**

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `default_projects` | string[] | conditional | Same validation as `POST`. |
| `unscoped` | boolean | conditional | Same validation as `POST`. |
| `description` | string or `null` | no | Set to `null` to clear. |
| `expires_at` | string or `null` | no | Set to `null` to clear. |

At least one field must be provided. Scope updates use the same contract as `POST`: either a non-empty `default_projects` array or explicit `unscoped: true`.

**Response — 200** — same shape as a `GET` list item.

**Errors**

| Status | Code / shape | Condition |
|---|---|---|
| 400 | `admin_update_empty` | No updatable fields provided |
| 400 | `admin_*` validation codes above | Invalid scope / description / expiry fields |
| 404 | `admin_key_not_found` | Unknown key id or already revoked |
| 404 | `{ "error": "Not found" }` | Admin auth disabled or wrong admin bearer |

### `DELETE /api/admin/keys/:id`

Revoke a key. **Admin auth required.**

**Response — 204**

No body.

**Errors**

| Status | Code / shape | Condition |
|---|---|---|
| 404 | `admin_key_not_found` | Unknown key id or already revoked |
| 404 | `{ "error": "Not found" }` | Admin auth disabled or wrong admin bearer |

---

## Health

### `GET /health`

Returns service liveness. No auth.

**Response — 200**

```json
{ "status": "ok" }
```

---

## Knowledge

### `POST /api/knowledge`

Publish a new knowledge item. **Auth required.**

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `claim` | string | yes | One falsifiable conclusion. |
| `source` | string[] | yes | Non-empty array of citations (file paths, URLs, PR numbers). |
| `project` | string | yes | Project namespace. |
| `module` | string | no | Optional sub-module within the project. |
| `tags` | string[] | yes | Non-empty array. |
| `confidence` | `"high" \| "medium" \| "low"` | yes | |
| `staleness_hint` | string | yes | Trigger condition for re-verification. |
| `detail` | string | no | Longer body text. |
| `related_to` | string[] | no | Array of existing knowledge ids; invalid ids return `400`. |
| `supersedes` | string | no | Existing knowledge id. Sets `superseded_by` on the referenced item. |

**Minimal valid request body**

```json
{
  "claim": "FTS5 sanitizer tokenizes user input before MATCH",
  "source": ["packages/backend/src/routes.ts"],
  "project": "team-memory",
  "tags": ["architecture", "search"],
  "confidence": "high",
  "staleness_hint": "Recheck if FTS5 syntax extensions change."
}
```

Note that `source` and `tags` are **string arrays**, not strings — a common first-attempt mistake when seeding manually. The response body includes a `warnings[]` array when the publish encounters a possible-duplicate match (configurable via the duplicate-detection thresholds). Duplicates are surfaced as warnings, not errors — the item is still persisted.

**Response — 201**

```json
{
  "id": "…",
  "claim": "…",
  "source": ["…"],
  "project": "…",
  "module": null,
  "tags": ["…"],
  "confidence": "high",
  "staleness_hint": "…",
  "detail": null,
  "owner": "alice",
  "related_to": [],
  "supersedes": null,
  "superseded_by": null,
  "duplicate_of": null,
  "created_at": "…",
  "updated_at": "…",
  "warnings": []
}
```

**Errors**

| Status | Error shape | Condition |
|---|---|---|
| 400 | `{ "error": "Missing required fields: …" }` | Required field missing or empty |
| 400 | `{ "error": "source must be a non-empty array of strings" }` | `source` empty/invalid |
| 400 | `{ "error": "tags must be a non-empty array of strings" }` | `tags` empty/invalid |
| 400 | `{ "error": "confidence must be one of: high, medium, low" }` | Invalid confidence |
| 400 | `{ "error": "Related item not found: …" }` | `related_to` contains unknown id |
| 401 | `{ "error": "…", "code": "auth_missing" }` | Authorization header omitted |
| 401 | `{ "error": "…", "code": "auth_invalid" }` | Authorization header present but token does not match an active API key |

### `GET /api/knowledge`

List knowledge items. No auth (unauthenticated listing; does not record `usage_events`).

**Query parameters**

| Param | Meaning |
|---|---|
| `project` | Filter by project. When omitted on an authenticated request, the caller's API-key `default_projects` scope applies. Use `*` to opt out back to unscoped reads. An empty query value (`?project=`) is treated as a literal override to the project name `""`, not as omission/inheritance. |
| `owner` | Filter by owner |
| `tags` | Comma-separated; items match if they carry **any** of the listed tags (OR semantics) |
| `include_superseded` | `true` to include superseded entries (default `false`) |
| `limit` | Integer, defaults to 50 (capped at 200) |
| `offset` | Integer, defaults to 0 |

**Response — 200**

```json
{ "items": [ { … knowledge row … } ], "total": 123 }
```

### `GET /api/knowledge/:id`

Retrieve a single knowledge item. Optional auth (read tracking); optional `task_id` passthrough.

**Query parameters**

| Param | Meaning |
|---|---|
| `query_context` | Optional label attached to the resulting `view` event (recommended when the read follows a search) |
| `task_id` | Optional task session id to link this view to |

When auth is provided, a `usage_events` row with `event_type='view'` is written. When `task_id` is provided, auth is required (see [Authentication](#authentication)).

**Response — 200** — knowledge row (same shape as the `POST` response, without `warnings`).

**Errors**

| Status | Code | Condition |
|---|---|---|
| 404 | — | Knowledge id not found |
| 401 | `auth_missing` | `task_id` provided without Authorization header |
| 401 | `auth_invalid` | `task_id` provided with an Authorization header whose token does not match an active API key |
| 404 | `task_not_found` | `task_id` does not exist |
| 403 | `task_owner_forbidden` | `task_id` owned by a different user |

### `PATCH /api/knowledge/:id`

Metadata-only update. **Auth required.**

Only the following fields are mutable: `tags`, `confidence`, `staleness_hint`, `related_to`, `duplicate_of`. Claims are append-only — if a claim's meaning changes, publish a new item with `supersedes` set.

**Response — 200** — updated knowledge row.

**Errors** — `400` for invalid field values; `401` `auth_missing` / `auth_invalid` as described above; `404` if the id does not exist.

---

## Knowledge search

### `GET /api/knowledge/search`

FTS5 keyword search. Optional auth (read tracking); optional `task_id` passthrough.

User text is sanitized before it reaches the FTS5 `MATCH` clause: tokens are extracted (`[\p{L}\p{N}_]+`), FTS reserved keywords (`AND` / `OR` / `NOT` / `NEAR`) are dropped, and each remaining token is quoted as a literal term. Descriptions containing hyphens, colons, boolean keywords, or unicode text therefore return results (or an empty array) rather than 500.

**Query parameters**

| Param | Meaning |
|---|---|
| `q` | **Required.** Search text. |
| `project` | Filter by project. When omitted on an authenticated request, the caller's API-key `default_projects` scope applies. Use `*` to opt out back to unscoped reads. An empty query value (`?project=`) is treated as a literal override to the project name `""`, not as omission/inheritance. |
| `module` | Filter by module |
| `tags` | Comma-separated; items match if they carry **any** of the listed tags (OR semantics) |
| `include_superseded` | `true` to include superseded entries |
| `limit` | Integer, defaults to 20 (capped at 100) |
| `task_id` | Optional task session linkage |

**Response — 200**

```json
{
  "items": [ { …knowledge row…, "search_mode": "fts", "score": 0.87 } ],
  "total": 5
}
```

When authenticated, each returned item is recorded as an `exposure` event sharing a `request_id` with the parent `query` event.

**Errors** — `400` when `q` is missing; passthrough auth errors as documented above.

### `GET /api/knowledge/semantic-search`

Embedding-based similarity search. Optional auth (read tracking); optional `task_id` passthrough. If query-embedding generation fails, the endpoint still returns `200` with an empty `items` array (observability rows still record the failure when authenticated).

**Query parameters**

| Param | Meaning |
|---|---|
| `q` | **Required.** Natural-language query. |
| `project` | Filter by project. When omitted on an authenticated request, the caller's API-key `default_projects` scope applies. Use `*` to opt out back to unscoped reads. An empty query value (`?project=`) is treated as a literal override to the project name `""`, not as omission/inheritance. |
| `limit` | Integer, defaults to 10 (capped at 100) |
| `task_id` | Optional task session linkage |

**Response — 200**

```json
{
  "items": [ { …knowledge row…, "similarity": 0.72 } ],
  "total": 5
}
```

Each item is a knowledge-row summary with a `similarity` score (cosine against the query embedding). `total` is the count of rows that had embeddings and were considered (i.e. pre-`limit` eligible pool), not the count returned.

---

## Reuse feedback

### `POST /api/knowledge/:id/feedback`

Record a verdict on a knowledge item. **Auth required.** Optional `task_id` linkage.

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `verdict` | `"useful" \| "not_useful" \| "outdated"` | yes | |
| `comment` | string | no | Free-form note |
| `task_id` | string | no | Task session linkage |

**Minimal valid request body**

```json
{
  "verdict": "useful",
  "comment": "Fixed my FTS5 tokenization question on first read."
}
```

`verdict` is the only required field — the example above includes `comment` because feedback without a one-line justification is harder to audit later.

**Response — 201**

```json
{ "knowledge_id": "…", "owner": "alice", "verdict": "useful", "comment": null, "created_at": "…" }
```

`task_id` is persisted to the `reuse_feedback` row when provided in the request, but the response body does not echo it.

**Errors** — `400` on invalid verdict; `401` `auth_missing` / `auth_invalid`; `404` if knowledge id not found; task-trace auth errors as documented.

---

## Task sessions

Task sessions are a framework-neutral measurement primitive. `start_task` opens a session and returns matches for the task description; `end_task` closes it and optionally publishes findings linked via `task_publications`. State is not a permission boundary — `completed` and `abandoned` sessions remain valid linkage targets for follow-up reads and feedback.

### `POST /api/tasks/start`

Open a task session. **Auth required.**

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `description` | string | yes | Non-empty after trim. Can contain arbitrary punctuation and operator-like words; FTS sanitization is internal. |
| `project` | string | no | Scope hybrid search to a project. When omitted, authenticated callers inherit their API-key `default_projects` scope. Use `"*"` to opt out back to unscoped retrieval. An empty string is treated as the literal project name `""`, not as omission/inheritance. |
| `max_matches` | integer | no | Range `[1, 100]` at the REST layer, default `10`. The MCP bridge exposes a narrower `[1, 50]` cap — agents calling `start_task` via MCP will hit a client-side validation error above 50. Direct REST callers can use the full `[1, 100]` range. |

The session is persisted with the **raw** description (before sanitization). Hybrid search runs with `search_mode: "hybrid"` and is recorded as a `query` event with `task_id` linked.

**Minimal valid request body**

```json
{
  "description": "Investigate why FTS5 MATCH returns 0 hits on hyphenated tokens",
  "project": "team-memory"
}
```

`description` is the only required field. The example pins `project` to a single namespace for clarity — see the field table above for what `project` does when omitted.

**Response — 201**

```json
{
  "task_id": "…",
  "description": "…",
  "project": "…" | null,
  "retrieval_mode": "fts" | "hybrid",
  "matches": [ { …knowledge row…, "search_mode": "fts" | "hybrid", "score": 0.81 } ]
}
```

Match rows mirror the shape returned by `GET /api/knowledge/search` — each row is a knowledge-row summary plus `search_mode` and `score`. 0-hit sessions still return `201` with `task_id` and `matches: []`. Failed-embedding queries still return `201` on the FTS path; the query row records the failure for reuse-report observability.

The response `project` field echoes the effective single-project scope label when one exists (explicit project or a single inherited default project). It is `null` for multi-project inherited scope and fully unscoped sessions.

**Errors**

| Status | Code | Condition |
|---|---|---|
| 400 | `task_description_required` | `description` missing, empty, or whitespace-only |
| 400 | `task_description_invalid` | `description` is not a string |
| 400 | `task_project_invalid` | `project` provided but not a string |
| 400 | `task_max_matches_invalid` | `max_matches` not an integer in `[1, 100]` |
| 401 | `auth_missing` | Authorization header omitted |
| 401 | `auth_invalid` | Authorization header present but the token does not match an active API key |

### `POST /api/tasks/:task_id/end`

Close a task session and optionally publish findings. **Auth required.** Only the task's owner can close it, and only sessions currently in `open` state can be closed (re-closing returns `409`).

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | `"completed" \| "abandoned"` | no | Defaults to `"completed"` when omitted. Cannot be `"open"`. |
| `findings` | array of publish bodies | no | Each entry is a `POST /api/knowledge` body (minus `owner`, which is inferred). Published atomically per finding; linked to the task via `task_publications`. |

Closure happens first (status + `closed_at` written). Then findings are published sequentially; the first failure short-circuits.

**Response — 200 (success)**

```json
{ "task_id": "…", "status": "completed", "published_ids": ["…","…"], "duration_ms": 1234 }
```

**Response — 400 (partial publish failure)** — body carries `published_ids[]` for findings that succeeded before the failure, plus an `error` object identifying the failing index:

```json
{
  "task_id": "…",
  "status": "completed",
  "published_ids": ["id-0"],
  "duration_ms": 1234,
  "error": {
    "code": "task_publish_failed",
    "failed_index": 1,
    "publish_status": 400,
    "publish_error": "Missing required fields: staleness_hint"
  }
}
```

The task is left in the closed state regardless of publish outcome — retrying `end_task` on a closed task returns `409`. To publish additional findings after close, use `POST /api/knowledge` directly (the session-external retry will not count toward `task_publications` provenance — this is intentional).

**Errors**

| Status | Code | Condition |
|---|---|---|
| 400 | `task_status_invalid` | `status` provided but not `"completed"` or `"abandoned"` (omitted is legal — defaults to `"completed"`) |
| 400 | `task_findings_invalid` | `findings` provided but not an array |
| 401 | `auth_missing` | Authorization header omitted |
| 401 | `auth_invalid` | Authorization header present but the token does not match an active API key |
| 403 | `task_owner_forbidden` | Caller is not the task owner |
| 404 | `task_not_found` | `task_id` does not exist |
| 409 | `task_already_closed` | Session is already `completed` or `abandoned` |
| 400 | `task_publish_failed` | See partial-failure body above |

---

## Reports

### `GET /api/reports/reuse`

Team-wide reuse snapshot. No auth.

**Query parameters (M1b)**

| Param | Meaning |
|---|---|
| `since=Nd` | Restrict the slice to events newer than `N` days (e.g. `7d`, `30d`). Filters `usage_events` and `reuse_feedback` rows; does **not** filter the knowledge baseline. Omit for lifetime. `400` if the format isn't `Nd`. |
| `project=<name>` | Scope both knowledge baseline and event slice to one project |
| `min_age_days=N` | Only filters the `never_accessed` **list** (hide items younger than `N` days). Does not affect `never_accessed_pct`, which always uses the unfiltered baseline. `400` if not a non-negative integer. |

**Response — 200**

| Field | Meaning |
|---|---|
| `total_queries` | Count of `query` rows in the slice. Includes 0-hit and failed-embedding queries. |
| `hit_rate` | `queries_with_result / total_queries`. `0` when there are no queries. |
| `total_views` | Count of `view` rows in the slice. |
| `total_items` | Total knowledge rows (filtered by `project` if provided; not filtered by `since`). |
| `never_accessed` | Items with no `exposure` / `view` / `feedback` **within the slice**. Slice-relative: an item whose events are all older than the cutoff still appears here. Further filtered by `min_age_days` if provided. |
| `never_accessed_pct` | `baseNeverAccessed / total_items` — uses the **unfiltered** baseline (independent of `min_age_days`) so the percentage stays comparable across age thresholds. |
| `feedback_coverage` | `(viewedPairs ∩ feedbackPairs) / viewedPairs.size` where each pair is `(owner, knowledge_id)`. Slice-relative. `0` when no views in slice. |
| `top_0hit_keywords` | Top 10 0-hit search queries in the slice, each `{ normalized_key, example_text, query_count }`. Normalization: `trim + lowercase + collapse whitespace`. Sorted by `query_count` desc then `example_text` asc. |
| `north_star_count` | Items used by ≥ 2 distinct owners via `view` or `useful` feedback (slice-relative). |
| `north_star_pct` | `north_star_count / total_items`. |
| `north_star` | **Deprecated** back-compat alias for `north_star_pct`. Will be removed. |
| `top_reused` | Top 10 items by `view_count + useful_feedback_count`, per-owner uniqueness tiebreaker (slice-relative). |

---

## Error code catalog

Task-session, task-trace, and admin-key endpoints return `{ error, code }` with a stable `code`. The full set:

| Code | Status | Surface |
|---|---|---|
| `auth_missing` | 401 | Any auth-required endpoint (`PATCH /knowledge/:id`, `POST /knowledge/:id/feedback`, `POST /tasks/start`, `POST /tasks/:id/end`) or any optional-auth endpoint with `task_id` passthrough when the caller omits the Authorization header |
| `auth_invalid` | 401 | Same surfaces — Authorization header present, but the bearer token does not match an active API key |
| `admin_owner_required` | 400 | `POST /admin/keys` |
| `admin_owner_invalid` | 400 | `POST /admin/keys` |
| `admin_default_projects_required` | 400 | `POST /admin/keys`, `PATCH /admin/keys/:id` |
| `admin_default_projects_invalid` | 400 | `POST /admin/keys`, `PATCH /admin/keys/:id` |
| `admin_unscoped_invalid` | 400 | `POST /admin/keys`, `PATCH /admin/keys/:id` |
| `admin_scope_conflict` | 400 | `POST /admin/keys`, `PATCH /admin/keys/:id` |
| `admin_description_invalid` | 400 | `POST /admin/keys`, `PATCH /admin/keys/:id` |
| `admin_expires_at_invalid` | 400 | `POST /admin/keys`, `PATCH /admin/keys/:id` |
| `admin_update_empty` | 400 | `PATCH /admin/keys/:id` |
| `admin_key_not_found` | 404 | `PATCH /admin/keys/:id`, `DELETE /admin/keys/:id` |
| `task_description_required` | 400 | `POST /tasks/start` |
| `task_description_invalid` | 400 | `POST /tasks/start` |
| `task_project_invalid` | 400 | `POST /tasks/start` |
| `task_max_matches_invalid` | 400 | `POST /tasks/start` |
| `task_status_invalid` | 400 | `POST /tasks/:id/end` |
| `task_findings_invalid` | 400 | `POST /tasks/:id/end` |
| `task_not_found` | 404 | `POST /tasks/:id/end`, any passthrough surface |
| `task_owner_forbidden` | 403 | `POST /tasks/:id/end`, any passthrough surface |
| `task_already_closed` | 409 | `POST /tasks/:id/end` |
| `task_publish_failed` | 400 | `POST /tasks/:id/end` (partial-publish body) |

Legacy endpoints (`/knowledge/*` without task-session semantics) return `{ error }` without a `code`. The admin-auth dark surface intentionally returns bare `404` (no `code`) when `TEAM_MEMORY_ADMIN_KEY` is unset or the admin bearer is missing/wrong; once a caller is on the authenticated admin path, validation and lookup failures use `{ error, code }`.

---

## Observability: what gets written to `usage_events` and `reuse_feedback`

This is useful context for dashboard and report consumers:

- `query_knowledge` / `semantic_search` / `start_task` each write **one** `usage_events` row with `event_type='query'` carrying `query_text` (raw), `result_count`, `project`, `search_mode`, and a `request_id`.
- Each item returned in a search response writes **one** `usage_events` row with `event_type='exposure'` sharing the parent `request_id`.
- `get_knowledge` writes **one** `usage_events` row with `event_type='view'`, carrying optional `query_context` and `task_id`.
- `reuse_feedback` writes **one** row in the dedicated `reuse_feedback` table, carrying `verdict`, `comment`, and optional `task_id`.
- `end_task(findings)` writes one `task_publications(task_id, knowledge_id)` row per successfully published finding, in the same transaction as the `knowledge` insert.

Reports prioritize `view` + `reuse_feedback` over `exposure` for reuse metrics. Exposure is tracked for search-effectiveness analysis only.

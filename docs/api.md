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

The backend uses a simple Bearer token model. Tokens are minted with the admin CLI (`npm run keys --workspace=packages/backend -- create <owner>`) and identify an owner plus optional default project.

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

The response body includes a `warnings[]` array when the publish encounters a possible-duplicate match (configurable via the duplicate-detection thresholds). Duplicates are surfaced as warnings, not errors — the item is still persisted.

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
| 401 | — | Missing/invalid Authorization |

### `GET /api/knowledge`

List knowledge items. Optional auth (read tracking).

**Query parameters**

| Param | Meaning |
|---|---|
| `project` | Filter by project |
| `owner` | Filter by owner |
| `tags` | Comma-separated; items must carry all listed tags |
| `include_superseded` | `true` to include superseded entries (default `false`) |
| `limit` | Integer, defaults to 50 |
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
| 401 | `auth_missing` | `task_id` provided without Authorization |
| 404 | `task_not_found` | `task_id` does not exist |
| 403 | `task_owner_forbidden` | `task_id` owned by a different user |

### `PATCH /api/knowledge/:id`

Metadata-only update. **Auth required.**

Only the following fields are mutable: `tags`, `confidence`, `staleness_hint`, `related_to`, `duplicate_of`. Claims are append-only — if a claim's meaning changes, publish a new item with `supersedes` set.

**Response — 200** — updated knowledge row.

**Errors** — `400` for invalid field values; `401` on missing auth; `404` if the id does not exist.

---

## Knowledge search

### `GET /api/knowledge/search`

FTS5 keyword search. Optional auth (read tracking); optional `task_id` passthrough.

User text is sanitized before it reaches the FTS5 `MATCH` clause: tokens are extracted (`[\p{L}\p{N}_]+`), FTS reserved keywords (`AND` / `OR` / `NOT` / `NEAR`) are dropped, and each remaining token is quoted as a literal term. Descriptions containing hyphens, colons, boolean keywords, or unicode text therefore return results (or an empty array) rather than 500.

**Query parameters**

| Param | Meaning |
|---|---|
| `q` | **Required.** Search text. |
| `project` | Filter by project |
| `module` | Filter by module |
| `tags` | Comma-separated; items must carry all listed tags |
| `include_superseded` | `true` to include superseded entries |
| `limit` | Integer |
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

Embedding-based similarity search. Optional auth; optional `task_id` passthrough. Falls back to pure FTS if embedding generation fails.

**Query parameters**

| Param | Meaning |
|---|---|
| `query` | **Required.** Natural-language query. |
| `project`, `module`, `tags`, `include_superseded`, `limit`, `task_id` | Same semantics as `/knowledge/search` |

**Response — 200**

```json
{
  "items": [ { …knowledge row…, "search_mode": "semantic" \| "hybrid", "score": 0.72 } ],
  "total": 5,
  "retrieval_mode": "hybrid"
}
```

`retrieval_mode` is one of `"fts"`, `"semantic"`, or `"hybrid"`.

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

**Response — 201**

```json
{ "id": "…", "knowledge_id": "…", "owner": "alice", "verdict": "useful", "comment": null, "task_id": null, "created_at": "…" }
```

**Errors** — `400` on invalid verdict; `401` on missing auth; `404` if knowledge id not found; task-trace auth errors as documented.

---

## Task sessions

Task sessions are a framework-neutral measurement primitive. `start_task` opens a session and returns matches for the task description; `end_task` closes it and optionally publishes findings linked via `task_publications`. State is not a permission boundary — `completed` and `abandoned` sessions remain valid linkage targets for follow-up reads and feedback.

### `POST /api/tasks/start`

Open a task session. **Auth required.**

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `description` | string | yes | Non-empty after trim. Can contain arbitrary punctuation and operator-like words; FTS sanitization is internal. |
| `project` | string | no | Scope hybrid search to a project |
| `max_matches` | integer | no | Range `[1, 100]` at the REST layer, default `10`. The MCP bridge exposes a narrower `[1, 50]` cap — agents calling `start_task` via MCP will hit a client-side validation error above 50. Direct REST callers can use the full `[1, 100]` range. |

The session is persisted with the **raw** description (before sanitization). Hybrid search runs with `search_mode: "hybrid"` and is recorded as a `query` event with `task_id` linked.

**Response — 201**

```json
{
  "task_id": "…",
  "description": "…",
  "project": "…" | null,
  "retrieval_mode": "fts" | "semantic" | "hybrid",
  "matches": [ { …knowledge row…, "search_mode": "hybrid", "score": 0.81 } ]
}
```

0-hit sessions still return `201` with `task_id` and `matches: []`. Failed-embedding queries still return `201`; the query row records the failure for reuse-report observability.

**Errors**

| Status | Code | Condition |
|---|---|---|
| 400 | `task_description_required` | `description` missing, empty, or whitespace-only |
| 400 | `task_description_invalid` | `description` is not a string |
| 400 | `task_project_invalid` | `project` provided but not a string |
| 400 | `task_max_matches_invalid` | `max_matches` not an integer in `[1, 100]` |
| 401 | — | Missing/invalid Authorization |

### `POST /api/tasks/:task_id/end`

Close a task session and optionally publish findings. **Auth required.** Only the task's owner can close it, and only sessions currently in `open` state can be closed (re-closing returns `409`).

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | `"completed" \| "abandoned"` | yes | Cannot close as `open`. |
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
| 400 | `task_status_invalid` | `status` missing or not `completed`/`abandoned` |
| 400 | `task_findings_invalid` | `findings` provided but not an array |
| 401 | — | Missing/invalid Authorization |
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

Task-session and task-trace endpoints return `{ error, code }` with a stable `code`. The full set:

| Code | Status | Surface |
|---|---|---|
| `auth_missing` | 401 | Any endpoint with `task_id` passthrough if the caller omits auth |
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

Legacy endpoints (`/knowledge/*` without task-session semantics) return `{ error }` without a `code`. New error surfaces added after A1 should follow the `{ error, code }` pattern.

---

## Observability: what gets written to `usage_events` and `reuse_feedback`

This is useful context for dashboard and report consumers:

- `query_knowledge` / `semantic_search` / `start_task` each write **one** `usage_events` row with `event_type='query'` carrying `query_text` (raw), `result_count`, `project`, `search_mode`, and a `request_id`.
- Each item returned in a search response writes **one** `usage_events` row with `event_type='exposure'` sharing the parent `request_id`.
- `get_knowledge` writes **one** `usage_events` row with `event_type='view'`, carrying optional `query_context` and `task_id`.
- `reuse_feedback` writes **one** row in the dedicated `reuse_feedback` table, carrying `verdict`, `comment`, and optional `task_id`.
- `end_task(findings)` writes one `task_publications(task_id, knowledge_id)` row per successfully published finding, in the same transaction as the `knowledge` insert.

Reports prioritize `view` + `reuse_feedback` over `exposure` for reuse metrics. Exposure is tracked for search-effectiveness analysis only.

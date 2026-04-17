# Agent Behavior Protocol for Team Memory

This document defines how agents should interact with Team Memory in their daily workflows. The goal is simple: **no agent should redo work that another agent already published**.

## How Team Memory Measures Reuse

Every interaction with a knowledge item is recorded so we can tell whether the system is actually saving work. The model has **four first-class tracked interactions** — learn these names, they show up in tool descriptions, reports, and the dashboard.

| Term | How it's produced | What it means |
|------|-------------------|---------------|
| **query** | You call `query_knowledge` or `semantic_search`. Each call writes one `usage_events` row with `event_type='query'`, the raw `query_text`, the `result_count`, the `project`, and a `search_mode` (`fts` / `semantic` / `hybrid`) | You asked the team's memory a question — including 0-hit searches and searches whose embedding generation failed |
| **exposure** | One `usage_events` row with `event_type='exposure'` is written for each item returned in your search results, sharing the same `request_id` as its parent `query` row | The item was offered to you but you may not have opened it |
| **view** | A `usage_events` row with `event_type='view'` is written when you call `get_knowledge` on an item | You opened the full detail — a weak reuse signal |
| **feedback** | A row is written in the dedicated `reuse_feedback` table when you call the `reuse_feedback` tool | You explicitly told the system whether the item helped — the strong reuse signal |

In P0.1, `query` is a first-class row in `usage_events` (alongside `exposure` and `view`); `feedback` is a separate first-class table. So the schema persists **3 event types in `usage_events` plus 1 first-class `reuse_feedback` record** — please do not call this "four event types", it implies feedback is in the `event_type` enum.

This is a reversal of the earlier P0 design that derived `query` from `COUNT(DISTINCT request_id)` over `exposure` rows. The reversal makes 0-hit and failed-embedding searches observable, which is why the reuse report now exposes `total_queries` and `hit_rate`.

Reports prioritize `view` + `feedback` over `exposure` for the real reuse metrics (north star, top reused). Exposure is tracked for search-effectiveness analysis only.

**Practical takeaway:** every `get_knowledge` should be followed by a `reuse_feedback` once you know whether it helped. Without feedback, the team only sees weak signals.

### What the reuse report exposes

`GET /api/reports/reuse` returns the team-wide reuse snapshot.

**Query parameters (M1b):**

| Param | Meaning |
|-------|---------|
| `?since=Nd` | Restrict the slice to events newer than `N` days (e.g. `7d`, `30d`). Filters `usage_events` and `reuse_feedback` rows; does NOT filter the knowledge baseline. Omit for lifetime data. Returns `400` if the format isn't `Nd` |
| `?project=<name>` | Scope both the knowledge baseline and the event slice to a single project |
| `?min_age_days=N` | Only filters the `never_accessed` **list** (hide items younger than `N` days). Never affects `never_accessed_pct` — the percentage always uses the unfiltered baseline. Returns `400` if not a non-negative integer |

**Response fields:**

| Field | Meaning |
|-------|---------|
| `total_queries` | Count of `query` rows in the slice. Includes 0-hit and failed-embedding queries |
| `hit_rate` | `queries_with_result / total_queries`. `0` when there are no queries |
| `total_views` | Count of `view` rows in the slice |
| `total_items` | Total knowledge rows (filtered by `?project=` if provided; not filtered by `?since=`) |
| `never_accessed` | Items with **no** `exposure`, `view`, or `feedback` *within the slice* (P0 original semantic — kept stable on purpose, not silently redefined). **Slice-relative under `?since=`:** an item with all events older than the cutoff still appears here. Further filtered by `?min_age_days=` if provided |
| `never_accessed_pct` | `baseNeverAccessed.length / total_items` — uses the **unfiltered** baseline (independent of `?min_age_days=`) so the percentage stays comparable across age thresholds |
| `feedback_coverage` | `(viewedPairs ∩ feedbackPairs) / viewedPairs.size` where each pair is `(owner, knowledge_id)`. Slice-relative under `?since=`. `0` when no views in slice. Computed at the report layer — there is no schema unique constraint on `(owner, knowledge_id)` |
| `top_0hit_keywords` | Top 10 0-hit search queries in the slice, each `{ normalized_key, example_text, query_count }`. Normalization: `trim + lowercase + collapse whitespace`, applied at aggregation time. Sorted by `query_count` desc, then `example_text` asc |
| `north_star_count` | Items used by ≥ 2 distinct owners via `view` or `useful` feedback (slice-relative under `?since=`) |
| `north_star_pct` | `north_star_count / total_items` |
| `north_star` | **Deprecated** — back-compat alias for `north_star_pct`. New code should read `north_star_pct` (and/or `north_star_count`); this field will be removed in a future release |
| `top_reused` | Top 10 items by `view_count + useful_feedback_count`, with per-owner uniqueness tiebreaker (slice-relative under `?since=`) |

## Core Workflow

### 1. Query Before Work

Before starting any task, query Team Memory for existing knowledge. Use **both** keyword and semantic search for best coverage:

```
query_knowledge({ query: "<task topic>", project: "<project>" })
semantic_search({ query: "<natural language description of your task>", project: "<project>" })
```

- `query_knowledge` uses keyword matching (FTS5) — best for exact terms, function names, error messages.
- `semantic_search` uses vector similarity — best for conceptual queries where the exact words may differ.

If results are found, read the full item and tag what you were doing so reuse can be measured:

```
get_knowledge({ id: "<matched-id>", query_context: "<task or question you're working on>" })
```

- `query_context` is optional but strongly recommended. It attaches a label to the `view` event so reports can show **why** each item was opened (e.g. `"task #42: billing refund investigation"`).

Use existing knowledge as context. Skip analysis that has already been done. If the existing knowledge is outdated, supersede it (see below).

### Give Reuse Feedback

After you finish using a knowledge item, tell the system whether it helped:

```
reuse_feedback({
  knowledge_id: "<matched-id>",
  verdict: "useful" | "not_useful" | "outdated",
  comment: "<optional one-line note>"
})
```

| verdict | When to use |
|---------|-------------|
| `useful` | It answered your question or saved you work |
| `not_useful` | Irrelevant to your task, or the claim turned out to be wrong |
| `outdated` | Used to be true but no longer applies (consider also publishing a superseding item) |

Feedback is how the team knows which items are worth keeping. **Skipping this is the single biggest reason metrics go stale.** Treat `reuse_feedback` as mandatory when you open an item, not as optional.

### 2. Publish After Work

After completing a task that produced a reusable conclusion, publish it:

```
publish_knowledge({
  claim: "One falsifiable conclusion",
  source: ["file.ts", "https://..."],
  project: "project-name",
  tags: ["relevant", "tags"],
  confidence: "high",
  staleness_hint: "Recheck when X changes"
})
```

> **Note on `owner`:** Your `owner` identity is automatically derived from your API key. You do not need to pass it explicitly.

Not everything needs to be published. Publish when:
- You discovered something that other agents are likely to need
- You verified a non-obvious fact about the codebase or system
- You made an architectural or design decision with rationale

Do NOT publish:
- Ephemeral task status ("I started working on X")
- Obvious facts derivable from reading the code
- Conversation summaries or meeting notes

### 3. Supersede When Facts Change

If you discover that an existing knowledge item is wrong or outdated:

```
publish_knowledge({
  claim: "Updated conclusion",
  ...other fields,
  supersedes: "<old-item-id>"
})
```

Do NOT use `update_knowledge` to change the meaning of a claim. `update_knowledge` is for metadata corrections only (tags, confidence, staleness_hint, related_to).

## Writing Good Claims

A claim should be **one falsifiable conclusion**, not a vague note.

| Bad | Good |
|-----|------|
| "Looked at the deploy system" | "infer-monorepo uses DEPLOY_MODE env var to switch between control and inference modes" |
| "Auth is complicated" | "The auth middleware stores session tokens in cookies, not in the database" |
| "Billing might have issues" | "saved_usd calculation double-counts refunds when a subscription is cancelled mid-cycle" |

Rules:
- One claim per item. If you have three findings, publish three items.
- Be specific enough that another agent can act on it without reading the source.
- Include the "so what" -- why does this matter for the project?

## Choosing Confidence

| Level | Meaning | When to use |
|-------|---------|-------------|
| `high` | Verified by reading code or running tests | You traced the code path, ran the test, saw the output |
| `medium` | Strong evidence but not fully verified | You read the code but didn't test edge cases |
| `low` | Inferred or suspected | Pattern-based reasoning, secondhand information |

When in doubt, use `medium`. A `low` confidence item is still more useful than no item at all.

## Writing Staleness Hints

A staleness hint tells future agents **when to re-verify** this knowledge.

| Bad | Good |
|-----|------|
| "Might change" | "Recheck if DEPLOY_MODE logic in app.py changes" |
| "Probably stable" | "Stable unless billing provider API version is upgraded" |
| "Check periodically" | "Re-verify after next database migration" |

Be specific about the trigger condition, not about time.

## Using related_to

Link knowledge items that are conceptually connected:

```
publish_knowledge({
  claim: "...",
  related_to: ["<id-of-related-item>"],
  ...
})
```

Use this when:
- Two items are about the same subsystem from different angles
- One item provides context that helps understand another
- Items represent alternatives or trade-offs

## Workflow Examples

### Example 1: Starting a New Task

```
# Step 1: Check what's known (keyword search)
query_knowledge({ query: "billing refund", project: "infer-monorepo" })

# Step 1b: Also try semantic search for broader matches
semantic_search({ query: "how are refunds processed in the billing system", project: "infer-monorepo" })

# Step 2: Found relevant item, read full detail with query_context
get_knowledge({
  id: "abc-123",
  query_context: "investigating refund webhook signature validation"
})

# Step 3: Use that context in your work, skip re-analysis
# ...do the task...

# Step 4: Tell the system whether abc-123 actually helped
reuse_feedback({
  knowledge_id: "abc-123",
  verdict: "useful",
  comment: "Confirmed webhook handler path, saved a round of tracing"
})

# Step 5: Publish your new finding
publish_knowledge({
  claim: "Refund webhook handler in billing/webhooks.ts does not validate event signatures",
  source: ["billing/webhooks.ts:42-58"],
  project: "infer-monorepo",
  module: "billing",
  tags: ["billing", "security"],
  confidence: "high",
  staleness_hint: "Recheck if webhook handler is refactored",
  related_to: ["abc-123"]
})
```

### Example 2: Correcting Outdated Knowledge

```
# Found that item xyz-789 says "auth uses JWT" but it's been changed to session cookies
publish_knowledge({
  claim: "Auth middleware now uses session cookies instead of JWT (changed in PR #45)",
  source: ["auth/middleware.ts", "PR #45"],
  project: "infer-monorepo",
  module: "auth",
  tags: ["auth", "architecture"],
  confidence: "high",
  staleness_hint: "Recheck if auth middleware is refactored",
  supersedes: "xyz-789"
})
```

### Example 3: Cold-Start Exploration

```
# New to the project, browse what's known
list_knowledge({ project: "infer-monorepo", limit: 20 })

# Read interesting items
get_knowledge({ id: "..." })
```

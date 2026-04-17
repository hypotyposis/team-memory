# Agent Behavior Protocol for Team Memory

This document defines how agents should interact with Team Memory in their daily workflows. The goal is simple: **no agent should redo work that another agent already published**.

## How Team Memory Measures Reuse

Every interaction with a knowledge item is recorded so we can tell whether the system is actually saving work. The model uses four distinct event types — learn these names, they show up in tool descriptions, reports, and the dashboard.

| Event | How it's produced | What it means |
|-------|-------------------|---------------|
| **query** | You call `query_knowledge` or `semantic_search` | You asked the team's memory a question |
| **exposure** | An item appeared in your search results | The item was offered to you but you may not have opened it |
| **view** | You call `get_knowledge` on an item | You opened the full detail — a weak reuse signal |
| **feedback** | You call `reuse_feedback` with a verdict | You explicitly told the system whether the item helped — the strong reuse signal |

Reports prioritize `view` + `feedback` over `exposure` for the real reuse metrics (north star, top reused). Exposure is tracked for search-effectiveness analysis only.

**Practical takeaway:** every `get_knowledge` should be followed by a `reuse_feedback` once you know whether it helped. Without feedback, the team only sees weak signals.

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

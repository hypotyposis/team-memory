# System Prompt Snippet for Team Memory

Copy the section below into your agent's system prompt or CLAUDE.md to enable Team Memory integration.

---

## Snippet

```markdown
## Team Memory

You have access to a shared team knowledge base via the Team Memory MCP tools. Use it to avoid duplicate work and share your findings.

### Before starting a task

1. Call `query_knowledge` with keywords related to your task and the project name.
2. Call `semantic_search` with a natural language description of your task — this finds conceptually related knowledge even when exact keywords differ.
3. If results are found, call `get_knowledge` to read the full detail. Pass `query_context` describing what task prompted the view.
4. Use existing knowledge as context. Do not redo analysis that has already been published.

### After using a knowledge item

Every `get_knowledge` call should be followed by a `reuse_feedback` call once you know whether the item helped:

- `useful` — answered your question or saved you work.
- `not_useful` — irrelevant to your task, or the claim was wrong.
- `outdated` — used to be true but no longer applies (consider also publishing a superseding item).

Skipping feedback means the team can't measure which knowledge is actually valuable. Treat `reuse_feedback` as mandatory, not optional.

### After completing a task

If you discovered something reusable (architectural insight, verified behavior, non-obvious finding), publish it:

- Call `publish_knowledge` with a single, falsifiable claim.
- Your `owner` identity is automatically set from your API key — do not pass it manually.
- Set `confidence` based on your verification level: `high` (tested/traced), `medium` (read code), `low` (inferred).
- Set `staleness_hint` to describe when this knowledge should be re-verified.
- If your finding contradicts an existing item, use `supersedes` to link to the old item.

### Rules

- One claim per knowledge item. Multiple findings = multiple publishes.
- Do not publish ephemeral status, obvious facts, or conversation summaries.
- Use `update_knowledge` only for metadata changes (tags, confidence, staleness_hint, related_to), never to change the claim itself.
- When superseding, always publish a new item rather than editing the old one.
- Always give `reuse_feedback` after `get_knowledge`. This is how the team measures which knowledge saves time.
```

---

## Usage

**For Claude Code agents (CLAUDE.md):**

Add the snippet above to your project's `CLAUDE.md` file. Claude Code reads this file automatically at the start of each session.

**For other agent frameworks:**

Append the snippet to your agent's system prompt or instruction set. Ensure the Team Memory MCP server is configured in the agent's tool list (see `docs/mcp-config-template.md`).

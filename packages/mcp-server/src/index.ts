#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ApiClient } from "./api-client.js";

const BACKEND_URL = process.env.TEAM_MEMORY_URL ?? "http://localhost:3456";
const API_KEY = process.env.TEAM_MEMORY_API_KEY;

const client = new ApiClient(BACKEND_URL, API_KEY);
const server = new McpServer({
  name: "team-memory",
  version: "0.1.0",
});

// --- Tool 1: publish_knowledge ---
server.tool(
  "publish_knowledge",
  "Publish a new knowledge item to the team shared memory. Use this after completing a task to share key findings with the team.",
  {
    claim: z.string().describe("A single, falsifiable conclusion (required)"),
    detail: z.string().optional().describe("Detailed explanation in markdown (optional)"),
    source: z.array(z.string()).min(1).describe("What evidence supports this claim — repo URLs, file paths, task links (required, at least one)"),
    project: z.string().describe("Project name this knowledge applies to, e.g. 'infer-monorepo' (required)"),
    module: z.string().optional().describe("Module or topic within the project (optional)"),
    tags: z.array(z.string()).min(1).describe("Domain tags, e.g. ['architecture', 'billing'] (required, at least one)"),
    confidence: z.enum(["high", "medium", "low"]).describe("How confident you are in this claim (required)"),
    staleness_hint: z.string().describe("Under what conditions this knowledge may become stale (required)"),
    owner: z.string().optional().describe("Your agent name (auto-filled from API key if configured)"),
    related_to: z.array(z.string()).optional().describe("IDs of related knowledge items (optional)"),
    supersedes: z.string().optional().describe("ID of an older knowledge item this one replaces (optional)"),
  },
  async (args) => {
    try {
      const item = await client.publish(args);
      return {
        content: [{
          type: "text" as const,
          text: `Knowledge published successfully.\n\nID: ${item.id}\nClaim: ${item.claim}\nProject: ${item.project}${item.module ? `\nModule: ${item.module}` : ""}\nConfidence: ${item.confidence}\nCreated: ${item.created_at}${item.supersedes ? `\nSupersedes: ${item.supersedes}` : ""}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }], isError: true };
    }
  }
);

// --- Tool 2: query_knowledge ---
server.tool(
  "query_knowledge",
  "Search the team knowledge base by keywords (FTS, with optional semantic rerank). Use this before starting a task to check what the team already knows about a topic. Each authenticated call records a first-class `query` event (query_text, result_count, project, search_mode) and shares a request_id with any `exposure` events written for the returned items — 0-hit searches are still recorded so 'nobody knew about X' shows up in the reuse report. If a task session has been opened with `start_task`, you may pass its `task_id` as an optional trace-linkage key so the resulting query/exposure events tie back to the task in reuse reports; calls without `task_id` remain fully supported.",
  {
    query: z.string().describe("Search keywords"),
    tags: z.array(z.string()).optional().describe("Filter by tags (optional)"),
    project: z.string().optional().describe("Filter by project (optional)"),
    module: z.string().optional().describe("Filter by module (optional)"),
    limit: z.number().int().min(1).max(50).optional().describe("Max results to return (default 10, max 50)"),
    task_id: z.string().optional().describe("Optional trace/measurement linkage to a task session you own. Not required; omitting it is a fully valid call. Unknown `task_id`s or `task_id`s owned by a different caller are rejected (404 / 403). Sessions in `completed` / `abandoned` state remain valid linkage targets — state is not a permission boundary. This is a trace key, not a workflow/assignment/ownership primitive."),
  },
  async (args) => {
    try {
      const results = await client.query(args);
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No knowledge items found matching your query." }] };
      }
      const lines = results.map(
        (r, i) => `${i + 1}. [${r.id}] (${r.confidence}) ${r.claim}\n   Project: ${r.project}${r.module ? ` / ${r.module}` : ""} | Tags: ${r.tags.join(", ")} | By: ${r.owner} | ${r.created_at}${r.staleness_hint ? `\n   Staleness: ${r.staleness_hint}` : ""}`
      );
      return { content: [{ type: "text" as const, text: `Found ${results.length} knowledge item(s):\n\n${lines.join("\n\n")}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }], isError: true };
    }
  }
);

// --- Tool 3: semantic_search ---
server.tool(
  "semantic_search",
  "Search the team knowledge base using semantic similarity (vector search). Use this when keyword search misses relevant results — it finds conceptually related knowledge even if the exact words differ. Like query_knowledge, each authenticated call records a first-class `query` event (search_mode='semantic') that shares a request_id with the resulting `exposure` rows; even failed embeddings log a query row with result_count=0 so the attempt stays observable. If a task session has been opened with `start_task`, you may pass its `task_id` as an optional trace-linkage key; calls without `task_id` remain fully supported.",
  {
    query: z.string().describe("Natural language query describing what you're looking for"),
    project: z.string().optional().describe("Filter by project (optional)"),
    limit: z.number().int().min(1).max(50).optional().describe("Max results to return (default 10, max 50)"),
    task_id: z.string().optional().describe("Optional trace/measurement linkage to a task session you own. Not required; omitting it is a fully valid call. Unknown `task_id`s or `task_id`s owned by a different caller are rejected (404 / 403). Sessions in `completed` / `abandoned` state remain valid linkage targets — state is not a permission boundary. This is a trace key, not a workflow/assignment/ownership primitive."),
  },
  async (args) => {
    try {
      const results = await client.semanticSearch(args);
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No semantically similar knowledge items found." }] };
      }
      const lines = results.map(
        (r, i) => `${i + 1}. [${r.id}] (${r.confidence}${r.similarity != null ? `, similarity: ${r.similarity.toFixed(3)}` : ""}) ${r.claim}\n   Project: ${r.project}${r.module ? ` / ${r.module}` : ""} | Tags: ${r.tags.join(", ")} | By: ${r.owner} | ${r.created_at}${r.staleness_hint ? `\n   Staleness: ${r.staleness_hint}` : ""}`
      );
      return { content: [{ type: "text" as const, text: `Found ${results.length} semantically similar item(s):\n\n${lines.join("\n\n")}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }], isError: true };
    }
  }
);

// --- Tool 4: list_knowledge ---

server.tool(
  "list_knowledge",
  "Browse knowledge items by project and/or tags without a search query. Use this for cold-start exploration.",
  {
    project: z.string().optional().describe("Filter by project (optional)"),
    tags: z.array(z.string()).optional().describe("Filter by tags (optional)"),
    limit: z.number().int().min(1).max(50).optional().describe("Max results to return (default 20, max 50)"),
  },
  async (args) => {
    try {
      const results = await client.list(args);
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No knowledge items found." }] };
      }
      const lines = results.map(
        (r, i) => `${i + 1}. [${r.id}] (${r.confidence}) ${r.claim}\n   Project: ${r.project}${r.module ? ` / ${r.module}` : ""} | Tags: ${r.tags.join(", ")} | By: ${r.owner}`
      );
      return { content: [{ type: "text" as const, text: `${results.length} knowledge item(s):\n\n${lines.join("\n\n")}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }], isError: true };
    }
  }
);

// --- Tool 5: get_knowledge ---
server.tool(
  "get_knowledge",
  "Get the full content of a single knowledge item by ID. Use this after query_knowledge or semantic_search to read the complete detail — opening an item records a first-class `view` event for reuse tracking. Always pass `query_context` with the task or question that prompted the view so the view row ties back to the original query intent; this is how the reuse report attributes views to the search that triggered them. `query_context` and `task_id` are parallel, not substitutes: `query_context` captures the query intent behind this specific view, while `task_id` (optional) ties the view to an active task session opened by `start_task`. Either, both, or neither may be passed.",
  {
    id: z.string().describe("The knowledge item UUID"),
    query_context: z.string().optional().describe("What task or question prompted this view. Strongly recommended when the view follows a query_knowledge or semantic_search call — pass the same question text so reports can tie the view back to the original search intent."),
    task_id: z.string().optional().describe("Optional trace/measurement linkage to a task session you own. Parallel to `query_context` (not a replacement). Not required; omitting it is a fully valid call. Unknown `task_id`s or `task_id`s owned by a different caller are rejected (404 / 403). Sessions in `completed` / `abandoned` state remain valid linkage targets — state is not a permission boundary. This is a trace key, not a workflow/assignment/ownership primitive."),
  },
  async (args) => {
    try {
      const item = await client.get(args.id, args.query_context, args.task_id);
      const parts = [
        `**${item.claim}**`, "",
        item.detail ?? "(no detail)", "",
        `- **ID:** ${item.id}`,
        `- **Project:** ${item.project}${item.module ? ` / ${item.module}` : ""}`,
        `- **Source:** ${item.source.join(", ")}`,
        `- **Tags:** ${item.tags.join(", ")}`,
        `- **Confidence:** ${item.confidence}`,
        `- **Staleness hint:** ${item.staleness_hint}`,
        `- **Owner:** ${item.owner}`,
        `- **Created:** ${item.created_at}`,
        `- **Updated:** ${item.updated_at}`,
      ];
      if (item.related_to?.length) parts.push(`- **Related to:** ${item.related_to.join(", ")}`);
      if (item.supersedes) parts.push(`- **Supersedes:** ${item.supersedes}`);
      if (item.superseded_by) parts.push(`- **Superseded by:** ${item.superseded_by}`);
      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }], isError: true };
    }
  }
);

// --- Tool 6: reuse_feedback ---
server.tool(
  "reuse_feedback",
  "Report whether a knowledge item was actually useful after using it. Call this after get_knowledge once you know whether the content helped. Verdict: 'useful' (it answered my question or saved work), 'not_useful' (irrelevant or wrong), 'outdated' (used to be true but no longer applies). Feedback is stored as an independent first-class record (separate from view events); each call inserts a new row. The reuse report computes `feedback_coverage` at aggregation time by deduplicating to distinct (owner, knowledge_id) pairs — so the metric measures 'of viewed (owner, item) pairs, how many carry any feedback' and stays bounded at 1.0 even if you submit feedback on the same item multiple times. If a task session has been opened with `start_task`, you may pass its `task_id` as an optional trace-linkage key; calls without `task_id` remain fully supported.",
  {
    knowledge_id: z.string().describe("The knowledge item UUID you are giving feedback on"),
    verdict: z.enum(["useful", "not_useful", "outdated"]).describe("useful = it helped / saved me work; not_useful = irrelevant or wrong; outdated = used to be true but no longer applies"),
    comment: z.string().optional().describe("Optional one-line note (e.g. what was wrong, or how you used it)"),
    task_id: z.string().optional().describe("Optional trace/measurement linkage to a task session you own. Not required; omitting it is a fully valid call. Unknown `task_id`s or `task_id`s owned by a different caller are rejected (404 / 403). Sessions in `completed` / `abandoned` state remain valid linkage targets — state is not a permission boundary. This is a trace key, not a workflow/assignment/ownership primitive."),
  },
  async (args) => {
    try {
      const feedback = await client.reuseFeedback(args);
      return {
        content: [{
          type: "text" as const,
          text: `Feedback recorded.\n\nKnowledge ID: ${feedback.knowledge_id}\nVerdict: ${feedback.verdict}${feedback.comment ? `\nComment: ${feedback.comment}` : ""}\nRecorded by: ${feedback.owner}\nAt: ${feedback.created_at}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }], isError: true };
    }
  }
);

// --- Tool 7: update_knowledge ---
server.tool(
  "update_knowledge",
  "Update metadata of an existing knowledge item. Only tags, staleness_hint, related_to, and confidence can be changed. To change the claim itself, publish a new item with supersedes.",
  {
    id: z.string().describe("The knowledge item UUID to update"),
    tags: z.array(z.string()).optional().describe("New tags (replaces existing)"),
    staleness_hint: z.string().optional().describe("Updated staleness hint"),
    related_to: z.array(z.string()).optional().describe("Updated related knowledge item IDs"),
    confidence: z.enum(["high", "medium", "low"]).optional().describe("Updated confidence level"),
  },
  async (args) => {
    try {
      const item = await client.update(args);
      return {
        content: [{
          type: "text" as const,
          text: `Knowledge item updated.\n\nID: ${item.id}\nClaim: ${item.claim}\nConfidence: ${item.confidence}\nTags: ${item.tags.join(", ")}\nStaleness hint: ${item.staleness_hint}\nUpdated: ${item.updated_at}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }], isError: true };
    }
  }
);

// --- Tool 8: start_task ---
server.tool(
  "start_task",
  "Open a knowledge retrieval + findings session for the task you are about to work on, and receive relevant existing knowledge in one step. This is a framework-neutral MCP primitive, not a publish gate, not a workflow/assignment/queue/supervisor system, and not an orchestration graph. The backend uses `description` as retrieval input for matching existing knowledge (it does not promise verbatim-query semantics, so the backend may apply light query shaping). `start_task` is not required before other tools — it is an optional way to group query / exposure / view / reuse_feedback / publish events under one `task_id` so reuse reports can attribute them to the same task session. Returns a `task_id` trace key plus `matches[]` of relevant items (per-item `search_mode` preserves each match's provenance; top-level `retrieval_mode` indicates which retrieval strategy ran). 0-hit responses still return a `task_id` with `matches: []` — the caller must always call `end_task` with that `task_id` to close the session. If `project` is omitted, no project filter is applied (A1 does not pre-claim any default-project behavior).",
  {
    description: z.string().describe("Caller-provided task description used by the backend as retrieval input for matching existing knowledge (required)"),
    project: z.string().optional().describe("Explicit project filter/override for retrieval (optional). When omitted, no project filter is applied."),
    max_matches: z.number().int().min(1).max(50).optional().describe("Max number of matches to return (default 10, max 50)"),
  },
  async (args) => {
    try {
      const result = await client.startTask(args);
      const header = `Task session opened.\n\nTask ID: ${result.task_id}\nRetrieval mode: ${result.retrieval_mode}${result.project ? `\nProject: ${result.project}` : ""}\nDescription: ${result.description}`;
      if (result.matches.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `${header}\n\nNo existing knowledge matched — the team has no recorded knowledge for this task yet. Proceed with your work, then call \`end_task\` with this \`task_id\` to close the session (optionally with findings).`,
          }],
        };
      }
      const lines = result.matches.map(
        (m, i) => `${i + 1}. [${m.id}] (${m.confidence}${m.similarity != null ? `, similarity: ${m.similarity.toFixed(3)}` : ""}, via ${m.search_mode}) ${m.claim}\n   Project: ${m.project}${m.module ? ` / ${m.module}` : ""} | Tags: ${m.tags.join(", ")} | By: ${m.owner} | ${m.created_at}${m.staleness_hint ? `\n   Staleness: ${m.staleness_hint}` : ""}`
      );
      return {
        content: [{
          type: "text" as const,
          text: `${header}\n\nFound ${result.matches.length} relevant item(s):\n\n${lines.join("\n\n")}\n\nCall \`end_task\` with \`task_id: ${result.task_id}\` to close this session. You may also pass this \`task_id\` as an optional trace-linkage key to \`query_knowledge\` / \`semantic_search\` / \`get_knowledge\` / \`reuse_feedback\` during the session.`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }], isError: true };
    }
  }
);

// --- Tool 9: end_task ---
server.tool(
  "end_task",
  "Close a task session previously opened by `start_task`, and can optionally publish findings using the existing publish contract. This is a framework-neutral MCP primitive, not a workflow-completion signal, not a commit / merge gate, and not an atomic all-or-nothing transaction — each finding is published via the same contract as `publish_knowledge`. An `end_task` call with no `findings` (or `findings: []`) is fully legal and supports pure-exploration or abandoned sessions. `status` defaults to `completed`; pass `\"abandoned\"` to record that the session did not yield a completed outcome. The response returns `published_ids[]` listing any knowledge items that were published as part of this call; these items are linked to the session as provenance (task-linked publications) so the reuse report can attribute them back to the originating task. Error responses: 404 if `task_id` is unknown; 403 if the caller does not own the task; 409 if the task is already closed.",
  {
    task_id: z.string().describe("The `task_id` returned by an earlier `start_task` call (required)"),
    status: z.enum(["completed", "abandoned"]).optional().describe("Session outcome status. Defaults to `completed`. Use `abandoned` if the task was dropped without finishing."),
    findings: z.array(
      z.object({
        claim: z.string().describe("A single, falsifiable conclusion (required)"),
        detail: z.string().optional().describe("Detailed explanation in markdown (optional)"),
        source: z.array(z.string()).min(1).describe("What evidence supports this claim — repo URLs, file paths, task links (required, at least one)"),
        project: z.string().describe("Project name this knowledge applies to (required)"),
        module: z.string().optional().describe("Module or topic within the project (optional)"),
        tags: z.array(z.string()).min(1).describe("Domain tags (required, at least one)"),
        confidence: z.enum(["high", "medium", "low"]).describe("How confident you are in this claim (required)"),
        staleness_hint: z.string().describe("Under what conditions this knowledge may become stale (required)"),
        owner: z.string().optional().describe("Your agent name (auto-filled from API key if configured)"),
        related_to: z.array(z.string()).optional().describe("IDs of related knowledge items (optional)"),
        supersedes: z.string().optional().describe("ID of an older knowledge item this one replaces (optional)"),
      })
    ).optional().describe("Optional array of findings to publish via the existing publish contract. An empty or omitted array is legal and closes the session without publishing anything."),
  },
  async (args) => {
    try {
      const result = await client.endTask(args);
      const totalFindings = args.findings?.length ?? 0;
      const parts = [
        result.error ? `Task session closed (with partial-publish failure).` : `Task session closed.`,
        ``,
        `Task ID: ${result.task_id}`,
        `Status: ${result.status}`,
        `Duration: ${result.duration_ms} ms`,
      ];
      if (result.published_ids.length === 0) {
        parts.push(``, `No findings were published.`);
      } else {
        const heading = result.error
          ? `Published ${result.published_ids.length} of ${totalFindings} finding(s) before failure:`
          : `Published ${result.published_ids.length} finding(s):`;
        parts.push(``, heading);
        result.published_ids.forEach((id, i) => parts.push(`  ${i + 1}. ${id}`));
      }
      if (result.error) {
        parts.push(
          ``,
          `Publish failed on finding index ${result.error.failed_index} (${totalFindings > 0 ? `out of ${totalFindings}` : "partial"}).`,
          `  Code:           ${result.error.code}`,
          `  Publish status: ${result.error.publish_status}`,
          `  Publish error:  ${result.error.publish_error}`,
          ``,
          `Note: the session is already closed — re-calling \`end_task\` will return 409. To publish the remaining findings, call \`publish_knowledge\` directly for each one.`,
        );
        return { content: [{ type: "text" as const, text: parts.join("\n") }], isError: true };
      }
      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }], isError: true };
    }
  }
);

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

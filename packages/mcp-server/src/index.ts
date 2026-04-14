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
  "Search the team knowledge base by keywords. Use this before starting a task to check what the team already knows about a topic.",
  {
    query: z.string().describe("Search keywords"),
    tags: z.array(z.string()).optional().describe("Filter by tags (optional)"),
    project: z.string().optional().describe("Filter by project (optional)"),
    module: z.string().optional().describe("Filter by module (optional)"),
    limit: z.number().int().min(1).max(50).optional().describe("Max results to return (default 10, max 50)"),
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
  "Search the team knowledge base using semantic similarity (vector search). Use this when keyword search misses relevant results — it finds conceptually related knowledge even if the exact words differ.",
  {
    query: z.string().describe("Natural language query describing what you're looking for"),
    project: z.string().optional().describe("Filter by project (optional)"),
    limit: z.number().int().min(1).max(50).optional().describe("Max results to return (default 10, max 50)"),
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
  "Get the full content of a single knowledge item by ID. Use this after query/list to read the complete detail.",
  {
    id: z.string().describe("The knowledge item UUID"),
  },
  async (args) => {
    try {
      const item = await client.get(args.id);
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

// --- Tool 6: update_knowledge ---
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

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

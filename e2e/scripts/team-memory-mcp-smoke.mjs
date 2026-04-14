import { Client } from "../../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

function getText(result) {
  const first = result.content?.find((item) => item.type === "text");
  return first?.text || "";
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

async function main() {
  const backendUrl = process.env.TEAM_MEMORY_URL || "http://localhost:3456";
  const apiKey = process.env.TEAM_MEMORY_API_KEY;
  if (!apiKey) {
    fail("TEAM_MEMORY_API_KEY is required for authenticated MCP smoke tests");
  }
  const client = new Client(
    { name: "team-memory-e2e-smoke", version: "0.1.0" },
    { capabilities: {} },
  );

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: new URL("../../packages/mcp-server/", import.meta.url).pathname,
    env: {
      ...process.env,
      TEAM_MEMORY_URL: backendUrl,
      TEAM_MEMORY_API_KEY: apiKey,
    },
    stderr: "pipe",
  });

  if (transport.stderr) {
    transport.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        console.error(`[mcp stderr] ${text}`);
      }
    });
  }

  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  for (const required of ["publish_knowledge", "query_knowledge", "get_knowledge"]) {
    if (!toolNames.includes(required)) {
      fail(`missing tool ${required}`);
    }
  }
  console.log(`TOOLS ${toolNames.join(",")}`);

  const publish = await client.callTool({
    name: "publish_knowledge",
    arguments: {
      claim: "Team Memory smoke test claim: DEPLOY_MODE drives infer-monorepo architecture.",
      detail: "Used only for MCP smoke testing.",
      source: ["scripts/team-memory-mcp-smoke.mjs"],
      project: "infer-monorepo",
      module: "architecture",
      tags: ["architecture", "smoke"],
      confidence: "high",
      staleness_hint: "Recheck after deploy-mode refactor.",
      owner: "Ein",
      related_to: [],
    },
  });
  const publishText = getText(publish);
  const idMatch = publishText.match(/ID:\s*([0-9a-f-]{36})/i);
  if (!idMatch) fail(`could not parse published id from: ${publishText}`);
  const id = idMatch[1];
  console.log(`PUBLISH_OK ${id}`);

  const query = await client.callTool({
    name: "query_knowledge",
    arguments: {
      query: "smoke",
      project: "infer-monorepo",
      limit: 10,
    },
  });
  const queryText = getText(query);
  if (!queryText.includes(id) && !queryText.includes("smoke test claim")) {
    fail(`query output did not include published item: ${queryText}`);
  }
  console.log(`QUERY_OK ${id}`);

  const full = await client.callTool({
    name: "get_knowledge",
    arguments: { id },
  });
  const fullText = getText(full);
  if (!fullText.includes(id) || !fullText.includes("DEPLOY_MODE drives infer-monorepo architecture")) {
    fail(`get output missing expected content: ${fullText}`);
  }
  console.log(`GET_OK ${id}`);

  await transport.close();
  console.log("PASS MCP smoke-path for Team Memory");
}

main().catch((error) => fail(error instanceof Error ? error.stack || error.message : String(error)));

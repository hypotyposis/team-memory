import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import type Database from "better-sqlite3";
import { Hono } from "hono";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "team-memory-reuse-tracking-"));
const dbPath = path.join(tempDir, "team-memory.db");

process.env.TEAM_MEMORY_DB = dbPath;
process.env.EMBEDDING_API_KEY = "test-reuse-key";
process.env.EMBEDDING_API_BASE = "https://openrouter.ai/api/v1";
process.env.EMBEDDING_MODEL = "openai/text-embedding-3-small";

interface UsageEventRow {
  knowledge_id: string;
  owner: string;
  event_type: string;
  request_id: string | null;
  query_context: string | null;
}

interface ReuseFeedbackRow {
  knowledge_id: string;
  owner: string;
  verdict: string;
  comment: string | null;
}

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
let originalFetch: typeof globalThis.fetch;

function encodeEmbedding(vector: number[]): Buffer {
  return Buffer.from(Float32Array.from(vector).buffer);
}

function createApiKey(owner = "Tester"): string {
  const db = getDb();
  const key = `${owner.toLowerCase()}-key`;
  db.prepare(
    "INSERT OR REPLACE INTO api_keys (key, owner, created_at, revoked_at) VALUES (?, ?, ?, NULL)",
  ).run(key, owner, new Date().toISOString());
  return key;
}

function insertKnowledgeRow(
  db: Database.Database,
  input: {
    id: string;
    claim: string;
    project?: string;
    embedding?: Buffer | null;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO knowledge (
      id, claim, detail, source, project, module, tags, confidence,
      staleness_hint, owner, related_to, supersedes, superseded_by,
      duplicate_of, embedding, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.claim,
    null,
    JSON.stringify(["tests/reuse-tracking.test.ts"]),
    input.project ?? "team-memory",
    "reuse",
    JSON.stringify(["reuse"]),
    "high",
    "Recheck if reuse tracking semantics change.",
    "Seeder",
    JSON.stringify([]),
    null,
    null,
    null,
    input.embedding ?? null,
    now,
    now,
  );
}

before(async () => {
  originalFetch = globalThis.fetch;

  const routesModule = await import("../src/routes.ts");
  const dbModule = await import("../src/db.ts");

  const honoApp = new Hono();
  honoApp.route("/api", routesModule.api);

  app = honoApp;
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  const db = getDb();
  db.exec("DELETE FROM knowledge; DELETE FROM api_keys;");
  db.exec("DELETE FROM usage_events; DELETE FROM reuse_feedback;");
});

after(() => {
  globalThis.fetch = originalFetch;
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.TEAM_MEMORY_DB;
  delete process.env.EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_API_BASE;
  delete process.env.EMBEDDING_MODEL;
});

test("authenticated FTS search writes exposure events with a shared request_id", async () => {
  const db = getDb();
  insertKnowledgeRow(db, {
    id: "billing-row-a",
    claim: "Billing pipeline buffers usage events before persistence.",
  });
  insertKnowledgeRow(db, {
    id: "billing-row-b",
    claim: "Billing ownership stays in the control plane.",
  });
  const apiKey = createApiKey("Researcher");

  const response = await app.request("http://localhost/api/knowledge/search?q=billing", {
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
  });

  assert.equal(response.status, 200);

  const events = getDb().prepare(
    "SELECT knowledge_id, owner, event_type, request_id, query_context FROM usage_events ORDER BY knowledge_id ASC",
  ).all() as UsageEventRow[];

  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.knowledge_id), ["billing-row-a", "billing-row-b"]);
  assert.ok(events[0]!.request_id);
  assert.equal(events[0]!.request_id, events[1]!.request_id);
  assert.deepEqual(
    events.map((event) => ({
      owner: event.owner,
      event_type: event.event_type,
      query_context: event.query_context,
    })),
    [
      { owner: "Researcher", event_type: "exposure", query_context: "billing" },
      { owner: "Researcher", event_type: "exposure", query_context: "billing" },
    ],
  );
});

test("authenticated semantic search writes exposure events with query context", async () => {
  const db = getDb();
  insertKnowledgeRow(db, {
    id: "semantic-row",
    claim: "Inference usage events are mirrored before billing persistence.",
    embedding: encodeEmbedding([1, 0]),
  });
  const apiKey = createApiKey("SemanticUser");

  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      data: [{ index: 0, embedding: [1, 0] }],
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  )) as typeof globalThis.fetch;

  const response = await app.request("http://localhost/api/knowledge/semantic-search?q=usage%20mirroring", {
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
  });

  assert.equal(response.status, 200);

  const events = getDb().prepare(
    "SELECT knowledge_id, owner, event_type, request_id, query_context FROM usage_events",
  ).all() as UsageEventRow[];

  assert.equal(events.length, 1);
  assert.equal(events[0]!.knowledge_id, "semantic-row");
  assert.equal(events[0]!.owner, "SemanticUser");
  assert.equal(events[0]!.event_type, "exposure");
  assert.ok(events[0]!.request_id);
  assert.equal(events[0]!.query_context, "usage mirroring");
});

test("authenticated get_knowledge writes a view event and stores query_context", async () => {
  const db = getDb();
  insertKnowledgeRow(db, {
    id: "view-row",
    claim: "Control plane owns billing writes.",
  });
  const apiKey = createApiKey("Viewer");

  const response = await app.request(
    "http://localhost/api/knowledge/view-row?query_context=task%3Abilling-investigation",
    {
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
    },
  );

  assert.equal(response.status, 200);

  const event = getDb().prepare(
    "SELECT knowledge_id, owner, event_type, request_id, query_context FROM usage_events",
  ).get() as UsageEventRow;

  assert.equal(event.knowledge_id, "view-row");
  assert.equal(event.owner, "Viewer");
  assert.equal(event.event_type, "view");
  assert.equal(event.request_id, null);
  assert.equal(event.query_context, "task:billing-investigation");
});

test("authenticated feedback endpoint persists reuse feedback", async () => {
  const db = getDb();
  insertKnowledgeRow(db, {
    id: "feedback-row",
    claim: "Knowledge reuse should be measurable.",
  });
  const apiKey = createApiKey("Reviewer");

  const response = await app.request("http://localhost/api/knowledge/feedback-row/feedback", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      verdict: "useful",
      comment: "Saved the first round of research.",
    }),
  });

  assert.equal(response.status, 201);

  const row = getDb().prepare(
    "SELECT knowledge_id, owner, verdict, comment FROM reuse_feedback",
  ).get() as ReuseFeedbackRow;

  assert.equal(row.knowledge_id, "feedback-row");
  assert.equal(row.owner, "Reviewer");
  assert.equal(row.verdict, "useful");
  assert.equal(row.comment, "Saved the first round of research.");
});

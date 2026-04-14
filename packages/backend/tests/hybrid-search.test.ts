import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import type Database from "better-sqlite3";
import { Hono } from "hono";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "team-memory-hybrid-search-"));
const dbPath = path.join(tempDir, "team-memory.db");

process.env.TEAM_MEMORY_DB = dbPath;
process.env.EMBEDDING_API_KEY = "test-hybrid-key";
process.env.EMBEDDING_API_BASE = "https://openrouter.ai/api/v1";
process.env.EMBEDDING_MODEL = "openai/text-embedding-3-small";

interface HybridSummary {
  id: string;
  claim: string;
  search_mode: "fts" | "semantic" | "hybrid";
  similarity?: number;
}

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
let originalFetch: typeof globalThis.fetch;

function encodeEmbedding(vector: number[]): Buffer {
  return Buffer.from(Float32Array.from(vector).buffer);
}

function insertKnowledgeRow(
  db: Database.Database,
  input: {
    id: string;
    claim: string;
    embedding?: Buffer | null;
    project?: string;
    supersededBy?: string | null;
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
    JSON.stringify(["tests/hybrid-search.test.ts"]),
    input.project ?? "team-memory",
    "search",
    JSON.stringify(["hybrid-search"]),
    "high",
    "Recheck if ranking strategy changes",
    "Seeder",
    JSON.stringify([]),
    null,
    input.supersededBy ?? null,
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

test("hybrid search merges fts and semantic results with search_mode annotations", async () => {
  const db = getDb();
  insertKnowledgeRow(db, {
    id: "hybrid-row",
    claim: "refund flow recovery design",
    embedding: encodeEmbedding([1, 0]),
  });
  insertKnowledgeRow(db, {
    id: "semantic-row",
    claim: "chargeback reversal pipeline",
    embedding: encodeEmbedding([0.96, 0.04]),
  });
  insertKnowledgeRow(db, {
    id: "fts-only-row",
    claim: "refund flow audit logs",
    embedding: null,
  });
  insertKnowledgeRow(db, {
    id: "other-project-row",
    claim: "refund flow but in another project",
    embedding: encodeEmbedding([1, 0]),
    project: "other-project",
  });

  globalThis.fetch = (async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    assert.deepEqual(payload.input, ["refund flow"]);

    return new Response(
      JSON.stringify({
        data: [{ index: 0, embedding: [1, 0] }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof globalThis.fetch;

  const response = await app.request("http://localhost/api/knowledge/search?q=refund%20flow&project=team-memory&limit=10");

  assert.equal(response.status, 200);
  const body = (await response.json()) as { items: HybridSummary[]; total: number };

  assert.equal(body.total, 3);
  assert.equal(body.items[0]?.id, "hybrid-row");

  const byId = new Map(body.items.map((item) => [item.id, item]));
  assert.equal(byId.get("hybrid-row")?.search_mode, "hybrid");
  assert.equal(byId.get("semantic-row")?.search_mode, "semantic");
  assert.equal(byId.get("fts-only-row")?.search_mode, "fts");
  assert.equal(byId.has("other-project-row"), false);
  assert.ok((byId.get("hybrid-row")?.similarity ?? 0) > 0.9);
  assert.ok((byId.get("semantic-row")?.similarity ?? 0) > 0.9);
});

test("hybrid search falls back to pure FTS when query embeddings are unavailable", async () => {
  const db = getDb();
  insertKnowledgeRow(db, {
    id: "fts-row",
    claim: "refund flow audit logs",
    embedding: null,
  });
  insertKnowledgeRow(db, {
    id: "semantic-only-row",
    claim: "chargeback reversal pipeline",
    embedding: encodeEmbedding([1, 0]),
  });

  delete process.env.EMBEDDING_API_KEY;

  const response = await app.request("http://localhost/api/knowledge/search?q=refund%20flow");

  assert.equal(response.status, 200);
  const body = (await response.json()) as { items: HybridSummary[]; total: number };

  assert.equal(body.total, 1);
  assert.deepEqual(body.items.map((item) => item.id), ["fts-row"]);
  assert.equal(body.items[0]?.search_mode, "fts");

  process.env.EMBEDDING_API_KEY = "test-hybrid-key";
});

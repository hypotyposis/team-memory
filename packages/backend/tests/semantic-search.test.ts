import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import type Database from "better-sqlite3";
import { Hono } from "hono";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "team-memory-semantic-search-"));
const dbPath = path.join(tempDir, "team-memory.db");

process.env.TEAM_MEMORY_DB = dbPath;
process.env.EMBEDDING_API_KEY = "test-semantic-key";
process.env.EMBEDDING_API_BASE = "https://openrouter.ai/api/v1";
process.env.EMBEDDING_MODEL = "openai/text-embedding-3-small";

interface SemanticSummary {
  id: string;
  claim: string;
  project: string;
  similarity: number;
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
    JSON.stringify(["tests/semantic-search.test.ts"]),
    input.project ?? "team-memory",
    "search",
    JSON.stringify(["semantic-search"]),
    "high",
    "Recheck if semantic ranking changes",
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

test("semantic search ranks by cosine similarity and filters superseded/project rows", async () => {
  const db = getDb();
  insertKnowledgeRow(db, {
    id: "similar-row",
    claim: "Control plane owns write-side billing persistence.",
    embedding: encodeEmbedding([1, 0]),
  });
  insertKnowledgeRow(db, {
    id: "second-row",
    claim: "Inference emits usage events before control persists them.",
    embedding: encodeEmbedding([0.6, 0.8]),
  });
  insertKnowledgeRow(db, {
    id: "superseded-row",
    claim: "This row should be filtered even if its embedding is perfect.",
    embedding: encodeEmbedding([1, 0]),
    supersededBy: "newer-row",
  });
  insertKnowledgeRow(db, {
    id: "other-project-row",
    claim: "This row belongs to another project and should be filtered.",
    embedding: encodeEmbedding([1, 0]),
    project: "other-project",
  });

  globalThis.fetch = (async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, "openai/text-embedding-3-small");
    assert.deepEqual(payload.input, ["database writer ownership"]);

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

  const response = await app.request("http://localhost/api/knowledge/semantic-search?q=database%20writer%20ownership&project=team-memory&limit=5");

  assert.equal(response.status, 200);
  const body = (await response.json()) as { items: SemanticSummary[]; total: number };

  assert.equal(body.total, 2);
  assert.deepEqual(
    body.items.map((item) => item.id),
    ["similar-row", "second-row"],
  );
  assert.ok(body.items[0]!.similarity > body.items[1]!.similarity);
});

test("semantic search returns empty results when query embedding cannot be generated", async () => {
  const db = getDb();
  insertKnowledgeRow(db, {
    id: "existing-row",
    claim: "A row with an embedding should not cause semantic search to fail.",
    embedding: encodeEmbedding([1, 0, 0]),
  });

  delete process.env.EMBEDDING_API_KEY;

  const response = await app.request("http://localhost/api/knowledge/semantic-search?q=missing%20provider");

  assert.equal(response.status, 200);
  const body = (await response.json()) as { items: SemanticSummary[]; total: number };
  assert.deepEqual(body, { items: [], total: 0 });

  process.env.EMBEDDING_API_KEY = "test-semantic-key";
});

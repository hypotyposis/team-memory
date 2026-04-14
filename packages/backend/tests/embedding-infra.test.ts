import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import type Database from "better-sqlite3";
import { Hono } from "hono";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "team-memory-embedding-"));
const dbPath = path.join(tempDir, "team-memory.db");

process.env.TEAM_MEMORY_DB = dbPath;
process.env.EMBEDDING_API_KEY = "test-embedding-key";
process.env.EMBEDDING_API_BASE = "https://openrouter.ai/api/v1/";
process.env.EMBEDDING_MODEL = "openai/text-embedding-3-small";

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
let originalFetch: typeof globalThis.fetch;
let backfillMissingEmbeddings: (db: Database.Database, options?: { batchSize?: number }) => Promise<{ updated: number; scanned: number }>;

function knowledgeText(claim: string, detail?: string) {
  return detail ? `${claim}\n\n${detail}` : claim;
}

before(async () => {
  originalFetch = globalThis.fetch;

  const routesModule = await import("../src/routes.ts");
  const dbModule = await import("../src/db.ts");
  const embeddingModule = await import("../src/embedding.ts");

  const honoApp = new Hono();
  honoApp.route("/api", routesModule.api);

  app = honoApp;
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  backfillMissingEmbeddings = embeddingModule.backfillMissingEmbeddings;
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

function createApiKey(owner = "Tester"): string {
  const db = getDb();
  const key = `${owner.toLowerCase()}-embedding-key`;
  db.prepare(
    "INSERT OR REPLACE INTO api_keys (key, owner, created_at, revoked_at) VALUES (?, ?, ?, NULL)",
  ).run(key, owner, new Date().toISOString());
  return key;
}

async function publishKnowledge(apiKey: string, body: Record<string, unknown>) {
  return app.request("http://localhost/api/knowledge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}

function insertKnowledgeRow(
  db: Database.Database,
  input: {
    id: string;
    claim: string;
    detail?: string | null;
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
    input.detail ?? null,
    JSON.stringify(["tests/embedding-infra.test.ts"]),
    "team-memory",
    "search",
    JSON.stringify(["semantic"]),
    "high",
    "Recheck if vector search changes",
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

test("publish stores an embedding blob when embedding generation succeeds", async () => {
  const claim = "Control plane is the sole PostgreSQL writer.";
  const detail = "Inference should emit usage events, not write billing rows directly.";

  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), "https://openrouter.ai/api/v1/embeddings");
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, "openai/text-embedding-3-small");
    assert.deepEqual(payload.input, [knowledgeText(claim, detail)]);
    assert.equal(payload.encoding_format, "float");

    return new Response(
      JSON.stringify({
        data: [{ index: 0, embedding: [0.25, 0.5, 0.75] }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof globalThis.fetch;

  const apiKey = createApiKey();
  const response = await publishKnowledge(apiKey, {
    claim,
    detail,
    source: ["tests/embedding-infra.test.ts"],
    project: "team-memory",
    tags: ["architecture"],
    confidence: "high",
    staleness_hint: "Recheck if write path changes",
  });

  assert.equal(response.status, 201);
  const created = (await response.json()) as { id: string };

  const row = getDb()
    .prepare("SELECT embedding FROM knowledge WHERE id = ?")
    .get(created.id) as { embedding: Buffer | null };

  assert.ok(row.embedding);
  assert.equal(row.embedding.byteLength, Float32Array.BYTES_PER_ELEMENT * 3);
});

test("publish still succeeds when embedding generation fails", async () => {
  globalThis.fetch = (async () => {
    throw new Error("embedding api unavailable");
  }) as typeof globalThis.fetch;

  const apiKey = createApiKey();
  const response = await publishKnowledge(apiKey, {
    claim: "Semantic search should degrade gracefully when embeddings are unavailable.",
    detail: "Publish should not fail if the embedding API is down.",
    source: ["tests/embedding-infra.test.ts"],
    project: "team-memory",
    tags: ["reliability"],
    confidence: "medium",
    staleness_hint: "Recheck if publish pipeline changes",
  });

  assert.equal(response.status, 201);
  const created = (await response.json()) as { id: string };

  const row = getDb()
    .prepare("SELECT embedding FROM knowledge WHERE id = ?")
    .get(created.id) as { embedding: Buffer | null };

  assert.equal(row.embedding, null);
});

test("backfill script embeds only rows that are still missing embeddings", async () => {
  const db = getDb();
  const existingEmbedding = Buffer.from(Float32Array.from([9, 9, 9]).buffer);
  const missingClaim = "Semantic backfill should cover older knowledge rows.";
  const missingDetail = "This row existed before embeddings were introduced.";

  insertKnowledgeRow(db, {
    id: "missing-embedding",
    claim: missingClaim,
    detail: missingDetail,
    embedding: null,
  });
  insertKnowledgeRow(db, {
    id: "existing-embedding",
    claim: "This row already has an embedding.",
    embedding: existingEmbedding,
  });

  globalThis.fetch = (async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    assert.deepEqual(payload.input, [knowledgeText(missingClaim, missingDetail)]);
    assert.equal(payload.model, "openai/text-embedding-3-small");

    return new Response(
      JSON.stringify({
        data: [{ index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof globalThis.fetch;

  const result = await backfillMissingEmbeddings(db, { batchSize: 10 });

  assert.equal(result.scanned, 1);
  assert.equal(result.updated, 1);

  const rows = db
    .prepare("SELECT id, embedding FROM knowledge ORDER BY id ASC")
    .all() as Array<{ id: string; embedding: Buffer | null }>;

  assert.equal(rows[0]?.id, "existing-embedding");
  assert.deepEqual(rows[0]?.embedding, existingEmbedding);
  assert.equal(rows[1]?.id, "missing-embedding");
  assert.ok(rows[1]?.embedding);
  assert.notDeepEqual(rows[1]?.embedding, existingEmbedding);
});

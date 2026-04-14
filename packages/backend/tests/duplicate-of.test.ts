import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import type Database from "better-sqlite3";
import { Hono } from "hono";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "team-memory-duplicate-of-"));
const dbPath = path.join(tempDir, "team-memory.db");

process.env.TEAM_MEMORY_DB = dbPath;
process.env.TEAM_MEMORY_STALE_AFTER_DAYS = "30";

interface ApiKnowledgeItem {
  id: string;
  claim: string;
  duplicate_of: string | null;
  warnings?: Array<{
    code: string;
    matches: Array<{ id: string }>;
  }>;
}

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
let originalFetch: typeof globalThis.fetch;

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
  delete process.env.EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_API_BASE;
  delete process.env.EMBEDDING_MODEL;
  delete process.env.TEAM_MEMORY_DUPLICATE_WARNING_THRESHOLD;
  delete process.env.TEAM_MEMORY_DUPLICATE_PERSIST_THRESHOLD;
});

after(() => {
  globalThis.fetch = originalFetch;
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.TEAM_MEMORY_DB;
  delete process.env.TEAM_MEMORY_STALE_AFTER_DAYS;
});

function encodeEmbedding(vector: number[]): Buffer {
  return Buffer.from(Float32Array.from(vector).buffer);
}

function mockEmbeddingResponse(vector: number[]) {
  process.env.EMBEDDING_API_KEY = "test-duplicate-key";
  process.env.EMBEDDING_API_BASE = "https://openrouter.ai/api/v1";
  process.env.EMBEDDING_MODEL = "openai/text-embedding-3-small";

  globalThis.fetch = (async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, "openai/text-embedding-3-small");
    assert.equal(payload.input.length, 1);

    return new Response(
      JSON.stringify({
        data: [{ index: 0, embedding: vector }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof globalThis.fetch;
}

function createApiKey(owner = "Tester"): string {
  const db = getDb();
  const key = `${owner.toLowerCase()}-key`;
  db.prepare(
    "INSERT OR REPLACE INTO api_keys (key, owner, created_at, revoked_at) VALUES (?, ?, ?, NULL)",
  ).run(key, owner, new Date().toISOString());
  return key;
}

async function publishKnowledge(
  apiKey: string,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<ApiKnowledgeItem> {
  const payload = {
    claim: "Billing pipeline uses Redis Stream buffering between inference and control.",
    detail: "Used for duplicate persistence tests.",
    source: ["tests/duplicate-of.test.ts"],
    project: "team-memory",
    module: "quality",
    tags: ["quality", "duplicate"],
    confidence: "high",
    staleness_hint: "Recheck if duplicate matching rules change.",
    related_to: [],
    ...overrides,
  };

  const response = await app.request("http://localhost/api/knowledge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  assert.equal(response.status, 201);
  return (await response.json()) as ApiKnowledgeItem;
}

function insertKnowledgeRow(
  db: Database.Database,
  input: {
    id: string;
    claim: string;
    project?: string;
    duplicateOf?: string | null;
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
    JSON.stringify(["tests/duplicate-of.test.ts"]),
    input.project ?? "team-memory",
    "quality",
    JSON.stringify(["quality"]),
    "high",
    "Recheck if duplicate matching rules change.",
    "Seeder",
    JSON.stringify([]),
    null,
    null,
    input.duplicateOf ?? null,
    input.embedding ?? null,
    now,
    now,
  );
}

test("textual fuzzy matches without embeddings do not trigger duplicate warnings", async () => {
  const apiKey = createApiKey();

  const original = await publishKnowledge(apiKey, {
    claim: "Billing pipeline uses Redis Stream buffering between inference and control.",
  });
  const fuzzy = await publishKnowledge(apiKey, {
    claim: "Billing pipeline routes usage through Redis buffering before control persistence.",
  });

  assert.equal(fuzzy.warnings?.length ?? 0, 0);
  assert.equal(fuzzy.duplicate_of, null);

  const stored = getDb()
    .prepare("SELECT duplicate_of FROM knowledge WHERE id = ?")
    .get(fuzzy.id) as { duplicate_of: string | null };
  assert.equal(stored.duplicate_of, null);
});

test("normalized exact claim matches persist duplicate_of", async () => {
  const apiKey = createApiKey();

  const original = await publishKnowledge(apiKey, {
    claim: "All PG writes MUST come from control plane only.",
  });
  const exactDuplicate = await publishKnowledge(apiKey, {
    claim: "  all   pg writes must come from control plane only.  ",
  });

  assert.equal(exactDuplicate.duplicate_of, original.id);
});

test("semantic duplicates trigger warnings even when wording is different", async () => {
  process.env.TEAM_MEMORY_DUPLICATE_WARNING_THRESHOLD = "0.75";
  process.env.TEAM_MEMORY_DUPLICATE_PERSIST_THRESHOLD = "0.95";

  const apiKey = createApiKey();
  const db = getDb();
  insertKnowledgeRow(db, {
    id: "semantic-warning-row",
    claim: "Redis stream buffering protects control-plane persistence.",
    embedding: encodeEmbedding([0.8, 0.6]),
  });
  mockEmbeddingResponse([1, 0]);

  const created = await publishKnowledge(apiKey, {
    claim: "Usage events are buffered before persistence reaches control services.",
  });

  assert.equal(created.warnings?.[0]?.code, "possible_duplicate");
  assert.equal(created.warnings?.[0]?.matches[0]?.id, "semantic-warning-row");
  assert.equal(created.duplicate_of, null);
});

test("high semantic similarity persists duplicate_of even without exact text match", async () => {
  process.env.TEAM_MEMORY_DUPLICATE_WARNING_THRESHOLD = "0.75";
  process.env.TEAM_MEMORY_DUPLICATE_PERSIST_THRESHOLD = "0.95";

  const apiKey = createApiKey();
  const db = getDb();
  insertKnowledgeRow(db, {
    id: "semantic-persist-row",
    claim: "Control-plane persistence is protected by Redis stream buffering.",
    embedding: encodeEmbedding([0.98, 0.2]),
  });
  mockEmbeddingResponse([1, 0]);

  const created = await publishKnowledge(apiKey, {
    claim: "Buffered event delivery protects writes before control-plane persistence.",
  });

  assert.equal(created.duplicate_of, "semantic-persist-row");
});

test("unrelated semantic matches do not trigger duplicate warnings", async () => {
  process.env.TEAM_MEMORY_DUPLICATE_WARNING_THRESHOLD = "0.75";
  process.env.TEAM_MEMORY_DUPLICATE_PERSIST_THRESHOLD = "0.95";

  const apiKey = createApiKey();
  const db = getDb();
  insertKnowledgeRow(db, {
    id: "unrelated-row",
    claim: "Billing exports run through a nightly warehouse sync.",
    embedding: encodeEmbedding([0, 1]),
  });
  mockEmbeddingResponse([1, 0]);

  const created = await publishKnowledge(apiKey, {
    claim: "Buffered event delivery protects writes before control-plane persistence.",
  });

  assert.equal(created.warnings?.length ?? 0, 0);
  assert.equal(created.duplicate_of, null);
});

test("database startup cleanup clears false-positive duplicate_of but preserves exact matches", () => {
  const db = getDb();

  insertKnowledgeRow(db, {
    id: "target-row",
    claim: "All PG writes MUST come from control plane only.",
  });
  insertKnowledgeRow(db, {
    id: "legacy-fuzzy-row",
    claim: "Billing pipeline routes usage through Redis buffering before control persistence.",
    duplicateOf: "target-row",
  });
  insertKnowledgeRow(db, {
    id: "legacy-exact-row",
    claim: " all   pg writes must come from control plane only. ",
    duplicateOf: "target-row",
  });

  closeDb();
  const reopened = getDb();

  const fuzzyRow = reopened
    .prepare("SELECT duplicate_of FROM knowledge WHERE id = ?")
    .get("legacy-fuzzy-row") as { duplicate_of: string | null };
  const exactRow = reopened
    .prepare("SELECT duplicate_of FROM knowledge WHERE id = ?")
    .get("legacy-exact-row") as { duplicate_of: string | null };

  assert.equal(fuzzyRow.duplicate_of, null);
  assert.equal(exactRow.duplicate_of, "target-row");
});

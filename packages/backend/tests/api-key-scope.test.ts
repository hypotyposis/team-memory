import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import type Database from "better-sqlite3";
import { Hono } from "hono";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "team-memory-api-key-scope-"));
const dbPath = path.join(tempDir, "team-memory.db");

process.env.TEAM_MEMORY_DB = dbPath;
process.env.EMBEDDING_API_KEY = "test-scope-key";
process.env.EMBEDDING_API_BASE = "https://openrouter.ai/api/v1";
process.env.EMBEDDING_MODEL = "openai/text-embedding-3-small";

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
let originalFetch: typeof globalThis.fetch;

function encodeEmbedding(vector: number[]): Buffer {
  return Buffer.from(Float32Array.from(vector).buffer);
}

function assertSameIds(actual: Array<{ id: string }>, expected: string[]): void {
  assert.deepEqual(
    actual.map((item) => item.id).sort(),
    [...expected].sort(),
  );
}

function createApiKey(owner: string, defaultProjects: string[] | null, key = `${owner.toLowerCase()}-key`): string {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO api_keys (key, owner, default_projects, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)",
  ).run(
    key,
    owner,
    defaultProjects ? JSON.stringify(defaultProjects) : null,
    new Date().toISOString(),
  );
  return key;
}

function insertKnowledgeRow(
  db: Database.Database,
  input: {
    id: string;
    claim: string;
    project: string;
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
    JSON.stringify(["tests/api-key-scope.test.ts"]),
    input.project,
    "scope",
    JSON.stringify(["scope"]),
    "high",
    "Recheck if API-key scoping semantics change.",
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

test("scoped key defaults unparametrized list_knowledge to its single project", async () => {
  const db = getDb();
  insertKnowledgeRow(db, { id: "alpha-row", claim: "Alpha only note", project: "alpha" });
  insertKnowledgeRow(db, { id: "beta-row", claim: "Beta only note", project: "beta" });
  const apiKey = createApiKey("AlphaOwner", ["alpha"]);

  const response = await app.request("http://localhost/api/knowledge", {
    headers: { authorization: `Bearer ${apiKey}` },
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<{ id: string }>; total: number };
  assertSameIds(body.items, ["alpha-row"]);
  assert.equal(body.total, 1);
});

test("scoped key with multiple projects sees all projects in its default namespace", async () => {
  const db = getDb();
  insertKnowledgeRow(db, { id: "alpha-row", claim: "Alpha only note", project: "alpha" });
  insertKnowledgeRow(db, { id: "beta-row", claim: "Beta only note", project: "beta" });
  insertKnowledgeRow(db, { id: "gamma-row", claim: "Gamma only note", project: "gamma" });
  const apiKey = createApiKey("MultiOwner", ["alpha", "beta"]);

  const response = await app.request("http://localhost/api/knowledge", {
    headers: { authorization: `Bearer ${apiKey}` },
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<{ id: string }>; total: number };
  assertSameIds(body.items, ["alpha-row", "beta-row"]);
  assert.equal(body.total, 2);
});

test("explicit project override bypasses default key scope on search", async () => {
  const db = getDb();
  insertKnowledgeRow(db, { id: "alpha-row", claim: "Billing note in alpha", project: "alpha" });
  insertKnowledgeRow(db, { id: "beta-row", claim: "Billing note in beta", project: "beta" });
  const apiKey = createApiKey("ScopedOwner", ["alpha"]);

  const response = await app.request("http://localhost/api/knowledge/search?q=billing&project=beta", {
    headers: { authorization: `Bearer ${apiKey}` },
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<{ id: string }>; total: number };
  assertSameIds(body.items, ["beta-row"]);
  assert.equal(body.total, 1);
});

test("project=* opt-out returns unscoped results for a scoped key", async () => {
  const db = getDb();
  insertKnowledgeRow(db, { id: "alpha-row", claim: "Billing note in alpha", project: "alpha" });
  insertKnowledgeRow(db, { id: "beta-row", claim: "Billing note in beta", project: "beta" });
  const apiKey = createApiKey("ScopedOwner", ["alpha"]);

  const response = await app.request("http://localhost/api/knowledge/search?q=billing&project=*", {
    headers: { authorization: `Bearer ${apiKey}` },
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<{ id: string }>; total: number };
  assertSameIds(body.items, ["alpha-row", "beta-row"]);
  assert.equal(body.total, 2);
});

test("semantic search applies API-key default project scope when project is omitted", async () => {
  const db = getDb();
  insertKnowledgeRow(db, {
    id: "alpha-semantic",
    claim: "Vector scope alpha result",
    project: "alpha",
    embedding: encodeEmbedding([1, 0]),
  });
  insertKnowledgeRow(db, {
    id: "beta-semantic",
    claim: "Vector scope beta result",
    project: "beta",
    embedding: encodeEmbedding([1, 0]),
  });
  const apiKey = createApiKey("SemanticOwner", ["alpha"]);

  globalThis.fetch = (async () => new Response(
    JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof globalThis.fetch;

  const response = await app.request("http://localhost/api/knowledge/semantic-search?q=vector%20scope", {
    headers: { authorization: `Bearer ${apiKey}` },
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<{ id: string }>; total: number };
  assertSameIds(body.items, ["alpha-semantic"]);
  assert.equal(body.total, 1);
});

test("legacy null-scoped keys remain unscoped when project is omitted", async () => {
  const db = getDb();
  insertKnowledgeRow(db, { id: "alpha-row", claim: "Alpha only note", project: "alpha" });
  insertKnowledgeRow(db, { id: "beta-row", claim: "Beta only note", project: "beta" });
  const apiKey = createApiKey("LegacyOwner", null);

  const response = await app.request("http://localhost/api/knowledge", {
    headers: { authorization: `Bearer ${apiKey}` },
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<{ id: string }>; total: number };
  assertSameIds(body.items, ["alpha-row", "beta-row"]);
  assert.equal(body.total, 2);
});

test("unauthenticated requests remain unscoped when project is omitted", async () => {
  const db = getDb();
  insertKnowledgeRow(db, { id: "alpha-row", claim: "Alpha only note", project: "alpha" });
  insertKnowledgeRow(db, { id: "beta-row", claim: "Beta only note", project: "beta" });

  const response = await app.request("http://localhost/api/knowledge");

  assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<{ id: string }>; total: number };
  assertSameIds(body.items, ["alpha-row", "beta-row"]);
  assert.equal(body.total, 2);
});

test("start_task inherits a single-project API-key scope when project is omitted", async () => {
  const db = getDb();
  insertKnowledgeRow(db, { id: "alpha-auth", claim: "Auth note in alpha", project: "alpha" });
  insertKnowledgeRow(db, { id: "beta-auth", claim: "Auth note in beta", project: "beta" });
  const apiKey = createApiKey("TaskScopedOwner", ["alpha"]);

  const response = await app.request("http://localhost/api/tasks/start", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ description: "auth" }),
  });

  assert.equal(response.status, 201);
  const body = await response.json() as {
    task_id: string;
    project: string | null;
    matches: Array<{ id: string }>;
  };
  assert.equal(typeof body.task_id, "string");
  assert.equal(body.project, "alpha");
  assertSameIds(body.matches, ["alpha-auth"]);
});

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

before(async () => {
  const routesModule = await import("../src/routes.ts");
  const dbModule = await import("../src/db.ts");

  const honoApp = new Hono();
  honoApp.route("/api", routesModule.api);

  app = honoApp;
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
});

afterEach(() => {
  const db = getDb();
  db.exec("DELETE FROM knowledge; DELETE FROM api_keys;");
});

after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.TEAM_MEMORY_DB;
  delete process.env.TEAM_MEMORY_STALE_AFTER_DAYS;
});

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
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO knowledge (
      id, claim, detail, source, project, module, tags, confidence,
      staleness_hint, owner, related_to, supersedes, superseded_by,
      duplicate_of, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    now,
    now,
  );
}

test("fuzzy duplicate warnings do not persist duplicate_of", async () => {
  const apiKey = createApiKey();

  const original = await publishKnowledge(apiKey, {
    claim: "Billing pipeline uses Redis Stream buffering between inference and control.",
  });
  const fuzzy = await publishKnowledge(apiKey, {
    claim: "Billing pipeline routes usage through Redis buffering before control persistence.",
  });

  assert.equal(fuzzy.warnings?.[0]?.code, "possible_duplicate");
  assert.equal(fuzzy.warnings?.[0]?.matches[0]?.id, original.id);
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

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import Database from "better-sqlite3";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "team-memory-task-sessions-schema-"));
const dbPath = path.join(tempDir, "team-memory.db");

process.env.TEAM_MEMORY_DB = dbPath;

interface TableColumnInfo {
  name: string;
}

interface ApiKeyRow {
  id: string | null;
  key: string;
  owner: string;
  default_projects: string | null;
  description: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

interface UsageEventRow {
  id: number;
  knowledge_id: string | null;
  owner: string;
  event_type: string;
  request_id: string | null;
  task_id: string | null;
  query_text: string | null;
  result_count: number | null;
  project: string;
  search_mode: string | null;
  query_context: string | null;
  created_at: string;
}

interface ReuseFeedbackRow {
  id: number;
  knowledge_id: string;
  owner: string;
  verdict: string;
  comment: string | null;
  task_id: string | null;
  created_at: string;
}

let getDb: () => Database.Database;
let closeDb: () => void;
let assertSchemaUpToDate: (db: Database.Database, table: string, columns: string[]) => void;

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as TableColumnInfo[]).map((column) => column.name);
}

function indexExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
  ).get(name);
  return Boolean(row);
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name);
  return Boolean(row);
}

function resetDbFile(): void {
  closeDb();
  if (existsSync(dbPath)) {
    unlinkSync(dbPath);
  }
}

before(async () => {
  const dbModule = await import("../src/db.ts") as typeof import("../src/db.ts") & {
    assertSchemaUpToDate?: (db: Database.Database, table: string, columns: string[]) => void;
  };
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  assertSchemaUpToDate = dbModule.assertSchemaUpToDate!;
});

afterEach(() => {
  resetDbFile();
});

after(() => {
  resetDbFile();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.TEAM_MEMORY_DB;
});

test("fresh database creates task-session tables and trace-linkage columns", () => {
  const db = getDb();

  assert.ok(tableExists(db, "tasks"));
  assert.ok(tableExists(db, "task_publications"));

  assert.ok(tableColumns(db, "usage_events").includes("task_id"));
  assert.ok(tableColumns(db, "reuse_feedback").includes("task_id"));

  assert.ok(indexExists(db, "idx_usage_events_task_id"));
  assert.ok(indexExists(db, "idx_reuse_feedback_task_id"));
  assert.ok(indexExists(db, "idx_task_publications_knowledge_id"));
});

test("migrates legacy usage and feedback tables without losing rows", () => {
  const legacyDb = new Database(dbPath);
  legacyDb.pragma("foreign_keys = ON");

  legacyDb.exec(`
    CREATE TABLE knowledge (
      id              TEXT PRIMARY KEY,
      claim           TEXT NOT NULL,
      detail          TEXT,
      source          TEXT NOT NULL DEFAULT '[]',
      project         TEXT NOT NULL,
      module          TEXT,
      tags            TEXT NOT NULL DEFAULT '[]',
      confidence      TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
      staleness_hint  TEXT NOT NULL,
      owner           TEXT NOT NULL,
      related_to      TEXT NOT NULL DEFAULT '[]',
      supersedes      TEXT,
      superseded_by   TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE TABLE usage_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      knowledge_id  TEXT REFERENCES knowledge(id) ON DELETE CASCADE,
      owner         TEXT NOT NULL,
      event_type    TEXT NOT NULL CHECK (event_type IN ('query', 'exposure', 'view')),
      request_id    TEXT,
      query_text    TEXT,
      result_count  INTEGER,
      project       TEXT NOT NULL DEFAULT '',
      search_mode   TEXT CHECK (search_mode IN ('fts', 'semantic', 'hybrid')),
      query_context TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE reuse_feedback (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      knowledge_id  TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
      owner         TEXT NOT NULL,
      verdict       TEXT NOT NULL CHECK (verdict IN ('useful', 'not_useful', 'outdated')),
      comment       TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  legacyDb.prepare(
    `INSERT INTO knowledge (
      id, claim, detail, source, project, module, tags, confidence,
      staleness_hint, owner, related_to, supersedes, superseded_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "legacy-item",
    "Legacy usage rows should survive task-session migration.",
    null,
    JSON.stringify(["tests/task-sessions-schema.test.ts"]),
    "team-memory",
    null,
    JSON.stringify(["migration"]),
    "high",
    "Recheck if schema semantics change.",
    "Seeder",
    JSON.stringify([]),
    null,
    null,
    "2026-04-17T00:00:00.000Z",
    "2026-04-17T00:00:00.000Z",
  );

  legacyDb.prepare(
    `INSERT INTO usage_events (
      knowledge_id, owner, event_type, request_id, query_text,
      result_count, project, search_mode, query_context, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "legacy-item",
    "LegacyUser",
    "exposure",
    "legacy-request",
    null,
    null,
    "team-memory",
    "hybrid",
    "legacy query context",
    "2026-04-17T00:00:00.000Z",
  );

  legacyDb.prepare(
    `INSERT INTO reuse_feedback (
      knowledge_id, owner, verdict, comment, created_at
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "legacy-item",
    "LegacyUser",
    "useful",
    "Still relevant after migration.",
    "2026-04-17T00:00:00.000Z",
  );

  legacyDb.close();

  const db = getDb();

  assert.ok(tableExists(db, "tasks"));
  assert.ok(tableExists(db, "task_publications"));
  assert.ok(tableColumns(db, "usage_events").includes("task_id"));
  assert.ok(tableColumns(db, "reuse_feedback").includes("task_id"));

  const usageRows = db.prepare(
    `SELECT id, knowledge_id, owner, event_type, request_id, task_id, query_text,
            result_count, project, search_mode, query_context, created_at
     FROM usage_events
     ORDER BY id ASC`,
  ).all() as UsageEventRow[];

  assert.equal(usageRows.length, 1);
  assert.equal(usageRows[0]!.knowledge_id, "legacy-item");
  assert.equal(usageRows[0]!.owner, "LegacyUser");
  assert.equal(usageRows[0]!.event_type, "exposure");
  assert.equal(usageRows[0]!.request_id, "legacy-request");
  assert.equal(usageRows[0]!.task_id, null);
  assert.equal(usageRows[0]!.project, "team-memory");
  assert.equal(usageRows[0]!.search_mode, "hybrid");
  assert.equal(usageRows[0]!.query_context, "legacy query context");

  const feedbackRows = db.prepare(
    `SELECT id, knowledge_id, owner, verdict, comment, task_id, created_at
     FROM reuse_feedback
     ORDER BY id ASC`,
  ).all() as ReuseFeedbackRow[];

  assert.equal(feedbackRows.length, 1);
  assert.equal(feedbackRows[0]!.knowledge_id, "legacy-item");
  assert.equal(feedbackRows[0]!.owner, "LegacyUser");
  assert.equal(feedbackRows[0]!.verdict, "useful");
  assert.equal(feedbackRows[0]!.comment, "Still relevant after migration.");
  assert.equal(feedbackRows[0]!.task_id, null);
});

test("migrates legacy api_keys schema before creating A5 indexes", () => {
  const legacyDb = new Database(dbPath);
  legacyDb.pragma("foreign_keys = ON");

  legacyDb.exec(`
    CREATE TABLE api_keys (
      key         TEXT PRIMARY KEY,
      owner       TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      revoked_at  TEXT,
      default_projects TEXT
    );
  `);

  legacyDb.prepare(
    `INSERT INTO api_keys (key, owner, created_at, revoked_at, default_projects)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "tm_legacy_key",
    "LegacyOwner",
    "2026-04-17T00:00:00.000Z",
    null,
    JSON.stringify(["hackathon"]),
  );

  legacyDb.close();

  const db = getDb();
  const columns = tableColumns(db, "api_keys");
  assert.ok(columns.includes("id"));
  assert.ok(columns.includes("description"));
  assert.ok(columns.includes("expires_at"));
  assert.ok(columns.includes("last_used_at"));
  assert.ok(indexExists(db, "idx_api_keys_id"));
  assert.ok(indexExists(db, "idx_api_keys_expires_at"));

  const row = db.prepare(
    `SELECT id, key, owner, default_projects, description, expires_at, last_used_at, created_at, revoked_at
     FROM api_keys
     WHERE key = ?`,
  ).get("tm_legacy_key") as ApiKeyRow | undefined;

  assert.ok(row);
  assert.equal(row!.owner, "LegacyOwner");
  assert.equal(row!.default_projects, JSON.stringify(["hackathon"]));
  assert.equal(row!.description, null);
  assert.equal(row!.expires_at, null);
  assert.equal(row!.last_used_at, null);
  assert.match(row!.id ?? "", /^key_[0-9a-f]{16}$/);
});

test("assertSchemaUpToDate rejects stale api_keys schema before migration", () => {
  const legacyDb = new Database(dbPath);
  legacyDb.pragma("foreign_keys = ON");

  legacyDb.exec(`
    CREATE TABLE api_keys (
      key         TEXT PRIMARY KEY,
      owner       TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      revoked_at  TEXT,
      default_projects TEXT
    );
  `);

  assert.throws(
    () => assertSchemaUpToDate(legacyDb, "api_keys", ["key", "id", "default_projects", "expires_at"]),
    /api_keys.*id.*expires_at|id.*expires_at.*api_keys/,
  );

  legacyDb.close();
});

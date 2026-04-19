import Database from "better-sqlite3";
import path from "node:path";
import { cleanupFalsePositiveDuplicateOf } from "./duplicates.js";

const DB_PATH = process.env.TEAM_MEMORY_DB ?? path.join(process.cwd(), "team-memory.db");

let _db: Database.Database | null = null;

interface TableColumnInfo {
  name: string;
  notnull: number;
}

function tableInfo(db: Database.Database, table: string): TableColumnInfo[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
  return rows;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = tableInfo(db, table);
  return rows.some((row) => row.name === column);
}

export function assertSchemaUpToDate(
  db: Database.Database,
  table: string,
  requiredColumns: string[],
): void {
  const missing = requiredColumns.filter((column) => !hasColumn(db, table, column));
  if (missing.length > 0) {
    throw new Error(
      `Schema mismatch for ${table}: missing columns ${missing.join(", ")}`,
    );
  }
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function tableSql(db: Database.Database, table: string): string | null {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

function createUsageEventsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      knowledge_id  TEXT REFERENCES knowledge(id) ON DELETE CASCADE,
      owner         TEXT NOT NULL,
      event_type    TEXT NOT NULL CHECK (event_type IN ('query', 'exposure', 'view')),
      request_id    TEXT,
      task_id       TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
      query_text    TEXT,
      result_count  INTEGER,
      project       TEXT NOT NULL DEFAULT '',
      search_mode   TEXT CHECK (search_mode IN ('fts', 'semantic', 'hybrid')),
      query_context TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function createUsageEventsIndexes(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_usage_events_knowledge ON usage_events(knowledge_id);
    CREATE INDEX IF NOT EXISTS idx_usage_events_owner ON usage_events(owner);
    CREATE INDEX IF NOT EXISTS idx_usage_events_request ON usage_events(request_id);
    CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_events_project ON usage_events(project);
    CREATE INDEX IF NOT EXISTS idx_usage_events_event_type ON usage_events(event_type);
  `);
}

function ensureUsageEventsSchema(db: Database.Database): void {
  createUsageEventsTable(db);

  const columns = tableInfo(db, "usage_events");
  if (columns.length === 0) {
    createUsageEventsIndexes(db);
    return;
  }

  const sql = tableSql(db, "usage_events")?.toLowerCase() ?? "";
  const knowledgeId = columns.find((column) => column.name === "knowledge_id");
  const project = columns.find((column) => column.name === "project");
  const needsMigration =
    !hasColumn(db, "usage_events", "query_text")
    || !hasColumn(db, "usage_events", "result_count")
    || !hasColumn(db, "usage_events", "project")
    || !hasColumn(db, "usage_events", "search_mode")
    || !sql.includes("'query'")
    || knowledgeId?.notnull === 1
    || project?.notnull !== 1;

  if (!needsMigration) {
    createUsageEventsIndexes(db);
    return;
  }

  db.exec(`
    ALTER TABLE usage_events RENAME TO usage_events_legacy;
    DROP INDEX IF EXISTS idx_usage_events_knowledge;
    DROP INDEX IF EXISTS idx_usage_events_owner;
    DROP INDEX IF EXISTS idx_usage_events_request;
    DROP INDEX IF EXISTS idx_usage_events_created;
    DROP INDEX IF EXISTS idx_usage_events_project;
    DROP INDEX IF EXISTS idx_usage_events_event_type;
  `);

  createUsageEventsTable(db);

  db.exec(`
    INSERT INTO usage_events (
      id, knowledge_id, owner, event_type, request_id, task_id,
      query_text, result_count, project, search_mode, query_context, created_at
    )
    SELECT
      legacy.id,
      legacy.knowledge_id,
      legacy.owner,
      legacy.event_type,
      legacy.request_id,
      NULL,
      NULL,
      NULL,
      COALESCE(knowledge.project, ''),
      NULL,
      legacy.query_context,
      legacy.created_at
    FROM usage_events_legacy AS legacy
    LEFT JOIN knowledge ON knowledge.id = legacy.knowledge_id
  `);

  db.exec("DROP TABLE usage_events_legacy");
  createUsageEventsIndexes(db);
}

export function getDb(): Database.Database {
  if (_db) return _db;

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge (
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

    CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project);
    CREATE INDEX IF NOT EXISTS idx_knowledge_owner ON knowledge(owner);
    CREATE INDEX IF NOT EXISTS idx_knowledge_created ON knowledge(created_at);
    CREATE INDEX IF NOT EXISTS idx_knowledge_superseded_by ON knowledge(superseded_by);

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      claim, detail, tags,
      content=knowledge, content_rowid=rowid
    );

    CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, claim, detail, tags)
      VALUES (new.rowid, new.claim, new.detail, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, claim, detail, tags)
      VALUES ('delete', old.rowid, old.claim, old.detail, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, claim, detail, tags)
      VALUES ('delete', old.rowid, old.claim, old.detail, old.tags);
      INSERT INTO knowledge_fts(rowid, claim, detail, tags)
      VALUES (new.rowid, new.claim, new.detail, new.tags);
    END;

    CREATE TABLE IF NOT EXISTS api_keys (
      id          TEXT UNIQUE,
      key         TEXT PRIMARY KEY,
      owner       TEXT NOT NULL,
      default_projects TEXT,
      description TEXT,
      expires_at  TEXT,
      last_used_at TEXT,
      created_at  TEXT NOT NULL,
      revoked_at  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys(owner);
    CREATE INDEX IF NOT EXISTS idx_api_keys_revoked_at ON api_keys(revoked_at);

    CREATE TABLE IF NOT EXISTS tasks (
      task_id      TEXT PRIMARY KEY,
      owner        TEXT NOT NULL,
      project      TEXT,
      description  TEXT NOT NULL,
      status       TEXT NOT NULL CHECK (status IN ('open', 'completed', 'abandoned')) DEFAULT 'open',
      opened_at    TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_owner_status ON tasks(owner, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_opened_at ON tasks(opened_at);

    CREATE TABLE IF NOT EXISTS reuse_feedback (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      knowledge_id  TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
      owner         TEXT NOT NULL,
      verdict       TEXT NOT NULL CHECK (verdict IN ('useful', 'not_useful', 'outdated')),
      comment       TEXT,
      task_id       TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_reuse_feedback_knowledge ON reuse_feedback(knowledge_id);
    CREATE INDEX IF NOT EXISTS idx_reuse_feedback_owner ON reuse_feedback(owner);
    CREATE INDEX IF NOT EXISTS idx_reuse_feedback_created ON reuse_feedback(created_at);

    CREATE TABLE IF NOT EXISTS task_publications (
      task_id       TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      knowledge_id  TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (task_id, knowledge_id)
    );

    CREATE INDEX IF NOT EXISTS idx_task_publications_knowledge_id ON task_publications(knowledge_id);
  `);

  ensureUsageEventsSchema(_db);
  ensureColumn(_db, "usage_events", "task_id", "TEXT REFERENCES tasks(task_id) ON DELETE SET NULL");
  _db.exec("CREATE INDEX IF NOT EXISTS idx_usage_events_task_id ON usage_events(task_id)");
  ensureColumn(_db, "knowledge", "duplicate_of", "TEXT");
  _db.exec("CREATE INDEX IF NOT EXISTS idx_knowledge_duplicate_of ON knowledge(duplicate_of)");
  ensureColumn(_db, "knowledge", "embedding", "BLOB");
  ensureColumn(_db, "api_keys", "id", "TEXT");
  ensureColumn(_db, "api_keys", "default_projects", "TEXT");
  ensureColumn(_db, "api_keys", "description", "TEXT");
  ensureColumn(_db, "api_keys", "expires_at", "TEXT");
  ensureColumn(_db, "api_keys", "last_used_at", "TEXT");
  _db.exec("UPDATE api_keys SET id = 'key_' || printf('%016x', rowid) WHERE id IS NULL OR id = ''");
  assertSchemaUpToDate(_db, "api_keys", ["key", "id", "default_projects", "expires_at"]);
  _db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_id ON api_keys(id)");
  _db.exec("CREATE INDEX IF NOT EXISTS idx_api_keys_expires_at ON api_keys(expires_at)");
  ensureColumn(_db, "reuse_feedback", "task_id", "TEXT REFERENCES tasks(task_id) ON DELETE SET NULL");
  _db.exec("CREATE INDEX IF NOT EXISTS idx_reuse_feedback_task_id ON reuse_feedback(task_id)");
  cleanupFalsePositiveDuplicateOf(_db);

  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

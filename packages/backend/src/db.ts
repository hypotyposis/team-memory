import Database from "better-sqlite3";
import path from "node:path";

const DB_PATH = process.env.TEAM_MEMORY_DB ?? path.join(process.cwd(), "team-memory.db");

let _db: Database.Database | null = null;

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
  `);

  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

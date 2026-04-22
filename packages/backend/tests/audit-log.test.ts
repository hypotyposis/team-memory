import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import type Database from "better-sqlite3";
import { Hono } from "hono";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "team-memory-audit-log-"));
const dbPath = path.join(tempDir, "team-memory.db");

process.env.TEAM_MEMORY_DB = dbPath;

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
let createStoredApiKey: typeof import("../src/api-keys.ts").createApiKey;

function adminHeaders(key = process.env.TEAM_MEMORY_ADMIN_KEY ?? "tm_admin_test"): HeadersInit {
  return {
    authorization: `Bearer ${key}`,
  };
}

function apiHeaders(key: string): HeadersInit {
  return {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
}

function insertKnowledgeRow(
  db: Database.Database,
  input: {
    id: string;
    owner: string;
    claim?: string;
    project?: string;
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
    input.claim ?? `Claim for ${input.id}`,
    null,
    JSON.stringify(["tests/audit-log.test.ts"]),
    input.project ?? "alpha",
    "audit",
    JSON.stringify(["audit"]),
    "high",
    "Recheck if audit semantics change.",
    input.owner,
    JSON.stringify([]),
    null,
    null,
    null,
    null,
    now,
    now,
  );
}

function insertAuditEvent(
  db: Database.Database,
  input: {
    eventType: "publish" | "update" | "supersede" | "delete";
    knowledgeId: string;
    owner: string;
    project: string | null;
    actorKeyId?: string | null;
    changedFields?: string[] | null;
    createdAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO audit_events (
      event_type, knowledge_id, owner, project, actor_key_id, changed_fields, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.eventType,
    input.knowledgeId,
    input.owner,
    input.project,
    input.actorKeyId ?? null,
    input.changedFields ? JSON.stringify(input.changedFields) : null,
    input.createdAt,
  );
}

before(async () => {
  const routesModule = await import("../src/routes.ts");
  const dbModule = await import("../src/db.ts");
  const apiKeysModule = await import("../src/api-keys.ts");

  const honoApp = new Hono();
  honoApp.route("/api", routesModule.api);

  app = honoApp;
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  createStoredApiKey = apiKeysModule.createApiKey;
});

afterEach(() => {
  delete process.env.TEAM_MEMORY_ADMIN_KEY;
  const db = getDb();
  db.exec("DELETE FROM audit_events; DELETE FROM task_publications; DELETE FROM reuse_feedback; DELETE FROM usage_events; DELETE FROM tasks; DELETE FROM knowledge; DELETE FROM api_keys;");
});

after(() => {
  delete process.env.TEAM_MEMORY_DB;
  delete process.env.TEAM_MEMORY_ADMIN_KEY;
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

test("POST /api/knowledge writes a publish audit event with the actor key id", async () => {
  const db = getDb();
  const record = createStoredApiKey(db, {
    owner: "Alice",
    defaultProjects: ["alpha"],
  });

  const response = await app.request("http://localhost/api/knowledge", {
    method: "POST",
    headers: apiHeaders(record.key),
    body: JSON.stringify({
      claim: "Publish audit event",
      source: ["tests/audit-log.test.ts"],
      project: "alpha",
      tags: ["audit"],
      confidence: "high",
      staleness_hint: "Recheck if publish audit behavior changes.",
    }),
  });

  assert.equal(response.status, 201);
  const body = await response.json() as { id: string };

  const rows = db.prepare(
    `SELECT id, event_type, knowledge_id, owner, project, actor_key_id, changed_fields, created_at
     FROM audit_events
     ORDER BY id ASC`,
  ).all() as Array<{
    event_type: string;
    knowledge_id: string;
    owner: string;
    project: string | null;
    actor_key_id: string | null;
    changed_fields: string | null;
  }>;

  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.event_type, "publish");
  assert.equal(rows[0]!.knowledge_id, body.id);
  assert.equal(rows[0]!.owner, "Alice");
  assert.equal(rows[0]!.project, "alpha");
  assert.equal(rows[0]!.actor_key_id, record.id);
  assert.equal(rows[0]!.changed_fields, null);
});

test("PATCH /api/knowledge/:id writes update audit row with exactly the changed fields", async () => {
  const db = getDb();
  const record = createStoredApiKey(db, {
    owner: "Alice",
    defaultProjects: ["alpha"],
  });
  insertKnowledgeRow(db, { id: "alpha-note", owner: "Alice", project: "alpha" });

  const response = await app.request("http://localhost/api/knowledge/alpha-note", {
    method: "PATCH",
    headers: apiHeaders(record.key),
    body: JSON.stringify({
      tags: ["audit", "updated"],
      confidence: "high",
      staleness_hint: "Updated staleness hint",
      related_to: [],
    }),
  });

  assert.equal(response.status, 200);

  const row = db.prepare(
    `SELECT id, event_type, knowledge_id, owner, project, actor_key_id, changed_fields, created_at
     FROM audit_events
     ORDER BY id DESC
     LIMIT 1`,
  ).get() as {
    event_type: string;
    knowledge_id: string;
    owner: string;
    project: string | null;
    actor_key_id: string | null;
    changed_fields: string | null;
  };

  assert.equal(row.event_type, "update");
  assert.equal(row.knowledge_id, "alpha-note");
  assert.equal(row.owner, "Alice");
  assert.equal(row.project, "alpha");
  assert.equal(row.actor_key_id, record.id);
  assert.deepEqual(JSON.parse(row.changed_fields ?? "[]"), ["tags", "staleness_hint"]);
});

test("publishing with supersedes writes publish and supersede audit rows", async () => {
  const db = getDb();
  const record = createStoredApiKey(db, {
    owner: "Alice",
    defaultProjects: ["alpha"],
  });
  insertKnowledgeRow(db, { id: "old-note", owner: "Bob", project: "alpha" });

  const response = await app.request("http://localhost/api/knowledge", {
    method: "POST",
    headers: apiHeaders(record.key),
    body: JSON.stringify({
      claim: "New superseding knowledge",
      source: ["tests/audit-log.test.ts"],
      project: "alpha",
      tags: ["audit"],
      confidence: "high",
      staleness_hint: "Recheck if supersede logging changes.",
      supersedes: "old-note",
    }),
  });

  assert.equal(response.status, 201);
  const body = await response.json() as { id: string };

  const rows = db.prepare(
    `SELECT event_type, knowledge_id, owner, project, actor_key_id
     FROM audit_events
     ORDER BY id ASC`,
  ).all() as Array<{
    event_type: string;
    knowledge_id: string;
    owner: string;
    project: string | null;
    actor_key_id: string | null;
  }>;

  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => ({
      event_type: row.event_type,
      knowledge_id: row.knowledge_id,
      owner: row.owner,
      project: row.project,
      actor_key_id: row.actor_key_id,
    })),
    [
      {
        event_type: "publish",
        knowledge_id: body.id,
        owner: "Alice",
        project: "alpha",
        actor_key_id: record.id,
      },
      {
        event_type: "supersede",
        knowledge_id: "old-note",
        owner: "Alice",
        project: "alpha",
        actor_key_id: record.id,
      },
    ],
  );
});

test("GET /api/admin/audit-log paginates and respects filter combinations", async () => {
  process.env.TEAM_MEMORY_ADMIN_KEY = "tm_admin_secret";
  const db = getDb();
  insertAuditEvent(db, {
    eventType: "publish",
    knowledgeId: "alpha-new",
    owner: "Alice",
    project: "alpha",
    createdAt: new Date().toISOString(),
  });
  insertAuditEvent(db, {
    eventType: "update",
    knowledgeId: "alpha-updated",
    owner: "Alice",
    project: "alpha",
    changedFields: ["tags"],
    createdAt: new Date().toISOString(),
  });
  insertAuditEvent(db, {
    eventType: "publish",
    knowledgeId: "beta-new",
    owner: "Bob",
    project: "beta",
    createdAt: new Date().toISOString(),
  });
  insertAuditEvent(db, {
    eventType: "supersede",
    knowledgeId: "old-alpha",
    owner: "Alice",
    project: "alpha",
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
  });

  const filteredResponse = await app.request(
    "http://localhost/api/admin/audit-log?owner=Alice&project=alpha&event_type=publish&since=1d",
    {
      headers: adminHeaders(),
    },
  );
  assert.equal(filteredResponse.status, 200);
  const filteredBody = await filteredResponse.json() as {
    items: Array<{
      event_type: string;
      knowledge_id: string;
      owner: string;
      project: string | null;
      actor_key_id: string | null;
      changed_fields: string[] | null;
    }>;
    total: number;
  };
  assert.equal(filteredBody.total, 1);
  assert.equal(filteredBody.items.length, 1);
  assert.equal(filteredBody.items[0]!.event_type, "publish");
  assert.equal(filteredBody.items[0]!.knowledge_id, "alpha-new");
  assert.equal(filteredBody.items[0]!.owner, "Alice");
  assert.equal(filteredBody.items[0]!.project, "alpha");
  assert.equal(filteredBody.items[0]!.actor_key_id, null);
  assert.equal(filteredBody.items[0]!.changed_fields, null);

  const knowledgeResponse = await app.request(
    "http://localhost/api/admin/audit-log?knowledge_id=alpha-updated",
    {
      headers: adminHeaders(),
    },
  );
  assert.equal(knowledgeResponse.status, 200);
  const knowledgeBody = await knowledgeResponse.json() as {
    items: Array<{
      knowledge_id: string;
      event_type: string;
      changed_fields: string[] | null;
    }>;
    total: number;
  };
  assert.equal(knowledgeBody.total, 1);
  assert.equal(knowledgeBody.items[0]!.knowledge_id, "alpha-updated");
  assert.equal(knowledgeBody.items[0]!.event_type, "update");
  assert.deepEqual(knowledgeBody.items[0]!.changed_fields, ["tags"]);

  const paginatedResponse = await app.request(
    "http://localhost/api/admin/audit-log?limit=1&offset=1",
    {
      headers: adminHeaders(),
    },
  );
  assert.equal(paginatedResponse.status, 200);
  const paginatedBody = await paginatedResponse.json() as {
    items: Array<{ knowledge_id: string }>;
    total: number;
  };
  assert.equal(paginatedBody.total, 4);
  assert.equal(paginatedBody.items.length, 1);
});

test("GET /api/admin/audit-log returns 404 without a valid admin credential", async () => {
  const disabledResponse = await app.request("http://localhost/api/admin/audit-log");
  assert.equal(disabledResponse.status, 404);

  process.env.TEAM_MEMORY_ADMIN_KEY = "tm_admin_secret";
  const wrongAuthResponse = await app.request("http://localhost/api/admin/audit-log", {
    headers: adminHeaders("tm_admin_wrong"),
  });
  assert.equal(wrongAuthResponse.status, 404);
});

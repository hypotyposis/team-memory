import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import type Database from "better-sqlite3";
import { Hono } from "hono";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "team-memory-admin-keys-"));
const dbPath = path.join(tempDir, "team-memory.db");

process.env.TEAM_MEMORY_DB = dbPath;

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
let createStoredApiKey: typeof import("../src/api-keys.ts").createApiKey;

function adminHeaders(key = process.env.TEAM_MEMORY_ADMIN_KEY ?? "tm_admin_test"): HeadersInit {
  return {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
}

function insertKnowledgeRow(
  db: Database.Database,
  input: {
    id: string;
    claim: string;
    project: string;
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
    JSON.stringify(["tests/admin-keys.test.ts"]),
    input.project,
    "admin",
    JSON.stringify(["admin"]),
    "high",
    "Recheck if admin key semantics change.",
    "Seeder",
    JSON.stringify([]),
    null,
    null,
    null,
    null,
    now,
    now,
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
  db.exec("DELETE FROM task_publications; DELETE FROM reuse_feedback; DELETE FROM usage_events; DELETE FROM tasks; DELETE FROM knowledge; DELETE FROM api_keys;");
});

after(() => {
  delete process.env.TEAM_MEMORY_DB;
  delete process.env.TEAM_MEMORY_ADMIN_KEY;
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

test("POST /api/admin/keys returns 404 when admin auth is disabled", async () => {
  const response = await app.request("http://localhost/api/admin/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      owner: "DevOps",
      default_projects: ["alpha"],
    }),
  });

  assert.equal(response.status, 404);
});

test("POST /api/admin/keys returns 404 when the admin key is wrong or missing", async () => {
  process.env.TEAM_MEMORY_ADMIN_KEY = "tm_admin_secret";

  const missingAuthResponse = await app.request("http://localhost/api/admin/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      owner: "DevOps",
      default_projects: ["alpha"],
    }),
  });
  assert.equal(missingAuthResponse.status, 404);

  const wrongAuthResponse = await app.request("http://localhost/api/admin/keys", {
    method: "POST",
    headers: adminHeaders("tm_admin_wrong"),
    body: JSON.stringify({
      owner: "DevOps",
      default_projects: ["alpha"],
    }),
  });
  assert.equal(wrongAuthResponse.status, 404);
});

test("POST /api/admin/keys mints a scoped key that is immediately usable", async () => {
  process.env.TEAM_MEMORY_ADMIN_KEY = "tm_admin_secret";
  const db = getDb();
  insertKnowledgeRow(db, { id: "alpha-item", claim: "Alpha note", project: "alpha" });
  insertKnowledgeRow(db, { id: "beta-item", claim: "Beta note", project: "beta" });

  const response = await app.request("http://localhost/api/admin/keys", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      owner: "DevOps",
      default_projects: ["alpha"],
      description: "scoped alpha key",
      expires_at: "2026-06-01T00:00:00Z",
    }),
  });

  assert.equal(response.status, 201);
  const body = await response.json() as {
    id: string;
    key: string;
    owner: string;
    default_projects: string[] | null;
    unscoped: boolean;
    description: string | null;
    expires_at: string | null;
  };
  assert.equal(typeof body.id, "string");
  assert.equal(typeof body.key, "string");
  assert.equal(body.owner, "DevOps");
  assert.deepEqual(body.default_projects, ["alpha"]);
  assert.equal(body.unscoped, false);
  assert.equal(body.description, "scoped alpha key");
  assert.equal(body.expires_at, "2026-06-01T00:00:00.000Z");

  const knowledgeResponse = await app.request("http://localhost/api/knowledge", {
    headers: { authorization: `Bearer ${body.key}` },
  });

  assert.equal(knowledgeResponse.status, 200);
  const knowledgeBody = await knowledgeResponse.json() as {
    items: Array<{ id: string }>;
    total: number;
  };
  assert.deepEqual(knowledgeBody.items.map((item) => item.id), ["alpha-item"]);
  assert.equal(knowledgeBody.total, 1);
});

test("POST /api/admin/keys supports explicit unscoped opt-out", async () => {
  process.env.TEAM_MEMORY_ADMIN_KEY = "tm_admin_secret";
  const db = getDb();
  insertKnowledgeRow(db, { id: "alpha-item", claim: "Alpha note", project: "alpha" });
  insertKnowledgeRow(db, { id: "beta-item", claim: "Beta note", project: "beta" });

  const response = await app.request("http://localhost/api/admin/keys", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      owner: "DevOps",
      unscoped: true,
      description: "explicit unscoped key",
    }),
  });

  assert.equal(response.status, 201);
  const body = await response.json() as {
    key: string;
    default_projects: string[] | null;
    unscoped: boolean;
  };
  assert.equal(body.default_projects, null);
  assert.equal(body.unscoped, true);

  const knowledgeResponse = await app.request("http://localhost/api/knowledge", {
    headers: { authorization: `Bearer ${body.key}` },
  });

  assert.equal(knowledgeResponse.status, 200);
  const knowledgeBody = await knowledgeResponse.json() as {
    items: Array<{ id: string }>;
  };
  assert.deepEqual(
    knowledgeBody.items.map((item) => item.id).sort(),
    ["alpha-item", "beta-item"],
  );
});

test("POST /api/admin/keys rejects ambiguous or missing scope input", async () => {
  process.env.TEAM_MEMORY_ADMIN_KEY = "tm_admin_secret";

  const cases = [
    {
      body: { owner: "DevOps" },
      status: 400,
      code: "admin_default_projects_required",
    },
    {
      body: { owner: "DevOps", default_projects: [] },
      status: 400,
      code: "admin_default_projects_invalid",
    },
    {
      body: { owner: "DevOps", default_projects: ["alpha"], unscoped: true },
      status: 400,
      code: "admin_scope_conflict",
    },
  ];

  for (const testCase of cases) {
    const response = await app.request("http://localhost/api/admin/keys", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify(testCase.body),
    });

    assert.equal(response.status, testCase.status);
    const body = await response.json() as { code: string };
    assert.equal(body.code, testCase.code);
  }
});

test("GET /api/admin/keys lists keys without echoing secrets", async () => {
  process.env.TEAM_MEMORY_ADMIN_KEY = "tm_admin_secret";
  await app.request("http://localhost/api/admin/keys", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      owner: "DevOps",
      default_projects: ["alpha"],
      description: "list test key",
    }),
  });

  const response = await app.request("http://localhost/api/admin/keys", {
    headers: { authorization: "Bearer tm_admin_secret" },
  });

  assert.equal(response.status, 200);
  const body = await response.json() as {
    items: Array<Record<string, unknown>>;
  };

  assert.equal(body.items.length, 1);
  assert.equal("key" in body.items[0]!, false);
  assert.deepEqual(body.items[0]!.default_projects, ["alpha"]);
  assert.equal(body.items[0]!.unscoped, false);
});

test("PATCH /api/admin/keys can switch an existing key to explicit unscoped mode", async () => {
  process.env.TEAM_MEMORY_ADMIN_KEY = "tm_admin_secret";
  const db = getDb();
  insertKnowledgeRow(db, { id: "alpha-item", claim: "Alpha note", project: "alpha" });
  insertKnowledgeRow(db, { id: "beta-item", claim: "Beta note", project: "beta" });

  const createdResponse = await app.request("http://localhost/api/admin/keys", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      owner: "DevOps",
      default_projects: ["alpha"],
    }),
  });
  const createdBody = await createdResponse.json() as {
    id: string;
    key: string;
  };

  const patchResponse = await app.request(`http://localhost/api/admin/keys/${createdBody.id}`, {
    method: "PATCH",
    headers: adminHeaders(),
    body: JSON.stringify({
      unscoped: true,
      description: "now unscoped",
    }),
  });

  assert.equal(patchResponse.status, 200);
  const patchBody = await patchResponse.json() as {
    default_projects: string[] | null;
    unscoped: boolean;
    description: string | null;
  };
  assert.equal(patchBody.default_projects, null);
  assert.equal(patchBody.unscoped, true);
  assert.equal(patchBody.description, "now unscoped");

  const knowledgeResponse = await app.request("http://localhost/api/knowledge", {
    headers: { authorization: `Bearer ${createdBody.key}` },
  });
  const knowledgeBody = await knowledgeResponse.json() as {
    items: Array<{ id: string }>;
  };
  assert.deepEqual(
    knowledgeBody.items.map((item) => item.id).sort(),
    ["alpha-item", "beta-item"],
  );
});

test("DELETE /api/admin/keys revokes the key and expired keys return 401 on use", async () => {
  process.env.TEAM_MEMORY_ADMIN_KEY = "tm_admin_secret";
  const activeRecord = createStoredApiKey(getDb(), {
    owner: "DeleteMe",
    defaultProjects: ["alpha"],
  });
  const expiredRecord = createStoredApiKey(getDb(), {
    owner: "Expired",
    defaultProjects: ["alpha"],
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });

  const deleteResponse = await app.request(`http://localhost/api/admin/keys/${activeRecord.id}`, {
    method: "DELETE",
    headers: { authorization: "Bearer tm_admin_secret" },
  });
  assert.equal(deleteResponse.status, 204);

  const revokedUseResponse = await app.request("http://localhost/api/knowledge", {
    headers: { authorization: `Bearer ${activeRecord.key}` },
  });
  assert.equal(revokedUseResponse.status, 401);
  const revokedBody = await revokedUseResponse.json() as { code: string };
  assert.equal(revokedBody.code, "auth_invalid");

  const expiredUseResponse = await app.request("http://localhost/api/knowledge", {
    headers: { authorization: `Bearer ${expiredRecord.key}` },
  });
  assert.equal(expiredUseResponse.status, 401);
  const expiredBody = await expiredUseResponse.json() as { code: string };
  assert.equal(expiredBody.code, "auth_invalid");
});

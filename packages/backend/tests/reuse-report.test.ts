import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import type Database from "better-sqlite3";
import { Hono } from "hono";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "team-memory-reuse-report-"));
const dbPath = path.join(tempDir, "team-memory.db");

process.env.TEAM_MEMORY_DB = dbPath;

interface NeverAccessedItem {
  id: string;
  claim: string;
}

interface TopReusedItem {
  knowledge_id: string;
  claim: string;
  view_count: number;
  unique_owners: number;
  useful_feedback_count: number;
  not_useful_feedback_count: number;
  outdated_feedback_count: number;
}

interface ReuseReportResponse {
  total_queries: number;
  total_views: number;
  total_items: number;
  never_accessed_pct: number;
  north_star: number;
  top_reused: TopReusedItem[];
  never_accessed: NeverAccessedItem[];
}

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

function insertKnowledgeRow(
  db: Database.Database,
  input: {
    id: string;
    claim: string;
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
    JSON.stringify(["tests/reuse-report.test.ts"]),
    "team-memory",
    "reuse-report",
    JSON.stringify(["reuse"]),
    "high",
    "Recheck if reuse-report semantics change.",
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

function insertUsageEvent(
  db: Database.Database,
  input: {
    knowledgeId: string;
    owner: string;
    eventType: "exposure" | "view";
    requestId?: string | null;
    queryContext?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO usage_events (knowledge_id, owner, event_type, request_id, query_context)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.knowledgeId,
    input.owner,
    input.eventType,
    input.requestId ?? null,
    input.queryContext ?? null,
  );
}

function insertFeedback(
  db: Database.Database,
  input: {
    knowledgeId: string;
    owner: string;
    verdict: "useful" | "not_useful" | "outdated";
    comment?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO reuse_feedback (knowledge_id, owner, verdict, comment)
     VALUES (?, ?, ?, ?)`,
  ).run(
    input.knowledgeId,
    input.owner,
    input.verdict,
    input.comment ?? null,
  );
}

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
  db.exec("DELETE FROM reuse_feedback; DELETE FROM usage_events; DELETE FROM knowledge; DELETE FROM api_keys;");
});

after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.TEAM_MEMORY_DB;
});

test("reuse report aggregates total queries, views, north-star, top reused, and never-accessed items", async () => {
  const db = getDb();
  insertKnowledgeRow(db, { id: "item-a", claim: "Billing writes belong to the control plane." });
  insertKnowledgeRow(db, { id: "item-b", claim: "Usage events are mirrored before persistence." });
  insertKnowledgeRow(db, { id: "item-c", claim: "Never accessed item C." });
  insertKnowledgeRow(db, { id: "item-d", claim: "Never accessed item D." });

  insertUsageEvent(db, {
    knowledgeId: "item-a",
    owner: "Alice",
    eventType: "exposure",
    requestId: "request-1",
    queryContext: "billing ownership",
  });
  insertUsageEvent(db, {
    knowledgeId: "item-b",
    owner: "Alice",
    eventType: "exposure",
    requestId: "request-1",
    queryContext: "billing ownership",
  });
  insertUsageEvent(db, {
    knowledgeId: "item-a",
    owner: "Bob",
    eventType: "exposure",
    requestId: "request-2",
    queryContext: "usage persistence",
  });

  insertUsageEvent(db, {
    knowledgeId: "item-a",
    owner: "Alice",
    eventType: "view",
    queryContext: "billing ownership",
  });
  insertUsageEvent(db, {
    knowledgeId: "item-a",
    owner: "Bob",
    eventType: "view",
    queryContext: "usage persistence",
  });
  insertUsageEvent(db, {
    knowledgeId: "item-b",
    owner: "Alice",
    eventType: "view",
    queryContext: "billing ownership",
  });

  insertFeedback(db, {
    knowledgeId: "item-a",
    owner: "Bob",
    verdict: "useful",
    comment: "Saved time.",
  });
  insertFeedback(db, {
    knowledgeId: "item-b",
    owner: "Alice",
    verdict: "not_useful",
  });
  insertFeedback(db, {
    knowledgeId: "item-b",
    owner: "Carol",
    verdict: "outdated",
  });

  const response = await app.request("http://localhost/api/reports/reuse");

  assert.equal(response.status, 200);
  const body = (await response.json()) as ReuseReportResponse;

  assert.equal(body.total_queries, 2);
  assert.equal(body.total_views, 3);
  assert.equal(body.total_items, 4);
  assert.equal(body.never_accessed_pct, 0.5);
  assert.equal(body.north_star, 0.25);
  assert.deepEqual(
    body.top_reused.map((item) => ({
      knowledge_id: item.knowledge_id,
      view_count: item.view_count,
      unique_owners: item.unique_owners,
      useful_feedback_count: item.useful_feedback_count,
      not_useful_feedback_count: item.not_useful_feedback_count,
      outdated_feedback_count: item.outdated_feedback_count,
    })),
    [
      {
        knowledge_id: "item-a",
        view_count: 2,
        unique_owners: 2,
        useful_feedback_count: 1,
        not_useful_feedback_count: 0,
        outdated_feedback_count: 0,
      },
      {
        knowledge_id: "item-b",
        view_count: 1,
        unique_owners: 1,
        useful_feedback_count: 0,
        not_useful_feedback_count: 1,
        outdated_feedback_count: 1,
      },
    ],
  );
  assert.deepEqual(
    body.never_accessed.map((item) => item.id),
    ["item-c", "item-d"],
  );
});

test("reuse report returns zeroed metrics when there is no usage data", async () => {
  const db = getDb();
  insertKnowledgeRow(db, { id: "lonely-item", claim: "This item has never been accessed." });

  const response = await app.request("http://localhost/api/reports/reuse");

  assert.equal(response.status, 200);
  const body = (await response.json()) as ReuseReportResponse;

  assert.equal(body.total_queries, 0);
  assert.equal(body.total_views, 0);
  assert.equal(body.total_items, 1);
  assert.equal(body.never_accessed_pct, 1);
  assert.equal(body.north_star, 0);
  assert.deepEqual(body.top_reused, []);
  assert.deepEqual(body.never_accessed, [{ id: "lonely-item", claim: "This item has never been accessed." }]);
});

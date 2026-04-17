import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import type Database from "better-sqlite3";
import { Hono } from "hono";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "team-memory-task-sessions-routes-"));
const dbPath = path.join(tempDir, "team-memory.db");

process.env.TEAM_MEMORY_DB = dbPath;

interface TaskRow {
  task_id: string;
  owner: string;
  project: string | null;
  description: string;
  status: string;
  opened_at: string;
  closed_at: string | null;
}

interface UsageEventRow {
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
}

interface FeedbackRow {
  knowledge_id: string;
  owner: string;
  verdict: string;
  comment: string | null;
  task_id: string | null;
}

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

function createApiKey(owner = "Tester"): string {
  const db = getDb();
  const key = `${owner.toLowerCase()}-task-key`;
  db.prepare(
    "INSERT OR REPLACE INTO api_keys (key, owner, created_at, revoked_at) VALUES (?, ?, ?, NULL)",
  ).run(key, owner, new Date().toISOString());
  return key;
}

function insertKnowledgeRow(
  db: Database.Database,
  input: {
    id: string;
    claim: string;
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
    input.claim,
    null,
    JSON.stringify(["tests/task-sessions-routes.test.ts"]),
    input.project ?? "team-memory",
    "task-sessions",
    JSON.stringify(["tasks"]),
    "high",
    "Recheck if task-session semantics change.",
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

function insertTaskRow(
  db: Database.Database,
  input: {
    taskId: string;
    owner: string;
    project?: string | null;
    description?: string;
    status?: "open" | "completed" | "abandoned";
    openedAt?: string;
    closedAt?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO tasks (task_id, owner, project, description, status, opened_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.taskId,
    input.owner,
    input.project ?? null,
    input.description ?? "Investigate billing ownership",
    input.status ?? "open",
    input.openedAt ?? new Date().toISOString(),
    input.closedAt ?? null,
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
  db.exec("DELETE FROM task_publications; DELETE FROM reuse_feedback; DELETE FROM usage_events; DELETE FROM tasks; DELETE FROM knowledge; DELETE FROM api_keys;");
});

after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.TEAM_MEMORY_DB;
});

test("start_task creates an open task and tags search events with task_id", async () => {
  const db = getDb();
  insertKnowledgeRow(db, {
    id: "billing-row",
    claim: "Billing ownership stays in the control plane.",
    project: "billing-core",
  });
  const apiKey = createApiKey("Alice");

  const response = await app.request("http://localhost/api/tasks/start", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      description: "billing ownership",
      project: "billing-core",
      max_matches: 5,
    }),
  });

  assert.equal(response.status, 201);
  const body = await response.json() as {
    task_id: string;
    description: string;
    project: string | null;
    retrieval_mode: string;
    matches: Array<{ id: string }>;
  };

  assert.equal(body.description, "billing ownership");
  assert.equal(body.project, "billing-core");
  assert.equal(body.retrieval_mode, "hybrid");
  assert.deepEqual(body.matches.map((item) => item.id), ["billing-row"]);

  const task = db.prepare(
    "SELECT task_id, owner, project, description, status, opened_at, closed_at FROM tasks WHERE task_id = ?",
  ).get(body.task_id) as TaskRow | undefined;
  assert.ok(task);
  assert.equal(task!.owner, "Alice");
  assert.equal(task!.project, "billing-core");
  assert.equal(task!.description, "billing ownership");
  assert.equal(task!.status, "open");
  assert.equal(task!.closed_at, null);

  const events = db.prepare(
    `SELECT knowledge_id, owner, event_type, request_id, task_id, query_text, result_count,
            project, search_mode, query_context
     FROM usage_events
     ORDER BY id ASC`,
  ).all() as UsageEventRow[];

  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.task_id === body.task_id));
  assert.deepEqual(events.map((event) => event.event_type), ["query", "exposure"]);
  assert.equal(events[0]!.query_text, "billing ownership");
  assert.equal(events[0]!.result_count, 1);
});

test("start_task returns task_id for 0-hit sessions and still records a query row", async () => {
  const db = getDb();
  const apiKey = createApiKey("Alice");

  const response = await app.request("http://localhost/api/tasks/start", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      description: "missing topic",
      project: "ghost-project",
    }),
  });

  assert.equal(response.status, 201);
  const body = await response.json() as {
    task_id: string;
    matches: unknown[];
  };

  assert.deepEqual(body.matches, []);

  const task = db.prepare("SELECT status FROM tasks WHERE task_id = ?").get(body.task_id) as { status: string };
  assert.equal(task.status, "open");

  const events = db.prepare(
    `SELECT event_type, task_id, query_text, result_count, project
     FROM usage_events
     ORDER BY id ASC`,
  ).all() as Array<{
    event_type: string;
    task_id: string | null;
    query_text: string | null;
    result_count: number | null;
    project: string;
  }>;

  assert.equal(events.length, 1);
  assert.equal(events[0]!.event_type, "query");
  assert.equal(events[0]!.task_id, body.task_id);
  assert.equal(events[0]!.query_text, "missing topic");
  assert.equal(events[0]!.result_count, 0);
  assert.equal(events[0]!.project, "ghost-project");
});

test("start_task treats FTS-sensitive description text as plain user input instead of crashing", async () => {
  const db = getDb();
  const apiKey = createApiKey("Alice");
  const descriptions = [
    "unrelated-gibberish",
    "fix #42: tokenize",
    "user-input AND dangerous",
    "refactor auth-middleware OR login",
    "NEAR edge case",
    "quote \"me\" please",
    "测试中文描述",
  ];

  for (const description of descriptions) {
    const response = await app.request("http://localhost/api/tasks/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        description,
        project: "ghost-project",
      }),
    });

    assert.equal(response.status, 201, `expected 201 for ${description}`);
    const body = await response.json() as {
      task_id: string;
      description: string;
      matches: unknown[];
    };

    assert.equal(body.description, description);
    assert.ok(body.task_id);
    assert.deepEqual(body.matches, []);
  }

  const queryRows = db.prepare(
    `SELECT event_type, query_text, result_count
     FROM usage_events
     WHERE event_type = 'query'
     ORDER BY id ASC`,
  ).all() as Array<{
    event_type: string;
    query_text: string | null;
    result_count: number | null;
  }>;

  assert.equal(queryRows.length, descriptions.length);
  assert.deepEqual(queryRows.map((row) => row.query_text), descriptions);
  assert.ok(queryRows.every((row) => row.result_count === 0));
});

test("start_task rejects blank-or-whitespace-only descriptions as required-field violations", async () => {
  const apiKey = createApiKey("Alice");

  for (const description of ["", "   ", "\t\n"]) {
    const response = await app.request("http://localhost/api/tasks/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ description }),
    });

    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(description)}`);
    assert.deepEqual(await response.json(), {
      error: "description is required",
      code: "task_description_required",
    });
  }
});

test("existing endpoints hard-reject unknown or foreign task_id but accept closed tasks for follow-up linkage", async () => {
  const db = getDb();
  insertKnowledgeRow(db, { id: "item-a", claim: "Control-plane billing note." });
  insertTaskRow(db, {
    taskId: "completed-task",
    owner: "Alice",
    status: "completed",
    closedAt: new Date().toISOString(),
  });
  insertTaskRow(db, {
    taskId: "foreign-task",
    owner: "Bob",
    status: "open",
  });
  const apiKey = createApiKey("Alice");

  const missingTask = await app.request("http://localhost/api/knowledge/search?q=billing&task_id=missing-task", {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(missingTask.status, 404);
  assert.deepEqual(await missingTask.json(), {
    error: "Task not found",
    code: "task_not_found",
  });

  const foreignTask = await app.request("http://localhost/api/knowledge/search?q=billing&task_id=foreign-task", {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(foreignTask.status, 403);
  assert.deepEqual(await foreignTask.json(), {
    error: "Only the task owner can use this task_id",
    code: "task_owner_forbidden",
  });

  const getResponse = await app.request("http://localhost/api/knowledge/item-a?task_id=completed-task&query_context=follow-up", {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(getResponse.status, 200);

  const feedbackResponse = await app.request("http://localhost/api/knowledge/item-a/feedback", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      verdict: "useful",
      comment: "Follow-up after close still belongs to the same task trace.",
      task_id: "completed-task",
    }),
  });
  assert.equal(feedbackResponse.status, 201);

  const viewEvent = db.prepare(
    `SELECT knowledge_id, owner, event_type, task_id, query_context
     FROM usage_events
     WHERE event_type = 'view'`,
  ).get() as {
    knowledge_id: string;
    owner: string;
    event_type: string;
    task_id: string | null;
    query_context: string | null;
  };

  assert.equal(viewEvent.knowledge_id, "item-a");
  assert.equal(viewEvent.owner, "Alice");
  assert.equal(viewEvent.task_id, "completed-task");
  assert.equal(viewEvent.query_context, "follow-up");

  const feedbackRow = db.prepare(
    `SELECT knowledge_id, owner, verdict, comment, task_id
     FROM reuse_feedback`,
  ).get() as FeedbackRow;

  assert.equal(feedbackRow.knowledge_id, "item-a");
  assert.equal(feedbackRow.owner, "Alice");
  assert.equal(feedbackRow.task_id, "completed-task");
});

test("end_task closes the session, publishes successful findings, and short-circuits on first failure", async () => {
  const db = getDb();
  insertTaskRow(db, {
    taskId: "task-partial",
    owner: "Alice",
    status: "open",
    openedAt: new Date(Date.now() - 1_000).toISOString(),
  });
  const apiKey = createApiKey("Alice");

  const response = await app.request("http://localhost/api/tasks/task-partial/end", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      findings: [
        {
          claim: "A1 sessions should preserve publish provenance via task_publications.",
          source: ["tests/task-sessions-routes.test.ts"],
          project: "team-memory",
          tags: ["tasks"],
          confidence: "high",
          staleness_hint: "Recheck if A1 publish semantics change.",
        },
        {
          claim: "This second finding is invalid because it omits tags.",
          source: ["tests/task-sessions-routes.test.ts"],
          project: "team-memory",
          confidence: "medium",
          staleness_hint: "Recheck if validation changes.",
        },
      ],
    }),
  });

  assert.equal(response.status, 400);
  const body = await response.json() as {
    task_id: string;
    status: string;
    published_ids: string[];
    duration_ms: number;
    error: {
      code: string;
      failed_index: number;
      publish_status: number;
      publish_error: string;
    };
  };

  assert.equal(body.task_id, "task-partial");
  assert.equal(body.status, "completed");
  assert.equal(body.published_ids.length, 1);
  assert.ok(body.duration_ms >= 0);
  assert.deepEqual(body.error, {
    code: "task_publish_failed",
    failed_index: 1,
    publish_status: 400,
    publish_error: "Missing required fields: tags",
  });

  const task = db.prepare(
    "SELECT status, closed_at FROM tasks WHERE task_id = ?",
  ).get("task-partial") as { status: string; closed_at: string | null };
  assert.equal(task.status, "completed");
  assert.ok(task.closed_at);

  const publications = db.prepare(
    "SELECT task_id, knowledge_id FROM task_publications ORDER BY created_at ASC",
  ).all() as Array<{ task_id: string; knowledge_id: string }>;
  assert.deepEqual(publications, [{ task_id: "task-partial", knowledge_id: body.published_ids[0]! }]);

  const secondEnd = await app.request("http://localhost/api/tasks/task-partial/end", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({}),
  });

  assert.equal(secondEnd.status, 409);
  assert.deepEqual(await secondEnd.json(), {
    error: "Task is already closed",
    code: "task_already_closed",
  });
});

test("end_task without findings can abandon a task cleanly", async () => {
  const db = getDb();
  insertTaskRow(db, {
    taskId: "task-abandon",
    owner: "Alice",
    status: "open",
  });
  const apiKey = createApiKey("Alice");

  const response = await app.request("http://localhost/api/tasks/task-abandon/end", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      status: "abandoned",
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    task_id: "task-abandon",
    status: "abandoned",
    published_ids: [],
    duration_ms: (await (async () => {
      const task = db.prepare("SELECT opened_at, closed_at FROM tasks WHERE task_id = ?").get("task-abandon") as { opened_at: string; closed_at: string };
      return Math.max(0, Date.parse(task.closed_at) - Date.parse(task.opened_at));
    })()),
  });

  const task = db.prepare(
    "SELECT status, closed_at FROM tasks WHERE task_id = ?",
  ).get("task-abandon") as { status: string; closed_at: string | null };
  assert.equal(task.status, "abandoned");
  assert.ok(task.closed_at);
});

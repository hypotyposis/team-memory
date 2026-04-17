import { Hono } from "hono";
import type { Context } from "hono";
import { v4 as uuidv4 } from "uuid";
import { getOptionalApiAuth, requireApiAuth, requireOwnerAccess } from "./auth.js";
import { getDb } from "./db.js";
import { findPersistedDuplicateOf } from "./duplicates.js";
import { embedKnowledgeItem, embedTexts } from "./embedding.js";
import { detectPossibleDuplicates, qualityFlagsFromRow } from "./quality.js";
import { cosineSimilarity, decodeEmbedding } from "./vector.js";

const api = new Hono();

interface KnowledgeRow {
  id: string; claim: string; detail: string | null; source: string;
  project: string; module: string | null; tags: string; confidence: string;
  staleness_hint: string; owner: string; related_to: string;
  supersedes: string | null; superseded_by: string | null; duplicate_of: string | null;
  created_at: string; updated_at: string;
}

interface SemanticKnowledgeRow extends KnowledgeRow {
  embedding: Buffer | null;
}

type SearchMode = "fts" | "semantic" | "hybrid";
type ReuseVerdict = "useful" | "not_useful" | "outdated";
type TaskStatus = "open" | "completed" | "abandoned";

interface TaskRow {
  task_id: string;
  owner: string;
  project: string | null;
  description: string;
  status: TaskStatus;
  opened_at: string;
  closed_at: string | null;
}

interface PublishKnowledgeInput {
  claim?: unknown;
  detail?: unknown;
  source?: unknown;
  project?: unknown;
  module?: unknown;
  tags?: unknown;
  confidence?: unknown;
  staleness_hint?: unknown;
  related_to?: unknown;
  supersedes?: unknown;
}

interface PublishKnowledgeSuccess {
  ok: true;
  status: 201;
  id: string;
  body: ReturnType<typeof rowToJson> & {
    warnings: Array<{
      code: string;
      message: string;
      matches: ReturnType<typeof detectPossibleDuplicates>;
    }>;
  };
}

interface PublishKnowledgeFailure {
  ok: false;
  status: number;
  error: string;
}

type PublishKnowledgeResult = PublishKnowledgeSuccess | PublishKnowledgeFailure;

interface TrackedSearchItem {
  id: string;
  project: string;
}

// Prefer semantic signal, but give a small bonus when a row matches both worlds.
const HYBRID_FTS_WEIGHT = 0.35;
const HYBRID_SEMANTIC_WEIGHT = 0.65;
const HYBRID_MATCH_BONUS = 0.15;
const SEMANTIC_ONLY_WEIGHT = 0.75;
const FTS_ONLY_WEIGHT = 0.55;

interface FtsSearchRow extends KnowledgeRow {
  rank: number;
}

interface SearchResultItem extends ReturnType<typeof summaryFromRow> {
  rank?: number;
  similarity?: number;
  search_mode: SearchMode;
}

function rowToJson(row: KnowledgeRow) {
  return {
    id: row.id, claim: row.claim, detail: row.detail,
    source: JSON.parse(row.source), project: row.project, module: row.module,
    tags: JSON.parse(row.tags), confidence: row.confidence,
    staleness_hint: row.staleness_hint, owner: row.owner,
    related_to: JSON.parse(row.related_to), supersedes: row.supersedes,
    superseded_by: row.superseded_by, duplicate_of: row.duplicate_of,
    created_at: row.created_at, updated_at: row.updated_at,
    ...qualityFlagsFromRow(row),
  };
}

function summaryFromRow(row: KnowledgeRow) {
  return {
    id: row.id, claim: row.claim, project: row.project, module: row.module,
    tags: JSON.parse(row.tags), confidence: row.confidence,
    staleness_hint: row.staleness_hint, owner: row.owner,
    duplicate_of: row.duplicate_of, created_at: row.created_at,
    ...qualityFlagsFromRow(row),
  };
}

function parseTagList(tags: string | null | undefined): string[] | undefined {
  if (!tags) return undefined;
  const list = tags.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function timestampFromDb(value: string): number {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return Date.parse(normalized);
}

function normalizeQueryText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function matchesRequestedTags(row: KnowledgeRow, tags: string[] | undefined): boolean {
  if (!tags || tags.length === 0) return true;
  const rowTags: string[] = JSON.parse(row.tags).map((tag: string) => tag.toLowerCase());
  return tags.some((tag) => rowTags.includes(tag));
}

function normalizedFtsScores(rows: FtsSearchRow[]): Map<string, number> {
  if (rows.length === 0) return new Map();
  if (rows.length === 1) return new Map([[rows[0]!.id, 1]]);

  const ranks = rows.map((row) => row.rank);
  const best = Math.min(...ranks);
  const worst = Math.max(...ranks);
  if (best === worst) {
    return new Map(rows.map((row) => [row.id, 1]));
  }

  return new Map(
    rows.map((row) => [row.id, (worst - row.rank) / (worst - best)]),
  );
}

function compareSearchResults(left: SearchResultItem & { hybrid_score: number }, right: SearchResultItem & { hybrid_score: number }): number {
  if (right.hybrid_score !== left.hybrid_score) {
    return right.hybrid_score - left.hybrid_score;
  }
  const modePriority: Record<SearchMode, number> = {
    hybrid: 3,
    semantic: 2,
    fts: 1,
  };
  if (modePriority[right.search_mode] !== modePriority[left.search_mode]) {
    return modePriority[right.search_mode] - modePriority[left.search_mode];
  }
  return Date.parse(right.created_at) - Date.parse(left.created_at);
}

async function runSemanticCandidates(
  db: ReturnType<typeof getDb>,
  input: {
    query: string;
    project?: string;
    module?: string;
    includeSuperseded: boolean;
    tags?: string[];
    candidateLimit: number;
  },
): Promise<Array<ReturnType<typeof summaryFromRow> & { similarity: number }>> {
  const [queryEmbedding] = await embedTexts([input.query]);
  if (!queryEmbedding) {
    return [];
  }

  const params: (string | number)[] = [];
  const conditions = ["embedding IS NOT NULL"];
  if (!input.includeSuperseded) {
    conditions.push("superseded_by IS NULL");
  }
  if (input.project) {
    conditions.push("project = ?");
    params.push(input.project);
  }
  if (input.module) {
    conditions.push("module = ?");
    params.push(input.module);
  }

  const rows = db.prepare(
    `SELECT * FROM knowledge WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
  ).all(...params) as SemanticKnowledgeRow[];

  return rows
    .filter((row) => matchesRequestedTags(row, input.tags))
    .map((row) => {
      const storedEmbedding = decodeEmbedding(row.embedding);
      if (!storedEmbedding) return null;

      const similarity = cosineSimilarity(queryEmbedding, storedEmbedding);
      if (similarity <= 0) return null;

      return {
        ...summaryFromRow(row),
        similarity,
      };
    })
    .filter((row): row is ReturnType<typeof summaryFromRow> & { similarity: number } => row !== null)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, input.candidateLimit);
}

async function runHybridSearch(
  db: ReturnType<typeof getDb>,
  input: {
    query: string;
    project?: string;
    module?: string;
    includeSuperseded: boolean;
    tags?: string[];
    limit: number;
  },
): Promise<{
  items: SearchResultItem[];
  total: number;
  retrievalMode: "fts" | "hybrid";
}> {
  const candidateLimit = Math.max(input.limit * 3, input.limit);
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (!input.includeSuperseded) conditions.push("k.superseded_by IS NULL");
  if (input.project) {
    conditions.push("k.project = ?");
    params.push(input.project);
  }
  if (input.module) {
    conditions.push("k.module = ?");
    params.push(input.module);
  }
  const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  const sql = `SELECT k.*, rank FROM knowledge_fts fts JOIN knowledge k ON k.rowid = fts.rowid WHERE knowledge_fts MATCH ? ${whereClause} ORDER BY rank LIMIT ?`;
  const ftsRows = db.prepare(sql).all(input.query, ...params, candidateLimit) as FtsSearchRow[];
  const filteredFtsRows = ftsRows.filter((row) => matchesRequestedTags(row, input.tags));
  const ftsScores = normalizedFtsScores(filteredFtsRows);

  const semanticRows = await runSemanticCandidates(db, {
    query: input.query,
    project: input.project,
    module: input.module,
    includeSuperseded: input.includeSuperseded,
    tags: input.tags,
    candidateLimit,
  });

  const merged = new Map<string, SearchResultItem & { hybrid_score: number; fts_score: number; semantic_score: number }>();

  for (const row of filteredFtsRows) {
    const ftsScore = ftsScores.get(row.id) ?? 0;
    merged.set(row.id, {
      ...summaryFromRow(row),
      rank: row.rank,
      search_mode: "fts",
      hybrid_score: ftsScore * FTS_ONLY_WEIGHT,
      fts_score: ftsScore,
      semantic_score: 0,
    });
  }

  for (const row of semanticRows) {
    const existing = merged.get(row.id);
    if (existing) {
      const semanticScore = row.similarity;
      merged.set(row.id, {
        ...existing,
        similarity: row.similarity,
        search_mode: "hybrid",
        semantic_score: semanticScore,
        hybrid_score:
          existing.fts_score * HYBRID_FTS_WEIGHT
          + semanticScore * HYBRID_SEMANTIC_WEIGHT
          + HYBRID_MATCH_BONUS,
      });
      continue;
    }

    merged.set(row.id, {
      ...row,
      search_mode: "semantic",
      hybrid_score: row.similarity * SEMANTIC_ONLY_WEIGHT,
      fts_score: 0,
      semantic_score: row.similarity,
    });
  }

  const items = Array.from(merged.values())
    .sort(compareSearchResults)
    .slice(0, input.limit)
    .map(({ hybrid_score: _hybridScore, fts_score: _ftsScore, semantic_score: _semanticScore, ...item }) => item);

  return {
    items,
    total: merged.size,
    retrievalMode: "hybrid",
  };
}

const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
const VALID_REUSE_VERDICTS = new Set<ReuseVerdict>(["useful", "not_useful", "outdated"]);
const VALID_TASK_STATUSES = new Set<TaskStatus>(["open", "completed", "abandoned"]);

function jsonTaskError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409,
  error: string,
  code: string,
): Response {
  return c.json({ error, code }, status);
}

function resolveTaskTrace(
  c: Context,
  taskId: string | null | undefined,
  auth: { owner: string } | Response | null,
): TaskRow | Response | null {
  if (!taskId) return null;
  if (auth instanceof Response) return auth;
  if (!auth) {
    return jsonTaskError(c, 401, "Missing Authorization: Bearer <api_key> header", "auth_missing");
  }

  const db = getDb();
  const task = db.prepare(
    "SELECT task_id, owner, project, description, status, opened_at, closed_at FROM tasks WHERE task_id = ?",
  ).get(taskId) as TaskRow | undefined;

  if (!task) {
    return jsonTaskError(c, 404, "Task not found", "task_not_found");
  }
  if (task.owner !== auth.owner) {
    return jsonTaskError(c, 403, "Only the task owner can use this task_id", "task_owner_forbidden");
  }
  return task;
}

function resolveTaskForClosure(c: Context, taskId: string, auth: { owner: string } | Response): TaskRow | Response {
  if (auth instanceof Response) return auth;

  const db = getDb();
  const task = db.prepare(
    "SELECT task_id, owner, project, description, status, opened_at, closed_at FROM tasks WHERE task_id = ?",
  ).get(taskId) as TaskRow | undefined;

  if (!task) {
    return jsonTaskError(c, 404, "Task not found", "task_not_found");
  }
  if (task.owner !== auth.owner) {
    return jsonTaskError(c, 403, "Only the task owner can close this task", "task_owner_forbidden");
  }
  if (task.status !== "open") {
    return jsonTaskError(c, 409, "Task is already closed", "task_already_closed");
  }
  return task;
}

async function publishKnowledgeItem(
  db: ReturnType<typeof getDb>,
  owner: string,
  body: PublishKnowledgeInput,
  taskId?: string,
): Promise<PublishKnowledgeResult> {
  const missing: string[] = [];
  for (const field of ["claim", "source", "project", "tags", "confidence", "staleness_hint"] as const) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      missing.push(field);
    }
  }
  if (missing.length > 0) {
    return { ok: false, status: 400, error: `Missing required fields: ${missing.join(", ")}` };
  }
  if (!Array.isArray(body.source) || body.source.length === 0) {
    return { ok: false, status: 400, error: "source must be a non-empty array of strings" };
  }
  if (!Array.isArray(body.tags) || body.tags.length === 0) {
    return { ok: false, status: 400, error: "tags must be a non-empty array of strings" };
  }
  const confidenceInput = body.confidence;
  if (!VALID_CONFIDENCE.has(confidenceInput as string)) {
    return { ok: false, status: 400, error: "confidence must be one of: high, medium, low" };
  }

  const claim = String(body.claim);
  const project = String(body.project);
  const detail = body.detail == null ? null : String(body.detail);
  const module = body.module == null ? null : String(body.module);
  const stalenessHint = String(body.staleness_hint);
  const source = body.source as string[];
  const tags = body.tags as string[];
  const confidence = confidenceInput as string;
  const relatedTo = body.related_to === undefined ? [] : body.related_to;
  const supersedes = body.supersedes == null ? null : String(body.supersedes);

  const id = uuidv4();
  const now = new Date().toISOString();
  const embedding = await embedKnowledgeItem(claim, detail);
  const duplicates = detectPossibleDuplicates(db, {
    claim,
    project,
    embedding,
  });
  const duplicateOf = findPersistedDuplicateOf(claim, project, duplicates);

  if (supersedes) {
    const old = db.prepare("SELECT id, superseded_by FROM knowledge WHERE id = ?").get(supersedes) as { id: string; superseded_by: string | null } | undefined;
    if (!old) return { ok: false, status: 400, error: `Superseded item not found: ${supersedes}` };
    if (old.superseded_by) {
      return { ok: false, status: 400, error: `Item ${supersedes} is already superseded by ${old.superseded_by}` };
    }
  }

  if (relatedTo && Array.isArray(relatedTo)) {
    for (const relId of relatedTo) {
      if (!db.prepare("SELECT 1 FROM knowledge WHERE id = ?").get(String(relId))) {
        return { ok: false, status: 400, error: `Related item not found: ${String(relId)}` };
      }
    }
  }

  const insert = db.prepare(
    `INSERT INTO knowledge (
      id, claim, detail, source, project, module, tags, confidence,
      staleness_hint, owner, related_to, supersedes, superseded_by,
      duplicate_of, embedding, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  );
  const updateSuperseded = db.prepare("UPDATE knowledge SET superseded_by = ? WHERE id = ?");
  const linkTaskPublication = db.prepare(
    "INSERT INTO task_publications (task_id, knowledge_id, created_at) VALUES (?, ?, ?)",
  );

  db.transaction(() => {
    insert.run(
      id,
      claim,
      detail,
      JSON.stringify(source),
      project,
      module,
      JSON.stringify(tags),
      confidence,
      stalenessHint,
      owner,
      JSON.stringify(Array.isArray(relatedTo) ? relatedTo : []),
      supersedes,
      duplicateOf,
      embedding,
      now,
      now,
    );
    if (supersedes) {
      updateSuperseded.run(id, supersedes);
    }
    if (taskId) {
      linkTaskPublication.run(taskId, id, now);
    }
  })();

  const row = db.prepare("SELECT * FROM knowledge WHERE id = ?").get(id) as KnowledgeRow;
  const warnings = duplicates.length > 0
    ? [{
        code: "possible_duplicate",
        message: `Found ${duplicates.length} possible duplicate knowledge item(s) in project ${project}`,
        matches: duplicates,
      }]
    : [];

  return {
    ok: true,
    status: 201,
    id,
    body: {
      ...rowToJson(row),
      warnings,
    },
  };
}

function recordSearchEvents(
  db: ReturnType<typeof getDb>,
  owner: string,
  input: {
    items: TrackedSearchItem[];
    project: string | null;
    taskId?: string | null;
    queryText: string;
    searchMode: SearchMode;
  },
): void {
  const requestId = uuidv4();
  const insertQuery = db.prepare(
    `INSERT INTO usage_events (
      knowledge_id, owner, event_type, request_id, task_id, query_text,
      result_count, project, search_mode, query_context
    ) VALUES (NULL, ?, 'query', ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const insertExposure = db.prepare(
    `INSERT INTO usage_events (
      knowledge_id, owner, event_type, request_id, task_id, query_text,
      result_count, project, search_mode, query_context
    ) VALUES (?, ?, 'exposure', ?, ?, NULL, NULL, ?, ?, ?)`,
  );

  const transaction = db.transaction((items: TrackedSearchItem[]) => {
    insertQuery.run(
      owner,
      requestId,
      input.taskId ?? null,
      input.queryText,
      items.length,
      input.project ?? "",
      input.searchMode,
    );

    for (const item of items) {
      insertExposure.run(
        item.id,
        owner,
        requestId,
        input.taskId ?? null,
        item.project,
        input.searchMode,
        input.queryText,
      );
    }
  });

  transaction(input.items);
}

function recordViewEvent(
  db: ReturnType<typeof getDb>,
  owner: string,
  knowledgeId: string,
  project: string,
  queryContext: string | null,
  taskId: string | null,
): void {
  db.prepare(
    `INSERT INTO usage_events (
      knowledge_id, owner, event_type, request_id, task_id, query_text,
      result_count, project, search_mode, query_context
    ) VALUES (?, ?, 'view', NULL, ?, NULL, NULL, ?, NULL, ?)`,
  ).run(knowledgeId, owner, taskId, project, queryContext);
}

// 1. POST /api/knowledge
api.post("/knowledge", async (c) => {
  const auth = requireApiAuth(c);
  if (auth instanceof Response) return auth;

  const db = getDb();
  const body = await c.req.json() as PublishKnowledgeInput;
  const result = await publishKnowledgeItem(db, auth.owner, body);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400);
  }
  return c.json(result.body, result.status);
});

// 1b. POST /api/tasks/start
api.post("/tasks/start", async (c) => {
  const auth = requireApiAuth(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json() as {
    description?: unknown;
    project?: unknown;
    max_matches?: unknown;
  };

  if (body.description === undefined || body.description === null || body.description === "") {
    return jsonTaskError(c, 400, "description is required", "task_description_required");
  }
  if (typeof body.description !== "string") {
    return jsonTaskError(c, 400, "description must be a string", "task_description_invalid");
  }
  if (body.project !== undefined && body.project !== null && typeof body.project !== "string") {
    return jsonTaskError(c, 400, "project must be a string when provided", "task_project_invalid");
  }
  const maxMatchesInput = body.max_matches;
  if (
    maxMatchesInput !== undefined
    && maxMatchesInput !== null
    && (typeof maxMatchesInput !== "number" || !Number.isInteger(maxMatchesInput) || maxMatchesInput < 1 || maxMatchesInput > 100)
  ) {
    return jsonTaskError(c, 400, "max_matches must be an integer between 1 and 100", "task_max_matches_invalid");
  }

  const description = body.description;
  const project = body.project ?? null;
  const maxMatches = (maxMatchesInput as number | undefined) ?? 10;
  const db = getDb();

  const results = await runHybridSearch(db, {
    query: description,
    project: project ?? undefined,
    includeSuperseded: false,
    limit: maxMatches,
  });

  const taskId = uuidv4();
  const openedAt = new Date().toISOString();
  const insertTask = db.prepare(
    `INSERT INTO tasks (task_id, owner, project, description, status, opened_at, closed_at)
     VALUES (?, ?, ?, ?, 'open', ?, NULL)`,
  );

  db.transaction(() => {
    insertTask.run(taskId, auth.owner, project, description, openedAt);
    recordSearchEvents(db, auth.owner, {
      items: results.items.map((item) => ({ id: item.id, project: item.project })),
      project,
      taskId,
      queryText: description,
      searchMode: "hybrid",
    });
  })();

  return c.json({
    task_id: taskId,
    description,
    project,
    retrieval_mode: results.retrievalMode,
    matches: results.items,
  }, 201);
});

// 1c. POST /api/tasks/:task_id/end
api.post("/tasks/:task_id/end", async (c) => {
  const auth = requireApiAuth(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json() as {
    status?: unknown;
    findings?: unknown;
  };

  const status = (body.status as TaskStatus | undefined) ?? "completed";
  if (!VALID_TASK_STATUSES.has(status) || status === "open") {
    return jsonTaskError(c, 400, "status must be one of: completed, abandoned", "task_status_invalid");
  }
  if (body.findings !== undefined && !Array.isArray(body.findings)) {
    return jsonTaskError(c, 400, "findings must be an array when provided", "task_findings_invalid");
  }

  const task = resolveTaskForClosure(c, c.req.param("task_id"), auth);
  if (task instanceof Response) return task;

  const db = getDb();
  const closedAt = new Date().toISOString();
  db.prepare(
    "UPDATE tasks SET status = ?, closed_at = ? WHERE task_id = ?",
  ).run(status, closedAt, task.task_id);

  const durationMs = Math.max(0, Date.parse(closedAt) - Date.parse(task.opened_at));
  const publishedIds: string[] = [];
  const findings = (body.findings as PublishKnowledgeInput[] | undefined) ?? [];

  for (let index = 0; index < findings.length; index += 1) {
    const result = await publishKnowledgeItem(db, auth.owner, findings[index]!, task.task_id);
    if (!result.ok) {
      return c.json({
        task_id: task.task_id,
        status,
        published_ids: publishedIds,
        duration_ms: durationMs,
        error: {
          code: "task_publish_failed",
          failed_index: index,
          publish_status: result.status,
          publish_error: result.error,
        },
      }, result.status as 400);
    }

    publishedIds.push(result.id);
  }

  return c.json({
    task_id: task.task_id,
    status,
    published_ids: publishedIds,
    duration_ms: durationMs,
  });
});

// 2. GET /api/knowledge/search
api.get("/knowledge/search", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "Query parameter 'q' is required" }, 400);
  const maybeAuth = getOptionalApiAuth(c);
  if (maybeAuth instanceof Response) return maybeAuth;
  const taskTrace = resolveTaskTrace(c, c.req.query("task_id"), maybeAuth);
  if (taskTrace instanceof Response) return taskTrace;
  const project = c.req.query("project");
  const tags = c.req.query("tags");
  const module_ = c.req.query("module");
  const includeSuperseded = c.req.query("include_superseded") === "true";
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
  const db = getDb();
  const requestedTags = parseTagList(tags);
  const results = await runHybridSearch(db, {
    query: q,
    project: project ?? undefined,
    module: module_ ?? undefined,
    includeSuperseded,
    tags: requestedTags,
    limit,
  });

  if (maybeAuth) {
    recordSearchEvents(db, maybeAuth.owner, {
      items: results.items.map((item) => ({ id: item.id, project: item.project })),
      project: project ?? null,
      taskId: taskTrace?.task_id ?? null,
      queryText: q,
      searchMode: "hybrid",
    });
  }

  return c.json({ items: results.items, total: results.total });
});

// 3. GET /api/knowledge/semantic-search
api.get("/knowledge/semantic-search", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "Query parameter 'q' is required" }, 400);
  const maybeAuth = getOptionalApiAuth(c);
  if (maybeAuth instanceof Response) return maybeAuth;
  const taskTrace = resolveTaskTrace(c, c.req.query("task_id"), maybeAuth);
  if (taskTrace instanceof Response) return taskTrace;

  const project = c.req.query("project");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "10", 10) || 10, 100);
  const db = getDb();

  const [queryEmbedding] = await embedTexts([q]);
  if (!queryEmbedding) {
    if (maybeAuth) {
      recordSearchEvents(db, maybeAuth.owner, {
        items: [],
        project: project ?? null,
        taskId: taskTrace?.task_id ?? null,
        queryText: q,
        searchMode: "semantic",
      });
    }
    return c.json({ items: [], total: 0 });
  }

  const params: (string | number)[] = [];
  const conditions = ["embedding IS NOT NULL", "superseded_by IS NULL"];
  if (project) {
    conditions.push("project = ?");
    params.push(project);
  }

  const rows = db.prepare(
    `SELECT * FROM knowledge WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
  ).all(...params) as SemanticKnowledgeRow[];

  const ranked = rows
    .map((row) => {
      const storedEmbedding = decodeEmbedding(row.embedding);
      if (!storedEmbedding) return null;

      return {
        ...summaryFromRow(row),
        similarity: cosineSimilarity(queryEmbedding, storedEmbedding),
      };
    })
    .filter((row): row is ReturnType<typeof summaryFromRow> & { similarity: number } => row !== null)
    .sort((left, right) => right.similarity - left.similarity);

  const items = ranked.slice(0, limit);
  if (maybeAuth) {
    recordSearchEvents(db, maybeAuth.owner, {
      items: items.map((item) => ({ id: item.id, project: item.project })),
      project: project ?? null,
      taskId: taskTrace?.task_id ?? null,
      queryText: q,
      searchMode: "semantic",
    });
  }

  return c.json({ items, total: ranked.length });
});

// 4. GET /api/knowledge
api.get("/knowledge", (c) => {
  const project = c.req.query("project");
  const tags = c.req.query("tags");
  const module_ = c.req.query("module");
  const owner = c.req.query("owner");
  const includeSuperseded = c.req.query("include_superseded") === "true";
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
  const offset = parseInt(c.req.query("offset") ?? "0", 10) || 0;
  const db = getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (!includeSuperseded) conditions.push("superseded_by IS NULL");
  if (project) { conditions.push("project = ?"); params.push(project); }
  if (module_) { conditions.push("module = ?"); params.push(module_); }
  if (owner) { conditions.push("owner = ?"); params.push(owner); }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM knowledge ${whereClause}`).get(...params) as { cnt: number };
  const rows = db.prepare(`SELECT * FROM knowledge ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as KnowledgeRow[];
  let items = rows.map(summaryFromRow);
  if (tags) {
    const tagList = tags.split(",").map((t) => t.trim().toLowerCase());
    items = items.filter((item) => { const rowTags = item.tags.map((t: string) => t.toLowerCase()); return tagList.some((t) => rowTags.includes(t)); });
  }
  return c.json({ items, total: tags ? items.length : countRow.cnt, limit, offset });
});

// 5. GET /api/knowledge/:id
api.get("/knowledge/:id", (c) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM knowledge WHERE id = ?").get(c.req.param("id")) as KnowledgeRow | undefined;
  if (!row) return c.json({ error: "Knowledge item not found" }, 404);
  const maybeAuth = getOptionalApiAuth(c);
  if (maybeAuth instanceof Response) return maybeAuth;
  const taskTrace = resolveTaskTrace(c, c.req.query("task_id"), maybeAuth);
  if (taskTrace instanceof Response) return taskTrace;
  if (maybeAuth) {
    recordViewEvent(
      db,
      maybeAuth.owner,
      row.id,
      row.project,
      c.req.query("query_context") ?? null,
      taskTrace?.task_id ?? null,
    );
  }
  return c.json(rowToJson(row));
});

// 6. GET /api/reports/reuse
api.get("/reports/reuse", (c) => {
  const since = c.req.query("since");
  const project = c.req.query("project");
  const minAgeDaysParam = c.req.query("min_age_days");
  let cutoffTimestamp: number | null = null;
  if (since) {
    const match = /^(\d+)d$/.exec(since.trim());
    if (!match) {
      return c.json({ error: "since must be in Nd format, for example 7d or 30d" }, 400);
    }
    cutoffTimestamp = Date.now() - Number.parseInt(match[1]!, 10) * 24 * 60 * 60 * 1000;
  }

  let minAgeDays: number | null = null;
  if (minAgeDaysParam) {
    const parsed = Number.parseInt(minAgeDaysParam, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return c.json({ error: "min_age_days must be a non-negative integer" }, 400);
    }
    minAgeDays = parsed;
  }

  const db = getDb();
  const knowledgeParams: string[] = [];
  const knowledgeWhere: string[] = [];
  if (project) {
    knowledgeWhere.push("project = ?");
    knowledgeParams.push(project);
  }
  const knowledgeRows = db.prepare(
    `SELECT id, claim, project, created_at
     FROM knowledge
     ${knowledgeWhere.length > 0 ? `WHERE ${knowledgeWhere.join(" AND ")}` : ""}
     ORDER BY created_at ASC`,
  ).all(...knowledgeParams) as Array<{ id: string; claim: string; project: string; created_at: string }>;

  const usageParams: string[] = [];
  const usageWhere: string[] = [];
  if (project) {
    usageWhere.push("project = ?");
    usageParams.push(project);
  }
  const usageRows = db.prepare(
    `SELECT knowledge_id, owner, event_type, request_id, query_text, result_count, project, created_at
     FROM usage_events
     ${usageWhere.length > 0 ? `WHERE ${usageWhere.join(" AND ")}` : ""}`,
  ).all(...usageParams) as Array<{
    knowledge_id: string | null;
    owner: string;
    event_type: "query" | "exposure" | "view";
    request_id: string | null;
    query_text: string | null;
    result_count: number | null;
    project: string;
    created_at: string;
  }>;

  const feedbackParams: string[] = [];
  const feedbackWhere: string[] = [];
  if (project) {
    feedbackWhere.push("knowledge.project = ?");
    feedbackParams.push(project);
  }
  const feedbackRows = db.prepare(
    `SELECT reuse_feedback.knowledge_id, reuse_feedback.owner, reuse_feedback.verdict, reuse_feedback.created_at
     FROM reuse_feedback
     JOIN knowledge ON knowledge.id = reuse_feedback.knowledge_id
     ${feedbackWhere.length > 0 ? `WHERE ${feedbackWhere.join(" AND ")}` : ""}`,
  ).all(...feedbackParams) as Array<{
    knowledge_id: string;
    owner: string;
    verdict: ReuseVerdict;
    created_at: string;
  }>;

  const filteredUsageRows = usageRows.filter((row) => (
    cutoffTimestamp === null || timestampFromDb(row.created_at) >= cutoffTimestamp
  ));
  const filteredFeedbackRows = feedbackRows.filter((row) => (
    cutoffTimestamp === null || timestampFromDb(row.created_at) >= cutoffTimestamp
  ));

  const stats = new Map<string, {
    claim: string;
    exposure_count: number;
    view_count: number;
    view_owners: Set<string>;
    useful_owners: Set<string>;
    useful_feedback_count: number;
    not_useful_feedback_count: number;
    outdated_feedback_count: number;
  }>();

  for (const row of knowledgeRows) {
    stats.set(row.id, {
      claim: row.claim,
      exposure_count: 0,
      view_count: 0,
      view_owners: new Set<string>(),
      useful_owners: new Set<string>(),
      useful_feedback_count: 0,
      not_useful_feedback_count: 0,
      outdated_feedback_count: 0,
    });
  }

  let totalQueries = 0;
  let queriesWithResult = 0;
  const viewedPairs = new Set<string>();
  for (const row of filteredUsageRows) {
    if (row.event_type === "query") {
      totalQueries += 1;
      if ((row.result_count ?? 0) > 0) {
        queriesWithResult += 1;
      }
      continue;
    }

    if (!row.knowledge_id) continue;
    const item = stats.get(row.knowledge_id);
    if (!item) continue;

    if (row.event_type === "exposure") {
      item.exposure_count += 1;
      continue;
    }

    item.view_count += 1;
    item.view_owners.add(row.owner);
    viewedPairs.add(`${row.owner}\u0000${row.knowledge_id}`);
  }

  const feedbackPairs = new Set<string>();
  for (const row of filteredFeedbackRows) {
    const item = stats.get(row.knowledge_id);
    if (!item) continue;
    feedbackPairs.add(`${row.owner}\u0000${row.knowledge_id}`);

    if (row.verdict === "useful") {
      item.useful_feedback_count += 1;
      item.useful_owners.add(row.owner);
    } else if (row.verdict === "not_useful") {
      item.not_useful_feedback_count += 1;
    } else {
      item.outdated_feedback_count += 1;
    }
  }

  const totalItems = knowledgeRows.length;
  const baseNeverAccessed = knowledgeRows.filter((row) => {
    const item = stats.get(row.id);
    if (!item) return false;
    return (
      item.exposure_count === 0
      && item.view_count === 0
      && item.useful_feedback_count === 0
      && item.not_useful_feedback_count === 0
      && item.outdated_feedback_count === 0
    );
  });

  const minCreatedAtTimestamp = minAgeDays === null
    ? null
    : Date.now() - minAgeDays * 24 * 60 * 60 * 1000;
  const neverAccessed = baseNeverAccessed
    .filter((row) => {
      if (minCreatedAtTimestamp !== null && timestampFromDb(row.created_at) > minCreatedAtTimestamp) {
        return false;
      }
      const item = stats.get(row.id);
      if (!item) return false;
      return true;
    })
    .map((row) => ({ id: row.id, claim: row.claim }));

  const top0HitKeywords = Array.from(
    filteredUsageRows
      .filter((row) => row.event_type === "query" && (row.result_count ?? 0) === 0 && row.query_text)
      .reduce((acc, row) => {
        const rawQuery = row.query_text!.trim();
        const normalizedKey = normalizeQueryText(row.query_text!);
        if (!normalizedKey) return acc;

        const existing = acc.get(normalizedKey);
        if (existing) {
          existing.query_count += 1;
          return acc;
        }

        acc.set(normalizedKey, {
          normalized_key: normalizedKey,
          example_text: rawQuery,
          query_count: 1,
        });
        return acc;
      }, new Map<string, { normalized_key: string; example_text: string; query_count: number }>())
      .values(),
  )
    .sort((left, right) => {
      if (right.query_count !== left.query_count) {
        return right.query_count - left.query_count;
      }
      return left.example_text.localeCompare(right.example_text);
    })
    .slice(0, 10);

  const northStarCount = knowledgeRows.filter((row) => {
    const item = stats.get(row.id);
    if (!item) return false;

    const owners = new Set<string>([
      ...item.view_owners,
      ...item.useful_owners,
    ]);
    return owners.size >= 2;
  }).length;

  const topReused = knowledgeRows
    .map((row) => {
      const item = stats.get(row.id)!;
      const uniqueOwners = new Set<string>([
        ...item.view_owners,
        ...item.useful_owners,
      ]);
      return {
        knowledge_id: row.id,
        claim: row.claim,
        view_count: item.view_count,
        unique_owners: uniqueOwners.size,
        useful_feedback_count: item.useful_feedback_count,
        not_useful_feedback_count: item.not_useful_feedback_count,
        outdated_feedback_count: item.outdated_feedback_count,
        reuse_score: item.view_count + item.useful_feedback_count,
      };
    })
    .filter((item) => item.reuse_score > 0)
    .sort((left, right) => {
      if (right.reuse_score !== left.reuse_score) {
        return right.reuse_score - left.reuse_score;
      }
      if (right.unique_owners !== left.unique_owners) {
        return right.unique_owners - left.unique_owners;
      }
      return left.claim.localeCompare(right.claim);
    })
    .slice(0, 10)
    .map(({ reuse_score: _reuseScore, ...item }) => item);

  const neverAccessedPct = totalItems === 0 ? 0 : baseNeverAccessed.length / totalItems;
  const northStarPct = totalItems === 0 ? 0 : northStarCount / totalItems;
  const hitRate = totalQueries === 0 ? 0 : queriesWithResult / totalQueries;
  const coveredPairs = Array.from(viewedPairs).filter((pairKey) => feedbackPairs.has(pairKey)).length;
  const feedbackCoverage = viewedPairs.size === 0 ? 0 : coveredPairs / viewedPairs.size;

  return c.json({
    total_queries: totalQueries,
    hit_rate: hitRate,
    total_views: filteredUsageRows.filter((row) => row.event_type === "view").length,
    total_items: totalItems,
    never_accessed_pct: neverAccessedPct,
    feedback_coverage: feedbackCoverage,
    north_star: northStarPct,
    north_star_count: northStarCount,
    north_star_pct: northStarPct,
    top_reused: topReused,
    top_0hit_keywords: top0HitKeywords,
    never_accessed: neverAccessed,
  });
});

// 7. POST /api/knowledge/:id/feedback
api.post("/knowledge/:id/feedback", async (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const row = db.prepare("SELECT id FROM knowledge WHERE id = ?").get(id) as { id: string } | undefined;
  if (!row) return c.json({ error: "Knowledge item not found" }, 404);

  const auth = requireApiAuth(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json();
  const taskTrace = resolveTaskTrace(c, body.task_id as string | undefined, auth);
  if (taskTrace instanceof Response) return taskTrace;
  const verdict = body.verdict as ReuseVerdict | undefined;
  const comment = body.comment;

  if (!verdict || !VALID_REUSE_VERDICTS.has(verdict)) {
    return c.json({ error: "verdict must be one of: useful, not_useful, outdated" }, 400);
  }
  if (comment !== undefined && comment !== null && typeof comment !== "string") {
    return c.json({ error: "comment must be a string when provided" }, 400);
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO reuse_feedback (knowledge_id, owner, verdict, comment, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, auth.owner, verdict, comment ?? null, taskTrace?.task_id ?? null, now);

  return c.json({
    knowledge_id: id,
    owner: auth.owner,
    verdict,
    comment: comment ?? null,
    created_at: now,
  }, 201);
});

// 8. PATCH /api/knowledge/:id
api.patch("/knowledge/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const db = getDb();
  const row = db.prepare("SELECT * FROM knowledge WHERE id = ?").get(id) as KnowledgeRow | undefined;
  if (!row) return c.json({ error: "Knowledge item not found" }, 404);
  const auth = requireOwnerAccess(c, row.owner);
  if (auth instanceof Response) return auth;
  const immutable = ["claim", "detail", "source", "project", "module", "owner"];
  const attempted = immutable.filter((f) => body[f] !== undefined);
  if (attempted.length > 0) return c.json({ error: `Cannot modify immutable fields: ${attempted.join(", ")}` }, 400);
  const updates: string[] = [];
  const params: (string | number)[] = [];
  if (body.tags !== undefined) { if (!Array.isArray(body.tags)) return c.json({ error: "tags must be an array" }, 400); updates.push("tags = ?"); params.push(JSON.stringify(body.tags)); }
  if (body.confidence !== undefined) { if (!VALID_CONFIDENCE.has(body.confidence)) return c.json({ error: "confidence must be one of: high, medium, low" }, 400); updates.push("confidence = ?"); params.push(body.confidence); }
  if (body.staleness_hint !== undefined) { updates.push("staleness_hint = ?"); params.push(body.staleness_hint); }
  if (body.related_to !== undefined) { if (!Array.isArray(body.related_to)) return c.json({ error: "related_to must be an array" }, 400); updates.push("related_to = ?"); params.push(JSON.stringify(body.related_to)); }
  if (updates.length === 0) return c.json({ error: "No valid fields to update" }, 400);
  const now = new Date().toISOString();
  updates.push("updated_at = ?"); params.push(now); params.push(id);
  db.prepare(`UPDATE knowledge SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  const updated = db.prepare("SELECT * FROM knowledge WHERE id = ?").get(id) as KnowledgeRow;
  return c.json(rowToJson(updated));
});

export { api };

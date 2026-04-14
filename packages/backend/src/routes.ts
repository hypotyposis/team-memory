import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { requireApiAuth, requireOwnerAccess } from "./auth.js";
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

const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);

// 1. POST /api/knowledge
api.post("/knowledge", async (c) => {
  const auth = requireApiAuth(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json();
  const missing: string[] = [];
  for (const f of ["claim", "source", "project", "tags", "confidence", "staleness_hint"]) {
    if (body[f] === undefined || body[f] === null || body[f] === "") missing.push(f);
  }
  if (missing.length > 0) return c.json({ error: `Missing required fields: ${missing.join(", ")}` }, 400);
  if (!Array.isArray(body.source) || body.source.length === 0) return c.json({ error: "source must be a non-empty array of strings" }, 400);
  if (!Array.isArray(body.tags) || body.tags.length === 0) return c.json({ error: "tags must be a non-empty array of strings" }, 400);
  if (!VALID_CONFIDENCE.has(body.confidence)) return c.json({ error: "confidence must be one of: high, medium, low" }, 400);

  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const embedding = await embedKnowledgeItem(body.claim, body.detail ?? null);
  const duplicates = detectPossibleDuplicates(db, { claim: body.claim, project: body.project });
  const duplicateOf = findPersistedDuplicateOf(body.claim, body.project, duplicates);

  if (body.supersedes) {
    const old = db.prepare("SELECT id, superseded_by FROM knowledge WHERE id = ?").get(body.supersedes) as { id: string; superseded_by: string | null } | undefined;
    if (!old) return c.json({ error: `Superseded item not found: ${body.supersedes}` }, 400);
    if (old.superseded_by) return c.json({ error: `Item ${body.supersedes} is already superseded by ${old.superseded_by}` }, 400);
  }

  if (body.related_to && Array.isArray(body.related_to)) {
    for (const relId of body.related_to) {
      if (!db.prepare("SELECT 1 FROM knowledge WHERE id = ?").get(relId))
        return c.json({ error: `Related item not found: ${relId}` }, 400);
    }
  }

  const insert = db.prepare(`INSERT INTO knowledge (id, claim, detail, source, project, module, tags, confidence, staleness_hint, owner, related_to, supersedes, superseded_by, duplicate_of, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`);
  const updateSuperseded = db.prepare("UPDATE knowledge SET superseded_by = ? WHERE id = ?");

  db.transaction(() => {
    insert.run(id, body.claim, body.detail ?? null, JSON.stringify(body.source), body.project, body.module ?? null, JSON.stringify(body.tags), body.confidence, body.staleness_hint, auth.owner, JSON.stringify(body.related_to ?? []), body.supersedes ?? null, duplicateOf, embedding, now, now);
    if (body.supersedes) updateSuperseded.run(id, body.supersedes);
  })();

  const row = db.prepare("SELECT * FROM knowledge WHERE id = ?").get(id) as KnowledgeRow;
  const responseBody = rowToJson(row);
  const warnings = duplicates.length > 0
    ? [{
        code: "possible_duplicate",
        message: `Found ${duplicates.length} possible duplicate knowledge item(s) in project ${body.project}`,
        matches: duplicates,
      }]
    : [];
  return c.json({ ...responseBody, warnings }, 201);
});

// 2. GET /api/knowledge/search
api.get("/knowledge/search", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "Query parameter 'q' is required" }, 400);
  const project = c.req.query("project");
  const tags = c.req.query("tags");
  const module_ = c.req.query("module");
  const includeSuperseded = c.req.query("include_superseded") === "true";
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
  const db = getDb();
  const requestedTags = parseTagList(tags);
  const candidateLimit = Math.max(limit * 3, limit);
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (!includeSuperseded) conditions.push("k.superseded_by IS NULL");
  if (project) { conditions.push("k.project = ?"); params.push(project); }
  if (module_) { conditions.push("k.module = ?"); params.push(module_); }
  const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  const sql = `SELECT k.*, rank FROM knowledge_fts fts JOIN knowledge k ON k.rowid = fts.rowid WHERE knowledge_fts MATCH ? ${whereClause} ORDER BY rank LIMIT ?`;
  const ftsRows = db.prepare(sql).all(q, ...params, candidateLimit) as FtsSearchRow[];
  const filteredFtsRows = ftsRows.filter((row) => matchesRequestedTags(row, requestedTags));
  const ftsScores = normalizedFtsScores(filteredFtsRows);

  const semanticRows = await runSemanticCandidates(db, {
    query: q,
    project: project ?? undefined,
    module: module_ ?? undefined,
    includeSuperseded,
    tags: requestedTags,
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
    .slice(0, limit)
    .map(({ hybrid_score: _hybridScore, fts_score: _ftsScore, semantic_score: _semanticScore, ...item }) => item);

  return c.json({ items, total: merged.size });
});

// 3. GET /api/knowledge/semantic-search
api.get("/knowledge/semantic-search", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "Query parameter 'q' is required" }, 400);

  const project = c.req.query("project");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "10", 10) || 10, 100);
  const db = getDb();

  const [queryEmbedding] = await embedTexts([q]);
  if (!queryEmbedding) {
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

  return c.json({
    items: ranked.slice(0, limit),
    total: ranked.length,
  });
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
  return c.json(rowToJson(row));
});

// 6. PATCH /api/knowledge/:id
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

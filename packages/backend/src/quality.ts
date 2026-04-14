import type Database from "better-sqlite3";

const CONFIDENCE_ORDER = ["low", "medium", "high"] as const;
type Confidence = (typeof CONFIDENCE_ORDER)[number];

export interface QualityFlags {
  is_stale: boolean;
  stale_after_days: number;
  stale_at: string;
  effective_confidence: Confidence;
}

interface QualityRow {
  confidence: string;
  updated_at: string;
}

interface DuplicateRow {
  id: string;
  claim: string;
  project: string;
  module: string | null;
  tags: string;
  confidence: string;
  staleness_hint: string;
  owner: string;
  created_at: string;
}

export interface DuplicateSummary {
  id: string;
  claim: string;
  project: string;
  module: string | null;
  tags: string[];
  confidence: string;
  staleness_hint: string;
  owner: string;
  created_at: string;
}

function normalizeConfidence(value: string): Confidence {
  return CONFIDENCE_ORDER.includes(value as Confidence) ? (value as Confidence) : "low";
}

function lowerConfidence(value: Confidence): Confidence {
  const index = CONFIDENCE_ORDER.indexOf(value);
  return CONFIDENCE_ORDER[Math.max(0, index - 1)];
}

function staleAfterDays(): number {
  const raw = Number.parseInt(process.env.TEAM_MEMORY_STALE_AFTER_DAYS ?? "30", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

export function qualityFlagsFromRow(row: QualityRow): QualityFlags {
  const days = staleAfterDays();
  const base = new Date(row.updated_at);
  const staleAtMs = base.getTime() + days * 24 * 60 * 60 * 1000;
  const isStale = staleAtMs <= Date.now();
  const confidence = normalizeConfidence(row.confidence);

  return {
    is_stale: isStale,
    stale_after_days: days,
    stale_at: new Date(staleAtMs).toISOString(),
    effective_confidence: isStale ? lowerConfidence(confidence) : confidence,
  };
}

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_]+/g)
        .map((part) => part.trim())
        .filter((part) => part.length >= 3),
    ),
  ).slice(0, 8);
}

function rowToDuplicateSummary(row: DuplicateRow): DuplicateSummary {
  return {
    id: row.id,
    claim: row.claim,
    project: row.project,
    module: row.module,
    tags: JSON.parse(row.tags) as string[],
    confidence: row.confidence,
    staleness_hint: row.staleness_hint,
    owner: row.owner,
    created_at: row.created_at,
  };
}

export function detectPossibleDuplicates(
  db: Database.Database,
  input: { claim: string; project: string; excludeId?: string | null },
): DuplicateSummary[] {
  const seen = new Set<string>();
  const matches: DuplicateSummary[] = [];
  const excludeId = input.excludeId ?? null;

  const exactRows = db.prepare(
    `SELECT id, claim, project, module, tags, confidence, staleness_hint, owner, created_at
     FROM knowledge
     WHERE lower(claim) = lower(?)
       AND project = ?
       AND superseded_by IS NULL
       AND (? IS NULL OR id != ?)
     ORDER BY created_at DESC
     LIMIT 3`,
  ).all(input.claim, input.project, excludeId, excludeId) as DuplicateRow[];

  for (const row of exactRows) {
    seen.add(row.id);
    matches.push(rowToDuplicateSummary(row));
  }

  const terms = tokenize(input.claim);
  if (terms.length === 0) return matches;

  const query = terms.join(" OR ");
  const ftsRows = db.prepare(
    `SELECT k.id, k.claim, k.project, k.module, k.tags, k.confidence, k.staleness_hint, k.owner, k.created_at
     FROM knowledge_fts fts
     JOIN knowledge k ON k.rowid = fts.rowid
     WHERE knowledge_fts MATCH ?
       AND k.project = ?
       AND k.superseded_by IS NULL
       AND (? IS NULL OR k.id != ?)
     ORDER BY rank
     LIMIT 5`,
  ).all(query, input.project, excludeId, excludeId) as DuplicateRow[];

  for (const row of ftsRows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    matches.push(rowToDuplicateSummary(row));
    if (matches.length >= 3) break;
  }

  return matches;
}

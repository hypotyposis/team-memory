import type Database from "better-sqlite3";
import { normalizeClaimForDuplicateMatch } from "./duplicates.js";
import { decodeEmbedding, cosineSimilarity } from "./vector.js";

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
  embedding?: Buffer | null;
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
  similarity?: number;
}

interface RankedDuplicateSummary extends DuplicateSummary {
  similarity: number;
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

function duplicateWarningThreshold(): number {
  const raw = Number.parseFloat(process.env.TEAM_MEMORY_DUPLICATE_WARNING_THRESHOLD ?? "0.8");
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.8;
}

export function detectPossibleDuplicates(
  db: Database.Database,
  input: { claim: string; project: string; embedding?: Buffer | null; excludeId?: string | null },
): DuplicateSummary[] {
  const seen = new Set<string>();
  const matches: DuplicateSummary[] = [];
  const excludeId = input.excludeId ?? null;
  const projectRows = db.prepare(
    `SELECT id, claim, project, module, tags, confidence, staleness_hint, owner, created_at, embedding
     FROM knowledge
     WHERE project = ?
       AND superseded_by IS NULL
       AND (? IS NULL OR id != ?)
     ORDER BY created_at DESC`,
  ).all(input.project, excludeId, excludeId) as DuplicateRow[];
  const normalizedClaim = normalizeClaimForDuplicateMatch(input.claim);
  const exactRows = projectRows.filter(
    (row) => normalizeClaimForDuplicateMatch(row.claim) === normalizedClaim,
  );

  for (const row of exactRows) {
    seen.add(row.id);
    matches.push(rowToDuplicateSummary(row));
    if (matches.length >= 3) return matches;
  }

  const currentEmbedding = decodeEmbedding(input.embedding ?? null);
  if (!currentEmbedding) return matches;

  const warningThreshold = duplicateWarningThreshold();
  const rankedRows = projectRows
    .filter((row) => !seen.has(row.id) && row.embedding != null)
    .map((row) => {
      const storedEmbedding = decodeEmbedding(row.embedding ?? null);
      if (!storedEmbedding) return null;

      const similarity = cosineSimilarity(currentEmbedding, storedEmbedding);
      if (similarity < warningThreshold) return null;

      return {
        ...rowToDuplicateSummary(row),
        similarity,
      };
    })
    .filter((row): row is RankedDuplicateSummary => row !== null)
    .sort((left, right) => {
      if (right.similarity !== left.similarity) {
        return right.similarity - left.similarity;
      }
      return Date.parse(right.created_at) - Date.parse(left.created_at);
    });

  for (const row of rankedRows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    matches.push(row);
    if (matches.length >= 3) break;
  }

  return matches;
}

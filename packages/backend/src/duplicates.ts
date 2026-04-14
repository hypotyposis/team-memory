import type Database from "better-sqlite3";

export interface DuplicateCandidate {
  id: string;
  claim: string;
  project: string;
  similarity?: number;
}

interface DuplicateLinkRow {
  id: string;
  claim: string;
  project: string;
  duplicate_of: string;
  target_claim: string | null;
  target_project: string | null;
}

export function normalizeClaimForDuplicateMatch(claim: string): string {
  return claim.trim().toLowerCase().replace(/\s+/g, " ");
}

function semanticPersistThreshold(): number {
  const raw = Number.parseFloat(process.env.TEAM_MEMORY_DUPLICATE_PERSIST_THRESHOLD ?? "0.95");
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.95;
}

function isExactDuplicateMatch(
  currentClaim: string,
  currentProject: string,
  targetClaim: string | null,
  targetProject: string | null,
): boolean {
  if (!targetClaim || !targetProject) return false;
  return (
    currentProject === targetProject &&
    normalizeClaimForDuplicateMatch(currentClaim) === normalizeClaimForDuplicateMatch(targetClaim)
  );
}

export function findPersistedDuplicateOf(
  claim: string,
  project: string,
  candidates: DuplicateCandidate[],
): string | null {
  const exactMatch = candidates.find((candidate) =>
    isExactDuplicateMatch(claim, project, candidate.claim, candidate.project),
  );
  if (exactMatch) {
    return exactMatch.id;
  }

  const semanticMatch = candidates.find((candidate) => (candidate.similarity ?? 0) >= semanticPersistThreshold());
  return semanticMatch?.id ?? null;
}

export function cleanupFalsePositiveDuplicateOf(db: Database.Database): number {
  const rows = db.prepare(
    `SELECT
       current.id,
       current.claim,
       current.project,
       current.duplicate_of,
       target.claim AS target_claim,
       target.project AS target_project
     FROM knowledge current
     LEFT JOIN knowledge target ON target.id = current.duplicate_of
     WHERE current.duplicate_of IS NOT NULL`,
  ).all() as DuplicateLinkRow[];

  const invalidIds = rows
    .filter((row) =>
      !isExactDuplicateMatch(row.claim, row.project, row.target_claim, row.target_project),
    )
    .map((row) => row.id);

  if (invalidIds.length === 0) {
    return 0;
  }

  const clearDuplicateOf = db.prepare("UPDATE knowledge SET duplicate_of = NULL WHERE id = ?");
  const cleanup = db.transaction((ids: string[]) => {
    for (const id of ids) {
      clearDuplicateOf.run(id);
    }
  });

  cleanup(invalidIds);
  return invalidIds.length;
}

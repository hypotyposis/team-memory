import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export interface ApiKeyRow {
  id: string;
  key: string;
  owner: string;
  default_projects: string | null;
  description: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface ApiKeyRecord {
  id: string;
  key: string;
  owner: string;
  default_projects: string[] | null;
  description: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface CreateApiKeyInput {
  owner: string;
  defaultProjects: string[] | null;
  description?: string | null;
  expiresAt?: string | null;
}

export interface UpdateApiKeyInput {
  defaultProjects?: string[] | null;
  description?: string | null;
  expiresAt?: string | null;
}

export function parseStoredProjects(raw: string | null | undefined): string[] | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const projects = normalizeProjectList(
      parsed.filter((value): value is string => typeof value === "string"),
    );
    return projects;
  } catch {
    return null;
  }
}

export function encodeProjects(projects: string[] | null): string | null {
  return projects ? JSON.stringify(projects) : null;
}

export function normalizeProjectList(projects: string[] | null | undefined): string[] | null {
  if (!projects) return null;

  const normalized = Array.from(new Set(
    projects
      .map((project) => project.trim())
      .filter(Boolean),
  ));

  return normalized.length > 0 ? normalized : null;
}

export function parseProjectsArg(value: string | undefined): string[] {
  if (value === undefined) {
    throw new Error("--projects requires a value, e.g. --projects alpha,beta");
  }

  const normalized = normalizeProjectList(value.split(","));
  if (!normalized) {
    throw new Error("--projects value is empty after parsing — pass at least one project name, or use --unscoped");
  }
  if (normalized.some((project) => project === "*")) {
    throw new Error("--projects does not accept '*' — use --unscoped to opt out of project scoping");
  }

  return normalized;
}

export function formatScope(rawProjects: string | null): string {
  const projects = parseStoredProjects(rawProjects);
  return projects ? projects.join(",") : "*";
}

export function createAdminKeySecret(): string {
  return `tm_admin_${randomBytes(24).toString("hex")}`;
}

function createApiKeyId(): string {
  return `key_${randomBytes(8).toString("hex")}`;
}

function createApiKeySecret(): string {
  return `tm_${randomBytes(24).toString("hex")}`;
}

export function rowToApiKeyRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    key: row.key,
    owner: row.owner,
    default_projects: parseStoredProjects(row.default_projects),
    description: row.description,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}

export function createApiKey(
  db: Database.Database,
  input: CreateApiKeyInput,
): ApiKeyRecord {
  const record: ApiKeyRecord = {
    id: createApiKeyId(),
    key: createApiKeySecret(),
    owner: input.owner,
    default_projects: normalizeProjectList(input.defaultProjects),
    description: input.description ?? null,
    expires_at: input.expiresAt ?? null,
    last_used_at: null,
    created_at: new Date().toISOString(),
    revoked_at: null,
  };

  db.prepare(
    `INSERT INTO api_keys (
      id, key, owner, default_projects, description, expires_at, last_used_at, created_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.key,
    record.owner,
    encodeProjects(record.default_projects),
    record.description,
    record.expires_at,
    record.last_used_at,
    record.created_at,
    record.revoked_at,
  );

  return record;
}

export function listApiKeys(db: Database.Database): ApiKeyRecord[] {
  const rows = db
    .prepare(
      `SELECT id, key, owner, default_projects, description, expires_at, last_used_at, created_at, revoked_at
       FROM api_keys
       ORDER BY created_at DESC`,
    )
    .all() as ApiKeyRow[];

  return rows.map(rowToApiKeyRecord);
}

export function getApiKeyById(db: Database.Database, id: string): ApiKeyRecord | null {
  const row = db
    .prepare(
      `SELECT id, key, owner, default_projects, description, expires_at, last_used_at, created_at, revoked_at
       FROM api_keys
       WHERE id = ?`,
    )
    .get(id) as ApiKeyRow | undefined;

  return row ? rowToApiKeyRecord(row) : null;
}

export function updateApiKeyById(
  db: Database.Database,
  id: string,
  input: UpdateApiKeyInput,
): ApiKeyRecord | null {
  const sets: string[] = [];
  const params: Array<string | null> = [];

  if ("defaultProjects" in input) {
    sets.push("default_projects = ?");
    params.push(encodeProjects(normalizeProjectList(input.defaultProjects)));
  }
  if ("description" in input) {
    sets.push("description = ?");
    params.push(input.description ?? null);
  }
  if ("expiresAt" in input) {
    sets.push("expires_at = ?");
    params.push(input.expiresAt ?? null);
  }

  if (sets.length === 0) {
    return getApiKeyById(db, id);
  }

  params.push(id);
  const result = db
    .prepare(`UPDATE api_keys SET ${sets.join(", ")} WHERE id = ? AND revoked_at IS NULL`)
    .run(...params);

  if (result.changes === 0) return null;
  return getApiKeyById(db, id);
}

export function revokeApiKeyById(db: Database.Database, id: string): boolean {
  const revokedAt = new Date().toISOString();
  const result = db
    .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(revokedAt, id);

  return result.changes > 0;
}

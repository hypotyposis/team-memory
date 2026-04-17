import type { Context } from "hono";
import { getDb } from "./db.js";
import { parseStoredProjects } from "./api-keys.js";

export interface ApiAuth {
  key: string;
  owner: string;
  defaultProjects: string[] | null;
}

interface ApiKeyRow {
  id: string | null;
  key: string;
  owner: string;
  default_projects: string | null;
  expires_at: string | null;
}

function jsonError(c: Context, status: 401 | 403, error: string, code: string): Response {
  return c.json({ error, code }, status);
}

function notFound(c: Context): Response {
  return c.json({ error: "Not found" }, 404);
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function lookupApiAuth(token: string): ApiAuth | undefined {
  const db = getDb();
  const row = db
    .prepare("SELECT id, key, owner, default_projects, expires_at FROM api_keys WHERE key = ? AND revoked_at IS NULL")
    .get(token) as ApiKeyRow | undefined;

  if (!row) return undefined;
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return undefined;

  if (row.id) {
    db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      row.id,
    );
  }

  return {
    key: row.key,
    owner: row.owner,
    defaultProjects: parseStoredProjects(row.default_projects),
  };
}

export function requireApiAuth(c: Context): ApiAuth | Response {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) {
    return jsonError(c, 401, "Missing Authorization: Bearer <api_key> header", "auth_missing");
  }

  const row = lookupApiAuth(token);

  if (!row) {
    return jsonError(c, 401, "Invalid API key", "auth_invalid");
  }

  return row;
}

export function getOptionalApiAuth(c: Context): ApiAuth | Response | null {
  const header = c.req.header("authorization");
  if (!header) return null;

  const token = extractBearerToken(header);
  if (!token) {
    return jsonError(c, 401, "Missing Authorization: Bearer <api_key> header", "auth_missing");
  }

  const row = lookupApiAuth(token);

  if (!row) {
    return jsonError(c, 401, "Invalid API key", "auth_invalid");
  }

  return row;
}

export function requireOwnerAccess(c: Context, itemOwner: string): ApiAuth | Response {
  const auth = requireApiAuth(c);
  if (auth instanceof Response) return auth;
  if (auth.owner !== itemOwner) {
    return jsonError(c, 403, "Only the owner can modify this item", "owner_forbidden");
  }
  return auth;
}

export function requireAdminAuth(c: Context): true | Response {
  const adminKey = process.env.TEAM_MEMORY_ADMIN_KEY;
  if (!adminKey) {
    return notFound(c);
  }

  const token = extractBearerToken(c.req.header("authorization"));
  if (!token || token !== adminKey) {
    return notFound(c);
  }

  return true;
}

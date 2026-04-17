import type { Context } from "hono";
import { getDb } from "./db.js";

export interface ApiAuth {
  key: string;
  owner: string;
  defaultProjects: string[] | null;
}

interface ApiKeyRow {
  key: string;
  owner: string;
  default_projects: string | null;
}

function jsonError(c: Context, status: 401 | 403, error: string, code: string): Response {
  return c.json({ error, code }, status);
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function parseDefaultProjects(raw: string | null | undefined): string[] | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const projects = Array.from(new Set(
      parsed
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ));
    return projects.length > 0 ? projects : null;
  } catch {
    return null;
  }
}

function lookupApiAuth(token: string): ApiAuth | undefined {
  const db = getDb();
  const row = db
    .prepare("SELECT key, owner, default_projects FROM api_keys WHERE key = ? AND revoked_at IS NULL")
    .get(token) as ApiKeyRow | undefined;

  if (!row) return undefined;

  return {
    key: row.key,
    owner: row.owner,
    defaultProjects: parseDefaultProjects(row.default_projects),
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

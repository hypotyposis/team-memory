import type { Context } from "hono";
import { getDb } from "./db.js";

export interface ApiAuth {
  key: string;
  owner: string;
}

function jsonError(c: Context, status: 401 | 403, error: string, code: string): Response {
  return c.json({ error, code }, status);
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function requireApiAuth(c: Context): ApiAuth | Response {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) {
    return jsonError(c, 401, "Missing Authorization: Bearer <api_key> header", "auth_missing");
  }

  const db = getDb();
  const row = db
    .prepare("SELECT key, owner FROM api_keys WHERE key = ? AND revoked_at IS NULL")
    .get(token) as ApiAuth | undefined;

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

  const db = getDb();
  const row = db
    .prepare("SELECT key, owner FROM api_keys WHERE key = ? AND revoked_at IS NULL")
    .get(token) as ApiAuth | undefined;

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

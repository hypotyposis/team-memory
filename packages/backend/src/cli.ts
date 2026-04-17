import { randomBytes } from "node:crypto";
import { closeDb, getDb } from "./db.js";

function usage(): never {
  console.error(`Usage:
  npm run keys -- create <owner> (--projects alpha,beta | --unscoped)
  npm run keys -- list
  npm run keys -- update-key <api_key> (--projects alpha,beta | --unscoped)
  npm run keys -- revoke <api_key>

Scope flags are required on create/update-key — silently minting an unscoped key is not allowed.
Pass explicit project names with --projects, or --unscoped to opt out of namespacing.`);
  process.exit(1);
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

type ScopeFlags = { projects: string[] | null };

function parseProjectsList(raw: string | undefined): string[] {
  if (raw === undefined) fail("--projects requires a value, e.g. --projects alpha,beta");
  const list = Array.from(new Set(
    raw.split(",").map((project) => project.trim()).filter(Boolean),
  ));
  if (list.length === 0) {
    fail("--projects value is empty after parsing — pass at least one project name, or use --unscoped");
  }
  if (list.some((p) => p === "*")) {
    fail("--projects does not accept '*' — use --unscoped to opt out of project scoping");
  }
  return list;
}

function parseScopeFlags(args: string[]): ScopeFlags {
  const projectsIdx = args.indexOf("--projects");
  const unscopedIdx = args.indexOf("--unscoped");
  const hasProjects = projectsIdx >= 0;
  const hasUnscoped = unscopedIdx >= 0;

  if (hasProjects && hasUnscoped) {
    fail("--projects and --unscoped are mutually exclusive — pick exactly one");
  }
  if (!hasProjects && !hasUnscoped) {
    fail("scope is required — pass --projects <names> or --unscoped");
  }
  if (hasUnscoped) return { projects: null };
  return { projects: parseProjectsList(args[projectsIdx + 1]) };
}

function encodeProjects(projects: string[] | null): string | null {
  return projects ? JSON.stringify(projects) : null;
}

function formatScope(projects: string | null): string {
  if (!projects) return "*";
  try {
    const parsed = JSON.parse(projects);
    if (!Array.isArray(parsed) || parsed.length === 0) return "*";
    return parsed.join(",");
  } catch {
    return projects;
  }
}

function createKey(owner: string, projects: string[] | null): void {
  const db = getDb();
  const key = `tm_${randomBytes(24).toString("hex")}`;
  const createdAt = new Date().toISOString();

  db.prepare(
    "INSERT INTO api_keys (key, owner, default_projects, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)",
  ).run(
    key,
    owner,
    encodeProjects(projects),
    createdAt,
  );

  console.log(`Created API key for ${owner}`);
  console.log(`key=${key}`);
  console.log(`created_at=${createdAt}`);
  console.log(`scope=${projects ? projects.join(",") : "*"}`);
}

function listKeys(): void {
  const db = getDb();
  const rows = db
    .prepare("SELECT key, owner, default_projects, created_at, revoked_at FROM api_keys ORDER BY created_at DESC")
    .all() as Array<{
      key: string;
      owner: string;
      default_projects: string | null;
      created_at: string;
      revoked_at: string | null;
    }>;

  if (rows.length === 0) {
    console.log("No API keys found.");
    return;
  }

  for (const row of rows) {
    console.log(
      `${row.key} owner=${row.owner} scope=${formatScope(row.default_projects)} created_at=${row.created_at} status=${row.revoked_at ? "revoked" : "active"}`,
    );
  }
}

function updateKeyProjects(key: string, projects: string[] | null): void {
  const db = getDb();
  const result = db
    .prepare("UPDATE api_keys SET default_projects = ? WHERE key = ? AND revoked_at IS NULL")
    .run(encodeProjects(projects), key);

  if (result.changes === 0) {
    console.error(`No active API key found for ${key}`);
    process.exit(1);
  }

  console.log(`Updated API key ${key}`);
  console.log(`scope=${projects ? projects.join(",") : "*"}`);
}

function revokeKey(key: string): void {
  const db = getDb();
  const revokedAt = new Date().toISOString();
  const result = db
    .prepare("UPDATE api_keys SET revoked_at = ? WHERE key = ? AND revoked_at IS NULL")
    .run(revokedAt, key);

  if (result.changes === 0) {
    console.error(`No active API key found for ${key}`);
    process.exit(1);
  }

  console.log(`Revoked API key ${key}`);
}

try {
  const args = process.argv.slice(2);
  const [command, firstArg, ...rest] = args;

  switch (command) {
    case "create": {
      if (!firstArg) usage();
      const { projects } = parseScopeFlags(rest);
      createKey(firstArg, projects);
      break;
    }
    case "list":
      listKeys();
      break;
    case "update-key": {
      if (!firstArg) usage();
      const { projects } = parseScopeFlags(rest);
      updateKeyProjects(firstArg, projects);
      break;
    }
    case "revoke":
      if (!firstArg) usage();
      revokeKey(firstArg);
      break;
    default:
      usage();
  }
} finally {
  closeDb();
}

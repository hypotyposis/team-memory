import { closeDb, getDb } from "./db.js";
import {
  createAdminKeySecret,
  createApiKey,
  listApiKeys,
  parseProjectsArg,
  updateApiKeyById,
  revokeApiKeyById,
} from "./api-keys.js";

function usage(): never {
  console.error(`Usage:
  npm run keys -- create <owner> (--projects alpha,beta | --unscoped)
  npm run keys -- admin-init
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
  try {
    return { projects: parseProjectsArg(args[projectsIdx + 1]) };
  } catch (error) {
    fail(error instanceof Error ? error.message : "invalid --projects value");
  }
}

function createKey(owner: string, projects: string[] | null): void {
  const db = getDb();
  const record = createApiKey(db, { owner, defaultProjects: projects });

  console.log(`Created API key for ${owner}`);
  console.log(`id=${record.id}`);
  console.log(`key=${record.key}`);
  console.log(`created_at=${record.created_at}`);
  console.log(`scope=${record.default_projects ? record.default_projects.join(",") : "*"}`);
}

function initAdminKey(): void {
  const key = createAdminKeySecret();
  console.log("Generated TEAM_MEMORY_ADMIN_KEY");
  console.log(`TEAM_MEMORY_ADMIN_KEY=${key}`);
}

function listKeys(): void {
  const db = getDb();
  const rows = listApiKeys(db);

  if (rows.length === 0) {
    console.log("No API keys found.");
    return;
  }

  for (const row of rows) {
    console.log(
      `${row.key} owner=${row.owner} scope=${row.default_projects ? row.default_projects.join(",") : "*"} created_at=${row.created_at} status=${row.revoked_at ? "revoked" : "active"}`,
    );
  }
}

function updateKeyProjects(key: string, projects: string[] | null): void {
  const db = getDb();
  const row = db
    .prepare("SELECT id FROM api_keys WHERE key = ? AND revoked_at IS NULL")
    .get(key) as { id: string } | undefined;

  if (!row) {
    console.error(`No active API key found for ${key}`);
    process.exit(1);
  }

  updateApiKeyById(db, row.id, { defaultProjects: projects });

  console.log(`Updated API key ${key}`);
  console.log(`scope=${projects ? projects.join(",") : "*"}`);
}

function revokeKey(key: string): void {
  const db = getDb();
  const row = db
    .prepare("SELECT id FROM api_keys WHERE key = ? AND revoked_at IS NULL")
    .get(key) as { id: string } | undefined;

  if (!row || !revokeApiKeyById(db, row.id)) {
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
    case "admin-init":
      initAdminKey();
      break;
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

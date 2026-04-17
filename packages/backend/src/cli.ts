import { randomBytes } from "node:crypto";
import { closeDb, getDb } from "./db.js";

function usage(): never {
  console.error(`Usage:
  npm run keys -- create <owner> [--projects alpha,beta]
  npm run keys -- list
  npm run keys -- update-key <api_key> --projects alpha,beta
  npm run keys -- revoke <api_key>`);
  process.exit(1);
}

function parseProjectsArg(value: string | undefined): string[] | null {
  if (value === undefined) usage();
  if (value === "" || value === "*") return null;

  const projects = Array.from(new Set(
    value
      .split(",")
      .map((project) => project.trim())
      .filter(Boolean),
  ));

  return projects.length > 0 ? projects : null;
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
      const flagIndex = rest.indexOf("--projects");
      const projects = flagIndex >= 0 ? parseProjectsArg(rest[flagIndex + 1]) : null;
      createKey(firstArg, projects);
      break;
    }
    case "list":
      listKeys();
      break;
    case "update-key": {
      if (!firstArg) usage();
      const flagIndex = rest.indexOf("--projects");
      if (flagIndex < 0) usage();
      updateKeyProjects(firstArg, parseProjectsArg(rest[flagIndex + 1]));
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

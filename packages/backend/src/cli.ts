import { randomBytes } from "node:crypto";
import { closeDb, getDb } from "./db.js";

function usage(): never {
  console.error(`Usage:
  npm run keys -- create <owner>
  npm run keys -- list
  npm run keys -- revoke <api_key>`);
  process.exit(1);
}

function createKey(owner: string): void {
  const db = getDb();
  const key = `tm_${randomBytes(24).toString("hex")}`;
  const createdAt = new Date().toISOString();

  db.prepare("INSERT INTO api_keys (key, owner, created_at, revoked_at) VALUES (?, ?, ?, NULL)").run(
    key,
    owner,
    createdAt,
  );

  console.log(`Created API key for ${owner}`);
  console.log(`key=${key}`);
  console.log(`created_at=${createdAt}`);
}

function listKeys(): void {
  const db = getDb();
  const rows = db
    .prepare("SELECT key, owner, created_at, revoked_at FROM api_keys ORDER BY created_at DESC")
    .all() as Array<{ key: string; owner: string; created_at: string; revoked_at: string | null }>;

  if (rows.length === 0) {
    console.log("No API keys found.");
    return;
  }

  for (const row of rows) {
    console.log(
      `${row.key} owner=${row.owner} created_at=${row.created_at} status=${row.revoked_at ? "revoked" : "active"}`,
    );
  }
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
  const [command, arg] = process.argv.slice(2);

  switch (command) {
    case "create":
      if (!arg) usage();
      createKey(arg);
      break;
    case "list":
      listKeys();
      break;
    case "revoke":
      if (!arg) usage();
      revokeKey(arg);
      break;
    default:
      usage();
  }
} finally {
  closeDb();
}

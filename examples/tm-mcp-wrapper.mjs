#!/usr/bin/env node
// Per-agent key delegation wrapper for Team Memory MCP server.
// See docs/per-agent-key-delegation.md for the full spec.
//
// Resolves the spawning agent's UUID from CWD, maps it to a TM API key
// via two JSON mapping files, and injects the key as TEAM_MEMORY_API_KEY
// before starting the real MCP server. Falls through to anonymous mode
// if any resolution step fails.
//
// Deletable: when the host launcher natively injects TEAM_MEMORY_API_KEY,
// point MCP config directly at packages/mcp-server/dist/index.js and rm this file.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEPLOY_DIR = process.env.TM_DEPLOY_DIR || resolve(__dirname, "..");
const MCP_ENTRY =
  process.env.TM_MCP_ENTRY ||
  resolve(DEPLOY_DIR, "packages/mcp-server/dist/index.js");
const UUID_MAP = resolve(DEPLOY_DIR, "agent-uuid-to-lane.json");
const KEYS = resolve(DEPLOY_DIR, "per-lane-keys.json");

const UUID_RE = /\/\.slock\/agents\/([0-9a-f-]{36})(?:\/|$)/;

let lane = null;
let mode = "anonymous";
let reason = null;
let keyPrefix = null;

const uuidMatch = process.cwd().match(UUID_RE);
if (process.env.TEAM_MEMORY_API_KEY) {
  mode = "explicit";
  keyPrefix = process.env.TEAM_MEMORY_API_KEY.slice(0, 8);
} else if (!uuidMatch) {
  reason = "no-uuid-in-cwd";
} else {
  const uuid = uuidMatch[1];
  try {
    const mapping = JSON.parse(readFileSync(UUID_MAP, "utf8"));
    const keys = JSON.parse(readFileSync(KEYS, "utf8"));
    lane = mapping[uuid] ?? null;
    if (!lane) {
      reason = "uuid-not-in-mapping";
    } else if (!keys[lane]) {
      reason = "lane-has-no-key";
    } else {
      process.env.TEAM_MEMORY_API_KEY = keys[lane];
      process.env.TEAM_MEMORY_WRAPPER_OWNER = lane;
      mode = "keyed";
      keyPrefix = keys[lane].slice(0, 8);
    }
  } catch (err) {
    reason = err.code || err.message;
  }
}

if (mode === "keyed") {
  process.stderr.write(
    `[tm-mcp-wrapper] lane=${lane} mode=keyed key=${keyPrefix}...\n`,
  );
} else if (mode === "explicit") {
  process.stderr.write(
    `[tm-mcp-wrapper] mode=explicit key=${keyPrefix}...\n`,
  );
} else {
  process.stderr.write(
    `[tm-mcp-wrapper] lane=${lane ?? "<unresolved>"} mode=anonymous reason=${reason}\n`,
  );
}

createRequire(import.meta.url)(MCP_ENTRY);

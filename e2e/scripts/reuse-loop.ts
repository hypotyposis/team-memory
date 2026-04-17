import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const BACKEND_DIR = path.join(REPO_ROOT, "packages", "backend");

const PORT = parseInt(process.env.REUSE_LOOP_PORT ?? "3469", 10);
const BASE = `http://localhost:${PORT}`;
const API = `${BASE}/api`;

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];

function record(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  const mark = ok ? "✓" : "✗";
  const suffix = detail ? ` — ${detail}` : "";
  console.log(`  ${mark} ${name}${suffix}`);
}

function fail(reason: string): never {
  console.error(`FATAL: ${reason}`);
  process.exit(1);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* not ready yet */
    }
    await sleep(250);
  }
  fail(`backend did not become healthy within ${timeoutMs}ms`);
}

async function req<T = unknown>(
  method: string,
  url: string,
  opts: { body?: unknown; apiKey?: string; expect?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text;
  }
  const expected = opts.expect ?? 200;
  if (res.status !== expected && !(expected === 200 && res.status === 201)) {
    fail(`${method} ${url} expected ${expected}, got ${res.status}: ${JSON.stringify(data)}`);
  }
  return data as T;
}

type PublishResponse = { id: string };
type SearchResponse = {
  items: Array<{ id: string; claim: string }>;
  total?: number;
};
type ReuseReport = {
  total_queries: number;
  hit_rate: number;
  total_views: number;
  total_items: number;
  never_accessed_pct: number;
  north_star_count?: number;
  north_star_pct?: number;
  feedback_coverage?: number;
  top_reused: Array<{ knowledge_id: string; view_count: number }>;
  never_accessed: Array<{ id: string; claim: string }>;
  top_0hit_keywords?: Array<{ normalized_key: string; example_text: string; query_count: number }>;
};

function sqliteQueryJson(dbPath: string, sql: string): Array<Record<string, string | number | null>> {
  const result = spawnSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(`sqlite3 query failed: ${result.stderr}`);
  }
  const out = result.stdout.trim();
  if (!out) return [];
  return JSON.parse(out) as Array<Record<string, string | number | null>>;
}

async function run(): Promise<void> {
  console.log(`reuse-loop.ts: ephemeral backend on :${PORT}`);

  const tmp = mkdtempSync(path.join(tmpdir(), "team-memory-e2e-"));
  const dbPath = path.join(tmp, "reuse-loop.db");
  const env = {
    ...process.env,
    PORT: String(PORT),
    TEAM_MEMORY_DB: dbPath,
  };

  let backend: ChildProcessWithoutNullStreams | null = null;
  const cleanup = (): void => {
    if (backend && !backend.killed) {
      backend.kill("SIGTERM");
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  try {
    const build = spawnSync("npm", ["run", "build", "--workspace=packages/backend"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (build.status !== 0) fail("backend build failed");

    backend = spawn("node", ["dist/index.js"], {
      cwd: BACKEND_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    backend.stdout.on("data", (chunk) => process.stdout.write(`[backend] ${chunk}`));
    backend.stderr.on("data", (chunk) => process.stderr.write(`[backend] ${chunk}`));
    backend.on("exit", (code) => {
      if (code !== null && code !== 0 && checks.length === 0) {
        fail(`backend exited early with code ${code}`);
      }
    });

    await waitForHealth(15_000);

    const keyOut = spawnSync("npx", ["tsx", "src/cli.ts", "create", "e2e-reuse-loop"], {
      cwd: BACKEND_DIR,
      env,
      encoding: "utf8",
    });
    if (keyOut.status !== 0) {
      fail(`failed to create API key: ${keyOut.stdout}\n${keyOut.stderr}`);
    }
    const keyMatch = keyOut.stdout.match(/key=(tm_[0-9a-f]+)/);
    if (!keyMatch) fail(`could not parse API key: ${keyOut.stdout}`);
    const apiKey = keyMatch[1];

    const stamp = Date.now();
    const projectAlpha = `reuse-loop-alpha-${stamp}`;
    const projectBeta = `reuse-loop-beta-${stamp}`;

    const itemA = await req<PublishResponse>("POST", `${API}/knowledge`, {
      apiKey,
      body: {
        claim: `Reuse-loop alpha: dual approval workflow for production deploys`,
        detail: "Scoped to reuse-loop e2e.",
        source: ["e2e/scripts/reuse-loop.ts"],
        project: projectAlpha,
        module: "deploy",
        tags: ["deploy", "e2e"],
        confidence: "high",
        staleness_hint: "e2e fixture, no refresh needed",
      },
      expect: 201,
    });

    const itemB = await req<PublishResponse>("POST", `${API}/knowledge`, {
      apiKey,
      body: {
        claim: `Reuse-loop beta: reviewer quorum policy`,
        detail: "Project isolation check.",
        source: ["e2e/scripts/reuse-loop.ts"],
        project: projectBeta,
        module: "review",
        tags: ["review", "e2e"],
        confidence: "high",
        staleness_hint: "e2e fixture, no refresh needed",
      },
      expect: 201,
    });

    const hit = await req<SearchResponse>(
      "GET",
      `${API}/knowledge/search?${new URLSearchParams({ q: "approval", project: projectAlpha, limit: "10" })}`,
      { apiKey },
    );
    const hitIncludesA = hit.items.some((it) => it.id === itemA.id);
    if (!hitIncludesA) fail(`hit search did not include alpha item: ${JSON.stringify(hit.items)}`);

    const reportAfterHit = await req<ReuseReport>("GET", `${API}/reports/reuse`, { apiKey });
    record(
      "1. total_queries=1 & hit_rate=1.0 after single hit query",
      reportAfterHit.total_queries === 1 && reportAfterHit.hit_rate === 1,
      `total_queries=${reportAfterHit.total_queries}, hit_rate=${reportAfterHit.hit_rate}`,
    );

    const linkageRows = sqliteQueryJson(
      dbPath,
      `SELECT event_type, request_id, knowledge_id FROM usage_events WHERE event_type IN ('query','exposure') ORDER BY id`,
    );
    const queryRows = linkageRows.filter((r) => r.event_type === "query");
    const exposureRows = linkageRows.filter((r) => r.event_type === "exposure");
    const sharedLinkage =
      queryRows.length === 1
      && exposureRows.length >= 1
      && queryRows[0].request_id !== null
      && exposureRows.every((r) => r.request_id === queryRows[0].request_id);
    record(
      "2. request_id linkage: 1 query + N exposure share one request_id",
      sharedLinkage,
      `query=${queryRows.length} exposure=${exposureRows.length} rid=${String(queryRows[0]?.request_id)}`,
    );

    const zeroHitKey = `ghostzzz${stamp}`;
    await req<SearchResponse>(
      "GET",
      `${API}/knowledge/search?${new URLSearchParams({ q: "Refund", project: projectAlpha, limit: "10" })}`,
      { apiKey },
    );
    await req<SearchResponse>(
      "GET",
      `${API}/knowledge/search?${new URLSearchParams({ q: "refund", project: projectAlpha, limit: "10" })}`,
      { apiKey },
    );
    await req<SearchResponse>(
      "GET",
      `${API}/knowledge/search?${new URLSearchParams({ q: zeroHitKey, project: projectAlpha, limit: "10" })}`,
      { apiKey },
    );

    const reportAfterZeroHit = await req<ReuseReport>("GET", `${API}/reports/reuse`, { apiKey });
    const top0hitPresent = Array.isArray(reportAfterZeroHit.top_0hit_keywords);
    record(
      "3. 0-hit → top_0hit_keywords populated and hit_rate<1",
      top0hitPresent
      && (reportAfterZeroHit.top_0hit_keywords?.length ?? 0) > 0
      && reportAfterZeroHit.hit_rate < 1,
      `hit_rate=${reportAfterZeroHit.hit_rate} top_0hit=${reportAfterZeroHit.top_0hit_keywords?.length ?? "missing"}`,
    );

    const refundEntries = reportAfterZeroHit.top_0hit_keywords?.filter(
      (k) => k.normalized_key.replace(/\s+/g, "").toLowerCase() === "refund",
    ) ?? [];
    record(
      "+1. normalize Refund/refund aggregated to single entry with query_count=2",
      refundEntries.length === 1 && refundEntries[0].query_count === 2,
      `entries=${JSON.stringify(refundEntries)}`,
    );

    await req("GET", `${API}/knowledge/${itemA.id}?query_context=approval`, { apiKey });

    const reportAfterView = await req<ReuseReport>("GET", `${API}/reports/reuse`, { apiKey });
    const coverageAfterView = reportAfterView.feedback_coverage;
    record(
      "6a. feedback_coverage == 0 after view, before any feedback",
      typeof coverageAfterView === "number" && coverageAfterView === 0,
      `feedback_coverage=${coverageAfterView}`,
    );

    await req("POST", `${API}/knowledge/${itemA.id}/feedback`, {
      apiKey,
      body: { verdict: "useful", comment: "reuse-loop initial feedback" },
      expect: 201,
    });

    const reportAfterFirstFeedback = await req<ReuseReport>("GET", `${API}/reports/reuse`, { apiKey });
    const coverageAfterFirst = reportAfterFirstFeedback.feedback_coverage;
    record(
      "6b. feedback_coverage == 1.0 after first feedback on viewed item",
      typeof coverageAfterFirst === "number" && coverageAfterFirst === 1,
      `feedback_coverage=${coverageAfterFirst}`,
    );

    await req("POST", `${API}/knowledge/${itemA.id}/feedback`, {
      apiKey,
      body: { verdict: "useful", comment: "reuse-loop duplicate feedback" },
      expect: 201,
    });

    const reportAlpha = await req<ReuseReport>(
      "GET",
      `${API}/reports/reuse?${new URLSearchParams({ project: projectAlpha })}`,
      { apiKey },
    );
    const alphaLeaksBeta = reportAlpha.top_reused.some((it) => it.knowledge_id === itemB.id)
      || reportAlpha.never_accessed.some((it) => it.id === itemB.id);
    record(
      "4. ?project=alpha isolates — beta item not in alpha report",
      !alphaLeaksBeta,
    );

    const reportSince7d = await req<ReuseReport>(
      "GET",
      `${API}/reports/reuse?${new URLSearchParams({ since: "7d" })}`,
      { apiKey },
    );
    record(
      "5. ?since=7d window: all recent events included (total_queries≥4)",
      reportSince7d.total_queries >= 4,
      `total_queries=${reportSince7d.total_queries}`,
    );

    const emptyProject = `reuse-loop-empty-${stamp}`;
    const reportEmptySlice = await req<ReuseReport>(
      "GET",
      `${API}/reports/reuse?${new URLSearchParams({ project: emptyProject })}`,
      { apiKey },
    );
    const emptySliceOk =
      reportEmptySlice.total_queries === 0
      && reportEmptySlice.total_views === 0
      && reportEmptySlice.total_items === 0
      && reportEmptySlice.hit_rate === 0
      && (reportEmptySlice.feedback_coverage ?? 0) === 0
      && reportEmptySlice.top_reused.length === 0
      && reportEmptySlice.never_accessed.length === 0;
    record(
      "5a. empty slice (?project=<nonexistent>): zeroed metrics, empty arrays",
      emptySliceOk,
      `q=${reportEmptySlice.total_queries} v=${reportEmptySlice.total_views} items=${reportEmptySlice.total_items} cov=${reportEmptySlice.feedback_coverage}`,
    );

    const reportWithCoverage = await req<ReuseReport>("GET", `${API}/reports/reuse`, { apiKey });
    const coverageAfterDup = reportWithCoverage.feedback_coverage;
    record(
      "6c. feedback_coverage stays == 1.0 after duplicate feedback (no double-count)",
      typeof coverageAfterDup === "number" && coverageAfterDup === 1,
      `feedback_coverage=${coverageAfterDup}`,
    );

    const reportAged = await req<ReuseReport>(
      "GET",
      `${API}/reports/reuse?${new URLSearchParams({ min_age_days: "999" })}`,
      { apiKey },
    );
    record(
      "7. ?min_age_days=999 → never_accessed empty (no items that old in ephemeral DB)",
      reportAged.never_accessed.length === 0,
      `count=${reportAged.never_accessed.length}`,
    );
    record(
      "7b. ?min_age_days=999 → never_accessed_pct stays at unfiltered baseline (pct/list dual contract)",
      typeof reportAged.never_accessed_pct === "number"
      && reportAged.never_accessed_pct === reportAfterFirstFeedback.never_accessed_pct
      && reportAged.never_accessed_pct > 0,
      `pct=${reportAged.never_accessed_pct} baseline=${reportAfterFirstFeedback.never_accessed_pct}`,
    );

    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      console.error(`\nFAIL reuse-loop: ${failed.length}/${checks.length} checks failed`);
      for (const f of failed) {
        console.error(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
      }
      process.exit(1);
    }

    console.log(`\nPASS reuse-loop: ${checks.length} checks`);
  } finally {
    cleanup();
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});

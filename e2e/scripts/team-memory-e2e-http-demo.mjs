const baseUrl = process.env.TEAM_MEMORY_BASE_URL || "http://localhost:3456/api";
const apiKey = process.env.TEAM_MEMORY_API_KEY;

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text;
  }

  if (!response.ok) {
    fail(`${options.method || "GET"} ${url} -> ${response.status} ${JSON.stringify(data)}`);
  }

  return data;
}

async function main() {
  if (!apiKey) {
    fail("TEAM_MEMORY_API_KEY is required for authenticated publish");
  }

  const payload = {
    claim: "infer-monorepo's primary architecture axis is DEPLOY_MODE rather than folder structure.",
    detail:
      "Architecture review should start from deploy mode semantics before package layout because deployment behavior is the dominant organizing concern.",
    source: [
      "https://github.com/RiemaLabs/infer-monorepo",
      "#all architecture analysis summary on 2026-04-13",
    ],
    project: "infer-monorepo",
    module: "architecture",
    tags: ["architecture", "deploy-mode"],
    confidence: "high",
    staleness_hint: "Recheck if deploy-mode logic or package boundaries change.",
    related_to: [],
  };

  console.log(`BASE_URL ${baseUrl}`);

  const created = await requestJson(`${baseUrl}/knowledge`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!created.id) fail("publish response missing id");
  console.log(`PUBLISHED ${created.id}`);

  const params = new URLSearchParams({
    q: "architecture",
    project: "infer-monorepo",
    limit: "10",
  });
  const search = await requestJson(`${baseUrl}/knowledge/search?${params.toString()}`);

  if (!Array.isArray(search.items) || search.items.length === 0) {
    fail("search returned no items");
  }

  const summary = search.items.find((item) => item.id === created.id) || search.items[0];

  for (const field of ["id", "claim", "project", "tags", "confidence", "staleness_hint"]) {
    if (!(field in summary)) fail(`search summary missing field ${field}`);
  }
  console.log(`SEARCH_HIT ${summary.id}`);

  const full = await requestJson(`${baseUrl}/knowledge/${summary.id}`);

  for (const field of [
    "id",
    "claim",
    "detail",
    "source",
    "project",
    "tags",
    "confidence",
    "staleness_hint",
    "owner",
    "created_at",
    "updated_at",
  ]) {
    if (!(field in full)) fail(`full item missing field ${field}`);
  }
  for (const field of ["is_stale", "stale_after_days", "stale_at", "effective_confidence"]) {
    if (!(field in full)) fail(`full item missing quality field ${field}`);
  }

  if (!Array.isArray(full.source) || full.source.length === 0) {
    fail("full item source is not a non-empty array");
  }

  console.log(`GET_OK ${full.id}`);
  console.log("PASS backend happy-path for Team Memory E2E");
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));

import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiClient, isEndTaskPartialFailure } from "../src/api-client.ts";

test("isEndTaskPartialFailure: recognizes partial-failure envelope", () => {
  const partial = {
    task_id: "t-1",
    status: "completed",
    published_ids: ["k-1"],
    duration_ms: 42,
    error: {
      code: "publish_failed",
      failed_index: 1,
      publish_status: 400,
      publish_error: "claim must be non-empty",
    },
  };
  assert.equal(isEndTaskPartialFailure(partial), true);
});

test("isEndTaskPartialFailure: rejects hard-error payloads that carry task_id", () => {
  // Hypothetical future hard-error path that echoes task_id — the old shape-based
  // discriminator would have mis-classified this as partial-failure.
  const hardError = {
    task_id: "t-1",
    status: "already-closed",
    published_ids: [],
    error: "task_already_closed",
  };
  assert.equal(isEndTaskPartialFailure(hardError), false);
});

test("isEndTaskPartialFailure: rejects bare lifecycle errors (404/403/409)", () => {
  for (const body of [
    { error: "task_not_found" },
    { error: "task_owner_mismatch", code: "owner_mismatch" },
    { error: "task_already_closed", code: "already_closed" },
  ]) {
    assert.equal(isEndTaskPartialFailure(body), false);
  }
});

test("isEndTaskPartialFailure: rejects error object without numeric failed_index", () => {
  for (const body of [
    { error: { code: "publish_failed" } },
    { error: { code: "publish_failed", failed_index: "1" } },
    { error: { code: "publish_failed", failed_index: null } },
    { error: null },
    { error: "string-error" },
  ]) {
    assert.equal(isEndTaskPartialFailure(body), false);
  }
});

test("isEndTaskPartialFailure: rejects non-object inputs", () => {
  for (const body of [null, undefined, 42, "string", true, []]) {
    assert.equal(isEndTaskPartialFailure(body), false);
  }
});

test("ApiClient.endTask: partial-failure non-2xx returns EndTaskResponse", async () => {
  const partialBody = {
    task_id: "t-1",
    status: "completed",
    published_ids: ["k-1"],
    duration_ms: 42,
    error: {
      code: "publish_failed",
      failed_index: 1,
      publish_status: 400,
      publish_error: "bad",
    },
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(partialBody), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    const client = new ApiClient("http://localhost:9999", "test-key");
    const result = await client.endTask({ task_id: "t-1", status: "completed" });
    assert.equal(result.task_id, "t-1");
    assert.equal(result.error?.failed_index, 1);
    assert.deepEqual(result.published_ids, ["k-1"]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("ApiClient.endTask: hard error without failed_index throws", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "task_not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    const client = new ApiClient("http://localhost:9999", "test-key");
    await assert.rejects(
      client.endTask({ task_id: "missing", status: "completed" }),
      /end_task failed \(404\)/,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("ApiClient.endTask: hard error with spurious task_id still throws (the #53 regression)", async () => {
  // This is the exact case #53 was filed for: the old shape-based discriminator
  // inferred "partial failure" from presence of task_id/status/published_ids.
  // After the tightening, only error.failed_index presence triggers the
  // partial-failure path.
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        task_id: "t-1",
        status: "already-closed",
        published_ids: [],
        error: "task_already_closed",
      }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  try {
    const client = new ApiClient("http://localhost:9999", "test-key");
    await assert.rejects(
      client.endTask({ task_id: "t-1", status: "completed" }),
      /end_task failed \(409\)/,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

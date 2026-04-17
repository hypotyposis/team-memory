/**
 * HTTP client for Team Memory Backend API.
 * All tool calls are proxied through this client to the backend server.
 */

export interface KnowledgeItem {
  id: string;
  claim: string;
  detail?: string;
  source: string[];
  project: string;
  module?: string;
  tags: string[];
  confidence: "high" | "medium" | "low";
  staleness_hint: string;
  owner: string;
  related_to?: string[];
  supersedes?: string;
  superseded_by?: string;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSummary {
  id: string;
  claim: string;
  tags: string[];
  confidence: "high" | "medium" | "low";
  staleness_hint?: string;
  owner: string;
  project: string;
  module?: string;
  created_at: string;
  similarity?: number;
}

export interface PublishInput {
  claim: string;
  detail?: string;
  source: string[];
  project: string;
  module?: string;
  tags: string[];
  confidence: "high" | "medium" | "low";
  staleness_hint: string;
  owner?: string;
  related_to?: string[];
  supersedes?: string;
}

export interface QueryInput {
  query: string;
  tags?: string[];
  project?: string;
  module?: string;
  limit?: number;
  task_id?: string;
}

export interface ListInput {
  project?: string;
  tags?: string[];
  limit?: number;
}

export interface SemanticSearchInput {
  query: string;
  project?: string;
  limit?: number;
  task_id?: string;
}

export interface UpdateInput {
  id: string;
  tags?: string[];
  staleness_hint?: string;
  related_to?: string[];
  confidence?: "high" | "medium" | "low";
}

export type ReuseVerdict = "useful" | "not_useful" | "outdated";

export interface ReuseFeedbackInput {
  knowledge_id: string;
  verdict: ReuseVerdict;
  comment?: string;
  task_id?: string;
}

export interface ReuseFeedback {
  knowledge_id: string;
  owner: string;
  verdict: ReuseVerdict;
  comment: string | null;
  created_at: string;
}

export type TaskSearchMode = "fts" | "semantic" | "hybrid";
export type TaskRetrievalMode = "fts" | "hybrid";
export type TaskStatus = "open" | "completed" | "abandoned";
export type TaskEndStatus = "completed" | "abandoned";

export interface TaskMatch extends KnowledgeSummary {
  search_mode: TaskSearchMode;
}

export interface StartTaskInput {
  description: string;
  project?: string;
  max_matches?: number;
}

export interface StartTaskResponse {
  task_id: string;
  retrieval_mode: TaskRetrievalMode;
  project?: string;
  description: string;
  matches: TaskMatch[];
}

export interface EndTaskInput {
  task_id: string;
  status?: TaskEndStatus;
  findings?: PublishInput[];
}

export interface EndTaskPartialError {
  code: string;
  failed_index: number;
  publish_status: number;
  publish_error: string;
}

export interface EndTaskResponse {
  task_id: string;
  status: TaskEndStatus;
  published_ids: string[];
  duration_ms: number;
  error?: EndTaskPartialError;
}

export function isEndTaskPartialFailure(parsed: unknown): parsed is EndTaskResponse {
  if (!parsed || typeof parsed !== "object") return false;
  const err = (parsed as { error?: unknown }).error;
  if (!err || typeof err !== "object") return false;
  return typeof (err as { failed_index?: unknown }).failed_index === "number";
}

export class ApiClient {
  private baseUrl: string;
  private apiKey?: string;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  private writeHeaders(): Record<string, string> {
    return { "Content-Type": "application/json", ...this.authHeaders() };
  }

  async publish(input: PublishInput): Promise<KnowledgeItem> {
    const res = await fetch(`${this.baseUrl}/api/knowledge`, {
      method: "POST",
      headers: this.writeHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`publish failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<KnowledgeItem>;
  }

  async query(input: QueryInput): Promise<KnowledgeSummary[]> {
    const params = new URLSearchParams();
    params.set("q", input.query);
    if (input.tags?.length) params.set("tags", input.tags.join(","));
    if (input.project) params.set("project", input.project);
    if (input.module) params.set("module", input.module);
    if (input.limit) params.set("limit", String(input.limit));
    if (input.task_id) params.set("task_id", input.task_id);

    const res = await fetch(
      `${this.baseUrl}/api/knowledge/search?${params.toString()}`,
      { headers: this.authHeaders() }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`query failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { items: KnowledgeSummary[] };
    return data.items;
  }

  async list(input: ListInput): Promise<KnowledgeSummary[]> {
    const params = new URLSearchParams();
    if (input.project) params.set("project", input.project);
    if (input.tags?.length) params.set("tags", input.tags.join(","));
    if (input.limit) params.set("limit", String(input.limit));

    const res = await fetch(
      `${this.baseUrl}/api/knowledge?${params.toString()}`,
      { headers: this.authHeaders() }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`list failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { items: KnowledgeSummary[] };
    return data.items;
  }

  async get(
    id: string,
    queryContext?: string,
    taskId?: string
  ): Promise<KnowledgeItem> {
    const params = new URLSearchParams();
    if (queryContext) params.set("query_context", queryContext);
    if (taskId) params.set("task_id", taskId);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(`${this.baseUrl}/api/knowledge/${id}${suffix}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`get failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<KnowledgeItem>;
  }

  async reuseFeedback(input: ReuseFeedbackInput): Promise<ReuseFeedback> {
    const { knowledge_id, ...body } = input;
    const res = await fetch(
      `${this.baseUrl}/api/knowledge/${knowledge_id}/feedback`,
      {
        method: "POST",
        headers: this.writeHeaders(),
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`reuse feedback failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<ReuseFeedback>;
  }

  async semanticSearch(input: SemanticSearchInput): Promise<KnowledgeSummary[]> {
    const params = new URLSearchParams();
    params.set("q", input.query);
    if (input.project) params.set("project", input.project);
    if (input.limit) params.set("limit", String(input.limit));
    if (input.task_id) params.set("task_id", input.task_id);

    const res = await fetch(
      `${this.baseUrl}/api/knowledge/semantic-search?${params.toString()}`,
      { headers: this.authHeaders() }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`semantic search failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { items: KnowledgeSummary[] };
    return data.items;
  }

  async update(input: UpdateInput): Promise<KnowledgeItem> {
    const { id, ...fields } = input;
    const res = await fetch(`${this.baseUrl}/api/knowledge/${id}`, {
      method: "PATCH",
      headers: this.writeHeaders(),
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`update failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<KnowledgeItem>;
  }

  async startTask(input: StartTaskInput): Promise<StartTaskResponse> {
    const res = await fetch(`${this.baseUrl}/api/tasks/start`, {
      method: "POST",
      headers: this.writeHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`start_task failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<StartTaskResponse>;
  }

  async endTask(input: EndTaskInput): Promise<EndTaskResponse> {
    const { task_id, ...body } = input;
    const res = await fetch(
      `${this.baseUrl}/api/tasks/${encodeURIComponent(task_id)}/end`,
      {
        method: "POST",
        headers: this.writeHeaders(),
        body: JSON.stringify(body),
      }
    );
    // Partial-failure contract (Spike Q1 lock): on a findings[] publish failure
    // the backend returns a non-2xx response with the full EndTaskResponse body
    // — the session is already closed, `published_ids[]` lists items committed
    // before the failure, and `error{}` describes the first failing finding.
    // Surface that body to the caller instead of throwing so the MCP handler
    // can render partial success richly. 404 / 403 / 409 use a bare error
    // payload and still throw.
    //
    // Discriminator is semantic, not shape-based: partial-failure is the only
    // shape that carries `error.failed_index` per the locked contract, so we
    // detect it directly rather than inferring from `task_id/status/published_ids`
    // presence (which could collide if a future hard-error path echoes task_id).
    if (!res.ok) {
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        // fall through to raw-text throw below
      }
      if (isEndTaskPartialFailure(parsed)) {
        return parsed as EndTaskResponse;
      }
      const text =
        parsed != null ? JSON.stringify(parsed) : await res.text().catch(() => "");
      throw new Error(`end_task failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<EndTaskResponse>;
  }
}

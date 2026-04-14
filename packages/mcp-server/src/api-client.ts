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
  owner: string;
  related_to?: string[];
  supersedes?: string;
}

export interface QueryInput {
  query: string;
  tags?: string[];
  project?: string;
  module?: string;
  limit?: number;
}

export interface ListInput {
  project?: string;
  tags?: string[];
  limit?: number;
}

export interface UpdateInput {
  id: string;
  tags?: string[];
  staleness_hint?: string;
  related_to?: string[];
  confidence?: "high" | "medium" | "low";
}

export class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async publish(input: PublishInput): Promise<KnowledgeItem> {
    const res = await fetch(`${this.baseUrl}/api/knowledge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

    const res = await fetch(
      `${this.baseUrl}/api/knowledge/search?${params.toString()}`
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
      `${this.baseUrl}/api/knowledge?${params.toString()}`
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`list failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { items: KnowledgeSummary[] };
    return data.items;
  }

  async get(id: string): Promise<KnowledgeItem> {
    const res = await fetch(`${this.baseUrl}/api/knowledge/${id}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`get failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<KnowledgeItem>;
  }

  async update(input: UpdateInput): Promise<KnowledgeItem> {
    const { id, ...fields } = input;
    const res = await fetch(`${this.baseUrl}/api/knowledge/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`update failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<KnowledgeItem>;
  }
}

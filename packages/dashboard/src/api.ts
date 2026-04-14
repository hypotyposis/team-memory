import type { KnowledgeItem, KnowledgeListItem } from "./types";
import { mockKnowledge } from "./mockData";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3456/api";
const USE_MOCK = false;

interface ListParams {
  project?: string;
  tags?: string;
  module?: string;
  owner?: string;
  include_superseded?: boolean;
  limit?: number;
  offset?: number;
}

interface SearchParams {
  q: string;
  project?: string;
  tags?: string;
  module?: string;
  include_superseded?: boolean;
  limit?: number;
}

interface PaginatedResponse<T> {
  items: T[];
  total: number;
}

// --- Mock implementations ---

function mockList(params: ListParams): PaginatedResponse<KnowledgeListItem> {
  let items = [...mockKnowledge];

  if (!params.include_superseded) {
    items = items.filter((k) => !k.superseded_by);
  }
  if (params.project) {
    items = items.filter((k) => k.project === params.project);
  }
  if (params.tags) {
    const filterTags = params.tags.split(",");
    items = items.filter((k) => filterTags.some((t) => k.tags.includes(t)));
  }
  if (params.module) {
    items = items.filter((k) => k.module === params.module);
  }
  if (params.owner) {
    items = items.filter((k) => k.owner === params.owner);
  }

  const total = items.length;
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 50;
  items = items.slice(offset, offset + limit);

  return {
    items: items.map((k) => ({
      id: k.id,
      claim: k.claim,
      tags: k.tags,
      confidence: k.confidence,
      staleness_hint: k.staleness_hint,
      owner: k.owner,
      project: k.project,
      module: k.module,
      created_at: k.created_at,
    })),
    total,
  };
}

function mockSearch(params: SearchParams): PaginatedResponse<KnowledgeListItem> {
  const q = params.q.toLowerCase();
  let items = mockKnowledge.filter(
    (k) =>
      k.claim.toLowerCase().includes(q) ||
      k.detail?.toLowerCase().includes(q) ||
      k.tags.some((t) => t.toLowerCase().includes(q))
  );

  if (!params.include_superseded) {
    items = items.filter((k) => !k.superseded_by);
  }
  if (params.project) {
    items = items.filter((k) => k.project === params.project);
  }
  if (params.tags) {
    const filterTags = params.tags.split(",");
    items = items.filter((k) => filterTags.some((t) => k.tags.includes(t)));
  }

  const limit = params.limit ?? 20;
  items = items.slice(0, limit);

  return {
    items: items.map((k) => ({
      id: k.id,
      claim: k.claim,
      tags: k.tags,
      confidence: k.confidence,
      staleness_hint: k.staleness_hint,
      owner: k.owner,
      project: k.project,
      module: k.module,
      created_at: k.created_at,
    })),
    total: items.length,
  };
}

function mockGet(id: string): KnowledgeItem | null {
  return mockKnowledge.find((k) => k.id === id) ?? null;
}

// --- Real API implementations ---

async function fetchList(params: ListParams): Promise<PaginatedResponse<KnowledgeListItem>> {
  const url = new URL(`${API_BASE}/knowledge`);
  if (params.project) url.searchParams.set("project", params.project);
  if (params.tags) url.searchParams.set("tags", params.tags);
  if (params.module) url.searchParams.set("module", params.module);
  if (params.owner) url.searchParams.set("owner", params.owner);
  if (params.include_superseded) url.searchParams.set("include_superseded", "true");
  if (params.limit) url.searchParams.set("limit", String(params.limit));
  if (params.offset) url.searchParams.set("offset", String(params.offset));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function fetchSearch(params: SearchParams): Promise<PaginatedResponse<KnowledgeListItem>> {
  const url = new URL(`${API_BASE}/knowledge/search`);
  url.searchParams.set("q", params.q);
  if (params.project) url.searchParams.set("project", params.project);
  if (params.tags) url.searchParams.set("tags", params.tags);
  if (params.module) url.searchParams.set("module", params.module);
  if (params.include_superseded) url.searchParams.set("include_superseded", "true");
  if (params.limit) url.searchParams.set("limit", String(params.limit));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function fetchGet(id: string): Promise<KnowledgeItem | null> {
  const res = await fetch(`${API_BASE}/knowledge/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// --- Public API ---

export async function listKnowledge(params: ListParams = {}): Promise<PaginatedResponse<KnowledgeListItem>> {
  if (USE_MOCK) return mockList(params);
  return fetchList(params);
}

export async function searchKnowledge(params: SearchParams): Promise<PaginatedResponse<KnowledgeListItem>> {
  if (USE_MOCK) return mockSearch(params);
  return fetchSearch(params);
}

export async function getKnowledge(id: string): Promise<KnowledgeItem | null> {
  if (USE_MOCK) return mockGet(id);
  return fetchGet(id);
}

// --- Helpers ---

export async function getAllFilters(): Promise<{
  projects: string[];
  owners: string[];
  tags: string[];
}> {
  if (USE_MOCK) {
    return {
      projects: [...new Set(mockKnowledge.map((k) => k.project))],
      owners: [...new Set(mockKnowledge.map((k) => k.owner))],
      tags: [...new Set(mockKnowledge.flatMap((k) => k.tags))],
    };
  }
  const result = await listKnowledge({ limit: 200, include_superseded: true });
  return {
    projects: [...new Set(result.items.map((k) => k.project))],
    owners: [...new Set(result.items.map((k) => k.owner))],
    tags: [...new Set(result.items.flatMap((k) => k.tags))],
  };
}

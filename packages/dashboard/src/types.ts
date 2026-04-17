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
  duplicate_of?: string | null;
  is_stale?: boolean;
  stale_after_days?: number;
  stale_at?: string;
  effective_confidence?: "high" | "medium" | "low";
  created_at: string;
  updated_at?: string;
}

export interface KnowledgeListItem {
  id: string;
  claim: string;
  tags: string[];
  confidence: "high" | "medium" | "low";
  staleness_hint: string;
  owner: string;
  project: string;
  module?: string;
  duplicate_of?: string | null;
  is_stale?: boolean;
  stale_after_days?: number;
  stale_at?: string;
  effective_confidence?: "high" | "medium" | "low";
  similarity?: number;
  search_mode?: "fts" | "semantic" | "hybrid";
  created_at: string;
}

export interface TopReusedItem {
  knowledge_id: string;
  claim: string;
  view_count: number;
  unique_owners: number;
  useful_feedback_count: number;
  not_useful_feedback_count: number;
  outdated_feedback_count: number;
}

export interface NeverAccessedItem {
  id: string;
  claim: string;
}

export interface ZeroHitKeyword {
  normalized_key: string;
  example_text: string;
  query_count: number;
}

export interface ReuseReport {
  total_queries: number;
  hit_rate: number;
  total_views: number;
  total_items: number;
  never_accessed_pct: number;
  feedback_coverage: number;
  north_star_count: number;
  north_star_pct: number;
  top_reused: TopReusedItem[];
  top_0hit_keywords: ZeroHitKeyword[];
  never_accessed: NeverAccessedItem[];
}

export type ReuseSince = "7d" | "30d" | "all";

export interface ReuseReportParams {
  since?: ReuseSince;
  project?: string;
  min_age_days?: number;
}

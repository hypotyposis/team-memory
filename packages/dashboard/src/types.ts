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
  created_at: string;
}

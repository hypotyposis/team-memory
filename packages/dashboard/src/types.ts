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
  created_at: string;
}

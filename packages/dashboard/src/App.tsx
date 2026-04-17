import { useState, useEffect, useCallback } from "react";
import type { KnowledgeItem, KnowledgeListItem, ReuseReport, ReuseSince } from "./types";
import {
  listKnowledge,
  searchKnowledge,
  getKnowledge,
  getAllFilters,
  getApiKey,
  setApiKey,
  getReuseReport,
} from "./api";
import "./App.css";

type View = "knowledge" | "reuse";

function App() {
  const [items, setItems] = useState<KnowledgeListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<KnowledgeItem | null>(null);
  const [query, setQuery] = useState("");
  const [filterProject, setFilterProject] = useState<string | null>(null);
  const [filterOwner, setFilterOwner] = useState<string | null>(null);
  const [filterTag, setFilterTag] = useState<string | null>(null);

  const [projects, setProjects] = useState<string[]>([]);
  const [owners, setOwners] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [searchMode, setSearchMode] = useState<"fts" | "semantic" | "hybrid" | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState(getApiKey() ?? "");
  const [view, setView] = useState<View>("knowledge");

  useEffect(() => {
    getAllFilters().then(({ projects, owners, tags }) => {
      setProjects(projects);
      setOwners(owners);
      setTags(tags);
    });
  }, []);

  const load = useCallback(async () => {
    const params = {
      project: filterProject ?? undefined,
      owner: filterOwner ?? undefined,
      tags: filterTag ?? undefined,
    };

    let result;
    if (query.trim()) {
      result = await searchKnowledge({ q: query.trim(), ...params });
    } else {
      result = await listKnowledge(params);
    }
    setItems(result.items);
    setTotal(result.total);
    if (query.trim() && result.items.length > 0) {
      const modes = new Set(result.items.map((i) => i.search_mode).filter(Boolean));
      if (modes.has("hybrid") || modes.size > 1) setSearchMode("hybrid");
      else if (modes.has("semantic")) setSearchMode("semantic");
      else if (modes.has("fts")) setSearchMode("fts");
      else setSearchMode(null);
    } else {
      setSearchMode(null);
    }
  }, [query, filterProject, filterOwner, filterTag]);

  useEffect(() => {
    load();
  }, [load]);

  async function selectItem(id: string) {
    const item = await getKnowledge(id);
    setSelected(item);
  }

  function clearFilters() {
    setQuery("");
    setFilterProject(null);
    setFilterOwner(null);
    setFilterTag(null);
  }

  const hasFilters = query || filterProject || filterOwner || filterTag;

  return (
    <div className="app">
      <header className="app-header">
        <h1>Team Memory</h1>
        <nav className="view-tabs">
          <button
            className={`view-tab ${view === "knowledge" ? "active" : ""}`}
            onClick={() => setView("knowledge")}
          >
            Knowledge
          </button>
          <button
            className={`view-tab ${view === "reuse" ? "active" : ""}`}
            onClick={() => setView("reuse")}
          >
            Reuse
          </button>
        </nav>
        {view === "knowledge" && (
          <span className="stats">
            {total} knowledge item{total !== 1 ? "s" : ""}
          </span>
        )}
        <button
          className="settings-btn"
          onClick={() => setShowSettings(!showSettings)}
          title="API Key Settings"
        >
          {getApiKey() ? "🔑" : "⚙"}
        </button>
      </header>

      {showSettings && (
        <div className="settings-bar">
          <label>
            API Key:
            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder="Enter API key for write operations"
            />
          </label>
          <button
            onClick={() => {
              setApiKey(apiKeyInput || null);
              setShowSettings(false);
            }}
          >
            Save
          </button>
          {getApiKey() && (
            <button
              onClick={() => {
                setApiKey(null);
                setApiKeyInput("");
                setShowSettings(false);
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}

      {view === "reuse" ? (
        <ReuseView
          projects={projects}
          onNavigate={(id) => { setView("knowledge"); selectItem(id); }}
        />
      ) : (
      <div className="app-body">
        <aside className="sidebar">
          <FilterSection
            title="Project"
            items={projects}
            active={filterProject}
            onSelect={(v) =>
              setFilterProject(v === filterProject ? null : v)
            }
          />
          <FilterSection
            title="Owner"
            items={owners}
            active={filterOwner}
            onSelect={(v) =>
              setFilterOwner(v === filterOwner ? null : v)
            }
          />
          <FilterSection
            title="Tags"
            items={tags}
            active={filterTag}
            onSelect={(v) => setFilterTag(v === filterTag ? null : v)}
          />
        </aside>

        <div className="main-content">
          <div className="search-bar">
            <input
              className="search-input"
              type="text"
              placeholder="Search knowledge..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {searchMode && query.trim() && (
              <span className={`search-mode-badge ${searchMode}`}>
                {searchMode}
              </span>
            )}
            {hasFilters && (
              <button className="filter-btn" onClick={clearFilters}>
                Clear
              </button>
            )}
          </div>

          <div className="knowledge-list">
            {items.length === 0 ? (
              <div className="empty-state">
                <div className="title">No knowledge items found</div>
                <div>
                  {hasFilters
                    ? "Try adjusting your filters"
                    : "Knowledge will appear here once published"}
                </div>
              </div>
            ) : (
              items.map((item) => (
                <div
                  key={item.id}
                  className={`knowledge-row ${
                    selected?.id === item.id ? "selected" : ""
                  }${item.is_stale ? " stale" : ""}${item.duplicate_of ? " duplicate" : ""}`}
                  onClick={() => selectItem(item.id)}
                >
                  <div className="claim">
                    {item.claim}
                    {item.is_stale && (
                      <span className="quality-badge stale-badge">stale</span>
                    )}
                    {item.duplicate_of && (
                      <span className="quality-badge duplicate-badge">duplicate</span>
                    )}
                  </div>
                  <div className="meta">
                    <span className={`confidence ${item.effective_confidence ?? item.confidence}`}>
                      {item.effective_confidence ?? item.confidence}
                    </span>
                    {item.similarity != null && (
                      <span className="similarity">{Math.round(item.similarity * 100)}% match</span>
                    )}
                    <span>{item.project}</span>
                    {item.module && <span>/ {item.module}</span>}
                    <span>by {item.owner}</span>
                    <span>{formatDate(item.created_at)}</span>
                  </div>
                  <div className="meta" style={{ marginTop: 4 }}>
                    {item.tags.slice(0, 4).map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                    {item.tags.length > 4 && (
                      <span className="tag">+{item.tags.length - 4}</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="detail-panel">
          {selected ? (
            <DetailView
              item={selected}
              onNavigate={selectItem}
            />
          ) : (
            <div className="detail-empty">
              Select a knowledge item to view details
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

function FilterSection({
  title,
  items,
  active,
  onSelect,
}: {
  title: string;
  items: string[];
  active: string | null;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="filter-section">
      <h3>{title}</h3>
      {items.map((item) => (
        <button
          key={item}
          className={`filter-btn ${active === item ? "active" : ""}`}
          onClick={() => onSelect(item)}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

function DetailView({
  item,
  onNavigate,
}: {
  item: KnowledgeItem;
  onNavigate: (id: string) => void;
}) {
  return (
    <div className="detail-content">
      <h2>
        {item.claim}
        {item.is_stale && (
          <span className="quality-badge stale-badge">stale</span>
        )}
        {item.duplicate_of && (
          <span className="quality-badge duplicate-badge">duplicate</span>
        )}
      </h2>

      {item.detail && (
        <div className="detail-section">
          <h4>Detail</h4>
          <pre><code>{item.detail}</code></pre>
        </div>
      )}

      {(item.is_stale || item.duplicate_of) && (
        <div className="detail-section quality-warnings">
          {item.is_stale && (
            <div className="quality-warning stale-warning">
              This knowledge item is stale — it was last updated more than {item.stale_after_days ?? 30} days ago.
              {item.stale_at && <> Stale since {formatDate(item.stale_at)}.</>}
              {item.effective_confidence && item.effective_confidence !== item.confidence && (
                <> Effective confidence downgraded from {item.confidence} to {item.effective_confidence}.</>
              )}
            </div>
          )}
          {item.duplicate_of && (
            <div className="quality-warning duplicate-warning">
              Possible duplicate of{" "}
              <span
                className="related-id"
                onClick={() => onNavigate(item.duplicate_of!)}
              >
                {item.duplicate_of}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="detail-section">
        <div className="detail-meta">
          <div className="detail-meta-item">
            <span className="label">Confidence</span>
            <span className={`confidence ${item.effective_confidence ?? item.confidence}`}>
              {item.effective_confidence ?? item.confidence}
              {item.effective_confidence && item.effective_confidence !== item.confidence && (
                <span className="confidence-original"> (was {item.confidence})</span>
              )}
            </span>
          </div>
          <div className="detail-meta-item">
            <span className="label">Owner</span>
            <span className="value">{item.owner}</span>
          </div>
          <div className="detail-meta-item">
            <span className="label">Project</span>
            <span className="value">{item.project}</span>
          </div>
          {item.module && (
            <div className="detail-meta-item">
              <span className="label">Module</span>
              <span className="value">{item.module}</span>
            </div>
          )}
          <div className="detail-meta-item">
            <span className="label">Created</span>
            <span className="value">{formatDate(item.created_at)}</span>
          </div>
          {item.updated_at && (
            <div className="detail-meta-item">
              <span className="label">Updated</span>
              <span className="value">{formatDate(item.updated_at)}</span>
            </div>
          )}
        </div>
      </div>

      <div className="detail-section">
        <h4>Staleness Hint</h4>
        <p>{item.staleness_hint}</p>
      </div>

      <div className="detail-section">
        <h4>Tags</h4>
        <div className="detail-tags">
          {item.tags.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
        </div>
      </div>

      <div className="detail-section">
        <h4>Sources</h4>
        <ul className="source-list">
          {item.source.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>

      {item.related_to && item.related_to.length > 0 && (
        <div className="detail-section">
          <h4>Related</h4>
          <div className="related-list">
            {item.related_to.map((id) => (
              <span
                key={id}
                className="related-id"
                onClick={() => onNavigate(id)}
              >
                {id}
              </span>
            ))}
          </div>
        </div>
      )}

      {item.supersedes && (
        <div className="detail-section">
          <h4>Supersedes</h4>
          <span
            className="related-id"
            onClick={() => onNavigate(item.supersedes!)}
          >
            {item.supersedes}
          </span>
        </div>
      )}

      {item.superseded_by && (
        <div className="detail-section">
          <h4>Superseded By</h4>
          <span
            className="related-id"
            onClick={() => onNavigate(item.superseded_by!)}
          >
            {item.superseded_by}
          </span>
        </div>
      )}
    </div>
  );
}

function ReuseView({
  projects,
  onNavigate,
}: {
  projects: string[];
  onNavigate: (id: string) => void;
}) {
  const [report, setReport] = useState<ReuseReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [since, setSince] = useState<ReuseSince>("7d");
  const [projectFilter, setProjectFilter] = useState<string>("");
  const [minAgeInput, setMinAgeInput] = useState<string>("");

  useEffect(() => {
    setLoading(true);
    setError(null);
    const minAge = minAgeInput.trim() === "" ? undefined : Number(minAgeInput);
    const params = {
      since,
      project: projectFilter || undefined,
      min_age_days: minAge !== undefined && !Number.isNaN(minAge) ? minAge : undefined,
    };
    getReuseReport(params)
      .then((r) => {
        setReport(r);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, [since, projectFilter, minAgeInput]);

  const sinceLabel =
    since === "7d" ? "最近 7 天" : since === "30d" ? "最近 30 天" : "全量";

  return (
    <div className="reuse-view">
      <section className="reuse-toolbar">
        <div className="reuse-toolbar-group">
          <span className="reuse-toolbar-label">时间窗</span>
          <div className="reuse-toggle">
            {(["7d", "30d", "all"] as ReuseSince[]).map((opt) => (
              <button
                key={opt}
                type="button"
                className={`reuse-toggle-btn ${since === opt ? "active" : ""}`}
                onClick={() => setSince(opt)}
              >
                {opt === "7d" ? "最近 7 天" : opt === "30d" ? "最近 30 天" : "全量"}
              </button>
            ))}
          </div>
        </div>
        <div className="reuse-toolbar-group">
          <span className="reuse-toolbar-label">项目</span>
          <select
            className="reuse-select"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
          >
            <option value="">全部项目</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className="reuse-toolbar-group">
          <span
            className="reuse-toolbar-label"
            title="Only filters the 'Never accessed' list — items younger than N days are excluded"
          >
            min age (days)
          </span>
          <input
            type="number"
            min={0}
            className="reuse-input"
            placeholder="0"
            value={minAgeInput}
            onChange={(e) => setMinAgeInput(e.target.value)}
          />
        </div>
        <div className="reuse-toolbar-spacer" />
        <span className="reuse-toolbar-status">
          {loading ? "Loading…" : `Window: ${sinceLabel}`}
        </span>
      </section>

      {error ? (
        <div className="reuse-error">
          <div className="title">Failed to load reuse report</div>
          <div>{error}</div>
        </div>
      ) : !report ? (
        <div className="reuse-loading">Loading reuse report…</div>
      ) : (
        <>
          <section className="reuse-cards">
            <MetricCard
              label="Total queries"
              value={report.total_queries.toString()}
              hint="raw query events in window"
            />
            <MetricCard
              label="Hit rate"
              value={formatPct(report.hit_rate)}
              hint="queries with ≥1 result / total queries"
            />
            <MetricCard
              label="Total views"
              value={report.total_views.toString()}
              hint="raw view events (get_knowledge opens)"
            />
            <MetricCard
              label="Feedback coverage"
              value={formatPct(report.feedback_coverage)}
              hint="per (owner, item) pair — of viewed pairs, how many have feedback"
            />
            <MetricCard
              label="North star"
              value={formatPct(report.north_star_pct)}
              hint={`${report.north_star_count} items viewed or marked useful by 2+ distinct owners`}
              highlight
            />
            <MetricCard
              label="Never accessed"
              value={formatPct(report.never_accessed_pct)}
              hint={`${Math.round(report.never_accessed_pct * report.total_items)} of ${report.total_items} items have no exposure, view, or feedback (baseline, ignores min age filter)`}
            />
          </section>

          <section className="reuse-section">
            <h2>Top reused items</h2>
            {report.top_reused.length === 0 ? (
              <div className="reuse-empty">
                No items have been viewed or received feedback yet.
              </div>
            ) : (
              <div className="reuse-table">
                <div className="reuse-table-head">
                  <span className="reuse-col-rank">#</span>
                  <span className="reuse-col-claim">Claim</span>
                  <span className="reuse-col-num">Views</span>
                  <span className="reuse-col-num">Owners</span>
                  <span className="reuse-col-feedback">Feedback</span>
                </div>
                {report.top_reused.map((item, idx) => (
                  <div
                    key={item.knowledge_id}
                    className="reuse-row"
                    onClick={() => onNavigate(item.knowledge_id)}
                  >
                    <span className="reuse-col-rank">{idx + 1}</span>
                    <span className="reuse-col-claim">{item.claim}</span>
                    <span className="reuse-col-num">{item.view_count}</span>
                    <span className="reuse-col-num">{item.unique_owners}</span>
                    <span className="reuse-col-feedback">
                      {item.useful_feedback_count > 0 && (
                        <span className="feedback-pill useful">
                          {item.useful_feedback_count} useful
                        </span>
                      )}
                      {item.not_useful_feedback_count > 0 && (
                        <span className="feedback-pill not-useful">
                          {item.not_useful_feedback_count} not useful
                        </span>
                      )}
                      {item.outdated_feedback_count > 0 && (
                        <span className="feedback-pill outdated">
                          {item.outdated_feedback_count} outdated
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="reuse-section">
            <h2>Top 0-hit keywords</h2>
            <p className="reuse-section-hint">
              Queries that returned no results — deduped by normalized key
              (trim + lowercase + collapse whitespace). Candidates for new
              knowledge or better tagging.
            </p>
            {report.top_0hit_keywords.length === 0 ? (
              <div className="reuse-empty">
                No 0-hit queries in this window.
              </div>
            ) : (
              <div className="reuse-zero-list">
                {report.top_0hit_keywords.map((kw) => (
                  <div key={kw.normalized_key} className="reuse-zero-row">
                    <span className="reuse-zero-example">{kw.example_text}</span>
                    <span className="reuse-zero-count">
                      {kw.query_count}×
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="reuse-section">
            <h2>Never accessed</h2>
            <p className="reuse-section-hint">
              Items with no exposure, view, or feedback. Candidates for better
              tagging, consolidation, or retirement.
              {minAgeInput.trim() !== "" && !Number.isNaN(Number(minAgeInput)) && (
                <> Filtered to items older than {minAgeInput} day(s).</>
              )}
            </p>
            {report.never_accessed.length === 0 ? (
              <div className="reuse-empty">
                Every knowledge item has been touched at least once.
              </div>
            ) : (
              <ul className="reuse-never-list">
                {report.never_accessed.map((item) => (
                  <li
                    key={item.id}
                    className="reuse-never-row"
                    onClick={() => onNavigate(item.id)}
                  >
                    {item.claim}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function MetricCard({
  label,
  value,
  hint,
  highlight,
}: {
  label: string;
  value: string;
  hint: string;
  highlight?: boolean;
}) {
  return (
    <div className={`metric-card ${highlight ? "highlight" : ""}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      <div className="metric-hint">{hint}</div>
    </div>
  );
}

function formatPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default App;

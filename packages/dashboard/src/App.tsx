import { useState, useEffect, useCallback } from "react";
import type { KnowledgeItem, KnowledgeListItem } from "./types";
import {
  listKnowledge,
  searchKnowledge,
  getKnowledge,
  getAllFilters,
  getApiKey,
  setApiKey,
} from "./api";
import "./App.css";

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
        <span className="stats">
          {total} knowledge item{total !== 1 ? "s" : ""}
        </span>
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

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default App;

import { useState, useEffect, useCallback } from "react";
import type { KnowledgeItem, KnowledgeListItem } from "./types";
import {
  listKnowledge,
  searchKnowledge,
  getKnowledge,
  getAllFilters,
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
      </header>

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
                  }`}
                  onClick={() => selectItem(item.id)}
                >
                  <div className="claim">{item.claim}</div>
                  <div className="meta">
                    <span className={`confidence ${item.confidence}`}>
                      {item.confidence}
                    </span>
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
      <h2>{item.claim}</h2>

      {item.detail && (
        <div className="detail-section">
          <h4>Detail</h4>
          <pre><code>{item.detail}</code></pre>
        </div>
      )}

      <div className="detail-section">
        <div className="detail-meta">
          <div className="detail-meta-item">
            <span className="label">Confidence</span>
            <span className={`confidence ${item.confidence}`}>
              {item.confidence}
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

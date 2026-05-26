// @ts-nocheck
// Command Center — a ⌘K palette in the terminal/CLI vocabulary of DevAsign.
// Opens from the topbar search button or ⌘K / Ctrl+K.
import React from "react";
import { Icon } from "./icons";

const CC_NAV = [
  { key: "agent",     label: "Agent",     icon: "agent",     kbd: "g a" },
  { key: "settings",  label: "Settings",  icon: "settings",  kbd: "g s" },
];

const CC_PRS = [
  { id: "#482",  repo: "acme/pay",   title: "feat(withdraw): add Base + Optimism routes", author: "lina",  state: "review" },
  { id: "#1142", repo: "acme/admin", title: "rbac: role inheritance & audit hooks",       author: "tomek", state: "ok" },
];

const CC_ACTIONS = [
  { key: "invite-dev",   label: "Invite developer",     icon: "user",   kbd: "c i" },
];

// Build a flat, ordered list of palette items
const buildItems = ({ onNavigate, onClose }) => {
  const items = [];

  // 1. Ask agent — top, always present
  items.push({
    id: "ask-agent",
    group: "ask",
    label: null,           // rendered specially
    keywords: "ask agent help ai claude question",
    run: (query) => { onNavigate("agent"); onClose(); }
  });

  return items;
};

const GROUP_LABEL = {
  ask:      "ask agent",
  navigate: "navigate",
  prs:      "pull requests",
  actions:  "actions",
};

// Simple substring + token match. Cheap, predictable, no fuzzy surprises.
const filterItems = (items, q) => {
  if (!q.trim()) return items;
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(it => {
    const hay = (it.keywords || "").toLowerCase();
    return tokens.every(t => hay.includes(t));
  });
};

const flagPill = (flag) => {
  const map = {
    blocker: { cls: "danger", text: "blocker" },
    review:  { cls: "warn",   text: "in review" },
    open:    { cls: "info",   text: "open" },
    ok:      { cls: "ok",     text: "ready" },
    draft:   { cls: "",       text: "draft" },
  };
  const m = map[flag];
  if (!m) return null;
  return <span className={`pill ${m.cls}`}><i className="dot"></i>{m.text}</span>;
};

const CommandCenter = ({ open, onClose, onNavigate, initialQuery = "" }) => {
  const [q, setQ] = React.useState(initialQuery);
  const [sel, setSel] = React.useState(0);
  const inputRef = React.useRef(null);
  const listRef = React.useRef(null);

  const allItems = React.useMemo(
    () => buildItems({ onNavigate, onClose }),
    [onNavigate, onClose]
  );

  const filtered = React.useMemo(() => filterItems(allItems, q), [q, allItems]);

  // Reset selection + query when opening
  React.useEffect(() => {
    if (open) {
      setQ(initialQuery || "");
      setSel(0);
      // focus after paint
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, initialQuery]);

  React.useEffect(() => { setSel(0); }, [q]);

  // Scroll selected into view inside the list (no scrollIntoView — manual)
  React.useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const node = list.querySelector(`[data-cc-idx="${sel}"]`);
    if (!node) return;
    const lr = list.getBoundingClientRect();
    const nr = node.getBoundingClientRect();
    if (nr.top < lr.top + 8)      list.scrollTop += nr.top - lr.top - 8;
    else if (nr.bottom > lr.bottom - 8) list.scrollTop += nr.bottom - lr.bottom + 8;
  }, [sel, open, filtered.length]);

  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel(s => Math.min(s + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel(s => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = filtered[sel];
      if (it) it.run(q);
    }
  };

  if (!open) return null;

  // Group filtered items in order they appear; preserve group order.
  const groupOrder = ["ask"];
  const grouped = groupOrder
    .map(g => ({ group: g, items: filtered.filter(it => it.group === g) }))
    .filter(g => g.items.length > 0);

  // Build index map so arrow nav across groups still works on the flat list
  let runningIdx = -1;
  const indexed = grouped.map(g => ({
    ...g,
    items: g.items.map(it => { runningIdx++; return { ...it, _idx: runningIdx }; })
  }));

  return (
    <div className="cc-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cc-panel" role="dialog" aria-label="Command Center" onKeyDown={onKey}>
        {/* Header */}
        <div className="cc-head">
          <span className="cc-prompt">›</span>
          <input
            ref={inputRef}
            className="cc-input"
            placeholder="Search commands, bounties, PRs, repos…"
            value={q}
            onChange={e => setQ(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          {q && (
            <button className="cc-clear" onClick={() => { setQ(""); inputRef.current?.focus(); }}>
              <Icon name="x" size={11} />
            </button>
          )}
          <span className="cc-kbd-hint">esc</span>
        </div>

        {/* Results */}
        <div className="cc-results" ref={listRef}>
          {indexed.length === 0 && (
            <div className="cc-empty">
              <div className="mono dim">no results for "<span style={{ color: "var(--fg)" }}>{q}</span>"</div>
              <div className="mono faint" style={{ marginTop: 6, fontSize: 11 }}>
                press <span className="cc-mini-kbd">↵</span> to ask the agent instead
              </div>
            </div>
          )}

          {indexed.map(g => (
            <div className="cc-group" key={g.group}>
              <div className="cc-group-label">{GROUP_LABEL[g.group]}</div>

              {g.group === "ask" && g.items.map(it => (
                <div key={it.id}
                     data-cc-idx={it._idx}
                     className={`cc-row cc-ask ${sel === it._idx ? "picked" : ""}`}
                     onMouseEnter={() => setSel(it._idx)}
                     onClick={() => it.run(q)}>
                  <span className="cc-row-icon ask"><Icon name="spark" size={13} /></span>
                  <div className="cc-row-main">
                    <div className="cc-ask-q">
                      {q ? <>Ask agent: <span className="cc-ask-text">"{q}"</span></>
                         : <>Ask the agent anything <span className="faint mono" style={{ fontSize: 11 }}>— draft, triage, explain a PR…</span></>}
                    </div>
                  </div>
                </div>
              ))}

              {g.group === "navigate" && g.items.map(it => (
                <div key={it.id}
                     data-cc-idx={it._idx}
                     className={`cc-row ${sel === it._idx ? "picked" : ""}`}
                     onMouseEnter={() => setSel(it._idx)}
                     onClick={() => it.run(q)}>
                  <span className="cc-row-icon"><Icon name={it.icon} size={13} /></span>
                  <div className="cc-row-main"><div className="cc-row-title">{it.label}</div></div>
                  <span className="cc-row-kbd">{it.kbd}</span>
                </div>
              ))}

              {g.group === "prs" && g.items.map(it => (
                <div key={it.id}
                     data-cc-idx={it._idx}
                     className={`cc-row ${sel === it._idx ? "picked" : ""}`}
                     onMouseEnter={() => setSel(it._idx)}
                     onClick={() => it.run(q)}>
                  <span className="cc-row-icon"><Icon name="git" size={13} /></span>
                  <span className="cc-ref mono">{it.ref}</span>
                  <div className="cc-row-main">
                    <div className="cc-row-title">{it.label}</div>
                    <div className="cc-row-sub mono faint">@{it.author}</div>
                  </div>
                  {flagPill(it.state)}
                </div>
              ))}

              {g.group === "actions" && g.items.map(it => (
                <div key={it.id}
                     data-cc-idx={it._idx}
                     className={`cc-row ${sel === it._idx ? "picked" : ""}`}
                     onMouseEnter={() => setSel(it._idx)}
                     onClick={() => it.run(q)}>
                  <span className="cc-row-icon"><Icon name={it.icon} size={13} /></span>
                  <div className="cc-row-main"><div className="cc-row-title">{it.label}</div></div>
                  <span className="cc-row-kbd">{it.kbd}</span>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="cc-foot">
          <div className="cc-foot-keys">
            <span><span className="cc-mini-kbd">↑</span><span className="cc-mini-kbd">↓</span> navigate</span>
            <span><span className="cc-mini-kbd">↵</span> select</span>
            <span><span className="cc-mini-kbd">esc</span> close</span>
          </div>
          <div className="cc-foot-meta mono faint">
            {filtered.length} {filtered.length === 1 ? "result" : "results"}
          </div>
        </div>
      </div>
    </div>
  );
};

export { CommandCenter };

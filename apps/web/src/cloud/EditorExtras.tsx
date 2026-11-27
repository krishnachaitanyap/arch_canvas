import { useEffect, useMemo, useRef, useState } from "react";
import { catalogEntry, type DiagramModel, detectSource, importSource, pageOf, pagesOf, SOURCE_NAMES, type SourceKind } from "@archcanvas/shared";

/** An item that matches the search: shapes, groups and notes by name, lines by label. */
export interface FindHit {
  type: "node" | "edge";
  id: string;
  page: string;
  text: string;
}

export function findHits(m: DiagramModel, query: string, opts: { caseSensitive?: boolean } = {}): FindHit[] {
  const q = opts.caseSensitive ? query : query.toLowerCase();
  if (!q) return [];
  const has = (s: string | undefined) => Boolean(s) && (opts.caseSensitive ? s! : s!.toLowerCase()).includes(q);
  const hits: FindHit[] = [];
  for (const n of m.nodes)
    if (has(n.label) || has(n.id) || has(catalogEntry(n.kind)?.label)) hits.push({ type: "node", id: n.id, page: pageOf(m, n.id), text: n.label || n.id });
  for (const e of m.edges) if (has(e.label)) hits.push({ type: "edge", id: e.id, page: pageOf(m, e.from), text: e.label! });
  // Tabs in order, so stepping through goes tab by tab.
  const order = new Map(pagesOf(m).map((p, i) => [p.id, i]));
  return hits.sort((a, b) => order.get(a.page)! - order.get(b.page)!);
}

/** Replaces text in names and line labels across every tab. Returns the new model and how many changed. */
export function replaceAll(m: DiagramModel, query: string, replacement: string, caseSensitive = false): { model: DiagramModel; count: number } {
  if (!query) return { model: m, count: 0 };
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi");
  let count = 0;
  const swap = (s: string, max: number) => {
    const out = s.replace(re, () => replacement).slice(0, max);
    if (out !== s) count++;
    return out;
  };
  const nodes = m.nodes.map((n) => {
    const label = swap(n.label, 500);
    return label === n.label ? n : { ...n, label };
  });
  const edges = m.edges.map((e) => {
    if (!e.label) return e;
    const label = swap(e.label, 60);
    return label === e.label ? e : { ...e, label };
  });
  return { model: { ...m, nodes, edges }, count };
}

/** Find (⌘F) and replace (⌘⌥F / ⌘H) over the canvas, across tabs. */
export function FindBar({
  model,
  readOnly,
  replace: startWithReplace,
  onGo,
  onReplaceAll,
  onClose,
}: {
  model: DiagramModel;
  readOnly: boolean;
  replace: boolean;
  onGo: (hit: FindHit) => void;
  onReplaceAll: (m: DiagramModel, count: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [showReplace, setShowReplace] = useState(startWithReplace);
  const [index, setIndex] = useState(0);
  /** Enter shows the first result, then steps through the rest. */
  const [went, setWent] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => findHits(model, query, { caseSensitive }), [model, query, caseSensitive]);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setShowReplace((r) => r || startWithReplace), [startWithReplace]);
  useEffect(() => {
    setIndex(0);
    setWent(false);
  }, [query, caseSensitive]);

  const go = (i: number) => {
    if (!hits.length) return;
    const k = ((i % hits.length) + hits.length) % hits.length;
    setIndex(k);
    setWent(true);
    onGo(hits[k]);
  };

  return (
    <div className="find-bar" role="search" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())}>
      <div className="find-row">
        <button className="find-toggle" title={showReplace ? "Hide replace" : "Replace"} onClick={() => setShowReplace(!showReplace)} disabled={readOnly}>
          {showReplace ? "▾" : "▸"}
        </button>
        <input
          ref={input}
          value={query}
          placeholder="Find on the canvas"
          aria-label="Find"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              go(e.shiftKey ? index - 1 : went ? index + 1 : index);
              setWent(true);
            }
          }}
        />
        <span className="find-count">{query ? (hits.length ? `${index + 1} of ${hits.length}` : "No results") : ""}</span>
        <button className={caseSensitive ? "on" : ""} title="Match case" onClick={() => setCaseSensitive(!caseSensitive)}>
          Aa
        </button>
        <button title="Previous (⇧Enter)" disabled={!hits.length} onClick={() => go(index - 1)}>
          ↑
        </button>
        <button title="Next (Enter)" disabled={!hits.length} onClick={() => go(index + 1)}>
          ↓
        </button>
        <button title="Close (Esc)" onClick={onClose}>
          ✕
        </button>
      </div>
      {showReplace && !readOnly && (
        <div className="find-row">
          <span className="find-toggle" />
          <input value={replacement} placeholder="Replace with" aria-label="Replace with" onChange={(e) => setReplacement(e.target.value)} />
          <button
            disabled={!query || !hits.length}
            onClick={() => {
              const r = replaceAll(model, query, replacement, caseSensitive);
              onReplaceAll(r.model, r.count);
            }}
          >
            Replace all
          </button>
        </div>
      )}
      {query && hits.length > 0 && (
        <ul className="find-list">
          {hits.slice(0, 30).map((h, i) => (
            <li key={`${h.type}:${h.id}`}>
              <button className={i === index ? "on" : ""} onClick={() => go(i)}>
                <span className="find-kind">{h.type === "edge" ? "line" : "item"}</span> {h.text}
                {pagesOf(model).length > 1 && <span className="hint"> · {pagesOf(model).find((p) => p.id === h.page)?.name}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const SHORTCUTS: [string, [string, string][]][] = [
  [
    "Editing",
    [
      ["⌘Z / ⇧⌘Z", "Undo / redo"],
      ["⌘C ⌘X ⌘V", "Copy, cut, paste"],
      ["⌘D", "Duplicate"],
      ["⌫ / Delete", "Delete the selection"],
      ["F2 or double-click", "Edit a name or a line's label"],
      ["Enter / ⇧Enter", "Finish editing / new line"],
      ["⌘L", "Lock or unlock the selection"],
      ["⌘S", "Save a version"],
    ],
  ],
  [
    "Selecting and moving",
    [
      ["⌘A", "Select everything on this tab"],
      ["Shift-click, drag a box", "Add to the selection"],
      ["Arrow keys (⇧ for 10px)", "Nudge the selection"],
      ["Esc", "Clear the selection, close menus"],
      ["Right-click", "Menu for an item, line or the canvas"],
    ],
  ],
  [
    "Finding and viewing",
    [
      ["⌘F", "Find on the canvas"],
      ["⌥⌘F", "Find and replace"],
      ["Scroll / pinch", "Pan / zoom"],
      ["?", "This list"],
    ],
  ],
];

/** Keyboard shortcuts help (press ?). */
export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const keys = (s: string) => (mac ? s : s.replace(/⌘/g, "Ctrl+").replace(/⌥/g, "Alt+").replace(/⇧/g, "Shift+"));
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal shortcuts" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Keyboard shortcuts</h3>
          <button onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="shortcut-cols">
          {SHORTCUTS.map(([title, rows]) => (
            <section key={title}>
              <h4>{title}</h4>
              <dl>
                {rows.map(([k, what]) => (
                  <div key={k}>
                    <dt>
                      <kbd>{keys(k)}</kbd>
                    </dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Import into this canvas: a draw.io file, or infrastructure code (Terraform, Kubernetes,
 * docker-compose) or a SQL schema, from a file or pasted.
 */
export function ImportCodeDialog({
  onDrawio,
  onModel,
  onClose,
}: {
  onDrawio: (file: File) => void;
  onModel: (m: DiagramModel, source: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [name, setName] = useState("pasted");
  const [kind, setKind] = useState<SourceKind | "auto">("auto");
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const detected = text.trim() ? detectSource(name, text) : null;

  function run(src: string, fileName: string, k: SourceKind | "auto" = kind) {
    try {
      const m = importSource(fileName, src, k === "auto" ? detectSource(fileName, src) : k);
      if (!m.nodes.length) throw new Error("Nothing to draw was found");
      onModel(m, `${fileName === "pasted" ? "the pasted" : fileName} ${SOURCE_NAMES[(k === "auto" ? detectSource(fileName, src) : k)!]}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function pick(f: File) {
    if (/\.(drawio|xml|svg)$/i.test(f.name)) return onDrawio(f);
    const src = await f.text();
    setText(src);
    setName(f.name);
    setError(null);
    run(src, f.name, "auto");
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide import-code" role="dialog" aria-label="Import" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Import into this canvas</h2>
          <button className="link" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div
          className="import-drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) void pick(f);
          }}
        >
          <button className="primary" onClick={() => file.current?.click()}>
            Choose a file…
          </button>
          <span className="hint">
            or drop one here: draw.io (<code>.drawio</code>), diagram code (<code>.arch</code>), Terraform (<code>.tf</code>), Kubernetes or docker-compose (<code>.yaml</code>), SQL schema (<code>.sql</code>)
          </span>
          <input
            ref={file}
            type="file"
            hidden
            accept=".drawio,.xml,.svg,.arch,.tf,.yaml,.yml,.sql,.txt"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pick(f);
              e.target.value = "";
            }}
          />
        </div>
        <label className="hint">Or paste code</label>
        <textarea
          className="import-text"
          value={text}
          spellCheck={false}
          placeholder={'resource "google_cloud_run_v2_service" "api" { … }\n\nservices:\n  web:\n    image: nginx\n\nCREATE TABLE customers (id uuid PRIMARY KEY, …);'}
          onChange={(e) => {
            setText(e.target.value);
            setName("pasted");
            setError(null);
          }}
        />
        <div className="row import-actions">
          <select value={kind} onChange={(e) => setKind(e.target.value as SourceKind | "auto")} aria-label="Type">
            <option value="auto">{detected ? `Detected: ${SOURCE_NAMES[detected]}` : "Detect the type"}</option>
            {(Object.keys(SOURCE_NAMES) as SourceKind[]).map((k) => (
              <option key={k} value={k}>
                {SOURCE_NAMES[k]}
              </option>
            ))}
          </select>
          <div className="spacer" />
          {error && <span className="import-error">{error}</span>}
          <button className="primary" disabled={!text.trim()} onClick={() => run(text, name)}>
            Import
          </button>
        </div>
      </div>
    </div>
  );
}

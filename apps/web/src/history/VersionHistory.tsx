import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type DiagramKind, type DiagramSummary, type Version, type VersionSummary } from "../api";
import { formatTime } from "../util";
import { Compare, type Snapshot } from "./Compare";
import { askConfirm } from "../dialogs";

/** What the open editor currently holds (possibly unsaved). */
export interface CurrentState {
  kind: DiagramKind;
  model: Snapshot["model"];
  source: string;
  elementCount?: number;
  dirty: boolean;
}

type Side = { type: "version"; version: number } | { type: "current" } | { type: "diagram"; id: string; title: string };

const sideKey = (s: Side) => (s.type === "version" ? `v:${s.version}` : s.type === "diagram" ? `d:${s.id}` : "current");

export function VersionHistory({
  diagramId,
  title,
  canEdit,
  getCurrent,
  onRestored,
  onDuplicated,
  onClose,
  setStatus,
}: {
  diagramId: string;
  title: string;
  canEdit: boolean;
  getCurrent: () => CurrentState | null;
  onRestored: () => void;
  onDuplicated: (newId: string) => void;
  onClose: () => void;
  setStatus: (s: { kind: "ok" | "error"; text: string } | null) => void;
}) {
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [others, setOthers] = useState<(DiagramSummary & { project_name?: string })[]>([]);
  const [a, setA] = useState<Side | null>(null);
  const [b, setB] = useState<Side>({ type: "current" });
  const [snaps, setSnaps] = useState<Record<string, Snapshot>>({});
  const [naming, setNaming] = useState<number | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const current = useMemo(getCurrent, [getCurrent]);

  const load = useCallback(async () => {
    const vs = await api.versions(diagramId);
    setVersions(vs);
    return vs;
  }, [diagramId]);

  useEffect(() => {
    void load().then((vs) => {
      // Default: what changed since the last saved version (or between the last two if nothing is unsaved).
      if (current?.dirty || vs.length < 2) setA(vs[0] ? { type: "version", version: vs[0].version } : null);
      else {
        setA({ type: "version", version: vs[1].version });
        setB({ type: "version", version: vs[0].version });
      }
    }, (e) => setStatus({ kind: "error", text: (e as Error).message }));
    api.listDiagrams().then((ds) => setOthers(ds.filter((d) => d.id !== diagramId)), () => setOthers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagramId]);

  // Fetch the content for whichever sides are selected.
  useEffect(() => {
    for (const side of [a, b]) {
      if (!side || snaps[sideKey(side)]) continue;
      const key = sideKey(side);
      if (side.type === "current") {
        if (current)
          setSnaps((s) => ({
            ...s,
            [key]: { label: current.dirty ? "Current (unsaved)" : "Current", kind: current.kind, model: current.model, source: current.source, elementCount: current.elementCount },
          }));
        // Opened straight from a link (no editor yet): the latest content, autosaved edits included.
        else
          void api.getDiagram(diagramId).then(
            (d) => setSnaps((s) => ({ ...s, [key]: { label: "Current", kind: d.kind, model: d.model, source: d.source, elementCount: d.scene.elements?.length } })),
            (e) => setStatus({ kind: "error", text: (e as Error).message }),
          );
      } else if (side.type === "version") {
        void api.version(diagramId, side.version).then(
          (v) => setSnaps((s) => ({ ...s, [key]: fromVersion(v, `v${v.version}${v.name ? ` · ${v.name}` : ""}`) })),
          (e) => setStatus({ kind: "error", text: (e as Error).message }),
        );
      } else {
        void api.getDiagram(side.id).then(
          (d) =>
            setSnaps((s) => ({
              ...s,
              [key]: { label: `${d.title} (v${d.version ?? 1})`, kind: d.kind, model: d.model, source: d.source, elementCount: d.scene.elements?.length },
            })),
          (e) => setStatus({ kind: "error", text: (e as Error).message }),
        );
      }
    }
  }, [a, b, snaps, current, diagramId, setStatus]);

  async function restore(v: VersionSummary) {
    const unsaved = current?.dirty ? " Your unsaved changes in the editor will be discarded." : "";
    if (!(await askConfirm({ title: `Restore v${v.version}?`, message: `It becomes the current content as a new version; nothing in the history is lost.${unsaved}`, confirm: "Restore" }))) return;
    try {
      const d = await api.restoreVersion(diagramId, v.version);
      setStatus({ kind: "ok", text: `Restored v${v.version} as v${d.version}` });
      onRestored();
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    }
  }

  async function duplicate(v: VersionSummary) {
    try {
      const d = await api.duplicateDiagram(diagramId, { version: v.version });
      setStatus({ kind: "ok", text: `Created "${d.title}"` });
      onDuplicated(d.id);
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    }
  }

  async function saveName(version: number) {
    try {
      await api.nameVersion(diagramId, version, nameDraft);
      setNaming(null);
      setSnaps((s) => {
        const copy = { ...s };
        delete copy[`v:${version}`];
        return copy;
      });
      await load();
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    }
  }

  const sa = a ? snaps[sideKey(a)] : undefined;
  const sb = snaps[sideKey(b)];

  return (
    <div className="history" role="dialog" aria-label="Version history">
      <div className="history-head">
        <h2>History · {title}</h2>
        <div className="spacer" />
        <label className="pick">
          Compare
          <SidePicker value={a} onChange={setA} versions={versions ?? []} others={others} hasCurrent={Boolean(current)} />
        </label>
        <button className="link" title="Swap sides" onClick={() => a && (setA(b), setB(a))}>
          ⇄
        </button>
        <label className="pick">
          with
          <SidePicker value={b} onChange={(s) => s && setB(s)} versions={versions ?? []} others={others} hasCurrent={Boolean(current)} />
        </label>
        <button onClick={onClose}>Close</button>
      </div>

      <div className="history-body">
        <ul className="version-list">
          {current && (
            <li className={b.type === "current" ? "selected" : ""}>
              <div className="v-title">
                Current{current.dirty && <span className="unsaved"> · unsaved changes</span>}
              </div>
              <div className="v-actions">
                {versions?.[0] && (
                  <button className="link" onClick={() => (setA({ type: "version", version: versions[0].version }), setB({ type: "current" }))}>
                    Compare with v{versions[0].version}
                  </button>
                )}
              </div>
            </li>
          )}
          {(versions ?? []).map((v, i) => (
            <li key={v.version} className={(b.type === "version" && b.version === v.version) || (a?.type === "version" && a.version === v.version) ? "selected" : ""}>
              {naming === v.version ? (
                <form
                  className="row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveName(v.version);
                  }}
                >
                  <input autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} placeholder="e.g. Approved design" aria-label="Version name" />
                  <button className="primary">Save</button>
                  <button type="button" onClick={() => setNaming(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <div className="v-title">
                  <b>v{v.version}</b> {v.name && <span className="v-name">{v.name}</span>}
                </div>
              )}
              <div className="hint">
                {formatTime(v.created_at)} · {v.created_by ?? "unknown"}
                {v.node_count !== null && ` · ${v.node_count} resources, ${v.edge_count} connections`}
                {v.restored_from && ` · restored from v${v.restored_from}`}
              </div>
              <div className="v-actions">
                {versions![i + 1] && (
                  <button className="link" onClick={() => (setA({ type: "version", version: versions![i + 1].version }), setB({ type: "version", version: v.version }))}>
                    Changes in this version
                  </button>
                )}
                {current && (
                  <button className="link" onClick={() => (setA({ type: "version", version: v.version }), setB({ type: "current" }))}>
                    Compare with current
                  </button>
                )}
                {canEdit && (
                  <button className="link" onClick={() => (setNaming(v.version), setNameDraft(v.name ?? ""))}>
                    {v.name ? "Rename" : "Name"}
                  </button>
                )}
                {canEdit && i > 0 && (
                  <button className="link" onClick={() => void restore(v)}>
                    Restore
                  </button>
                )}
                {canEdit && (
                  <button className="link" onClick={() => void duplicate(v)}>
                    Copy as new diagram
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>

        <div className="history-compare">
          {!a ? (
            <p className="hint pad">Pick a version to compare.</p>
          ) : sa && sb ? (
            <Compare key={`${sideKey(a)}|${sideKey(b)}`} a={sa} b={sb} />
          ) : (
            <p className="hint pad">Loading…</p>
          )}
        </div>
      </div>
    </div>
  );
}

function SidePicker({
  value,
  onChange,
  versions,
  others,
  hasCurrent,
}: {
  value: Side | null;
  onChange: (s: Side | null) => void;
  versions: VersionSummary[];
  others: (DiagramSummary & { project_name?: string })[];
  hasCurrent: boolean;
}) {
  return (
    <select
      value={value ? sideKey(value) : ""}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "current") onChange({ type: "current" });
        else if (v.startsWith("v:")) onChange({ type: "version", version: Number(v.slice(2)) });
        else if (v.startsWith("d:")) {
          const d = others.find((o) => o.id === v.slice(2));
          if (d) onChange({ type: "diagram", id: d.id, title: d.title });
        }
      }}
    >
      {!value && <option value="">Choose…</option>}
      {hasCurrent && <option value="current">Current</option>}
      <optgroup label="Versions">
        {versions.map((v) => (
          <option key={v.version} value={`v:${v.version}`}>
            v{v.version}
            {v.name ? ` · ${v.name}` : ""}
          </option>
        ))}
      </optgroup>
      {others.length > 0 && (
        <optgroup label="Other diagrams (latest)">
          {others.map((d) => (
            <option key={d.id} value={`d:${d.id}`}>
              {d.title}
              {d.project_name ? ` — ${d.project_name}` : ""}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

function fromVersion(v: Version, label: string): Snapshot {
  return { label, kind: v.kind, model: v.model, source: v.source, elementCount: v.scene.elements?.length };
}

import { useMemo, useState } from "react";
import { type DiagramModel, describeChanges, type DiffLine, emptyModel, hunks, lineDiff, terraformDiff, toCode, toMermaid } from "@archcanvas/shared";
import { DiffCanvas } from "../cloud/DiffCanvas";

/** One side of a comparison: a saved version, the editor's current state, or another diagram. */
export interface Snapshot {
  label: string;
  kind: "cloud" | "whiteboard";
  model: DiagramModel | null;
  source: string;
  elementCount?: number;
}

type Tab = "visual" | "changes" | "terraform" | "code" | "mermaid";

export function Compare({ a, b }: { a: Snapshot; b: Snapshot }) {
  const cloud = a.kind === "cloud" && b.kind === "cloud";
  const [tab, setTab] = useState<Tab>(cloud ? "visual" : "code");
  const [focus, setFocus] = useState<string | null>(null);
  const ma = a.model ?? emptyModel();
  const mb = b.model ?? emptyModel();
  const changes = useMemo(() => (cloud ? describeChanges(ma, mb) : []), [cloud, ma, mb]);
  const tf = useMemo(() => (cloud && tab === "terraform" ? terraformDiff(ma, mb) : null), [cloud, tab, ma, mb]);
  // Cloud diagrams compare as diagram code (what changed, like a code review), and as Mermaid
  // for pasting into reviews elsewhere.
  const code = useMemo(() => {
    if (tab === "code") return cloud ? lineDiff(toCode(ma), toCode(mb)) : lineDiff(a.source, b.source);
    if (tab === "mermaid" && cloud) return lineDiff(toMermaid(ma), toMermaid(mb));
    return [];
  }, [tab, cloud, ma, mb, a.source, b.source]);

  const counts = {
    added: changes.filter((c) => c.change === "added").length,
    changed: changes.filter((c) => c.change === "changed").length,
    removed: changes.filter((c) => c.change === "removed").length,
  };

  return (
    <div className="compare">
      <div className="compare-head">
        <span className="side a">{a.label}</span>
        <span className="arrow">→</span>
        <span className="side b">{b.label}</span>
        <div className="spacer" />
        {cloud ? (
          <span className="hint">
            <b className="add">+{counts.added}</b> <b className="chg">~{counts.changed}</b> <b className="del">−{counts.removed}</b>
          </span>
        ) : (
          a.elementCount !== undefined &&
          b.elementCount !== undefined && (
            <span className="hint">
              Canvas elements: {a.elementCount} → {b.elementCount}
            </span>
          )
        )}
      </div>
      <div className="tabs small left">
        {cloud && (
          <>
            <button className={tab === "visual" ? "active" : ""} onClick={() => setTab("visual")}>
              Visual
            </button>
            <button className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>
              Changes ({changes.length})
            </button>
            <button className={tab === "terraform" ? "active" : ""} onClick={() => setTab("terraform")}>
              Terraform
            </button>
          </>
        )}
        <button className={tab === "code" ? "active" : ""} onClick={() => setTab("code")}>
          Diagram code
        </button>
        {cloud && (
          <button className={tab === "mermaid" ? "active" : ""} onClick={() => setTab("mermaid")}>
            Mermaid
          </button>
        )}
      </div>

      <div className="compare-body">
        {tab === "visual" && cloud && (
          <div className="visual">
            <DiffCanvas before={ma} after={mb} focus={focus} />
            <ChangeList changes={changes} onFocus={setFocus} compact />
          </div>
        )}
        {tab === "changes" && <ChangeList changes={changes} onFocus={(id) => (setFocus(id), setTab("visual"))} />}
        {tab === "terraform" && tf && (
          <div className="scroll pad">
            {tf.resourcesAdded.length + tf.resourcesRemoved.length === 0 ? (
              <p className="hint">No resources would be created or destroyed{tf.files.some((f) => f.status !== "unchanged") ? "; some settings change in place." : "."}</p>
            ) : (
              <div className="tf-summary">
                {tf.resourcesAdded.map((r) => (
                  <div key={r} className="add">
                    + create {r}
                  </div>
                ))}
                {tf.resourcesRemoved.map((r) => (
                  <div key={r} className="del">
                    − destroy {r}
                  </div>
                ))}
              </div>
            )}
            {tf.files
              .filter((f) => f.status !== "unchanged")
              .map((f) => (
                <div key={f.path} className="file-diff">
                  <div className="file-head">
                    {f.path} <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
                  </div>
                  <DiffView lines={f.lines} />
                </div>
              ))}
          </div>
        )}
        {(tab === "code" || tab === "mermaid") && (
          <div className="scroll pad">
            {code.every((l) => l.op === "eq") ? <p className="hint">No differences.</p> : <DiffView lines={code} />}
          </div>
        )}
      </div>
    </div>
  );
}

function ChangeList({
  changes,
  onFocus,
  compact,
}: {
  changes: ReturnType<typeof describeChanges>;
  onFocus: (id: string) => void;
  compact?: boolean;
}) {
  if (!changes.length) return <p className={`hint pad ${compact ? "change-list compact" : ""}`}>No differences.</p>;
  return (
    <ul className={`change-list ${compact ? "compact" : ""}`}>
      {changes.map((c) => (
        <li key={`${c.target}:${c.id}`} className={c.change}>
          <button className="link" onClick={() => c.target !== "connection" && onFocus(c.id)} disabled={c.target === "connection"}>
            <span className="sev">{c.change}</span> <b>{c.target === "connection" ? c.detail : c.label}</b>{" "}
            <span className="hint">{c.target === "connection" ? c.label && `(${c.label})` : c.detail}</span>
          </button>
          {c.fields.length > 0 && (
            <ul className="fields">
              {c.fields.map((f) => (
                <li key={f.field}>
                  {f.field}: <span className="del">{f.from}</span> → <span className="add">{f.to}</span>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

export function DiffView({ lines }: { lines: DiffLine[] }) {
  const hs = hunks(lines, 3);
  return (
    <div className="diff">
      {hs.map((h, i) => (
        <div key={i} className="hunk">
          {i > 0 && <div className="hunk-sep">⋯</div>}
          {h.lines.map((l, k) => (
            <div key={k} className={`dl ${l.op}`}>
              <span className="ln">{l.a ?? ""}</span>
              <span className="ln">{l.b ?? ""}</span>
              <span className="mark">{l.op === "add" ? "+" : l.op === "del" ? "−" : " "}</span>
              <span className="txt">{l.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

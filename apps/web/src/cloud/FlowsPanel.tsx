import { useMemo, useState } from "react";
import { type DiagramModel, describeIntegrations, type Integration, nodeById, sequenceOf, sequenceSvg, toArchitectureDoc, toMermaidSequence, type Workflow } from "@archcanvas/shared";
import { api } from "../api";
import { slug } from "../util";
import { download } from "./exporters";
import type { Highlight } from "./flow";

/** Highlight for one step of a workflow: that connection, with the earlier steps kept visible. */
export function stepHighlight(w: Workflow, index: number): Highlight {
  const s = w.steps[index];
  const before = w.steps.slice(0, index);
  return {
    nodes: [s.from, s.to],
    edges: [s.edgeId],
    visitedNodes: before.flatMap((b) => [b.from, b.to]),
    visitedEdges: before.map((b) => b.edgeId),
  };
}

/** Highlight for a whole workflow. */
export function workflowHighlight(w: Workflow): Highlight {
  return { nodes: [...new Set(w.steps.flatMap((s) => [s.from, s.to]))], edges: w.steps.map((s) => s.edgeId) };
}

export function FlowsPanel({
  model,
  title,
  workflows,
  aiNarrated,
  aiEnabled,
  onNarrated,
  onHighlight,
  onPresent,
  setStatus,
}: {
  model: DiagramModel;
  title: string;
  workflows: Workflow[];
  aiNarrated: boolean;
  aiEnabled: boolean;
  onNarrated: (w: Workflow[] | null) => void;
  onHighlight: (h: Highlight | null, focus?: string[]) => void;
  onPresent: (workflowIndex?: number) => void;
  setStatus: (s: { kind: "ok" | "error"; text: string } | null) => void;
}) {
  const integrations = useMemo(() => describeIntegrations(model), [model]);
  const [active, setActive] = useState<string | null>(null);
  const [sequence, setSequence] = useState<Workflow | null>(null);
  const [openEdge, setOpenEdge] = useState<string | null>(null);
  const [narrating, setNarrating] = useState(false);
  const name = (id: string) => nodeById(model, id)?.label ?? id;

  async function narrate() {
    setNarrating(true);
    try {
      const r = await api.narrateWorkflows(model, title);
      onNarrated(r.workflows);
      setStatus({ kind: "ok", text: `Rewrote ${r.rewritten} of ${r.workflows.length} workflows` });
    } catch (e) {
      const msg = (e as Error).message;
      setStatus({
        kind: "error",
        text: /auth|api key|credential|permission/i.test(msg) ? `${msg} Set GEMINI_API_KEY in .env and restart the API.` : msg,
      });
    } finally {
      setNarrating(false);
    }
  }

  const doc = () => toArchitectureDoc(model, title, workflows);

  if (!model.edges.length)
    return <p className="hint pad">Connect resources to see workflows and how each integration works.</p>;

  return (
    <div className="flows">
      <div className="row wrap">
        <button className="primary" onClick={() => onPresent()}>
          Present
        </button>
        <button onClick={() => download(`${slug(title)}-architecture.md`, doc(), "text/markdown")}>Download doc</button>
        <button onClick={() => void navigator.clipboard.writeText(doc()).then(() => setStatus({ kind: "ok", text: "Architecture doc copied as Markdown" }))}>
          Copy doc
        </button>
        {aiEnabled &&
          (aiNarrated ? (
            <button onClick={() => onNarrated(null)} title="Back to the generated wording">
              Reset wording
            </button>
          ) : (
            <button onClick={() => void narrate()} disabled={narrating} title="Let the AI rewrite titles and step text; the steps themselves stay the same">
              {narrating ? "Writing…" : "Improve wording with AI"}
            </button>
          ))}
      </div>

      {sequence && <SequenceDialog model={model} workflow={sequence} title={title} onClose={() => setSequence(null)} setStatus={setStatus} />}
      <h3>Workflows</h3>
      {workflows.map((w, wi) => (
        <section key={w.id} className={`workflow ${active?.startsWith(`${w.id}#`) || active === w.id ? "active" : ""}`}>
          <button
            className="workflow-head"
            onClick={() => {
              setActive(w.id);
              onHighlight(workflowHighlight(w));
            }}
          >
            <span className={`mode ${w.mode}`}>{w.mode === "async" ? "async" : "request"}</span>
            <b>{w.title}</b>
          </button>
          <p className="hint">{w.summary}</p>
          <ol>
            {w.steps.map((s, i) => (
              <li key={s.edgeId} className={active === `${w.id}#${i}` ? "current" : ""}>
                <button
                  className="link"
                  onClick={() => {
                    setActive(`${w.id}#${i}`);
                    onHighlight(stepHighlight(w, i), [s.from, s.to]);
                  }}
                >
                  <span className="step-route">
                    {name(s.from)} → {name(s.to)}
                    {s.mode === "async" && <span className="mode async">async</span>}
                  </span>
                  <span>{s.text}</span>
                </button>
              </li>
            ))}
          </ol>
          <div className="workflow-actions">
            <button className="link small" onClick={() => onPresent(wi)}>
              Present this workflow ▸
            </button>
            <button className="link small" onClick={() => setSequence(w)}>
              Sequence diagram
            </button>
          </div>
        </section>
      ))}

      <h3>How each integration works</h3>
      {integrations.map((i) => (
        <section key={i.edgeId} className="integration">
          <button
            className="workflow-head"
            onClick={() => {
              setOpenEdge(openEdge === i.edgeId ? null : i.edgeId);
              onHighlight({ nodes: [i.from, i.to], edges: [i.edgeId] }, [i.from, i.to]);
            }}
          >
            <span>{openEdge === i.edgeId ? "▾" : "▸"}</span>
            <b>
              {name(i.from)} → {name(i.to)}
            </b>
            {!i.mapped && <span className="mode doc">docs only</span>}
          </button>
          {openEdge === i.edgeId ? <IntegrationCard integration={i} /> : <p className="hint">{i.summary}</p>}
        </section>
      ))}
    </div>
  );
}

export function IntegrationCard({ integration: i }: { integration: Integration }) {
  const block = (title: string, items: string[], code = false) =>
    items.length ? (
      <div className="int-block">
        <div className="int-title">{title}</div>
        <ul>
          {items.map((x) => (
            <li key={x}>{code ? <code>{x}</code> : x}</li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <div className="int-card">
      <p>
        <span className="hint">{i.pattern}{i.mode === "async" ? " · asynchronous" : ""}.</span> {i.summary}
      </p>
      {block("How it works", i.howItWorks)}
      {block("Security", i.security)}
      {block("Configuration", i.config, true)}
      {block("Watch out for", i.considerations)}
      {block("Terraform", i.terraform, true)}
      {!i.mapped && <p className="banner warn">Documentation only: the generated Terraform does not deploy this connection.</p>}
    </div>
  );
}

/** A workflow as a sequence diagram, with SVG download and Mermaid text to paste elsewhere. */
function SequenceDialog({
  model,
  workflow,
  title,
  onClose,
  setStatus,
}: {
  model: DiagramModel;
  workflow: Workflow;
  title: string;
  onClose: () => void;
  setStatus: (s: { kind: "ok" | "error"; text: string } | null) => void;
}) {
  const seq = useMemo(() => sequenceOf(model, workflow), [model, workflow]);
  const svg = useMemo(() => sequenceSvg(seq), [seq]);
  const name = `${slug(title)}-${slug(workflow.title).toLowerCase()}`;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide sequence" role="dialog" aria-label="Sequence diagram" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{workflow.title}</h2>
          <button className="link" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {/* The SVG is generated here from escaped text, not taken from user HTML. */}
        <div className="sequence-svg" dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="row">
          <button onClick={() => download(`${name}.svg`, svg, "image/svg+xml")}>Download SVG</button>
          <button onClick={() => download(`${name}.mmd`, toMermaidSequence(seq))}>Download Mermaid</button>
          <button
            onClick={() =>
              void navigator.clipboard.writeText(toMermaidSequence(seq)).then(
                () => setStatus({ kind: "ok", text: "Mermaid sequence diagram copied: paste it into GitHub, GitLab, Notion or Confluence" }),
                () => setStatus({ kind: "error", text: "Couldn't copy to the clipboard" }),
              )
            }
          >
            Copy Mermaid
          </button>
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  catalogEntry,
  compileTerraform,
  type DiagramModel,
  describeIntegrations,
  nodeById,
  validateModel,
  type Workflow,
} from "@archcanvas/shared";
import { StaticCanvas } from "./DiffCanvas";
import { ResourceIcon, type Highlight } from "./flow";
import { stepHighlight, workflowHighlight } from "./FlowsPanel";

type Slide =
  | { type: "title" }
  | { type: "overview" }
  | { type: "workflow"; w: Workflow; wi: number }
  | { type: "step"; w: Workflow; wi: number; si: number }
  | { type: "closing" };

/**
 * Full-screen walkthrough: title, overview, then each workflow step by step with the canvas
 * zooming to the connection being explained, then a deployment and review summary.
 * Keys: → / Space / PageDown next, ← / PageUp back, Home / End, F fullscreen, Esc exit.
 */
export function Presentation({
  model,
  title,
  workflows,
  startWorkflow,
  onClose,
}: {
  model: DiagramModel;
  title: string;
  workflows: Workflow[];
  startWorkflow?: number;
  onClose: () => void;
}) {
  const slides = useMemo<Slide[]>(
    () => [
      { type: "title" },
      { type: "overview" },
      ...workflows.flatMap((w, wi): Slide[] => [{ type: "workflow", w, wi }, ...w.steps.map((_, si): Slide => ({ type: "step", w, wi, si }))]),
      { type: "closing" },
    ],
    [workflows],
  );
  const [index, setIndex] = useState(() =>
    startWorkflow === undefined ? 0 : Math.max(0, slides.findIndex((s) => s.type === "workflow" && s.wi === startWorkflow)),
  );
  const root = useRef<HTMLDivElement>(null);
  const slide = slides[index];
  const go = useCallback((i: number) => setIndex(Math.max(0, Math.min(slides.length - 1, i))), [slides.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowRight", "PageDown", " ", "Enter"].includes(e.key)) go(index + 1);
      else if (["ArrowLeft", "PageUp", "Backspace"].includes(e.key)) go(index - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(slides.length - 1);
      else if (e.key.toLowerCase() === "f") void toggleFullscreen();
      else if (e.key === "Escape" && !document.fullscreenElement) onClose();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await root.current?.requestFullscreen().catch(() => undefined);
  }

  const name = (id: string) => nodeById(model, id)?.label ?? id;
  const integrations = useMemo(() => new Map(describeIntegrations(model).map((i) => [i.edgeId, i])), [model]);

  let highlight: Highlight | null = null;
  let focus: string[] = [];
  if (slide.type === "workflow") {
    highlight = workflowHighlight(slide.w);
    focus = highlight.nodes;
  } else if (slide.type === "step") {
    highlight = stepHighlight(slide.w, slide.si);
    focus = highlight.nodes;
  }

  return (
    <div className="present" ref={root} role="dialog" aria-label={`Presentation: ${title}`}>
      <div className="present-bar">
        <b>{title}</b>
        <span className="hint">{crumb(slide)}</span>
        <div className="spacer" />
        <span className="hint">
          {index + 1} / {slides.length}
        </span>
        <button onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous slide">
          ←
        </button>
        <button className="primary" onClick={() => go(index + 1)} disabled={index === slides.length - 1} aria-label="Next slide">
          →
        </button>
        <button onClick={() => void toggleFullscreen()} title="Fullscreen (F)">
          ⛶
        </button>
        <button onClick={onClose} title="Exit (Esc)">
          Exit
        </button>
      </div>
      <div className="present-progress">
        <div style={{ width: `${((index + 1) / slides.length) * 100}%` }} />
      </div>

      <div className="present-body">
        <div className="present-canvas">
          <StaticCanvas model={model} highlight={highlight} focus={focus} minimap={false} />
        </div>
        <aside className="present-text">
          {slide.type === "title" && <TitleSlide model={model} title={title} workflows={workflows} />}
          {slide.type === "overview" && <OverviewSlide model={model} />}
          {slide.type === "workflow" && (
            <>
              <div className="kicker">
                Workflow {slide.wi + 1} of {workflows.length} · {slide.w.mode === "async" ? "asynchronous" : "request"}
              </div>
              <h1>{slide.w.title}</h1>
              <p className="lead">{slide.w.summary}</p>
              <p>
                <b>Trigger:</b> {slide.w.trigger}.
              </p>
              <ol className="agenda">
                {slide.w.steps.map((s) => (
                  <li key={s.edgeId}>
                    {name(s.from)} → {name(s.to)}
                  </li>
                ))}
              </ol>
            </>
          )}
          {slide.type === "step" &&
            (() => {
              const s = slide.w.steps[slide.si];
              const i = integrations.get(s.edgeId);
              return (
                <>
                  <div className="kicker">
                    {slide.w.title} · step {slide.si + 1} of {slide.w.steps.length}
                  </div>
                  <h1 className="route">
                    <ResourceIcon kind={nodeById(model, s.from)?.kind ?? ""} icon={nodeById(model, s.from)?.icon} size={30} /> {name(s.from)}
                    <span className="arrow">{s.mode === "async" ? "⇢" : "→"}</span>
                    <ResourceIcon kind={nodeById(model, s.to)?.kind ?? ""} icon={nodeById(model, s.to)?.icon} size={30} /> {name(s.to)}
                  </h1>
                  <p className="lead">{s.text}</p>
                  {i && (
                    <>
                      {i.howItWorks.length > 0 && (
                        <>
                          <h3>How it works</h3>
                          <ul>
                            {i.howItWorks.map((x) => (
                              <li key={x}>{x}</li>
                            ))}
                          </ul>
                        </>
                      )}
                      {i.security.length > 0 && (
                        <>
                          <h3>Security</h3>
                          <ul>
                            {i.security.map((x) => (
                              <li key={x}>{x}</li>
                            ))}
                          </ul>
                        </>
                      )}
                      {i.considerations.length > 0 && (
                        <>
                          <h3>Watch out for</h3>
                          <ul>
                            {i.considerations.map((x) => (
                              <li key={x}>{x}</li>
                            ))}
                          </ul>
                        </>
                      )}
                    </>
                  )}
                </>
              );
            })()}
          {slide.type === "closing" && <ClosingSlide model={model} />}
        </aside>
      </div>
    </div>
  );
}

function crumb(s: Slide): string {
  if (s.type === "workflow") return s.w.title;
  if (s.type === "step") return `${s.w.title} · step ${s.si + 1}`;
  return s.type === "title" ? "" : s.type === "overview" ? "Overview" : "Deployment and review";
}

function TitleSlide({ model, title, workflows }: { model: DiagramModel; title: string; workflows: Workflow[] }) {
  const gcp = model.nodes.filter((n) => n.kind.startsWith("gcp.") && !catalogEntry(n.kind)?.container);
  return (
    <>
      <div className="kicker">Architecture walkthrough</div>
      <h1 className="big">{title}</h1>
      <p className="lead">
        {gcp.length} Google Cloud component{gcp.length === 1 ? "" : "s"}, {model.edges.length} integration{model.edges.length === 1 ? "" : "s"},{" "}
        {workflows.length} workflow{workflows.length === 1 ? "" : "s"}.
      </p>
      <h3>Agenda</h3>
      <ol className="agenda">
        <li>Overview</li>
        {workflows.map((w) => (
          <li key={w.id}>{w.title}</li>
        ))}
        <li>Deployment and review</li>
      </ol>
      <p className="hint">Use → and ← to move, F for fullscreen, Esc to exit.</p>
    </>
  );
}

function OverviewSlide({ model }: { model: DiagramModel }) {
  const groups = new Map<string, { label: string; kind: string; icon?: string }[]>();
  for (const n of model.nodes) {
    const e = catalogEntry(n.kind);
    if (!e || e.container) continue;
    groups.set(e.category, [...(groups.get(e.category) ?? []), { label: n.label, kind: n.kind, icon: n.icon }]);
  }
  const containers = model.nodes.filter((n) => catalogEntry(n.kind)?.container);
  return (
    <>
      <div className="kicker">Overview</div>
      <h1>What's in the architecture</h1>
      {[...groups].map(([cat, items]) => (
        <div key={cat} className="ov-group">
          <h3>{cat}</h3>
          <div className="chips">
            {items.map((x) => (
              <span key={x.label} className="chip">
                <ResourceIcon kind={x.kind} icon={x.icon} size={18} /> {x.label}
              </span>
            ))}
          </div>
        </div>
      ))}
      {containers.length > 0 && (
        <p className="hint">
          Grouped into {containers.map((c) => `${catalogEntry(c.kind)?.label.toLowerCase()} ${c.label}`).join(", ")}.
        </p>
      )}
    </>
  );
}

function ClosingSlide({ model }: { model: DiagramModel }) {
  const tf = useMemo(() => compileTerraform(model), [model]);
  const issues = useMemo(() => validateModel(model), [model]);
  const count = (s: string) => issues.filter((i) => i.severity === s).length;
  return (
    <>
      <div className="kicker">Wrap-up</div>
      <h1>Deployment and review</h1>
      <p className="lead">
        The generated Terraform creates <b>{tf.resources.length}</b> Google Cloud resources, including least-privilege service accounts and IAM for every
        integration.
      </p>
      <h3>Review</h3>
      <p>
        {count("error")} errors · {count("warning")} warnings · {count("suggestion")} suggestions
      </p>
      <ul>
        {issues
          .filter((i) => i.severity !== "error")
          .slice(0, 6)
          .map((i, k) => (
            <li key={k}>{i.message}</li>
          ))}
      </ul>
    </>
  );
}

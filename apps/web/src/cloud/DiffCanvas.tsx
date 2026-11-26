import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Background, BackgroundVariant, Controls, MiniMap, type Node, ReactFlow, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { type DiagramModel, diffModels, type ModelDiff, pageModel, pageOf, pagesOf } from "@archcanvas/shared";
import { edgeTypes, type Highlight, nodeTypes, toFlow, withGhosts } from "./flow";
import { autoLayout, hasLayout, structureKey } from "./layout";

interface StaticProps {
  model: DiagramModel;
  diff?: ModelDiff;
  highlight?: Highlight | null;
  /** Node ids to zoom to; the whole diagram when empty. */
  focus?: string[];
  overlay?: ReactNode;
  minimap?: boolean;
  className?: string;
}

/** Read-only canvas: comparisons, walkthroughs and presentations. Auto-lays out when positions are missing. */
export function StaticCanvas(props: StaticProps) {
  // A diagram with canvas tabs is shown one tab at a time: the tab of what's in focus (e.g.
  // the presentation's current step), else the one picked from the small tab bar.
  const pages = pagesOf(props.model);
  const [picked, setPicked] = useState(pages[0].id);
  const focusPage = props.focus?.length ? pageOf(props.model, props.focus[0]) : undefined;
  const page = focusPage ?? (pages.some((p) => p.id === picked) ? picked : pages[0].id);
  const model = useMemo(() => (pages.length > 1 ? pageModel(props.model, page) : props.model), [props.model, page, pages.length]);
  return (
    <ReactFlowProvider>
      <Inner
        key={pages.length > 1 ? page : "one"}
        {...props}
        model={model}
        overlay={
          <>
            {props.overlay}
            {pages.length > 1 && (
              <div className="static-pages" role="tablist" aria-label="Canvas tabs">
                {pages.map((p) => (
                  <button key={p.id} role="tab" aria-selected={p.id === page} className={p.id === page ? "on" : ""} onClick={() => setPicked(p.id)}>
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </>
        }
      />
    </ReactFlowProvider>
  );
}

function Inner({ model, diff, highlight, focus, overlay, minimap = true, className = "" }: StaticProps) {
  const rf = useReactFlow();
  const [layout, setLayout] = useState<DiagramModel["layout"] | null>(hasLayout(model) ? model.layout : null);
  const key = structureKey(model);

  useEffect(() => {
    if (hasLayout(model)) return setLayout(model.layout);
    let cancelled = false;
    void autoLayout(model).then((l) => !cancelled && setLayout(l));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const flow = useMemo(() => toFlow({ ...model, layout: layout ?? {} }, { diff, highlight }), [model, layout, diff, highlight]);
  // Keep measured sizes across re-renders (each step of a presentation re-renders the nodes).
  const measured = useRef(new Map<string, Node["measured"]>());
  const nodes = flow.nodes.map((n) => (measured.current.get(n.id) ? { ...n, measured: measured.current.get(n.id) } : n));
  const focusKey = (focus ?? []).join(",");

  useEffect(() => {
    if (!layout) return;
    const t = setTimeout(() => {
      const nodes = (focus ?? []).map((id) => rf.getNode(id)).filter((n) => n !== undefined);
      void rf.fitView(nodes.length ? { nodes, padding: 0.6, duration: 450, maxZoom: 1.4 } : { padding: 0.12, duration: 300 });
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, focusKey, rf]);

  return (
    <div className={`cloud-canvas static-canvas ${className}`}>
      {layout && (
        <ReactFlow
          nodes={nodes}
          onNodesChange={(changes) => {
            for (const c of changes) if (c.type === "dimensions" && c.dimensions) measured.current.set(c.id, c.dimensions);
          }}
          edges={flow.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          fitView
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} />
          {minimap && <MiniMap pannable zoomable nodeStrokeWidth={2} />}
        </ReactFlow>
      )}
      {overlay}
    </div>
  );
}

/**
 * Shows `after` with what changed since `before`: added in green, changed in amber, removed
 * as red ghosts. Keeps the saved layout when it covers every node.
 */
export function DiffCanvas({ before, after, focus }: { before: DiagramModel; after: DiagramModel; focus?: string | null }) {
  const diff = useMemo(() => diffModels(before, after), [before, after]);
  const merged = useMemo(() => {
    const m = withGhosts(before, after, diff);
    return { ...m, layout: { ...before.layout, ...after.layout } };
  }, [before, after, diff]);
  return (
    <StaticCanvas
      model={merged}
      diff={diff}
      focus={focus ? [focus] : []}
      className="diff-canvas"
      overlay={
        <div className="diff-legend">
          <span className="add">■ added</span>
          <span className="chg">■ changed</span>
          <span className="del">■ removed</span>
        </div>
      }
    />
  );
}

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { type DiagramModel, diffModels, type ModelDiff } from "@archcanvas/shared";
import { type Highlight, nodeTypes, toFlow, withGhosts } from "./flow";
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
  return (
    <ReactFlowProvider>
      <Inner {...props} />
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
          nodes={flow.nodes}
          edges={flow.edges}
          nodeTypes={nodeTypes}
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

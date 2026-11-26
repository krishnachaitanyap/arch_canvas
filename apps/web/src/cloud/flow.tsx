import { createContext, useContext, useEffect, useState } from "react";
import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  NodeResizer,
  Position,
} from "@xyflow/react";
import {
  Archive,
  Box,
  Container,
  Database,
  FolderKanban,
  KeyRound,
  type LucideIcon,
  MapPin,
  MessagesSquare,
  Network,
  Package,
  Split,
  Users,
  Waypoints,
  Zap,
} from "lucide-react";
import { kindIconRef, useIcon } from "../icons/registry";
import { catalogEntry, childrenOf, type DiagramModel, type DiagramNode, type ModelDiff, type Routing } from "@archcanvas/shared";
import { NODE_H, NODE_W } from "./layout";

export type Status = "added" | "changed" | "removed";

/** Emphasis for walkthroughs: the current step is highlighted, earlier steps stay visible, the rest dims. */
export interface Highlight {
  nodes: string[];
  edges: string[];
  visitedNodes?: string[];
  visitedEdges?: string[];
}

export interface CloudNodeData extends Record<string, unknown> {
  node: DiagramNode;
  status?: Status;
  issues?: number;
}
type CloudNode = Node<CloudNodeData>;

const DEFAULT_ICONS: Record<string, LucideIcon> = {
  "generic.client": Users,
  "generic.component": Box,
  "gcp.project": FolderKanban,
  "gcp.region": MapPin,
  "gcp.vpc": Network,
  "gcp.subnet": Waypoints,
  "gcp.cloud_run": Container,
  "gcp.cloud_sql": Database,
  "gcp.gcs_bucket": Archive,
  "gcp.memorystore_redis": Zap,
  "gcp.pubsub_topic": MessagesSquare,
  "gcp.load_balancer": Split,
  "gcp.secret": KeyRound,
  "gcp.artifact_registry": Package,
};

/**
 * The icon for a node: its own icon if set, else the workspace's Google Cloud pack icon for
 * its type, else a Lucide badge in the category colour. Icons render through <img>, so
 * uploaded SVGs can never run scripts.
 */
export function ResourceIcon({ kind, icon, size = 32 }: { kind: string; icon?: string; size?: number }) {
  const own = useIcon(icon);
  const fromPack = useIcon(own ? undefined : kindIconRef(kind));
  const url = own ?? fromPack;
  if (url) return <img className="ricon-img" src={url} width={size} height={size} alt="" draggable={false} />;
  const entry = catalogEntry(kind);
  const Glyph = DEFAULT_ICONS[kind] ?? Box;
  return (
    <span className="ricon" style={{ background: entry?.icon.color ?? "#5f6368", width: size, height: size }} aria-hidden>
      <Glyph size={Math.round(size * 0.58)} strokeWidth={2} color="#fff" />
    </span>
  );
}

/** Lets custom nodes and edges edit in place without putting callbacks in node data. */
export interface EditorActions {
  editable: boolean;
  editing: string | null;
  setEditing: (id: string | null) => void;
  rename: (id: string, label: string) => void;
  renameEdge: (edgeId: string, label: string) => void;
  resized: (id: string, box: { x: number; y: number; w: number; h: number }) => void;
}
export const EditorContext = createContext<EditorActions>({
  editable: false,
  editing: null,
  setEditing: () => undefined,
  rename: () => undefined,
  renameEdge: () => undefined,
  resized: () => undefined,
});

function InlineText({ id, value, className, multiline, onCommit }: { id: string; value: string; className?: string; multiline?: boolean; onCommit: (v: string) => void }) {
  const ctx = useContext(EditorContext);
  const [draft, setDraft] = useState(value);
  const editing = ctx.editing === id;
  useEffect(() => setDraft(value), [value, editing]);
  if (!editing) return <div className={className}>{value}</div>;
  const done = (commit: boolean) => {
    ctx.setEditing(null);
    if (commit && draft.trim() && draft !== value) onCommit(draft.trim());
  };
  const props = {
    autoFocus: true,
    value: draft,
    className: `inline-edit nodrag nopan ${className ?? ""}`,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => done(true),
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") done(false);
      if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) done(true);
    },
    onFocus: (e: { target: HTMLInputElement | HTMLTextAreaElement }) => e.target.select(),
  };
  return multiline ? <textarea {...props} rows={3} /> : <input {...props} />;
}

function ResourceNode({ id, data, selected }: NodeProps<CloudNode>) {
  const entry = catalogEntry(data.node.kind);
  const ctx = useContext(EditorContext);
  return (
    <div
      className={`rnode ${data.status ?? ""} ${selected ? "selected" : ""}`}
      title={entry?.description}
      onDoubleClick={() => ctx.editable && ctx.setEditing(id)}
    >
      <Handle type="target" position={Position.Left} />
      <ResourceIcon kind={data.node.kind} icon={data.node.icon} />
      <div className="rnode-text">
        <InlineText id={id} value={data.node.label} className="rnode-label" onCommit={(v) => ctx.rename(id, v)} />
        <div className="rnode-kind">{entry?.label ?? data.node.kind}</div>
      </div>
      {data.issues ? <span className="rnode-badge" title={`${data.issues} warning(s)`}>{data.issues}</span> : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function GroupNode({ id, data, selected }: NodeProps<CloudNode>) {
  const entry = catalogEntry(data.node.kind);
  const ctx = useContext(EditorContext);
  const color = data.node.kind === "generic.group" ? "#71717a" : (entry?.icon.color ?? "#80868b");
  const region = data.node.kind === "gcp.region" ? (data.node.props.region as string | undefined) ?? "us-central1" : undefined;
  return (
    <div className={`gnode ${data.status ?? ""} ${selected ? "selected" : ""} ${data.node.kind === "generic.group" ? "doc" : ""}`} style={{ borderColor: color }}>
      <NodeResizer
        isVisible={selected && ctx.editable}
        minWidth={160}
        minHeight={80}
        color="#4f46e5"
        onResizeEnd={(_, p) => ctx.resized(id, { x: p.x, y: p.y, w: p.width, h: p.height })}
      />
      <div className="gnode-head" style={{ color }} onDoubleClick={() => ctx.editable && ctx.setEditing(id)}>
        <ResourceIcon kind={data.node.kind} icon={data.node.icon} size={20} />
        <InlineText id={id} value={data.node.label} className="gnode-label" onCommit={(v) => ctx.rename(id, v)} />
        <span className="gnode-kind">
          {data.node.kind === "generic.group" ? "" : entry?.label}
          {region ? ` · ${region}` : ""}
        </span>
      </div>
    </div>
  );
}

function NoteNode({ id, data, selected }: NodeProps<CloudNode>) {
  const ctx = useContext(EditorContext);
  return (
    <div className={`note ${selected ? "selected" : ""}`} onDoubleClick={() => ctx.editable && ctx.setEditing(id)}>
      <NodeResizer isVisible={selected && ctx.editable} minWidth={100} minHeight={40} color="#ca8a04" onResizeEnd={(_, p) => ctx.resized(id, { x: p.x, y: p.y, w: p.width, h: p.height })} />
      <Handle type="target" position={Position.Left} />
      <InlineText id={id} value={data.node.label} className="note-text" multiline onCommit={(v) => ctx.rename(id, v)} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const nodeTypes = { resource: ResourceNode, group: GroupNode, note: NoteNode };

/** Connection drawn orthogonal, straight or curved, with a label you can double-click to edit. */
function SmartEdge(props: EdgeProps<Edge<{ routing?: Routing; label?: string; editable?: boolean }>>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data, label } = props;
  const ctx = useContext(EditorContext);
  const params = { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition };
  const [path, lx, ly] =
    data?.routing === "straight" ? getStraightPath(params) : data?.routing === "curved" ? getBezierPath(params) : getSmoothStepPath({ ...params, borderRadius: 8 });
  const text = typeof label === "string" ? label : "";
  const editing = ctx.editing === `edge:${id}`;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={18} />
      {(text || editing) && (
        <EdgeLabelRenderer>
          <div
            className="edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
            onDoubleClick={() => ctx.editable && ctx.setEditing(`edge:${id}`)}
          >
            <InlineText id={`edge:${id}`} value={data?.label ?? text} onCommit={(v) => ctx.renameEdge(id, v)} />
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = { smart: SmartEdge };

/** Model → React Flow nodes/edges. Parents are emitted before children, as React Flow requires. */
export function toFlow(
  m: DiagramModel,
  opts: { diff?: ModelDiff; issues?: Map<string, number>; selected?: string | null; selectedIds?: Set<string>; highlight?: Highlight | null; editable?: boolean } = {},
): { nodes: CloudNode[]; edges: Edge[] } {
  const statusOf = (id: string): Status | undefined =>
    opts.diff?.addedNodes.includes(id)
      ? "added"
      : opts.diff?.removedNodes.includes(id)
        ? "removed"
        : opts.diff?.changedNodes.includes(id)
          ? "changed"
          : undefined;
  const nodes: CloudNode[] = [];
  const visit = (parentId: string | undefined) => {
    for (const n of childrenOf(m, parentId)) {
      const container = catalogEntry(n.kind)?.container;
      const note = n.kind === "generic.note";
      const box = m.layout[n.id] ?? { x: 0, y: 0 };
      const w = box.w ?? (note ? 200 : NODE_W);
      const h = box.h ?? (note ? 90 : NODE_H);
      nodes.push({
        id: n.id,
        type: container ? "group" : note ? "note" : "resource",
        position: { x: box.x, y: box.y },
        ...(n.parentId ? { parentId: n.parentId } : {}),
        data: { node: n, status: statusOf(n.id), issues: opts.issues?.get(n.id) },
        style: container || note ? { width: w, height: h } : { width: w },
        width: w,
        height: h,
        selected: opts.selectedIds ? opts.selectedIds.has(n.id) : opts.selected === n.id,
        zIndex: container ? 0 : note ? 5 : 10,
        className: emphasis(opts.highlight, n.id, "node", Boolean(container)),
      });
      visit(n.id);
    }
  };
  visit(undefined);

  const edges: Edge[] = m.edges.map((e) => {
    const status = opts.diff?.addedEdges.includes(e.id) ? "added" : opts.diff?.removedEdges.includes(e.id) ? "removed" : undefined;
    const hl = opts.highlight;
    const current = hl?.edges.includes(e.id);
    const visited = hl?.visitedEdges?.includes(e.id);
    const color = current ? "#4f46e5" : status === "added" ? "#1e8e3e" : status === "removed" ? "#d93025" : visited ? "#6366f1" : "#5f6368";
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.label ?? e.protocol,
      type: "smart",
      data: { routing: e.routing, label: e.label ?? e.protocol ?? "", editable: opts.editable },
      reconnectable: Boolean(opts.editable),
      selected: opts.selectedIds?.has(`edge:${e.id}`),
      animated: status === "added" || Boolean(current),
      zIndex: current ? 30 : 20,
      className: [status ?? "", hl ? (current ? "hl" : visited ? "visited" : "dim") : ""].join(" ").trim(),
      style: { stroke: color, strokeWidth: current ? 3 : visited ? 2 : 1.6, ...(status === "removed" ? { strokeDasharray: "6 4" } : {}) },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 },
    };
  });
  return { nodes, edges };
}

function emphasis(hl: Highlight | null | undefined, id: string, _t: "node", container: boolean): string {
  if (!hl) return "";
  if (hl.nodes.includes(id)) return "hl";
  if (hl.visitedNodes?.includes(id)) return "visited";
  return container ? "dim-group" : "dim";
}

/**
 * What the canvas shows while the agent proposes changes: the proposal, plus removed nodes
 * and edges from the base drawn as ghosts.
 */
export function withGhosts(base: DiagramModel, proposal: DiagramModel, diff: ModelDiff): DiagramModel {
  const present = new Set(proposal.nodes.map((n) => n.id));
  const ghosts = base.nodes
    .filter((n) => diff.removedNodes.includes(n.id))
    .map((n) => (n.parentId && !present.has(n.parentId) ? { ...n, parentId: undefined } : n));
  const ghostEdges = base.edges.filter((e) => diff.removedEdges.includes(e.id));
  return {
    ...proposal,
    nodes: [...proposal.nodes, ...ghosts],
    edges: [...proposal.edges, ...ghostEdges.filter((e) => [...present, ...ghosts.map((g) => g.id)].includes(e.from))],
  };
}

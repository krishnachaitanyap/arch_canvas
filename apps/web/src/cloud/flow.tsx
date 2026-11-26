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
import {
  type Arrowhead,
  catalogEntry,
  childrenOf,
  type DiagramModel,
  type DiagramNode,
  type ModelDiff,
  resolvedProps,
  type Routing,
  SHAPE_LABELS,
  type ShapeName,
  type Side,
  SIDES,
} from "@archcanvas/shared";
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

/** SVG outline for a general shape at its real pixel size (so it stays crisp when resized). */
export function ShapeOutline({ shape, w, h, fill, stroke, sw = 1.6 }: { shape: string; w: number; h: number; fill: string; stroke: string; sw?: number }) {
  const p = sw / 2 + 0.5;
  const W = w - p;
  const H = h - p;
  const common = { fill, stroke, strokeWidth: sw, vectorEffect: "non-scaling-stroke" as const };
  const slant = Math.min(24, w * 0.18);
  let el: React.ReactNode;
  switch (shape) {
    case "rounded":
      el = <rect x={p} y={p} width={W - p} height={H - p} rx={12} {...common} />;
      break;
    case "terminator":
      el = <rect x={p} y={p} width={W - p} height={H - p} rx={(H - p) / 2} {...common} />;
      break;
    case "ellipse":
    case "circle":
      el = <ellipse cx={w / 2} cy={h / 2} rx={w / 2 - p} ry={h / 2 - p} {...common} />;
      break;
    case "diamond":
      el = <polygon points={`${w / 2},${p} ${W},${h / 2} ${w / 2},${H} ${p},${h / 2}`} {...common} />;
      break;
    case "parallelogram":
      el = <polygon points={`${p + slant},${p} ${W},${p} ${W - slant},${H} ${p},${H}`} {...common} />;
      break;
    case "hexagon":
      el = <polygon points={`${p + slant},${p} ${W - slant},${p} ${W},${h / 2} ${W - slant},${H} ${p + slant},${H} ${p},${h / 2}`} {...common} />;
      break;
    case "manual-input":
      el = <polygon points={`${p},${p + h * 0.25} ${W},${p} ${W},${H} ${p},${H}`} {...common} />;
      break;
    case "triangle":
      el = <polygon points={`${w / 2},${p} ${W},${H} ${p},${H}`} {...common} />;
      break;
    case "document": {
      const wave = Math.min(14, h * 0.18);
      el = <path d={`M${p},${p} H${W} V${H - wave} C${w * 0.75},${H - 2 * wave} ${w * 0.25},${H + wave} ${p},${H - wave} Z`} {...common} />;
      break;
    }
    case "cylinder": {
      const ry = Math.min(14, h * 0.15);
      el = (
        <>
          <path d={`M${p},${p + ry} V${H - ry} A${w / 2 - p},${ry} 0 0 0 ${W},${H - ry} V${p + ry} A${w / 2 - p},${ry} 0 0 0 ${p},${p + ry} Z`} {...common} />
          <path d={`M${p},${p + ry} A${w / 2 - p},${ry} 0 0 0 ${W},${p + ry}`} {...common} fill="none" />
        </>
      );
      break;
    }
    case "predefined": {
      const inset = Math.min(14, w * 0.08);
      el = (
        <>
          <rect x={p} y={p} width={W - p} height={H - p} {...common} />
          <line x1={p + inset} y1={p} x2={p + inset} y2={H} {...common} />
          <line x1={W - inset} y1={p} x2={W - inset} y2={H} {...common} />
        </>
      );
      break;
    }
    case "cloud":
      el = (
        <path
          d={`M${w * 0.25},${h * 0.85} C${w * 0.02},${h * 0.85} ${w * 0.02},${h * 0.45} ${w * 0.22},${h * 0.45} C${w * 0.2},${h * 0.12} ${w * 0.55},${h * 0.05} ${w * 0.62},${h * 0.3} C${w * 0.75},${h * 0.12} ${w * 0.98},${h * 0.25} ${w * 0.88},${h * 0.5} C${w * 1.02},${h * 0.6} ${w * 0.95},${h * 0.88} ${w * 0.75},${h * 0.85} Z`}
          {...common}
        />
      );
      break;
    case "text":
      el = null;
      break;
    default:
      el = <rect x={p} y={p} width={W - p} height={H - p} {...common} />;
  }
  return (
    <svg className="shape-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      {el}
    </svg>
  );
}

function ShapeNode({ id, data, selected, width, height }: NodeProps<CloudNode>) {
  const ctx = useContext(EditorContext);
  const p = resolvedProps("generic.shape", data.node.props);
  const shape = String(p.shape);
  const [dw, dh] = SHAPE_LABELS[shape as ShapeName]?.size ?? [160, 70];
  const w = width ?? dw;
  const h = height ?? dh;
  return (
    <div
      className={`shape-node ${data.status ?? ""} ${selected ? "selected" : ""} ${shape === "text" ? "text-only" : ""}`}
      style={{ color: String(p.textColor) }}
      onDoubleClick={() => ctx.editable && ctx.setEditing(id)}
    >
      <NodeResizer isVisible={selected && ctx.editable} minWidth={40} minHeight={24} color="#4f46e5" onResizeEnd={(_, r) => ctx.resized(id, { x: r.x, y: r.y, w: r.width, h: r.height })} />
      <ShapeOutline shape={shape} w={w} h={h} fill={String(p.fill)} stroke={selected ? "#4f46e5" : String(p.stroke)} />
      <div className={`shape-label ${shape === "cylinder" ? "low" : ""}`}>
        <InlineText id={id} value={data.node.label} multiline onCommit={(v) => ctx.rename(id, v)} />
      </div>
      {/* A source and a target handle on every side (same id), so lines can start and end anywhere. */}
      {SIDES.map((side) => (
        <Handle key={`s-${side}`} id={side} type="source" position={SIDE_POS[side]} className="side-handle" />
      ))}
      {SIDES.map((side) => (
        <Handle key={`t-${side}`} id={side} type="target" position={SIDE_POS[side]} className="side-handle" />
      ))}
    </div>
  );
}

const SIDE_POS: Record<Side, Position> = { t: Position.Top, r: Position.Right, b: Position.Bottom, l: Position.Left };

export const nodeTypes = { resource: ResourceNode, group: GroupNode, note: NoteNode, shape: ShapeNode };

/** Connection drawn orthogonal, straight or curved, with a label you can double-click to edit. */
type EdgeData = { routing?: Routing; label?: string; editable?: boolean; color: string; width: number; dash?: string; arrowStart?: Arrowhead; arrowEnd?: Arrowhead; status?: string };

/** Arrowhead drawn in the line's colour; `auto-start-reverse` lets one marker serve both ends. */
function Marker({ id, kind, color }: { id: string; kind: Arrowhead; color: string }) {
  if (kind === "none") return null;
  const shape =
    kind === "arrow" ? (
      <path d="M1,1 L12,6 L1,11 z" fill={color} />
    ) : kind === "open" ? (
      <path d="M1,1 L12,6 L1,11" fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
    ) : kind === "triangle" ? (
      <path d="M1,1 L12,6 L1,11 z" fill="#fff" stroke={color} strokeWidth={1.4} />
    ) : kind === "diamond" || kind === "odiamond" ? (
      <path d="M0.8,6 L6.5,1 L12.2,6 L6.5,11 z" fill={kind === "diamond" ? color : "#fff"} stroke={color} strokeWidth={1.4} />
    ) : (
      <circle cx={7} cy={6} r={4.2} fill={color} />
    );
  return (
    <marker id={id} viewBox="0 0 13 12" refX={12} refY={6} markerWidth={13} markerHeight={12} markerUnits="userSpaceOnUse" orient="auto-start-reverse">
      {shape}
    </marker>
  );
}

function SmartEdge(props: EdgeProps<Edge<EdgeData>>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, label } = props;
  const ctx = useContext(EditorContext);
  const params = { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition };
  const [path, lx, ly] =
    data?.routing === "straight" ? getStraightPath(params) : data?.routing === "curved" ? getBezierPath(params) : getSmoothStepPath({ ...params, borderRadius: 8 });
  const text = typeof label === "string" ? label : "";
  const editing = ctx.editing === `edge:${id}`;
  const color = data?.color ?? "#5f6368";
  const startId = `m-${id}-s`;
  const endId = `m-${id}-e`;
  const end = data?.arrowEnd ?? "arrow";
  const start = data?.arrowStart ?? "none";
  const dash = data?.dash === "dashed" ? "7 5" : data?.dash === "dotted" ? "1.5 4.5" : data?.status === "removed" ? "6 4" : undefined;
  return (
    <>
      <defs>
        <Marker id={endId} kind={end} color={color} />
        <Marker id={startId} kind={start} color={color} />
      </defs>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={end === "none" ? undefined : `url(#${endId})`}
        markerStart={start === "none" ? undefined : `url(#${startId})`}
        style={{ stroke: color, strokeWidth: data?.width ?? 1.6, strokeDasharray: dash, strokeLinecap: data?.dash === "dotted" ? "round" : undefined }}
        interactionWidth={18}
      />
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
  const order = new Map(m.nodes.map((n, i) => [n.id, i]));
  const visit = (parentId: string | undefined) => {
    for (const n of childrenOf(m, parentId)) {
      const container = catalogEntry(n.kind)?.container;
      const note = n.kind === "generic.note";
      const shape = n.kind === "generic.shape";
      const box = m.layout[n.id] ?? { x: 0, y: 0 };
      const ds = shape ? (SHAPE_LABELS[String(resolvedProps(n.kind, n.props).shape) as ShapeName]?.size ?? [160, 70]) : undefined;
      const w = box.w ?? (note ? 200 : ds ? ds[0] : NODE_W);
      const h = box.h ?? (note ? 90 : ds ? ds[1] : NODE_H);
      nodes.push({
        id: n.id,
        type: container ? "group" : note ? "note" : shape ? "shape" : "resource",
        position: { x: box.x, y: box.y },
        ...(n.parentId ? { parentId: n.parentId } : {}),
        data: { node: n, status: statusOf(n.id), issues: opts.issues?.get(n.id) },
        style: container || note || shape ? { width: w, height: h } : { width: w },
        width: w,
        height: h,
        selected: opts.selectedIds ? opts.selectedIds.has(n.id) : opts.selected === n.id,
        // Layer by type, then by order in the model (Bring to front / Send to back reorder it).
        zIndex: (container ? 0 : note || shape ? 5 : 10) * 1000 + order.get(n.id)!,
        className: emphasis(opts.highlight, n.id, "node", Boolean(container)),
      });
      visit(n.id);
    }
  };
  visit(undefined);

  // Lines touching general shapes attach to the side facing the other end (or the side the
  // user dragged from); resources keep their left/right handles.
  const abs = (id: string): { x: number; y: number; w: number; h: number } => {
    const n = m.nodes.find((x) => x.id === id);
    const l = m.layout[id] ?? { x: 0, y: 0 };
    const base = n?.parentId ? abs(n.parentId) : { x: 0, y: 0, w: 0, h: 0 };
    return { x: base.x + l.x, y: base.y + l.y, w: l.w ?? NODE_W, h: l.h ?? NODE_H };
  };
  const isShape = (id: string) => m.nodes.find((x) => x.id === id)?.kind === "generic.shape";
  const sides = (from: string, to: string): [Side, Side] => {
    const a = abs(from);
    const b = abs(to);
    const dx = b.x + b.w / 2 - (a.x + a.w / 2);
    const dy = b.y + b.h / 2 - (a.y + a.h / 2);
    if (Math.abs(dy) > Math.abs(dx)) return dy > 0 ? ["b", "t"] : ["t", "b"];
    return dx > 0 ? ["r", "l"] : ["l", "r"];
  };

  const edges: Edge[] = m.edges.map((e) => {
    const status = opts.diff?.addedEdges.includes(e.id) ? "added" : opts.diff?.removedEdges.includes(e.id) ? "removed" : undefined;
    const hl = opts.highlight;
    const current = hl?.edges.includes(e.id);
    const visited = hl?.visitedEdges?.includes(e.id);
    const color = current ? "#4f46e5" : status === "added" ? "#1e8e3e" : status === "removed" ? "#d93025" : visited ? "#6366f1" : (e.color ?? "#5f6368");
    const auto = isShape(e.from) || isShape(e.to) ? sides(e.from, e.to) : undefined;
    const sourceHandle = isShape(e.from) ? (e.fromHandle ?? auto![0]) : undefined;
    const targetHandle = isShape(e.to) ? (e.toHandle ?? auto![1]) : undefined;
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.label ?? e.protocol,
      type: "smart",
      ...(sourceHandle ? { sourceHandle } : {}),
      ...(targetHandle ? { targetHandle } : {}),
      data: {
        routing: e.routing,
        label: e.label ?? e.protocol ?? "",
        editable: opts.editable,
        color,
        width: current ? 3 : visited ? 2 : 1.6,
        dash: e.dash,
        arrowStart: e.arrowStart,
        arrowEnd: e.arrowEnd,
        status,
      },
      reconnectable: Boolean(opts.editable),
      selected: opts.selectedIds?.has(`edge:${e.id}`),
      animated: status === "added" || Boolean(current),
      zIndex: current ? 30500 : 20000,
      className: [status ?? "", hl ? (current ? "hl" : visited ? "visited" : "dim") : ""].join(" ").trim(),
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

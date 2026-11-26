import { createContext, useContext, useEffect, useRef, useState } from "react";
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
  useViewport,
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
  ROW_SHAPES,
  SHAPE_LABELS,
  type ShapeName,
  type Side,
  SIDES,
  TAB_ICONS,
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
  /** Drop a line's label somewhere else (offset from the middle of the line). */
  moveEdgeLabel: (edgeId: string, dx: number, dy: number) => void;
  resized: (id: string, box: { x: number; y: number; w: number; h: number }) => void;
}
export const EditorContext = createContext<EditorActions>({
  editable: false,
  editing: null,
  setEditing: () => undefined,
  rename: () => undefined,
  renameEdge: () => undefined,
  moveEdgeLabel: () => undefined,
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
  return multiline ? <EditInPlace className={className} value={value} onDone={(v, commit) => { ctx.setEditing(null); if (commit && v.trim() && v.trim() !== value) onCommit(v.trim()); }} /> : <input {...props} />;
}

/**
 * Edits text where it is drawn, as draw.io does: same font and position, no box, all text
 * selected to start. Enter adds a line; ⌘/Ctrl+Enter or clicking away saves; Esc cancels.
 */
function EditInPlace({ value, className, onDone }: { value: string; className?: string; onDone: (v: string, commit: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    const el = ref.current!;
    el.innerText = value;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    onDone(ref.current?.innerText.replace(/\n$/, "") ?? value, commit);
  };
  return (
    <div
      ref={ref}
      className={`edit-in-place nodrag nopan nowheel ${className ?? ""}`}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") finish(false);
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) finish(true);
      }}
    />
  );
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

/** The group's corner tab: AWS group icons already are one; other icons sit on the group colour. */
function GroupTab({ kind, icon, color }: { kind: string; icon?: string; color: string }) {
  if (icon && TAB_ICONS.has(icon))
    return (
      <span className="gnode-tab">
        <ResourceIcon kind={kind} icon={icon} size={32} />
      </span>
    );
  const mono = !icon || icon.startsWith("lucide:");
  return (
    <span className={`gnode-tab ${mono ? "mono" : "plain"}`} style={{ background: mono ? color : "#fff", borderColor: color }}>
      <ResourceIcon kind={kind} icon={icon} size={mono ? 22 : 24} />
    </span>
  );
}

function GroupNode({ id, data, selected }: NodeProps<CloudNode>) {
  const entry = catalogEntry(data.node.kind);
  const ctx = useContext(EditorContext);
  const p = resolvedProps(data.node.kind, data.node.props);
  const color = String(p.color ?? entry?.icon.color ?? "#80868b");
  const border = String(p.border ?? "dashed");
  const header = String(p.header ?? "icon");
  const fill = String(p.fill ?? "none");
  const region = data.node.kind === "gcp.region" ? (data.node.props.region as string | undefined) ?? "us-central1" : undefined;
  const kindLabel = `${data.node.kind === "generic.group" ? "" : (entry?.label ?? "")}${region ? ` · ${region}` : ""}`;
  return (
    <div
      className={`gnode ${data.status ?? ""} ${selected ? "selected" : ""} head-${header}`}
      title={kindLabel || undefined}
      style={{
        borderStyle: border === "none" ? "solid" : border,
        borderColor: border === "none" ? "transparent" : color,
        borderWidth: Number(p.borderWidth ?? 1.5),
        background: fill === "none" ? "transparent" : fill,
      }}
    >
      <NodeResizer
        isVisible={selected && ctx.editable}
        minWidth={160}
        minHeight={80}
        lineClassName="sel-line"
        handleClassName="sel-handle"
        onResizeEnd={(_, r) => ctx.resized(id, { x: r.x, y: r.y, w: r.width, h: r.height })}
      />
      <div className="gnode-head" style={{ color }} onDoubleClick={() => ctx.editable && ctx.setEditing(id)}>
        {header === "tab" && <GroupTab kind={data.node.kind} icon={data.node.icon} color={color} />}
        {header === "icon" && <ResourceIcon kind={data.node.kind} icon={data.node.icon} size={20} />}
        <InlineText id={id} value={data.node.label} className="gnode-label" onCommit={(v) => ctx.rename(id, v)} />
        {kindLabel && (header === "icon" || header === "label") && <span className="gnode-kind">{kindLabel}</span>}
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

/** CSS font stacks for the catalog's FONTS. */
export const FONT_STACKS: Record<string, string> = {
  Sans: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  Helvetica: "Helvetica, Arial, sans-serif",
  Arial: "Arial, Helvetica, sans-serif",
  Verdana: "Verdana, Geneva, sans-serif",
  Georgia: "Georgia, serif",
  "Times New Roman": '"Times New Roman", Times, serif',
  "Courier New": '"Courier New", Courier, monospace',
  "Comic Sans MS": '"Comic Sans MS", "Comic Neue", cursive',
  Handwritten: '"Bradley Hand", "Segoe Print", "Comic Neue", cursive',
};

/** Thumbnail size for a shape in a box (keeps its proportions; circles stay round). */
export function thumbSize(shape: string, maxW: number, maxH: number): [number, number] {
  const [w, h] = SHAPE_LABELS[shape as ShapeName]?.size ?? [160, 70];
  const k = Math.min(maxW / w, maxH / h);
  return [Math.max(6, Math.round(w * k)), Math.max(6, Math.round(h * k))];
}

type SvgCommon = { fill: string; stroke: string; strokeWidth: number; vectorEffect: "non-scaling-stroke"; strokeDasharray?: string; strokeLinecap?: "round" };

/**
 * Arrow shapes, drawn pointing right along a length L and thickness T, then turned to face
 * their direction: block arrows, two-way arrows, chevrons and thin arrows.
 */
function arrowShape(shape: string, w: number, h: number, p: number, common: SvgCommon): React.ReactNode {
  const dir = shape.endsWith("left") && !shape.endsWith("left-right") ? "left" : shape.endsWith("up") ? "up" : shape.endsWith("down") && !shape.endsWith("up-down") ? "down" : shape.endsWith("up-down") ? "down" : "right";
  const vertical = dir === "up" || dir === "down";
  const L = vertical ? h : w;
  const T = vertical ? w : h;
  // (along, across) → (x, y) for the arrow's direction.
  const at = (a: number, c: number) => (dir === "right" ? [a, c] : dir === "left" ? [w - a, c] : dir === "down" ? [c, a] : [c, h - a]).join(",");
  const pts = (list: [number, number][]) => list.map(([a, c]) => at(a, c)).join(" ");
  if (shape.startsWith("thin-")) {
    const hl = Math.min(14, L * 0.3);
    const hw = Math.min(T / 2 - p, 7);
    return (
      <>
        <polyline points={pts([[p, T / 2], [L - hl, T / 2]])} {...common} fill="none" strokeWidth={common.strokeWidth + 0.4} />
        <polygon points={pts([[L - hl, T / 2 - hw], [L - p, T / 2], [L - hl, T / 2 + hw]])} {...common} fill={common.stroke} />
      </>
    );
  }
  const head = Math.min(L * 0.38, T * 0.9);
  const y1 = T * 0.27;
  const y2 = T * 0.73;
  if (shape === "chevron") {
    const k = Math.min(L * 0.3, T * 0.5);
    return <polygon points={pts([[p, p], [L - k, p], [L - p, T / 2], [L - k, T - p], [p, T - p], [p + k, T / 2]])} {...common} />;
  }
  if (shape.endsWith("left-right") || shape.endsWith("up-down")) {
    const hd = Math.min(L * 0.3, T * 0.9);
    return (
      <polygon
        points={pts([[p, T / 2], [hd, p], [hd, y1], [L - hd, y1], [L - hd, p], [L - p, T / 2], [L - hd, T - p], [L - hd, y2], [hd, y2], [hd, T - p]])}
        {...common}
      />
    );
  }
  return <polygon points={pts([[p, y1], [L - head, y1], [L - head, p], [L - p, T / 2], [L - head, T - p], [L - head, y2], [p, y2]])} {...common} />;
}

/** SVG outline for a general shape at its real pixel size (so it stays crisp when resized). */
export function ShapeOutline({
  shape,
  w,
  h,
  fill,
  stroke,
  sw = 1.6,
  dash,
  shadow,
}: {
  shape: string;
  w: number;
  h: number;
  fill: string;
  stroke: string;
  sw?: number;
  dash?: string;
  shadow?: boolean;
}) {
  const p = sw / 2 + 0.5;
  const W = w - p;
  const H = h - p;
  fill = fill === "none" ? "transparent" : fill;
  const dasharray = dash === "dashed" ? `${sw * 4} ${sw * 3}` : dash === "dotted" ? `${Math.max(1, sw * 0.8)} ${sw * 2.5}` : undefined;
  const common = { fill, stroke, strokeWidth: sw, vectorEffect: "non-scaling-stroke" as const, strokeDasharray: dasharray, strokeLinecap: dash === "dotted" ? ("round" as const) : undefined };
  const solid = { ...common, fill: stroke };
  const open = { ...common, fill: "none" };
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
    case "line":
      el = <line x1={p} y1={h / 2} x2={W} y2={h / 2} {...common} strokeWidth={sw + 0.4} />;
      break;
    case "vline":
      el = <line x1={w / 2} y1={p} x2={w / 2} y2={H} {...common} strokeWidth={sw + 0.4} />;
      break;
    case "square":
    case "activation":
      el = <rect x={p} y={p} width={W - p} height={H - p} {...common} />;
      break;
    case "heading":
      el = null;
      break;
    case "internal-storage": {
      const k = Math.min(14, w * 0.15, h * 0.15);
      el = (
        <>
          <rect x={p} y={p} width={W - p} height={H - p} {...common} />
          <line x1={p + k} y1={p} x2={p + k} y2={H} {...open} />
          <line x1={p} y1={p + k} x2={W} y2={p + k} {...open} />
        </>
      );
      break;
    }
    case "cube": {
      const d = Math.min(16, w * 0.16, h * 0.16);
      el = (
        <>
          <rect x={p} y={p + d} width={W - d - p} height={H - d - p} {...common} />
          <polygon points={`${p},${p + d} ${p + d},${p} ${W},${p} ${W - d},${p + d}`} {...common} />
          <polygon points={`${W - d},${p + d} ${W},${p} ${W},${H - d} ${W - d},${H}`} {...common} />
        </>
      );
      break;
    }
    case "trapezoid": {
      const k = Math.min(26, w * 0.2);
      el = <polygon points={`${p + k},${p} ${W - k},${p} ${W},${H} ${p},${H}`} {...common} />;
      break;
    }
    case "tape": {
      const a = Math.min(10, h * 0.12);
      el = <path d={`M${p},${p + a} C${w * 0.33},${p - a} ${w * 0.66},${p + 3 * a} ${W},${p + a} V${H - a} C${w * 0.66},${H - 3 * a} ${w * 0.33},${H + a} ${p},${H - a} Z`} {...common} />;
      break;
    }
    case "page": {
      const f = Math.min(16, w * 0.25, h * 0.25);
      el = (
        <>
          <polygon points={`${p},${p} ${W - f},${p} ${W},${p + f} ${W},${H} ${p},${H}`} {...common} />
          <polyline points={`${W - f},${p} ${W - f},${p + f} ${W},${p + f}`} {...open} />
        </>
      );
      break;
    }
    case "card": {
      const c = Math.min(18, w * 0.25, h * 0.25);
      el = <polygon points={`${p + c},${p} ${W},${p} ${W},${H} ${p},${H} ${p},${p + c}`} {...common} />;
      break;
    }
    case "callout":
    case "callout-round": {
      const bh = h * 0.74;
      const r = shape === "callout-round" ? Math.min(12, w * 0.12, bh * 0.25) : 0;
      el = (
        <path
          d={`M${p + r},${p} H${W - r} Q${W},${p} ${W},${p + r} V${bh - r} Q${W},${bh} ${W - r},${bh} H${w * 0.36} L${w * 0.16},${H} L${w * 0.22},${bh} H${p + r} Q${p},${bh} ${p},${bh - r} V${p + r} Q${p},${p} ${p + r},${p} Z`}
          {...common}
        />
      );
      break;
    }
    case "actor": {
      const r = Math.min(w, h) * 0.13;
      el = (
        <>
          <circle cx={w / 2} cy={p + r} r={r} {...common} />
          <line x1={w / 2} y1={p + 2 * r} x2={w / 2} y2={h * 0.64} {...open} />
          <line x1={p} y1={h * 0.38} x2={W} y2={h * 0.38} {...open} />
          <polyline points={`${p},${H} ${w / 2},${h * 0.64} ${W},${H}`} {...open} />
        </>
      );
      break;
    }
    case "delay":
      el = <path d={`M${p},${p} H${w / 2} A${W - w / 2},${(H - p) / 2} 0 0 1 ${w / 2},${H} H${p} Z`} {...common} />;
      break;
    case "data-storage": {
      const k = Math.min(16, w * 0.15);
      el = <path d={`M${p + k},${p} H${W} Q${W - 2 * k},${h / 2} ${W},${H} H${p + k} Q${p - k},${h / 2} ${p + k},${p} Z`} {...common} />;
      break;
    }
    case "container":
    case "list":
    case "entity":
    case "class":
      el = (
        <>
          <rect x={p} y={p} width={W - p} height={H - p} {...common} />
          <line x1={p} y1={Math.min(26, h - p)} x2={W} y2={Math.min(26, h - p)} {...open} />
        </>
      );
      break;
    case "weak-entity":
      el = (
        <>
          <rect x={p} y={p} width={W - p} height={H - p} {...common} />
          <rect x={p + 4} y={p + 4} width={W - p - 8} height={H - p - 8} {...open} />
        </>
      );
      break;
    case "package": {
      const tw = Math.min(60, w * 0.4);
      el = (
        <>
          <rect x={p} y={p} width={tw} height={16} {...common} />
          <rect x={p} y={p + 16} width={W - p} height={H - p - 16} {...common} />
        </>
      );
      break;
    }
    case "component":
      el = (
        <>
          <rect x={p + 10} y={p} width={W - p - 10} height={H - p} {...common} />
          <rect x={p} y={h * 0.25} width={20} height={12} {...common} />
          <rect x={p} y={h * 0.55} width={20} height={12} {...common} />
        </>
      );
      break;
    case "lifeline": {
      const top = Math.min(40, h * 0.3);
      el = (
        <>
          <rect x={p} y={p} width={W - p} height={top} {...common} />
          <line x1={w / 2} y1={p + top} x2={w / 2} y2={H} {...open} strokeDasharray="6 4" />
        </>
      );
      break;
    }
    case "frame": {
      const tw = Math.min(70, w * 0.4);
      el = (
        <>
          <rect x={p} y={p} width={W - p} height={H - p} {...common} />
          <polyline points={`${p},${p + 22} ${p + tw - 8},${p + 22} ${p + tw},${p + 14} ${p + tw},${p}`} {...open} />
        </>
      );
      break;
    }
    case "initial":
      el = <ellipse cx={w / 2} cy={h / 2} rx={w / 2 - p} ry={h / 2 - p} {...solid} />;
      break;
    case "final":
      el = (
        <>
          <ellipse cx={w / 2} cy={h / 2} rx={w / 2 - p} ry={h / 2 - p} {...common} fill="#fff" />
          <ellipse cx={w / 2} cy={h / 2} rx={(w / 2 - p) * 0.62} ry={(h / 2 - p) * 0.62} {...solid} />
        </>
      );
      break;
    case "fork":
      el = <rect x={p} y={p} width={W - p} height={H - p} {...solid} />;
      break;
    case "curve-arrow":
      el = (
        <>
          <path d={`M${p + 2},${H - 2} C${w * 0.95},${H} ${w * 0.05},${p + 10} ${W - 14},${p + 10}`} {...open} />
          <polygon points={`${W - 15},${p + 3} ${W},${p + 10} ${W - 15},${p + 17}`} {...solid} />
        </>
      );
      break;
    case "diag-line":
    case "diag-arrow":
    case "diag-double-arrow": {
      const len = Math.hypot(W - p, H - p);
      const ux = (W - p) / len;
      const uy = (p - H) / len;
      const head = (x: number, y: number, dx: number, dy: number) =>
        `${x},${y} ${x - 13 * dx - 5 * dy},${y - 13 * dy + 5 * dx} ${x - 13 * dx + 5 * dy},${y - 13 * dy - 5 * dx}`;
      const two = shape === "diag-double-arrow";
      const one = shape !== "diag-line";
      el = (
        <>
          <line x1={p + (two ? 10 * ux : 0)} y1={H + (two ? 10 * uy : 0)} x2={W - (one ? 10 * ux : 0)} y2={p - (one ? 10 * uy : 0)} {...open} />
          {one && <polygon points={head(W, p, ux, uy)} {...solid} strokeDasharray={undefined} />}
          {two && <polygon points={head(p, H, -ux, -uy)} {...solid} strokeDasharray={undefined} />}
        </>
      );
      break;
    }
    case "diag-arrow-block":
    case "diag-double-block": {
      const L = Math.min(w, h) * 0.98;
      const T = L * 0.42;
      el = (
        <g transform={`translate(${(w - L) / 2},${(h - T) / 2}) rotate(-45 ${L / 2} ${T / 2})`}>
          {arrowShape(shape === "diag-double-block" ? "arrow-left-right" : "arrow-right", L, T, p, common)}
        </g>
      );
      break;
    }
    default:
      if (shape.includes("arrow") || shape === "chevron") el = arrowShape(shape, w, h, p, common);
      else
      el = <rect x={p} y={p} width={W - p} height={H - p} {...common} />;
  }
  return (
    <svg className={`shape-svg ${shadow ? "shadow" : ""}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
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
      style={{
        color: String(p.textColor),
        fontFamily: FONT_STACKS[String(p.font)] ?? undefined,
        ["--shape-font-size" as string]: `${p.fontSize}px`,
        fontWeight: p.bold ? 700 : undefined,
        fontStyle: p.italic ? "italic" : undefined,
      }}
      onDoubleClick={() => ctx.editable && ctx.setEditing(id)}
    >
      <NodeResizer
        isVisible={selected && ctx.editable}
        minWidth={40}
        minHeight={24}
        lineClassName="sel-line"
        handleClassName="sel-handle"
        onResizeEnd={(_, r) => ctx.resized(id, { x: r.x, y: r.y, w: r.width, h: r.height })}
      />
      <ShapeOutline shape={shape} w={w} h={h} fill={String(p.fill)} stroke={String(p.stroke)} sw={Number(p.strokeWidth)} dash={String(p.lineStyle)} shadow={Boolean(p.shadow)} />
      {ROW_SHAPES.has(shape) && ctx.editing !== id ? (
        <RowsText shape={shape} text={data.node.label} stroke={String(p.stroke)} />
      ) : (
        <div className={`shape-label at-${LABEL_AT[shape] ?? "center"} ${ROW_SHAPES.has(shape) ? "rows-editing" : ""}`}>
          <InlineText id={id} value={data.node.label} multiline onCommit={(v) => ctx.rename(id, v)} />
        </div>
      )}
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

/** Where a shape's label sits (default: centred). */
const LABEL_AT: Record<string, string> = {
  cylinder: "low",
  actor: "below",
  lifeline: "head",
  frame: "tag",
  package: "body",
  component: "right",
  callout: "bubble",
  "callout-round": "bubble",
  cube: "front",
  page: "center",
};

/**
 * Text laid out in rows: the first line is the title (in the header band), the rest are rows.
 * In a class, a line of "--" starts the next compartment (attributes, then operations).
 */
function RowsText({ shape, text, stroke }: { shape: string; text: string; stroke: string }) {
  const [title, ...rest] = text.split("\n");
  if (shape === "heading")
    return (
      <div className="rows heading">
        <div className="rows-heading">{title}</div>
        <div className="rows-para">{rest.join("\n")}</div>
      </div>
    );
  if (shape === "container")
    return (
      <div className="rows">
        <div className="rows-title">{title}</div>
      </div>
    );
  const groups: string[][] = [[]];
  for (const line of rest) {
    if (shape === "class" && /^-{2,}$/.test(line.trim())) groups.push([]);
    else groups[groups.length - 1].push(line);
  }
  return (
    <div className={`rows ${shape}`}>
      <div className="rows-title">{title}</div>
      {groups.map((g, i) => (
        <div key={i} className="rows-group" style={i ? { borderTopColor: stroke } : undefined}>
          {g.map((line, j) => (
            <div key={j} className="rows-line" style={shape === "list" && j ? { borderTopColor: stroke } : undefined}>
              {line || "\u00a0"}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const SIDE_POS: Record<Side, Position> = { t: Position.Top, r: Position.Right, b: Position.Bottom, l: Position.Left };

export const nodeTypes = { resource: ResourceNode, group: GroupNode, note: NoteNode, shape: ShapeNode };

/** Connection drawn orthogonal, straight or curved, with a label you can double-click to edit. */
type EdgeData = {
  routing?: Routing;
  label?: string;
  editable?: boolean;
  color: string;
  width: number;
  dash?: string;
  arrowStart?: Arrowhead;
  arrowEnd?: Arrowhead;
  labelDx?: number;
  labelDy?: number;
  status?: string;
};

/** Arrowhead drawn in the line's colour; `auto-start-reverse` lets one marker serve both ends. */
function Marker({ id, kind, color }: { id: string; kind: Arrowhead; color: string }) {
  if (kind === "none") return null;
  if (kind.startsWith("er-")) {
    // Crow's-foot notation; the line meets the entity at x = 12.
    const d =
      kind === "er-one"
        ? "M0,6 H12 M5,1 V11 M8,1 V11"
        : kind === "er-many"
          ? "M0,6 H12 M3,6 L12,1 M3,6 L12,11"
          : kind === "er-one-many"
            ? "M0,6 H12 M2.5,1 V11 M5,6 L12,1 M5,6 L12,11"
            : kind === "er-zero-many"
              ? "M6,6 H12 M6,6 L12,1 M6,6 L12,11"
              : "M5.6,6 H12 M8.5,1 V11";
    return (
      <marker id={id} viewBox="-1 0 14 12" refX={12} refY={6} markerWidth={14} markerHeight={12} markerUnits="userSpaceOnUse" orient="auto-start-reverse">
        <path d={d} fill="none" stroke={color} strokeWidth={1.3} />
        {(kind === "er-zero-many" || kind === "er-zero-one") && <circle cx={3} cy={6} r={2.6} fill="#fff" stroke={color} strokeWidth={1.3} />}
      </marker>
    );
  }
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
          <EdgeLabel id={id} x={lx} y={ly} dx={data?.labelDx ?? 0} dy={data?.labelDy ?? 0} editing={editing} moved={Boolean(data?.labelDx || data?.labelDy)}>
            <InlineText id={`edge:${id}`} value={data?.label ?? text} onCommit={(v) => ctx.renameEdge(id, v)} />
          </EdgeLabel>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/**
 * A line's label. Drag it anywhere (it stays attached to the line and follows it when shapes
 * move, as in draw.io); double-click to edit. A dotted lead-in shows which line it belongs to.
 */
function EdgeLabel({ id, x, y, dx, dy, editing, moved, children }: { id: string; x: number; y: number; dx: number; dy: number; editing: boolean; moved: boolean; children: React.ReactNode }) {
  const ctx = useContext(EditorContext);
  const { zoom } = useViewport();
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const start = useRef<{ px: number; py: number; moved: boolean } | null>(null);
  const ox = dx + (drag?.x ?? 0);
  const oy = dy + (drag?.y ?? 0);
  return (
    <>
      {(moved || drag) && (
        <svg className="edge-label-lead" style={{ transform: `translate(${Math.min(x, x + ox)}px, ${Math.min(y, y + oy)}px)` }} width={Math.abs(ox) + 1} height={Math.abs(oy) + 1}>
          <line x1={ox < 0 ? -ox : 0} y1={oy < 0 ? -oy : 0} x2={ox < 0 ? 0 : ox} y2={oy < 0 ? 0 : oy} />
        </svg>
      )}
      <div
        className={`edge-label nodrag nopan ${drag ? "dragging" : ""} ${ctx.editable && !editing ? "movable" : ""}`}
        style={{ transform: `translate(-50%, -50%) translate(${x + ox}px, ${y + oy}px)` }}
        onDoubleClick={() => ctx.editable && ctx.setEditing(`edge:${id}`)}
        onPointerDown={(e) => {
          if (!ctx.editable || editing || e.button !== 0) return;
          e.stopPropagation();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          start.current = { px: e.clientX, py: e.clientY, moved: false };
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (!s) return;
          const mx = (e.clientX - s.px) / zoom;
          const my = (e.clientY - s.py) / zoom;
          if (!s.moved && Math.hypot(mx, my) < 3) return;
          s.moved = true;
          setDrag({ x: mx, y: my });
        }}
        onPointerUp={() => {
          const s = start.current;
          start.current = null;
          if (s?.moved && drag) ctx.moveEdgeLabel(id, Math.round(dx + drag.x), Math.round(dy + drag.y));
          setDrag(null);
        }}
      >
        {children}
      </div>
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
        labelDx: e.labelDx ?? 0,
        labelDy: e.labelDy ?? 0,
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

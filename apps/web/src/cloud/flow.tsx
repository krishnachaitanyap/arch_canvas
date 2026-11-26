import { Handle, MarkerType, type Edge, type Node, type NodeProps, Position } from "@xyflow/react";
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
import { catalogEntry, childrenOf, type DiagramModel, type DiagramNode, type ModelDiff } from "@archcanvas/shared";
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

function ResourceNode({ data, selected }: NodeProps<CloudNode>) {
  const entry = catalogEntry(data.node.kind);
  return (
    <div className={`rnode ${data.status ?? ""} ${selected ? "selected" : ""}`} title={entry?.description}>
      <Handle type="target" position={Position.Left} />
      <ResourceIcon kind={data.node.kind} icon={data.node.icon} />
      <div className="rnode-text">
        <div className="rnode-label">{data.node.label}</div>
        <div className="rnode-kind">{entry?.label ?? data.node.kind}</div>
      </div>
      {data.issues ? <span className="rnode-badge" title={`${data.issues} warning(s)`}>{data.issues}</span> : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function GroupNode({ data, selected }: NodeProps<CloudNode>) {
  const entry = catalogEntry(data.node.kind);
  const color = entry?.icon.color ?? "#80868b";
  const region = data.node.kind === "gcp.region" ? (data.node.props.region as string | undefined) ?? "us-central1" : undefined;
  return (
    <div className={`gnode ${data.status ?? ""} ${selected ? "selected" : ""}`} style={{ borderColor: color }}>
      <div className="gnode-head" style={{ color }}>
        <ResourceIcon kind={data.node.kind} icon={data.node.icon} size={20} />
        <span className="gnode-label">{data.node.label}</span>
        <span className="gnode-kind">
          {entry?.label}
          {region ? ` · ${region}` : ""}
        </span>
      </div>
    </div>
  );
}

export const nodeTypes = { resource: ResourceNode, group: GroupNode };

/** Model → React Flow nodes/edges. Parents are emitted before children, as React Flow requires. */
export function toFlow(
  m: DiagramModel,
  opts: { diff?: ModelDiff; issues?: Map<string, number>; selected?: string | null; highlight?: Highlight | null } = {},
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
      const box = m.layout[n.id] ?? { x: 0, y: 0 };
      const w = box.w ?? NODE_W;
      const h = box.h ?? NODE_H;
      nodes.push({
        id: n.id,
        type: container ? "group" : "resource",
        position: { x: box.x, y: box.y },
        ...(n.parentId ? { parentId: n.parentId } : {}),
        data: { node: n, status: statusOf(n.id), issues: opts.issues?.get(n.id) },
        style: container ? { width: w, height: h } : { width: w },
        width: w,
        height: h,
        selected: opts.selected === n.id,
        zIndex: container ? 0 : 10,
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
      type: "smoothstep",
      animated: status === "added" || Boolean(current),
      zIndex: current ? 30 : 20,
      className: [status ?? "", hl ? (current ? "hl" : visited ? "visited" : "dim") : ""].join(" ").trim(),
      style: { stroke: color, strokeWidth: current ? 3 : visited ? 2 : 1.6, ...(status === "removed" ? { strokeDasharray: "6 4" } : {}) },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 },
      labelStyle: { fontSize: 11, fill: "#3c4043" },
      labelBgStyle: { fill: "#fff" },
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

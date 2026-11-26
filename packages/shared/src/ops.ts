import { catalogEntry, propError } from "./catalog.js";
import {
  ancestorsOf,
  type DiagramEdge,
  type DiagramModel,
  type DiagramNode,
  NODE_ID,
  nodeById,
  type Protocol,
  PROTOCOLS,
  type Routing,
} from "./model.js";

/** Every change to a model, by a person or the agent, is one of these operations. */
export type Op =
  | { op: "add_node"; id: string; kind: string; label: string; parentId?: string; props?: Record<string, unknown>; icon?: string }
  | { op: "update_node"; id: string; label?: string; parentId?: string | null; props?: Record<string, unknown>; icon?: string | null }
  | { op: "remove_node"; id: string }
  | { op: "connect"; from: string; to: string; label?: string; protocol?: Protocol; routing?: Routing }
  | { op: "update_edge"; from: string; to: string; label?: string | null; protocol?: Protocol | null; routing?: Routing | null }
  | { op: "disconnect"; from: string; to: string };

export type OpResult = { ok: true; model: DiagramModel } | { ok: false; error: string };

export const edgeId = (from: string, to: string) => `${from}__${to}`;

export function applyOp(m: DiagramModel, op: Op): OpResult {
  switch (op.op) {
    case "add_node": {
      if (!NODE_ID.test(op.id)) return fail(`id "${op.id}" must be snake_case (a-z, 0-9, _), max 41 chars`);
      if (nodeById(m, op.id)) return fail(`a node with id "${op.id}" already exists`);
      const entry = catalogEntry(op.kind);
      if (!entry) return fail(`unknown kind "${op.kind}"`);
      const parentErr = checkParent(m, op.id, op.kind, op.parentId);
      if (parentErr) return fail(parentErr);
      const propsErr = checkProps(op.kind, op.props);
      if (propsErr) return fail(propsErr);
      const node: DiagramNode = { id: op.id, kind: op.kind, label: op.label || entry.label, props: { ...op.props } };
      if (op.parentId) node.parentId = op.parentId;
      if (op.icon) node.icon = op.icon.slice(0, 240);
      return ok({ ...m, nodes: [...m.nodes, node] });
    }
    case "update_node": {
      const node = nodeById(m, op.id);
      if (!node) return fail(`no node with id "${op.id}"`);
      const next: DiagramNode = { ...node, props: { ...node.props } };
      if (op.label !== undefined) next.label = op.label;
      if (op.icon === null || op.icon === "") delete next.icon;
      else if (op.icon !== undefined) next.icon = op.icon.slice(0, 240);
      if (op.parentId !== undefined) {
        const parentId = op.parentId ?? undefined;
        const parentErr = checkParent(m, node.id, node.kind, parentId);
        if (parentErr) return fail(parentErr);
        if (parentId) next.parentId = parentId;
        else delete next.parentId;
      }
      if (op.props) {
        const propsErr = checkProps(node.kind, op.props);
        if (propsErr) return fail(propsErr);
        Object.assign(next.props, op.props);
      }
      const layout = { ...m.layout };
      if (op.parentId !== undefined) delete layout[node.id];
      return ok({ ...m, layout, nodes: m.nodes.map((n) => (n.id === node.id ? next : n)) });
    }
    case "remove_node": {
      const node = nodeById(m, op.id);
      if (!node) return fail(`no node with id "${op.id}"`);
      // Children move up to the removed node's parent rather than disappearing.
      const nodes = m.nodes
        .filter((n) => n.id !== op.id)
        .map((n) => (n.parentId === op.id ? withParent(n, node.parentId) : n));
      const edges = m.edges.filter((e) => e.from !== op.id && e.to !== op.id);
      const layout = { ...m.layout };
      delete layout[op.id];
      return ok({ ...m, nodes, edges, layout });
    }
    case "connect": {
      if (!nodeById(m, op.from)) return fail(`no node with id "${op.from}"`);
      if (!nodeById(m, op.to)) return fail(`no node with id "${op.to}"`);
      if (op.from === op.to) return fail("cannot connect a node to itself");
      if (catalogEntry(nodeById(m, op.from)!.kind)?.container || catalogEntry(nodeById(m, op.to)!.kind)?.container)
        return fail("connect resources, not groups (project, region, VPC, subnet)");
      if (op.protocol && !PROTOCOLS.includes(op.protocol)) return fail(`protocol must be one of ${PROTOCOLS.join(", ")}`);
      const id = edgeId(op.from, op.to);
      if (m.edges.some((e) => e.id === id)) return fail(`"${op.from}" is already connected to "${op.to}"`);
      const edge: DiagramEdge = { id, from: op.from, to: op.to };
      if (op.label) edge.label = op.label;
      if (op.protocol) edge.protocol = op.protocol;
      if (op.routing) edge.routing = op.routing;
      return ok({ ...m, edges: [...m.edges, edge] });
    }
    case "update_edge": {
      const id = edgeId(op.from, op.to);
      const e = m.edges.find((x) => x.id === id);
      if (!e) return fail(`"${op.from}" is not connected to "${op.to}"`);
      if (op.protocol && !PROTOCOLS.includes(op.protocol)) return fail(`protocol must be one of ${PROTOCOLS.join(", ")}`);
      const next: DiagramEdge = { ...e };
      for (const k of ["label", "protocol", "routing"] as const) {
        const v = op[k];
        if (v === null || v === "") delete next[k];
        else if (v !== undefined) (next as Record<string, unknown>)[k] = k === "label" ? String(v).slice(0, 60) : v;
      }
      return ok({ ...m, edges: m.edges.map((x) => (x.id === id ? next : x)) });
    }
    case "disconnect": {
      const id = edgeId(op.from, op.to);
      if (!m.edges.some((e) => e.id === id)) return fail(`"${op.from}" is not connected to "${op.to}"`);
      return ok({ ...m, edges: m.edges.filter((e) => e.id !== id) });
    }
  }
}

/** Applies operations in order; stops at the first failure. */
export function applyOps(m: DiagramModel, ops: Op[]): OpResult {
  let cur = m;
  for (const [i, op] of ops.entries()) {
    const r = applyOp(cur, op);
    if (!r.ok) return fail(`operation ${i + 1} (${op.op}): ${r.error}`);
    cur = r.model;
  }
  return ok(cur);
}

function checkParent(m: DiagramModel, id: string, kind: string, parentId: string | undefined): string | undefined {
  if (!parentId) return undefined;
  const parent = nodeById(m, parentId);
  if (!parent) return `no parent with id "${parentId}"`;
  if (parentId === id || ancestorsOf(m, parentId).some((a) => a.id === id)) return "a group cannot contain itself";
  const entry = catalogEntry(kind)!;
  if (!entry.parents.includes(parent.kind))
    return `${entry.label} cannot be placed inside ${catalogEntry(parent.kind)?.label ?? parent.kind}; allowed parents: ${
      entry.parents.map((p) => catalogEntry(p)?.label ?? p).join(", ") || "top level only"
    }`;
  return undefined;
}

function checkProps(kind: string, props: Record<string, unknown> | undefined): string | undefined {
  if (!props) return undefined;
  const specs = catalogEntry(kind)?.props ?? [];
  for (const [k, v] of Object.entries(props)) {
    const spec = specs.find((s) => s.key === k);
    if (!spec) return `unknown property "${k}" for ${kind}; known: ${specs.map((s) => s.key).join(", ") || "none"}`;
    const err = propError(spec, v);
    if (err) return err;
  }
  return undefined;
}

function withParent(n: DiagramNode, parentId: string | undefined): DiagramNode {
  const copy = { ...n };
  if (parentId) copy.parentId = parentId;
  else delete copy.parentId;
  return copy;
}

const ok = (model: DiagramModel): OpResult => ({ ok: true, model });
const fail = (error: string): OpResult => ({ ok: false, error });

export interface ModelDiff {
  addedNodes: string[];
  changedNodes: string[];
  removedNodes: string[];
  addedEdges: string[];
  removedEdges: string[];
}

export function diffModels(before: DiagramModel, after: DiagramModel): ModelDiff {
  const b = new Map(before.nodes.map((n) => [n.id, n]));
  const a = new Map(after.nodes.map((n) => [n.id, n]));
  const be = new Set(before.edges.map((e) => e.id));
  const ae = new Set(after.edges.map((e) => e.id));
  return {
    addedNodes: [...a.keys()].filter((id) => !b.has(id)),
    removedNodes: [...b.keys()].filter((id) => !a.has(id)),
    changedNodes: [...a.keys()].filter((id) => b.has(id) && JSON.stringify(b.get(id)) !== JSON.stringify(a.get(id))),
    addedEdges: [...ae].filter((id) => !be.has(id)),
    removedEdges: [...be].filter((id) => !ae.has(id)),
  };
}

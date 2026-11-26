import { catalogEntry, resolvedProps } from "./catalog.js";
import type { DiagramEdge, DiagramModel, DiagramNode } from "./model.js";
import { compileTerraform } from "./terraform.js";

/**
 * Comparison between two versions of a diagram (or two different diagrams): a readable
 * change list, line diffs for text, and a Terraform diff of what would be deployed.
 */

export interface FieldChange {
  field: string;
  from: string;
  to: string;
}

export interface ChangeItem {
  change: "added" | "removed" | "changed";
  target: "resource" | "group" | "connection";
  id: string;
  label: string;
  /** Resource type label, or "A → B" for connections. */
  detail: string;
  fields: FieldChange[];
}

export function describeChanges(before: DiagramModel, after: DiagramModel): ChangeItem[] {
  const out: ChangeItem[] = [];
  const b = new Map(before.nodes.map((n) => [n.id, n]));
  const a = new Map(after.nodes.map((n) => [n.id, n]));
  const nameIn = (m: Map<string, DiagramNode>, id: string | undefined) => (id ? m.get(id)?.label ?? id : "top level");
  const target = (n: DiagramNode) => (catalogEntry(n.kind)?.container ? "group" : "resource");
  const typeLabel = (n: DiagramNode) => catalogEntry(n.kind)?.label ?? n.kind;

  for (const n of after.nodes) {
    const old = b.get(n.id);
    if (!old) {
      out.push({ change: "added", target: target(n), id: n.id, label: n.label, detail: typeLabel(n), fields: [] });
      continue;
    }
    const fields: FieldChange[] = [];
    if (old.kind !== n.kind) fields.push({ field: "type", from: typeLabel(old), to: typeLabel(n) });
    if (old.label !== n.label) fields.push({ field: "name", from: old.label, to: n.label });
    if ((old.parentId ?? "") !== (n.parentId ?? ""))
      fields.push({ field: "inside", from: nameIn(b, old.parentId), to: nameIn(a, n.parentId) });
    const op = resolvedProps(old.kind, old.props);
    const np = resolvedProps(n.kind, n.props);
    for (const key of new Set([...Object.keys(op), ...Object.keys(np)]))
      if (String(op[key] ?? "") !== String(np[key] ?? ""))
        fields.push({ field: propLabel(n.kind, key), from: fmt(op[key]), to: fmt(np[key]) });
    if (fields.length) out.push({ change: "changed", target: target(n), id: n.id, label: n.label, detail: typeLabel(n), fields });
  }
  for (const n of before.nodes)
    if (!a.has(n.id)) out.push({ change: "removed", target: target(n), id: n.id, label: n.label, detail: typeLabel(n), fields: [] });

  const be = new Map(before.edges.map((e) => [e.id, e]));
  const ae = new Map(after.edges.map((e) => [e.id, e]));
  const edgeName = (e: DiagramEdge, m: Map<string, DiagramNode>) => `${nameIn(m, e.from)} → ${nameIn(m, e.to)}`;
  for (const e of after.edges) {
    const old = be.get(e.id);
    if (!old) {
      out.push({ change: "added", target: "connection", id: e.id, label: e.label ?? e.protocol ?? "", detail: edgeName(e, a), fields: [] });
      continue;
    }
    const fields: FieldChange[] = [];
    if ((old.protocol ?? "") !== (e.protocol ?? "")) fields.push({ field: "protocol", from: old.protocol ?? "—", to: e.protocol ?? "—" });
    if ((old.label ?? "") !== (e.label ?? "")) fields.push({ field: "label", from: old.label ?? "—", to: e.label ?? "—" });
    if (fields.length) out.push({ change: "changed", target: "connection", id: e.id, label: e.label ?? "", detail: edgeName(e, a), fields });
  }
  for (const e of before.edges)
    if (!ae.has(e.id)) out.push({ change: "removed", target: "connection", id: e.id, label: e.label ?? e.protocol ?? "", detail: edgeName(e, b), fields: [] });
  return out;
}

function propLabel(kind: string, key: string): string {
  return catalogEntry(kind)?.props.find((p) => p.key === key)?.label ?? key;
}
const fmt = (v: unknown) => (v === undefined || v === "" ? "—" : typeof v === "boolean" ? (v ? "on" : "off") : String(v));

// ------------------------------------------------------------------ text diff

export interface DiffLine {
  op: "eq" | "add" | "del";
  text: string;
  /** 1-based line numbers in the old / new text. */
  a?: number;
  b?: number;
}

/** Line diff (longest common subsequence). Inputs up to a few thousand lines. */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const A = oldText === "" ? [] : oldText.replace(/\n$/, "").split("\n");
  const B = newText === "" ? [] : newText.replace(/\n$/, "").split("\n");
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a = A.slice(pre, A.length - suf);
  const b = B.slice(pre, B.length - suf);

  // LCS table over the differing middle section only.
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const out: DiffLine[] = [];
  let la = 1;
  let lb = 1;
  for (let k = 0; k < pre; k++) out.push({ op: "eq", text: A[k], a: la++, b: lb++ });
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "eq", text: a[i++], a: la++, b: lb++ });
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "del", text: a[i++], a: la++ });
    else out.push({ op: "add", text: b[j++], b: lb++ });
  }
  while (i < n) out.push({ op: "del", text: a[i++], a: la++ });
  while (j < m) out.push({ op: "add", text: b[j++], b: lb++ });
  for (let k = A.length - suf; k < A.length; k++) out.push({ op: "eq", text: A[k], a: la++, b: lb++ });
  return out;
}

export interface Hunk {
  lines: DiffLine[];
}

/** Groups a line diff into hunks with `context` unchanged lines around each change. */
export function hunks(lines: DiffLine[], context = 3): Hunk[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.op !== "eq") for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: Hunk[] = [];
  let cur: DiffLine[] | null = null;
  lines.forEach((l, i) => {
    if (keep[i]) (cur ??= []).push(l);
    else if (cur) {
      out.push({ lines: cur });
      cur = null;
    }
  });
  if (cur) out.push({ lines: cur });
  return out;
}

export interface FileDiff {
  path: string;
  status: "added" | "removed" | "changed" | "unchanged";
  added: number;
  removed: number;
  lines: DiffLine[];
}

/** Diff of the Terraform each model compiles to: what would change on deploy. */
export function terraformDiff(before: DiagramModel, after: DiagramModel): { files: FileDiff[]; resourcesAdded: string[]; resourcesRemoved: string[] } {
  const ta = compileTerraform(before);
  const tb = compileTerraform(after);
  const paths = [...new Set([...ta.files.map((f) => f.path), ...tb.files.map((f) => f.path)])];
  const files = paths.map((path): FileDiff => {
    const x = ta.files.find((f) => f.path === path)?.content ?? "";
    const y = tb.files.find((f) => f.path === path)?.content ?? "";
    const lines = lineDiff(x, y);
    const added = lines.filter((l) => l.op === "add").length;
    const removed = lines.filter((l) => l.op === "del").length;
    return { path, status: !x ? "added" : !y ? "removed" : added || removed ? "changed" : "unchanged", added, removed, lines };
  });
  const ra = new Set(ta.resources);
  const rb = new Set(tb.resources);
  return {
    files,
    resourcesAdded: tb.resources.filter((r) => !ra.has(r)),
    resourcesRemoved: ta.resources.filter((r) => !rb.has(r)),
  };
}

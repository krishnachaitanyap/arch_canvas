import { CATALOG, catalogEntry } from "./catalog.js";
import { ARROWHEADS, type Arrowhead, type DiagramEdge, type DiagramModel, type DiagramNode, NODE_ID, PROTOCOLS, type Protocol } from "./model.js";
import { edgeId } from "./ops.js";
import { pageOf, pagesOf } from "./pages.js";

/**
 * ArchCanvas diagram code (`.arch`): the diagram as plain text, in the spirit of Eraser's
 * diagram-as-code. It holds what the diagram means (items, groups, names, settings, lines,
 * tabs) but not where things sit, so diffs stay readable and code reviews are about the
 * architecture. Positions live on the canvas and are kept when code is applied.
 *
 *   // comments
 *   terraform on                                   canvas setting (shows cloud details)
 *   page ops "Operations" { … }                    a tab; only written when the canvas has tabs
 *   id "Name" [kind, key: value, icon: "pack:name"] { children }
 *   from -> to "label" [https, curved, color: "#1a73e8", end: diamond]
 *
 * Lines: `->` arrow at the end, `<-` at the start, `<->` both, `-` none. `--` is dashed,
 * `..` is dotted (`-->`, `<..>`, …). Eraser's `>`, `<`, `<>` work too.
 */

export interface CodeError {
  line: number;
  col: number;
  message: string;
}

export type ParseResult = { ok: true; model: DiagramModel } | { ok: false; errors: CodeError[]; model?: DiagramModel };

// ---------------------------------------------------------------- printing

const BARE = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;
const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;

function value(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return BARE.test(s) && s !== "true" && s !== "false" ? s : quote(s);
}

function arrowToken(e: DiagramEdge): { token: string; attrs: string[] } {
  const start: Arrowhead = e.arrowStart ?? "none";
  const end: Arrowhead = e.arrowEnd ?? "arrow";
  const body = e.dash === "dashed" ? "--" : e.dash === "dotted" ? ".." : "-";
  const attrs: string[] = [];
  if (start !== "none" && start !== "arrow") attrs.push(`start: ${start}`);
  if (end !== "none" && end !== "arrow") attrs.push(`end: ${end}`);
  return { token: `${start === "arrow" ? "<" : ""}${body}${end === "arrow" ? ">" : ""}`, attrs };
}

function edgeLine(e: DiagramEdge): string {
  const { token, attrs } = arrowToken(e);
  const all = [...(e.protocol ? [e.protocol] : []), ...(e.routing && e.routing !== "orthogonal" ? [e.routing] : []), ...attrs, ...(e.color ? [`color: ${quote(e.color)}`] : [])];
  return `${e.from} ${token} ${e.to}${e.label ? ` ${quote(e.label)}` : ""}${all.length ? ` [${all.join(", ")}]` : ""}`;
}

function nodeHead(n: DiagramNode): string {
  // Settings in the catalog's order, then any others alphabetically: the same text however the
  // diagram was stored (Postgres JSONB doesn't keep key order).
  const order = (catalogEntry(n.kind)?.props ?? []).map((p) => p.key);
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
  const props = Object.entries(n.props ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  const attrs = [n.kind, ...props.map(([k, v]) => `${k}: ${value(v)}`)];
  if (n.icon) attrs.push(`icon: ${quote(n.icon)}`);
  if (n.locked) attrs.push("locked: true");
  return `${n.id}${n.label ? ` ${quote(n.label)}` : ""} [${attrs.join(", ")}]`;
}

/** The diagram as code. Deterministic: the same diagram always prints the same text. */
export function toCode(m: DiagramModel): string {
  const out: string[] = ["// ArchCanvas diagram code: edit here or on the canvas, both stay in sync."];
  if (m.settings?.terraform) out.push("terraform on");
  const ids = new Set(m.nodes.map((n) => n.id));
  const kids = new Map<string | undefined, DiagramNode[]>();
  for (const n of m.nodes) {
    const p = n.parentId && ids.has(n.parentId) ? n.parentId : undefined;
    kids.set(p, [...(kids.get(p) ?? []), n]);
  }
  const emit = (n: DiagramNode, ind: string, lines: string[], seen: Set<string>) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    const children = kids.get(n.id) ?? [];
    if (!children.length) return void lines.push(ind + nodeHead(n));
    lines.push(`${ind}${nodeHead(n)} {`);
    for (const c of children) emit(c, ind + "  ", lines, seen);
    lines.push(`${ind}}`);
  };
  const section = (pageId: string | null, ind: string): string[] => {
    const lines: string[] = [];
    const seen = new Set<string>();
    const top = (kids.get(undefined) ?? []).filter((n) => pageId === null || pageOf(m, n.id) === pageId);
    for (const n of top) emit(n, ind, lines, seen);
    const onPage = (id: string) => pageId === null || pageOf(m, id) === pageId;
    const edges = m.edges.filter((e) => onPage(e.from));
    if (edges.length && lines.length) lines.push("");
    for (const e of edges) lines.push(ind + edgeLine(e));
    return lines;
  };
  if (!m.pages?.length) {
    const body = section(null, "");
    if (body.length) out.push("", ...body);
  } else {
    for (const p of pagesOf(m)) out.push("", `page ${p.id} ${quote(p.name)} {`, ...section(p.id, "  "), "}");
  }
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------- lexing

type Tok =
  | { t: "id"; v: string; line: number; col: number }
  | { t: "str"; v: string; line: number; col: number }
  | { t: "num"; v: number; line: number; col: number }
  | { t: "arrow"; v: string; line: number; col: number }
  | { t: "punct"; v: "[" | "]" | "{" | "}" | "," | ":"; line: number; col: number }
  | { t: "nl"; v: ""; line: number; col: number }
  | { t: "eof"; v: ""; line: number; col: number };

function lex(src: string, errors: CodeError[]): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const adv = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === "\n") {
        line++;
        col = 1;
      } else col++;
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      toks.push({ t: "nl", v: "", line, col });
      adv();
    } else if (c === " " || c === "\t" || c === "\r") adv();
    else if (c === "/" && src[i + 1] === "/") while (i < src.length && src[i] !== "\n") adv();
    else if (c === '"') {
      const l = line;
      const cl = col;
      adv();
      let s = "";
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\n") break;
        if (src[i] === "\\") {
          const e = src[i + 1];
          s += e === "n" ? "\n" : e === "t" ? "\t" : (e ?? "");
          adv(2);
        } else {
          s += src[i];
          adv();
        }
      }
      if (src[i] !== '"') errors.push({ line: l, col: cl, message: "missing closing quote (text in quotes ends on the same line; use \\n for a new line)" });
      else adv();
      toks.push({ t: "str", v: s, line: l, col: cl });
    } else if ("[]{},:".includes(c)) {
      toks.push({ t: "punct", v: c as "[", line, col });
      adv();
    } else if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(src[i + 1] ?? "") && /[\s:,[]/.test(src[i - 1] ?? " "))) {
      const m = /^-?\d+(\.\d+)?/.exec(src.slice(i))!;
      // A number followed by letters is a name (e.g. 10.0.0.0/24 is quoted; "2x" is a name).
      const rest = /^[A-Za-z_][\w.\-]*/.exec(src.slice(i + m[0].length));
      if (rest) {
        toks.push({ t: "id", v: m[0] + rest[0], line, col });
        adv(m[0].length + rest[0].length);
      } else {
        toks.push({ t: "num", v: Number(m[0]), line, col });
        adv(m[0].length);
      }
    } else if ("<>-.".includes(c)) {
      const m = /^[<>\-.]+/.exec(src.slice(i))!;
      toks.push({ t: "arrow", v: m[0], line, col });
      adv(m[0].length);
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][\w.\-]*/.exec(src.slice(i))!;
      // Don't swallow a following arrow: "a->b" is a, ->, b.
      let v = m[0];
      const cut = v.search(/-(-|\.|>|$)|\.\./);
      if (cut > 0) v = v.slice(0, cut);
      v = v.replace(/[.\-]+$/, "") || v;
      toks.push({ t: "id", v, line, col });
      adv(v.length);
    } else {
      errors.push({ line, col, message: `unexpected character "${c}"` });
      // Skip the rest of the line: what follows is unlikely to make sense.
      while (i < src.length && src[i] !== "\n") adv();
    }
  }
  toks.push({ t: "eof", v: "", line, col });
  return toks;
}

// ---------------------------------------------------------------- parsing

/** `->`, `<-`, `<->`, `-`, dashed `--`, dotted `..`; Eraser's `>`, `<`, `<>`. */
function parseArrow(v: string): { start: Arrowhead; end: Arrowhead; dash?: "dashed" | "dotted" } | null {
  const m = /^(<)?(-|--|\.\.)?(>)?$/.exec(v);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return { start: m[1] ? "arrow" : "none", end: m[3] ? "arrow" : "none", ...(m[2] === "--" ? { dash: "dashed" as const } : m[2] === ".." ? { dash: "dotted" as const } : {}) };
}

/** A kind by its full name (gcp.cloud_run) or, when unambiguous, its short name (cloud_run). */
function resolveKind(k: string): string | undefined {
  if (catalogEntry(k)) return k;
  const hits = CATALOG.filter((e) => e.kind.split(".").pop() === k);
  return hits.length === 1 ? hits[0].kind : undefined;
}

type Attr = { key?: string; value: string | number | boolean; tok: Tok };

/**
 * Parses diagram code. `base` is the diagram the code is replacing: positions, line handles
 * and label offsets are kept from it for items that are still there.
 */
export function parseCode(src: string, base?: DiagramModel): ParseResult {
  const errors: CodeError[] = [];
  const toks = lex(src, errors);
  let p = 0;
  const err = (t: Tok, message: string) => errors.push({ line: t.line, col: t.col, message });
  const peek = (k = 0) => toks[Math.min(p + k, toks.length - 1)];
  const next = () => toks[p++] ?? toks[toks.length - 1];
  const skipNl = () => {
    while (peek().t === "nl") p++;
  };
  const isP = (t: Tok, v: string) => t.t === "punct" && t.v === v;
  /** Skips to the end of the line after an error, so later lines are still checked. */
  const recover = () => {
    while (peek().t !== "nl" && peek().t !== "eof" && !isP(peek(), "}")) p++;
  };

  const nodes: DiagramNode[] = [];
  const edges: (DiagramEdge & { tok: Tok })[] = [];
  const pages: { id: string; name: string }[] = [];
  let terraform: boolean | undefined;

  function attrs(): Attr[] | null {
    const open = next(); // [
    const out: Attr[] = [];
    skipNl();
    if (isP(peek(), "]")) return (next(), out);
    for (;;) {
      skipNl();
      const t = next();
      if (t.t !== "id" && t.t !== "str" && t.t !== "num") return (err(t, "expected a name or value inside [ ]"), null);
      if (isP(peek(), ":")) {
        next();
        const v = next();
        if (t.t !== "id") return (err(t, "a setting name can't be in quotes"), null);
        if (v.t === "id") out.push({ key: t.v, value: v.v === "true" ? true : v.v === "false" ? false : v.v, tok: t });
        else if (v.t === "str" || v.t === "num") out.push({ key: t.v, value: v.v, tok: t });
        else return (err(v, `expected a value for "${t.v}"`), null);
      } else out.push({ value: t.v, tok: t });
      skipNl();
      const sep = next();
      if (isP(sep, "]")) return out;
      if (!isP(sep, ",")) return (err(sep.t === "eof" ? open : sep, sep.t === "eof" ? "missing ]" : "expected , or ]"), null);
    }
  }

  function edge(from: Tok): void {
    const arrowTok = next();
    const arrow = parseArrow(String(arrowTok.v));
    if (!arrow) return void (err(arrowTok, `"${arrowTok.v}" is not a line; use ->, <-, <->, -, -->, ..> and so on`), recover());
    const to = next();
    if (to.t !== "id") return void (err(to, "expected the name of the item the line goes to"), recover());
    const e: DiagramEdge & { tok: Tok } = { id: edgeId(from.v as string, to.v), from: from.v as string, to: to.v, tok: from };
    if (arrow.start !== "none") e.arrowStart = arrow.start;
    if (arrow.end !== "arrow") e.arrowEnd = arrow.end;
    if (arrow.dash) e.dash = arrow.dash;
    if (peek().t === "str") {
      const l = next();
      if ((l.v as string).length > 60) err(l, "line labels are at most 60 characters");
      if (l.v) e.label = (l.v as string).slice(0, 60);
    }
    if (isP(peek(), "[")) {
      const as = attrs();
      if (!as) return void recover();
      for (const a of as) {
        const v = String(a.value);
        if (!a.key) {
          if ((PROTOCOLS as readonly string[]).includes(v)) e.protocol = v as Protocol;
          else if (v === "straight" || v === "curved") e.routing = v;
          else if (v === "orthogonal") delete e.routing;
          else if (v === "dashed" || v === "dotted") e.dash = v;
          else if (v === "solid") delete e.dash;
          else err(a.tok, `unknown line option "${v}"; protocols are ${PROTOCOLS.join(", ")}`);
        } else if (a.key === "start" || a.key === "end") {
          if (!(ARROWHEADS as readonly string[]).includes(v)) err(a.tok, `${a.key} must be one of ${ARROWHEADS.join(", ")}`);
          else if (a.key === "start") v === "none" ? delete e.arrowStart : (e.arrowStart = v as Arrowhead);
          else v === "arrow" ? delete e.arrowEnd : (e.arrowEnd = v as Arrowhead);
        } else if (a.key === "color") {
          if (!/^#[0-9a-fA-F]{6}$/.test(v)) err(a.tok, 'color must be like "#1a73e8"');
          else e.color = v.toLowerCase();
        } else if (a.key === "protocol") {
          if (!(PROTOCOLS as readonly string[]).includes(v)) err(a.tok, `protocol must be one of ${PROTOCOLS.join(", ")}`);
          else e.protocol = v as Protocol;
        } else if (a.key === "label") e.label = v.slice(0, 60);
        else err(a.tok, `unknown line setting "${a.key}"`);
      }
    }
    if (peek().t !== "nl" && peek().t !== "eof" && !isP(peek(), "}")) return void (err(peek(), "expected the end of the line"), recover());
    edges.push(e);
  }

  function node(idTok: Tok, parentId: string | undefined, page: string | undefined): void {
    const id = idTok.v as string;
    let label = "";
    if (peek().t === "str") label = next().v as string;
    if (!isP(peek(), "[")) return void (err(peek(), `expected [type] after "${id}", e.g. ${id} "Name" [gcp.cloud_run]`), recover());
    const as = attrs();
    if (!as) return void recover();
    const n: DiagramNode = { id, kind: "", label, props: {} };
    if (!NODE_ID.test(id)) err(idTok, `"${id}" must be snake_case: lowercase letters, digits and _ (max 41 characters)`);
    if (label.length > 500) err(idTok, "names are at most 500 characters");
    const [first, ...rest] = as;
    if (!first || first.key) err(idTok, `the first thing in [ ] is the type, e.g. [gcp.cloud_run]`);
    else {
      const kind = resolveKind(String(first.value));
      if (!kind) err(first.tok, `unknown type "${first.value}"; types are ${CATALOG.map((e) => e.kind).join(", ")}`);
      n.kind = kind ?? String(first.value);
    }
    for (const a of first?.key ? as : rest) {
      if (!a.key) err(a.tok, `"${a.value}" needs a setting name, like key: ${value(a.value)}`);
      else if (a.key === "icon") n.icon = String(a.value);
      else if (a.key === "locked") {
        if (a.value === true) n.locked = true;
        else if (a.value !== false) err(a.tok, "locked is true or false");
      }
      else n.props[a.key] = a.value;
    }
    if (parentId) n.parentId = parentId;
    if (page && !parentId) n.page = page;
    nodes.push(n);
    if (isP(peek(), "{")) {
      next();
      block(id, page, "}");
    }
  }

  function block(parentId: string | undefined, page: string | undefined, close: "}" | "eof"): void {
    for (;;) {
      skipNl();
      const t = peek();
      if (t.t === "eof") {
        if (close === "}") err(t, "missing }");
        return;
      }
      if (isP(t, "}")) {
        next();
        if (close === "eof") err(t, "unexpected }");
        else return;
        continue;
      }
      if (t.t === "id" && t.v === "terraform" && (peek(1).t === "id" || peek(1).t === "nl" || peek(1).t === "eof")) {
        next();
        const v = peek().t === "id" ? (next().v as string) : "on";
        if (v !== "on" && v !== "off") err(t, "write terraform on or terraform off");
        else if (parentId || page) err(t, "terraform on goes at the top of the code");
        terraform = v === "on";
        continue;
      }
      if (t.t === "id" && t.v === "page" && peek(1).t === "id" && (peek(2).t === "str" || isP(peek(2), "{"))) {
        next();
        const idTok = next();
        const name = peek().t === "str" ? (next().v as string) : (idTok.v as string);
        if (parentId || page) err(t, "tabs (page) can't be inside a group or another tab");
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(idTok.v as string)) err(idTok, "tab ids use lowercase letters, digits and -");
        if (pages.some((x) => x.id === idTok.v)) err(idTok, `there are two tabs called ${idTok.v}`);
        if (!name.trim()) err(idTok, "a tab needs a name");
        pages.push({ id: idTok.v as string, name: name.trim().slice(0, 60) || String(idTok.v) });
        skipNl();
        if (!isP(peek(), "{")) {
          err(peek(), "expected { after the tab name");
          recover();
          continue;
        }
        next();
        block(undefined, idTok.v as string, "}");
        continue;
      }
      if (t.t !== "id") {
        err(t, t.t === "str" ? "a name in quotes goes after the item's id, e.g. api \"Orders API\" [gcp.cloud_run]" : "expected an item or a line");
        next();
        recover();
        continue;
      }
      next();
      if (peek().t === "arrow") edge(t);
      else node(t, parentId, page);
    }
  }

  block(undefined, undefined, "eof");

  // ---- whole-diagram checks: ids, endpoints, nesting, tabs
  const byId = new Map<string, DiagramNode>();
  for (const n of nodes) {
    if (byId.has(n.id)) {
      const t = toks.find((x) => x.t === "id" && x.v === n.id);
      errors.push({ line: t?.line ?? 1, col: t?.col ?? 1, message: `"${n.id}" is used for two items; ids must be unique` });
    }
    byId.set(n.id, n);
  }
  const baseNode = new Map(base?.nodes.map((n) => [n.id, n]) ?? []);
  for (const n of nodes) {
    if (!n.parentId) continue;
    // Nesting the canvas already has (e.g. from an import) is left alone; new nesting is checked.
    if (baseNode.get(n.id)?.parentId === n.parentId && baseNode.get(n.id)?.kind === n.kind && baseNode.get(n.parentId)?.kind === byId.get(n.parentId)!.kind) continue;
    const parent = byId.get(n.parentId)!;
    const pe = catalogEntry(parent.kind);
    const entry = catalogEntry(n.kind);
    const t = toks.find((x) => x.t === "id" && x.v === n.id);
    if (pe && !pe.container) errors.push({ line: t?.line ?? 1, col: t?.col ?? 1, message: `${parent.id} (${pe.label}) can't contain other items` });
    else if (entry && pe && !entry.parents.includes(parent.kind))
      errors.push({ line: t?.line ?? 1, col: t?.col ?? 1, message: `${entry.label} can't be inside ${pe.label}; it can go in ${entry.parents.join(", ") || "the top level only"}` });
  }
  const model: DiagramModel = { schemaVersion: 1, nodes, edges: [], layout: {} };
  if (pages.length) model.pages = pages;
  // The first tab is where items without a tab live: keep the common shape (no page) for it.
  if (pages.length) for (const n of nodes) if (n.page === pages[0].id) delete n.page;
  const seenEdges = new Set<string>();
  for (const { tok, ...e } of edges) {
    const pos = { line: tok.line, col: tok.col };
    if (!byId.has(e.from)) errors.push({ ...pos, message: `no item called "${e.from}"` });
    else if (!byId.has(e.to)) errors.push({ ...pos, message: `no item called "${e.to}"` });
    else if (e.from === e.to) errors.push({ ...pos, message: "a line can't connect an item to itself" });
    else if (seenEdges.has(e.id)) errors.push({ ...pos, message: `${e.from} and ${e.to} are already connected` });
    else if (pageOf(model, e.from) !== pageOf(model, e.to)) errors.push({ ...pos, message: `${e.from} and ${e.to} are on different tabs` });
    else if (!base?.edges.some((b) => b.from === e.from && b.to === e.to) && (catalogEntry(byId.get(e.from)!.kind)?.container || catalogEntry(byId.get(e.to)!.kind)?.container))
      errors.push({ ...pos, message: "lines connect items, not groups (project, region, VPC, subnet)" });
    seenEdges.add(e.id);
    model.edges.push(e);
  }
  if (terraform) model.settings = { terraform: true };

  if (base) keepCanvas(model, base);
  // One error per line: the first one is the cause, later ones usually follow from it.
  errors.sort((a, b) => a.line - b.line || a.col - b.col);
  const shown = errors.filter((e, i) => i === 0 || errors[i - 1].line !== e.line);
  return shown.length ? { ok: false, errors: shown, model } : { ok: true, model };
}

/** Keeps what the code doesn't say from the canvas: positions, sizes, rotation, line handles and label offsets. */
function keepCanvas(model: DiagramModel, base: DiagramModel): void {
  const old = new Map(base.nodes.map((n) => [n.id, n]));
  for (const n of model.nodes) {
    const o = old.get(n.id);
    const l = base.layout[n.id];
    // Moved to another group: its position was relative to the old one, so it is placed again.
    if (o && l && (o.parentId ?? "") === (n.parentId ?? "") && (n.parentId || pageOf(base, n.id) === pageOf(model, n.id))) model.layout[n.id] = l;
  }
  const oldEdges = new Map(base.edges.map((e) => [`${e.from}>${e.to}`, e]));
  model.edges = model.edges.map((e) => {
    const o = oldEdges.get(`${e.from}>${e.to}`);
    if (!o) return e;
    const kept: Partial<DiagramEdge> = { id: o.id };
    for (const k of ["fromHandle", "toHandle", "labelDx", "labelDy"] as const) if (o[k] !== undefined) (kept as Record<string, unknown>)[k] = o[k];
    return { ...e, ...kept };
  });
  // Other canvas settings the code doesn't cover yet stay as they were.
  if (base.settings) {
    const { terraform: _t, ...rest } = base.settings;
    if (Object.keys(rest).length || model.settings) model.settings = { ...rest, ...model.settings };
  }
}

/** The code of a diagram, or nothing (for one side of a comparison that has no diagram). */
export function codeOf(m: DiagramModel | null | undefined): string {
  return m ? toCode(m) : "";
}

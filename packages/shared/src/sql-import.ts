import type { Arrowhead, DiagramEdge, DiagramModel, DiagramNode } from "./model.js";
import { edgeId } from "./ops.js";

/**
 * SQL schema (CREATE TABLE / ALTER TABLE … FOREIGN KEY) → entity-relationship diagram: one
 * entity shape per table with its columns, and a crow's-foot line per foreign key. Handles
 * the common Postgres, MySQL, SQLite and SQL Server DDL; anything else is skipped.
 */

export interface SqlTable {
  name: string;
  columns: { name: string; type: string; pk: boolean; notNull: boolean; unique: boolean }[];
  /** Foreign keys: these columns reference a table (and its columns). */
  fks: { columns: string[]; table: string; refColumns: string[] }[];
}

const ident = (s: string) => s.replace(/^[`"[]|[`"\]]$/g, "").split(".").pop()!.replace(/^[`"[]|[`"\]]$/g, "");

/** Strips comments and splits on top-level semicolons. */
function statements(sql: string): string[] {
  const clean = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of clean) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === ";") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Splits "a, b(1,2), c" on commas outside parentheses. */
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const cols = (s: string) => s.split(",").map((c) => ident(c.trim())).filter(Boolean);
const NAME = String.raw`([\w$."\`\[\]]+)`;

export function parseSqlSchema(sql: string): SqlTable[] {
  const tables = new Map<string, SqlTable>();
  for (const st of statements(sql)) {
    const create = new RegExp(String.raw`^create\s+(?:(?:global\s+|local\s+)?(?:temporary|temp)\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${NAME}\s*\(([\s\S]*)\)[^)]*$`, "i").exec(st);
    if (create) {
      const t: SqlTable = { name: ident(create[1]), columns: [], fks: [] };
      for (const part of splitTop(create[2])) {
        const pk = /^(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]*)\)/i.exec(part);
        const fk = /^(?:constraint\s+\S+\s+)?foreign\s+key\s*\(([^)]*)\)\s*references\s+([\w$."`[\]]+)\s*(?:\(([^)]*)\))?/i.exec(part);
        const uq = /^(?:constraint\s+\S+\s+)?unique\s*(?:key\s*\S*\s*)?\(([^)]*)\)/i.exec(part);
        if (pk) {
          for (const c of cols(pk[1])) {
            const col = t.columns.find((x) => x.name === c);
            if (col) col.pk = true;
          }
        } else if (fk) t.fks.push({ columns: cols(fk[1]), table: ident(fk[2]), refColumns: fk[3] ? cols(fk[3]) : [] });
        else if (uq) {
          const only = cols(uq[1]);
          if (only.length === 1) {
            const col = t.columns.find((x) => x.name === only[0]);
            if (col) col.unique = true;
          }
        } else if (/^(constraint|check|index|key|exclude|fulltext|spatial)\b/i.test(part)) continue;
        else {
          const m = /^([`"[]?[\w$ ]+?[`"\]]?)\s+([\w]+(?:\s*\([^)]*\))?(?:\s+(?:varying|precision|with(?:out)?\s+time\s+zone|unsigned))*(?:\[\])?)([\s\S]*)$/i.exec(part);
          if (!m) continue;
          const rest = m[3];
          const name = ident(m[1].trim());
          t.columns.push({
            name,
            type: m[2].replace(/\s+/g, " ").toLowerCase(),
            pk: /\bprimary\s+key\b/i.test(rest),
            notNull: /\bnot\s+null\b/i.test(rest) || /\bprimary\s+key\b/i.test(rest),
            unique: /\bunique\b/i.test(rest),
          });
          const ref = /\breferences\s+([\w$."`[\]]+)\s*(?:\(([^)]*)\))?/i.exec(rest);
          if (ref) t.fks.push({ columns: [name], table: ident(ref[1]), refColumns: ref[2] ? cols(ref[2]) : [] });
        }
      }
      tables.set(t.name.toLowerCase(), t);
      continue;
    }
    const alter = new RegExp(String.raw`^alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?${NAME}\s+add\s+(?:constraint\s+\S+\s+)?foreign\s+key\s*\(([^)]*)\)\s*references\s+${NAME}\s*(?:\(([^)]*)\))?`, "i").exec(st);
    if (alter) tables.get(ident(alter[1]).toLowerCase())?.fks.push({ columns: cols(alter[2]), table: ident(alter[3]), refColumns: alter[4] ? cols(alter[4]) : [] });
    const alterPk = new RegExp(String.raw`^alter\s+table\s+(?:only\s+)?${NAME}\s+add\s+(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]*)\)`, "i").exec(st);
    if (alterPk) {
      const t = tables.get(ident(alterPk[1]).toLowerCase());
      for (const c of cols(alterPk[2])) {
        const col = t?.columns.find((x) => x.name === c);
        if (col) col.pk = true;
      }
    }
  }
  return [...tables.values()];
}

const nodeId = (name: string, taken: Set<string>) => {
  let base = name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "table";
  if (!/^[a-z]/.test(base)) base = `t_${base}`;
  base = base.slice(0, 36);
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}_${i}`;
  taken.add(id);
  return id;
};

/** An entity-relationship diagram of the schema. Tables are placed in a grid; Auto layout tidies them. */
export function sqlToModel(sql: string): DiagramModel {
  const tables = parseSqlSchema(sql);
  if (!tables.length) throw new Error("No CREATE TABLE statements found");
  const taken = new Set<string>();
  const ids = new Map(tables.map((t) => [t.name.toLowerCase(), nodeId(t.name, taken)]));
  const nodes: DiagramNode[] = [];
  const layout: DiagramModel["layout"] = {};
  const perRow = Math.ceil(Math.sqrt(tables.length));
  let rowY = 0;
  let rowH = 0;
  tables.forEach((t, i) => {
    const fkCols = new Set(t.fks.flatMap((f) => f.columns));
    const lines = t.columns.map((c) => `${c.name}: ${c.type}${c.pk ? " PK" : ""}${fkCols.has(c.name) ? " FK" : ""}${!c.pk && c.unique ? " UQ" : ""}`);
    const label = [t.name, ...lines].join("\n").slice(0, 500);
    const id = ids.get(t.name.toLowerCase())!;
    nodes.push({ id, kind: "generic.shape", label, props: { shape: "entity" } });
    const w = Math.max(170, Math.min(320, 40 + 7 * Math.max(t.name.length, ...lines.map((l) => l.length))));
    const h = 32 + 20 * Math.max(1, lines.length);
    if (i % perRow === 0 && i) {
      rowY += rowH + 80;
      rowH = 0;
    }
    rowH = Math.max(rowH, h);
    layout[id] = { x: (i % perRow) * 360, y: rowY, w, h };
  });
  const edges: DiagramEdge[] = [];
  for (const t of tables)
    for (const fk of t.fks) {
      const from = ids.get(t.name.toLowerCase())!;
      const to = ids.get(fk.table.toLowerCase());
      if (!to || to === from || edges.some((e) => e.id === edgeId(from, to))) continue;
      const columns = t.columns.filter((c) => fk.columns.includes(c.name));
      // One child row per parent when the key is unique (or the whole primary key); else many.
      const one = columns.length > 0 && columns.every((c) => c.unique || (c.pk && t.columns.filter((x) => x.pk).length === fk.columns.length));
      const optional = columns.some((c) => !c.notNull);
      const arrowStart: Arrowhead = one ? "er-one" : optional ? "er-zero-many" : "er-one-many";
      const arrowEnd: Arrowhead = optional ? "er-zero-one" : "er-one";
      edges.push({ id: edgeId(from, to), from, to, label: fk.columns.join(", ").slice(0, 60), arrowStart, arrowEnd, routing: "orthogonal" });
    }
  return { schemaVersion: 1, nodes, edges, layout };
}

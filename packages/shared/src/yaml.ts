/**
 * A small YAML reader for configuration files (Kubernetes manifests, docker-compose). It
 * covers what those files use: block mappings and sequences, plain and quoted scalars,
 * flow [lists] and {maps}, block scalars (| and >), comments and multiple documents.
 * Anchors, aliases and tags are read as plain values. No dependencies.
 */

export type Yaml = null | boolean | number | string | Yaml[] | { [k: string]: Yaml };

interface Line {
  indent: number;
  text: string;
  no: number;
}

function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q && s[i - 1] !== "\\") q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function scalar(raw: string): Yaml {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2)
    return s.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith("[") && s.endsWith("]")) return splitFlow(s.slice(1, -1)).map(scalar);
  if (s.startsWith("{") && s.endsWith("}")) {
    const o: Record<string, Yaml> = {};
    for (const part of splitFlow(s.slice(1, -1))) {
      const i = keySplit(part);
      if (i < 0) o[String(scalar(part))] = null;
      else o[String(scalar(part.slice(0, i)))] = scalar(part.slice(i + 1));
    }
    return o;
  }
  // Anchors and tags in front of a value: &name value, !!str value
  const tagged = /^(?:[&!][^\s]+\s+)+(.*)$/.exec(s);
  if (tagged) return scalar(tagged[1]);
  if (/^(true|True|TRUE|yes|Yes|on|On)$/.test(s)) return s === "yes" || s === "Yes" || s === "on" || s === "On" ? s : true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?(\d+|\d*\.\d+)([eE][-+]?\d+)?$/.test(s) && !/^0\d/.test(s)) return Number(s);
  return s;
}

function splitFlow(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q: string | null = null;
  let cur = "";
  for (const c of s) {
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Index of the ": " (or trailing ":") that ends a mapping key, outside quotes and brackets. */
function keySplit(s: string): number {
  let q: string | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === ":" && depth === 0 && (i === s.length - 1 || s[i + 1] === " " || s[i + 1] === "\t")) return i;
  }
  return -1;
}

class Parser {
  i = 0;
  constructor(private lines: Line[]) {}

  peek(): Line | undefined {
    return this.lines[this.i];
  }

  /** A block at this indentation: a mapping or a sequence. */
  block(indent: number): Yaml {
    const first = this.peek();
    if (!first || first.indent < indent) return null;
    return first.text.startsWith("- ") || first.text === "-" ? this.seq(first.indent) : this.map(first.indent);
  }

  seq(indent: number): Yaml[] {
    const out: Yaml[] = [];
    for (let l = this.peek(); l && l.indent === indent && (l.text.startsWith("- ") || l.text === "-"); l = this.peek()) {
      const rest = l.text === "-" ? "" : l.text.slice(2).trimStart();
      const inner = indent + (l.text.length - rest.length);
      if (!rest) {
        this.i++;
        out.push(this.block(indent + 1));
      } else if (rest.startsWith("- ")) {
        // "- - x": a nested sequence starting on the same line.
        this.lines[this.i] = { ...l, indent: inner, text: rest };
        out.push(this.seq(inner));
      } else if (keySplit(rest) >= 0 && !/^["'[{]/.test(rest)) {
        // "- key: value": a mapping whose first key is on the dash line.
        this.lines[this.i] = { ...l, indent: inner, text: rest };
        out.push(this.map(inner));
      } else {
        this.i++;
        out.push(this.value(rest, indent));
      }
    }
    return out;
  }

  map(indent: number): Record<string, Yaml> {
    const out: Record<string, Yaml> = {};
    for (let l = this.peek(); l && l.indent === indent && !l.text.startsWith("- ") && l.text !== "-"; l = this.peek()) {
      const k = keySplit(l.text);
      this.i++;
      if (k < 0) continue; // not a mapping line; skip it
      const key = String(scalar(l.text.slice(0, k)));
      const rest = l.text.slice(k + 1).trim();
      if (key === "<<") {
        // Merge keys (<<: *anchor) are skipped: aliases aren't resolved.
        continue;
      }
      if (rest === "" || /^[&!][^\s]+$/.test(rest)) {
        const next = this.peek();
        // A sequence may sit at the same indentation as its key.
        if (next && (next.indent > indent || (next.indent === indent && (next.text.startsWith("- ") || next.text === "-")))) out[key] = this.block(next.indent);
        else out[key] = null;
      } else out[key] = this.value(rest, indent);
    }
    return out;
  }

  /** A value after "key:" or "- ": a scalar, or a block scalar (| or >) on the lines below. */
  value(rest: string, indent: number): Yaml {
    const bs = /^([|>])([+-]?)\d*\s*$/.exec(rest);
    if (!bs) return scalar(rest);
    const lines: string[] = [];
    let min = Infinity;
    const raw: Line[] = [];
    for (let l = this.peek(); l && (l.indent > indent || l.text === ""); l = this.peek()) {
      raw.push(l);
      if (l.text) min = Math.min(min, l.indent);
      this.i++;
    }
    for (const l of raw) lines.push(l.text ? " ".repeat(l.indent - min) + l.text : "");
    const text = bs[1] === "|" ? lines.join("\n") : lines.join(" ").replace(/\s+/g, " ");
    return bs[2] === "-" ? text.replace(/\s+$/, "") : text.replace(/\s+$/, "") + "\n";
  }
}

/** Parses every document in the text. */
export function parseYamlDocuments(src: string): Yaml[] {
  const docs: Line[][] = [[]];
  src.split(/\r?\n/).forEach((raw, no) => {
    if (/^(---|\.\.\.)(\s|$)/.test(raw)) {
      docs.push([]);
      return;
    }
    const noComment = stripComment(raw).replace(/\s+$/, "");
    if (!noComment.trim()) return;
    const indent = /^ */.exec(noComment)![0].length;
    docs[docs.length - 1].push({ indent, text: noComment.slice(indent), no: no + 1 });
  });
  return docs.filter((d) => d.length).map((d) => new Parser(d).block(d[0].indent));
}

export function parseYaml(src: string): Yaml {
  return parseYamlDocuments(src)[0] ?? null;
}

/**
 * Minimal HCL writer: enough to emit Terraform that `terraform fmt -check` accepts
 * (two-space indent, aligned `=` in runs of attributes).
 */
export class Expr {
  constructor(readonly code: string) {}
}
/** A raw Terraform expression, e.g. ex("google_compute_network.main.id"). */
export const ex = (code: string) => new Expr(code);

export type Val = string | number | boolean | Expr | Val[] | { [k: string]: Val };
export type Attr = { attr: string; value: Val };
export type Block = { block: string; labels?: string[]; body: Item[] };
export type Comment = { comment: string };
export type Item = Attr | Block | Comment;

export const attr = (name: string, value: Val | undefined): Attr[] => (value === undefined ? [] : [{ attr: name, value }]);
export const block = (name: string, labels: string[], body: Item[]): Block => ({ block: name, labels, body });
export const nested = (name: string, body: Item[]): Block => ({ block: name, body });
export const comment = (text: string): Comment => ({ comment: text });

const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const pad = (n: number) => "  ".repeat(n);

export function renderBlocks(blocks: Item[]): string {
  return blocks.map((b) => renderItems([b], 0)).join("\n\n");
}

function renderItems(items: Item[], depth: number): string {
  const lines: string[] = [];
  let i = 0;
  let prevKind: "attr" | "block" | "comment" | undefined;
  while (i < items.length) {
    const item = items[i];
    if ("attr" in item) {
      const run: Attr[] = [];
      while (i < items.length && "attr" in items[i]) run.push(items[i++] as Attr);
      if (prevKind === "block") lines.push("");
      // terraform fmt aligns `=` only across consecutive single-line attributes.
      let group: Attr[] = [];
      const flush = () => {
        const width = Math.max(...group.map((a) => keyOf(a.attr).length));
        for (const a of group) lines.push(`${pad(depth)}${keyOf(a.attr).padEnd(width)} = ${renderVal(a.value, depth)}`);
        group = [];
      };
      for (const a of run) {
        const multiline = renderVal(a.value, depth).includes("\n");
        if (multiline) {
          if (group.length) flush();
          lines.push(`${pad(depth)}${keyOf(a.attr)} = ${renderVal(a.value, depth)}`);
        } else group.push(a);
      }
      if (group.length) flush();
      prevKind = "attr";
    } else if ("comment" in item) {
      if (prevKind === "block") lines.push("");
      for (const l of item.comment.split("\n")) lines.push(`${pad(depth)}# ${l}`.trimEnd());
      i++;
      prevKind = "comment";
    } else {
      if (prevKind === "attr" || prevKind === "block") lines.push("");
      const labels = (item.labels ?? []).map((l) => JSON.stringify(l)).join(" ");
      const head = `${pad(depth)}${item.block}${labels ? " " + labels : ""} {`;
      if (item.body.length === 0) lines.push(`${head}}`);
      else {
        lines.push(head);
        lines.push(renderItems(item.body, depth + 1));
        lines.push(`${pad(depth)}}`);
      }
      i++;
      prevKind = "block";
    }
  }
  return lines.join("\n");
}

const keyOf = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));

export function renderVal(v: Val, depth: number): string {
  if (v instanceof Expr) return v.code;
  if (typeof v === "string") return JSON.stringify(v).replace(/\$\{/g, "$${").replace(/%\{/g, "%%{");
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map((x) => renderVal(x, depth + 1));
    const oneLine = `[${parts.join(", ")}]`;
    if (oneLine.length <= 80 && !parts.some((p) => p.includes("\n"))) return oneLine;
    return `[\n${parts.map((p) => `${pad(depth + 1)}${p},`).join("\n")}\n${pad(depth)}]`;
  }
  const entries = Object.entries(v);
  if (entries.length === 0) return "{}";
  const width = Math.max(...entries.map(([k]) => keyOf(k).length));
  return `{\n${entries.map(([k, x]) => `${pad(depth + 1)}${keyOf(k).padEnd(width)} = ${renderVal(x, depth + 1)}`).join("\n")}\n${pad(depth)}}`;
}

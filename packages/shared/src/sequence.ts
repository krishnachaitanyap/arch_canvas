import { catalogEntry, withNames } from "./catalog.js";
import type { DiagramModel } from "./model.js";
import type { Workflow } from "./flows.js";

/**
 * Sequence diagrams from the diagram's workflows: each item a workflow touches becomes a
 * participant, each step a message (solid for request/response, dashed for async). Rendered
 * as SVG (no dependencies) and as Mermaid sequenceDiagram text.
 */

export interface SequenceDiagram {
  title: string;
  participants: { id: string; label: string; type: string }[];
  messages: { from: string; to: string; text: string; async: boolean }[];
}

export function sequenceOf(model: DiagramModel, w: Workflow): SequenceDiagram {
  const m = withNames(model);
  const seen: string[] = [];
  for (const s of w.steps) for (const id of [s.from, s.to]) if (!seen.includes(id)) seen.push(id);
  return {
    title: w.title,
    participants: seen.map((id) => {
      const n = m.nodes.find((x) => x.id === id);
      return { id, label: n?.label || id, type: n ? (catalogEntry(n.kind)?.label ?? n.kind) : "" };
    }),
    messages: w.steps.map((s) => ({ from: s.from, to: s.to, text: s.text, async: s.mode === "async" })),
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Wraps text into lines of about `max` characters. */
function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    if (cur && (cur + " " + word).length > max) {
      out.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  return out.slice(0, 4);
}

/** A standalone SVG of the sequence diagram. */
export function sequenceSvg(seq: SequenceDiagram): string {
  const COL = 190;
  const TOP = 20;
  const BOX_H = 46;
  const n = seq.participants.length;
  const x = (id: string) => 20 + seq.participants.findIndex((p) => p.id === id) * COL + COL / 2 - 10;
  const rows = seq.messages.map((msg) => {
    const self = msg.from === msg.to;
    const span = Math.abs(x(msg.to) - x(msg.from));
    const lines = wrap(`${msg.text}`, Math.max(18, Math.floor((self ? COL : span) / 6.4)));
    return { msg, lines, h: 18 + lines.length * 14 + (self ? 22 : 0) };
  });
  const bodyH = rows.reduce((h, r) => h + r.h + 10, 0);
  const width = Math.max(260, n * COL + 20);
  const height = TOP + BOX_H + 30 + bodyH + BOX_H + 30;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="12">`,
    `<defs><marker id="sq-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#3c4043"/></marker>`,
    `<marker id="sq-o" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10" fill="none" stroke="#3c4043" stroke-width="1.5"/></marker></defs>`,
    `<rect width="100%" height="100%" fill="#fff"/>`,
  );
  const lifeTop = TOP + BOX_H;
  const lifeBottom = height - BOX_H - 20;
  const box = (p: SequenceDiagram["participants"][number], y: number) => {
    const cx = x(p.id);
    const label = p.label.length > 24 ? `${p.label.slice(0, 23)}…` : p.label;
    return (
      `<rect x="${cx - 80}" y="${y}" width="160" height="${BOX_H}" rx="8" fill="#f1f5fe" stroke="#1a73e8"/>` +
      `<text x="${cx}" y="${y + 20}" text-anchor="middle" font-weight="600" fill="#202124">${esc(label)}</text>` +
      `<text x="${cx}" y="${y + 36}" text-anchor="middle" font-size="10.5" fill="#5f6368">${esc(p.type)}</text>`
    );
  };
  for (const p of seq.participants) {
    parts.push(`<line x1="${x(p.id)}" y1="${lifeTop}" x2="${x(p.id)}" y2="${lifeBottom}" stroke="#bdc1c6" stroke-dasharray="4 4"/>`);
    parts.push(box(p, TOP), box(p, lifeBottom));
  }
  let y = lifeTop + 30;
  rows.forEach(({ msg, lines, h }, i) => {
    const x1 = x(msg.from);
    const x2 = x(msg.to);
    const dash = msg.async ? ` stroke-dasharray="6 4"` : "";
    const marker = msg.async ? "sq-o" : "sq-a";
    const textX = msg.from === msg.to ? x1 + 10 : (x1 + x2) / 2;
    const anchor = msg.from === msg.to ? "start" : "middle";
    lines.forEach((l, k) => parts.push(`<text x="${textX}" y="${y + 12 + k * 14}" text-anchor="${anchor}" fill="#3c4043">${k === 0 ? `<tspan font-weight="600">${i + 1}.</tspan> ` : ""}${esc(l)}</text>`));
    const ay = y + 8 + lines.length * 14;
    if (msg.from === msg.to)
      parts.push(`<path d="M${x1} ${ay} h36 v18 h-34" fill="none" stroke="#3c4043" stroke-width="1.4"${dash} marker-end="url(#${marker})"/>`);
    else parts.push(`<line x1="${x1}" y1="${ay}" x2="${x2 + (x2 > x1 ? -2 : 2)}" y2="${ay}" stroke="#3c4043" stroke-width="1.4"${dash} marker-end="url(#${marker})"/>`);
    y += h + 10;
  });
  parts.push("</svg>");
  return parts.join("");
}

/** Mermaid sequenceDiagram text (renders in GitHub, GitLab, Notion and Confluence). */
export function toMermaidSequence(seq: SequenceDiagram): string {
  const q = (s: string) => s.replace(/[;#\n]/g, " ");
  const lines = ["sequenceDiagram", `  title ${q(seq.title)}`];
  for (const p of seq.participants) lines.push(`  participant ${p.id} as ${q(p.label)}`);
  for (const msg of seq.messages) lines.push(`  ${msg.from}${msg.async ? "--)" : "->>"}${msg.to}: ${q(msg.text)}`);
  return lines.join("\n") + "\n";
}

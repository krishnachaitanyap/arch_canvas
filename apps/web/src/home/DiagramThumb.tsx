import { memo, useMemo } from "react";
import { catalogEntry, type DiagramModel, pageModel, pagesOf, resolveLayout } from "@archcanvas/shared";

/**
 * A miniature of a diagram's first tab, for dashboard cards: groups as boxes, items as
 * coloured tiles, shapes in their outline, and the lines between them. Pure SVG, no canvas
 * library, so a page of cards stays light.
 */
type Box = { x: number; y: number; w: number; h: number };

const ICON_COLORS: [RegExp, string][] = [
  [/^aws:/, "#ed7100"],
  [/^azure:/, "#0078d4"],
  [/^gcp:/, "#4285f4"],
  [/^logos:/, "#64748b"],
  [/^lucide:/, "#475569"],
];

function colorOf(kind: string, icon?: string): string {
  if (icon) return ICON_COLORS.find(([re]) => re.test(icon))?.[1] ?? "#64748b";
  return catalogEntry(kind)?.icon.color ?? "#64748b";
}

const hex = (v: unknown, fallback: string) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback);

export const DiagramThumb = memo(function DiagramThumb({ model }: { model: DiagramModel }) {
  const view = useMemo(() => {
    const m = pageModel(model, pagesOf(model)[0].id);
    if (!m.nodes.length) return null;
    const rel = resolveLayout(m);
    const abs = new Map<string, Box>();
    const get = (id: string, depth = 0): Box | undefined => {
      if (abs.has(id)) return abs.get(id);
      const n = m.nodes.find((x) => x.id === id);
      const r = rel.get(id);
      if (!n || !r || depth > 30) return undefined;
      const p = n.parentId ? get(n.parentId, depth + 1) : undefined;
      const b = { x: r.x + (p?.x ?? 0), y: r.y + (p?.y ?? 0), w: r.w, h: r.h };
      abs.set(id, b);
      return b;
    };
    m.nodes.forEach((n) => get(n.id));
    const boxes = [...abs.values()];
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const maxY = Math.max(...boxes.map((b) => b.y + b.h));
    const pad = Math.max(maxX - minX, maxY - minY) * 0.06 + 10;
    return { m, abs, vb: `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`, scale: Math.max(maxX - minX, maxY - minY) / 300 };
  }, [model]);

  if (!view) return <EmptyThumb />;
  const { m, abs, vb, scale } = view;
  const sw = Math.max(1, scale * 1.2);
  const depth = (id: string) => {
    let d = 0;
    for (let n = m.nodes.find((x) => x.id === id); n?.parentId && d < 30; n = m.nodes.find((x) => x.id === n!.parentId)) d++;
    return d;
  };
  const groups = m.nodes.filter((n) => catalogEntry(n.kind)?.container).sort((a, b) => depth(a.id) - depth(b.id));
  const items = m.nodes.filter((n) => !catalogEntry(n.kind)?.container);
  const center = (id: string) => {
    const b = abs.get(id);
    if (!b) return null;
    const n = m.nodes.find((x) => x.id === id);
    // Icon items: the icon sits in the top part of the box (the name is underneath).
    return n && n.kind !== "generic.shape" && n.kind !== "generic.note" ? { x: b.x + b.w / 2, y: b.y + Math.min(b.h, b.w) * 0.42 } : { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  };

  return (
    <svg className="thumb-svg" viewBox={vb} preserveAspectRatio="xMidYMid meet" aria-hidden>
      {groups.map((g) => {
        const b = abs.get(g.id)!;
        const color = hex(g.props.color, "#94a3b8");
        const fill = hex(g.props.fill, "none");
        const dash = g.props.border === "dashed" ? `${6 * sw} ${4 * sw}` : g.props.border === "dotted" ? `${1.5 * sw} ${3 * sw}` : undefined;
        return (
          <g key={g.id}>
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={6 * sw} fill={fill === "none" ? "rgba(255,255,255,0.55)" : fill} stroke={color} strokeWidth={sw * 1.3} strokeDasharray={dash} />
            <rect x={b.x + 8 * sw} y={b.y + 7 * sw} width={Math.min(b.w * 0.4, 90 * sw)} height={5 * sw} rx={2.5 * sw} fill={color} opacity={0.55} />
          </g>
        );
      })}
      {m.edges.map((e) => {
        const a = center(e.from);
        const b = center(e.to);
        if (!a || !b) return null;
        return <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#94a3b8" strokeWidth={sw * 1.1} strokeDasharray={e.dash && e.dash !== "solid" ? `${5 * sw} ${4 * sw}` : undefined} />;
      })}
      {items.map((n) => {
        const b = abs.get(n.id)!;
        if (n.kind === "generic.note")
          return <rect key={n.id} x={b.x} y={b.y} width={b.w} height={b.h} rx={3 * sw} fill="#fef3c7" stroke="#f59e0b" strokeWidth={sw} />;
        if (n.kind === "generic.shape") {
          const shape = String(n.props.shape ?? "rectangle");
          const fill = hex(n.props.fill, "#ffffff");
          const stroke = hex(n.props.stroke, "#334155");
          if (shape === "text" || shape === "heading")
            return <rect key={n.id} x={b.x} y={b.y + b.h * 0.35} width={b.w * 0.8} height={Math.max(4 * sw, b.h * 0.25)} rx={2 * sw} fill="#cbd5e1" />;
          if (shape === "ellipse" || shape === "circle")
            return <ellipse key={n.id} cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} fill={fill} stroke={stroke} strokeWidth={sw} />;
          if (shape === "diamond")
            return <polygon key={n.id} points={`${b.x + b.w / 2},${b.y} ${b.x + b.w},${b.y + b.h / 2} ${b.x + b.w / 2},${b.y + b.h} ${b.x},${b.y + b.h / 2}`} fill={fill} stroke={stroke} strokeWidth={sw} />;
          const rows = shape === "entity" || shape === "class" || shape === "list";
          return (
            <g key={n.id}>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={shape === "rounded" || shape === "terminator" ? Math.min(b.h / 2, 14 * sw) : 2 * sw} fill={fill} stroke={stroke} strokeWidth={sw} />
              {rows && <rect x={b.x} y={b.y} width={b.w} height={Math.min(b.h, 24)} fill="#e2e8f0" stroke={stroke} strokeWidth={sw} />}
            </g>
          );
        }
        // Icon items: a coloured tile with a label bar under it.
        const s = Math.min(b.w, b.h) * 0.62;
        const c = colorOf(n.kind, n.icon);
        const x = b.x + (b.w - s) / 2;
        const y = b.y + Math.min(b.h, b.w) * 0.42 - s / 2;
        return (
          <g key={n.id}>
            <rect x={x} y={y} width={s} height={s} rx={s * 0.22} fill={c} />
            <rect x={x + s * 0.28} y={y + s * 0.28} width={s * 0.44} height={s * 0.44} rx={s * 0.1} fill="#fff" opacity={0.85} />
            <rect x={b.x + b.w * 0.2} y={y + s + 6 * sw} width={b.w * 0.6} height={4 * sw} rx={2 * sw} fill="#cbd5e1" />
          </g>
        );
      })}
    </svg>
  );
});

function EmptyThumb() {
  return (
    <svg className="thumb-svg" viewBox="0 0 160 100" aria-hidden>
      <rect x="55" y="32" width="50" height="36" rx="8" fill="none" stroke="#cbd5e1" strokeWidth="2" strokeDasharray="5 4" />
      <path d="M80 42 v16 M72 50 h16" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Whiteboards (Excalidraw) have no model: a sketchy placeholder. */
export function WhiteboardThumb() {
  return (
    <svg className="thumb-svg" viewBox="0 0 160 100" aria-hidden>
      <path d="M30 60 C 45 30, 60 30, 70 50 S 95 75, 110 45" fill="none" stroke="#a78bfa" strokeWidth="3" strokeLinecap="round" />
      <rect x="95" y="20" width="34" height="22" rx="4" fill="none" stroke="#7c3aed" strokeWidth="2" transform="rotate(-4 112 31)" />
      <circle cx="42" cy="30" r="9" fill="none" stroke="#7c3aed" strokeWidth="2" />
    </svg>
  );
}

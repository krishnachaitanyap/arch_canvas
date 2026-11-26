import { useLayoutEffect, useRef, useState } from "react";
import { type Arrowhead, type DiagramModel, resolvedProps, SHAPE_LABELS, SHAPES } from "@archcanvas/shared";
import { ShapeOutline } from "./flow";

export interface MenuState {
  x: number;
  y: number;
  /** Where on the canvas (flow coordinates) the menu was opened. */
  at: { x: number; y: number };
  target: { type: "node" | "edge"; id: string } | { type: "pane" };
}

export interface MenuActions {
  rename: (id: string) => void;
  properties: () => void;
  duplicate: (id: string) => void;
  copy: (id: string) => void;
  remove: (t: { type: "node" | "edge"; id: string }) => void;
  paste: (at: { x: number; y: number }) => void;
  addText: (at: { x: number; y: number }) => void;
  addNote: (at: { x: number; y: number }) => void;
  addGroup: (at: { x: number; y: number }) => void;
  /** Set shape properties (fill, stroke, textColor, shape) on the clicked shape and any other selected shapes. */
  styleShapes: (id: string, props: Record<string, string>) => void;
  arrange: (id: string, where: "front" | "back") => void;
  edge: (edgeId: string, patch: Record<string, string | null>) => void;
  reverse: (edgeId: string) => void;
  editEdgeLabel: (edgeId: string) => void;
  fit: () => void;
}

const FILLS = ["#ffffff", "#f4f4f5", "#dae8fc", "#d5e8d4", "#fff2cc", "#ffe6cc", "#f8cecc", "#e1d5e7"];
const STROKES = ["#000000", "#64748b", "#6c8ebf", "#82b366", "#d6b656", "#d79b00", "#b85450", "#9673a6"];
const TEXTS = ["#000000", "#475569", "#1d4ed8", "#15803d", "#b45309", "#b91c1c", "#7c3aed", "#ffffff"];
const LINES = ["#5f6368", "#18181b", "#1d4ed8", "#15803d", "#d97706", "#b91c1c", "#7c3aed", "#94a3b8"];
const HEADS: [Arrowhead, string][] = [
  ["none", "—"],
  ["arrow", "▶"],
  ["open", ">"],
  ["triangle", "▷"],
  ["diamond", "◆"],
  ["odiamond", "◇"],
  ["circle", "●"],
];

/**
 * Right-click menu, draw.io style: actions plus quick styling (colours, shape, arrowheads,
 * line pattern) for shapes and lines.
 */
export function ContextMenu({
  menu,
  model,
  readOnly,
  onClose,
  actions,
}: {
  menu: MenuState;
  model: DiagramModel;
  readOnly: boolean;
  onClose: () => void;
  actions: MenuActions;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  // Keep the menu inside the canvas.
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const maxX = parent.clientWidth - el.offsetWidth - 8;
    const maxY = parent.clientHeight - el.offsetHeight - 8;
    setPos({ x: Math.max(8, Math.min(menu.x, maxX)), y: Math.max(8, Math.min(menu.y, maxY)) });
  }, [menu.x, menu.y]);

  const item = (label: string, fn: () => void, opts: { disabled?: boolean; danger?: boolean; hint?: string } = {}) => (
    <button
      className={`ctx-item ${opts.danger ? "danger" : ""}`}
      disabled={opts.disabled}
      onClick={() => {
        fn();
        onClose();
      }}
    >
      <span>{label}</span>
      {opts.hint && <kbd>{opts.hint}</kbd>}
    </button>
  );
  const swatches = (title: string, colors: string[], current: string | undefined, pick: (c: string) => void) => (
    <div className="ctx-swatches" role="group" aria-label={title}>
      <span className="ctx-label">{title}</span>
      <div>
        {colors.map((c) => (
          <button
            key={c}
            className={`swatch ${current?.toLowerCase() === c ? "on" : ""}`}
            style={{ background: c }}
            title={c}
            disabled={readOnly}
            onClick={() => pick(c)}
          />
        ))}
        <label className="swatch custom" title="Custom colour">
          <input type="color" value={current ?? "#ffffff"} disabled={readOnly} onChange={(e) => pick(e.target.value)} />
        </label>
      </div>
    </div>
  );

  const t = menu.target;
  const node = t.type === "node" ? model.nodes.find((n) => n.id === t.id) : undefined;
  const edge = t.type === "edge" ? model.edges.find((e) => e.id === t.id) : undefined;
  const shape = node?.kind === "generic.shape" ? resolvedProps(node.kind, node.props) : undefined;

  return (
    <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()} role="menu">
      {t.type === "node" && node && (
        <>
          {item(shape || node.kind === "generic.note" ? "Edit text" : "Rename", () => actions.rename(t.id), { disabled: readOnly, hint: "F2" })}
          {shape && (
            <>
              {swatches("Fill", FILLS, String(shape.fill), (c) => actions.styleShapes(t.id, { fill: c }))}
              {swatches("Border", STROKES, String(shape.stroke), (c) => actions.styleShapes(t.id, { stroke: c }))}
              {swatches("Text", TEXTS, String(shape.textColor), (c) => actions.styleShapes(t.id, { textColor: c }))}
              <div className="ctx-swatches">
                <span className="ctx-label">Shape</span>
                <div className="ctx-shapes">
                  {SHAPES.map((s) => (
                    <button
                      key={s}
                      className={`shape-pick ${shape.shape === s ? "on" : ""}`}
                      title={SHAPE_LABELS[s].title}
                      disabled={readOnly}
                      onClick={() => actions.styleShapes(t.id, { shape: s })}
                    >
                      <ShapeOutline shape={s} w={26} h={18} fill="#fff" stroke="#000" sw={1.2} />
                    </button>
                  ))}
                </div>
              </div>
              <hr />
            </>
          )}
          {item("Bring to front", () => actions.arrange(t.id, "front"), { disabled: readOnly })}
          {item("Send to back", () => actions.arrange(t.id, "back"), { disabled: readOnly })}
          <hr />
          {!shape && node.kind !== "generic.note" && item("Properties & icon…", () => actions.properties())}
          {item("Copy", () => actions.copy(t.id), { hint: "⌘C" })}
          {item("Duplicate", () => actions.duplicate(t.id), { disabled: readOnly, hint: "⌘D" })}
          {item("Delete", () => actions.remove(t), { disabled: readOnly, danger: true, hint: "⌫" })}
        </>
      )}
      {t.type === "edge" && edge && (
        <>
          {item(edge.label ? "Edit label" : "Add label", () => actions.editEdgeLabel(t.id), { disabled: readOnly })}
          <div className="ctx-swatches">
            <span className="ctx-label">Path</span>
            <div className="ctx-seg">
              {(["orthogonal", "straight", "curved"] as const).map((r) => (
                <button key={r} className={(edge.routing ?? "orthogonal") === r ? "on" : ""} disabled={readOnly} onClick={() => actions.edge(t.id, { routing: r === "orthogonal" ? null : r })}>
                  {r === "orthogonal" ? "┐ Elbow" : r === "straight" ? "／ Straight" : "⌒ Curved"}
                </button>
              ))}
            </div>
          </div>
          <div className="ctx-swatches">
            <span className="ctx-label">Line</span>
            <div className="ctx-seg">
              {(["solid", "dashed", "dotted"] as const).map((d) => (
                <button key={d} className={(edge.dash ?? "solid") === d ? "on" : ""} disabled={readOnly} onClick={() => actions.edge(t.id, { dash: d === "solid" ? null : d })}>
                  {d === "solid" ? "──" : d === "dashed" ? "- - -" : "· · ·"}
                </button>
              ))}
            </div>
          </div>
          <div className="ctx-swatches">
            <span className="ctx-label">Start / end</span>
            <div className="ctx-seg heads">
              {HEADS.map(([h, g]) => (
                <button
                  key={`s-${h}`}
                  className={(edge.arrowStart ?? "none") === h ? "on" : ""}
                  title={`Start: ${h}`}
                  disabled={readOnly}
                  onClick={() => actions.edge(t.id, { arrowStart: h === "none" ? null : h })}
                >
                  <span style={{ display: "inline-block", transform: "scaleX(-1)" }}>{g}</span>
                </button>
              ))}
            </div>
            <div className="ctx-seg heads">
              {HEADS.map(([h, g]) => (
                <button
                  key={`e-${h}`}
                  className={(edge.arrowEnd ?? "arrow") === h ? "on" : ""}
                  title={`End: ${h}`}
                  disabled={readOnly}
                  onClick={() => actions.edge(t.id, { arrowEnd: h === "arrow" ? null : h })}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>
          {swatches("Colour", LINES, edge.color ?? "#5f6368", (c) => actions.edge(t.id, { color: c }))}
          <hr />
          {item("Reverse direction", () => actions.reverse(t.id), { disabled: readOnly })}
          {item("Delete connection", () => actions.remove(t), { disabled: readOnly, danger: true })}
        </>
      )}
      {t.type === "pane" && (
        <>
          {item("Add text here", () => actions.addText(menu.at), { disabled: readOnly, hint: "dbl-click" })}
          {item("Add note here", () => actions.addNote(menu.at), { disabled: readOnly })}
          {item("Add group here", () => actions.addGroup(menu.at), { disabled: readOnly })}
          {item("Paste here", () => actions.paste(menu.at), { disabled: readOnly, hint: "⌘V" })}
          <hr />
          {item("Fit to screen", () => actions.fit())}
        </>
      )}
    </div>
  );
}

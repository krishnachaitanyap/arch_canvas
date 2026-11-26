import { useLayoutEffect, useRef, useState } from "react";
import { type Page, type Arrowhead, BORDER_WIDTHS, catalogEntry, type DiagramModel, FONT_SIZES, FONTS, resolvedProps, SHAPE_LABELS, SHAPES } from "@archcanvas/shared";
import { FONT_STACKS, ShapeOutline, thumbSize } from "./flow";

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
  /** Set style properties on the clicked item and any other selected items that have them. */
  styleNodes: (id: string, props: Record<string, string | boolean>) => void;
  arrange: (id: string, where: "front" | "back") => void;
  edge: (edgeId: string, patch: Record<string, string | null>) => void;
  reverse: (edgeId: string) => void;
  editEdgeLabel: (edgeId: string) => void;
  fit: () => void;
  /** Moves the item (and any other selected ones) to another canvas tab. */
  moveToPage: (id: string, page: string) => void;
}

const FILLS = ["#ffffff", "#f4f4f5", "#dae8fc", "#d5e8d4", "#fff2cc", "#ffe6cc", "#f8cecc", "#e1d5e7"];
const STROKES = ["#000000", "#64748b", "#6c8ebf", "#82b366", "#d6b656", "#d79b00", "#b85450", "#9673a6"];
const TEXTS = ["#000000", "#475569", "#1d4ed8", "#15803d", "#b45309", "#b91c1c", "#7c3aed", "#ffffff"];
const GROUP_COLORS = ["#147eba", "#248814", "#232f3e", "#e7157b", "#d86613", "#df3312", "#0078d4", "#326ce5", "#a142f4", "#5f6368"];
const GROUP_FILLS = ["none", "#ffffff", "#e6f2f8", "#e9f3e6", "#f2f6e8", "#fdf2e9", "#fbeaea", "#f1f3f4"];
const HEADER_LABELS: [string, string][] = [
  ["tab", "Icon tab"],
  ["icon", "Icon"],
  ["label", "Title"],
  ["center", "Centred"],
];
const LINES = ["#5f6368", "#18181b", "#1d4ed8", "#15803d", "#d97706", "#b91c1c", "#7c3aed", "#94a3b8"];
const HEADS: [Arrowhead, string][] = [
  ["none", "—"],
  ["arrow", "▶"],
  ["open", ">"],
  ["triangle", "▷"],
  ["diamond", "◆"],
  ["odiamond", "◇"],
  ["circle", "●"],
  ["er-one", "‖"],
  ["er-many", "⋲"],
  ["er-one-many", "|⋲"],
  ["er-zero-many", "o⋲"],
  ["er-zero-one", "o|"],
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
  pages = [],
  page,
}: {
  pages?: Page[];
  page?: string;
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
            className={`swatch ${current?.toLowerCase() === c ? "on" : ""} ${c === "none" ? "none" : ""}`}
            style={{ background: c === "none" ? undefined : c }}
            title={c === "none" ? "No fill" : c}
            disabled={readOnly}
            onClick={() => pick(c)}
          />
        ))}
        <label className="swatch custom" title="Custom colour">
          <input type="color" value={current && current !== "none" ? current : "#ffffff"} disabled={readOnly} onChange={(e) => pick(e.target.value)} />
        </label>
      </div>
    </div>
  );

  const t = menu.target;
  const node = t.type === "node" ? model.nodes.find((n) => n.id === t.id) : undefined;
  const edge = t.type === "edge" ? model.edges.find((e) => e.id === t.id) : undefined;
  const shape = node?.kind === "generic.shape" ? resolvedProps(node.kind, node.props) : undefined;
  const group = node && catalogEntry(node.kind)?.container ? resolvedProps(node.kind, node.props) : undefined;
  const seg = (title: string, key: string, options: [string, React.ReactNode][], current: string) => (
    <div className="ctx-swatches">
      <span className="ctx-label">{title}</span>
      <div className="ctx-seg">
        {options.map(([v, label]) => (
          <button key={v} className={current === v ? "on" : ""} disabled={readOnly} onClick={() => actions.styleNodes(menu.target.type === "node" ? menu.target.id : "", { [key]: v })}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()} role="menu">
      {t.type === "node" && node && (
        <>
          {item(shape || node.kind === "generic.note" ? "Edit text" : "Rename", () => actions.rename(t.id), { disabled: readOnly, hint: "F2" })}
          {shape && (
            <>
              {swatches("Fill", FILLS, String(shape.fill), (c) => actions.styleNodes(t.id, { fill: c }))}
              {swatches("Border", STROKES, String(shape.stroke), (c) => actions.styleNodes(t.id, { stroke: c }))}
              {seg("Line", "lineStyle", [["solid", "──"], ["dashed", "- - -"], ["dotted", "· · ·"]], String(shape.lineStyle))}
              {seg("Thickness", "strokeWidth", ["1", "1.5", "2", "3", "4", "6"].map((w) => [w, <span key={w} className="thick" style={{ borderTopWidth: Number(w) }} title={`${w}px`} />]), String(shape.strokeWidth))}
              {swatches("Text", TEXTS, String(shape.textColor), (c) => actions.styleNodes(t.id, { textColor: c }))}
              <div className="ctx-swatches">
                <span className="ctx-label">Font</span>
                <div className="ctx-font">
                  <select value={String(shape.font)} disabled={readOnly} onChange={(e) => actions.styleNodes(t.id, { font: e.target.value })} aria-label="Font">
                    {FONTS.map((f) => (
                      <option key={f} value={f} style={{ fontFamily: FONT_STACKS[f] }}>
                        {f}
                      </option>
                    ))}
                  </select>
                  <select value={String(shape.fontSize)} disabled={readOnly} onChange={(e) => actions.styleNodes(t.id, { fontSize: e.target.value })} aria-label="Font size">
                    {FONT_SIZES.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                  <button className={shape.bold ? "on" : ""} disabled={readOnly} title="Bold" onClick={() => actions.styleNodes(t.id, { bold: !shape.bold })}>
                    <b>B</b>
                  </button>
                  <button className={shape.italic ? "on" : ""} disabled={readOnly} title="Italic" onClick={() => actions.styleNodes(t.id, { italic: !shape.italic })}>
                    <i>I</i>
                  </button>
                  <button className={shape.shadow ? "on" : ""} disabled={readOnly} title="Shadow" onClick={() => actions.styleNodes(t.id, { shadow: !shape.shadow })}>
                    ❐
                  </button>
                </div>
              </div>
              <div className="ctx-swatches">
                <span className="ctx-label">Shape</span>
                <div className="ctx-shapes">
                  {SHAPES.map((s) => (
                    <button
                      key={s}
                      className={`shape-pick ${shape.shape === s ? "on" : ""}`}
                      title={SHAPE_LABELS[s].title}
                      disabled={readOnly}
                      onClick={() => actions.styleNodes(t.id, { shape: s })}
                    >
                      <ShapeOutline shape={s} w={thumbSize(s, 26, 20)[0]} h={thumbSize(s, 26, 20)[1]} fill="#fff" stroke="#000" sw={1.2} />
                    </button>
                  ))}
                </div>
              </div>
              <hr />
            </>
          )}
          {group && (
            <>
              {seg("Border", "border", [["solid", "──"], ["dashed", "- - -"], ["dotted", "· · ·"], ["none", "None"]], String(group.border))}
              {seg("Thickness", "borderWidth", BORDER_WIDTHS.map((w) => [w, <span key={w} className="thick" style={{ borderTopWidth: Number(w) }} title={`${w}px`} />]), String(group.borderWidth))}
              {swatches("Colour", GROUP_COLORS, String(group.color), (c) => actions.styleNodes(t.id, { color: c }))}
              {swatches("Fill", GROUP_FILLS, String(group.fill), (c) => actions.styleNodes(t.id, { fill: c }))}
              {seg("Title", "header", HEADER_LABELS, String(group.header))}
              <hr />
            </>
          )}
          {item("Bring to front", () => actions.arrange(t.id, "front"), { disabled: readOnly })}
          {item("Send to back", () => actions.arrange(t.id, "back"), { disabled: readOnly })}
          <hr />
          {pages.length > 1 && (
            <div className="ctx-swatches">
              <span className="ctx-label">Move to tab</span>
              <div className="ctx-pages">
                {pages
                  .filter((p) => p.id !== page)
                  .map((p) => (
                    <button
                      key={p.id}
                      disabled={readOnly}
                      onClick={() => {
                        actions.moveToPage(t.id, p.id);
                        onClose();
                      }}
                    >
                      {p.name}
                    </button>
                  ))}
              </div>
            </div>
          )}
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
          {(edge.labelDx || edge.labelDy) ? item("Put label back on the line", () => actions.edge(t.id, { labelDx: null, labelDy: null }), { disabled: readOnly }) : null}
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

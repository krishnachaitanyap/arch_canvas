import { useState } from "react";
import {
  BringToFront,
  Copy,
  CornerDownRight,
  MoveRight,
  PaintBucket,
  PanelLeft,
  PenLine,
  Plus,
  Redo2,
  SendToBack,
  Spline,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Routing } from "@archcanvas/shared";
import type { PaletteItem } from "./Palette";

const ZOOMS = [25, 50, 75, 100, 125, 150, 200, 300];

export type LineEnds = "none" | "end" | "both" | "start";
export interface LineStyle {
  dash: "solid" | "dashed" | "dotted";
  ends: LineEnds;
}

/** A small picture of a line: its pattern and which ends have arrows. */
function LineGlyph({ dash = "solid", ends = "end" }: { dash?: LineStyle["dash"]; ends?: LineEnds }) {
  const pattern = dash === "dashed" ? "4 3" : dash === "dotted" ? "1 3" : undefined;
  return (
    <svg width="26" height="14" viewBox="0 0 26 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <line x1={ends === "start" || ends === "both" ? 7 : 2} y1="7" x2={ends === "end" || ends === "both" ? 19 : 24} y2="7" strokeDasharray={pattern} />
      {(ends === "end" || ends === "both") && <path d="M18 3 L24 7 L18 11 Z" fill="currentColor" />}
      {(ends === "start" || ends === "both") && <path d="M8 3 L2 7 L8 11 Z" fill="currentColor" />}
    </svg>
  );
}

/** What the + menu adds, at the next free spot. */
const INSERT: PaletteItem[] = [
  { key: "ins:text", kind: "generic.shape", label: "Text", props: { shape: "text" } },
  { key: "ins:rect", kind: "generic.shape", label: "Process", props: { shape: "rectangle" } },
  { key: "ins:rounded", kind: "generic.shape", label: "Step", props: { shape: "rounded" } },
  { key: "ins:ellipse", kind: "generic.shape", label: "Event", props: { shape: "ellipse" } },
  { key: "ins:diamond", kind: "generic.shape", label: "Decision?", props: { shape: "diamond" } },
  { key: "ins:heading", kind: "generic.shape", label: "Heading\nWrite a paragraph of text here.", props: { shape: "heading" } },
  { key: "ins:entity", kind: "generic.shape", label: "Customer\nid: uuid PK\nname: text", props: { shape: "entity" } },
  { key: "ins:class", kind: "generic.shape", label: "Order\n+ id: string\n--\n+ place(): void", props: { shape: "class" } },
  { key: "ins:note", kind: "generic.note", label: "Note" },
  { key: "ins:group", kind: "generic.group", label: "Group" },
];
const INSERT_NAMES: Record<string, string> = {
  "ins:text": "Text",
  "ins:rect": "Rectangle",
  "ins:rounded": "Rounded rectangle",
  "ins:ellipse": "Ellipse",
  "ins:diamond": "Diamond",
  "ins:heading": "Heading and text",
  "ins:entity": "Entity (table)",
  "ins:class": "UML class",
  "ins:note": "Sticky note",
  "ins:group": "Group",
};

/**
 * The formatting toolbar above the canvas, laid out like draw.io's: panels, zoom, undo,
 * delete, order, fill / line colour, shadow, connector style and insert.
 */
export function FormatBar(p: {
  readOnly: boolean;
  paletteOpen: boolean;
  onTogglePalette: () => void;
  zoom: number;
  onZoom: (z: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  selected: number;
  onDelete: () => void;
  onFront: () => void;
  onBack: () => void;
  fill?: string;
  line?: string;
  onFill: (c: string) => void;
  onLine: (c: string) => void;
  shadow: boolean | null;
  onShadow: () => void;
  routing: Routing;
  onRouting: (r: Routing) => void;
  /** Line pattern and arrowheads for new lines (and the selected ones). */
  lineStyle: LineStyle;
  onLineStyle: (patch: Partial<LineStyle>) => void;
  onInsert: (item: PaletteItem) => void;
}) {
  const [inserting, setInserting] = useState(false);
  const none = !p.selected || p.readOnly;
  const pct = Math.round(p.zoom * 100);
  return (
    <div className="format-bar" role="toolbar" aria-label="Format">
      <button className={p.paletteOpen ? "on" : ""} title={p.paletteOpen ? "Hide shapes" : "Show shapes"} onClick={p.onTogglePalette}>
        <PanelLeft size={16} />
      </button>
      <span className="fb-sep" />
      <select
        className="fb-zoom"
        value={ZOOMS.includes(pct) ? String(pct) : "custom"}
        onChange={(e) => (e.target.value === "fit" ? p.onFit() : p.onZoom(Number(e.target.value) / 100))}
        title="Zoom"
      >
        {!ZOOMS.includes(pct) && <option value="custom">{pct}%</option>}
        {ZOOMS.map((z) => (
          <option key={z} value={z}>
            {z}%
          </option>
        ))}
        <option value="fit">Fit</option>
      </select>
      <button title="Zoom in" onClick={p.onZoomIn}>
        <ZoomIn size={16} />
      </button>
      <button title="Zoom out" onClick={p.onZoomOut}>
        <ZoomOut size={16} />
      </button>
      <span className="fb-sep" />
      <button title="Undo (⌘Z)" disabled={!p.canUndo || p.readOnly} onClick={p.onUndo}>
        <Undo2 size={16} />
      </button>
      <button title="Redo (⇧⌘Z)" disabled={!p.canRedo || p.readOnly} onClick={p.onRedo}>
        <Redo2 size={16} />
      </button>
      <span className="fb-sep" />
      <button title="Delete (⌫)" disabled={none} onClick={p.onDelete}>
        <Trash2 size={16} />
      </button>
      <span className="fb-sep" />
      <button title="Bring to front" disabled={none} onClick={p.onFront}>
        <BringToFront size={16} />
      </button>
      <button title="Send to back" disabled={none} onClick={p.onBack}>
        <SendToBack size={16} />
      </button>
      <span className="fb-sep" />
      <label className={`fb-color ${none ? "disabled" : ""}`} title="Fill colour">
        <PaintBucket size={16} />
        <span className="fb-swatch" style={{ background: p.fill && p.fill !== "none" ? p.fill : "transparent" }} />
        <input type="color" disabled={none} value={p.fill && p.fill !== "none" ? p.fill : "#ffffff"} onChange={(e) => p.onFill(e.target.value)} />
      </label>
      <label className={`fb-color ${none ? "disabled" : ""}`} title="Line colour">
        <PenLine size={16} />
        <span className="fb-swatch" style={{ background: p.line ?? "#000" }} />
        <input type="color" disabled={none} value={p.line ?? "#000000"} onChange={(e) => p.onLine(e.target.value)} />
      </label>
      <button className={p.shadow ? "on" : ""} title="Shadow" disabled={none || p.shadow === null} onClick={p.onShadow}>
        <Copy size={16} />
      </button>
      <span className="fb-sep" />
      {(
        [
          ["straight", <MoveRight key="s" size={16} />, "Straight connectors"],
          ["orthogonal", <CornerDownRight key="o" size={16} />, "Elbow connectors"],
          ["curved", <Spline key="c" size={16} />, "Curved connectors"],
        ] as const
      ).map(([r, icon, title]) => (
        <button
          key={r}
          className={p.routing === r ? "on" : ""}
          title={`${title}: for new lines and the selected ones`}
          disabled={p.readOnly}
          onClick={() => p.onRouting(r)}
        >
          {icon}
        </button>
      ))}
      <span className="fb-sep" />
      <div className="fb-lines" role="group" aria-label="Line style">
        {(
          [
            ["none", "No arrows"],
            ["end", "Arrow at one end"],
            ["both", "Arrows at both ends"],
          ] as const
        ).map(([ends, title]) => (
          <button
            key={ends}
            className={p.lineStyle.ends === ends ? "on" : ""}
            title={`${title}: for new lines and the selected ones`}
            disabled={p.readOnly}
            onClick={() => p.onLineStyle({ ends })}
          >
            <LineGlyph dash={p.lineStyle.dash} ends={ends} />
          </button>
        ))}
        <span className="fb-sep thin" />
        {(
          [
            ["solid", "Solid line"],
            ["dashed", "Dashed line"],
            ["dotted", "Dotted line"],
          ] as const
        ).map(([dash, title]) => (
          <button
            key={dash}
            className={p.lineStyle.dash === dash ? "on" : ""}
            title={`${title}: for new lines and the selected ones`}
            disabled={p.readOnly}
            onClick={() => p.onLineStyle({ dash })}
          >
            <LineGlyph dash={dash} ends="none" />
          </button>
        ))}
      </div>
      <span className="fb-sep" />
      <div className="fb-insert">
        <button title="Insert" disabled={p.readOnly} onClick={() => setInserting((v) => !v)} className={inserting ? "on" : ""}>
          <Plus size={16} />
        </button>
        {inserting && (
          <div className="fb-menu" onMouseLeave={() => setInserting(false)}>
            {INSERT.map((it) => (
              <button
                key={it.key}
                onClick={() => {
                  setInserting(false);
                  p.onInsert(it);
                }}
              >
                {INSERT_NAMES[it.key]}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

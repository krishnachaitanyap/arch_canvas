import { getViewportForBounds, type Rect } from "@xyflow/react";
import { toPng, toSvg } from "html-to-image";

export function download(filename: string, content: string | Blob, type = "text/plain"): void {
  const blob = typeof content === "string" ? new Blob([content], { type }) : content;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Renders the whole diagram (not just the visible part) to SVG or PNG. */
export async function exportImage(kind: "svg" | "png", bounds: Rect, filename: string): Promise<void> {
  const viewport = document.querySelector<HTMLElement>(".cloud-canvas .react-flow__viewport");
  if (!viewport) throw new Error("Canvas not ready");
  const pad = 40;
  const width = Math.ceil(bounds.width + pad * 2);
  const height = Math.ceil(bounds.height + pad * 2);
  const vp = getViewportForBounds(bounds, width, height, 0.2, 2, pad);
  const opts = {
    backgroundColor: "#ffffff",
    width,
    height,
    pixelRatio: kind === "png" ? 2 : 1,
    style: { width: `${width}px`, height: `${height}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` },
  };
  const url = kind === "svg" ? await toSvg(viewport, opts) : await toPng(viewport, opts);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
}

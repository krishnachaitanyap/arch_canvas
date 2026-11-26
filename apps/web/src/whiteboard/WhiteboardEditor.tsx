import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Excalidraw, convertToExcalidrawElements, exportToBlob, exportToSvg } from "@excalidraw/excalidraw";
import type { BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { api, type Diagram } from "../api";
import { slug } from "../util";

const STARTER = `flowchart LR
  user([User]) -->|HTTPS| lb[Load balancer]
  lb --> web[Web app]
  web -->|REST| api[API service]
  api --> db[(Postgres)]
  api -->|prompt| llm{{LLM gateway}}`;

export interface WhiteboardProps {
  diagramId: string | null;
  initial: Diagram | null;
  title: string;
  toolbar: HTMLElement | null;
  setStatus: (s: { kind: "ok" | "error"; text: string } | null) => void;
  onSaved: (d: Diagram) => void;
}

/** Freeform whiteboard: Excalidraw canvas with Mermaid diagram-as-code and one-shot AI. */
export function WhiteboardEditor({ diagramId, initial, title, toolbar, setStatus, onSaved }: WhiteboardProps) {
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const [source, setSource] = useState(initial ? initial.source : STARTER);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const render = useCallback(
    async (code: string) => {
      if (!excalidraw) return;
      try {
        const { elements, files } = await parseMermaidToExcalidraw(code, { themeVariables: { fontSize: "16px" } });
        excalidraw.updateScene({ elements: convertToExcalidrawElements(elements) });
        if (files) excalidraw.addFiles(Object.values(files));
        excalidraw.scrollToContent(undefined, { fitToContent: true });
        setStatus(null);
      } catch (err) {
        setStatus({ kind: "error", text: `Mermaid error: ${(err as Error).message}` });
      }
    },
    [excalidraw, setStatus],
  );

  // Load the saved scene, or render the starter, once the canvas is ready.
  useEffect(() => {
    if (!excalidraw) return;
    if (initial) {
      excalidraw.updateScene({ elements: (initial.scene.elements ?? []) as never });
      if (initial.scene.files) excalidraw.addFiles(Object.values(initial.scene.files as BinaryFiles));
      excalidraw.scrollToContent(undefined, { fitToContent: true });
    } else void render(STARTER);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [excalidraw]);

  async function onGenerate(edit: boolean) {
    if (!prompt.trim()) return;
    setBusy(edit ? "Updating diagram…" : "Generating diagram…");
    try {
      const { source: generated } = await api.generate(prompt, edit ? source : undefined);
      setSource(generated);
      await render(generated);
      setPrompt("");
    } catch (err) {
      setStatus({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function onSave() {
    if (!excalidraw) return;
    setBusy("Saving…");
    const scene = { elements: excalidraw.getSceneElements(), files: excalidraw.getFiles() };
    try {
      const d = diagramId
        ? await api.updateDiagram(diagramId, { title, source, scene })
        : await api.createDiagram({ title, kind: "whiteboard", source, scene });
      setStatus({ kind: "ok", text: "Saved" });
      onSaved(d);
    } catch (err) {
      setStatus({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function onExport(kind: "svg" | "png") {
    if (!excalidraw) return;
    const opts = {
      elements: excalidraw.getSceneElements(),
      appState: { ...excalidraw.getAppState(), exportBackground: true },
      files: excalidraw.getFiles(),
    };
    const blob =
      kind === "svg"
        ? new Blob([(await exportToSvg(opts)).outerHTML], { type: "image/svg+xml" })
        : await exportToBlob({ ...opts, mimeType: "image/png" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${slug(title)}.${kind}`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const tools = (
    <>
      <button onClick={() => void onExport("svg")}>Export SVG</button>
      <button onClick={() => void onExport("png")}>Export PNG</button>
      <button className="primary" onClick={() => void onSave()} disabled={Boolean(busy)}>
        Save
      </button>
    </>
  );

  return (
    <main className="workspace">
      {toolbar && createPortal(tools, toolbar)}
      <aside className="panel">
        <section>
          <h2>Ask AI</h2>
          <textarea
            rows={5}
            placeholder="e.g. Microservices e-commerce on GKE with Pub/Sub, Cloud SQL and a Redis cache"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void onGenerate(Boolean(source.trim()));
            }}
          />
          <div className="row">
            <button className="primary" onClick={() => void onGenerate(false)} disabled={Boolean(busy)}>
              Generate new
            </button>
            <button onClick={() => void onGenerate(true)} disabled={Boolean(busy) || !source.trim()}>
              Edit current
            </button>
          </div>
          {busy && <p className="hint">{busy}</p>}
        </section>

        <section className="grow">
          <h2>Diagram as code (Mermaid)</h2>
          <textarea className="code" spellCheck={false} value={source} onChange={(e) => setSource(e.target.value)} />
          <button onClick={() => void render(source)}>Render to canvas</button>
          <p className="hint">Rendering replaces the canvas. Edit freely on the canvas afterwards.</p>
        </section>
      </aside>

      <div className="canvas">
        <Excalidraw excalidrawAPI={setExcalidraw} />
      </div>
    </main>
  );
}

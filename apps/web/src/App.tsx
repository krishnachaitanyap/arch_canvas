import { useCallback, useEffect, useState } from "react";
import { Excalidraw, convertToExcalidrawElements, exportToBlob, exportToSvg } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, BinaryFiles } from "@excalidraw/excalidraw/types";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { api, type DiagramSummary } from "./api";

const STARTER = `flowchart LR
  user([User]) -->|HTTPS| lb[Load balancer]
  lb --> web[Web app]
  web -->|REST| api[API service]
  api --> db[(Postgres)]
  api -->|prompt| llm{{LLM gateway}}`;

export function App() {
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const [source, setSource] = useState(STARTER);
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("Untitled diagram");
  const [diagramId, setDiagramId] = useState<string | null>(null);
  const [diagrams, setDiagrams] = useState<DiagramSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const refreshList = useCallback(() => {
    api.listDiagrams().then(setDiagrams).catch(() => setDiagrams([]));
  }, []);
  useEffect(refreshList, [refreshList]);

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
    [excalidraw],
  );

  // Render the starter diagram once the canvas is ready
  useEffect(() => {
    if (excalidraw) void render(STARTER);
  }, [excalidraw, render]);

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
      if (diagramId) {
        await api.updateDiagram(diagramId, { title, source, scene });
      } else {
        const created = await api.createDiagram({ title, source, scene });
        setDiagramId(created.id);
      }
      setStatus({ kind: "ok", text: "Saved" });
      refreshList();
    } catch (err) {
      setStatus({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function onOpen(id: string) {
    if (!excalidraw) return;
    if (!id) return onNew();
    const d = await api.getDiagram(id);
    setDiagramId(d.id);
    setTitle(d.title);
    setSource(d.source);
    excalidraw.updateScene({ elements: (d.scene.elements ?? []) as never });
    if (d.scene.files) excalidraw.addFiles(Object.values(d.scene.files as BinaryFiles));
    excalidraw.scrollToContent(undefined, { fitToContent: true });
  }

  function onNew() {
    setDiagramId(null);
    setTitle("Untitled diagram");
    setSource("");
    excalidraw?.resetScene();
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
    a.download = `${title.replace(/[^\w-]+/g, "_")}.${kind}`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">ArchCanvas</span>
        <input className="title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Diagram title" />
        <select value={diagramId ?? ""} onChange={(e) => void onOpen(e.target.value)} aria-label="Open diagram">
          <option value="">New diagram</option>
          {diagrams.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
        <div className="spacer" />
        {status && <span className={`status ${status.kind}`}>{status.text}</span>}
        <button onClick={onNew}>New</button>
        <button onClick={() => void onExport("svg")}>Export SVG</button>
        <button onClick={() => void onExport("png")}>Export PNG</button>
        <button className="primary" onClick={() => void onSave()} disabled={Boolean(busy)}>
          Save
        </button>
      </header>

      <main className="workspace">
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
            <textarea
              className="code"
              spellCheck={false}
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
            <button onClick={() => void render(source)}>Render to canvas</button>
            <p className="hint">Rendering replaces the canvas. Edit freely on the canvas afterwards.</p>
          </section>
        </aside>

        <div className="canvas">
          <Excalidraw excalidrawAPI={setExcalidraw} />
        </div>
      </main>
    </div>
  );
}

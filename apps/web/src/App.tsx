import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { type DiagramModel, emptyModel, SAMPLE_MODEL } from "@archcanvas/shared";
import { api, type AppConfig, type Diagram, type DiagramKind, type DiagramSummary } from "./api";

// Each editor is its own chunk: the whiteboard pulls in Excalidraw + Mermaid, the cloud editor React Flow + ELK.
const CloudEditor = lazy(() => import("./cloud/CloudEditor").then((m) => ({ default: m.CloudEditor })));
const WhiteboardEditor = lazy(() => import("./whiteboard/WhiteboardEditor").then((m) => ({ default: m.WhiteboardEditor })));

interface Doc {
  /** Bumped to remount the editor when another diagram is opened. */
  key: number;
  id: string | null;
  kind: DiagramKind;
  title: string;
  loaded: Diagram | null;
  model: DiagramModel;
}

type Status = { kind: "ok" | "error"; text: string } | null;

let nextKey = 1;
const newDoc = (kind: DiagramKind, title = "Untitled architecture", model = emptyModel()): Doc => ({
  key: nextKey++,
  id: null,
  kind,
  title,
  loaded: null,
  model,
});

export function App() {
  const [doc, setDoc] = useState<Doc>(() => newDoc("cloud"));
  const [diagrams, setDiagrams] = useState<DiagramSummary[]>([]);
  const [status, setStatus] = useState<Status>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);

  const refreshList = useCallback(() => {
    api.listDiagrams().then(setDiagrams).catch(() => setDiagrams([]));
  }, []);
  useEffect(refreshList, [refreshList]);
  useEffect(() => {
    api.config().then(setConfig).catch(() => setConfig(null));
  }, []);
  useEffect(() => {
    if (status?.kind !== "ok") return;
    const t = setTimeout(() => setStatus(null), 2500);
    return () => clearTimeout(t);
  }, [status]);

  async function open(id: string) {
    try {
      const d = await api.getDiagram(id);
      setStatus(null);
      setDoc({
        key: nextKey++,
        id: d.id,
        kind: d.kind,
        title: d.title,
        loaded: d,
        model: d.model ?? emptyModel(),
      });
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    }
  }

  function create(choice: string) {
    setStatus(null);
    if (choice === "cloud") setDoc(newDoc("cloud"));
    if (choice === "whiteboard") setDoc(newDoc("whiteboard", "Untitled whiteboard"));
    if (choice === "sample") setDoc(newDoc("cloud", "GCP web app (sample)", structuredClone(SAMPLE_MODEL)));
  }

  const onSaved = (d: Diagram) => {
    setDoc((cur) => ({ ...cur, id: d.id }));
    refreshList();
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">ArchCanvas</span>
        <input
          className="title"
          value={doc.title}
          onChange={(e) => setDoc((d) => ({ ...d, title: e.target.value }))}
          aria-label="Diagram title"
        />
        <span className="kind-pill">{doc.kind === "cloud" ? "GCP architecture" : "Whiteboard"}</span>
        <select value={doc.id ?? ""} onChange={(e) => e.target.value && void open(e.target.value)} aria-label="Open diagram">
          <option value="">Open…</option>
          {diagrams.map((d) => (
            <option key={d.id} value={d.id}>
              {d.kind === "cloud" ? "☁ " : "✎ "}
              {d.title}
            </option>
          ))}
        </select>
        <select
          value=""
          aria-label="New diagram"
          onChange={(e) => {
            create(e.target.value);
            e.target.value = "";
          }}
        >
          <option value="" disabled>
            New…
          </option>
          <option value="cloud">GCP architecture</option>
          <option value="sample">GCP architecture from sample</option>
          <option value="whiteboard">Whiteboard (Mermaid)</option>
        </select>
        <div className="spacer" />
        {status && (
          <span className={`status ${status.kind}`} title={status.text}>
            {status.text}
          </span>
        )}
        <div className="toolbar-slot" ref={setToolbar} />
      </header>

      <Suspense fallback={<div className="loading">Loading editor…</div>}>
        {doc.kind === "cloud" ? (
          <CloudEditor
            key={doc.key}
            diagramId={doc.id}
            initial={doc.model}
            title={doc.title}
            toolbar={toolbar}
            config={config}
            setStatus={setStatus}
            onSaved={onSaved}
          />
        ) : (
          <WhiteboardEditor
            key={doc.key}
            diagramId={doc.id}
            initial={doc.loaded}
            title={doc.title}
            toolbar={toolbar}
            setStatus={setStatus}
            onSaved={onSaved}
          />
        )}
      </Suspense>
    </div>
  );
}

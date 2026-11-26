import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  type OnNodesChange,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  applyOp,
  catalogEntry,
  diffModels,
  type DiagramModel,
  emptyModel,
  type ModelDiff,
  type Op,
  toDrawio,
  toMermaid,
  toPlantUml,
  validateModel,
} from "@archcanvas/shared";
import { api, type AppConfig, type Diagram } from "../api";
import { AgentPanel } from "./AgentPanel";
import { download, exportImage } from "./exporters";
import { type CloudNodeData, nodeTypes, toFlow, withGhosts } from "./flow";
import { autoLayout, hasLayout, structureKey } from "./layout";
import { Palette, Properties, Review, type Selection, TerraformPanel } from "./panels";
import { slug } from "../util";

type Tab = "assistant" | "properties" | "review" | "terraform";

interface Proposal {
  base: DiagramModel;
  model: DiagramModel;
  running: boolean;
  changed: boolean;
}

export interface EditorProps {
  diagramId: string | null;
  initial: DiagramModel;
  title: string;
  toolbar: HTMLElement | null;
  config: AppConfig | null;
  setStatus: (s: { kind: "ok" | "error"; text: string } | null) => void;
  onSaved: (d: Diagram) => void;
}

export function CloudEditor(props: EditorProps) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}

function Editor({ diagramId, initial, title, toolbar, config, setStatus, onSaved }: EditorProps) {
  const rf = useReactFlow();
  const [model, setModel] = useState<DiagramModel>(initial);
  const modelRef = useRef(model);
  modelRef.current = model;
  const [past, setPast] = useState<DiagramModel[]>([]);
  const [future, setFuture] = useState<DiagramModel[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [tab, setTab] = useState<Tab>("assistant");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [proposalLayout, setProposalLayout] = useState<DiagramModel["layout"] | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const readOnly = Boolean(proposal);

  const fit = useCallback(() => setTimeout(() => void rf.fitView({ padding: 0.15, duration: 300 }), 60), [rf]);

  // ---------------------------------------------------------------- model changes

  const commit = useCallback((next: DiagramModel) => {
    setPast((p) => [...p.slice(-99), modelRef.current]);
    setFuture([]);
    modelRef.current = next;
    setModel(next);
    setDirty(true);
  }, []);

  const op = useCallback(
    (o: Op) => {
      const r = applyOp(modelRef.current, o);
      if (!r.ok) return setStatus({ kind: "error", text: r.error });
      setStatus(null);
      commit(r.model);
      if (o.op === "remove_node") setSelection(null);
    },
    [commit, setStatus],
  );

  const undo = useCallback(() => {
    if (!past.length || readOnly) return;
    setFuture((f) => [modelRef.current, ...f]);
    const prev = past[past.length - 1];
    setPast((p) => p.slice(0, -1));
    setModel(prev);
    setDirty(true);
  }, [past, readOnly]);

  const redo = useCallback(() => {
    if (!future.length || readOnly) return;
    setPast((p) => [...p, modelRef.current]);
    setModel(future[0]);
    setFuture((f) => f.slice(1));
    setDirty(true);
  }, [future, readOnly]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // Auto-layout whenever some node has no position yet (new nodes, reparenting).
  const modelKey = structureKey(model);
  useEffect(() => {
    if (hasLayout(model)) return;
    let cancelled = false;
    void autoLayout(model).then((layout) => {
      if (cancelled) return;
      setModel((m) => (structureKey(m) === modelKey ? { ...m, layout } : m));
      fit();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey]);

  async function relayout() {
    const layout = await autoLayout(model);
    commit({ ...model, layout });
    fit();
  }

  // ---------------------------------------------------------------- agent proposals

  const diff: ModelDiff | undefined = useMemo(
    () => (proposal ? diffModels(proposal.base, proposal.model) : undefined),
    [proposal],
  );
  const display: DiagramModel = useMemo(() => {
    if (!proposal || !diff) return model;
    const shown = withGhosts(proposal.base, proposal.model, diff);
    return { ...shown, layout: proposalLayout ?? proposal.base.layout };
  }, [model, proposal, diff, proposalLayout]);

  const proposalKey = proposal && diff ? structureKey(withGhosts(proposal.base, proposal.model, diff)) : "";
  useEffect(() => {
    if (!proposal || !diff) return setProposalLayout(null);
    let cancelled = false;
    void autoLayout(withGhosts(proposal.base, proposal.model, diff)).then((l) => {
      if (!cancelled) {
        setProposalLayout(l);
        fit();
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposalKey]);

  const agentCallbacks = {
    onStart: (base: DiagramModel) => setProposal({ base, model: base, running: true, changed: false }),
    onProposal: (m: DiagramModel) => setProposal((p) => (p ? { ...p, model: m, changed: true } : p)),
    onDone: (m: DiagramModel, changed: boolean) =>
      setProposal((p) => (p && changed ? { ...p, model: m, running: false, changed: true } : null)),
    onShowTerraform: () => setTab("terraform"),
  };

  function accept() {
    if (!proposal) return;
    const ids = new Set(proposal.model.nodes.map((n) => n.id));
    const layout = Object.fromEntries(Object.entries(proposalLayout ?? {}).filter(([id]) => ids.has(id)));
    commit({ ...proposal.model, layout: hasLayout({ ...proposal.model, layout }) ? layout : {} });
    setProposal(null);
    setStatus({ kind: "ok", text: "Changes applied" });
    fit();
  }

  function reject() {
    setProposal(null);
    fit();
  }

  // ---------------------------------------------------------------- canvas

  const issues = useMemo(() => validateModel(model), [model]);
  const issueCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of issues) if (i.nodeId && i.severity !== "suggestion") m.set(i.nodeId, (m.get(i.nodeId) ?? 0) + 1);
    return m;
  }, [issues]);

  const flow = useMemo(
    () => toFlow(display, { diff, issues: proposal ? undefined : issueCounts, selected: selection?.type === "node" ? selection.id : null }),
    [display, diff, issueCounts, proposal, selection],
  );
  const [nodes, setNodes] = useState<Node<CloudNodeData>[]>(flow.nodes);
  useEffect(() => setNodes(flow.nodes), [flow.nodes]);

  const onNodesChange: OnNodesChange<Node<CloudNodeData>> = useCallback((changes) => {
    // Removal goes through the model (onNodesDelete); everything else is local until drag stop.
    for (const c of changes.getByType("remove")) changes.remove(c);
    setNodes((nds) => changes.applyTo(nds));
  }, []);

  function onNodeDragStop(_: unknown, __: Node, dragged: Node[]) {
    const layout = { ...model.layout };
    for (const n of dragged) layout[n.id] = { ...layout[n.id], x: n.position.x, y: n.position.y };
    commit({ ...model, layout });
  }

  function addResource(kind: string) {
    const entry = catalogEntry(kind)!;
    const sel = selection?.type === "node" ? model.nodes.find((n) => n.id === selection.id) : undefined;
    // Put it in the selected group, or the selected resource's group, when the catalog allows.
    const candidates = sel ? [sel, ...(sel.parentId ? [model.nodes.find((n) => n.id === sel.parentId)!] : [])] : [];
    const parent = candidates.find((c) => c && entry.parents.includes(c.kind));
    const base = kind.split(".").pop()!.replace(/^(cloud_|gcs_|memorystore_)/, "");
    let id = base;
    for (let i = 2; model.nodes.some((n) => n.id === id); i++) id = `${base}_${i}`;
    const r = applyOp(model, { op: "add_node", id, kind, label: entry.label, parentId: parent?.id });
    if (!r.ok) return setStatus({ kind: "error", text: r.error });
    commit(r.model);
    setSelection({ type: "node", id });
    setTab("properties");
  }

  // ---------------------------------------------------------------- save / export

  async function save() {
    setSaving(true);
    try {
      const d = diagramId
        ? await api.updateDiagram(diagramId, { title, kind: "cloud", model })
        : await api.createDiagram({ title, kind: "cloud", model });
      setDirty(false);
      setStatus({ kind: "ok", text: "Saved" });
      onSaved(d);
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function exportAs(format: string) {
    const name = slug(title);
    try {
      switch (format) {
        case "drawio":
          return download(`${name}.drawio`, toDrawio(model, title), "application/xml");
        case "mermaid":
          return download(`${name}.mmd`, toMermaid(model));
        case "plantuml":
          return download(`${name}.puml`, toPlantUml(model));
        case "json":
          return download(`${name}.archcanvas.json`, JSON.stringify({ title, kind: "cloud", model }, null, 2), "application/json");
        case "svg":
        case "png":
          return await exportImage(format, rf.getNodesBounds(rf.getNodes()), `${name}.${format}`);
      }
    } catch (e) {
      setStatus({ kind: "error", text: `Export failed: ${(e as Error).message}` });
    }
  }

  // ---------------------------------------------------------------- render

  const tools = (
    <>
      <button onClick={undo} disabled={!past.length || readOnly} title="Undo (⌘Z)">
        Undo
      </button>
      <button onClick={redo} disabled={!future.length || readOnly} title="Redo (⇧⌘Z)">
        Redo
      </button>
      <button onClick={() => void relayout()} disabled={readOnly || !model.nodes.length}>
        Auto layout
      </button>
      <select
        value=""
        aria-label="Export"
        disabled={!model.nodes.length}
        onChange={(e) => {
          void exportAs(e.target.value);
          e.target.value = "";
        }}
      >
        <option value="" disabled>
          Export…
        </option>
        <option value="drawio">draw.io (.drawio)</option>
        <option value="svg">SVG image</option>
        <option value="png">PNG image</option>
        <option value="mermaid">Mermaid (.mmd)</option>
        <option value="plantuml">PlantUML (.puml)</option>
        <option value="json">ArchCanvas JSON</option>
      </select>
      <button className="primary" onClick={() => void save()} disabled={saving || readOnly}>
        {saving ? "Saving…" : dirty || !diagramId ? "Save" : "Saved"}
      </button>
    </>
  );

  return (
    <div className="cloud">
      {toolbar && createPortal(tools, toolbar)}
      <Palette onAdd={addResource} disabled={readOnly} />

      <div className="cloud-canvas">
        <ReactFlow
          nodes={nodes}
          edges={flow.edges as Edge[]}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onNodesDelete={(ns) => ns.forEach((n) => op({ op: "remove_node", id: n.id }))}
          onEdgesDelete={(es) => es.forEach((e) => op({ op: "disconnect", from: e.source, to: e.target }))}
          onConnect={(c) => c.source && c.target && op({ op: "connect", from: c.source, to: c.target })}
          onNodeClick={(_, n) => {
            setSelection({ type: "node", id: n.id });
            if (tab !== "assistant") setTab("properties");
          }}
          onEdgeClick={(_, e) => {
            setSelection({ type: "edge", id: e.id });
            setTab("properties");
          }}
          onPaneClick={() => setSelection(null)}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
          fitView
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeStrokeWidth={2} />
        </ReactFlow>
        {!model.nodes.length && !proposal && (
          <div className="canvas-empty">
            <h2>Start a GCP architecture</h2>
            <p>Describe it to the assistant on the right, or add resources from the palette.</p>
          </div>
        )}
        {proposal && (
          <div className="proposal-bar">
            {proposal.running ? (
              <span>The assistant is editing… changes appear highlighted.</span>
            ) : (
              <>
                <span>
                  Proposed: <b className="add">+{diff!.addedNodes.length}</b> <b className="chg">~{diff!.changedNodes.length}</b>{" "}
                  <b className="del">−{diff!.removedNodes.length}</b> resources,{" "}
                  <b className="add">+{diff!.addedEdges.length}</b> <b className="del">−{diff!.removedEdges.length}</b> connections
                </span>
                <button className="primary" onClick={accept}>
                  Accept
                </button>
                <button onClick={reject}>Reject</button>
              </>
            )}
          </div>
        )}
      </div>

      <aside className="inspector">
        <div className="tabs">
          {(
            [
              ["assistant", "Assistant"],
              ["properties", "Properties"],
              ["review", `Review${issues.filter((i) => i.severity !== "suggestion").length ? ` (${issues.filter((i) => i.severity !== "suggestion").length})` : ""}`],
              ["terraform", "Terraform"],
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </div>
        <div className="tab-body" hidden={tab !== "assistant"}>
          <AgentPanel model={model} diagramId={diagramId} config={config} busy={Boolean(proposal && !proposal.running)} callbacks={agentCallbacks} />
        </div>
        <div className="tab-body scroll" hidden={tab !== "properties"}>
          <Properties model={model} selection={selection} onOp={op} readOnly={readOnly} />
        </div>
        <div className="tab-body scroll" hidden={tab !== "review"}>
          <Review
            issues={issues}
            onSelect={(id) => {
              setSelection({ type: "node", id });
              const n = rf.getNode(id);
              if (n) void rf.fitView({ nodes: [n], padding: 1.5, duration: 300 });
            }}
          />
        </div>
        <div className="tab-body scroll" hidden={tab !== "terraform"}>
          <TerraformPanel model={proposal ? proposal.model : model} title={title} />
        </div>
      </aside>
    </div>
  );
}

export const newCloudModel = (): DiagramModel => emptyModel();

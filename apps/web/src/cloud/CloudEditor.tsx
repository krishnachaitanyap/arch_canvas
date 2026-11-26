import { type DragEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  type OnNodesChange,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  applyOp,
  applyOps,
  catalogEntry,
  diffModels,
  type DiagramModel,
  emptyModel,
  generateWorkflows,
  type ModelDiff,
  NODE_ID,
  type Op,
  toArchitectureDoc,
  toDrawio,
  toMermaid,
  toPlantUml,
  validateModel,
  type Workflow,
} from "@archcanvas/shared";
import { api, type AppConfig, type Diagram } from "../api";
import type { CurrentState } from "../history/VersionHistory";
import { slug } from "../util";
import { AgentPanel } from "./AgentPanel";
import { download, exportImage } from "./exporters";
import { type CloudNodeData, EditorContext, type EditorActions, edgeTypes, type Highlight, nodeTypes, toFlow, withGhosts } from "./flow";
import { FlowsPanel } from "./FlowsPanel";
import { absBox, type AlignMode, align, type Clip, containerAt, copySelection, growGroups, pasteOps, placeMissing, relativeAt, reparentOps } from "./geometry";
import { autoLayout, hasLayout, structureKey } from "./layout";
import { DRAG_TYPE, Palette, type PaletteItem } from "./Palette";
import { Presentation } from "./Presentation";
import { Properties, Review, type Selection, TerraformPanel } from "./panels";

export type Tab = "assistant" | "properties" | "flows" | "review" | "terraform";

interface Proposal {
  base: DiagramModel;
  model: DiagramModel;
  running: boolean;
  changed: boolean;
}

interface Menu {
  x: number;
  y: number;
  /** Where on the canvas (flow coordinates) the menu was opened. */
  at: { x: number; y: number };
  target: { type: "node" | "edge"; id: string } | { type: "pane" };
}

export interface EditorProps {
  diagramId: string | null;
  /** Project that a new diagram is created in on first save. */
  projectId: string | null;
  canEdit: boolean;
  /** Lets the shell read the editor's current (possibly unsaved) state, e.g. for comparisons. */
  registerCurrent: (fn: () => CurrentState) => void;
  initial: DiagramModel;
  title: string;
  toolbar: HTMLElement | null;
  config: AppConfig | null;
  initialTab?: Tab;
  onTabChange?: (tab: Tab) => void;
  /** Presentation mode is part of the URL; the shell passes it down and handles open/close. */
  presenting?: { start?: number } | null;
  onPresent?: (startWorkflow?: number) => void;
  onExitPresent?: () => void;
  setStatus: (s: { kind: "ok" | "error"; text: string } | null) => void;
  onSaved: (d: Diagram) => void;
}

// Clipboard shared across diagrams in this tab.
let clipboard: Clip | null = null;

export function CloudEditor(props: EditorProps) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}

function Editor({
  diagramId,
  projectId,
  canEdit,
  registerCurrent,
  initial,
  title,
  toolbar,
  config,
  initialTab,
  onTabChange,
  presenting,
  onPresent,
  onExitPresent,
  setStatus,
  onSaved,
}: EditorProps) {
  const rf = useReactFlow();
  const [model, setModel] = useState<DiagramModel>(initial);
  const modelRef = useRef(model);
  modelRef.current = model;
  const [past, setPast] = useState<DiagramModel[]>([]);
  const [future, setFuture] = useState<DiagramModel[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [tab, setTabState] = useState<Tab>(initialTab ?? "assistant");
  const setTab = useCallback(
    (t: Tab) => {
      setTabState(t);
      onTabChange?.(t);
    },
    [onTabChange],
  );
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [proposalLayout, setProposalLayout] = useState<DiagramModel["layout"] | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const readOnly = Boolean(proposal) || !canEdit;
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [snap, setSnap] = useState(() => localStorage.getItem("archcanvas.snap") !== "0");
  const [paletteW, setPaletteW] = usePanelWidth("archcanvas.paletteW", 260);
  const [inspectorW, setInspectorW] = usePanelWidth("archcanvas.inspectorW", 380);
  const canvasRef = useRef<HTMLDivElement>(null);

  // AI-rewritten workflow wording, valid only for the content it was written for.
  const [narrated, setNarrated] = useState<{ key: string; workflows: Workflow[] } | null>(null);
  const contentKey = useMemo(() => JSON.stringify([model.nodes, model.edges]), [model.nodes, model.edges]);
  const workflows = useMemo(
    () => (narrated && narrated.key === contentKey ? narrated.workflows : generateWorkflows(model)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contentKey, narrated],
  );
  useEffect(() => {
    if (tab !== "flows") setHighlight(null);
  }, [tab]);

  useEffect(() => {
    registerCurrent(() => ({ kind: "cloud", model: modelRef.current, source: "", dirty: dirtyRef.current || !diagramId }));
  }, [registerCurrent, diagramId]);

  const fit = useCallback(() => setTimeout(() => void rf.fitView({ padding: 0.15, duration: 300 }), 60), [rf]);

  // ---------------------------------------------------------------- model changes

  const commit = useCallback((next: DiagramModel) => {
    setPast((p) => [...p.slice(-99), modelRef.current]);
    setFuture([]);
    modelRef.current = next;
    setModel(next);
    setDirty(true);
  }, []);

  /** Applies operations, then lets `layout` adjust positions; one undo step. */
  const change = useCallback(
    (ops: Op[], layout?: (m: DiagramModel) => DiagramModel["layout"]) => {
      const r = ops.length ? applyOps(modelRef.current, ops) : { ok: true as const, model: modelRef.current };
      if (!r.ok) {
        setStatus({ kind: "error", text: r.error });
        return false;
      }
      const next = layout ? { ...r.model, layout: layout(r.model) } : r.model;
      commit({ ...next, layout: growGroups(next) });
      return true;
    },
    [commit, setStatus],
  );

  const op = useCallback(
    (o: Op) => {
      if (change([o])) {
        setStatus(null);
        if (o.op === "remove_node") setSelection(null);
      }
    },
    [change, setStatus],
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

  // Positions: a fresh diagram (nothing placed yet) gets a full auto-layout; after that only
  // new or re-parented nodes are placed, so manual arrangement is never thrown away.
  const modelKey = structureKey(model);
  useEffect(() => {
    if (hasLayout(model)) return;
    const nothingPlaced = model.nodes.every((n) => !model.layout[n.id]);
    if (!nothingPlaced) {
      setModel((m) => ({ ...m, layout: placeMissing(m) }));
      return;
    }
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

  const diff: ModelDiff | undefined = useMemo(() => (proposal ? diffModels(proposal.base, proposal.model) : undefined), [proposal]);
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
    onDone: (m: DiagramModel, changed: boolean) => setProposal((p) => (p && changed ? { ...p, model: m, running: false, changed: true } : null)),
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
    () =>
      toFlow(display, {
        diff,
        issues: proposal ? undefined : issueCounts,
        selectedIds: proposal ? new Set() : selectedIds,
        highlight: proposal ? null : highlight,
        editable: !readOnly,
      }),
    [display, diff, issueCounts, proposal, selectedIds, highlight, readOnly],
  );
  const [nodes, setNodes] = useState<Node<CloudNodeData>[]>(flow.nodes);
  useEffect(() => setNodes(flow.nodes), [flow.nodes]);

  const onNodesChange: OnNodesChange<Node<CloudNodeData>> = useCallback((changes) => {
    // Removal goes through the model (onNodesDelete); moves and resizes are committed at the end.
    for (const c of changes.getByType("remove")) changes.remove(c);
    setNodes((nds) => changes.applyTo(nds));
  }, []);

  const nodeIds = (ids: Iterable<string>) => [...ids].filter((id) => !id.startsWith("edge:"));

  /** Drop at the end of a drag: positions, and moving into or out of groups. */
  function onNodeDragStop(_: unknown, __: Node, dragged: Node[]) {
    const m = modelRef.current;
    const ids = new Set(dragged.map((n) => n.id));
    // Children move with a dragged parent; only re-parent the outermost dragged nodes.
    const roots = dragged.filter((n) => !m.nodes.find((x) => x.id === n.id)?.parentId || !ids.has(m.nodes.find((x) => x.id === n.id)!.parentId!));
    const layout = { ...m.layout };
    for (const n of dragged) layout[n.id] = { ...layout[n.id], x: Math.round(n.position.x), y: Math.round(n.position.y) };
    let next: DiagramModel = { ...m, layout };
    const moved: string[] = [];
    for (const n of roots) {
      const node = next.nodes.find((x) => x.id === n.id)!;
      const abs = absBox(next, n.id);
      const target = containerAt(next, { x: abs.x + abs.w / 2, y: abs.y + Math.min(abs.h / 2, 30) }, node.kind, [n.id]);
      if ((target?.id ?? undefined) === (node.parentId ?? undefined)) continue;
      const { ops, layout: fix } = reparentOps(next, n.id, target?.id);
      const r = applyOps(next, ops);
      if (!r.ok) continue;
      next = { ...r.model, layout: fix(r.model) };
      moved.push(`${node.label} → ${target ? target.label : "top level"}`);
    }
    commit({ ...next, layout: growGroups(next) });
    if (moved.length) setStatus({ kind: "ok", text: `Moved ${moved.join(", ")}` });
  }

  /** Adds a palette item: at a canvas point (drag and drop), or next to the selection (click). */
  function addItem(item: PaletteItem, at?: { x: number; y: number }) {
    if (readOnly) return;
    const m = modelRef.current;
    const entry = catalogEntry(item.kind)!;
    let parentId: string | undefined;
    if (at) parentId = containerAt(m, at, item.kind)?.id;
    else {
      const sel = selection?.type === "node" ? m.nodes.find((n) => n.id === selection.id) : undefined;
      const candidates = sel ? [sel, ...(sel.parentId ? [m.nodes.find((n) => n.id === sel.parentId)!] : [])] : [];
      parentId = candidates.find((c) => c && entry.parents.includes(c.kind))?.id;
    }
    const label = item.kind === "generic.note" ? "Double-click to edit this note" : item.label;
    const base =
      item.kind === "generic.note"
        ? "note"
        : item.icon || item.kind === "generic.group"
          ? item.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "n_$1").slice(0, 30) || "component"
          : item.kind.split(".").pop()!.replace(/^(cloud_|gcs_|memorystore_)/, "");
    let id = NODE_ID.test(base) ? base : "node";
    for (let i = 2; m.nodes.some((n) => n.id === id); i++) id = `${base}_${i}`;
    const ok = change([{ op: "add_node", id, kind: item.kind, label: label.slice(0, item.kind === "generic.note" ? 500 : 80), parentId, ...(item.icon ? { icon: item.icon } : {}) }], (after) => {
      if (!at) return placeMissing(after);
      return { ...after.layout, [id]: relativeAt(after, parentId, at, item.kind) };
    });
    if (!ok) return;
    setSelection({ type: "node", id });
    setSelectedIds(new Set([id]));
    if (item.kind === "generic.note") setEditing(id);
    else setTab("properties");
  }

  function onDrop(e: DragEvent) {
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;
    e.preventDefault();
    addItem(JSON.parse(raw) as PaletteItem, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  }

  function removeSelected(ids = selectedIds) {
    const ops: Op[] = [];
    for (const id of ids) {
      if (id.startsWith("edge:")) {
        const e = modelRef.current.edges.find((x) => x.id === id.slice(5));
        if (e) ops.push({ op: "disconnect", from: e.from, to: e.to });
      }
    }
    // Nodes after edges; skip descendants of removed groups (their children move up).
    for (const id of nodeIds(ids)) ops.push({ op: "remove_node", id });
    if (ops.length && change(ops)) {
      setSelection(null);
      setSelectedIds(new Set());
    }
  }

  function copy(ids = nodeIds(selectedIds)) {
    const clip = copySelection(modelRef.current, ids);
    if (!clip) return false;
    clipboard = clip;
    try {
      localStorage.setItem("archcanvas.clipboard", JSON.stringify(clip));
    } catch {
      /* too large to share across tabs; this tab still has it */
    }
    return true;
  }

  function paste(at?: { x: number; y: number }) {
    const clip = clipboard ?? (JSON.parse(localStorage.getItem("archcanvas.clipboard") ?? "null") as Clip | null);
    if (!clip || readOnly) return;
    const m = modelRef.current;
    let offset = 32;
    if (at) {
      const first = clip.nodes.find((n) => !clip.nodes.some((p) => p.id === n.parentId));
      const l = first ? clip.layout[first.id] : undefined;
      offset = 0;
      if (l) {
        const shifted: Clip = { ...clip, layout: Object.fromEntries(Object.entries(clip.layout).map(([k, v]) => [k, k === first!.id ? { ...v, x: at.x, y: at.y } : v])) };
        return finishPaste(pasteOps(m, shifted, offset));
      }
    }
    finishPaste(pasteOps(m, clip, offset));
  }

  function finishPaste(r: ReturnType<typeof pasteOps>) {
    if ("error" in r) return setStatus({ kind: "error", text: r.error });
    commit(r.model);
    setSelectedIds(new Set(r.ids));
    setSelection(r.ids.length === 1 ? { type: "node", id: r.ids[0] } : null);
  }

  function duplicate(ids = nodeIds(selectedIds)) {
    const clip = copySelection(modelRef.current, ids);
    if (clip) finishPaste(pasteOps(modelRef.current, clip, 32));
  }

  function doAlign(mode: AlignMode) {
    const ids = nodeIds(selectedIds);
    if (ids.length < 2) return;
    commit({ ...modelRef.current, layout: align(modelRef.current, ids, mode) });
  }

  function nudge(dx: number, dy: number) {
    const ids = nodeIds(selectedIds);
    if (!ids.length || readOnly) return;
    const m = modelRef.current;
    const layout = { ...m.layout };
    for (const id of ids) if (layout[id]) layout[id] = { ...layout[id], x: layout[id].x + dx, y: layout[id].y + dy };
    commit({ ...m, layout: growGroups({ ...m, layout }) });
  }

  // Keyboard shortcuts (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if (!t.closest(".cloud") && t !== document.body) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && k === "y") {
        e.preventDefault();
        redo();
      } else if (mod && k === "c") {
        if (copy()) e.preventDefault();
      } else if (mod && k === "x" && !readOnly) {
        if (copy()) {
          e.preventDefault();
          removeSelected();
        }
      } else if (mod && k === "v" && !readOnly) {
        e.preventDefault();
        paste();
      } else if (mod && k === "d" && !readOnly) {
        e.preventDefault();
        duplicate();
      } else if (mod && k === "a") {
        e.preventDefault();
        setSelectedIds(new Set(modelRef.current.nodes.map((n) => n.id)));
      } else if (k === "f2" && selection?.type === "node" && !readOnly) {
        e.preventDefault();
        setEditing(selection.id);
      } else if (k === "escape") {
        setMenu(null);
        setSelectedIds(new Set());
        setSelection(null);
      } else if (k.startsWith("arrow") && !readOnly && nodeIds(selectedIds).length) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        nudge(k === "arrowleft" ? -step : k === "arrowright" ? step : 0, k === "arrowup" ? -step : k === "arrowdown" ? step : 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const actions: EditorActions = {
    editable: !readOnly,
    editing,
    setEditing,
    rename: (id, label) => op({ op: "update_node", id, label: label.slice(0, modelRef.current.nodes.find((n) => n.id === id)?.kind === "generic.note" ? 500 : 80) }),
    renameEdge: (edgeId, label) => {
      const e = modelRef.current.edges.find((x) => x.id === edgeId);
      if (e) op({ op: "update_edge", from: e.from, to: e.to, label });
    },
    resized: (id, box) => {
      const m = modelRef.current;
      commit({ ...m, layout: growGroups({ ...m, layout: { ...m.layout, [id]: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) } } }) });
    },
  };

  // ---------------------------------------------------------------- save / export

  async function save() {
    setSaving(true);
    try {
      if (!diagramId && !projectId) throw new Error("Pick a project first");
      const d = diagramId
        ? await api.updateDiagram(diagramId, { title, kind: "cloud", model })
        : await api.createDiagram({ projectId: projectId!, title, kind: "cloud", model });
      setDirty(false);
      setStatus({ kind: "ok", text: d.versionCreated === false ? "No changes since the last version" : `Saved as v${d.version}` });
      onSaved(d);
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  // Save shortcut works even while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (canEdit && !readOnly && !saving) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
        case "doc":
          return download(`${name}-architecture.md`, toArchitectureDoc(model, title, workflows), "text/markdown");
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

  const multi = nodeIds(selectedIds).length;
  const tools = (
    <>
      <button onClick={undo} disabled={!past.length || readOnly} title="Undo (⌘Z)">
        Undo
      </button>
      <button onClick={redo} disabled={!future.length || readOnly} title="Redo (⇧⌘Z)">
        Redo
      </button>
      <button
        className={snap ? "toggle on" : "toggle"}
        onClick={() => {
          localStorage.setItem("archcanvas.snap", snap ? "0" : "1");
          setSnap(!snap);
        }}
        title="Snap to grid"
      >
        Grid
      </button>
      <button
        onClick={() => {
          if (!model.nodes.length || readOnly) return;
          if (Object.keys(model.layout).length && !confirm("Auto layout rearranges every shape. Continue? (You can undo.)")) return;
          void relayout();
        }}
        disabled={readOnly || !model.nodes.length}
      >
        Auto layout
      </button>
      <button onClick={() => onPresent?.()} disabled={!model.edges.length || Boolean(proposal)} title="Walk through the workflows">
        Present
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
        <option value="doc">Architecture doc (.md)</option>
        <option value="json">ArchCanvas JSON</option>
      </select>
      {canEdit ? (
        <button className="primary" onClick={() => void save()} disabled={saving || readOnly} title="Save (⌘S)">
          {saving ? "Saving…" : dirty || !diagramId ? "Save" : "Saved"}
        </button>
      ) : (
        <span className="kind-pill">View only</span>
      )}
    </>
  );

  const openMenu = (e: React.MouseEvent, target: Menu["target"]) => {
    e.preventDefault();
    const box = canvasRef.current!.getBoundingClientRect();
    setMenu({ x: e.clientX - box.left, y: e.clientY - box.top, at: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }), target });
  };

  return (
    <EditorContext.Provider value={actions}>
      <div className="cloud">
        {toolbar && createPortal(tools, toolbar)}
        {presenting && <Presentation model={model} title={title} workflows={workflows} startWorkflow={presenting.start} onClose={() => onExitPresent?.()} />}

        <aside className="palette" style={{ width: paletteW }}>
          <Palette onAdd={(item) => addItem(item)} disabled={readOnly} />
        </aside>
        <Resizer onDrag={(dx) => setPaletteW((w) => w + dx)} />

        <div className="cloud-canvas" ref={canvasRef} onDragOver={(e) => e.dataTransfer.types.includes(DRAG_TYPE) && (e.preventDefault(), (e.dataTransfer.dropEffect = "copy"))} onDrop={onDrop}>
          <ReactFlow
            nodes={nodes}
            edges={flow.edges as Edge[]}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onNodesDelete={() => undefined}
            onEdgesDelete={() => undefined}
            onBeforeDelete={async () => {
              removeSelected();
              return false;
            }}
            onConnect={(c) => c.source && c.target && op({ op: "connect", from: c.source, to: c.target })}
            onReconnect={(old, c) => {
              const e = modelRef.current.edges.find((x) => x.id === old.id);
              if (!e || !c.source || !c.target || (c.source === e.from && c.target === e.to)) return;
              change([
                { op: "disconnect", from: e.from, to: e.to },
                { op: "connect", from: c.source, to: c.target, label: e.label, protocol: e.protocol, routing: e.routing },
              ]);
            }}
            edgesReconnectable={!readOnly}
            onSelectionChange={({ nodes: ns, edges: es }) => {
              const ids = new Set([...ns.map((n) => n.id), ...es.map((e) => `edge:${e.id}`)]);
              setSelectedIds((prev) => (prev.size === ids.size && [...ids].every((i) => prev.has(i)) ? prev : ids));
              // Only explicit actions clear the selection (pane click, Esc, delete): React Flow also
              // reports empty selections while nodes are re-rendered.
              if (ns.length === 1 && !es.length) setSelection({ type: "node", id: ns[0].id });
              else if (es.length === 1 && !ns.length) setSelection({ type: "edge", id: es[0].id });
            }}
            onNodeClick={() => tab !== "assistant" && tab !== "flows" && setTab("properties")}
            onEdgeClick={() => setTab("properties")}
            onPaneClick={() => {
              setHighlight(null);
              setMenu(null);
              setSelection(null);
              setSelectedIds(new Set());
            }}
            onNodeContextMenu={(e, n) => {
              if (!selectedIds.has(n.id)) setSelectedIds(new Set([n.id]));
              setSelection({ type: "node", id: n.id });
              openMenu(e, { type: "node", id: n.id });
            }}
            onEdgeContextMenu={(e, ed) => {
              setSelection({ type: "edge", id: ed.id });
              openMenu(e, { type: "edge", id: ed.id });
            }}
            onPaneContextMenu={(e) => openMenu(e as React.MouseEvent, { type: "pane" })}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            connectionMode={ConnectionMode.Loose}
            deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
            multiSelectionKeyCode={["Meta", "Control", "Shift"]}
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            panOnDrag={[1, 2]}
            panOnScroll
            zoomActivationKeyCode={["Meta", "Control"]}
            snapToGrid={snap}
            snapGrid={[10, 10]}
            fitView
            minZoom={0.1}
            maxZoom={3}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={snap ? 20 : 18} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeStrokeWidth={2} />
          </ReactFlow>

          {multi >= 2 && !readOnly && (
            <div className="align-bar" role="toolbar" aria-label="Align">
              <span className="hint">{multi} selected</span>
              {(
                [
                  ["left", "⇤", "Align left"],
                  ["center", "↔", "Align centres horizontally"],
                  ["right", "⇥", "Align right"],
                  ["top", "⤒", "Align top"],
                  ["middle", "↕", "Align middles"],
                  ["bottom", "⤓", "Align bottom"],
                  ["hspace", "⋯", "Distribute horizontally"],
                  ["vspace", "⋮", "Distribute vertically"],
                ] as [AlignMode, string, string][]
              ).map(([m, glyph, label]) => (
                <button key={m} onClick={() => doAlign(m)} title={label} aria-label={label}>
                  {glyph}
                </button>
              ))}
              <button onClick={() => duplicate()} title="Duplicate (⌘D)">
                Duplicate
              </button>
              <button className="danger" onClick={() => removeSelected()} title="Delete">
                Delete
              </button>
            </div>
          )}

          {menu && (
            <ContextMenu
              menu={menu}
              readOnly={readOnly}
              onClose={() => setMenu(null)}
              actions={{
                rename: (id) => setEditing(id),
                properties: () => setTab("properties"),
                duplicate: (id) => duplicate(selectedIds.has(id) ? nodeIds(selectedIds) : [id]),
                copy: (id) => copy(selectedIds.has(id) ? nodeIds(selectedIds) : [id]),
                remove: (t) => removeSelected(t.type === "edge" ? new Set([`edge:${t.id}`]) : selectedIds.has(t.id) ? selectedIds : new Set([t.id])),
                paste: (at) => paste(at),
                addNote: (at) => addItem({ key: "note", kind: "generic.note", label: "Note" }, at),
                addGroup: (at) => addItem({ key: "group", kind: "generic.group", label: "Group" }, at),
                routing: (edgeId, routing) => {
                  const e = model.edges.find((x) => x.id === edgeId);
                  if (e) op({ op: "update_edge", from: e.from, to: e.to, routing: routing === "orthogonal" ? null : (routing as never) });
                },
                editEdgeLabel: (edgeId) => setEditing(`edge:${edgeId}`),
                fit: () => fit(),
              }}
            />
          )}

          {!model.nodes.length && !proposal && (
            <div className="canvas-empty">
              <h2>Start a GCP architecture</h2>
              <p>Drag resources and icons from the left, describe it to the assistant on the right, or right-click to add a note.</p>
            </div>
          )}
          {proposal && (
            <div className="proposal-bar">
              {proposal.running ? (
                <span>The assistant is editing… changes appear highlighted.</span>
              ) : (
                <>
                  <span>
                    Proposed: <b className="add">+{diff!.addedNodes.length}</b> <b className="chg">~{diff!.changedNodes.length}</b> <b className="del">−{diff!.removedNodes.length}</b>{" "}
                    resources, <b className="add">+{diff!.addedEdges.length}</b> <b className="del">−{diff!.removedEdges.length}</b> connections
                  </span>
                  <button className="primary" onClick={accept} disabled={!canEdit} title={canEdit ? undefined : "Viewers cannot change diagrams"}>
                    Accept
                  </button>
                  <button onClick={reject}>Reject</button>
                </>
              )}
            </div>
          )}
        </div>

        <Resizer onDrag={(dx) => setInspectorW((w) => w - dx)} />
        <aside className="inspector" style={{ width: inspectorW }}>
          <div className="tabs">
            {(
              [
                ["assistant", "Assistant"],
                ["properties", "Properties"],
                ["flows", "Flows"],
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
            {multi >= 2 ? (
              <p className="hint pad">{multi} shapes selected. Use the toolbar on the canvas to align, distribute, duplicate or delete them.</p>
            ) : (
              <Properties model={model} selection={selection} onOp={op} readOnly={readOnly} />
            )}
          </div>
          <div className="tab-body scroll" hidden={tab !== "flows"}>
            <FlowsPanel
              model={model}
              title={title}
              workflows={workflows}
              aiNarrated={Boolean(narrated && narrated.key === contentKey)}
              aiEnabled={Boolean(config?.aiEnabled)}
              onNarrated={(w) => setNarrated(w ? { key: contentKey, workflows: w } : null)}
              onHighlight={(h, focus) => {
                setHighlight(h);
                const ns = (focus ?? h?.nodes ?? []).map((id) => rf.getNode(id)).filter((n) => n !== undefined);
                if (ns.length) void rf.fitView({ nodes: ns, padding: 0.8, duration: 350, maxZoom: 1.3 });
              }}
              onPresent={(start) => onPresent?.(start)}
              setStatus={setStatus}
            />
          </div>
          <div className="tab-body scroll" hidden={tab !== "review"}>
            <Review
              issues={issues}
              onSelect={(id) => {
                setSelection({ type: "node", id });
                setSelectedIds(new Set([id]));
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
    </EditorContext.Provider>
  );
}

// ---------------------------------------------------------------- pieces

function ContextMenu({
  menu,
  readOnly,
  onClose,
  actions,
}: {
  menu: Menu;
  readOnly: boolean;
  onClose: () => void;
  actions: {
    rename: (id: string) => void;
    properties: () => void;
    duplicate: (id: string) => void;
    copy: (id: string) => void;
    remove: (t: { type: "node" | "edge"; id: string }) => void;
    paste: (at: { x: number; y: number }) => void;
    addNote: (at: { x: number; y: number }) => void;
    addGroup: (at: { x: number; y: number }) => void;
    routing: (edgeId: string, routing: string) => void;
    editEdgeLabel: (edgeId: string) => void;
    fit: () => void;
  };
}) {
  const item = (label: string, fn: () => void, opts: { disabled?: boolean; danger?: boolean; hint?: string } = {}) => (
    <button
      className={opts.danger ? "danger" : ""}
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
  const t = menu.target;
  return (
    <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onContextMenu={(e) => e.preventDefault()} role="menu">
      {t.type === "node" && (
        <>
          {item("Rename", () => actions.rename(t.id), { disabled: readOnly, hint: "F2" })}
          {item("Properties…", () => actions.properties())}
          {item("Copy", () => actions.copy(t.id), { hint: "⌘C" })}
          {item("Duplicate", () => actions.duplicate(t.id), { disabled: readOnly, hint: "⌘D" })}
          <hr />
          {item("Delete", () => actions.remove(t), { disabled: readOnly, danger: true, hint: "⌫" })}
        </>
      )}
      {t.type === "edge" && (
        <>
          {item("Edit label", () => actions.editEdgeLabel(t.id), { disabled: readOnly })}
          {item("Orthogonal line", () => actions.routing(t.id, "orthogonal"), { disabled: readOnly })}
          {item("Straight line", () => actions.routing(t.id, "straight"), { disabled: readOnly })}
          {item("Curved line", () => actions.routing(t.id, "curved"), { disabled: readOnly })}
          <hr />
          {item("Delete connection", () => actions.remove(t), { disabled: readOnly, danger: true })}
        </>
      )}
      {t.type === "pane" && (
        <>
          {item("Paste here", () => actions.paste(menu.at), { disabled: readOnly, hint: "⌘V" })}
          {item("Add note here", () => actions.addNote(menu.at), { disabled: readOnly })}
          {item("Add group here", () => actions.addGroup(menu.at), { disabled: readOnly })}
          <hr />
          {item("Fit to screen", () => actions.fit())}
        </>
      )}
    </div>
  );
}

/** A thin vertical handle between panels; drag to resize. */
function Resizer({ onDrag }: { onDrag: (dx: number) => void }) {
  const start = (e: ReactPointerEvent) => {
    e.preventDefault();
    let last = e.clientX;
    const move = (ev: PointerEvent) => {
      onDrag(ev.clientX - last);
      last = ev.clientX;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return <div className="resizer" onPointerDown={start} role="separator" aria-orientation="vertical" />;
}

function usePanelWidth(key: string, initial: number): [number, (fn: (w: number) => number) => void] {
  const [w, setW] = useState(() => Number(localStorage.getItem(key)) || initial);
  const set = useCallback(
    (fn: (w: number) => number) =>
      setW((cur) => {
        const next = Math.max(180, Math.min(640, fn(cur)));
        localStorage.setItem(key, String(Math.round(next)));
        return next;
      }),
    [key],
  );
  return [w, set];
}

export const newCloudModel = (): DiagramModel => emptyModel();

import { type DragEvent, lazy, type PointerEvent as ReactPointerEvent, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  useViewport,
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
  type DrawioPage,
  addPage,
  movePage,
  removePage,
  renamePage,
  type Op,
  pageModel,
  pageOf,
  pagesOf,
  resolvedProps,
  SHAPE_LABELS,
  type ShapeName,
  readDrawio,
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
import { ContextMenu, type MenuState } from "./ContextMenu";
import { FormatBar, type LineStyle } from "./FormatBar";
import { PageTabs } from "./PageTabs";
import { Presentation } from "./Presentation";
import { Properties, Review, type Selection, TerraformPanel } from "./panels";

const ImportDialog = lazy(() => import("../home/ImportDialog"));

export type Tab = "assistant" | "properties" | "flows" | "review" | "terraform";

interface Proposal {
  base: DiagramModel;
  model: DiagramModel;
  running: boolean;
  changed: boolean;
}

type Menu = MenuState;

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
  const { zoom } = useViewport();
  /** How new connections are drawn (the toolbar's connector style). */
  const [newRouting, setNewRouting] = useState<"orthogonal" | "straight" | "curved">("orthogonal");
  /** Pattern and arrowheads for new lines (the toolbar's line style; remembered on this device). */
  const [newLine, setNewLine] = useState<LineStyle>(() => {
    try {
      return { dash: "solid", ends: "end", ...JSON.parse(localStorage.getItem("archcanvas.lineStyle") ?? "{}") };
    } catch {
      return { dash: "solid", ends: "end" };
    }
  });
  const [paletteOpen, setPaletteOpen] = useState(true);
  /** The canvas tab in view; everything you add, paste or lay out happens on it. */
  const [activePage, setActivePage] = useState<string>(() => pagesOf(initial).at(0)!.id);
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
  const [autoSaving, setAutoSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const lastTitle = useRef(title);
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
  /** Where the right button went down: a right-drag pans, a right-click opens the menu. */
  const rightDown = useRef<{ x: number; y: number } | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState<{ fileName: string; pages: DrawioPage[] } | null>(null);

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

  const fit = useCallback(() => setTimeout(() => void rf.fitView({ padding: 0.15, duration: 300, maxZoom: 1.25 }), 60), [rf]);

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

  /** Canvas setting: show resource types, regions, warnings and the Terraform panel. */
  const terraformOn = Boolean(model.settings?.terraform);
  useEffect(() => {
    if (tab === "terraform" && !terraformOn) setTab("properties");
  }, [tab, terraformOn]);
  const pages = pagesOf(model);
  const page = pages.some((p) => p.id === activePage) ? activePage : pages[0].id;
  const pageRef = useRef(page);
  pageRef.current = page;

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
    void layoutPages(model).then((layout) => {
      if (cancelled) return;
      setModel((m) => (structureKey(m) === modelKey ? { ...m, layout } : m));
      fit();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey]);

  /** Auto layout of the tab in view (other tabs keep their arrangement). */
  async function relayout() {
    const layout = await autoLayout(pageModel(model, page));
    // Positions change; rotations stay.
    for (const [id, l] of Object.entries(layout)) if (model.layout[id]?.r) layout[id] = { ...l, r: model.layout[id].r };
    commit({ ...model, layout: { ...model.layout, ...layout } });
    fit();
  }

  // ---------------------------------------------------------------- agent proposals

  const diff: ModelDiff | undefined = useMemo(() => (proposal ? diffModels(proposal.base, proposal.model) : undefined), [proposal]);
  const display: DiagramModel = useMemo(() => {
    if (!proposal || !diff) return pageModel(model, page);
    const shown = withGhosts(proposal.base, proposal.model, diff);
    return pageModel({ ...shown, layout: proposalLayout ?? proposal.base.layout }, page);
  }, [model, proposal, diff, proposalLayout, page]);

  const proposalKey = proposal && diff ? structureKey(withGhosts(proposal.base, proposal.model, diff)) : "";
  useEffect(() => {
    if (!proposal || !diff) return setProposalLayout(null);
    let cancelled = false;
    void layoutPages(withGhosts(proposal.base, proposal.model, diff)).then((l) => {
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
    onProposal: (m: DiagramModel) => setProposal((p) => (p ? { ...p, model: onPage(p.base, m, page), changed: true } : p)),
    onDone: (m: DiagramModel, changed: boolean) => setProposal((p) => (p && changed ? { ...p, model: onPage(p.base, m, page), running: false, changed: true } : null)),
    // Asking the assistant for Terraform is an explicit request: turn the details on.
    onShowTerraform: () => {
      const m = modelRef.current;
      if (!m.settings?.terraform) commit({ ...m, settings: { ...m.settings, terraform: true } });
      setTab("terraform");
    },
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
  // React Flow keeps each node's measured size on the node object. Carry it over when the model
  // changes, or every edit hides nodes until they're re-measured (blinking) and lines to nodes
  // whose size didn't change never come back.
  // Done during render, not in an effect: an effect hands React Flow the new nodes one render
  // late, it reports the stale selection back, and selection flips every frame (blinking).
  const [syncedFrom, setSyncedFrom] = useState(flow.nodes);
  if (syncedFrom !== flow.nodes) {
    setSyncedFrom(flow.nodes);
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return flow.nodes.map((n) => {
        const o = old.get(n.id);
        return o?.measured ? { ...n, measured: o.measured } : n;
      });
    });
  }

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
      const target = containerAt(next, { x: abs.x + abs.w / 2, y: abs.y + Math.min(abs.h / 2, 30) }, node.kind, [n.id], page);
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
    if (at) parentId = containerAt(m, at, item.kind, [], page)?.id;
    else {
      const sel = selection?.type === "node" ? m.nodes.find((n) => n.id === selection.id) : undefined;
      const candidates = sel ? [sel, ...(sel.parentId ? [m.nodes.find((n) => n.id === sel.parentId)!] : [])] : [];
      parentId = candidates.find((c) => c && entry.parents.includes(c.kind))?.id;
    }
    const label = item.kind === "generic.note" ? "Double-click to edit this note" : item.label;
    const shapeSize = item.kind === "generic.shape" ? SHAPE_LABELS[String(item.props?.shape ?? "rectangle") as ShapeName]?.size : undefined;
    const base =
      item.kind === "generic.note"
        ? "note"
        : item.kind === "generic.shape"
          ? String(item.props?.shape ?? "shape").replace(/-/g, "_")
          : item.icon || item.kind === "generic.group"
          ? item.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "n_$1").slice(0, 30) || "component"
          : item.kind.split(".").pop()!.replace(/^(cloud_|gcs_|memorystore_)/, "");
    let id = NODE_ID.test(base) ? base : "node";
    for (let i = 2; m.nodes.some((n) => n.id === id); i++) id = `${base}_${i}`;
    const long = item.kind === "generic.note" || item.kind === "generic.shape";
    const ok = change(
      [{ op: "add_node", id, kind: item.kind, label: (label || " ").slice(0, long ? 500 : 80), parentId, ...(item.icon ? { icon: item.icon } : {}), ...(item.props ? { props: item.props } : {}), ...(parentId ? {} : { page }) }],
      (after) => {
        if (!shapeSize) return at ? { ...after.layout, [id]: relativeAt(after, parentId, at, item.kind) } : placeMissing(after);
        const [w, h] = shapeSize;
        if (!at) {
          const placed = placeMissing(after);
          return { ...placed, [id]: { ...placed[id], w, h } };
        }
        const base = parentId ? absBox(after, parentId) : { x: 0, y: 0 };
        return { ...after.layout, [id]: { x: Math.round(at.x - base.x - w / 2), y: Math.round(at.y - base.y - h / 2), w, h } };
      },
    );
    if (!ok) return;
    setSelection({ type: "node", id });
    setSelectedIds(new Set([id]));
    if (item.kind === "generic.note" || item.kind === "generic.shape") setEditing(id);
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
        return finishPaste(pasteOps(m, shifted, offset, undefined, false, page));
      }
    }
    finishPaste(pasteOps(m, clip, offset, undefined, false, page));
  }

  function finishPaste(r: ReturnType<typeof pasteOps>) {
    if ("error" in r) return setStatus({ kind: "error", text: r.error });
    commit(r.model);
    setSelectedIds(new Set(r.ids));
    setSelection(r.ids.length === 1 ? { type: "node", id: r.ids[0] } : null);
  }

  function duplicate(ids = nodeIds(selectedIds)) {
    const clip = copySelection(modelRef.current, ids);
    if (clip) finishPaste(pasteOps(modelRef.current, clip, 32, undefined, false, pageOf(modelRef.current, ids[0] ?? "")));
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
        setSelectedIds(new Set(modelRef.current.nodes.filter((n) => pageOf(modelRef.current, n.id) === pageRef.current).map((n) => n.id)));
      } else if (k === "f2" && selection && !readOnly) {
        e.preventDefault();
        setEditing(selection.type === "edge" ? `edge:${selection.id}` : selection.id);
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
    moveEdgeLabel: (edgeId, dx, dy) => {
      const e = modelRef.current.edges.find((x) => x.id === edgeId);
      // Dropped back near the middle: snap onto the line again.
      const home = Math.hypot(dx, dy) < 6;
      if (e) op({ op: "update_edge", from: e.from, to: e.to, labelDx: home ? null : dx, labelDy: home ? null : dy });
    },
    rotated: (id, deg) => {
      const m = modelRef.current;
      const l = m.layout[id] ?? { x: 0, y: 0 };
      const r = Math.round(deg * 10) / 10;
      const { r: _old, ...rest } = l;
      if ((l.r ?? 0) !== r) commit({ ...m, layout: { ...m.layout, [id]: r ? { ...rest, r } : rest } });
    },
    resized: (id, box) => {
      const m = modelRef.current;
      commit({ ...m, layout: growGroups({ ...m, layout: { ...m.layout, [id]: { ...m.layout[id], x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) } } }) });
    },
  };

  // ---------------------------------------------------------------- import into this diagram

  async function pickImport(file: File) {
    if (!/\.(drawio|xml|svg)$/i.test(file.name)) return setStatus({ kind: "error", text: `${file.name} isn't a draw.io file. Use .drawio, .drawio.svg or .xml.` });
    try {
      setImporting({ fileName: file.name, pages: await readDrawio(await file.text()) });
    } catch (e) {
      setStatus({ kind: "error", text: `Couldn't read ${file.name}: ${(e as Error).message}` });
    }
  }

  /** Adds an imported diagram to the right of the current content, keeping ids where free. */
  async function mergeImport(imported: DiagramModel, fileName: string) {
    const laid = imported.nodes.every((n) => imported.layout[n.id]) ? imported : { ...imported, layout: await autoLayout(imported) };
    const m = modelRef.current;
    const tops = laid.nodes.filter((n) => !n.parentId).map((n) => n.id);
    const clip = copySelection(laid, tops);
    if (!clip) return;
    const existing = m.nodes.filter((n) => !n.parentId && pageOf(m, n.id) === page).map((n) => absBox(m, n.id));
    const right = existing.length ? Math.max(...existing.map((b) => b.x + b.w)) + 120 : 0;
    const top = existing.length ? Math.min(...existing.map((b) => b.y)) : 0;
    const minX = Math.min(...tops.map((id) => laid.layout[id]?.x ?? 0));
    const minY = Math.min(...tops.map((id) => laid.layout[id]?.y ?? 0));
    const r = pasteOps(m, clip, { x: right - minX, y: top - minY }, undefined, true, page);
    if ("error" in r) return setStatus({ kind: "error", text: r.error });
    commit(r.model);
    setSelectedIds(new Set(r.ids));
    setStatus({ kind: "ok", text: `Added ${clip.nodes.length} shapes from ${fileName}` });
    fit();
  }

  // ---------------------------------------------------------------- save / export

  /** Save creates a version; autosave (a moment after each change) only stores the content. */
  async function save(auto = false) {
    const sent = modelRef.current;
    if (auto) setAutoSaving(true);
    else setSaving(true);
    try {
      if (!diagramId && !projectId) throw new Error("Pick a project first");
      const d = diagramId
        ? await api.updateDiagram(diagramId, { title, kind: "cloud", model: sent, ...(auto ? { autosave: true } : {}) })
        : await api.createDiagram({ projectId: projectId!, title, kind: "cloud", model: sent });
      // Changes made while saving stay unsaved (the next autosave picks them up).
      if (modelRef.current === sent) setDirty(false);
      setSavedAt(new Date());
      if (!auto) setStatus({ kind: "ok", text: d.versionCreated === false ? "No changes since the last version" : `Saved as v${d.version}` });
      if (!auto || d.title !== lastTitle.current) onSaved(d);
      lastTitle.current = d.title;
    } catch (e) {
      setStatus({ kind: "error", text: `${auto ? "Autosave failed: " : ""}${(e as Error).message}` });
    } finally {
      if (auto) setAutoSaving(false);
      else setSaving(false);
    }
  }

  // Autosave saved diagrams 1.5 s after the last change (not while the assistant's proposal is pending).
  useEffect(() => {
    if ((!dirty && title === lastTitle.current) || !title.trim() || !diagramId || !canEdit || readOnly || saving || autoSaving || proposal) return;
    const t = setTimeout(() => void save(true), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, model, title, diagramId, canEdit, readOnly, saving, autoSaving, proposal]);

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
        className={terraformOn ? "toggle on" : "toggle"}
        aria-pressed={terraformOn}
        disabled={readOnly}
        onClick={() => {
          const m = modelRef.current;
          commit({ ...m, settings: { ...m.settings, terraform: !terraformOn } });
          if (terraformOn && tab === "terraform") setTab("properties");
        }}
        title={terraformOn ? "Hide cloud details: resource types, regions, warnings and Terraform" : "Show cloud details on this canvas: resource types, regions, warnings and Terraform"}
      >
        Terraform
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
      <button onClick={() => importInput.current?.click()} disabled={readOnly} title="Add a draw.io diagram to this canvas">
        Import
      </button>
      <input
        ref={importInput}
        type="file"
        accept=".drawio,.xml,.svg"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void pickImport(f);
          e.target.value = "";
        }}
      />
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
        <>
          {diagramId && !readOnly && (
            <span className="autosave" title={savedAt ? `Last saved ${savedAt.toLocaleTimeString()}` : "Changes save automatically"}>
              {autoSaving ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved"}
            </span>
          )}
          <button
            className="primary"
            onClick={() => void save()}
            disabled={saving || readOnly}
            title={diagramId ? "Save a version you can compare and restore (⌘S). Changes also save automatically." : "Save (⌘S)"}
          >
            {saving ? "Saving…" : diagramId ? "Save version" : "Save"}
          </button>
        </>
      ) : (
        <span className="kind-pill">View only</span>
      )}
    </>
  );

  // ---------------------------------------------------------------- canvas tabs

  function switchPage(id: string) {
    setActivePage(id);
    setSelectedIds(new Set());
    setSelection(null);
    setMenu(null);
    setHighlight(null);
    fit();
  }
  function newPage() {
    const n = pages.length + 1;
    let name = `Page ${n}`;
    for (let i = n; pages.some((p) => p.name === name); i++) name = `Page ${i + 1}`;
    const r = addPage(modelRef.current, name);
    commit(r.model);
    switchPage(r.id);
  }
  function duplicatePage(id: string) {
    const m = modelRef.current;
    const src = pages.find((p) => p.id === id);
    if (!src) return;
    const r = addPage(m, `${src.name} copy`);
    const tops = r.model.nodes.filter((n) => !n.parentId && pageOf(r.model, n.id) === id).map((n) => n.id);
    const clip = copySelection(r.model, tops);
    const pasted = clip ? pasteOps(r.model, clip, 0, undefined, false, r.id) : { model: r.model, ids: [] };
    if ("error" in pasted) return setStatus({ kind: "error", text: pasted.error });
    commit(pasted.model);
    switchPage(r.id);
  }
  function deletePage(id: string) {
    const m = modelRef.current;
    const p = pages.find((x) => x.id === id);
    const count = m.nodes.filter((n) => pageOf(m, n.id) === id).length;
    if (!p || (count && !confirm(`Delete the "${p.name}" tab and the ${count} item${count === 1 ? "" : "s"} on it? You can undo this.`))) return;
    commit(removePage(m, id));
    if (id === page) switchPage(pagesOf(removePage(m, id))[0].id);
  }
  /** Moves the selected (or given) items to another tab, with whatever is inside them. */
  function moveToPage(ids: string[], target: string) {
    const m = modelRef.current;
    const tops = ids.filter((id) => {
      const n = m.nodes.find((x) => x.id === id);
      return n && !ids.includes(n.parentId ?? "");
    });
    if (!tops.length) return;
    if (change(tops.map((id) => ({ op: "update_node" as const, id, page: target })))) {
      setSelectedIds(new Set());
      setSelection(null);
      setStatus({ kind: "ok", text: `Moved ${tops.length} item${tops.length === 1 ? "" : "s"} to ${pages.find((p) => p.id === target)?.name}` });
    }
  }
  const pageCounts = Object.fromEntries(pages.map((p) => [p.id, model.nodes.filter((n) => !n.parentId && pageOf(model, n.id) === p.id).length]));

  /** Bring to front / send to back: z-order follows the order of nodes in the model. */
  function arrange(idList: string[], where: "front" | "back") {
    const m = modelRef.current;
    const ids = new Set(idList);
    const moved = m.nodes.filter((n) => ids.has(n.id));
    const rest = m.nodes.filter((n) => !ids.has(n.id));
    if (moved.length) commit({ ...m, nodes: where === "front" ? [...rest, ...moved] : [...moved, ...rest] });
  }

  /** Styles everything selected; each item gets the property it has (a shape's fill, a group's colour, a line's colour…). */
  function styleSelected(forNode: (kind: string, props: Record<string, unknown>) => Record<string, unknown> | null, edgePatch?: Record<string, unknown>) {
    const m = modelRef.current;
    const ops: Op[] = [];
    for (const id of nodeIds(selectedIds)) {
      const n = m.nodes.find((x) => x.id === id);
      const pr = n && forNode(n.kind, n.props);
      if (n && pr) ops.push({ op: "update_node", id, props: { ...n.props, ...pr } });
    }
    if (edgePatch)
      for (const id of selectedIds) {
        const e = id.startsWith("edge:") ? m.edges.find((x) => x.id === id.slice(5)) : undefined;
        if (e) ops.push({ op: "update_edge", from: e.from, to: e.to, ...edgePatch } as Op);
      }
    if (ops.length) change(ops);
  }
  const firstSelected = (() => {
    const id = [...selectedIds][0];
    if (!id) return undefined;
    if (id.startsWith("edge:")) {
      const e = model.edges.find((x) => x.id === id.slice(5));
      return e ? { fill: undefined, line: e.color ?? "#5f6368", shadow: null } : undefined;
    }
    const n = model.nodes.find((x) => x.id === id);
    if (!n) return undefined;
    const pr = resolvedProps(n.kind, n.props);
    if (n.kind === "generic.shape") return { fill: String(pr.fill), line: String(pr.stroke), shadow: Boolean(pr.shadow) };
    if (catalogEntry(n.kind)?.container) return { fill: String(pr.fill), line: String(pr.color), shadow: null };
    return { fill: undefined, line: undefined, shadow: null };
  })();

  const openMenu = (e: React.MouseEvent, target: Menu["target"]) => {
    e.preventDefault();
    const box = canvasRef.current!.getBoundingClientRect();
    setMenu({ x: e.clientX - box.left, y: e.clientY - box.top, at: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }), target });
  };

  return (
    <EditorContext.Provider value={actions}>
      <div className="cloud">
        {toolbar && createPortal(tools, toolbar)}
        {importing && (
          <Suspense fallback={null}>
            <ImportDialog
              merge
              fileName={importing.fileName}
              pages={importing.pages}
              onClose={() => setImporting(null)}
              onImport={(_, imported) => {
                const name = importing.fileName;
                setImporting(null);
                void mergeImport(imported, name);
              }}
            />
          </Suspense>
        )}
        {presenting && <Presentation model={model} title={title} workflows={workflows} startWorkflow={presenting.start} onClose={() => onExitPresent?.()} />}

        {paletteOpen && (
          <>
            <aside className="palette" style={{ width: paletteW }}>
              <Palette onAdd={(item) => addItem(item)} disabled={readOnly} terraform={terraformOn} />
            </aside>
            <Resizer onDrag={(dx) => setPaletteW((w) => w + dx)} />
          </>
        )}

        <div
          className="cloud-canvas"
          ref={canvasRef}
          onPointerDownCapture={(e) => (rightDown.current = e.button === 2 ? { x: e.clientX, y: e.clientY } : null)}
          onContextMenu={(e) => {
            // React Flow drops the pane's context menu while right-drag panning is on, so open it here.
            if (!(e.target as HTMLElement).classList.contains("react-flow__pane")) return;
            e.preventDefault();
            const d = rightDown.current;
            if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
            openMenu(e, { type: "pane" });
          }}
          onDragOver={(e) => e.dataTransfer.types.includes(DRAG_TYPE) && (e.preventDefault(), (e.dataTransfer.dropEffect = "copy"))} onDrop={onDrop}>
          <PageTabs
            pages={pages}
            active={page}
            counts={pageCounts}
            readOnly={readOnly || Boolean(proposal)}
            onSelect={switchPage}
            onAdd={newPage}
            onRename={(id, name) => commit(renamePage(modelRef.current, id, name))}
            onDuplicate={duplicatePage}
            onMove={(id, by) => commit(movePage(modelRef.current, id, by))}
            onDelete={deletePage}
          />
          <FormatBar
            readOnly={readOnly}
            paletteOpen={paletteOpen}
            onTogglePalette={() => setPaletteOpen((o) => !o)}
            zoom={zoom}
            onZoom={(z) => void rf.zoomTo(z, { duration: 200 })}
            onZoomIn={() => void rf.zoomIn({ duration: 200 })}
            onZoomOut={() => void rf.zoomOut({ duration: 200 })}
            onFit={() => fit()}
            canUndo={past.length > 0}
            canRedo={future.length > 0}
            onUndo={undo}
            onRedo={redo}
            selected={selectedIds.size}
            onDelete={() => removeSelected()}
            onFront={() => arrange(nodeIds(selectedIds), "front")}
            onBack={() => arrange(nodeIds(selectedIds), "back")}
            fill={firstSelected?.fill}
            line={firstSelected?.line}
            onFill={(c) => styleSelected((kind) => (kind === "generic.shape" || catalogEntry(kind)?.container ? { fill: c } : null))}
            onLine={(c) =>
              styleSelected((kind) => (kind === "generic.shape" ? { stroke: c } : catalogEntry(kind)?.container ? { color: c } : null), { color: c })
            }
            shadow={firstSelected?.shadow ?? null}
            onShadow={() => {
              const on = !firstSelected?.shadow;
              styleSelected((kind) => (kind === "generic.shape" ? { shadow: on } : null));
            }}
            lineStyle={newLine}
            onLineStyle={(patch) => {
              const next = { ...newLine, ...patch };
              setNewLine(next);
              localStorage.setItem("archcanvas.lineStyle", JSON.stringify(next));
              const edgePatch: Record<string, unknown> = {};
              if (patch.dash) edgePatch.dash = patch.dash === "solid" ? null : patch.dash;
              if (patch.ends) {
                edgePatch.arrowEnd = patch.ends === "end" || patch.ends === "both" ? null : "none";
                edgePatch.arrowStart = patch.ends === "start" || patch.ends === "both" ? "arrow" : null;
              }
              styleSelected(() => null, edgePatch);
            }}
            routing={newRouting}
            onRouting={(r) => {
              setNewRouting(r);
              styleSelected(() => null, { routing: r === "orthogonal" ? null : r });
            }}
            onInsert={(item) => addItem(item)}
          />
          <ReactFlow
            onDoubleClick={(e) => {
              // Double-click on empty canvas adds text, as in draw.io.
              if (readOnly || !(e.target as HTMLElement).classList.contains("react-flow__pane")) return;
              addItem({ key: "text", kind: "generic.shape", label: "Text", props: { shape: "text" } }, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
            }}
            zoomOnDoubleClick={false}
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
            onConnect={(c) => {
              if (!c.source || !c.target) return;
              const side = (h: string | null | undefined) => (h && ["t", "r", "b", "l"].includes(h) ? (h as "t") : undefined);
              op({
                op: "connect",
                from: c.source,
                to: c.target,
                ...(newRouting !== "orthogonal" ? { routing: newRouting } : {}),
                ...(newLine.dash !== "solid" ? { dash: newLine.dash } : {}),
                ...(newLine.ends === "none" || newLine.ends === "start" ? { arrowEnd: "none" as const } : {}),
                ...(newLine.ends === "both" || newLine.ends === "start" ? { arrowStart: "arrow" as const } : {}),
                ...(side(c.sourceHandle) ? { fromHandle: side(c.sourceHandle) } : {}),
                ...(side(c.targetHandle) ? { toHandle: side(c.targetHandle) } : {}),
              });
            }}
            onReconnect={(old, c) => {
              const e = modelRef.current.edges.find((x) => x.id === old.id);
              if (!e || !c.source || !c.target || (c.source === e.from && c.target === e.to)) return;
              const side = (h: string | null | undefined) => (h && ["t", "r", "b", "l"].includes(h) ? (h as "t") : undefined);
              const { id: _id, from: _f, to: _t, fromHandle: _fh, toHandle: _th, ...style } = e;
              change([
                { op: "disconnect", from: e.from, to: e.to },
                { op: "connect", from: c.source, to: c.target, ...style, fromHandle: side(c.sourceHandle), toHandle: side(c.targetHandle) },
              ]);
            }}
            edgesReconnectable={!readOnly}
            onSelectionChange={({ nodes: ns, edges: es }) => {
              const ids = new Set([...ns.map((n) => n.id), ...es.map((e) => `edge:${e.id}`)]);
              setSelectedIds((prev) => (prev.size === ids.size && [...ids].every((i) => prev.has(i)) ? prev : ids));
              // Only explicit actions clear the selection (pane click, Esc, delete): React Flow also
              // reports empty selections while nodes are re-rendered.
              // React Flow calls this again on every render, so only set a new selection when it changed.
              const pick = ns.length === 1 && !es.length ? { type: "node" as const, id: ns[0].id } : es.length === 1 && !ns.length ? { type: "edge" as const, id: es[0].id } : null;
              if (pick) setSelection((prev) => (prev?.type === pick.type && prev.id === pick.id ? prev : pick));
            }}
            onNodeClick={() => tab !== "assistant" && tab !== "flows" && setTab("properties")}
            onEdgeClick={(e, ed) => {
              // Lines are controlled by the model, so selecting one is done here (Shift/⌘ adds to the selection).
              const key = `edge:${ed.id}`;
              setSelectedIds((prev) => (e.shiftKey || e.metaKey || e.ctrlKey ? new Set([...prev, key]) : new Set([key])));
              setSelection({ type: "edge", id: ed.id });
              setTab("properties");
            }}
            // Double-click a line to add or edit its text, as in draw.io.
            onEdgeDoubleClick={(_, ed) => !readOnly && setEditing(`edge:${ed.id}`)}
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
              model={model}
              readOnly={readOnly}
              onClose={() => setMenu(null)}
              pages={pages}
              page={page}
              actions={{
                moveToPage: (id, target) => moveToPage(selectedIds.has(id) ? nodeIds(selectedIds) : [id], target),
                addText: (at) => addItem({ key: "text", kind: "generic.shape", label: "Text", props: { shape: "text" } }, at),
                styleNodes: (id, props) => {
                  const ids = selectedIds.has(id) ? nodeIds(selectedIds) : [id];
                  // Only items that have these properties (shapes get fill/shape, groups get border…).
                  const has = (kind: string) => Object.keys(props).every((k) => catalogEntry(kind)?.props.some((p) => p.key === k));
                  const ops = ids
                    .map((x) => modelRef.current.nodes.find((n) => n.id === x))
                    .filter((n) => n && has(n.kind))
                    .map((n) => ({ op: "update_node" as const, id: n!.id, props: { ...n!.props, ...props } }));
                  // Changing the shape keeps the size the user gave it.
                  if (ops.length) change(ops);
                },
                rotate: (id, by) => {
                  const m = modelRef.current;
                  const ids = selectedIds.has(id) ? nodeIds(selectedIds) : [id];
                  const layout = { ...m.layout };
                  for (const x of ids) {
                    const n = m.nodes.find((k) => k.id === x);
                    if (!n || catalogEntry(n.kind)?.container || n.kind === "generic.note") continue;
                    const l = layout[x] ?? { x: 0, y: 0 };
                    let r = by === null ? 0 : (((l.r ?? 0) + by) % 360 + 360) % 360;
                    if (r > 180) r -= 360;
                    const { r: _old, ...rest } = l;
                    layout[x] = r ? { ...rest, r } : rest;
                  }
                  commit({ ...m, layout });
                },
                arrange: (id, where) => arrange(selectedIds.has(id) ? nodeIds(selectedIds) : [id], where),
                edge: (edgeId, patch) => {
                  const e = modelRef.current.edges.find((x) => x.id === edgeId);
                  if (e) op({ op: "update_edge", from: e.from, to: e.to, ...(patch as Record<string, never>) });
                },
                reverse: (edgeId) => {
                  const e = modelRef.current.edges.find((x) => x.id === edgeId);
                  if (!e) return;
                  const { id: _id, from, to, fromHandle, toHandle, ...style } = e;
                  change([
                    { op: "disconnect", from, to },
                    { op: "connect", from: to, to: from, ...style, fromHandle: toHandle, toHandle: fromHandle },
                  ]);
                },
                rename: (id) => setEditing(id),
                properties: () => setTab("properties"),
                duplicate: (id) => duplicate(selectedIds.has(id) ? nodeIds(selectedIds) : [id]),
                copy: (id) => copy(selectedIds.has(id) ? nodeIds(selectedIds) : [id]),
                remove: (t) => removeSelected(t.type === "edge" ? new Set([`edge:${t.id}`]) : selectedIds.has(t.id) ? selectedIds : new Set([t.id])),
                paste: (at) => paste(at),
                addNote: (at) => addItem({ key: "note", kind: "generic.note", label: "Note" }, at),
                addGroup: (at) => addItem({ key: "group", kind: "generic.group", label: "Group" }, at),
                editEdgeLabel: (edgeId) => setEditing(`edge:${edgeId}`),
                fit: () => fit(),
              }}
            />
          )}

          {!display.nodes.length && !proposal && (
            <div className="canvas-empty">
              <h2>Start your architecture</h2>
              <p>
                Mix Google Cloud, AWS, Azure and on-prem: drag anything from the left (Google Cloud items also generate Terraform), describe it to the assistant
                on the right, or import a draw.io file from the toolbar.
              </p>
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
            )
              .filter(([t]) => t !== "terraform" || terraformOn)
              .map(([t, label]) => (
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

/** Lays out each tab on its own (tabs don't share space). */
async function layoutPages(m: DiagramModel): Promise<DiagramModel["layout"]> {
  const out: DiagramModel["layout"] = {};
  for (const p of pagesOf(m)) Object.assign(out, await autoLayout(pageModel(m, p.id)));
  return out;
}

/** Things the assistant adds go on the tab you're looking at. */
function onPage(base: DiagramModel, m: DiagramModel, page: string): DiagramModel {
  const known = new Set(base.nodes.map((n) => n.id));
  if (page === pagesOf(m)[0].id && !m.pages?.length) return m;
  return { ...m, pages: m.pages ?? base.pages, nodes: m.nodes.map((n) => (!known.has(n.id) && !n.parentId && !n.page ? { ...n, page } : n)) };
}

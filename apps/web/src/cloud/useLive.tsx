import { useEffect, useRef, useState } from "react";
import { useViewport, ViewportPortal } from "@xyflow/react";
import { applyPatch, type DiagramModel, diffPatch, type ModelPatch } from "@archcanvas/shared";
import { postLive, streamEvents } from "../api";
import { Avatar } from "../ui";

/**
 * Live collaboration for the editor: joins the diagram's room, sends local changes as patches,
 * applies other people's patches, and tracks their cursors. Saving stays as it is (autosave
 * and versions); the room only shares changes while people are editing together.
 */
export interface Peer {
  id: string;
  userId: string;
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
  selection: string[];
  canEdit: boolean;
}

type LiveEvent =
  | { type: "welcome"; seq: number; model: DiagramModel; peers: Peer[] }
  | { type: "join"; peer: Peer }
  | { type: "leave"; id: string }
  | { type: "patch"; seq: number; from: string; patch: ModelPatch }
  | { type: "presence"; id: string; cursor: Peer["cursor"]; selection: string[] };

const CLIENT = `c${Math.random().toString(36).slice(2, 12)}`;

export function useLive({
  diagramId,
  model,
  canSend,
  onRemote,
}: {
  diagramId: string | null;
  model: DiagramModel;
  /** False while viewing, or while the assistant's proposal is shown. */
  canSend: boolean;
  /** Another person's change (or the room's state on joining): show it without an undo step. */
  onRemote: (m: DiagramModel) => void;
}) {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [connected, setConnected] = useState(false);
  /** The model as the room knows it: local changes are sent as the difference from it. */
  const synced = useRef<DiagramModel | null>(null);
  const modelRef = useRef(model);
  modelRef.current = model;
  const onRemoteRef = useRef(onRemote);
  onRemoteRef.current = onRemote;
  const path = diagramId ? `/api/diagrams/${diagramId}/live` : null;

  // Join the room, and rejoin after a dropped connection.
  useEffect(() => {
    if (!path) return;
    const ctrl = new AbortController();
    let stop = false;
    let retry = 0;
    const run = async () => {
      while (!stop) {
        try {
          await streamEvents(
            `${path}?client=${CLIENT}`,
            (raw) => {
              const e = raw as LiveEvent;
              if (e.type === "welcome") {
                retry = 0;
                setConnected(true);
                setPeers(e.peers);
                synced.current = e.model;
                // Others have changed it since this tab loaded: take the room's version.
                if (diffPatch(modelRef.current, e.model)) onRemoteRef.current(e.model);
              } else if (e.type === "join") setPeers((p) => [...p.filter((x) => x.id !== e.peer.id), e.peer]);
              else if (e.type === "leave") setPeers((p) => p.filter((x) => x.id !== e.id));
              else if (e.type === "presence") setPeers((p) => p.map((x) => (x.id === e.id ? { ...x, cursor: e.cursor, selection: e.selection } : x)));
              else if (e.type === "patch") {
                synced.current = applyPatch(synced.current ?? modelRef.current, e.patch);
                onRemoteRef.current(applyPatch(modelRef.current, e.patch));
              }
            },
            ctrl.signal,
          );
        } catch {
          if (stop) return;
        }
        setConnected(false);
        setPeers([]);
        if (stop) return;
        await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * 2 ** retry++)));
      }
    };
    void run();
    return () => {
      stop = true;
      ctrl.abort();
      setConnected(false);
    };
  }, [path]);

  // Send local changes shortly after they happen (one patch per burst of edits).
  useEffect(() => {
    if (!path || !connected || !canSend || !synced.current) return;
    const t = setTimeout(() => {
      const base = synced.current;
      if (!base) return;
      const patch = diffPatch(base, modelRef.current);
      if (!patch) return;
      synced.current = modelRef.current;
      void postLive(path, { type: "patch", client: CLIENT, patch }).catch(() => undefined);
    }, 120);
    return () => clearTimeout(t);
  }, [model, path, connected, canSend]);

  // Cursor and selection, at most ~12 times a second.
  const last = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presence = (cursor: { x: number; y: number } | null, selection: string[]) => {
    if (!path || !connected || !peers.length) return;
    const go = () => {
      last.current = Date.now();
      void postLive(path, { type: "presence", client: CLIENT, cursor, selection }).catch(() => undefined);
    };
    if (pending.current) clearTimeout(pending.current);
    const wait = 80 - (Date.now() - last.current);
    if (wait <= 0) go();
    else pending.current = setTimeout(go, wait);
  };

  return { peers, connected, presence };
}

/** Other people's cursors, drawn in canvas coordinates so they follow pan and zoom. */
export function LiveCursors({ peers }: { peers: Peer[] }) {
  // Same size on screen at any zoom.
  const { zoom } = useViewport();
  return (
    <ViewportPortal>
      {peers
        .filter((p) => p.cursor)
        .map((p) => (
          <div key={p.id} className="live-cursor" style={{ transform: `translate(${p.cursor!.x}px, ${p.cursor!.y}px) scale(${1 / zoom})`, color: p.color }}>
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
              <path d="M2 2l5.5 13 1.9-5.4L15 7.6z" fill="currentColor" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
            <span style={{ background: p.color }}>{p.name}</span>
          </div>
        ))}
    </ViewportPortal>
  );
}

/** Who else is here, for the toolbar. */
export function LivePeople({ peers, connected }: { peers: Peer[]; connected: boolean }) {
  if (!connected) return null;
  const people = [...new Map(peers.map((p) => [p.userId, p])).values()];
  return (
    <div className="live-people" title={people.length ? `Editing now: ${people.map((p) => p.name).join(", ")}` : "Live: changes from others appear as they make them"}>
      <span className="live-dot" aria-hidden />
      {people.length ? (
        <span className="avatar-stack">
          {people.slice(0, 4).map((p) => (
            <span key={p.userId} className="live-ring" style={{ borderColor: p.color }}>
              <Avatar name={p.name} size={24} />
            </span>
          ))}
          {people.length > 4 && <span className="avatar more">+{people.length - 4}</span>}
        </span>
      ) : (
        <span className="live-label">Live</span>
      )}
    </div>
  );
}

import { useSyncExternalStore } from "react";
import { bestIcon, GCP_ICON_QUERIES, iconDataUrl, iconScore, type IconEntry, type IconPackMeta, parseIconRef } from "@archcanvas/shared";
import { api } from "../api";

/**
 * Icon packs: the bundled ones (public/icons, built by scripts/build-icons.mjs) and the ones
 * uploaded to the current workspace. Packs load on demand; components re-render through
 * useIconsVersion() when one arrives.
 */
interface Pack {
  meta: IconPackMeta;
  icons?: IconEntry[];
  byName?: Map<string, IconEntry>;
  loading?: Promise<IconEntry[]>;
}

const BASE = import.meta.env.BASE_URL;
const packs = new Map<string, Pack>();
const resolved = new Map<string, string | null>();
const listeners = new Set<() => void>();
let version = 0;

function notify() {
  version++;
  resolved.clear();
  listeners.forEach((l) => l());
}

export function useIconsVersion(): number {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => version,
  );
}

const builtIns: Promise<IconPackMeta[]> = fetch(`${BASE}icons/index.json`)
  .then((r) => (r.ok ? r.json() : []))
  .then((list: Omit<IconPackMeta, "builtIn">[]) => {
    const metas = list.map((m) => ({ ...m, builtIn: true }));
    for (const m of metas) if (!packs.has(m.id)) packs.set(m.id, { meta: m });
    notify();
    return metas;
  })
  .catch(() => []);

/** Replaces the uploaded packs with those of the workspace now in view. */
export function setWorkspacePacks(metas: IconPackMeta[]): void {
  for (const [id, p] of packs) if (!p.meta.builtIn) packs.delete(id);
  for (const m of metas) packs.set(m.id, { meta: { ...m, builtIn: false } });
  notify();
}

export function allPacks(): IconPackMeta[] {
  return [...packs.values()].map((p) => p.meta).sort((a, b) => Number(a.builtIn) - Number(b.builtIn) || a.name.localeCompare(b.name));
}

export async function builtInPacks(): Promise<IconPackMeta[]> {
  return builtIns;
}

export function loadPack(id: string): Promise<IconEntry[]> {
  const p = packs.get(id);
  if (!p) return Promise.resolve([]);
  if (p.icons) return Promise.resolve(p.icons);
  p.loading ??= (p.meta.builtIn ? fetch(`${BASE}icons/${id}.json`).then((r) => r.json()) : api.iconPack(id))
    .then((data: { icons: IconEntry[] }) => {
      p.icons = data.icons;
      p.byName = new Map(data.icons.map((i) => [i.n, i]));
      notify();
      return data.icons;
    })
    .catch(() => {
      p.icons = [];
      p.byName = new Map();
      return [];
    });
  return p.loading;
}

/** Data URL for an icon reference, or undefined while its pack loads (or if there's no match). */
export function resolveIcon(ref: string): string | undefined {
  if (resolved.has(ref)) return resolved.get(ref) ?? undefined;
  const r = parseIconRef(ref);
  if (!r) return undefined;
  if (r.pack) {
    const p = packs.get(r.pack);
    if (!p) return undefined; // e.g. an uploaded pack from another workspace
    if (!p.icons) {
      void loadPack(r.pack);
      return undefined;
    }
    const icon = p.byName!.get(r.name);
    resolved.set(ref, icon ? iconDataUrl(icon.s) : null);
    return resolved.get(ref) ?? undefined;
  }
  // Best match in any pack of the family; uploaded packs win over bundled ones.
  const candidates = [...packs.values()].filter((p) => p.meta.family === r.family).sort((a, b) => Number(a.meta.builtIn) - Number(b.meta.builtIn));
  if (!candidates.length) return undefined;
  for (const p of candidates) {
    if (!p.icons) {
      void loadPack(p.meta.id);
      return undefined;
    }
    const hit = bestIcon(r.name, p.icons);
    if (hit) {
      resolved.set(ref, iconDataUrl(hit.s));
      return resolved.get(ref)!;
    }
  }
  resolved.set(ref, null);
  return undefined;
}

/** Icon reference a GCP resource type uses when the workspace has a Google Cloud pack. */
export function kindIconRef(kind: string): string | undefined {
  const q = GCP_ICON_QUERIES[kind];
  if (!q) return undefined;
  return [...packs.values()].some((p) => p.meta.family === "gcp") ? `gcp~${q}` : undefined;
}

export function useIcon(ref: string | undefined): string | undefined {
  useIconsVersion();
  return ref ? resolveIcon(ref) : undefined;
}

export interface SearchHit extends IconEntry {
  ref: string;
  pack: string;
}

/** Searches the given packs (loading them as needed). Empty query lists the pack's icons. */
export async function searchIcons(query: string, packIds: string[], limit = 160): Promise<SearchHit[]> {
  const lists = await Promise.all(packIds.map((id) => loadPack(id).then((icons) => icons.map((i) => ({ ...i, pack: id, ref: `${id}:${i.n}` })))));
  const all = lists.flat();
  const q = query.trim();
  if (!q) return all.filter((i) => !i.c || i.c === "Services" || i.c === "Groups").slice(0, limit);
  return all
    .map((i) => ({ i, s: iconScore(q, i) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i.t.length - b.i.t.length)
    .slice(0, limit)
    .map((x) => x.i);
}

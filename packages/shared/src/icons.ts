/**
 * Icon helpers shared by the web app and the API: references, name matching, which icon a
 * GCP resource type should use from an uploaded Google Cloud pack, and SVG sanitising.
 *
 * Icon references:
 *   "<packId>:<name>"   an exact icon, e.g. "aws:AWSLambda", "lucide:database"
 *   "<family>~<query>"  the best match in any pack of that family, e.g. "aws~sagemaker",
 *                       "gcp~cloud run" (used by import, and for GCP types)
 */

export type IconFamily = "gcp" | "aws" | "azure" | "generic" | "logos" | "custom";

export interface IconEntry {
  /** Name within the pack (file name without extension). */
  n: string;
  /** Human title. */
  t: string;
  /** Category, e.g. "Services". */
  c?: string;
  /** SVG markup, or a data: URL for PNGs. */
  s: string;
}

export interface IconPackMeta {
  id: string;
  name: string;
  family: IconFamily;
  license: string;
  url?: string;
  count: number;
  builtIn: boolean;
  created_by?: string;
  created_at?: string;
}

export function parseIconRef(ref: string): { pack?: string; family?: string; name: string } | null {
  const fuzzy = ref.indexOf("~");
  const exact = ref.indexOf(":");
  if (fuzzy > 0 && (exact < 0 || fuzzy < exact)) return { family: ref.slice(0, fuzzy), name: ref.slice(fuzzy + 1) };
  if (exact > 0) return { pack: ref.slice(0, exact), name: ref.slice(exact + 1) };
  return null;
}

/** "Cloud-Run_512-color.svg", "CloudRun", "cloud_run" → "cloud run". */
export function normalizeIconName(name: string): string {
  return name
    .replace(/\.(svg|png)$/i, "")
    .replace(/[-_ ](\d{2,4}|color|colour|rgb|cmyk|white|black|light|dark|mono|icon|logo|product|arch|res)(?=$|[-_ ])/gi, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const VENDOR = /\b(amazon|aws|google|gcp|azure|microsoft)\b/g;

/** Scores how well an icon name matches a query (0 = no match). */
export function iconScore(query: string, entry: Pick<IconEntry, "n" | "t">): number {
  const q = normalizeIconName(query).replace(VENDOR, "").replace(/\s+/g, " ").trim();
  if (!q) return 0;
  const names = [normalizeIconName(entry.n), normalizeIconName(entry.t)].map((s) => s.replace(VENDOR, "").replace(/\s+/g, " ").trim());
  let best = 0;
  for (const name of names) {
    if (name === q) best = Math.max(best, 100);
    else if (name.replace(/ /g, "") === q.replace(/ /g, "")) best = Math.max(best, 95);
    else if (name.startsWith(q)) best = Math.max(best, 80 - Math.min(20, name.length - q.length));
    else if (name.includes(q)) best = Math.max(best, 60 - Math.min(20, name.length - q.length));
    else {
      const qt = q.split(" ");
      const nt = new Set(name.split(" "));
      const hit = qt.filter((t) => nt.has(t) || [...nt].some((x) => x.startsWith(t))).length;
      if (hit) best = Math.max(best, Math.round((hit / qt.length) * 50) - (nt.size - hit));
    }
  }
  return best;
}

export function bestIcon<T extends Pick<IconEntry, "n" | "t">>(query: string, icons: T[], min = 40): T | undefined {
  let top: T | undefined;
  let topScore = min - 1;
  for (const i of icons) {
    const s = iconScore(query, i);
    if (s > topScore) {
      top = i;
      topScore = s;
    }
  }
  return top;
}

/** What to look for in an uploaded Google Cloud pack for each GCP resource type. */
export const GCP_ICON_QUERIES: Record<string, string> = {
  "gcp.project": "project",
  "gcp.region": "region",
  "gcp.vpc": "virtual private cloud",
  "gcp.subnet": "subnet",
  "gcp.cloud_run": "cloud run",
  "gcp.cloud_sql": "cloud sql",
  "gcp.gcs_bucket": "cloud storage",
  "gcp.memorystore_redis": "memorystore",
  "gcp.pubsub_topic": "pubsub",
  "gcp.load_balancer": "cloud load balancing",
  "gcp.secret": "secret manager",
  "gcp.artifact_registry": "artifact registry",
};

export function guessFamily(name: string): IconFamily {
  const n = name.toLowerCase();
  if (/google|gcp|cloud[-_ ]?icons|gcp/.test(n)) return "gcp";
  if (/aws|amazon/.test(n)) return "aws";
  if (/azure|microsoft/.test(n)) return "azure";
  return "custom";
}

/**
 * Removes anything executable from an SVG: scripts, event handlers, javascript: links,
 * foreignObject, and external references. Icons are also always displayed through <img>,
 * which never runs scripts; this is defence in depth (e.g. for draw.io export).
 * Returns null if it isn't an SVG.
 */
export function sanitizeSvg(svg: string): string | null {
  const s = svg.replace(/^﻿/, "").trim();
  const start = s.search(/<svg[\s>]/i);
  if (start < 0 || !/<\/svg>\s*$/i.test(s)) return null;
  return s
    .slice(start)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script[^>]*\/>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|xlink:href)\s*=\s*("|')\s*(javascript:|data:text\/html|https?:)[^"']*\2/gi, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<\?xml[^>]*\?>/gi, "");
}

/** PNG icons are kept as data URLs; anything else is rejected. */
export function sanitizeIconData(s: string): string | null {
  if (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s)) return s;
  return sanitizeSvg(s);
}

export const iconDataUrl = (s: string) => (s.startsWith("data:") ? s : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`);

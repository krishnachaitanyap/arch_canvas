import JSZip from "jszip";
import { guessFamily, type IconEntry, type IconFamily, normalizeIconName, sanitizeIconData } from "@archcanvas/shared";

const MAX_TOTAL = 11 * 1024 * 1024;
const MAX_PNG = 150 * 1024;

export interface ReadIcons {
  icons: IconEntry[];
  skipped: number;
  suggestedName: string;
  family: IconFamily;
}

/**
 * Reads icons from vendor zips (e.g. Google Cloud's or AWS's official icon downloads) and/or
 * loose SVG and PNG files. Prefers SVG over PNG, keeps one icon per product name, and
 * sanitises every SVG.
 */
export async function readIconFiles(files: File[]): Promise<ReadIcons> {
  const raw: { path: string; svg?: string; png?: Uint8Array }[] = [];
  let skipped = 0;
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const zip = await JSZip.loadAsync(f);
      for (const entry of Object.values(zip.files)) {
        if (entry.dir || /(^|\/)(__MACOSX|\.)/.test(entry.name)) continue;
        if (/\.svg$/i.test(entry.name)) raw.push({ path: entry.name, svg: await entry.async("string") });
        else if (/\.png$/i.test(entry.name)) raw.push({ path: entry.name, png: await entry.async("uint8array") });
      }
    } else if (/\.svg$/i.test(f.name)) raw.push({ path: f.name, svg: await f.text() });
    else if (/\.png$/i.test(f.name)) raw.push({ path: f.name, png: new Uint8Array(await f.arrayBuffer()) });
    else skipped++;
  }

  // Category = first folder below a shared root folder, if any.
  const roots = new Set(raw.map((r) => r.path.split("/")[0]));
  const strip = roots.size === 1 && raw.every((r) => r.path.includes("/"));
  const byName = new Map<string, IconEntry & { kind: "svg" | "png" }>();
  let total = 0;
  for (const r of raw) {
    const parts = (strip ? r.path.split("/").slice(1) : r.path.split("/")).filter(Boolean);
    const file = parts[parts.length - 1];
    const base = file.replace(/\.(svg|png)$/i, "");
    const key = normalizeIconName(base);
    if (!key) continue;
    const existing = byName.get(key);
    if (existing && (existing.kind === "svg" || r.png)) continue; // keep the first SVG
    let s: string | null = null;
    if (r.svg) s = sanitizeIconData(r.svg);
    else if (r.png && r.png.length <= MAX_PNG) s = `data:image/png;base64,${toBase64(r.png)}`;
    if (!s) continue;
    total += s.length;
    if (total > MAX_TOTAL) throw new Error("This icon pack is larger than 11 MB. Upload the SVG folder only, or split it into smaller packs.");
    byName.set(key, { n: base, t: titleCase(key), c: parts.length > 1 ? titleCase(normalizeIconName(parts[0])) : undefined, s, kind: r.svg ? "svg" : "png" });
  }
  const icons = [...byName.values()].map(({ kind: _k, ...i }) => i);
  const used = new Set<string>();
  for (const i of icons) {
    let n = i.n;
    for (let k = 2; used.has(n); k++) n = `${i.n}-${k}`;
    i.n = n;
    used.add(n);
  }
  const first = files[0]?.name.replace(/\.(zip|svg|png)$/i, "") ?? "Icons";
  // Not images, plus duplicates, invalid SVGs and oversized PNGs.
  return { icons, skipped: skipped + raw.length - icons.length, suggestedName: files.length === 1 ? first : "Uploaded icons", family: guessFamily(files.map((f) => f.name).join(" ")) };
}

const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

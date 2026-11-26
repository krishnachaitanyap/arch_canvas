import { useEffect, useMemo, useState } from "react";
import { iconDataUrl } from "@archcanvas/shared";
import { allPacks, searchIcons, type SearchHit, useIconsVersion } from "./registry";

/**
 * Searchable grid over every icon pack: AWS, Lucide, technology logos and the packs uploaded
 * to the workspace. Used in the palette (to add a component) and as the icon picker.
 */
export function IconLibrary({ onPick, compact, initialQuery = "" }: { onPick: (hit: SearchHit) => void; compact?: boolean; initialQuery?: string }) {
  useIconsVersion();
  const packs = allPacks();
  const [query, setQuery] = useState(initialQuery);
  const [packId, setPackId] = useState<string>("aws");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const ids = useMemo(() => (packId === "*" ? packs.filter((p) => p.id !== "logos" || query.trim()).map((p) => p.id) : [packId]), [packId, packs, query]);
  const idsKey = ids.join(",");

  useEffect(() => {
    if (!ids.length) return setHits([]);
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      void searchIcons(query, ids, compact ? 60 : 160).then((h) => {
        if (!cancelled) {
          setHits(h);
          setLoading(false);
        }
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, idsKey, compact]);

  const meta = packs.find((p) => p.id === packId);

  return (
    <div className={`icon-library ${compact ? "compact" : ""}`}>
      <input placeholder="Search icons (e.g. lambda, kafka, database)" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search icons" />
      <div className="pack-chips">
        {[{ id: "*", name: "All" }, ...packs].map((p) => (
          <button key={p.id} className={p.id === packId ? "active" : ""} onClick={() => setPackId(p.id)} title={"license" in p ? `${p.name} · ${p.license}` : undefined}>
            {shortName(p.name)}
          </button>
        ))}
      </div>
      <div className="icon-grid">
        {hits?.map((h) => (
          <button key={h.ref} className="icon-tile" title={`${h.t}${h.c ? ` · ${h.c}` : ""}`} onClick={() => onPick(h)}>
            <img src={iconDataUrl(h.s)} alt="" loading="lazy" draggable={false} />
            <span>{h.t}</span>
          </button>
        ))}
      </div>
      {loading && <p className="hint">Loading icons…</p>}
      {!loading && hits?.length === 0 && <p className="hint">No icons match.</p>}
      {meta && !meta.builtIn && <p className="hint">Uploaded pack · {meta.count} icons</p>}
      {meta?.builtIn && (
        <p className="hint">
          {meta.name} · {meta.license}
          {meta.url && (
            <>
              {" · "}
              <a href={meta.url} target="_blank" rel="noreferrer">
                source
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}

function shortName(name: string): string {
  if (/^AWS/.test(name)) return "AWS";
  if (/^Technology logos/.test(name)) return "Logos";
  return name.length > 18 ? `${name.slice(0, 16)}…` : name;
}

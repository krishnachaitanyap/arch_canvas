import { type DragEvent, useEffect, useMemo, useState } from "react";
import { CATALOG, type Category, iconDataUrl, iconScore, type IconEntry } from "@archcanvas/shared";
import { allPacks, loadPack, useIconsVersion } from "../icons/registry";
import { ResourceIcon } from "./flow";

/** What a palette tile adds to the canvas. */
export interface PaletteItem {
  key: string;
  kind: string;
  label: string;
  icon?: string;
  hint?: string;
  /** Icon markup for pack items (already loaded). */
  svg?: string;
}

export const DRAG_TYPE = "application/x-archcanvas-item";

interface Segment {
  id: string;
  title: string;
  note?: string;
  items: PaletteItem[] | null; // null = pack not loaded yet
  packId?: string;
  defaultOpen?: boolean;
}

const GCP_ORDER: Category[] = ["Groups", "Compute", "Data", "Messaging", "Networking", "Security", "DevOps"];
const BASICS = ["generic.client", "generic.group", "generic.component", "generic.note"];
const PREVIEW = 48;

/** Search synonyms, so "database" finds Cloud SQL and "lambda" finds Cloud Run. */
const SYNONYMS: Record<string, string> = {
  "gcp.project": "account project organization",
  "gcp.region": "region location zone",
  "gcp.vpc": "vpc network vnet",
  "gcp.subnet": "subnet network segment",
  "gcp.cloud_run": "compute service container api app serverless lambda function microservice",
  "gcp.cloud_sql": "database db postgres postgresql mysql sql rds",
  "gcp.gcs_bucket": "storage bucket object s3 blob files",
  "gcp.memorystore_redis": "cache redis elasticache memory",
  "gcp.pubsub_topic": "queue topic events messaging kafka sqs sns stream",
  "gcp.load_balancer": "load balancer gateway ingress alb elb cdn waf",
  "gcp.secret": "secret key vault credentials password",
  "gcp.artifact_registry": "registry docker images container ecr",
  "generic.client": "users people browser mobile internet client",
  "generic.group": "group boundary container team environment",
  "generic.component": "component box system service external saas",
  "generic.note": "note text comment annotation sticky",
};

const gcpItems: PaletteItem[] = CATALOG.filter((c) => c.kind.startsWith("gcp."))
  .sort((a, b) => GCP_ORDER.indexOf(a.category) - GCP_ORDER.indexOf(b.category))
  .map((c) => ({ key: c.kind, kind: c.kind, label: c.label, hint: c.description }));
const basicItems: PaletteItem[] = BASICS.map((k) => CATALOG.find((c) => c.kind === k)!).map((c) => ({ key: c.kind, kind: c.kind, label: c.label, hint: c.description }));

/** Icon-pack entries become documentation components; AWS group icons (VPC, subnet…) become groups. */
const fromIcon = (packId: string, i: IconEntry): PaletteItem => ({
  key: `${packId}:${i.n}`,
  kind: i.c === "Groups" ? "generic.group" : "generic.component",
  label: i.t,
  icon: `${packId}:${i.n}`,
  svg: i.s,
  hint: `${i.t}${i.c ? ` · ${i.c}` : ""}${i.c === "Groups" ? " (group)" : ""}`,
});

export function Palette({ onAdd, disabled }: { onAdd: (item: PaletteItem) => void; disabled: boolean }) {
  useIconsVersion();
  const packs = allPacks();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>(() => JSON.parse(localStorage.getItem("archcanvas.palette.open") ?? "{}"));
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState<Record<string, IconEntry[]>>({});
  const q = query.trim();

  const isOpen = (s: Segment) => open[s.id] ?? Boolean(s.defaultOpen);
  const toggle = (id: string, value: boolean) =>
    setOpen((o) => {
      const next = { ...o, [id]: value };
      localStorage.setItem("archcanvas.palette.open", JSON.stringify(next));
      return next;
    });

  const segments: Segment[] = useMemo(() => {
    const out: Segment[] = [
      { id: "gcp", title: "Google Cloud", note: "Deploys with Terraform", items: gcpItems, defaultOpen: true },
      { id: "basics", title: "Diagram basics", items: basicItems, defaultOpen: true },
    ];
    for (const p of packs) {
      const icons = loaded[p.id] ?? null;
      if (p.id === "aws") {
        for (const [c, title] of [
          ["Groups", "AWS · Groups (VPC, subnets, regions…)"],
          ["Services", "AWS · Services"],
          ["Resources", "AWS · Resources"],
        ] as const)
          out.push({ id: `aws-${c}`, title, packId: p.id, items: icons ? icons.filter((i) => i.c === c).map((i) => fromIcon(p.id, i)) : null, defaultOpen: c === "Groups" });
      } else
        out.push({
          id: p.id,
          title: p.builtIn ? (p.id === "lucide" ? "Generic icons (Lucide)" : p.id === "logos" ? "Technology logos" : p.name) : `${p.family === "gcp" ? "Google Cloud icons" : "Uploaded"} · ${p.name}`,
          packId: p.id,
          items: icons ? icons.map((i) => fromIcon(p.id, i)) : null,
        });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packs.map((p) => p.id).join(), loaded]);

  // Load a pack when its segment is open, or for every pack while searching.
  useEffect(() => {
    for (const s of segments) {
      if (!s.packId || loaded[s.packId] || !(q || isOpen(s))) continue;
      const id = s.packId;
      void loadPack(id).then((icons) => setLoaded((l) => (l[id] ? l : { ...l, [id]: icons })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, open, q]);

  const filtered = (items: PaletteItem[]) => {
    if (!q) return items;
    return items
      // Names first; descriptions catch synonyms ("database" → Cloud SQL, "cache" → Memorystore).
      .map((it) => {
        const words = !it.svg ? `${SYNONYMS[it.kind] ?? ""} ${it.hint ?? ""}`.toLowerCase() : "";
        const synonym = words && q.toLowerCase().split(/\s+/).every((w) => words.includes(w)) ? 70 : 0;
        return { it, s: Math.max(iconScore(q, { n: it.key, t: it.label }), synonym) };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.it);
  };

  const onDragStart = (e: DragEvent, item: PaletteItem) => {
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item));
    e.dataTransfer.effectAllowed = "copy";
  };

  let shown = 0;
  return (
    <div className="palette-inner">
      <input className="palette-search" placeholder="Search all icons and resources" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search palette" />
      {segments.map((s) => {
        const items = s.items ? filtered(s.items) : null;
        if (q && items && !items.length) return null;
        const expanded = q ? true : isOpen(s);
        const all = Boolean(showAll[s.id]);
        const visible = items ? (all ? items : items.slice(0, q ? 24 : PREVIEW)) : [];
        shown += visible.length;
        return (
          <section key={s.id} className={`seg ${expanded ? "open" : ""}`}>
            <button className="seg-head" onClick={() => !q && toggle(s.id, !expanded)} aria-expanded={expanded}>
              <span className="chev">{expanded ? "▾" : "▸"}</span>
              <span className="seg-title">{s.title}</span>
              {items && <span className="count">{items.length}</span>}
            </button>
            {expanded && (
              <>
                {s.note && <p className="seg-note">{s.note}</p>}
                {!items ? (
                  <p className="hint">Loading…</p>
                ) : (
                  <div className="tile-grid">
                    {visible.map((it) => (
                      <button
                        key={it.key}
                        className="tile"
                        title={it.hint ?? it.label}
                        disabled={disabled}
                        draggable={!disabled}
                        onDragStart={(e) => onDragStart(e, it)}
                        onClick={() => onAdd(it)}
                      >
                        {it.svg ? <img src={iconDataUrl(it.svg)} alt="" width={32} height={32} loading="lazy" draggable={false} /> : <ResourceIcon kind={it.kind} size={32} />}
                        <span>{it.label}</span>
                      </button>
                    ))}
                  </div>
                )}
                {items && items.length > visible.length && (
                  <button className="link small" onClick={() => setShowAll((a) => ({ ...a, [s.id]: true }))}>
                    Show all {items.length}
                  </button>
                )}
              </>
            )}
          </section>
        );
      })}
      {q && shown === 0 && <p className="hint">Nothing matches “{q}”.</p>}
      <p className="hint palette-foot">Click to add, or drag onto the canvas (into a group to nest it). Only Google Cloud items deploy with Terraform; everything else is documentation.</p>
    </div>
  );
}

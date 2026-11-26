import { type DragEvent, useEffect, useMemo, useState } from "react";
import { AWS_GROUPS, awsGroupStyle, CATALOG, type Category, type GroupPreset, iconDataUrl, OTHER_GROUPS, iconScore, type IconEntry, SHAPE_LABELS, type ShapeName, SHAPES } from "@archcanvas/shared";
import { allPacks, loadPack, useIconsVersion } from "../icons/registry";
import { ResourceIcon, ShapeOutline } from "./flow";

/** What a palette tile adds to the canvas. */
export interface PaletteItem {
  key: string;
  kind: string;
  label: string;
  icon?: string;
  hint?: string;
  /** Icon markup for pack items (already loaded). */
  svg?: string;
  /** Properties for the new node (e.g. which shape). */
  props?: Record<string, unknown>;
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
  "generic.shape": "shape flowchart diagram box",
};

/**
 * A curated starting set for mixed estates. Groups become real containers; the rest are
 * documentation components. Icons come from the bundled packs (Lucide, logos, AWS).
 */
/** A styled boundary box (AWS region, Azure VNet, namespace…). */
const preset = (prefix: string, p: GroupPreset): PaletteItem => ({
  key: `${prefix}:${p.label}`,
  kind: "generic.group",
  label: p.label,
  icon: p.icon,
  props: { ...p.style },
  hint: `${p.hint} (group)`,
});
const boundaryItems: PaletteItem[] = OTHER_GROUPS.map((p) => preset("grp", p));
/** AWS group boxes without a pack icon (the rest come from the AWS pack). */
const awsExtraGroups: PaletteItem[] = AWS_GROUPS.filter((p) => !p.icon).map((p) => preset("awsgrp", p));
const c = (label: string, icon: string, hint: string): PaletteItem => ({ key: `mc:${label}`, kind: "generic.component", label, icon, hint });
const multiCloudItems: PaletteItem[] = [
  c("Server", "lucide:server", "server host bare metal on-prem"),
  c("Virtual machine", "lucide:cpu", "vm virtual machine compute instance"),
  c("Container", "lucide:container", "container docker pod"),
  c("Database server", "lucide:database", "database db sql on-prem oracle"),
  c("Storage / SAN", "lucide:hard-drive", "storage san nas disk file share"),
  c("Firewall", "lucide:brick-wall", "firewall security network"),
  c("Router", "lucide:router", "router network gateway"),
  c("Switch / cabling", "lucide:cable", "switch network cable lan"),
  c("Load balancer", "lucide:split", "load balancer f5 haproxy on-prem"),
  c("VPN", "lucide:lock", "vpn tunnel interconnect secure link"),
  c("Internet", "lucide:globe", "internet public web"),
  c("Workstation", "lucide:laptop", "laptop desktop employee workstation"),
  c("Mobile app", "lucide:smartphone", "mobile app ios android phone"),
  c("Web browser", "lucide:app-window", "browser web app spa"),
  c("Mainframe / legacy", "lucide:landmark", "mainframe legacy system"),
  c("Identity provider", "logos:okta-icon", "identity idp sso okta auth"),
  c("Kafka", "logos:kafka-icon", "kafka stream events queue"),
  c("RabbitMQ", "logos:rabbitmq-icon", "rabbitmq queue amqp messaging"),
  c("PostgreSQL", "logos:postgresql", "postgres postgresql database"),
  c("Redis", "logos:redis", "redis cache"),
  c("Monitoring", "logos:grafana", "monitoring grafana observability dashboards"),
  c("CI/CD", "lucide:git-branch", "ci cd pipeline build deploy"),
  c("External API / SaaS", "lucide:cloud", "external api saas third party vendor"),
];

const shapeItems: PaletteItem[] = SHAPES.map((shape) => ({
  key: `shape:${shape}`,
  kind: "generic.shape",
  label: SHAPE_LABELS[shape].label,
  props: { shape },
  hint: `${SHAPE_LABELS[shape].title} shape flowchart ${shape}`,
}));

const gcpItems: PaletteItem[] = CATALOG.filter((c) => c.kind.startsWith("gcp."))
  .sort((a, b) => GCP_ORDER.indexOf(a.category) - GCP_ORDER.indexOf(b.category))
  .map((c) => ({ key: c.kind, kind: c.kind, label: c.label, hint: c.description }));
const basicItems: PaletteItem[] = [
  { key: "basic:text", kind: "generic.shape", label: "Text", props: { shape: "text" }, hint: "text label free text heading annotation (or double-click the canvas)" },
  ...BASICS.map((k) => CATALOG.find((c) => c.kind === k)!).map((c) => ({ key: c.kind, kind: c.kind, label: c.label, hint: c.description })),
];

/** Icon-pack entries become documentation components; AWS group icons (VPC, subnet…) become groups. */
const fromIcon = (packId: string, i: IconEntry): PaletteItem => {
  const style = packId === "aws" && i.c === "Groups" ? awsGroupStyle(i.n) : undefined;
  return {
    key: `${packId}:${i.n}`,
    kind: i.c === "Groups" ? "generic.group" : "generic.component",
    label: style ? (AWS_GROUPS.find((g) => g.icon === `aws:${i.n}`)?.label ?? i.t) : i.t,
    icon: `${packId}:${i.n}`,
    svg: i.s,
    ...(style ? { props: { ...style } } : {}),
    hint: `${i.t}${i.c ? ` · ${i.c}` : ""}${i.c === "Groups" ? " (group)" : ""}`,
  };
};

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
      { id: "shapes", title: "Flowchart & shapes", note: "Connect them with lines; set arrowheads and dashes in Properties", items: shapeItems, defaultOpen: true },
      { id: "boundaries", title: "Boundaries · Azure, Kubernetes, on-prem", note: "Groups to nest things in; change border, thickness and colour by right-clicking", items: boundaryItems, defaultOpen: true },
      { id: "multicloud", title: "Multi-cloud & on-prem", note: "Documentation; mix freely with any cloud", items: multiCloudItems, defaultOpen: true },
    ];
    for (const p of packs) {
      const icons = loaded[p.id] ?? null;
      if (p.id === "aws") {
        for (const [c, title] of [
          ["Groups", "AWS · Groups (VPC, subnets, regions…)"],
          ["Services", "AWS · Services"],
          ["Resources", "AWS · Resources"],
        ] as const)
          out.push({
            id: `aws-${c}`,
            title,
            packId: p.id,
            items: icons ? [...icons.filter((i) => i.c === c).map((i) => fromIcon(p.id, i)), ...(c === "Groups" ? awsExtraGroups : [])] : null,
            defaultOpen: c === "Groups",
          });
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
                        {it.key === "basic:text" ? (
                          <span className="tile-text">T</span>
                        ) : it.kind === "generic.shape" ? (
                          <ShapeOutline shape={String(it.props?.shape)} w={36} h={it.props?.shape === "circle" ? 30 : 26} fill="#fff" stroke="#27272a" sw={1.3} />
                        ) : it.kind === "generic.group" && !it.icon && it.props ? (
                          <span
                            className="tile-box"
                            style={{
                              borderStyle: String(it.props.border) === "none" ? "solid" : String(it.props.border),
                              borderColor: String(it.props.color),
                              background: it.props.fill && it.props.fill !== "none" ? String(it.props.fill) : "transparent",
                            }}
                          />
                        ) : it.svg ? (
                          <img src={iconDataUrl(it.svg)} alt="" width={32} height={32} loading="lazy" draggable={false} />
                        ) : (
                          <ResourceIcon kind={it.kind} icon={it.icon} size={32} />
                        )}
                        <span>{it.kind === "generic.shape" && it.key.startsWith("shape:") ? SHAPE_LABELS[it.props!.shape as ShapeName].title : it.label}</span>
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
      <p className="hint palette-foot">
        Click to add, or drag onto the canvas (into a group to nest it). Google Cloud items also generate Terraform; everything else is documentation. For
        official Azure or Google Cloud icons, upload their icon packs from the project page.
      </p>
    </div>
  );
}

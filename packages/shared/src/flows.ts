import { catalogEntry, resolvedProps, withNames } from "./catalog.js";
import { type DiagramEdge, type DiagramModel, type DiagramNode, nearestAncestor, nodeById } from "./model.js";
import { compileTerraform } from "./terraform.js";

/**
 * Workflows and integration explanations derived from the diagram. They use the same edge
 * semantics as the Terraform compiler, so what they say matches what gets deployed.
 */

export type Mode = "sync" | "async";

export interface Integration {
  edgeId: string;
  from: string;
  to: string;
  /** e.g. "Cloud Run → Cloud SQL" */
  pattern: string;
  /** One sentence, used as the workflow step text. */
  summary: string;
  mode: Mode;
  howItWorks: string[];
  security: string[];
  /** Environment variables and settings the caller gets. */
  config: string[];
  considerations: string[];
  /** Terraform resources this connection creates. */
  terraform: string[];
  /** False when there is no Terraform mapping (documentation only). */
  mapped: boolean;
}

export interface WorkflowStep {
  edgeId: string;
  from: string;
  to: string;
  text: string;
  mode: Mode;
}

export interface Workflow {
  id: string;
  title: string;
  summary: string;
  trigger: string;
  mode: Mode;
  steps: WorkflowStep[];
}

const STORES = new Set(["gcp.cloud_sql", "gcp.gcs_bucket", "gcp.secret", "gcp.memorystore_redis"]);
const env = (n: DiagramNode, s: string) => `${n.id.toUpperCase()}_${s}`;
const typeOf = (n: DiagramNode) => catalogEntry(n.kind)?.label ?? n.kind;

// ------------------------------------------------------------------ integrations

export function describeIntegrations(model: DiagramModel): Integration[] {
  const m = withNames(model);
  const resources = compileTerraform(m).resources;
  return m.edges.map((e) => describeEdge(m, e, resources)).filter((x): x is Integration => Boolean(x));
}

export function describeEdge(m: DiagramModel, e: DiagramEdge, resources = compileTerraform(m).resources): Integration | undefined {
  const from = nodeById(m, e.from);
  const to = nodeById(m, e.to);
  if (!from || !to) return undefined;
  const base = {
    edgeId: e.id,
    from: from.id,
    to: to.id,
    pattern: `${typeOf(from)} → ${typeOf(to)}`,
    terraform: terraformFor(resources, from.id, to.id),
  };
  const d = explain(m, from, to, e);
  return { ...base, ...d, mapped: d.mapped ?? base.terraform.length > 0 };
}

type Explained = Omit<Integration, "edgeId" | "from" | "to" | "pattern" | "terraform" | "mapped"> & { mapped?: boolean };

function explain(m: DiagramModel, from: DiagramNode, to: DiagramNode, e: DiagramEdge): Explained {
  // Data stores: access is granted whichever way the arrow was drawn (same as the compiler).
  if (from.kind === "gcp.cloud_run" && STORES.has(to.kind)) return runToStore(m, from, to);
  if (to.kind === "gcp.cloud_run" && STORES.has(from.kind)) return runToStore(m, to, from);

  const F = from.label;
  const T = to.label;
  switch (`${from.kind}>${to.kind}`) {
    case "generic.client>gcp.load_balancer": {
      const p = resolvedProps(to.kind, to.props);
      const domain = String(p.domain ?? "").trim();
      return {
        summary: `${F} send ${domain ? "HTTPS" : "HTTP"} requests to ${T}${domain ? ` at ${domain}` : ""}.`,
        mode: "sync",
        howItWorks: [
          `${T} is a global external Application Load Balancer with one anycast IP address (output ${to.id}_ip).`,
          domain
            ? `TLS terminates at Google's edge with a Google-managed certificate for ${domain}; point the domain's DNS A record at the IP so the certificate can provision.`
            : `No domain is set, so it listens on plain HTTP port 80.`,
          "The URL map picks a backend service per request (see the load balancer → service connections).",
        ],
        security: [
          p.cloud_armor
            ? "Cloud Armor runs the preconfigured SQL-injection and XSS WAF rules before traffic reaches a backend."
            : "Cloud Armor is off: no WAF or IP filtering in front of the backends.",
        ],
        config: [],
        considerations: domain ? ["Certificate provisioning can take up to an hour after DNS points at the IP."] : ["Set a domain to get HTTPS."],
        mapped: true,
      };
    }
    case "generic.client>gcp.cloud_run": {
      const pub = Boolean(resolvedProps(to.kind, to.props).public);
      return {
        summary: `${F} call ${T} directly on its run.app URL.`,
        mode: "sync",
        howItWorks: [`Requests go to the service's HTTPS URL (output ${to.id}_url); Cloud Run scales instances with traffic.`],
        security: [
          pub
            ? "The service allows unauthenticated calls (roles/run.invoker for allUsers)."
            : "The service requires authentication, so anonymous users get 403. Make it public or put a load balancer in front.",
        ],
        config: [],
        considerations: ["No WAF or custom domain without a load balancer in front."],
        mapped: pub,
      };
    }
    case "generic.client>gcp.gcs_bucket":
      return {
        summary: `${F} access objects in ${T}.`,
        mode: "sync",
        howItWorks: ["The bucket enforces public access prevention, so users need signed URLs issued by a service."],
        security: ["Uniform bucket-level access; no public objects."],
        config: [],
        considerations: ["Have a service issue V4 signed URLs for uploads and downloads."],
        mapped: false,
      };
    case "gcp.load_balancer>gcp.cloud_run": {
      const backends = m.edges.filter((x) => x.from === from.id && nodeById(m, x.to)?.kind === "gcp.cloud_run");
      const first = backends[0]?.to === to.id;
      return {
        summary: `${F} routes ${first ? "requests" : `/${to.id.replace(/_/g, "-")}/* requests`} to ${T}.`,
        mode: "sync",
        howItWorks: [
          `A serverless network endpoint group in ${T}'s region points the backend service at the Cloud Run service.`,
          first
            ? `${T} is the default backend: every path that no other rule matches goes here.`
            : `The URL map sends /${to.id.replace(/_/g, "-")} and /${to.id.replace(/_/g, "-")}/* to ${T}.`,
        ],
        security: [
          "The service's ingress is set to internal and load balancer only, so its run.app URL can't be called directly from the internet.",
          "The load balancer carries no user identity: authenticate users in the app or add Identity-Aware Proxy.",
        ],
        config: [],
        considerations: ["Cold starts show up as latency at the load balancer; raise min instances for latency-sensitive services."],
      };
    }
    case "gcp.cloud_run>gcp.cloud_run":
      return {
        summary: `${F} calls ${T} over authenticated HTTPS.`,
        mode: "sync",
        howItWorks: [
          `${F} reads ${T}'s URL from ${env(to, "URL")}.`,
          `It gets a Google-signed ID token from the metadata server with the audience set to that URL and sends it as a Bearer token.`,
        ],
        security: [`Only ${F}'s service account has roles/run.invoker on ${T}.`],
        config: [`${env(to, "URL")} = ${T}'s https URL`],
        considerations: ["Set request timeouts and retries with backoff; calls are synchronous, so failures propagate."],
      };
    case "gcp.cloud_run>gcp.pubsub_topic":
      return {
        summary: `${F} publishes a message to ${T} and carries on without waiting for it to be processed.`,
        mode: "async",
        howItWorks: [
          `${F} publishes with the Pub/Sub client library to the topic in ${env(to, "TOPIC")}.`,
          "Pub/Sub stores the message durably and delivers it to every subscription at least once.",
        ],
        security: [`${F}'s service account has roles/pubsub.publisher on ${T} only.`],
        config: [`${env(to, "TOPIC")} = topic id`],
        considerations: ["Messages can be delivered more than once: include an idempotency key."],
      };
    case "gcp.pubsub_topic>gcp.cloud_run":
      return {
        summary: `${F} pushes each message to ${T} as an authenticated HTTPS POST.`,
        mode: "async",
        howItWorks: [
          `A push subscription POSTs each message (base64 data plus attributes) to ${T}'s URL.`,
          `${T} acknowledges by returning 2xx within 60 seconds; any other result is retried with backoff.`,
        ],
        security: [
          `Requests carry an OIDC token for a dedicated push service account, which is the only extra identity with roles/run.invoker on ${T}.`,
        ],
        config: [],
        considerations: [
          "Make processing idempotent: delivery is at least once.",
          "No dead-letter topic is configured yet, so poison messages are retried until they expire (7 days).",
        ],
      };
    case "gcp.artifact_registry>gcp.cloud_run":
    case "gcp.cloud_run>gcp.artifact_registry": {
      const [repo, run] = from.kind === "gcp.artifact_registry" ? [from, to] : [to, from];
      return {
        summary: `${run.label} runs container images stored in ${repo.label}.`,
        mode: "sync",
        howItWorks: [
          `CI pushes images to ${repo.label} (output ${repo.id}_repository) and deploys by setting the ${run.id}_image variable.`,
          "Cloud Run pulls the image when it creates a revision.",
        ],
        security: ["Within one project the Cloud Run service agent can pull images without extra IAM."],
        config: [],
        considerations: ["Deploy by digest rather than :latest so revisions are reproducible."],
        mapped: true,
      };
    }
    default:
      return {
        summary: `${F} connects to ${T}${e.protocol ? ` over ${e.protocol}` : ""}${e.label ? ` (${e.label})` : ""}.`,
        mode: e.protocol === "pubsub" ? "async" : "sync",
        howItWorks: ["This connection is documentation only: there is no automatic Terraform mapping for this pair yet."],
        security: [],
        config: [],
        considerations: [],
        mapped: false,
      };
  }
}

function runToStore(m: DiagramModel, run: DiagramNode, store: DiagramNode): Explained {
  const R = run.label;
  const S = store.label;
  const p = resolvedProps(store.kind, store.props);
  switch (store.kind) {
    case "gcp.cloud_sql": {
      const vpc = nearestAncestor(m, store.id, "gcp.vpc");
      const pg = String(p.database_version).startsWith("POSTGRES");
      const max = Number(resolvedProps(run.kind, run.props).max_instances);
      return {
        summary: `${R} reads and writes the ${p.database_name} database in ${S}.`,
        mode: "sync",
        howItWorks: [
          `Cloud Run mounts the Cloud SQL connector at /cloudsql; ${R} connects through the Unix socket /cloudsql/$${env(store, "INSTANCE")}.`,
          vpc
            ? `${S} has only a private IP in ${vpc.label}, reached through private service access.`
            : `${S} has a public IP but accepts only connections through the connector (SSL required, no authorized networks).`,
          `It signs in as its own service account using IAM database authentication: no password is stored anywhere.`,
        ],
        security: [
          `${R}'s service account has roles/cloudsql.client and roles/cloudsql.instanceUser, and a ${pg ? "PostgreSQL" : "MySQL"} IAM user.`,
          "Grant that database user only the table privileges it needs (for example with a migration).",
        ],
        config: [`${env(store, "INSTANCE")} = connection name`, `${env(store, "DATABASE")} = ${p.database_name}`, `${env(store, "USER")} = IAM user name`],
        considerations: [
          `Up to ${max} instances × the app's connection pool size must stay under ${S}'s connection limit.`,
          p.high_availability ? "High availability is on: failover takes about a minute." : `${S} is single-zone: a zone outage takes it down.`,
        ],
      };
    }
    case "gcp.memorystore_redis": {
      const subnet = nearestAncestor(m, run.id, "gcp.subnet");
      return {
        summary: `${R} caches data in ${S}.`,
        mode: "sync",
        howItWorks: [
          subnet
            ? `${R} sends private traffic out through subnet ${subnet.label} (direct VPC egress), reaching ${S}'s private IP.`
            : `${R} is not inside a subnet, so it cannot reach ${S}'s private IP. Move it into a subnet of the same VPC.`,
          `It connects with any Redis client to ${env(store, "HOST")}:${env(store, "PORT")}.`,
        ],
        security: ["Access is limited to the VPC network. Redis AUTH and in-transit encryption are not enabled."],
        config: [`${env(store, "HOST")} = private IP`, `${env(store, "PORT")} = 6379`],
        considerations: [
          p.tier === "BASIC" ? "BASIC tier has no replica: data is lost on failure, so treat it as a cache only." : "STANDARD_HA replicates across zones.",
        ],
        mapped: Boolean(subnet),
      };
    }
    case "gcp.gcs_bucket":
      return {
        summary: `${R} stores and reads objects in ${S}.`,
        mode: "sync",
        howItWorks: [
          `${R} calls the Cloud Storage API with the Google Cloud client library, using the bucket name in ${env(store, "BUCKET")}.`,
          "Credentials come from its service account through the metadata server; no keys are involved.",
        ],
        security: [`${R}'s service account has roles/storage.objectUser on ${S} only.`, "Public access prevention is enforced on the bucket."],
        config: [`${env(store, "BUCKET")} = bucket name`],
        considerations: [p.versioning ? "Object versioning keeps overwritten objects: add a lifecycle rule to control cost." : "Versioning is off: overwrites and deletes are permanent."],
      };
    case "gcp.secret":
      return {
        summary: `${R} reads the ${S} secret at startup.`,
        mode: "sync",
        howItWorks: [`Cloud Run resolves the latest version of ${S} when an instance starts and exposes it as the ${store.id.toUpperCase()} environment variable.`],
        security: [`Only ${R}'s service account has roles/secretmanager.secretAccessor on ${S}.`],
        config: [`${store.id.toUpperCase()} = secret value`],
        considerations: ["A rotated secret reaches running instances only after a new revision or restart."],
      };
  }
  return { summary: `${R} uses ${S}.`, mode: "sync", howItWorks: [], security: [], config: [], considerations: [], mapped: false };
}

function terraformFor(resources: string[], a: string, b: string): string[] {
  const prefixes = [`${a}_${b}`, `${b}_${a}`, `${a}_to_${b}`, `${a}_invokes_${b}`, `${a}_publishes_${b}`];
  return resources.filter((r) => {
    const name = r.slice(r.indexOf(".") + 1);
    return prefixes.some((p) => name === p || name.startsWith(`${p}_`));
  });
}

// ------------------------------------------------------------------ workflows

/**
 * Splits the diagram into workflows. Each starts at an entry point (users and clients, or
 * nodes nothing calls) and follows connections in order. Pub/Sub topics are async
 * boundaries: publishing ends the request flow, and each topic starts its own workflow.
 */
export function generateWorkflows(model: DiagramModel): Workflow[] {
  const m = withNames(model);
  const integrations = new Map(describeIntegrations(m).map((i) => [i.edgeId, i]));
  const out = new Map<string, DiagramEdge[]>();
  for (const e of m.edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  const indeg = new Map<string, number>();
  for (const e of m.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const isContainer = (n: DiagramNode) => Boolean(catalogEntry(n.kind)?.container);
  const covered = new Set<string>();

  const walk = (start: string): DiagramEdge[] => {
    const steps: DiagramEdge[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      for (const e of out.get(id) ?? []) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        steps.push(e);
        const target = nodeById(m, e.to);
        // Stop at async boundaries and at data stores.
        if (target && target.kind !== "gcp.pubsub_topic" && !STORES.has(target.kind)) visit(e.to);
      }
    };
    visit(start);
    return steps;
  };

  const workflows: Workflow[] = [];
  const add = (id: string, title: string, trigger: string, mode: Mode, edges: DiagramEdge[]) => {
    if (!edges.length) return;
    edges.forEach((e) => covered.add(e.id));
    const steps = edges.map((e) => {
      const i = integrations.get(e.id);
      return { edgeId: e.id, from: e.from, to: e.to, text: i?.summary ?? `${e.from} → ${e.to}`, mode: i?.mode ?? "sync" };
    });
    workflows.push({ id, title, trigger, mode, steps, summary: summarize(m, steps) });
  };

  const clients = m.nodes.filter((n) => n.kind === "generic.client");
  const entries = clients.length
    ? clients
    : m.nodes.filter((n) => !isContainer(n) && !indeg.get(n.id) && n.kind !== "gcp.pubsub_topic" && !STORES.has(n.kind) && out.get(n.id)?.length);
  for (const n of entries) add(`request:${n.id}`, `Request from ${n.label}`, `${n.label} make a request`, "sync", walk(n.id));

  for (const t of m.nodes.filter((n) => n.kind === "gcp.pubsub_topic"))
    add(`async:${t.id}`, `Processing ${t.label} messages`, `A message is published to ${t.label}`, "async", walk(t.id));

  // Anything not reached from an entry point (e.g. a scheduled job's calls).
  const rest = m.edges.filter((e) => !covered.has(e.id));
  const restStarts = [...new Set(rest.map((e) => e.from))].filter((id) => !rest.some((e) => e.to === id));
  for (const id of restStarts) {
    const n = nodeById(m, id)!;
    add(`other:${id}`, `Calls made by ${n.label}`, `${n.label} runs`, "sync", walk(id).filter((e) => !covered.has(e.id)));
  }
  const left = m.edges.filter((e) => !covered.has(e.id));
  add("other:rest", "Other connections", "Various", "sync", left);
  return workflows;
}

function summarize(m: DiagramModel, steps: WorkflowStep[]): string {
  const name = (id: string) => nodeById(m, id)?.label ?? id;
  const path: string[] = [];
  for (const s of steps) {
    if (!path.length) path.push(name(s.from));
    const t = nodeById(m, s.to);
    if (t && !STORES.has(t.kind) && t.kind !== "gcp.pubsub_topic" && !path.includes(name(s.to))) path.push(name(s.to));
  }
  const stores = [...new Set(steps.map((s) => nodeById(m, s.to)).filter((n) => n && STORES.has(n.kind)).map((n) => n!.label))];
  const topics = [...new Set(steps.map((s) => nodeById(m, s.to)).filter((n) => n?.kind === "gcp.pubsub_topic").map((n) => n!.label))];
  let s = path.join(" → ");
  if (stores.length) s += `, using ${list(stores)}`;
  if (topics.length) s += `, and hands work off to ${list(topics)}`;
  return s + ".";
}

const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

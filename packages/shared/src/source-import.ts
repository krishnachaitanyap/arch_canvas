import type { DiagramEdge, DiagramModel, DiagramNode, Protocol } from "./model.js";
import { edgeId } from "./ops.js";
import { parseCode } from "./code.js";
import { sqlToModel } from "./sql-import.js";
import { parseYamlDocuments, type Yaml } from "./yaml.js";

/**
 * Diagrams from existing infrastructure code: Terraform (.tf), Kubernetes manifests and
 * docker-compose files (YAML), and SQL schemas. Positions are left to the editor's auto
 * layout. Each importer is deliberately forgiving: what it can't read, it skips.
 */

export type SourceKind = "arch" | "terraform" | "kubernetes" | "compose" | "sql";

class Builder {
  nodes: DiagramNode[] = [];
  edges: DiagramEdge[] = [];
  private taken = new Set<string>();

  id(raw: string): string {
    let base = raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "item";
    if (!/^[a-z]/.test(base)) base = `n_${base}`;
    base = base.slice(0, 36).replace(/_+$/, "");
    let id = base;
    for (let i = 2; this.taken.has(id); i++) id = `${base}_${i}`;
    this.taken.add(id);
    return id;
  }

  node(n: Omit<DiagramNode, "props"> & { props?: DiagramNode["props"] }): string {
    this.nodes.push({ props: {}, ...n, label: n.label.slice(0, 500) });
    return n.id;
  }

  edge(from: string | undefined, to: string | undefined, extra: Partial<DiagramEdge> = {}) {
    if (!from || !to || from === to) return;
    const id = edgeId(from, to);
    if (this.edges.some((e) => e.id === id || e.id === edgeId(to, from))) return;
    this.edges.push({ id, from, to, ...extra, ...(extra.label ? { label: extra.label.slice(0, 60) } : {}) });
  }

  model(): DiagramModel {
    // Lines can't join groups: drop any that do (a group's member is drawn instead).
    const groups = new Set(this.nodes.filter((n) => n.kind === "generic.group" || /^gcp\.(project|region|vpc|subnet)$/.test(n.kind)).map((n) => n.id));
    return { schemaVersion: 1, nodes: this.nodes, edges: this.edges.filter((e) => !groups.has(e.from) && !groups.has(e.to)), layout: {} };
  }
}

// ------------------------------------------------------------------ Terraform

interface TfBlock {
  type: string;
  name: string;
  body: string;
  /** Top-level string attributes (name = "…"). */
  attrs: Record<string, string>;
  /** Other resources this one refers to, as "type.name". */
  refs: string[];
}

/** Finds the resource and module blocks in Terraform files (HCL), with their references. */
export function parseTerraform(src: string): TfBlock[] {
  const text = src.replace(/(^|[^:])\/\/[^\n]*/g, "$1").replace(/#[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const out: TfBlock[] = [];
  const head = /\b(resource|module)\s+"([^"]+)"(?:\s+"([^"]+)")?\s*\{/g;
  for (let m = head.exec(text); m; m = head.exec(text)) {
    let depth = 1;
    let i = head.lastIndex;
    let q = false;
    for (; i < text.length && depth; i++) {
      const c = text[i];
      if (c === '"' && text[i - 1] !== "\\") q = !q;
      else if (!q && c === "{") depth++;
      else if (!q && c === "}") depth--;
    }
    const body = text.slice(head.lastIndex, i - 1);
    head.lastIndex = i;
    const [type, name] = m[1] === "module" ? ["module", m[2]] : [m[2], m[3] ?? ""];
    const attrs: Record<string, string> = {};
    // Attributes at the top level of the block only.
    let d = 0;
    for (const line of body.split("\n")) {
      const a = /^\s*([a-z_][a-z0-9_]*)\s*=\s*"([^"]*)"\s*$/i.exec(line);
      if (a && d === 0) attrs[a[1]] = a[2];
      d += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    }
    const refs = [...new Set([...body.matchAll(/(?<![\w.])((?:google|google-beta|aws|azurerm|kubernetes)_[a-z0-9_]+|module)\.([a-zA-Z0-9_-]+)/g)].map((r) => `${r[1] === "module" ? "module" : r[1]}.${r[2]}`))];
    out.push({ type, name, body, attrs, refs });
  }
  return out;
}

/** Terraform resource types drawn as ArchCanvas kinds (GCP) or icon items (AWS and others). */
const GCP_KINDS: Record<string, string> = {
  google_project: "gcp.project",
  google_compute_network: "gcp.vpc",
  google_compute_subnetwork: "gcp.subnet",
  google_cloud_run_v2_service: "gcp.cloud_run",
  google_cloud_run_service: "gcp.cloud_run",
  google_sql_database_instance: "gcp.cloud_sql",
  google_storage_bucket: "gcp.gcs_bucket",
  google_redis_instance: "gcp.memorystore_redis",
  google_pubsub_topic: "gcp.pubsub_topic",
  google_secret_manager_secret: "gcp.secret",
  google_artifact_registry_repository: "gcp.artifact_registry",
  google_compute_global_forwarding_rule: "gcp.load_balancer",
  google_compute_forwarding_rule: "gcp.load_balancer",
};

/** Icon items for other providers' resources ("pack:name"). */
export const TF_ICONS: Record<string, { icon: string; label: string }> = {
  aws_lambda_function: { icon: "aws:AWSLambda", label: "Lambda" },
  aws_s3_bucket: { icon: "aws:AmazonSimpleStorageService", label: "S3" },
  aws_db_instance: { icon: "aws:AmazonRDS", label: "RDS" },
  aws_rds_cluster: { icon: "aws:AmazonAurora", label: "Aurora" },
  aws_dynamodb_table: { icon: "aws:AmazonDynamoDB", label: "DynamoDB" },
  aws_sqs_queue: { icon: "aws:AmazonSimpleQueueService", label: "SQS" },
  aws_sns_topic: { icon: "aws:AmazonSimpleNotificationService", label: "SNS" },
  aws_lb: { icon: "aws:ElasticLoadBalancingApplicationLoadBalancer", label: "Load balancer" },
  aws_alb: { icon: "aws:ElasticLoadBalancingApplicationLoadBalancer", label: "Load balancer" },
  aws_ecs_service: { icon: "aws:AmazonElasticContainerService", label: "ECS service" },
  aws_ecs_cluster: { icon: "aws:AmazonElasticContainerService", label: "ECS cluster" },
  aws_instance: { icon: "aws:AmazonEC2", label: "EC2" },
  aws_autoscaling_group: { icon: "aws:AmazonEC2", label: "Auto Scaling group" },
  aws_elasticache_cluster: { icon: "aws:AmazonElastiCache", label: "ElastiCache" },
  aws_elasticache_replication_group: { icon: "aws:AmazonElastiCache", label: "ElastiCache" },
  aws_api_gateway_rest_api: { icon: "aws:AmazonAPIGateway", label: "API Gateway" },
  aws_apigatewayv2_api: { icon: "aws:AmazonAPIGateway", label: "API Gateway" },
  aws_cloudfront_distribution: { icon: "aws:AmazonCloudFront", label: "CloudFront" },
  aws_secretsmanager_secret: { icon: "aws:AWSSecretsManager", label: "Secret" },
  aws_cognito_user_pool: { icon: "aws:AmazonCognito", label: "Cognito" },
  aws_eks_cluster: { icon: "aws:AmazonElasticKubernetesService", label: "EKS" },
  aws_ecr_repository: { icon: "aws:AmazonElasticContainerRegistry", label: "ECR" },
  aws_kinesis_stream: { icon: "aws:AmazonKinesisDataStreams", label: "Kinesis" },
  aws_sfn_state_machine: { icon: "aws:AWSStepFunctions", label: "Step Functions" },
  aws_cloudwatch_event_rule: { icon: "aws:AmazonEventBridge", label: "EventBridge rule" },
  aws_route53_zone: { icon: "aws:AmazonRoute53", label: "Route 53" },
};

/** AWS network boundaries become boxes, like the AWS group presets. */
const TF_GROUPS: Record<string, Record<string, string>> = {
  aws_vpc: { color: "#248814", border: "solid", borderWidth: "1", fill: "none", header: "tab" },
  aws_subnet: { color: "#147eba", border: "none", fill: "#e6f2f8", header: "tab" },
};
const TF_GROUP_ICONS: Record<string, string> = { aws_vpc: "aws:VirtualprivatecloudVPC", aws_subnet: "aws:Privatesubnet" };

/** Resources that are details of another one (folded away rather than drawn). */
const TF_SKIP = /^(google_project_service|google_project_iam_|google_.*_iam_(member|binding|policy)|google_service_account|google_sql_(database|user)$|google_compute_(url_map|target_https_proxy|target_http_proxy|backend_service|region_network_endpoint_group|managed_ssl_certificate|security_policy|global_address|router|router_nat)|google_vpc_access_connector|google_service_networking_connection|google_secret_manager_secret_version|random_|null_resource|time_|aws_iam_|aws_security_group|aws_route|aws_internet_gateway|aws_nat_gateway|aws_eip|aws_lb_listener|aws_lb_target_group|aws_cloudwatch_log_group|aws_ecs_task_definition|aws_lambda_permission|aws_s3_bucket_[a-z_]+|aws_db_subnet_group|aws_elasticache_subnet_group|aws_sqs_queue_policy|aws_sns_topic_subscription|aws_lambda_event_source_mapping|aws_api_gateway_(resource|method|integration|deployment|stage)|aws_apigatewayv2_(route|integration|stage))/;

export function terraformToModel(src: string): DiagramModel {
  const blocks = parseTerraform(src);
  if (!blocks.length) throw new Error("No resource or module blocks found");
  const b = new Builder();
  const ids = new Map<string, string>();
  const key = (t: TfBlock) => `${t.type}.${t.name}`;
  const kept = blocks.filter((t) => !TF_SKIP.test(t.type));
  for (const t of kept) {
    // The resource's own name attribute when it's a literal (name, function_name, bucket…), else its Terraform name.
    const named = ["name", "function_name", "identifier", "bucket", "cluster_identifier", "cluster_id", "replication_group_id", "table_name", "repository_id", "secret_id", "instance_id", "account_id"]
      .map((k) => t.attrs[k])
      .find((v) => v && !/\$\{/.test(v));
    const label = named ?? t.name;
    const id = b.id(t.type === "module" ? `module_${t.name}` : t.name);
    ids.set(key(t), id);
    const gcp = GCP_KINDS[t.type];
    const props: Record<string, unknown> = {};
    if (gcp === "gcp.subnet" && t.attrs.ip_cidr_range) props.cidr = t.attrs.ip_cidr_range;
    if (gcp === "gcp.project" && t.attrs.project_id) props.project_id = t.attrs.project_id;
    if (gcp) b.node({ id, kind: gcp, label, props });
    else if (TF_GROUPS[t.type]) b.node({ id, kind: "generic.group", label: t.attrs.cidr_block ? `${label} ${t.attrs.cidr_block}` : label, props: { ...TF_GROUPS[t.type] }, icon: TF_GROUP_ICONS[t.type] });
    else if (TF_ICONS[t.type]) b.node({ id, kind: "generic.component", label, icon: TF_ICONS[t.type].icon });
    else if (t.type === "module") b.node({ id, kind: "generic.component", label: `module ${t.name}`, icon: "lucide:layers" });
    else b.node({ id, kind: "generic.component", label: `${label}`, icon: "lucide:box" });
  }
  const node = (k: string) => b.nodes.find((n) => n.id === ids.get(k));
  // Nesting: subnets in their network; GCP data stores with a private network in the VPC; AWS
  // resources in the subnet (or VPC) they name.
  for (const t of kept) {
    const n = node(key(t));
    if (!n) continue;
    const parents = t.refs.map((r) => node(r)).filter((p): p is DiagramNode => Boolean(p));
    const pick = (kinds: string[], types: string[]) => parents.find((p) => kinds.includes(p.kind) && types.some((ty) => [...ids.entries()].some(([k, v]) => v === p.id && k.startsWith(`${ty}.`))));
    let parent: DiagramNode | undefined;
    if (n.kind === "gcp.subnet") parent = pick(["gcp.vpc"], ["google_compute_network"]);
    else if (["gcp.cloud_sql", "gcp.memorystore_redis"].includes(n.kind)) parent = pick(["gcp.vpc"], ["google_compute_network"]);
    else if (t.type === "aws_subnet") parent = pick(["generic.group"], ["aws_vpc"]);
    else if (t.type.startsWith("aws_")) parent = pick(["generic.group"], ["aws_subnet"]) ?? pick(["generic.group"], ["aws_vpc"]);
    if (parent && parent.id !== n.id) n.parentId = parent.id;
  }
  // Connections: a resource that refers to another depends on (calls or uses) it.
  const protocolFor = (to: DiagramNode): Protocol | undefined =>
    ({ "gcp.cloud_sql": "sql", "gcp.memorystore_redis": "redis", "gcp.gcs_bucket": "storage", "gcp.secret": "secret", "gcp.pubsub_topic": "pubsub" })[to.kind] as Protocol | undefined;
  const isBox = (n: DiagramNode) => n.kind === "generic.group" || /^gcp\.(project|region|vpc|subnet)$/.test(n.kind);
  for (const t of kept) {
    const from = node(key(t));
    if (!from || isBox(from)) continue;
    for (const r of t.refs) {
      const to = node(r);
      if (!to || isBox(to) || to.id === from.id) continue;
      b.edge(from.id, to.id, protocolFor(to) ? { protocol: protocolFor(to) } : {});
    }
  }
  // Folded resources that link two drawn ones: a Pub/Sub push subscription (topic → target),
  // a Lambda event source (queue → function), an SNS subscription (topic → target).
  for (const t of blocks.filter((x) => TF_SKIP.test(x.type) || x.type === "google_pubsub_subscription")) {
    const refs = t.refs.map((r) => node(r)).filter((n): n is DiagramNode => Boolean(n) && !isBox(n!));
    if (t.type === "google_pubsub_subscription") {
      const topic = refs.find((n) => n.kind === "gcp.pubsub_topic");
      const target = refs.find((n) => n.kind !== "gcp.pubsub_topic");
      if (topic && target) b.edge(topic.id, target.id, { label: "push" });
    } else if (t.type === "aws_lambda_event_source_mapping" || t.type === "aws_sns_topic_subscription") {
      if (refs.length === 2) b.edge(refs[0].id, refs[1].id, { label: "trigger", dash: "dashed" });
    }
  }
  return b.model();
}

// ------------------------------------------------------------------ Kubernetes

type Obj = { [k: string]: Yaml };
const obj = (v: Yaml | undefined): Obj => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const arr = (v: Yaml | undefined): Yaml[] => (Array.isArray(v) ? v : []);
const str = (v: Yaml | undefined) => (v === null || v === undefined ? "" : String(v));

const K8S_ICONS: Record<string, string> = {
  Deployment: "lucide:box",
  StatefulSet: "lucide:database",
  DaemonSet: "lucide:layers",
  Job: "lucide:timer",
  CronJob: "lucide:clock",
  Service: "lucide:network",
  Ingress: "lucide:globe",
  ConfigMap: "lucide:file-cog",
  Secret: "lucide:key-round",
  PersistentVolumeClaim: "lucide:hard-drive",
  Pod: "lucide:container",
};
const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "Pod", "ReplicaSet"]);

export function kubernetesToModel(src: string): DiagramModel {
  const docs = parseYamlDocuments(src)
    .flatMap((d) => (obj(d).kind === "List" ? arr(obj(d).items) : [d]))
    .map(obj)
    .filter((d) => d.kind && d.metadata);
  if (!docs.length) throw new Error("No Kubernetes objects found (kind and metadata)");
  const b = new Builder();
  const namespaces = new Map<string, string>();
  const byKey = new Map<string, string>();
  const k = (kind: string, ns: string, name: string) => `${kind}/${ns}/${name}`;
  const nsOf = (d: Obj) => str(obj(d.metadata).namespace) || "default";
  const multiNs = new Set(docs.map(nsOf)).size > 1 || docs.some((d) => obj(d.metadata).namespace);
  for (const d of docs) {
    const kind = str(d.kind);
    if (!K8S_ICONS[kind] && !WORKLOADS.has(kind)) continue;
    const ns = nsOf(d);
    let parentId: string | undefined;
    if (multiNs) {
      if (!namespaces.has(ns))
        namespaces.set(ns, b.node({ id: b.id(`ns_${ns}`), kind: "generic.group", label: `namespace: ${ns}`, props: { color: "#326ce5", border: "dashed", borderWidth: "1", fill: "none", header: "label" } }));
      parentId = namespaces.get(ns);
    }
    const name = str(obj(d.metadata).name);
    const id = b.node({ id: b.id(`${name}_${kind === "Service" ? "svc" : kind === "Ingress" ? "ing" : ""}`.replace(/_$/, "")), kind: "generic.component", label: `${name}\n${kind}`.slice(0, 500), icon: K8S_ICONS[kind] ?? "lucide:box", ...(parentId ? { parentId } : {}) });
    byKey.set(k(kind, ns, name), id);
  }
  const find = (kind: string, ns: string, name: string) => byKey.get(k(kind, ns, name));
  const podSpec = (d: Obj): Obj => {
    const kind = str(d.kind);
    if (kind === "Pod") return obj(d.spec);
    if (kind === "CronJob") return obj(obj(obj(obj(obj(d.spec).jobTemplate).spec).template).spec);
    return obj(obj(obj(d.spec).template).spec);
  };
  const podLabels = (d: Obj): Obj => (str(d.kind) === "Pod" ? obj(obj(d.metadata).labels) : obj(obj(obj(obj(d.spec).template).metadata).labels));
  for (const d of docs) {
    const kind = str(d.kind);
    const ns = nsOf(d);
    const self = find(kind, ns, str(obj(d.metadata).name));
    if (!self) continue;
    if (WORKLOADS.has(kind)) {
      const spec = podSpec(d);
      const containers = [...arr(spec.containers), ...arr(spec.initContainers)].map(obj);
      for (const c of containers) {
        for (const ef of arr(c.envFrom).map(obj)) {
          if (ef.configMapRef) b.edge(self, find("ConfigMap", ns, str(obj(ef.configMapRef).name)), { label: "config", dash: "dotted" });
          if (ef.secretRef) b.edge(self, find("Secret", ns, str(obj(ef.secretRef).name)), { protocol: "secret", dash: "dotted" });
        }
        for (const ev of arr(c.env).map(obj)) {
          const from = obj(ev.valueFrom);
          if (from.configMapKeyRef) b.edge(self, find("ConfigMap", ns, str(obj(from.configMapKeyRef).name)), { label: "config", dash: "dotted" });
          if (from.secretKeyRef) b.edge(self, find("Secret", ns, str(obj(from.secretKeyRef).name)), { protocol: "secret", dash: "dotted" });
          // Env values naming another Service (DB_HOST=postgres) are calls to it.
          const v = str(ev.value);
          const svc = v && find("Service", ns, v.split(/[:./]/)[0]);
          if (svc) b.edge(self, svc, { label: str(ev.name).toLowerCase().slice(0, 40) });
        }
      }
      for (const v of arr(spec.volumes).map(obj)) {
        if (v.persistentVolumeClaim) b.edge(self, find("PersistentVolumeClaim", ns, str(obj(v.persistentVolumeClaim).claimName)), { protocol: "storage" });
        if (v.configMap) b.edge(self, find("ConfigMap", ns, str(obj(v.configMap).name)), { label: "config", dash: "dotted" });
        if (v.secret) b.edge(self, find("Secret", ns, str(obj(v.secret).secretName)), { protocol: "secret", dash: "dotted" });
      }
    }
    if (kind === "Service") {
      const sel = obj(obj(d.spec).selector);
      if (Object.keys(sel).length)
        for (const w of docs.filter((x) => WORKLOADS.has(str(x.kind)) && nsOf(x) === ns)) {
          const labels = podLabels(w);
          if (Object.entries(sel).every(([key, val]) => str(labels[key]) === str(val))) b.edge(self, find(str(w.kind), ns, str(obj(w.metadata).name)));
        }
    }
    if (kind === "Ingress") {
      const spec = obj(d.spec);
      const backends: string[] = [];
      const def = obj(obj(spec.defaultBackend).service);
      if (def.name) backends.push(str(def.name));
      for (const rule of arr(spec.rules).map(obj))
        for (const p of arr(obj(rule.http).paths).map(obj)) {
          const s = obj(obj(p.backend).service);
          backends.push(str(s.name || obj(p.backend).serviceName));
        }
      for (const name of backends) b.edge(self, find("Service", ns, name), { protocol: "https" });
    }
  }
  return b.model();
}

// ------------------------------------------------------------------ docker-compose

const IMAGE_ICONS: [RegExp, string][] = [
  [/postgres|postgis|timescale/, "logos:postgresql"],
  [/mysql/, "logos:mysql"],
  [/mariadb/, "logos:mariadb"],
  [/mongo/, "logos:mongodb"],
  [/redis|valkey/, "logos:redis"],
  [/memcached/, "logos:memcached"],
  [/nginx/, "logos:nginx"],
  [/kafka|redpanda/, "logos:kafka"],
  [/rabbitmq/, "logos:rabbitmq"],
  [/elasticsearch/, "logos:elasticsearch"],
  [/opensearch/, "logos:opensearch"],
  [/cassandra/, "logos:cassandra"],
  [/clickhouse/, "logos:clickhouse"],
  [/grafana/, "logos:grafana"],
  [/prometheus/, "logos:prometheus"],
  [/vault/, "logos:vault"],
  [/consul/, "logos:consul"],
  [/jenkins/, "logos:jenkins"],
  [/node/, "logos:nodejs"],
  [/python/, "logos:python"],
  [/golang|\bgo\b/, "logos:go"],
  [/openjdk|temurin|java/, "logos:java"],
];
const DB_IMAGES = /postgres|mysql|mariadb|mongo|cassandra|clickhouse/;

export function composeToModel(src: string): DiagramModel {
  const doc = obj(parseYamlDocuments(src)[0]);
  const services = obj(doc.services);
  if (!Object.keys(services).length) throw new Error("No services found (a docker-compose file has a services: section)");
  const b = new Builder();
  const ids = new Map<string, string>();
  for (const [name, raw] of Object.entries(services)) {
    const s = obj(raw);
    const image = str(s.image).toLowerCase();
    const icon = IMAGE_ICONS.find(([re]) => re.test(image || name))?.[1] ?? (s.build ? "logos:docker" : "lucide:box");
    // The service name only: workflows and docs read it in sentences; the icon shows the image.
    ids.set(name, b.node({ id: b.id(name), kind: "generic.component", label: name, icon }));
  }
  const protocolOf = (name: string): Protocol | undefined => {
    const image = str(obj(services[name]).image).toLowerCase();
    return DB_IMAGES.test(image) ? "sql" : /redis|valkey|memcached/.test(image) ? "redis" : undefined;
  };
  const volumes = new Map<string, string>();
  for (const [name, raw] of Object.entries(services)) {
    const s = obj(raw);
    const self = ids.get(name)!;
    const deps = Array.isArray(s.depends_on) ? s.depends_on.map(str) : Object.keys(obj(s.depends_on));
    for (const d of [...deps, ...arr(s.links).map((l) => str(l).split(":")[0])]) b.edge(self, ids.get(d), protocolOf(d) ? { protocol: protocolOf(d) } : {});
    // Environment values that name another service (DATABASE_URL=postgres://db:5432/…) are calls to it.
    const env = Array.isArray(s.environment) ? s.environment.map(str) : Object.entries(obj(s.environment)).map(([k, v]) => `${k}=${str(v)}`);
    for (const e of env)
      for (const other of ids.keys())
        if (other !== name && new RegExp(`(^|[=/@:,])${other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([:/,]|$)`).test(e.split("=").slice(1).join("="))) b.edge(self, ids.get(other), protocolOf(other) ? { protocol: protocolOf(other) } : {});
    for (const v of arr(s.volumes)) {
      const source = typeof v === "string" ? v.split(":")[0] : str(obj(v).source);
      // Named volumes only (not ./host/paths).
      if (!source || /^[./~]/.test(source) || !(source in obj(doc.volumes))) continue;
      if (!volumes.has(source)) volumes.set(source, b.node({ id: b.id(`vol_${source}`), kind: "generic.component", label: `${source}\nvolume`, icon: "lucide:hard-drive" }));
      b.edge(self, volumes.get(source), { protocol: "storage" });
    }
  }
  return b.model();
}

// ------------------------------------------------------------------ any source

/** Which importer a file needs, from its name and content. */
export function detectSource(fileName: string, text: string): SourceKind | null {
  const name = fileName.toLowerCase();
  if (/\.arch$/.test(name) || /^\s*\/\/ ArchCanvas diagram code/.test(text)) return "arch";
  if (/\.tf$|\.tf\.json$/.test(name) || /^\s*(resource|module|provider|terraform)\s+("|\{)/m.test(text)) return "terraform";
  if (/\.sql$/.test(name) || /\bcreate\s+table\b/i.test(text)) return "sql";
  if (/\.(ya?ml)$/.test(name) || /^\s*(services|apiVersion|kind):/m.test(text)) {
    if (/(^|\/)(docker-)?compose[^/]*\.ya?ml$/.test(name) || /^services:\s*$/m.test(text)) return "compose";
    if (/^\s*apiVersion:/m.test(text) && /^\s*kind:/m.test(text)) return "kubernetes";
    if (/^services:/m.test(text)) return "compose";
  }
  return null;
}

export const SOURCE_NAMES: Record<SourceKind, string> = { arch: "ArchCanvas diagram code", terraform: "Terraform", kubernetes: "Kubernetes manifests", compose: "docker-compose", sql: "SQL schema" };

/** A diagram from infrastructure code or a schema. Throws with a readable message when it can't. */
export function importSource(fileName: string, text: string, kind = detectSource(fileName, text)): DiagramModel {
  switch (kind) {
    case "arch": {
      const r = parseCode(text);
      if (!r.ok) throw new Error(`${fileName}: ${r.errors.slice(0, 3).map((e) => `line ${e.line}: ${e.message}`).join("; ")}`);
      return r.model;
    }
    case "terraform":
      return terraformToModel(text);
    case "kubernetes":
      return kubernetesToModel(text);
    case "compose":
      return composeToModel(text);
    case "sql":
      return sqlToModel(text);
    default:
      throw new Error(`${fileName}: not a file ArchCanvas can read. Use Terraform (.tf), Kubernetes or docker-compose YAML, SQL (.sql), or draw.io.`);
  }
}

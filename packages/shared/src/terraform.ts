import { catalogEntry, resolvedProps } from "./catalog.js";
import { attr, block, comment, type Block, ex, type Item, nested, renderBlocks, type Val } from "./hcl.js";
import { type DiagramEdge, type DiagramModel, type DiagramNode, nearestAncestor, nodeById } from "./model.js";

/**
 * Deterministic diagram → Terraform compiler (google provider). The same model always gives
 * the same files. Edges carry meaning: a Cloud Run → Cloud SQL edge becomes IAM database
 * auth plus the Cloud SQL volume; a load balancer → Cloud Run edge becomes a serverless NEG
 * backend; and so on. Anything without a mapping is reported as a warning, never guessed.
 */
export interface TerraformFile {
  path: string;
  content: string;
}

export interface TerraformOutput {
  files: TerraformFile[];
  warnings: { nodeId?: string; message: string }[];
  /** Resource addresses, e.g. google_cloud_run_v2_service.api */
  resources: string[];
}

export const GOOGLE_PROVIDER_VERSION = "~> 6.0";
const DEFAULT_REGION = "us-central1";

const STORE_KINDS = new Set(["gcp.cloud_sql", "gcp.gcs_bucket", "gcp.secret", "gcp.memorystore_redis"]);

export function compileTerraform(model: DiagramModel): TerraformOutput {
  return new Compiler(model).run();
}

/** GCP resource name for a node: snake_case id → kebab-case. */
export const gcpName = (n: DiagramNode) => n.id.replace(/_/g, "-");

function serviceAccountId(n: DiagramNode): string {
  let base = gcpName(n).slice(0, 26).replace(/-+$/, "");
  if (base.length < 3) base = `svc-${base}`;
  return `${base}-sa`;
}

const envName = (n: DiagramNode, suffix: string) => `${n.id.toUpperCase()}_${suffix}`;

class Compiler {
  private main: Item[] = [];
  private outputs: Block[] = [];
  private variables: Block[] = [];
  private apis = new Set<string>(["iam.googleapis.com"]);
  private warnings: TerraformOutput["warnings"] = [];
  private resources: string[] = [];
  /** Extra container settings for each Cloud Run service, filled in from its edges. */
  private runs = new Map<string, RunExtras>();
  private sqlIamUsers = new Map<string, boolean>();
  private psaVpcs = new Set<string>();

  constructor(private readonly m: DiagramModel) {}

  run(): TerraformOutput {
    for (const n of this.m.nodes) if (!catalogEntry(n.kind)) this.warn(n.id, `unknown kind ${n.kind}; skipped`);
    for (const n of this.nodes("gcp.cloud_run")) this.runs.set(n.id, { env: [], secretEnv: [], sql: [], fronted: false });
    for (const n of this.nodes("gcp.cloud_sql")) {
      const vpc = nearestAncestor(this.m, n.id, "gcp.vpc");
      if (vpc) this.psaVpcs.add(vpc.id);
    }

    // Edges first: they decide extra settings on the nodes they touch.
    const edgeItems: Item[] = [];
    for (const e of this.m.edges) edgeItems.push(...this.edge(e));

    const nodeItems: Item[] = [];
    for (const n of this.m.nodes) nodeItems.push(...this.node(n));

    this.main.push(this.apiBlock(), ...nodeItems);
    if (edgeItems.length) this.main.push(comment("---- Connections ----"), ...edgeItems);

    const files: TerraformFile[] = [
      { path: "versions.tf", content: this.versions() },
      { path: "providers.tf", content: this.providers() },
      { path: "variables.tf", content: renderBlocks(this.variableBlocks()) + "\n" },
      { path: "main.tf", content: header() + renderBlocks(this.main) + "\n" },
      { path: "outputs.tf", content: (this.outputs.length ? renderBlocks(this.outputs) : "# No outputs") + "\n" },
    ];
    return { files, warnings: this.warnings, resources: this.resources };
  }

  // ---------------------------------------------------------------- nodes

  private node(n: DiagramNode): Item[] {
    const p = resolvedProps(n.kind, n.props);
    switch (n.kind) {
      case "gcp.vpc":
        return this.vpc(n);
      case "gcp.subnet": {
        const vpc = nearestAncestor(this.m, n.id, "gcp.vpc");
        if (!vpc) {
          this.warn(n.id, "subnet is not inside a VPC; skipped");
          return [];
        }
        this.apis.add("compute.googleapis.com");
        return [
          this.res("google_compute_subnetwork", n.id, [
            ...attr("name", gcpName(n)),
            ...attr("region", this.regionOf(n)),
            ...attr("network", ex(`google_compute_network.${vpc.id}.id`)),
            ...attr("ip_cidr_range", String(p.cidr)),
            ...attr("private_ip_google_access", true),
          ], n),
        ];
      }
      case "gcp.cloud_run":
        return this.cloudRun(n, p);
      case "gcp.cloud_sql":
        return this.cloudSql(n, p);
      case "gcp.gcs_bucket": {
        this.apis.add("storage.googleapis.com");
        this.output(`${n.id}_bucket`, ex(`google_storage_bucket.${n.id}.name`));
        return [
          this.res("google_storage_bucket", n.id, [
            ...attr("name", ex(`"\${var.project_id}-${gcpName(n)}"`)),
            ...attr("location", this.regionOf(n)),
            ...attr("storage_class", String(p.storage_class)),
            ...attr("uniform_bucket_level_access", true),
            ...attr("public_access_prevention", "enforced"),
            nested("versioning", attr("enabled", Boolean(p.versioning))),
          ], n),
        ];
      }
      case "gcp.memorystore_redis": {
        this.apis.add("redis.googleapis.com");
        const vpc = nearestAncestor(this.m, n.id, "gcp.vpc");
        if (!vpc) this.warn(n.id, "Memorystore is not inside a VPC, so it attaches to the project's default network");
        this.output(`${n.id}_host`, ex(`google_redis_instance.${n.id}.host`));
        return [
          this.res("google_redis_instance", n.id, [
            ...attr("name", gcpName(n)),
            ...attr("region", this.regionOf(n)),
            ...attr("tier", String(p.tier)),
            ...attr("memory_size_gb", Number(p.memory_size_gb)),
            ...attr("connect_mode", "DIRECT_PEERING"),
            ...attr("authorized_network", vpc ? ex(`google_compute_network.${vpc.id}.id`) : undefined),
          ], n),
        ];
      }
      case "gcp.pubsub_topic":
        this.apis.add("pubsub.googleapis.com");
        return [this.res("google_pubsub_topic", n.id, attr("name", gcpName(n)), n)];
      case "gcp.secret":
        this.apis.add("secretmanager.googleapis.com");
        this.warn(n.id, `add a value to secret "${gcpName(n)}" (a secret version) before services that read it start`);
        return [
          this.res("google_secret_manager_secret", n.id, [
            ...attr("secret_id", gcpName(n)),
            nested("replication", [nested("auto", [])]),
          ], n),
        ];
      case "gcp.artifact_registry":
        this.apis.add("artifactregistry.googleapis.com");
        this.output(
          `${n.id}_repository`,
          ex(`"\${google_artifact_registry_repository.${n.id}.location}-docker.pkg.dev/\${var.project_id}/\${google_artifact_registry_repository.${n.id}.repository_id}"`),
        );
        return [
          this.res("google_artifact_registry_repository", n.id, [
            ...attr("repository_id", gcpName(n)),
            ...attr("location", this.regionOf(n)),
            ...attr("format", "DOCKER"),
          ], n),
        ];
      case "gcp.load_balancer":
        return this.loadBalancer(n, p);
      default:
        return []; // groups and external actors are not provisioned
    }
  }

  private vpc(n: DiagramNode): Item[] {
    this.apis.add("compute.googleapis.com");
    const items: Item[] = [
      this.res("google_compute_network", n.id, [
        ...attr("name", gcpName(n)),
        ...attr("auto_create_subnetworks", false),
      ], n),
    ];
    if (this.psaVpcs.has(n.id)) {
      // Private service access, so Cloud SQL gets a private IP in this network.
      this.apis.add("servicenetworking.googleapis.com");
      items.push(
        this.res("google_compute_global_address", `${n.id}_psa`, [
          ...attr("name", `${gcpName(n)}-psa`),
          ...attr("purpose", "VPC_PEERING"),
          ...attr("address_type", "INTERNAL"),
          ...attr("prefix_length", 16),
          ...attr("network", ex(`google_compute_network.${n.id}.id`)),
        ]),
        this.res("google_service_networking_connection", `${n.id}_psa`, [
          ...attr("network", ex(`google_compute_network.${n.id}.id`)),
          ...attr("service", "servicenetworking.googleapis.com"),
          ...attr("reserved_peering_ranges", [ex(`google_compute_global_address.${n.id}_psa.name`)]),
        ]),
      );
    }
    return items;
  }

  private cloudRun(n: DiagramNode, p: Record<string, string | number | boolean>): Item[] {
    this.apis.add("run.googleapis.com");
    const x = this.runs.get(n.id)!;
    const imageVar = `${n.id}_image`;
    this.variables.push(
      block("variable", [imageVar], [
        ...attr("description", `Container image for ${n.label}`),
        ...attr("type", ex("string")),
        ...attr("default", String(p.image)),
      ]),
    );

    const container: Item[] = [
      ...attr("image", ex(`var.${imageVar}`)),
      nested("resources", attr("limits", { cpu: String(p.cpu), memory: String(p.memory) })),
    ];
    for (const e of x.env) container.push(nested("env", [...attr("name", e.name), ...attr("value", e.value)]));
    for (const s of x.secretEnv)
      container.push(
        nested("env", [
          ...attr("name", s.name),
          nested("value_source", [
            nested("secret_key_ref", [
              ...attr("secret", ex(`google_secret_manager_secret.${s.secret}.secret_id`)),
              ...attr("version", "latest"),
            ]),
          ]),
        ]),
      );
    if (x.sql.length) container.push(nested("volume_mounts", [...attr("name", "cloudsql"), ...attr("mount_path", "/cloudsql")]));

    const template: Item[] = [
      ...attr("service_account", ex(`google_service_account.${n.id}.email`)),
      nested("scaling", [
        ...attr("min_instance_count", Number(p.min_instances)),
        ...attr("max_instance_count", Number(p.max_instances)),
      ]),
      nested("containers", container),
    ];
    if (x.sql.length)
      template.push(
        nested("volumes", [
          ...attr("name", "cloudsql"),
          nested("cloud_sql_instance", attr("instances", x.sql.map((s) => ex(`google_sql_database_instance.${s}.connection_name`)))),
        ]),
      );
    const subnet = nearestAncestor(this.m, n.id, "gcp.subnet");
    if (subnet) {
      const vpc = nearestAncestor(this.m, subnet.id, "gcp.vpc")!;
      template.push(
        nested("vpc_access", [
          ...attr("egress", "PRIVATE_RANGES_ONLY"),
          nested("network_interfaces", [
            ...attr("network", ex(`google_compute_network.${vpc.id}.id`)),
            ...attr("subnetwork", ex(`google_compute_subnetwork.${subnet.id}.id`)),
          ]),
        ]),
      );
    }

    const items: Item[] = [
      this.res("google_service_account", n.id, [
        ...attr("account_id", serviceAccountId(n)),
        ...attr("display_name", `${n.label} (Cloud Run)`),
      ]),
      this.res("google_cloud_run_v2_service", n.id, [
        ...attr("name", gcpName(n)),
        ...attr("location", this.regionOf(n)),
        ...attr("ingress", x.fronted && !p.public ? "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" : "INGRESS_TRAFFIC_ALL"),
        nested("template", template),
      ], n),
    ];
    // A load balancer carries no credentials, so fronted services allow unauthenticated calls,
    // while ingress above restricts traffic to the load balancer.
    if (p.public || x.fronted)
      items.push(
        this.res("google_cloud_run_v2_service_iam_member", `${n.id}_public`, [
          ...attr("name", ex(`google_cloud_run_v2_service.${n.id}.name`)),
          ...attr("location", ex(`google_cloud_run_v2_service.${n.id}.location`)),
          ...attr("role", "roles/run.invoker"),
          ...attr("member", "allUsers"),
        ]),
      );
    this.output(`${n.id}_url`, ex(`google_cloud_run_v2_service.${n.id}.uri`));
    return items;
  }

  private cloudSql(n: DiagramNode, p: Record<string, string | number | boolean>): Item[] {
    this.apis.add("sqladmin.googleapis.com");
    const vpc = nearestAncestor(this.m, n.id, "gcp.vpc");
    const postgres = String(p.database_version).startsWith("POSTGRES");
    const settings: Item[] = [
      ...attr("tier", String(p.tier)),
      ...attr("availability_type", p.high_availability ? "REGIONAL" : "ZONAL"),
      nested("ip_configuration", [
        ...attr("ipv4_enabled", !vpc),
        ...attr("private_network", vpc ? ex(`google_compute_network.${vpc.id}.id`) : undefined),
        ...attr("ssl_mode", "ENCRYPTED_ONLY"),
      ]),
      nested("backup_configuration", [
        ...attr("enabled", true),
        ...(postgres ? attr("point_in_time_recovery_enabled", true) : attr("binary_log_enabled", true)),
      ]),
    ];
    if (this.sqlIamUsers.has(n.id))
      settings.push(
        nested("database_flags", [
          ...attr("name", postgres ? "cloudsql.iam_authentication" : "cloudsql_iam_authentication"),
          ...attr("value", "on"),
        ]),
      );
    if (!vpc) this.warn(n.id, "Cloud SQL is outside a VPC, so it gets a public IP (SSL only, no authorized networks)");

    const instance = this.res("google_sql_database_instance", n.id, [
      ...attr("name", gcpName(n)),
      ...attr("region", this.regionOf(n)),
      ...attr("database_version", String(p.database_version)),
      ...attr("deletion_protection", Boolean(p.deletion_protection)),
      nested("settings", settings),
    ], n, vpc ? [`google_service_networking_connection.${vpc.id}_psa`] : []);
    this.output(`${n.id}_connection_name`, ex(`google_sql_database_instance.${n.id}.connection_name`));
    return [
      instance,
      this.res("google_sql_database", n.id, [
        ...attr("name", String(p.database_name)),
        ...attr("instance", ex(`google_sql_database_instance.${n.id}.name`)),
      ]),
    ];
  }

  private loadBalancer(n: DiagramNode, p: Record<string, string | number | boolean>): Item[] {
    this.apis.add("compute.googleapis.com");
    const backends = this.m.edges
      .filter((e) => e.from === n.id)
      .map((e) => nodeById(this.m, e.to)!)
      .filter((t) => t?.kind === "gcp.cloud_run");
    if (!backends.length) {
      this.warn(n.id, "load balancer has no Cloud Run backends; connect it to a service");
      return [];
    }
    const name = gcpName(n);
    const items: Item[] = [];
    if (p.cloud_armor)
      items.push(
        this.res("google_compute_security_policy", n.id, [
          ...attr("name", `${name}-armor`),
          nested("rule", [
            ...attr("action", "deny(403)"),
            ...attr("priority", 1000),
            ...attr("description", "OWASP: SQL injection and XSS"),
            nested("match", [
              nested("expr", attr("expression", "evaluatePreconfiguredWaf('sqli-v33-stable') || evaluatePreconfiguredWaf('xss-v33-stable')")),
            ]),
          ]),
          nested("rule", [
            ...attr("action", "allow"),
            ...attr("priority", 2147483647),
            ...attr("description", "Default allow"),
            nested("match", [
              ...attr("versioned_expr", "SRC_IPS_V1"),
              nested("config", attr("src_ip_ranges", ["*"])),
            ]),
          ]),
        ]),
      );
    for (const b of backends) {
      const key = `${n.id}_${b.id}`;
      items.push(
        this.res("google_compute_region_network_endpoint_group", key, [
          ...attr("name", `${name}-${gcpName(b)}-neg`.slice(0, 63)),
          ...attr("region", this.regionOf(b)),
          ...attr("network_endpoint_type", "SERVERLESS"),
          nested("cloud_run", attr("service", ex(`google_cloud_run_v2_service.${b.id}.name`))),
        ]),
        this.res("google_compute_backend_service", key, [
          ...attr("name", `${name}-${gcpName(b)}`.slice(0, 63)),
          ...attr("load_balancing_scheme", "EXTERNAL_MANAGED"),
          ...attr("protocol", "HTTPS"),
          ...attr("security_policy", p.cloud_armor ? ex(`google_compute_security_policy.${n.id}.id`) : undefined),
          nested("backend", attr("group", ex(`google_compute_region_network_endpoint_group.${key}.id`))),
        ]),
      );
    }
    const svc = (b: DiagramNode) => ex(`google_compute_backend_service.${n.id}_${b.id}.id`);
    const urlMap: Item[] = [...attr("name", name), ...attr("default_service", svc(backends[0]))];
    if (backends.length > 1) {
      urlMap.push(
        nested("host_rule", [...attr("hosts", ["*"]), ...attr("path_matcher", "routes")]),
        nested("path_matcher", [
          ...attr("name", "routes"),
          ...attr("default_service", svc(backends[0])),
          ...backends.slice(1).map((b) =>
            nested("path_rule", [...attr("paths", [`/${gcpName(b)}`, `/${gcpName(b)}/*`]), ...attr("service", svc(b))]),
          ),
        ]),
      );
      this.warn(n.id, `routes /${backends.slice(1).map(gcpName).join(", /")} by path; everything else goes to ${backends[0].label}`);
    }
    items.push(
      this.res("google_compute_url_map", n.id, urlMap),
      this.res("google_compute_global_address", n.id, attr("name", `${name}-ip`)),
    );
    const domain = String(p.domain ?? "").trim();
    if (domain) {
      items.push(
        this.res("google_compute_managed_ssl_certificate", n.id, [
          ...attr("name", `${name}-cert`),
          nested("managed", attr("domains", [domain])),
        ]),
        this.res("google_compute_target_https_proxy", n.id, [
          ...attr("name", `${name}-https`),
          ...attr("url_map", ex(`google_compute_url_map.${n.id}.id`)),
          ...attr("ssl_certificates", [ex(`google_compute_managed_ssl_certificate.${n.id}.id`)]),
        ]),
        this.res("google_compute_global_forwarding_rule", n.id, [
          ...attr("name", `${name}-https`),
          ...attr("target", ex(`google_compute_target_https_proxy.${n.id}.id`)),
          ...attr("ip_address", ex(`google_compute_global_address.${n.id}.id`)),
          ...attr("port_range", "443"),
          ...attr("load_balancing_scheme", "EXTERNAL_MANAGED"),
        ]),
      );
    } else {
      this.warn(n.id, "no domain set, so the load balancer serves plain HTTP; set a domain for a managed certificate");
      items.push(
        this.res("google_compute_target_http_proxy", n.id, [
          ...attr("name", `${name}-http`),
          ...attr("url_map", ex(`google_compute_url_map.${n.id}.id`)),
        ]),
        this.res("google_compute_global_forwarding_rule", n.id, [
          ...attr("name", `${name}-http`),
          ...attr("target", ex(`google_compute_target_http_proxy.${n.id}.id`)),
          ...attr("ip_address", ex(`google_compute_global_address.${n.id}.id`)),
          ...attr("port_range", "80"),
          ...attr("load_balancing_scheme", "EXTERNAL_MANAGED"),
        ]),
      );
    }
    this.output(`${n.id}_ip`, ex(`google_compute_global_address.${n.id}.address`));
    return items;
  }

  // ---------------------------------------------------------------- edges

  private edge(e: DiagramEdge): Item[] {
    const from = nodeById(this.m, e.from);
    const to = nodeById(this.m, e.to);
    if (!from || !to) return [];
    if (from.kind === "generic.client" || to.kind === "generic.client") return [];

    // Cloud Run ↔ data store: access is granted whichever way the arrow was drawn.
    if (from.kind === "gcp.cloud_run" && STORE_KINDS.has(to.kind)) return this.runToStore(from, to);
    if (to.kind === "gcp.cloud_run" && STORE_KINDS.has(from.kind)) return this.runToStore(to, from);

    if (from.kind === "gcp.cloud_run" && to.kind === "gcp.cloud_run") {
      this.runs.get(from.id)!.env.push({ name: envName(to, "URL"), value: ex(`google_cloud_run_v2_service.${to.id}.uri`) });
      return [
        this.res("google_cloud_run_v2_service_iam_member", `${from.id}_invokes_${to.id}`, [
          ...attr("name", ex(`google_cloud_run_v2_service.${to.id}.name`)),
          ...attr("location", ex(`google_cloud_run_v2_service.${to.id}.location`)),
          ...attr("role", "roles/run.invoker"),
          ...attr("member", saMember(from)),
        ]),
      ];
    }
    if (from.kind === "gcp.cloud_run" && to.kind === "gcp.pubsub_topic") {
      this.runs.get(from.id)!.env.push({ name: envName(to, "TOPIC"), value: ex(`google_pubsub_topic.${to.id}.id`) });
      return [
        this.res("google_pubsub_topic_iam_member", `${from.id}_publishes_${to.id}`, [
          ...attr("topic", ex(`google_pubsub_topic.${to.id}.name`)),
          ...attr("role", "roles/pubsub.publisher"),
          ...attr("member", saMember(from)),
        ]),
      ];
    }
    if (from.kind === "gcp.pubsub_topic" && to.kind === "gcp.cloud_run") return this.pushSubscription(from, to);
    if (from.kind === "gcp.load_balancer" && to.kind === "gcp.cloud_run") {
      this.runs.get(to.id)!.fronted = true;
      return []; // backends are emitted with the load balancer
    }
    if (from.kind === "gcp.artifact_registry" || to.kind === "gcp.artifact_registry") return [];

    this.warn(undefined, `connection ${from.label} → ${to.label} has no Terraform mapping yet; it is documentation only`);
    return [];
  }

  private runToStore(run: DiagramNode, store: DiagramNode): Item[] {
    const x = this.runs.get(run.id)!;
    switch (store.kind) {
      case "gcp.cloud_sql": {
        this.sqlIamUsers.set(store.id, true);
        const postgres = String(resolvedProps(store.kind, store.props).database_version).startsWith("POSTGRES");
        x.sql.push(store.id);
        x.env.push(
          { name: envName(store, "INSTANCE"), value: ex(`google_sql_database_instance.${store.id}.connection_name`) },
          { name: envName(store, "DATABASE"), value: ex(`google_sql_database.${store.id}.name`) },
          { name: envName(store, "USER"), value: ex(`google_sql_user.${run.id}_${store.id}.name`) },
        );
        const key = `${run.id}_${store.id}`;
        return [
          this.res("google_project_iam_member", `${key}_client`, [
            ...attr("project", ex("var.project_id")),
            ...attr("role", "roles/cloudsql.client"),
            ...attr("member", saMember(run)),
          ]),
          this.res("google_project_iam_member", `${key}_instance_user`, [
            ...attr("project", ex("var.project_id")),
            ...attr("role", "roles/cloudsql.instanceUser"),
            ...attr("member", saMember(run)),
          ]),
          // IAM database authentication: no passwords to manage.
          this.res("google_sql_user", key, [
            ...attr(
              "name",
              postgres
                ? ex(`trimsuffix(google_service_account.${run.id}.email, ".gserviceaccount.com")`)
                : ex(`split("@", google_service_account.${run.id}.email)[0]`),
            ),
            ...attr("instance", ex(`google_sql_database_instance.${store.id}.name`)),
            ...attr("type", "CLOUD_IAM_SERVICE_ACCOUNT"),
          ]),
        ];
      }
      case "gcp.gcs_bucket":
        x.env.push({ name: envName(store, "BUCKET"), value: ex(`google_storage_bucket.${store.id}.name`) });
        return [
          this.res("google_storage_bucket_iam_member", `${run.id}_${store.id}`, [
            ...attr("bucket", ex(`google_storage_bucket.${store.id}.name`)),
            ...attr("role", "roles/storage.objectUser"),
            ...attr("member", saMember(run)),
          ]),
        ];
      case "gcp.secret":
        x.secretEnv.push({ name: store.id.toUpperCase(), secret: store.id });
        return [
          this.res("google_secret_manager_secret_iam_member", `${run.id}_${store.id}`, [
            ...attr("secret_id", ex(`google_secret_manager_secret.${store.id}.id`)),
            ...attr("role", "roles/secretmanager.secretAccessor"),
            ...attr("member", saMember(run)),
          ]),
        ];
      case "gcp.memorystore_redis":
        if (!nearestAncestor(this.m, run.id, "gcp.subnet"))
          this.warn(run.id, `${run.label} is not inside a subnet, so it cannot reach ${store.label}; move it into a subnet of the same VPC`);
        x.env.push(
          { name: envName(store, "HOST"), value: ex(`google_redis_instance.${store.id}.host`) },
          { name: envName(store, "PORT"), value: ex(`tostring(google_redis_instance.${store.id}.port)`) },
        );
        return [];
    }
    return [];
  }

  private pushSubscription(topic: DiagramNode, run: DiagramNode): Item[] {
    const key = `${topic.id}_to_${run.id}`;
    return [
      this.res("google_service_account", `${key}_push`, [
        ...attr("account_id", `${gcpName(topic).slice(0, 20).replace(/-+$/, "")}-push`.padStart(6, "p")),
        ...attr("display_name", `Pub/Sub push from ${topic.label} to ${run.label}`),
      ]),
      this.res("google_cloud_run_v2_service_iam_member", `${key}_invoker`, [
        ...attr("name", ex(`google_cloud_run_v2_service.${run.id}.name`)),
        ...attr("location", ex(`google_cloud_run_v2_service.${run.id}.location`)),
        ...attr("role", "roles/run.invoker"),
        ...attr("member", ex(`"serviceAccount:\${google_service_account.${key}_push.email}"`)),
      ]),
      this.res("google_pubsub_subscription", key, [
        ...attr("name", `${gcpName(topic)}-to-${gcpName(run)}`),
        ...attr("topic", ex(`google_pubsub_topic.${topic.id}.id`)),
        ...attr("ack_deadline_seconds", 60),
        nested("push_config", [
          ...attr("push_endpoint", ex(`google_cloud_run_v2_service.${run.id}.uri`)),
          nested("oidc_token", attr("service_account_email", ex(`google_service_account.${key}_push.email`))),
        ]),
      ]),
    ];
  }

  // ---------------------------------------------------------------- helpers

  private res(type: string, name: string, body: Item[], node?: DiagramNode, dependsOn: string[] = []): Block {
    this.resources.push(`${type}.${name}`);
    const head: Item[] = node ? [comment(node.label)] : [];
    const deps = ["google_project_service.apis", ...dependsOn];
    return block("resource", [type, name], [...head, ...body, ...attr("depends_on", deps.map((d) => ex(d)))]);
  }

  private nodes(kind: string) {
    return this.m.nodes.filter((n) => n.kind === kind);
  }

  private regionOf(n: DiagramNode): Val {
    const region = nearestAncestor(this.m, n.id, "gcp.region");
    return region ? String(resolvedProps(region.kind, region.props).region) : ex("var.region");
  }

  private output(name: string, value: Val): void {
    this.outputs.push(block("output", [name], attr("value", value)));
  }

  private warn(nodeId: string | undefined, message: string): void {
    this.warnings.push(nodeId ? { nodeId, message } : { message });
  }

  private apiBlock(): Block {
    return block("resource", ["google_project_service", "apis"], [
      comment("APIs used by this architecture"),
      ...attr("for_each", ex(`toset(${renderList([...this.apis].sort())})`)),
      ...attr("service", ex("each.value")),
      ...attr("disable_on_destroy", false),
    ]);
  }

  private variableBlocks(): Block[] {
    const firstRegion = this.m.nodes.find((n) => n.kind === "gcp.region");
    const region = firstRegion ? String(resolvedProps(firstRegion.kind, firstRegion.props).region) : DEFAULT_REGION;
    return [
      block("variable", ["project_id"], [
        ...attr("description", "Google Cloud project to deploy into"),
        ...attr("type", ex("string")),
      ]),
      block("variable", ["region"], [
        ...attr("description", "Default region for resources outside a region group"),
        ...attr("type", ex("string")),
        ...attr("default", region),
      ]),
      ...this.variables,
    ];
  }

  private versions(): string {
    return (
      renderBlocks([
        block("terraform", [], [
          ...attr("required_version", ">= 1.5"),
          nested("required_providers", attr("google", { source: "hashicorp/google", version: GOOGLE_PROVIDER_VERSION })),
        ]),
      ]) + "\n"
    );
  }

  private providers(): string {
    return (
      renderBlocks([
        block("provider", ["google"], [...attr("project", ex("var.project_id")), ...attr("region", ex("var.region"))]),
      ]) + "\n"
    );
  }
}

interface RunExtras {
  env: { name: string; value: Val }[];
  secretEnv: { name: string; secret: string }[];
  sql: string[];
  fronted: boolean;
}

const saMember = (n: DiagramNode) => ex(`"serviceAccount:\${google_service_account.${n.id}.email}"`);
const renderList = (xs: string[]) => `[\n${xs.map((x) => `    ${JSON.stringify(x)},`).join("\n")}\n  ]`;
const header = () => "# Generated by ArchCanvas from the architecture diagram. Edit the diagram, not this file.\n\n";

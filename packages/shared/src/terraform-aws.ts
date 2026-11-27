import { attr, block, type Block, comment, ex, type Item, nested, renderBlocks, renderVal, type Val } from "./hcl.js";
import { ancestorsOf, type DiagramEdge, type DiagramModel, type DiagramNode } from "./model.js";

/**
 * AWS Terraform from the diagram (aws provider). AWS items are icon items (AWS Lambda, S3,
 * RDS…) and AWS boxes (VPC, subnets), so they're recognised by their icon. As with Google
 * Cloud, the same diagram always gives the same files, defaults are secure (encrypted,
 * private, least privilege), and connections carry meaning: Lambda → DynamoDB becomes an IAM
 * policy and a TABLE_NAME variable, SQS → Lambda an event source mapping, ECS → RDS a
 * security-group rule, and so on. Anything without a mapping is reported, never guessed.
 */

export type AwsService =
  | "lambda"
  | "s3"
  | "rds"
  | "dynamodb"
  | "sqs"
  | "sns"
  | "elasticache"
  | "secret"
  | "ecr"
  | "ecs"
  | "alb"
  | "apigw"
  | "cloudfront"
  | "cognito"
  | "ec2"
  | "kinesis";

const ICONS: [RegExp, AwsService][] = [
  [/^aws:AWSLambda/, "lambda"],
  [/^aws:AmazonSimpleStorageService/, "s3"],
  [/^aws:(AmazonRDS|AmazonAurora)/, "rds"],
  [/^aws:AmazonDynamoDB$/, "dynamodb"],
  [/^aws:AmazonSimpleQueueService/, "sqs"],
  [/^aws:AmazonSimpleNotificationService/, "sns"],
  [/^aws:AmazonElastiCache/, "elasticache"],
  [/^aws:AWSSecretsManager/, "secret"],
  [/^aws:AmazonElasticContainerRegistry/, "ecr"],
  [/^aws:(AmazonElasticContainerService|AWSFargate)/, "ecs"],
  [/^aws:ElasticLoadBalancing/, "alb"],
  [/^aws:AmazonAPIGateway/, "apigw"],
  [/^aws:AmazonCloudFront$/, "cloudfront"],
  [/^aws:AmazonCognito/, "cognito"],
  [/^aws:AmazonEC2$/, "ec2"],
  [/^aws:AmazonKinesisDataStreams/, "kinesis"],
];

export function awsServiceOf(n: DiagramNode): AwsService | undefined {
  if (n.kind !== "generic.component" || !n.icon) return undefined;
  return ICONS.find(([re]) => re.test(n.icon!))?.[1];
}
const isVpc = (n: DiagramNode) => n.kind === "generic.group" && n.icon === "aws:VirtualprivatecloudVPC";
const isSubnet = (n: DiagramNode) => n.kind === "generic.group" && /^aws:(Public|Private)subnet$/.test(n.icon ?? "");
const isPublicSubnet = (n: DiagramNode) => isSubnet(n) && (n.icon === "aws:Publicsubnet" || /public/i.test(n.label));
const AWS_REGION = /\b([a-z]{2}(?:-gov)?-[a-z]+-\d)\b/;
const CIDR = /\b(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})\b/;

/** True when the diagram has anything the AWS compiler turns into Terraform. */
export function hasAws(m: DiagramModel): boolean {
  return m.nodes.some((n) => awsServiceOf(n) || isVpc(n));
}

export const AWS_PROVIDER_VERSION = "~> 5.0";

const COMPUTE = new Set<AwsService>(["lambda", "ecs", "ec2"]);
const PORTS: Partial<Record<AwsService, number>> = { rds: 5432, elasticache: 6379 };

export interface AwsTerraform {
  files: { path: string; content: string }[];
  warnings: { nodeId?: string; message: string }[];
  resources: string[];
}

export function compileAwsTerraform(m: DiagramModel, dir = "aws"): AwsTerraform | null {
  if (!hasAws(m)) return null;
  return new AwsCompiler(m, dir).run();
}

interface Caller {
  statements: { Effect: string; Action: string[]; Resource: Val[] }[];
  env: Record<string, Val>;
}

class AwsCompiler {
  private main: Item[] = [];
  private outputs: Block[] = [];
  private vars: Block[] = [];
  private warnings: AwsTerraform["warnings"] = [];
  private resources: string[] = [];
  private callers = new Map<string, Caller>();
  private sgRules: Item[] = [];
  private needsAzs = false;
  private needsCluster = false;
  private needsAmi = false;
  private svc = new Map<string, AwsService>();

  constructor(
    private readonly m: DiagramModel,
    private readonly dir: string,
  ) {
    for (const n of m.nodes) {
      const s = awsServiceOf(n);
      if (s) this.svc.set(n.id, s);
    }
  }

  run(): AwsTerraform {
    const vpcItems = this.m.nodes.filter(isVpc).flatMap((v) => this.vpc(v));
    for (const n of this.m.nodes) if (COMPUTE.has(this.svc.get(n.id)!)) this.callers.set(n.id, { statements: [], env: {} });
    const edgeItems = this.m.edges.flatMap((e) => this.edge(e));
    const nodeItems = this.m.nodes.flatMap((n) => this.node(n));
    if (this.needsCluster)
      nodeItems.unshift(
        this.res("aws_ecs_cluster", "main", [...attr("name", ex(`"\${var.name}"`)), nested("setting", [...attr("name", "containerInsights"), ...attr("value", "enabled")])]),
      );
    const data: Item[] = [];
    if (this.needsAzs) data.push(block("data", ["aws_availability_zones", "available"], attr("state", "available")));
    if (this.needsAmi) data.push(block("data", ["aws_ssm_parameter", "al2023"], attr("name", "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64")));
    this.main.push(...data, ...vpcItems, ...nodeItems);
    if (edgeItems.length || this.sgRules.length) this.main.push(comment("---- Connections ----"), ...edgeItems, ...this.sgRules);
    const region = this.m.nodes.map((n) => (n.kind === "generic.group" && n.icon === "aws:Region" ? AWS_REGION.exec(n.label)?.[1] : undefined)).find(Boolean) ?? "us-east-1";
    this.vars.unshift(
      block("variable", ["region"], [...attr("type", ex("string")), ...attr("default", region), ...attr("description", "AWS region")]),
      block("variable", ["name"], [...attr("type", ex("string")), ...attr("default", "archcanvas"), ...attr("description", "Prefix for resource names")]),
    );
    const p = (f: string) => (this.dir ? `${this.dir}/${f}` : f);
    return {
      files: [
        {
          path: p("versions.tf"),
          content:
            renderBlocks([
              block("terraform", [], [...attr("required_version", ">= 1.5"), nested("required_providers", attr("aws", { source: "hashicorp/aws", version: AWS_PROVIDER_VERSION }))]),
            ]) + "\n",
        },
        {
          path: p("providers.tf"),
          content:
            renderBlocks([
              block("provider", ["aws"], [...attr("region", ex("var.region")), nested("default_tags", attr("tags", { ManagedBy: "terraform", GeneratedBy: "archcanvas" }))]),
            ]) + "\n",
        },
        { path: p("variables.tf"), content: renderBlocks(this.vars) + "\n" },
        { path: p("main.tf"), content: "# Generated by ArchCanvas from the AWS parts of the diagram. Edit the diagram, not this file.\n\n" + renderBlocks(this.main) + "\n" },
        { path: p("outputs.tf"), content: (this.outputs.length ? renderBlocks(this.outputs) : "# No outputs") + "\n" },
      ],
      warnings: this.warnings,
      resources: this.resources,
    };
  }

  // ---------------------------------------------------------------- network

  private vpc(v: DiagramNode): Item[] {
    const cidr = CIDR.exec(v.label)?.[1] ?? (typeof v.props.cidr === "string" ? v.props.cidr : "10.0.0.0/16");
    const items: Item[] = [
      this.res("aws_vpc", v.id, [...attr("cidr_block", cidr), ...attr("enable_dns_support", true), ...attr("enable_dns_hostnames", true), this.tags(v)], v),
    ];
    const subnets = this.subnetsIn(v);
    subnets.forEach((s, i) => {
      this.needsAzs = true;
      const sc = CIDR.exec(s.label)?.[1];
      items.push(
        this.res("aws_subnet", s.id, [
          ...attr("vpc_id", ex(`aws_vpc.${v.id}.id`)),
          ...attr("cidr_block", sc ?? ex(`cidrsubnet(aws_vpc.${v.id}.cidr_block, 8, ${i + 1})`)),
          ...attr("availability_zone", ex(`data.aws_availability_zones.available.names[${i} % length(data.aws_availability_zones.available.names)]`)),
          ...attr("map_public_ip_on_launch", isPublicSubnet(s)),
          this.tags(s),
        ], s),
      );
    });
    if (subnets.some(isPublicSubnet)) {
      items.push(
        this.res("aws_internet_gateway", v.id, [...attr("vpc_id", ex(`aws_vpc.${v.id}.id`))]),
        this.res("aws_route_table", `${v.id}_public`, [
          ...attr("vpc_id", ex(`aws_vpc.${v.id}.id`)),
          nested("route", [...attr("cidr_block", "0.0.0.0/0"), ...attr("gateway_id", ex(`aws_internet_gateway.${v.id}.id`))]),
        ]),
        ...subnets.filter(isPublicSubnet).map((s) => this.res("aws_route_table_association", s.id, [...attr("subnet_id", ex(`aws_subnet.${s.id}.id`)), ...attr("route_table_id", ex(`aws_route_table.${v.id}_public.id`))])),
      );
      if (subnets.some((s) => !isPublicSubnet(s))) this.warn(v.id, "private subnets have no NAT gateway: add one if their services need to reach the internet");
    }
    return items;
  }

  private subnetsIn(v: DiagramNode): DiagramNode[] {
    return this.m.nodes.filter((n) => isSubnet(n) && ancestorsOf(this.m, n.id).some((a) => a.id === v.id));
  }
  private vpcOf(n: DiagramNode): DiagramNode | undefined {
    return ancestorsOf(this.m, n.id).find(isVpc);
  }
  private subnetOf(n: DiagramNode): DiagramNode | undefined {
    return ancestorsOf(this.m, n.id).find(isSubnet);
  }
  /** Subnets for a service that needs several availability zones (RDS, ElastiCache, ALB): its own, then its VPC's others of the same kind. */
  private subnetsFor(n: DiagramNode, publicOnes: boolean): Val[] | undefined {
    const vpc = this.vpcOf(n);
    if (!vpc) return undefined;
    const own = this.subnetOf(n);
    const all = this.subnetsIn(vpc).filter((s) => isPublicSubnet(s) === publicOnes);
    const list = own ? [own, ...all.filter((s) => s.id !== own.id)] : all;
    if (list.length < 2) this.warn(n.id, `${n.label || n.id} needs subnets in at least two availability zones: add another ${publicOnes ? "public" : "private"} subnet to the VPC`);
    return list.length ? list.map((s) => ex(`aws_subnet.${s.id}.id`)) : undefined;
  }

  /** A security group for something in a VPC (created on first use). */
  private sgs = new Set<string>();
  private sg(n: DiagramNode): string | undefined {
    const vpc = this.vpcOf(n);
    if (!vpc) return undefined;
    if (!this.sgs.has(n.id)) {
      this.sgs.add(n.id);
      this.main.push(
        this.res("aws_security_group", n.id, [
          ...attr("name", ex(`"\${var.name}-${n.id.replace(/_/g, "-")}"`)),
          ...attr("description", `${n.label || n.id}`.replace(/[^\x20-\x7e]/g, "").slice(0, 200) || n.id),
          ...attr("vpc_id", ex(`aws_vpc.${vpc.id}.id`)),
          nested("egress", [...attr("from_port", 0), ...attr("to_port", 0), ...attr("protocol", "-1"), ...attr("cidr_blocks", ["0.0.0.0/0"])]),
        ]),
      );
    }
    return `aws_security_group.${n.id}.id`;
  }

  // ---------------------------------------------------------------- services

  private node(n: DiagramNode): Item[] {
    const s = this.svc.get(n.id);
    const name = (suffix = "") => ex(`"\${var.name}-${n.id.replace(/_/g, "-")}${suffix}"`);
    switch (s) {
      case undefined:
        return [];
      case "s3":
        this.output(`${n.id}_bucket`, ex(`aws_s3_bucket.${n.id}.bucket`));
        return [
          this.res("aws_s3_bucket", n.id, [...attr("bucket_prefix", ex(`"\${var.name}-${n.id.replace(/_/g, "-").slice(0, 20)}-"`)), this.tags(n)], n),
          this.res("aws_s3_bucket_public_access_block", n.id, [
            ...attr("bucket", ex(`aws_s3_bucket.${n.id}.id`)),
            ...attr("block_public_acls", true),
            ...attr("block_public_policy", true),
            ...attr("ignore_public_acls", true),
            ...attr("restrict_public_buckets", true),
          ]),
          this.res("aws_s3_bucket_versioning", n.id, [...attr("bucket", ex(`aws_s3_bucket.${n.id}.id`)), nested("versioning_configuration", attr("status", "Enabled"))]),
          this.res("aws_s3_bucket_server_side_encryption_configuration", n.id, [
            ...attr("bucket", ex(`aws_s3_bucket.${n.id}.id`)),
            nested("rule", [nested("apply_server_side_encryption_by_default", attr("sse_algorithm", "AES256"))]),
          ]),
        ];
      case "dynamodb":
        return [
          this.res("aws_dynamodb_table", n.id, [
            ...attr("name", name()),
            ...attr("billing_mode", "PAY_PER_REQUEST"),
            ...attr("hash_key", "pk"),
            ...attr("range_key", "sk"),
            nested("attribute", [...attr("name", "pk"), ...attr("type", "S")]),
            nested("attribute", [...attr("name", "sk"), ...attr("type", "S")]),
            nested("point_in_time_recovery", attr("enabled", true)),
            nested("server_side_encryption", attr("enabled", true)),
            this.tags(n),
          ], n),
        ];
      case "sqs":
        return [
          this.res("aws_sqs_queue", `${n.id}_dlq`, [...attr("name", name("-dlq")), ...attr("sqs_managed_sse_enabled", true), ...attr("message_retention_seconds", 1209600)]),
          this.res("aws_sqs_queue", n.id, [
            ...attr("name", name()),
            ...attr("sqs_managed_sse_enabled", true),
            ...attr("visibility_timeout_seconds", 60),
            ...attr("redrive_policy", ex(`jsonencode({ deadLetterTargetArn = aws_sqs_queue.${n.id}_dlq.arn, maxReceiveCount = 5 })`)),
            this.tags(n),
          ], n),
        ];
      case "sns":
        return [this.res("aws_sns_topic", n.id, [...attr("name", name()), ...attr("kms_master_key_id", "alias/aws/sns"), this.tags(n)], n)];
      case "secret":
        return [this.res("aws_secretsmanager_secret", n.id, [...attr("name_prefix", ex(`"\${var.name}-${n.id.replace(/_/g, "-")}-"`)), ...attr("recovery_window_in_days", 7), this.tags(n)], n)];
      case "ecr":
        return [
          this.res("aws_ecr_repository", n.id, [
            ...attr("name", name()),
            ...attr("image_tag_mutability", "IMMUTABLE"),
            nested("image_scanning_configuration", attr("scan_on_push", true)),
            nested("encryption_configuration", attr("encryption_type", "AES256")),
          ], n),
        ];
      case "kinesis":
        return [this.res("aws_kinesis_stream", n.id, [...attr("name", name()), ...attr("encryption_type", "KMS"), ...attr("kms_key_id", "alias/aws/kinesis"), nested("stream_mode_details", attr("stream_mode", "ON_DEMAND"))], n)];
      case "cognito":
        this.output(`${n.id}_user_pool_id`, ex(`aws_cognito_user_pool.${n.id}.id`));
        return [
          this.res("aws_cognito_user_pool", n.id, [
            ...attr("name", name()),
            ...attr("mfa_configuration", "OPTIONAL"),
            nested("software_token_mfa_configuration", attr("enabled", true)),
            nested("password_policy", [...attr("minimum_length", 12), ...attr("require_symbols", true), ...attr("require_numbers", true)]),
          ], n),
          this.res("aws_cognito_user_pool_client", n.id, [...attr("name", name("-client")), ...attr("user_pool_id", ex(`aws_cognito_user_pool.${n.id}.id`)), ...attr("generate_secret", false)]),
        ];
      case "rds": {
        const subnets = this.subnetsFor(n, false);
        const sg = this.sg(n);
        if (!subnets) this.warn(n.id, `${n.label || n.id} isn't inside a VPC; put it in a private subnet so it gets a private address`);
        this.output(`${n.id}_endpoint`, ex(`aws_db_instance.${n.id}.address`));
        const items: Item[] = [];
        if (subnets) items.push(this.res("aws_db_subnet_group", n.id, [...attr("name", name()), ...attr("subnet_ids", subnets)]));
        items.push(
          this.res("aws_db_instance", n.id, [
            ...attr("identifier", name()),
            ...attr("engine", "postgres"),
            ...attr("engine_version", "16"),
            ...attr("instance_class", "db.t4g.medium"),
            ...attr("allocated_storage", 20),
            ...attr("max_allocated_storage", 100),
            ...attr("db_name", "app"),
            ...attr("username", "app"),
            ...attr("manage_master_user_password", true),
            ...attr("iam_database_authentication_enabled", true),
            ...attr("storage_encrypted", true),
            ...attr("multi_az", ex("var.rds_multi_az")),
            ...attr("publicly_accessible", false),
            ...attr("backup_retention_period", 7),
            ...attr("deletion_protection", true),
            ...attr("skip_final_snapshot", false),
            ...attr("final_snapshot_identifier", name("-final")),
            ...(subnets ? attr("db_subnet_group_name", ex(`aws_db_subnet_group.${n.id}.name`)) : []),
            ...(sg ? attr("vpc_security_group_ids", [ex(sg)]) : []),
            this.tags(n),
          ], n),
        );
        if (!this.vars.some((b) => b.labels?.[0] === "rds_multi_az"))
          this.vars.push(block("variable", ["rds_multi_az"], [...attr("type", ex("bool")), ...attr("default", true), ...attr("description", "Run RDS databases in two availability zones")]));
        return items;
      }
      case "elasticache": {
        const subnets = this.subnetsFor(n, false);
        const sg = this.sg(n);
        if (!subnets) this.warn(n.id, `${n.label || n.id} isn't inside a VPC; put it in a private subnet`);
        this.output(`${n.id}_endpoint`, ex(`aws_elasticache_replication_group.${n.id}.primary_endpoint_address`));
        return [
          ...(subnets ? [this.res("aws_elasticache_subnet_group", n.id, [...attr("name", name()), ...attr("subnet_ids", subnets)])] : []),
          this.res("aws_elasticache_replication_group", n.id, [
            ...attr("replication_group_id", name()),
            ...attr("description", n.label || n.id),
            ...attr("engine", "redis"),
            ...attr("node_type", "cache.t4g.small"),
            ...attr("num_cache_clusters", 2),
            ...attr("automatic_failover_enabled", true),
            ...attr("at_rest_encryption_enabled", true),
            ...attr("transit_encryption_enabled", true),
            ...(subnets ? attr("subnet_group_name", ex(`aws_elasticache_subnet_group.${n.id}.name`)) : []),
            ...(sg ? attr("security_group_ids", [ex(sg)]) : []),
          ], n),
        ];
      }
      case "lambda":
        return this.lambda(n);
      case "ecs":
        return this.ecs(n);
      case "ec2": {
        this.needsAmi = true;
        const subnet = this.subnetOf(n);
        const sg = this.sg(n);
        if (!subnet) this.warn(n.id, `${n.label || n.id} isn't in a subnet; it goes in the default VPC`);
        return [
          this.res("aws_instance", n.id, [
            ...attr("ami", ex("data.aws_ssm_parameter.al2023.value")),
            ...attr("instance_type", "t3.small"),
            ...(subnet ? attr("subnet_id", ex(`aws_subnet.${subnet.id}.id`)) : []),
            ...(sg ? attr("vpc_security_group_ids", [ex(sg)]) : []),
            nested("metadata_options", [...attr("http_tokens", "required")]),
            nested("root_block_device", [...attr("encrypted", true)]),
            this.tags(n),
          ], n),
        ];
      }
      case "alb": {
        const subnets = this.subnetsFor(n, true);
        const sg = this.sg(n);
        if (!subnets) {
          this.warn(n.id, `${n.label || n.id} isn't inside a VPC: put it in public subnets in two availability zones`);
          return [];
        }
        this.output(`${n.id}_dns_name`, ex(`aws_lb.${n.id}.dns_name`));
        if (sg)
          for (const port of [80, 443])
            this.sgRules.push(
              this.res("aws_vpc_security_group_ingress_rule", `${n.id}_${port}`, [...attr("security_group_id", ex(sg)), ...attr("cidr_ipv4", "0.0.0.0/0"), ...attr("ip_protocol", "tcp"), ...attr("from_port", port), ...attr("to_port", port)]),
            );
        this.warn(n.id, `${n.label || n.id} listens on HTTP; add an ACM certificate and an HTTPS listener for production`);
        const targets = this.m.edges.filter((e) => e.from === n.id && ["ecs", "lambda"].includes(this.svc.get(e.to) ?? ""));
        const first = targets[0];
        return [
          this.res("aws_lb", n.id, [
            ...attr("name", ex(`substr("\${var.name}-${n.id.replace(/_/g, "-")}", 0, 32)`)),
            ...attr("load_balancer_type", "application"),
            ...attr("internal", false),
            ...attr("subnets", subnets),
            ...(sg ? attr("security_groups", [ex(sg)]) : []),
            ...attr("drop_invalid_header_fields", true),
          ], n),
          this.res("aws_lb_listener", n.id, [
            ...attr("load_balancer_arn", ex(`aws_lb.${n.id}.arn`)),
            ...attr("port", 80),
            ...attr("protocol", "HTTP"),
            first
              ? nested("default_action", [...attr("type", "forward"), ...attr("target_group_arn", ex(`aws_lb_target_group.${first.from}_${first.to}.arn`))])
              : nested("default_action", [...attr("type", "fixed-response"), nested("fixed_response", [...attr("content_type", "text/plain"), ...attr("status_code", "404")])]),
          ]),
        ];
      }
      case "apigw":
        this.output(`${n.id}_url`, ex(`aws_apigatewayv2_stage.${n.id}.invoke_url`));
        return [
          this.res("aws_apigatewayv2_api", n.id, [...attr("name", name()), ...attr("protocol_type", "HTTP")], n),
          this.res("aws_apigatewayv2_stage", n.id, [...attr("api_id", ex(`aws_apigatewayv2_api.${n.id}.id`)), ...attr("name", "$default"), ...attr("auto_deploy", true)]),
        ];
      case "cloudfront":
        return this.cloudfront(n);
    }
  }

  private lambda(n: DiagramNode): Item[] {
    const c = this.callers.get(n.id)!;
    const subnet = this.subnetOf(n);
    const sg = this.sg(n);
    const fname = ex(`"\${var.name}-${n.id.replace(/_/g, "-")}"`);
    this.vars.push(block("variable", [`${n.id}_package`], [...attr("type", ex("string")), ...attr("default", `build/${n.id}.zip`), ...attr("description", `Deployment package (zip) for ${n.label || n.id}`)]));
    return [
      ...this.role(n.id, "lambda.amazonaws.com", [
        subnet ? "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole" : "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      ]),
      this.res("aws_lambda_function", n.id, [
        ...attr("function_name", fname),
        ...attr("role", ex(`aws_iam_role.${n.id}.arn`)),
        ...attr("runtime", "nodejs20.x"),
        ...attr("handler", "index.handler"),
        ...attr("filename", ex(`var.${n.id}_package`)),
        ...attr("source_code_hash", ex(`filebase64sha256(var.${n.id}_package)`)),
        ...attr("timeout", 30),
        ...attr("memory_size", 512),
        nested("tracing_config", attr("mode", "Active")),
        ...(Object.keys(c.env).length ? [nested("environment", attr("variables", c.env))] : []),
        ...(subnet && sg ? [nested("vpc_config", [...attr("subnet_ids", [ex(`aws_subnet.${subnet.id}.id`)]), ...attr("security_group_ids", [ex(sg)])])] : []),
        this.tags(n),
      ], n),
      ...this.policy(n.id),
    ];
  }

  private ecs(n: DiagramNode): Item[] {
    this.needsCluster = true;
    const c = this.callers.get(n.id)!;
    const subnet = this.subnetOf(n);
    const sg = this.sg(n);
    if (!subnet) this.warn(n.id, `${n.label || n.id} isn't in a subnet: Fargate services need one`);
    this.vars.push(block("variable", [`${n.id}_image`], [...attr("type", ex("string")), ...attr("default", "public.ecr.aws/nginx/nginx:stable"), ...attr("description", `Container image for ${n.label || n.id}`)]));
    const lbs = this.m.edges.filter((e) => e.to === n.id && this.svc.get(e.from) === "alb");
    return [
      ...this.role(`${n.id}_exec`, "ecs-tasks.amazonaws.com", ["arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"]),
      ...this.role(n.id, "ecs-tasks.amazonaws.com", []),
      this.res("aws_cloudwatch_log_group", n.id, [...attr("name", ex(`"/ecs/\${var.name}/${n.id}"`)), ...attr("retention_in_days", 30)]),
      this.res("aws_ecs_task_definition", n.id, [
        ...attr("family", ex(`"\${var.name}-${n.id.replace(/_/g, "-")}"`)),
        ...attr("requires_compatibilities", ["FARGATE"]),
        ...attr("network_mode", "awsvpc"),
        ...attr("cpu", "512"),
        ...attr("memory", "1024"),
        ...attr("execution_role_arn", ex(`aws_iam_role.${n.id}_exec.arn`)),
        ...attr("task_role_arn", ex(`aws_iam_role.${n.id}.arn`)),
        ...attr(
          "container_definitions",
          ex(
            `jsonencode([${renderVal(
              {
                name: n.id,
                image: ex(`var.${n.id}_image`),
                essential: true,
                portMappings: [{ containerPort: 8080, protocol: "tcp" }],
                environment: Object.entries(c.env).map(([k, v]) => ({ name: k, value: v })),
                logConfiguration: {
                  logDriver: "awslogs",
                  options: { "awslogs-group": ex(`aws_cloudwatch_log_group.${n.id}.name`), "awslogs-region": ex("var.region"), "awslogs-stream-prefix": n.id },
                },
              },
              1,
            )}])`,
          ),
        ),
      ], n),
      this.res("aws_ecs_service", n.id, [
        ...attr("name", ex(`"\${var.name}-${n.id.replace(/_/g, "-")}"`)),
        ...attr("cluster", ex("aws_ecs_cluster.main.id")),
        ...attr("task_definition", ex(`aws_ecs_task_definition.${n.id}.arn`)),
        ...attr("desired_count", 2),
        ...attr("launch_type", "FARGATE"),
        ...(subnet ? [nested("network_configuration", [...attr("subnets", [ex(`aws_subnet.${subnet.id}.id`)]), ...(sg ? attr("security_groups", [ex(sg)]) : []), ...attr("assign_public_ip", isPublicSubnet(subnet))])] : []),
        ...lbs.map((e) => nested("load_balancer", [...attr("target_group_arn", ex(`aws_lb_target_group.${e.from}_${e.to}.arn`)), ...attr("container_name", n.id), ...attr("container_port", 8080)])),
      ], n),
      ...this.policy(n.id),
    ];
  }

  private cloudfront(n: DiagramNode): Item[] {
    const origins = this.m.edges.filter((e) => e.from === n.id && ["s3", "alb", "apigw"].includes(this.svc.get(e.to) ?? ""));
    if (!origins.length) {
      this.warn(n.id, `${n.label || n.id} has no origin: connect it to an S3 bucket, a load balancer or an API`);
      return [];
    }
    this.output(`${n.id}_domain`, ex(`aws_cloudfront_distribution.${n.id}.domain_name`));
    const items: Item[] = [];
    const originBlocks = origins.map((e) => {
      const t = this.svc.get(e.to)!;
      if (t === "s3") {
        items.push(
          this.res("aws_cloudfront_origin_access_control", `${n.id}_${e.to}`, [
            ...attr("name", ex(`"\${var.name}-${e.to.replace(/_/g, "-")}"`)),
            ...attr("origin_access_control_origin_type", "s3"),
            ...attr("signing_behavior", "always"),
            ...attr("signing_protocol", "sigv4"),
          ]),
          this.res("aws_s3_bucket_policy", `${e.to}_cloudfront`, [
            ...attr("bucket", ex(`aws_s3_bucket.${e.to}.id`)),
            ...attr(
              "policy",
              ex(
                `jsonencode(${renderVal(
                  {
                    Version: "2012-10-17",
                    Statement: [
                      {
                        Effect: "Allow",
                        Principal: { Service: "cloudfront.amazonaws.com" },
                        Action: "s3:GetObject",
                        Resource: ex(`"\${aws_s3_bucket.${e.to}.arn}/*"`),
                        Condition: { StringEquals: { "AWS:SourceArn": ex(`aws_cloudfront_distribution.${n.id}.arn`) } },
                      },
                    ],
                  },
                  1,
                )})`,
              ),
            ),
          ]),
        );
        return nested("origin", [
          ...attr("origin_id", e.to),
          ...attr("domain_name", ex(`aws_s3_bucket.${e.to}.bucket_regional_domain_name`)),
          ...attr("origin_access_control_id", ex(`aws_cloudfront_origin_access_control.${n.id}_${e.to}.id`)),
        ]);
      }
      const domain = t === "alb" ? ex(`aws_lb.${e.to}.dns_name`) : ex(`replace(aws_apigatewayv2_api.${e.to}.api_endpoint, "https://", "")`);
      return nested("origin", [
        ...attr("origin_id", e.to),
        ...attr("domain_name", domain),
        nested("custom_origin_config", [...attr("http_port", 80), ...attr("https_port", 443), ...attr("origin_protocol_policy", t === "alb" ? "http-only" : "https-only"), ...attr("origin_ssl_protocols", ["TLSv1.2"])]),
      ]);
    });
    const def = origins.find((e) => this.svc.get(e.to) !== "s3") ?? origins[0];
    items.unshift(
      this.res("aws_cloudfront_distribution", n.id, [
        ...attr("enabled", true),
        ...attr("comment", n.label || n.id),
        ...attr("price_class", "PriceClass_100"),
        ...originBlocks,
        nested("default_cache_behavior", [
          ...attr("target_origin_id", def.to),
          ...attr("viewer_protocol_policy", "redirect-to-https"),
          ...attr("allowed_methods", this.svc.get(def.to) === "s3" ? ["GET", "HEAD"] : ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]),
          ...attr("cached_methods", ["GET", "HEAD"]),
          // Managed policies: CachingOptimized for S3, CachingDisabled + AllViewer for dynamic origins.
          ...attr("cache_policy_id", this.svc.get(def.to) === "s3" ? "658327ea-f89d-4fab-a63d-7e88639e58f6" : "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"),
          ...(this.svc.get(def.to) === "s3" ? [] : attr("origin_request_policy_id", "216adef6-5c7f-47e4-b989-5492eafa07d3")),
        ]),
        ...origins
          .filter((e) => e !== def)
          .map((e) =>
            nested("ordered_cache_behavior", [
              ...attr("path_pattern", this.svc.get(e.to) === "s3" ? "/static/*" : `/${e.to}/*`),
              ...attr("target_origin_id", e.to),
              ...attr("viewer_protocol_policy", "redirect-to-https"),
              ...attr("allowed_methods", ["GET", "HEAD"]),
              ...attr("cached_methods", ["GET", "HEAD"]),
              ...attr("cache_policy_id", "658327ea-f89d-4fab-a63d-7e88639e58f6"),
            ]),
          ),
        nested("restrictions", [nested("geo_restriction", attr("restriction_type", "none"))]),
        nested("viewer_certificate", attr("cloudfront_default_certificate", true)),
      ], n),
    );
    return items;
  }

  // ---------------------------------------------------------------- connections

  private edge(e: DiagramEdge): Item[] {
    const from = this.svc.get(e.from);
    const to = this.svc.get(e.to);
    const a = this.m.nodes.find((n) => n.id === e.from)!;
    const b = this.m.nodes.find((n) => n.id === e.to)!;
    if (!from || !to) return [];
    const caller = this.callers.get(e.from);
    const ENV = e.to.toUpperCase();
    /** TABLE_NAME-style variable names, without repeating the item's id (a "queue" gives QUEUE_URL, not QUEUE_QUEUE_URL). */
    const envKey = (suffix: string) => (suffix === ENV || suffix.startsWith(`${ENV}_`) ? suffix : `${ENV}_${suffix}`);
    const items: Item[] = [];
    // A compute service using a data or messaging service: IAM, environment, network.
    if (caller) {
      switch (to) {
        case "dynamodb":
          caller.statements.push({ Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem"], Resource: [ex(`aws_dynamodb_table.${e.to}.arn`), ex(`"\${aws_dynamodb_table.${e.to}.arn}/index/*"`)] });
          caller.env[envKey("TABLE")] = ex(`aws_dynamodb_table.${e.to}.name`);
          return items;
        case "s3":
          caller.statements.push({ Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource: [ex(`"\${aws_s3_bucket.${e.to}.arn}/*"`)] }, { Effect: "Allow", Action: ["s3:ListBucket"], Resource: [ex(`aws_s3_bucket.${e.to}.arn`)] });
          caller.env[envKey("BUCKET")] = ex(`aws_s3_bucket.${e.to}.bucket`);
          return items;
        case "sqs":
          caller.statements.push({ Effect: "Allow", Action: ["sqs:SendMessage", "sqs:GetQueueAttributes"], Resource: [ex(`aws_sqs_queue.${e.to}.arn`)] });
          caller.env[envKey("QUEUE_URL")] = ex(`aws_sqs_queue.${e.to}.url`);
          return items;
        case "sns":
          caller.statements.push({ Effect: "Allow", Action: ["sns:Publish"], Resource: [ex(`aws_sns_topic.${e.to}.arn`)] });
          caller.env[envKey("TOPIC_ARN")] = ex(`aws_sns_topic.${e.to}.arn`);
          return items;
        case "kinesis":
          caller.statements.push({ Effect: "Allow", Action: ["kinesis:PutRecord", "kinesis:PutRecords", "kinesis:DescribeStreamSummary"], Resource: [ex(`aws_kinesis_stream.${e.to}.arn`)] });
          caller.env[envKey("STREAM")] = ex(`aws_kinesis_stream.${e.to}.name`);
          return items;
        case "secret":
          caller.statements.push({ Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: [ex(`aws_secretsmanager_secret.${e.to}.arn`)] });
          caller.env[envKey("SECRET_ARN")] = ex(`aws_secretsmanager_secret.${e.to}.arn`);
          return items;
        case "lambda":
          caller.statements.push({ Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: [ex(`aws_lambda_function.${e.to}.arn`)] });
          caller.env[envKey("FUNCTION")] = ex(`aws_lambda_function.${e.to}.function_name`);
          return items;
        case "rds":
        case "elasticache": {
          const port = PORTS[to]!;
          caller.env[envKey("HOST")] = to === "rds" ? ex(`aws_db_instance.${e.to}.address`) : ex(`aws_elasticache_replication_group.${e.to}.primary_endpoint_address`);
          caller.env[envKey("PORT")] = String(port);
          if (to === "rds") {
            caller.statements.push({ Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: [ex(`aws_db_instance.${e.to}.master_user_secret[0].secret_arn`)] });
            caller.env[envKey("SECRET_ARN")] = ex(`aws_db_instance.${e.to}.master_user_secret[0].secret_arn`);
          }
          const src = this.sg(a);
          const dst = this.sg(b);
          if (!src) this.warn(e.from, `${a.label || a.id} reaches ${b.label || b.id} over the network: put it in the same VPC`);
          else if (dst)
            this.sgRules.push(
              this.res("aws_vpc_security_group_ingress_rule", `${e.from}_to_${e.to}`, [
                ...attr("security_group_id", ex(dst)),
                ...attr("referenced_security_group_id", ex(src)),
                ...attr("ip_protocol", "tcp"),
                ...attr("from_port", port),
                ...attr("to_port", port),
              ]),
            );
          return items;
        }
      }
    }
    // Triggers and front doors.
    if (from === "sqs" && to === "lambda") {
      this.callers.get(e.to)?.statements.push({ Effect: "Allow", Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource: [ex(`aws_sqs_queue.${e.from}.arn`)] });
      items.push(this.res("aws_lambda_event_source_mapping", `${e.from}_${e.to}`, [...attr("event_source_arn", ex(`aws_sqs_queue.${e.from}.arn`)), ...attr("function_name", ex(`aws_lambda_function.${e.to}.arn`)), ...attr("batch_size", 10)]));
    } else if (from === "kinesis" && to === "lambda") {
      this.callers.get(e.to)?.statements.push({ Effect: "Allow", Action: ["kinesis:GetRecords", "kinesis:GetShardIterator", "kinesis:DescribeStream", "kinesis:ListShards"], Resource: [ex(`aws_kinesis_stream.${e.from}.arn`)] });
      items.push(this.res("aws_lambda_event_source_mapping", `${e.from}_${e.to}`, [...attr("event_source_arn", ex(`aws_kinesis_stream.${e.from}.arn`)), ...attr("function_name", ex(`aws_lambda_function.${e.to}.arn`)), ...attr("starting_position", "LATEST")]));
    } else if (from === "sns" && to === "lambda") {
      items.push(
        this.res("aws_sns_topic_subscription", `${e.from}_${e.to}`, [...attr("topic_arn", ex(`aws_sns_topic.${e.from}.arn`)), ...attr("protocol", "lambda"), ...attr("endpoint", ex(`aws_lambda_function.${e.to}.arn`))]),
        this.res("aws_lambda_permission", `${e.from}_${e.to}`, [...attr("action", "lambda:InvokeFunction"), ...attr("function_name", ex(`aws_lambda_function.${e.to}.function_name`)), ...attr("principal", "sns.amazonaws.com"), ...attr("source_arn", ex(`aws_sns_topic.${e.from}.arn`))]),
      );
    } else if (from === "sns" && to === "sqs") {
      items.push(
        this.res("aws_sns_topic_subscription", `${e.from}_${e.to}`, [...attr("topic_arn", ex(`aws_sns_topic.${e.from}.arn`)), ...attr("protocol", "sqs"), ...attr("endpoint", ex(`aws_sqs_queue.${e.to}.arn`)), ...attr("raw_message_delivery", true)]),
        this.res("aws_sqs_queue_policy", `${e.from}_${e.to}`, [
          ...attr("queue_url", ex(`aws_sqs_queue.${e.to}.id`)),
          ...attr(
            "policy",
            ex(
              `jsonencode(${renderVal({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "sns.amazonaws.com" }, Action: "sqs:SendMessage", Resource: ex(`aws_sqs_queue.${e.to}.arn`), Condition: { ArnEquals: { "aws:SourceArn": ex(`aws_sns_topic.${e.from}.arn`) } } }] }, 1)})`,
            ),
          ),
        ]),
      );
    } else if (from === "apigw" && to === "lambda") {
      const multi = this.m.edges.filter((x) => x.from === e.from && this.svc.get(x.to) === "lambda").length > 1;
      items.push(
        this.res("aws_apigatewayv2_integration", `${e.from}_${e.to}`, [...attr("api_id", ex(`aws_apigatewayv2_api.${e.from}.id`)), ...attr("integration_type", "AWS_PROXY"), ...attr("integration_uri", ex(`aws_lambda_function.${e.to}.invoke_arn`)), ...attr("payload_format_version", "2.0")]),
        this.res("aws_apigatewayv2_route", `${e.from}_${e.to}`, [
          ...attr("api_id", ex(`aws_apigatewayv2_api.${e.from}.id`)),
          ...attr("route_key", multi ? `ANY /${e.to.replace(/_/g, "-")}/{proxy+}` : "$default"),
          ...attr("target", ex(`"integrations/\${aws_apigatewayv2_integration.${e.from}_${e.to}.id}"`)),
        ]),
        this.res("aws_lambda_permission", `${e.from}_${e.to}`, [
          ...attr("action", "lambda:InvokeFunction"),
          ...attr("function_name", ex(`aws_lambda_function.${e.to}.function_name`)),
          ...attr("principal", "apigateway.amazonaws.com"),
          ...attr("source_arn", ex(`"\${aws_apigatewayv2_api.${e.from}.execution_arn}/*/*"`)),
        ]),
      );
    } else if (from === "alb" && (to === "ecs" || to === "lambda")) {
      const vpc = this.vpcOf(a);
      items.push(
        this.res("aws_lb_target_group", `${e.from}_${e.to}`, [
          ...attr("name", ex(`substr("\${var.name}-${e.to.replace(/_/g, "-")}", 0, 32)`)),
          ...(to === "ecs" ? [...attr("port", 8080), ...attr("protocol", "HTTP"), ...attr("target_type", "ip"), ...(vpc ? attr("vpc_id", ex(`aws_vpc.${vpc.id}.id`)) : []), nested("health_check", [...attr("path", "/"), ...attr("matcher", "200-399")])] : attr("target_type", "lambda")),
        ]),
      );
      if (to === "lambda")
        items.push(
          this.res("aws_lambda_permission", `${e.from}_${e.to}`, [...attr("action", "lambda:InvokeFunction"), ...attr("function_name", ex(`aws_lambda_function.${e.to}.function_name`)), ...attr("principal", "elasticloadbalancing.amazonaws.com"), ...attr("source_arn", ex(`aws_lb_target_group.${e.from}_${e.to}.arn`))]),
          this.res("aws_lb_target_group_attachment", `${e.from}_${e.to}`, [...attr("target_group_arn", ex(`aws_lb_target_group.${e.from}_${e.to}.arn`)), ...attr("target_id", ex(`aws_lambda_function.${e.to}.arn`)), ...attr("depends_on", [ex(`aws_lambda_permission.${e.from}_${e.to}`)])]),
        );
      const lbSg = this.sg(a);
      const svcSg = this.sg(b);
      if (to === "ecs" && lbSg && svcSg)
        this.sgRules.push(
          this.res("aws_vpc_security_group_ingress_rule", `${e.from}_to_${e.to}`, [...attr("security_group_id", ex(svcSg)), ...attr("referenced_security_group_id", ex(lbSg)), ...attr("ip_protocol", "tcp"), ...attr("from_port", 8080), ...attr("to_port", 8080)]),
        );
    } else if (from === "cloudfront") {
      // Origins: handled with the distribution.
    } else if (!caller) this.warn(e.from, `the connection ${a.label || a.id} → ${b.label || b.id} has no AWS Terraform mapping yet; it's documentation only`);
    return items;
  }

  // ---------------------------------------------------------------- helpers

  private role(id: string, service: string, managed: string[]): Item[] {
    return [
      this.res("aws_iam_role", id, [
        ...attr("name_prefix", ex(`substr("\${var.name}-${id.replace(/_/g, "-")}-", 0, 38)`)),
        ...attr("assume_role_policy", ex(`jsonencode(${renderVal({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" }] }, 1)})`)),
      ]),
      ...managed.map((arn, i) => this.res("aws_iam_role_policy_attachment", managed.length > 1 ? `${id}_${i}` : id, [...attr("role", ex(`aws_iam_role.${id}.name`)), ...attr("policy_arn", arn)])),
    ];
  }

  /** The least-privilege policy a compute service gets from its connections. */
  private policy(id: string): Item[] {
    const c = this.callers.get(id);
    if (!c?.statements.length) return [];
    return [
      this.res("aws_iam_role_policy", id, [
        ...attr("name", "connections"),
        ...attr("role", ex(`aws_iam_role.${id}.id`)),
        ...attr("policy", ex(`jsonencode(${renderVal({ Version: "2012-10-17", Statement: c.statements as unknown as Val[] }, 1)})`)),
      ]),
    ];
  }

  private tags(n: DiagramNode): Item {
    return nested("tags", attr("Name", n.label ? n.label.split("\n")[0].slice(0, 120) : n.id)) as Item;
  }

  private res(type: string, name: string, body: Item[], node?: DiagramNode): Block {
    this.resources.push(`${type}.${name}`);
    // tags is a map attribute, not a block: render it as one.
    const fixed = body.map((i) => ("block" in i && i.block === "tags" && !i.labels?.length ? { attr: "tags", value: Object.fromEntries((i.body as { attr: string; value: Val }[]).map((a) => [a.attr, a.value])) } : i));
    return block("resource", [type, name], [...(node ? [comment(node.label.split("\n")[0] || node.id)] : []), ...fixed]);
  }

  private output(name: string, value: Val): void {
    this.outputs.push(block("output", [name], attr("value", value)));
  }

  private warn(nodeId: string | undefined, message: string): void {
    if (!this.warnings.some((w) => w.nodeId === nodeId && w.message === message)) this.warnings.push(nodeId ? { nodeId, message } : { message });
  }
}

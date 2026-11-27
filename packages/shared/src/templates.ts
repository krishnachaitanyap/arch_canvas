import { parseCode } from "./code.js";
import type { DiagramModel } from "./model.js";
import { SAMPLE_MODEL } from "./sample.js";

/**
 * Starter templates, written as diagram code so they're easy to read and change. Each one
 * parses into a model; positions are laid out automatically when it's opened.
 */
export interface Template {
  id: string;
  title: string;
  description: string;
  /** Diagram code; the sample template uses the reference model instead. */
  code?: string;
}

const AWS_CLOUD = `color: "#232f3e", border: solid, borderWidth: "1", fill: none, header: tab, icon: "aws:AWSCloud"`;
const AWS_REGION = `color: "#147eba", border: solid, borderWidth: "1", fill: none, header: tab, icon: "aws:Region"`;
const AWS_VPC = `color: "#248814", border: solid, borderWidth: "1", fill: none, header: tab, icon: "aws:VirtualprivatecloudVPC"`;
const PUBLIC = `color: "#248814", border: none, fill: "#e9f3e6", header: tab, icon: "aws:Publicsubnet"`;
const PRIVATE = `color: "#147eba", border: none, fill: "#e6f2f8", header: tab, icon: "aws:Privatesubnet"`;

export const TEMPLATES: Template[] = [
  {
    id: "gcp-web-app",
    title: "Web app on Google Cloud",
    description: "Load balancer, Cloud Run API and worker, Cloud SQL, Redis, Pub/Sub and Cloud Storage. Generates Terraform.",
  },
  {
    id: "aws-three-tier",
    title: "Three-tier app on AWS",
    description: "CloudFront, an Application Load Balancer, ECS services across subnets, RDS and ElastiCache.",
    code: `users "Users" [generic.client]
cdn "CloudFront" [generic.component, icon: "aws:AmazonCloudFront"]
dns "Route 53" [generic.component, icon: "aws:AmazonRoute53"]
aws "AWS Cloud" [generic.group, ${AWS_CLOUD}] {
  region "us-east-1" [generic.group, ${AWS_REGION}] {
    vpc "VPC 10.0.0.0/16" [generic.group, ${AWS_VPC}] {
      public "Public subnet" [generic.group, ${PUBLIC}] {
        alb "Application Load Balancer" [generic.component, icon: "aws:ElasticLoadBalancingApplicationLoadBalancer"]
      }
      app "Private subnet: app" [generic.group, ${PRIVATE}] {
        web "Web (ECS)" [generic.component, icon: "aws:AmazonElasticContainerService"]
        api "API (ECS)" [generic.component, icon: "aws:AmazonElasticContainerService"]
      }
      data "Private subnet: data" [generic.group, ${PRIVATE}] {
        db "RDS PostgreSQL" [generic.component, icon: "aws:AmazonRDS"]
        cache "ElastiCache" [generic.component, icon: "aws:AmazonElastiCache"]
      }
    }
    assets "S3 assets" [generic.component, icon: "aws:AmazonSimpleStorageService"]
    secrets "Secrets Manager" [generic.component, icon: "aws:AWSSecretsManager"]
  }
}

users -> dns "DNS"
users -> cdn "HTTPS" [https]
cdn -> alb [https]
cdn -> assets [storage]
alb -> web [https]
web -> api [https]
api -> db [sql]
api -> cache [redis]
api -> secrets [secret]
`,
  },
  {
    id: "aws-serverless",
    title: "Serverless API on AWS",
    description: "API Gateway, Lambda, DynamoDB, SQS, S3 and Cognito sign-in.",
    code: `users "Users" [generic.client]
aws "AWS Cloud" [generic.group, ${AWS_CLOUD}] {
  auth "Cognito" [generic.component, icon: "aws:AmazonCognito"]
  gateway "API Gateway" [generic.component, icon: "aws:AmazonAPIGateway"]
  orders "Orders function" [generic.component, icon: "aws:AWSLambda"]
  worker "Worker function" [generic.component, icon: "aws:AWSLambda"]
  table "Orders table" [generic.component, icon: "aws:AmazonDynamoDB"]
  queue "Jobs queue" [generic.component, icon: "aws:AmazonSimpleQueueService"]
  bucket "Receipts" [generic.component, icon: "aws:AmazonSimpleStorageService"]
}

users -> auth "sign in"
users -> gateway "HTTPS" [https]
gateway -> orders [https]
orders -> table "read / write"
orders -> queue "enqueue"
queue -> worker "trigger" [dashed]
worker -> bucket [storage]
`,
  },
  {
    id: "event-driven",
    title: "Event-driven pipeline on Google Cloud",
    description: "Ingest API publishing to Pub/Sub, a processing worker, Cloud SQL and an archive bucket.",
    code: `terraform on
producers "Producers" [generic.client]
data "Data platform" [gcp.project] {
  region "us-central1" [gcp.region, region: us-central1] {
    ingest "Ingest API" [gcp.cloud_run, public: true]
    processor "Processor" [gcp.cloud_run, min_instances: 1]
    archive "Raw events" [gcp.gcs_bucket]
  }
  events "events" [gcp.pubsub_topic]
  dlq "events-dead-letter" [gcp.pubsub_topic]
  warehouse "Warehouse DB" [gcp.cloud_sql, high_availability: true]
}

producers -> ingest "HTTPS" [https]
ingest -> events "publish"
events -> processor "push"
processor -> warehouse [sql]
processor -> archive [storage]
processor -> dlq "failures" [dashed]
`,
  },
  {
    id: "kubernetes-microservices",
    title: "Microservices on Kubernetes",
    description: "Ingress, services in a namespace, a message broker and databases.",
    code: `users "Users" [generic.client]
cluster "Kubernetes cluster" [generic.group, color: "#326ce5", border: solid, borderWidth: "1.5", fill: none, header: tab, icon: "logos:kubernetes"] {
  ingress "Ingress" [generic.component, icon: "lucide:network"]
  ns "namespace: shop" [generic.group, color: "#326ce5", border: dashed, borderWidth: "1", fill: none, header: label] {
    catalog "catalog" [generic.component, icon: "lucide:box"]
    cart "cart" [generic.component, icon: "lucide:shopping-cart"]
    checkout "checkout" [generic.component, icon: "lucide:credit-card"]
  }
  broker "Kafka" [generic.component, icon: "logos:kafka"]
}
pg "PostgreSQL" [generic.component, icon: "logos:postgresql"]
redis "Redis" [generic.component, icon: "logos:redis"]

users -> ingress [https]
ingress -> catalog [https]
ingress -> cart [https]
ingress -> checkout [https]
checkout -> broker "order placed" [dashed]
catalog -> pg [sql]
cart -> redis [redis]
`,
  },
  {
    id: "flowchart",
    title: "Flowchart",
    description: "Start, steps, a decision and an end, with the draw.io flowchart shapes.",
    code: `start "Start" [generic.shape, shape: terminator]
input "Read the request" [generic.shape, shape: parallelogram]
valid "Valid?" [generic.shape, shape: diamond]
process "Process the order" [generic.shape, shape: rectangle]
reject "Return an error" [generic.shape, shape: rectangle]
done "End" [generic.shape, shape: terminator]

start -> input
input -> valid
valid -> process "yes"
valid -> reject "no"
process -> done
reject -> done
`,
  },
];

/** The template as a model (positions are filled in by the editor's auto layout). */
export function templateModel(id: string): DiagramModel {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`no template ${id}`);
  if (!t.code) return structuredClone(SAMPLE_MODEL);
  const r = parseCode(t.code);
  if (!r.ok) throw new Error(`template ${id}: ${r.errors.map((e) => `${e.line}: ${e.message}`).join("; ")}`);
  return r.model;
}

import { describe, expect, it } from "vitest";
import { compileTerraform, parseCode, SAMPLE_MODEL, templateModel } from "../src/index.js";

const model = (code: string) => {
  const r = parseCode(code);
  if (!r.ok) throw new Error(r.errors.map((e) => `${e.line}: ${e.message}`).join("\n"));
  return r.model;
};
const main = (tf: ReturnType<typeof compileTerraform>) => tf.files.find((f) => f.path.endsWith("main.tf"))!.content;

describe("AWS Terraform", () => {
  it("compiles the serverless template: Lambda, API Gateway, DynamoDB, SQS trigger, least-privilege IAM", () => {
    const tf = compileTerraform(templateModel("aws-serverless"));
    expect(tf.files.map((f) => f.path)).toEqual(["versions.tf", "providers.tf", "variables.tf", "main.tf", "outputs.tf"]);
    expect(tf.files[0].content).toContain('source  = "hashicorp/aws"');
    for (const r of [
      "aws_lambda_function.orders",
      "aws_lambda_function.worker",
      "aws_dynamodb_table.table",
      "aws_sqs_queue.queue",
      "aws_apigatewayv2_route.gateway_orders",
      "aws_lambda_event_source_mapping.queue_worker",
      "aws_iam_role_policy.orders",
    ])
      expect(tf.resources).toContain(r);
    const m = main(tf);
    expect(m).toContain("TABLE     = aws_dynamodb_table.table.name");
    expect(m).toContain("QUEUE_URL = aws_sqs_queue.queue.url");
    expect(m).toContain('"dynamodb:PutItem"');
    expect(m).toContain('route_key = "$default"');
    // The worker can read its queue; the API can only send to it.
    expect(m).toMatch(/sqs:ReceiveMessage[\s\S]*aws_sqs_queue\.queue\.arn/);
  });

  it("compiles the three-tier template with networking, security groups and an RDS secret", () => {
    const tf = compileTerraform(templateModel("aws-three-tier"));
    const m = main(tf);
    for (const r of ["aws_vpc.vpc", "aws_subnet.public", "aws_subnet.app", "aws_subnet.data", "aws_internet_gateway.vpc", "aws_lb.alb", "aws_ecs_service.api", "aws_db_instance.db", "aws_elasticache_replication_group.cache", "aws_cloudfront_distribution.cdn"])
      expect(tf.resources).toContain(r);
    expect(m).toContain('cidr_block           = "10.0.0.0/16"');
    expect(m).toContain("manage_master_user_password         = true");
    expect(m).toContain("storage_encrypted                   = true");
    expect(m).toContain("publicly_accessible                 = false");
    // ECS API → RDS: only the API's security group may reach port 5432.
    expect(m).toMatch(/resource "aws_vpc_security_group_ingress_rule" "api_to_db" \{[\s\S]*?referenced_security_group_id = aws_security_group\.api\.id[\s\S]*?from_port\s+= 5432/);
    // CloudFront → S3 uses origin access control, and the bucket stays private.
    expect(m).toContain("aws_cloudfront_origin_access_control");
    expect(m).toContain("block_public_policy     = true");
    expect(tf.warnings.map((w) => w.message).join("\n")).toContain("two availability zones");
  });

  it("puts AWS next to Google Cloud in its own folder when a diagram has both", () => {
    const both = { ...SAMPLE_MODEL, nodes: [...SAMPLE_MODEL.nodes, { id: "fn", kind: "generic.component", label: "Fn", props: {}, icon: "aws:AWSLambda" }] };
    const paths = compileTerraform(both).files.map((f) => f.path);
    expect(paths).toContain("main.tf");
    expect(paths).toContain("aws/main.tf");
  });

  it("is the same every time, and plain icon items are left alone", () => {
    const m = model(`fn "Fn" [generic.component, icon: "aws:AWSLambda"]\nnote "Note" [generic.note]\nx "Logo" [generic.component, icon: "logos:react"]`);
    expect(compileTerraform(m)).toEqual(compileTerraform(m));
    expect(compileTerraform(m).resources.filter((r) => r.startsWith("aws_lambda_function"))).toEqual(["aws_lambda_function.fn"]);
  });
});

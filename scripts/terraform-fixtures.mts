/**
 * Writes the Terraform Keelrail generates for the sample diagram and every template, one
 * folder each (and aws/ inside when a diagram mixes clouds), so CI can run `terraform validate`
 * on real compiler output:
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/terraform-fixtures.mts <out-dir>
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileTerraform, type DiagramModel, SAMPLE_MODEL, TEMPLATES, templateModel } from "../packages/shared/src/index.ts";

const out = process.argv[2] ?? "terraform-fixtures";
rmSync(out, { recursive: true, force: true });

const mixed: DiagramModel = {
  ...SAMPLE_MODEL,
  nodes: [
    ...SAMPLE_MODEL.nodes,
    { id: "fn", kind: "generic.component", label: "Fn", props: {}, icon: "aws:AWSLambda" },
    { id: "q", kind: "generic.component", label: "Queue", props: {}, icon: "aws:AmazonSimpleQueueService" },
  ],
  edges: [...SAMPLE_MODEL.edges, { id: "q__fn", from: "q", to: "fn" }],
};
const cases: [string, DiagramModel][] = [["sample", SAMPLE_MODEL], ["mixed-clouds", mixed], ...TEMPLATES.map((t): [string, DiagramModel] => [t.id, templateModel(t.id)])];

const roots: string[] = [];
for (const [name, model] of cases) {
  const tf = compileTerraform(model);
  if (!tf.resources.length) continue; // flowchart and other documentation-only templates
  for (const f of tf.files) {
    const file = path.join(out, name, f.path);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, f.content);
  }
  for (const dir of new Set(tf.files.map((f) => path.dirname(path.join(out, name, f.path))))) roots.push(dir);
  console.log(`${name}: ${tf.resources.length} resources`);
}
// One Terraform root module per line, for the CI loop.
writeFileSync(path.join(out, "roots.txt"), roots.join("\n") + "\n");

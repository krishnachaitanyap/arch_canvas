/**
 * Keelrail diagram code on the command line, for diagrams kept in Git as .arch files.
 *
 *   npm run arch -- check  diagram.arch               check the code (exit 1 on problems)
 *   npm run arch -- fmt    diagram.arch [--write]     print (or rewrite) the code tidied up
 *   npm run arch -- diff   before.arch after.arch     what changed: items, lines and Terraform
 *   npm run arch -- terraform diagram.arch [out-dir]  write the Terraform (default ./terraform)
 *   npm run arch -- review diagram.arch               security and reliability review
 *   npm run arch -- from   diagram.json|.drawio       turn an Keelrail JSON export or a draw.io file into code
 *   npm run arch -- to     diagram.arch drawio|mermaid|plantuml|json
 *
 * "-" reads from stdin. diff also accepts git revisions: `diff HEAD~1:infra/app.arch infra/app.arch`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  compileTerraform,
  type DiagramModel,
  DiagramModelSchema,
  describeChanges,
  drawioPagesToModel,
  hunks,
  lineDiff,
  parseCode,
  readDrawio,
  detectSource,
  importSource,
  terraformDiff,
  toCode,
  toDrawio,
  toMermaid,
  toPlantUml,
  validateModel,
} from "../packages/shared/src/index.ts";

const [cmd, ...args] = process.argv.slice(2);
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const color = (c: number, s: string) => (useColor ? `\x1b[${c}m${s}\x1b[0m` : s);
const green = (s: string) => color(32, s);
const red = (s: string) => color(31, s);
const dim = (s: string) => color(2, s);

function read(file: string): string {
  if (file === "-") return readFileSync(0, "utf8");
  // An empty side, for a diagram added (or deleted) in a pull request.
  if (file === "/dev/null" || file === "NUL" || file === "empty") return "";
  // A git revision: rev:path
  if (/^[^/\\]+:.+/.test(file) && !/^[A-Za-z]:[\\/]/.test(file) && !readable(file)) return execFileSync("git", ["show", file], { encoding: "utf8" });
  return readFileSync(file, "utf8");
}
function readable(f: string) {
  try {
    readFileSync(f);
    return true;
  } catch {
    return false;
  }
}

function load(file: string): DiagramModel {
  const r = parseCode(read(file));
  if (!r.ok) {
    for (const e of r.errors) console.error(`${file}:${e.line}:${e.col}: ${red("error")} ${e.message}`);
    process.exit(1);
  }
  return r.model;
}

function printDiff(lines: ReturnType<typeof lineDiff>) {
  for (const [i, h] of hunks(lines, 2).entries()) {
    if (i) console.log(dim("  ⋯"));
    for (const l of h.lines) console.log(l.op === "add" ? green(`+ ${l.text}`) : l.op === "del" ? red(`- ${l.text}`) : dim(`  ${l.text}`));
  }
}

const USAGE = `Keelrail diagram code (.arch)

  arch check  diagram.arch                check the code (exit 1 on problems)
  arch fmt    diagram.arch [--write]      print (or rewrite) the code tidied up
  arch diff   before.arch after.arch      what changed: items, lines and Terraform
              [--markdown] [--exit-code]  (git revisions work: HEAD~1:infra/app.arch; /dev/null for none)
  arch terraform diagram.arch [out-dir]   write the Terraform (default ./terraform)
  arch review diagram.arch                security and reliability review
  arch from   diagram.drawio|.json|main.tf|compose.yml|k8s.yaml|schema.sql   into diagram code
  arch to     diagram.arch drawio|mermaid|plantuml|json`;

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

/** A pull-request comment: what changed in a diagram, its code and its Terraform. */
function markdownDiff(name: string, a: DiagramModel, b: DiagramModel): string {
  const changes = describeChanges(a, b);
  const code = lineDiff(toCode(a), toCode(b));
  const tf = terraformDiff(a, b);
  const out: string[] = [`### \`${name}\``, ""];
  if (!changes.length && !code.some((l) => l.op !== "eq")) return out.concat("No changes to the diagram.", "", "").join("\n");
  const counts = ["added", "changed", "removed"].map((k) => `${changes.filter((c) => c.change === k).length} ${k}`).join(", ");
  out.push(`**${counts}**`, "");
  for (const c of changes) {
    const what = c.target === "connection" ? c.detail : `${(c.label || c.id).replace(/\n/g, " ")} (${c.detail})`;
    out.push(`- ${c.change === "added" ? "➕" : c.change === "removed" ? "➖" : "✏️"} ${c.target} **${what}**`);
    for (const f of c.fields) out.push(`  - ${f.field}: \`${f.from}\` → \`${f.to}\``);
  }
  if (tf.resourcesAdded.length || tf.resourcesRemoved.length || tf.files.some((f) => f.status !== "unchanged")) {
    out.push("", "**Terraform**", "");
    if (!tf.resourcesAdded.length && !tf.resourcesRemoved.length) out.push("Settings change in place; no resources created or destroyed.");
    for (const r of tf.resourcesAdded) out.push(`- create \`${r}\``);
    for (const r of tf.resourcesRemoved) out.push(`- destroy \`${r}\``);
  }
  const shown = hunks(code, 2).flatMap((h, i) => [...(i ? ["@@"] : []), ...h.lines.map((l) => `${l.op === "add" ? "+" : l.op === "del" ? "-" : " "} ${l.text}`)]);
  out.push("", "<details><summary>Diagram code diff</summary>", "", "```diff", ...shown.slice(0, 400), "```", "", "</details>", "");
  return out.join("\n");
}

switch (cmd) {
  case "check": {
    if (!args[0]) usage();
    const m = load(args[0]);
    const issues = validateModel(m).filter((i) => i.severity === "error");
    for (const i of issues) console.error(`${args[0]}: ${red("error")} ${i.nodeId ? `${i.nodeId}: ` : ""}${i.message}`);
    if (issues.length) process.exit(1);
    console.log(`${args[0]}: ${m.nodes.length} items, ${m.edges.length} lines ${green("ok")}`);
    break;
  }
  case "fmt": {
    if (!args[0]) usage();
    const out = toCode(load(args[0]));
    if (args.includes("--write") && args[0] !== "-") writeFileSync(args[0], out);
    else process.stdout.write(out);
    break;
  }
  case "diff": {
    const files = args.filter((x) => !x.startsWith("--"));
    if (files.length < 2) usage();
    const [a, b] = [load(files[0]), load(files[1])];
    if (args.includes("--markdown")) {
      process.stdout.write(markdownDiff(files[1].replace(/^[^:]*:(?=.)/, ""), a, b));
      break;
    }
    const changes = describeChanges(a, b);
    console.log(`${changes.length ? "" : "No changes to the diagram.\n"}${changes
      .map((c) => {
        const mark = c.change === "added" ? green("+") : c.change === "removed" ? red("-") : "~";
        const fields = c.fields.map((f) => `\n    ${f.field}: ${red(f.from)} → ${green(f.to)}`).join("");
        return `${mark} ${c.target} ${c.target === "connection" ? c.detail : `${c.label || c.id} (${c.detail})`}${fields}`;
      })
      .join("\n")}`);
    const code = lineDiff(toCode(a), toCode(b));
    if (code.some((l) => l.op !== "eq")) {
      console.log("\nDiagram code:");
      printDiff(code);
    }
    const tf = terraformDiff(a, b);
    if (tf.files.some((f) => f.status !== "unchanged")) {
      console.log("\nTerraform:");
      for (const r of tf.resourcesAdded) console.log(green(`  + create ${r}`));
      for (const r of tf.resourcesRemoved) console.log(red(`  - destroy ${r}`));
      for (const f of tf.files.filter((f) => f.status !== "unchanged")) {
        console.log(`\n${f.path} ${green(`+${f.added}`)} ${red(`-${f.removed}`)}`);
        printDiff(f.lines);
      }
    }
    // Like git diff --exit-code: 1 when something changed, for CI checks.
    if (args.includes("--exit-code") && (changes.length || code.some((l) => l.op !== "eq"))) process.exit(1);
    break;
  }
  case "terraform": {
    if (!args[0]) usage();
    const m = load(args[0]);
    const out = args[1] ?? "terraform";
    const tf = compileTerraform(m);
    mkdirSync(out, { recursive: true });
    for (const f of tf.files) {
      mkdirSync(path.dirname(path.join(out, f.path)), { recursive: true });
      writeFileSync(path.join(out, f.path), f.content);
    }
    for (const w of tf.warnings) console.error(`warning: ${w.nodeId ? `${w.nodeId}: ` : ""}${w.message}`);
    console.log(`Wrote ${tf.files.length} files (${tf.resources.length} resources) to ${out}/`);
    break;
  }
  case "review": {
    if (!args[0]) usage();
    const issues = validateModel(load(args[0]));
    if (!issues.length) console.log(green("No issues found."));
    for (const i of issues) console.log(`${i.severity === "error" ? red(i.severity) : i.severity}: ${i.nodeId ? `${i.nodeId}: ` : ""}${i.message}`);
    if (issues.some((i) => i.severity === "error")) process.exit(1);
    break;
  }
  case "from": {
    if (!args[0]) usage();
    const src = read(args[0]);
    let m: DiagramModel;
    if (/\.(drawio|xml)$/i.test(args[0]) || src.trimStart().startsWith("<")) m = drawioPagesToModel(await readDrawio(src));
    else if (detectSource(args[0], src)) m = importSource(args[0], src);
    else {
      const json = JSON.parse(src);
      m = DiagramModelSchema.parse(json.model ?? json);
    }
    process.stdout.write(toCode(m));
    break;
  }
  case "to": {
    if (args.length < 2) usage();
    const m = load(args[0]);
    const fmt = args[1];
    const out =
      fmt === "drawio" ? toDrawio(m) : fmt === "mermaid" ? toMermaid(m) : fmt === "plantuml" ? toPlantUml(m) : fmt === "json" ? JSON.stringify(m, null, 2) + "\n" : usage();
    process.stdout.write(out);
    break;
  }
  default:
    usage();
}

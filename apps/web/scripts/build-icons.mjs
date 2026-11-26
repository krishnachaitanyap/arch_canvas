// Builds the bundled icon packs into public/icons/<pack>.json, loaded by the app on demand.
//   aws     AWS Architecture Icons (official SVGs via the `aws-icons` package); AWS permits
//           their use in architecture diagrams.
//   lucide  Lucide (ISC): generic architecture icons (server, database, queue, user…)
//   logos   SVG Logos by Gil Barbara (CC0): ~2,300 technology logos (Postgres, Kafka, K8s…)
// Google Cloud icons are not bundled: people upload Google's official zip in the app.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const out = path.join(import.meta.dirname, "..", "public", "icons");
mkdirSync(out, { recursive: true });

const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
const write = (pack) => {
  writeFileSync(path.join(out, `${pack.id}.json`), JSON.stringify(pack));
  return { ...pack, icons: undefined, count: pack.icons.length };
};
const titleCase = (s) => s.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase()).trim();

// ---- AWS
function aws() {
  const root = path.join(pkgDir("aws-icons"), "icons");
  const icons = [];
  const groups = [
    ["architecture-service", "Services"],
    ["architecture-group", "Groups"],
    ["resource", "Resources"],
  ];
  for (const [dir, category] of groups) {
    const full = path.join(root, dir);
    if (!existsSync(full)) continue;
    for (const file of readdirSync(full).filter((f) => f.endsWith(".svg")).sort()) {
      const svg = readFileSync(path.join(full, file), "utf8");
      // <title>Icon-Architecture/48/Arch_AWS-Lambda_48</title> → "AWS Lambda"
      const raw = svg.match(/<title>([^<]*)<\/title>/)?.[1]?.split("/").pop() ?? file.replace(/\.svg$/, "");
      const title = raw
        .replace(/^(Arch|Res|Arch-Category|Arch-Group)_/i, "")
        .replace(/_(16|32|48|64)(_Light|_Dark)?$/i, "")
        .replace(/[-_]+/g, " ")
        .trim();
      icons.push({ n: file.replace(/\.svg$/, ""), t: title || file, c: category, s: svg.replace(/<title>[^<]*<\/title>/, "") });
    }
  }
  return write({
    id: "aws",
    name: "AWS Architecture Icons",
    family: "aws",
    license: "AWS Architecture Icons terms (use in architecture diagrams)",
    url: "https://aws.amazon.com/architecture/icons/",
    icons,
  });
}

// ---- Iconify sets (Lucide, Logos)
function iconify(id, pkg, name, family, license, url, color) {
  const set = require(`${pkg}/icons.json`);
  const icons = Object.entries(set.icons).map(([n, def]) => {
    const w = def.width ?? set.width ?? 16;
    const h = def.height ?? set.height ?? 16;
    let body = def.body;
    if (color) body = body.replaceAll("currentColor", color);
    return { n, t: titleCase(n), s: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${def.left ?? 0} ${def.top ?? 0} ${w} ${h}">${body}</svg>` };
  });
  return write({ id, name, family, license, url, icons });
}

const index = [
  aws(),
  iconify("lucide", "@iconify-json/lucide", "Lucide", "generic", "ISC", "https://lucide.dev", "#3f3f46"),
  iconify("logos", "@iconify-json/logos", "Technology logos (SVG Logos)", "logos", "CC0-1.0", "https://github.com/gilbarbara/logos"),
];
writeFileSync(path.join(out, "index.json"), JSON.stringify(index));
console.log(`icon packs -> ${path.relative(process.cwd(), out)}: ${index.map((p) => `${p.id} (${p.count})`).join(", ")}`);

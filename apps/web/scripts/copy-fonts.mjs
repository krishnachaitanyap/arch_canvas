// Self-host Excalidraw fonts so the app works air-gapped (no CDN calls).
import { cpSync, existsSync } from "node:fs";
import path from "node:path";

// Walk up from this app to find the (possibly hoisted) package in node_modules.
function findPkgDir(start) {
  for (let dir = start; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", "@excalidraw", "excalidraw");
    if (existsSync(candidate)) return candidate;
    if (dir === path.dirname(dir)) throw new Error("@excalidraw/excalidraw is not installed");
  }
}
const pkgDir = findPkgDir(path.join(import.meta.dirname, ".."));
const src = path.join(pkgDir, "dist", "prod", "fonts");
const dest = path.join(import.meta.dirname, "..", "public", "fonts");
if (!existsSync(src)) throw new Error(`Excalidraw fonts not found at ${src}`);
cpSync(src, dest, { recursive: true });
console.log(`copied Excalidraw fonts -> ${path.relative(process.cwd(), dest)}`);

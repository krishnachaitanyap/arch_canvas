// Takes the README screenshots from the demo build with headless Chrome (no extra deps:
// Chrome DevTools Protocol over Node's built-in WebSocket).
//
//   VITE_DEMO=1 VITE_BASE=/arch_canvas/ npm run build -w @archcanvas/web
//   node node_modules/vite/bin/vite.js preview apps/web --port 5180 --base /arch_canvas/ &
//   node scripts/screenshots.mjs [http://localhost:5180/arch_canvas/]
//
// Set CHROME to the browser binary if it isn't in the default macOS/Linux location.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const url = process.argv[2] ?? "http://localhost:5180/arch_canvas/";
const outDir = path.join(import.meta.dirname, "..", "docs", "screenshots");
const W = 1600;
const H = 1000;
const chrome =
  process.env.CHROME ??
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
mkdirSync(outDir, { recursive: true });

const port = 9333;
const proc = spawn(
  chrome,
  ["--headless=new", `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, "--hide-scrollbars", "--no-first-run", `--user-data-dir=${mkdtempSync(path.join(tmpdir(), "archcanvas-shots-"))}`, "about:blank"],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
let nextId = 1;
const pending = new Map();
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n in: ${expr.slice(0, 200)}`);
  return r.result.value;
}
async function shot(name) {
  await sleep(700);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, "base64"));
  console.log(`  ${name}.png`);
}
// Click the first element matching a selector (and optional text).
const click = (selector, text) =>
  js(`
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = els.find((e) => ${text ? `e.textContent.trim().startsWith(${JSON.stringify(text)})` : "true"});
    if (!el) throw new Error("not found: ${selector} ${text ?? ""}");
    el.scrollIntoView({ block: "center" });
    el.click();
  `);
const waitFor = (selector, ms = 10000) =>
  js(`
    const t = Date.now();
    while (!document.querySelector(${JSON.stringify(selector)})) {
      if (Date.now() - t > ${ms}) throw new Error("timeout waiting for ${selector}");
      await new Promise((r) => setTimeout(r, 100));
    }
  `);
const key = async (k, code) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: code === "ArrowRight" ? 39 : 0 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code });
};

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((r) => r.json())
      .then((l) => l.find((t) => t.type === "page"))
      .catch(() => undefined);
  }
  if (!target) throw new Error("Chrome did not start");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    }
  });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await send("Page.navigate", { url });
  await waitFor(".card");
  console.log(`Capturing ${url} -> ${path.relative(process.cwd(), outDir)}`);

  // 1. Home: workspace, projects, diagram cards, draw.io drop zone
  await shot("home");

  // 2. Editor with the GCP web app
  await click(".card-main");
  await waitFor(".react-flow__node");
  await sleep(1500);
  await shot("editor");

  // 3. Flows tab with a highlighted step
  await click(".inspector .tabs button", "Flows");
  await sleep(400);
  await js(`document.querySelectorAll(".workflow li .link")[1].click();`);
  await sleep(900);
  await shot("flows");

  // 4. Terraform tab
  await click(".inspector .tabs button", "Terraform");
  await shot("terraform");

  // 5. Presentation, on a step slide
  await click(".toolbar-slot button", "Present");
  await waitFor(".present");
  for (let i = 0; i < 4; i++) await key("ArrowRight", "ArrowRight");
  await sleep(1200);
  await shot("presentation");
  await key("Escape", "Escape");
  await sleep(300);

  // 6. Version history: compare v1 → v3
  await click(".version-badge");
  await waitFor(".history .version-list");
  await js(`
    const [a, b] = document.querySelectorAll(".history-head select");
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    set.call(a, "v:1"); a.dispatchEvent(new Event("change", { bubbles: true }));
    set.call(b, "v:3"); b.dispatchEvent(new Event("change", { bubbles: true }));
  `);
  await waitFor(".diff-canvas .react-flow__node");
  await sleep(1500);
  await shot("compare");

  // 7. Icon library (AWS icons) in the palette
  await click(".history-head button", "Close");
  await click(".palette .tabs button", "Icons");
  await waitFor(".icon-tile");
  await js(`
    const i = document.querySelector('input[aria-label="Search icons"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, "database");
    i.dispatchEvent(new Event("input", { bubbles: true }));
  `);
  await sleep(1200);
  await shot("icons");

  // 8. draw.io import review (drop the AWS example on the project page)
  await click("button.logo");
  await waitFor(".dropzone");
  const drawio = readFileSync(path.join(import.meta.dirname, "..", "docs", "examples", "aws-orders.drawio"), "utf8");
  await js(`
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(drawio)}], "aws-orders.drawio", { type: "application/xml" }));
    const z = document.querySelector(".dropzone");
    z.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  `);
  await waitFor(".import-preview .react-flow__node");
  await sleep(1500);
  await shot("import");
  console.log("Done.");
} finally {
  ws?.close();
  proc.kill();
}

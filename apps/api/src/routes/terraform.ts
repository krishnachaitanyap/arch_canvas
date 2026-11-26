import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { compileTerraform, DiagramModelSchema } from "@archcanvas/shared";
import { config } from "../config.js";

const run = promisify(execFile);
const body = z.object({ model: DiagramModelSchema });

interface Diagnostic {
  severity: string;
  summary: string;
  detail?: string;
  file?: string;
  line?: number;
}

/**
 * POST /api/terraform/validate — compiles the model and runs `terraform fmt -check` and
 * `terraform validate` on the result in a throwaway directory. `init` needs to reach the
 * provider registry (or a configured mirror for air-gapped installs).
 */
export async function terraformRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/terraform/validate", async (req, reply) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const out = compileTerraform(parsed.data.model);

    try {
      await run(config.TERRAFORM_BIN, ["version"], { timeout: 10_000 });
    } catch {
      return { available: false, message: `Terraform is not installed on the server (${config.TERRAFORM_BIN} not found).` };
    }

    const dir = await mkdtemp(path.join(tmpdir(), "archcanvas-tf-"));
    const env = { ...process.env, TF_IN_AUTOMATION: "1", TF_PLUGIN_CACHE_DIR: path.join(tmpdir(), "archcanvas-tf-plugins") };
    try {
      await run("mkdir", ["-p", env.TF_PLUGIN_CACHE_DIR]);
      for (const f of out.files) await writeFile(path.join(dir, f.path), f.content);
      const tf = (args: string[]) => run(config.TERRAFORM_BIN, args, { cwd: dir, env, timeout: 180_000, maxBuffer: 10 * 1024 * 1024 });

      const fmt = await tf(["fmt", "-check", "-list=true"]).then(
        () => [] as string[],
        (e: { stdout?: string }) => (e.stdout ?? "").split("\n").filter(Boolean),
      );
      try {
        await tf(["init", "-backend=false", "-input=false", "-no-color"]);
      } catch (e) {
        return { available: true, valid: false, stage: "init", fmt, diagnostics: [{ severity: "error", summary: "terraform init failed", detail: tail((e as { stderr?: string }).stderr) }] };
      }
      const res = await tf(["validate", "-json", "-no-color"]).then(
        (r) => r.stdout,
        (e: { stdout?: string }) => e.stdout ?? "{}",
      );
      const json = JSON.parse(res) as {
        valid: boolean;
        diagnostics?: { severity: string; summary: string; detail?: string; range?: { filename: string; start: { line: number } } }[];
      };
      const diagnostics: Diagnostic[] = (json.diagnostics ?? []).map((d) => ({
        severity: d.severity,
        summary: d.summary,
        detail: d.detail,
        file: d.range?.filename,
        line: d.range?.start.line,
      }));
      return { available: true, valid: json.valid, stage: "validate", fmt, diagnostics };
    } catch (err) {
      req.log.error({ err }, "terraform validation failed");
      return reply.code(500).send({ error: (err as Error).message });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

const tail = (s = "") => s.split("\n").slice(-15).join("\n");

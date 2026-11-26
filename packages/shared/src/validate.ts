import { catalogEntry, resolvedProps } from "./catalog.js";
import { type DiagramModel, nearestAncestor, nodeById } from "./model.js";
import { compileTerraform } from "./terraform.js";

export type Severity = "error" | "warning" | "suggestion";
export interface Issue {
  severity: Severity;
  nodeId?: string;
  message: string;
}

/**
 * Deterministic architecture review: structural errors, deployability warnings (from the
 * Terraform compiler) and best-practice suggestions. The agent's review builds on this.
 */
export function validateModel(m: DiagramModel): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set<string>();
  for (const n of m.nodes) {
    if (ids.has(n.id)) issues.push({ severity: "error", nodeId: n.id, message: `duplicate id ${n.id}` });
    ids.add(n.id);
    const entry = catalogEntry(n.kind);
    if (!entry) issues.push({ severity: "error", nodeId: n.id, message: `unknown kind ${n.kind}` });
    if (n.parentId) {
      const parent = nodeById(m, n.parentId);
      if (!parent) issues.push({ severity: "error", nodeId: n.id, message: `parent ${n.parentId} does not exist` });
      else if (entry && !entry.parents.includes(parent.kind))
        issues.push({ severity: "error", nodeId: n.id, message: `${entry.label} cannot be inside ${parent.label}` });
    }
  }
  for (const e of m.edges)
    if (!ids.has(e.from) || !ids.has(e.to))
      issues.push({ severity: "error", message: `connection ${e.from} → ${e.to} points at a missing node` });

  for (const w of compileTerraform(m).warnings) issues.push({ severity: "warning", ...w });

  // Best-practice suggestions
  const incoming = (id: string) => m.edges.filter((e) => e.to === id).map((e) => nodeById(m, e.from)!).filter(Boolean);
  for (const n of m.nodes) {
    const p = resolvedProps(n.kind, n.props);
    if (n.kind === "gcp.cloud_run") {
      const callers = incoming(n.id);
      const fromUsers = callers.some((c) => c.kind === "generic.client");
      const viaLb = callers.some((c) => c.kind === "gcp.load_balancer");
      if (fromUsers && !viaLb && !p.public)
        issues.push({
          severity: "warning",
          nodeId: n.id,
          message: `users call ${n.label} directly but it requires authentication; put a load balancer in front or allow unauthenticated`,
        });
      if (fromUsers && !viaLb && p.public)
        issues.push({
          severity: "suggestion",
          nodeId: n.id,
          message: `${n.label} is public without a load balancer; add one for Cloud Armor (WAF) and a custom domain`,
        });
    }
    if (n.kind === "gcp.cloud_sql" && !p.high_availability)
      issues.push({ severity: "suggestion", nodeId: n.id, message: `${n.label} is single-zone; enable high availability for production` });
    if (n.kind === "gcp.cloud_sql" && !nearestAncestor(m, n.id, "gcp.vpc"))
      issues.push({ severity: "suggestion", nodeId: n.id, message: `place ${n.label} inside a VPC for a private IP` });
    if (n.kind === "gcp.memorystore_redis" && p.tier === "BASIC")
      issues.push({ severity: "suggestion", nodeId: n.id, message: `${n.label} uses the BASIC tier (no replica); use STANDARD_HA for production` });
    if (n.kind === "gcp.load_balancer" && !p.cloud_armor)
      issues.push({ severity: "suggestion", nodeId: n.id, message: `enable Cloud Armor on ${n.label}` });
  }
  return issues;
}

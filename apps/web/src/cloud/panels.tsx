import { useEffect, useMemo, useState } from "react";
import JSZip from "jszip";
import {
  CATALOG,
  type Category,
  catalogEntry,
  compileTerraform,
  type DiagramModel,
  type Issue,
  type Op,
  describeEdge,
  PROTOCOLS,
  type PropSpec,
  resolvedProps,
} from "@archcanvas/shared";
import { api, type TerraformValidation } from "../api";
import { ResourceIcon } from "./flow";
import { download } from "./exporters";
import { slug } from "../util";
import { IntegrationCard } from "./FlowsPanel";
import { IconLibrary } from "../icons/IconLibrary";
import type { SearchHit } from "../icons/registry";
import { Modal } from "../home/Home";

// ------------------------------------------------------------------ properties

export type Selection = { type: "node" | "edge"; id: string } | null;

export function Properties({
  model,
  selection,
  onOp,
  readOnly,
}: {
  model: DiagramModel;
  selection: Selection;
  onOp: (op: Op) => void;
  readOnly: boolean;
}) {
  if (!selection) return <p className="hint pad">Select a resource or connection to edit it.</p>;
  if (selection.type === "edge") {
    const e = model.edges.find((x) => x.id === selection.id);
    if (!e) return null;
    const from = model.nodes.find((n) => n.id === e.from);
    const to = model.nodes.find((n) => n.id === e.to);
    return (
      <div className="props">
        <h3>
          {from?.label} → {to?.label}
        </h3>
        <EdgeLabelField key={e.id} value={e.label ?? ""} disabled={readOnly} onCommit={(v) => onOp({ op: "update_edge", from: e.from, to: e.to, label: v || null })} />
        <label>
          Protocol
          <select
            value={e.protocol ?? ""}
            disabled={readOnly}
            onChange={(ev) => onOp({ op: "update_edge", from: e.from, to: e.to, protocol: (ev.target.value || null) as never })}
          >
            <option value="">—</option>
            {PROTOCOLS.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          Line style
          <select
            value={e.routing ?? "orthogonal"}
            disabled={readOnly}
            onChange={(ev) => onOp({ op: "update_edge", from: e.from, to: e.to, routing: ev.target.value === "orthogonal" ? null : (ev.target.value as never) })}
          >
            <option value="orthogonal">Orthogonal</option>
            <option value="straight">Straight</option>
            <option value="curved">Curved</option>
          </select>
        </label>
        <p className="hint">Drag either end of the line on the canvas to reconnect it. Double-click the label to edit it in place.</p>
        <button disabled={readOnly} onClick={() => onOp({ op: "disconnect", from: e.from, to: e.to })}>
          Delete connection
        </button>
        {(() => {
          const info = describeEdge(model, e);
          return info ? (
            <>
              <h3>How this integration works</h3>
              <IntegrationCard integration={info} />
            </>
          ) : null;
        })()}
      </div>
    );
  }
  const node = model.nodes.find((n) => n.id === selection.id);
  if (!node) return null;
  return <NodeProperties key={node.id} model={model} nodeId={node.id} onOp={onOp} readOnly={readOnly} />;
}

function EdgeLabelField({ value, disabled, onCommit }: { value: string; disabled: boolean; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label>
      Label
      <input
        value={draft}
        disabled={disabled}
        placeholder="e.g. reads orders"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onCommit(draft.trim())}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

function NodeProperties({ model, nodeId, onOp, readOnly }: { model: DiagramModel; nodeId: string; onOp: (op: Op) => void; readOnly: boolean }) {
  const node = model.nodes.find((n) => n.id === nodeId)!;
  const entry = catalogEntry(node.kind);
  const props = resolvedProps(node.kind, node.props);
  const [label, setLabel] = useState(node.label);
  useEffect(() => setLabel(node.label), [node.label]);
  const parents = model.nodes.filter((p) => entry?.parents.includes(p.kind) && p.id !== node.id);

  return (
    <div className="props">
      <h3>
        <ResourceIcon kind={node.kind} icon={node.icon} size={22} /> {entry?.label ?? node.kind}
      </h3>
      <p className="hint">{entry?.description}</p>
      <label>
        Name
        <input
          value={label}
          disabled={readOnly}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label.trim() && label !== node.label && onOp({ op: "update_node", id: node.id, label: label.trim() })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </label>
      <IconField node={node} onOp={onOp} readOnly={readOnly} />
      <label>
        Id <span className="hint">(Terraform name)</span>
        <input value={node.id} disabled />
      </label>
      <label>
        Inside
        <select
          value={node.parentId ?? ""}
          disabled={readOnly}
          onChange={(e) => onOp({ op: "update_node", id: node.id, parentId: e.target.value || null })}
        >
          <option value="">Top level</option>
          {parents.map((p) => (
            <option key={p.id} value={p.id}>
              {catalogEntry(p.kind)?.label}: {p.label}
            </option>
          ))}
        </select>
      </label>
      {entry?.props.map((spec) => (
        <PropField
          key={spec.key}
          spec={spec}
          value={props[spec.key]}
          disabled={readOnly}
          onChange={(v) => onOp({ op: "update_node", id: node.id, props: { [spec.key]: v } })}
        />
      ))}
      <button className="danger" disabled={readOnly} onClick={() => onOp({ op: "remove_node", id: node.id })}>
        Delete {entry?.container ? "group" : "resource"}
      </button>
    </div>
  );
}

function IconField({ node, onOp, readOnly }: { node: { id: string; kind: string; label: string; icon?: string }; onOp: (op: Op) => void; readOnly: boolean }) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="icon-field">
      <ResourceIcon kind={node.kind} icon={node.icon} size={36} />
      <div className="row wrap">
        <button disabled={readOnly} onClick={() => setPicking(true)}>
          Change icon…
        </button>
        {node.icon && (
          <button disabled={readOnly} onClick={() => onOp({ op: "update_node", id: node.id, icon: null })}>
            Default
          </button>
        )}
      </div>
      {picking && (
        <Modal title={`Icon for ${node.label}`} onClose={() => setPicking(false)} wide>
          <IconLibrary
            initialQuery={node.label}
            onPick={(hit) => {
              onOp({ op: "update_node", id: node.id, icon: hit.ref });
              setPicking(false);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function PropField({
  spec,
  value,
  disabled,
  onChange,
}: {
  spec: PropSpec;
  value: string | number | boolean;
  disabled: boolean;
  onChange: (v: string | number | boolean) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  if (spec.type === "boolean")
    return (
      <label className="check" title={spec.description}>
        <input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        {spec.label}
      </label>
    );
  if (spec.type === "enum")
    return (
      <label title={spec.description}>
        {spec.label}
        <select value={String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {spec.options!.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </label>
    );
  const commit = () => {
    if (draft === String(value)) return;
    if (spec.type === "number") {
      const n = Number(draft);
      if (Number.isFinite(n)) onChange(n);
      else setDraft(String(value));
    } else onChange(draft);
  };
  return (
    <label title={spec.description}>
      {spec.label}
      <input
        type={spec.type === "number" ? "number" : "text"}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {spec.description && <span className="hint">{spec.description}</span>}
    </label>
  );
}

// ------------------------------------------------------------------ review

export function Review({ issues, onSelect }: { issues: Issue[]; onSelect: (id: string) => void }) {
  if (!issues.length) return <p className="hint pad">No issues found.</p>;
  const order = { error: 0, warning: 1, suggestion: 2 };
  return (
    <ul className="issues">
      {[...issues]
        .sort((a, b) => order[a.severity] - order[b.severity])
        .map((i, k) => (
          <li key={k} className={i.severity}>
            <span className="sev">{i.severity}</span>
            {i.nodeId ? (
              <button className="link" onClick={() => onSelect(i.nodeId!)}>
                {i.message}
              </button>
            ) : (
              <span>{i.message}</span>
            )}
          </li>
        ))}
    </ul>
  );
}

// ------------------------------------------------------------------ terraform

export function TerraformPanel({ model, title }: { model: DiagramModel; title: string }) {
  const out = useMemo(() => compileTerraform(model), [model]);
  const [file, setFile] = useState("main.tf");
  const [validation, setValidation] = useState<TerraformValidation | null>(null);
  const [validating, setValidating] = useState(false);
  useEffect(() => setValidation(null), [out]);
  const current = out.files.find((f) => f.path === file) ?? out.files[0];

  async function zip() {
    const z = new JSZip();
    const dir = z.folder(slug(title))!;
    for (const f of out.files) dir.file(f.path, f.content);
    dir.file(
      "README.md",
      `# ${title}\n\nGenerated by ArchCanvas.\n\n\`\`\`bash\nterraform init\nterraform plan -var project_id=YOUR_PROJECT\n\`\`\`\n`,
    );
    download(`${slug(title)}-terraform.zip`, await z.generateAsync({ type: "blob" }));
  }

  async function validate() {
    setValidating(true);
    try {
      setValidation(await api.validateTerraform(model));
    } catch (e) {
      setValidation({ available: true, valid: false, diagnostics: [{ severity: "error", summary: (e as Error).message }] });
    } finally {
      setValidating(false);
    }
  }

  return (
    <div className="tf">
      <div className="row wrap">
        <button className="primary" onClick={() => void zip()} disabled={!model.nodes.length}>
          Download .zip
        </button>
        <button onClick={() => void validate()} disabled={validating || !model.nodes.length}>
          {validating ? "Validating…" : "Validate"}
        </button>
        <button onClick={() => void navigator.clipboard.writeText(current.content)}>Copy file</button>
        <span className="hint">{out.resources.length} resources</span>
      </div>
      {validation && <ValidationResult v={validation} />}
      {out.warnings.length > 0 && (
        <ul className="issues compact">
          {out.warnings.map((w, i) => (
            <li key={i} className="warning">
              <span className="sev">note</span>
              <span>{w.message}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="tabs small">
        {out.files.map((f) => (
          <button key={f.path} className={f.path === current.path ? "active" : ""} onClick={() => setFile(f.path)}>
            {f.path}
          </button>
        ))}
      </div>
      <pre className="code-view">{current.content}</pre>
    </div>
  );
}

function ValidationResult({ v }: { v: TerraformValidation }) {
  if (!v.available) return <p className="banner warn">{v.message} Install Terraform on the API host to validate.</p>;
  return (
    <div className={`banner ${v.valid ? "ok" : "bad"}`}>
      {v.valid ? "terraform validate: passed" : `terraform ${v.stage ?? "validate"}: failed`}
      {v.fmt?.length ? <div>terraform fmt would change: {v.fmt.join(", ")}</div> : null}
      {v.diagnostics?.map((d, i) => (
        <div key={i}>
          <b>{d.severity}</b>: {d.summary}
          {d.file ? ` (${d.file}:${d.line})` : ""}
          {d.detail ? <pre>{d.detail}</pre> : null}
        </div>
      ))}
    </div>
  );
}


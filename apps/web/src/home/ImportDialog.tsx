import { useMemo, useState } from "react";
import {
  CATALOG,
  type Confidence,
  type DiagramModel,
  type DrawioPage,
  drawioPagesToModel,
  drawioToModel,
  generateWorkflows,
  type ImportItem,
} from "@archcanvas/shared";
import { StaticCanvas } from "../cloud/DiffCanvas";
import { Modal } from "./Home";

const RANK: Record<Confidence, number> = { none: 0, low: 1, medium: 2, high: 3, exact: 4 };
const GROUP_KINDS = CATALOG.filter((c) => c.container);
const RESOURCE_KINDS = CATALOG.filter((c) => !c.container);

/**
 * Review a draw.io import before it becomes a diagram: what each shape was mapped to and why,
 * with a live preview. Unrecognised and low-confidence shapes are listed first.
 */
export default function ImportDialog({
  fileName,
  pages,
  onImport,
  onClose,
  merge = false,
}: {
  fileName: string;
  pages: DrawioPage[];
  onImport: (title: string, model: DiagramModel) => void;
  onClose: () => void;
  /** Adding to the open diagram rather than creating a new one. */
  merge?: boolean;
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const [overrides, setOverrides] = useState<Record<string, string | null>>({});
  const baseName = fileName.replace(/(\.drawio)?\.(drawio|xml|svg)$/i, "");
  const [title, setTitle] = useState(pages.length > 1 ? `${baseName} – ${pages[0].name}` : baseName);
  const [showAll, setShowAll] = useState(false);
  // A multi-page file becomes one diagram with a canvas tab per page (unless adding into a diagram).
  const [allPages, setAllPages] = useState(!merge && pages.length > 1);
  const [pageOverrides, setPageOverrides] = useState<Record<number, Record<string, string | null>>>({});
  const page = pages[pageIndex];

  const result = useMemo(() => drawioToModel(page, overrides), [page, overrides]);
  const workflows = useMemo(() => generateWorkflows(result.model), [result.model]);
  const resources = result.model.nodes.filter((n) => !CATALOG.find((c) => c.kind === n.kind)?.container).length;
  const groups = result.model.nodes.length - resources;
  const review = result.items.filter((i) => !i.container && RANK[i.confidence] <= 1);
  const items = [...result.items].sort((a, b) => RANK[a.confidence] - RANK[b.confidence] || Number(b.container) - Number(a.container));
  const shown = showAll ? items : items.filter((i) => RANK[i.confidence] <= 2);

  const set = (item: ImportItem, kind: string | null) => setOverrides((o) => ({ ...o, [item.cellId]: kind }));

  return (
    <Modal title={merge ? `Add ${fileName} to this diagram` : `Import ${fileName}`} onClose={onClose} wide>
      <div className="import">
        <div className="import-top">
          <label hidden={merge}>
            Diagram name
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          {pages.length > 1 && (
            <label>
              Page
              <select
                value={pageIndex}
                onChange={(e) => {
                  const i = Number(e.target.value);
                  setPageOverrides((o) => ({ ...o, [pageIndex]: overrides }));
                  setPageIndex(i);
                  setOverrides(pageOverrides[i] ?? {});
                  if (!allPages) setTitle(`${baseName} – ${pages[i].name}`);
                }}
              >
                {pages.map((p, i) => (
                  <option key={p.id} value={i}>
                    {p.name} ({p.cells.filter((c) => c.vertex).length} shapes)
                  </option>
                ))}
              </select>
            </label>
          )}
          {pages.length > 1 && !merge && (
            <label className="check">
              <input
                type="checkbox"
                checked={allPages}
                onChange={(e) => {
                  setAllPages(e.target.checked);
                  setTitle(e.target.checked ? baseName : `${baseName} – ${page.name}`);
                }}
              />
              Import all {pages.length} pages as canvas tabs
            </label>
          )}
        </div>

        <p className="import-summary">
          <b>{resources}</b> resources · <b>{groups}</b> groups · <b>{result.model.edges.length}</b> connections · <b>{workflows.length}</b> workflow
          {workflows.length === 1 ? "" : "s"}
          {review.length > 0 && (
            <>
              {" "}
              · <span className="warn-text">{review.length} to review</span>
            </>
          )}
          {result.layoutKept ? " · positions kept" : " · will be auto-laid out"}
        </p>

        <div className="import-body">
          <div className="import-list">
            <table>
              <thead>
                <tr>
                  <th>Shape in draw.io</th>
                  <th>Becomes</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.cellId} className={`conf-${i.confidence}`}>
                    <td>
                      {i.container && <span className="mode doc">group</span>} {i.label}
                    </td>
                    <td>
                      <select value={i.kind ?? ""} onChange={(e) => set(i, e.target.value || null)} aria-label={`Type for ${i.label}`}>
                        <option value="">{i.container ? "— keep contents only" : "— skip"}</option>
                        {(i.container ? GROUP_KINDS : RESOURCE_KINDS).map((c) => (
                          <option key={c.kind} value={c.kind}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <span className={`conf ${i.confidence}`}>{i.confidence === "none" ? "unmatched" : i.confidence}</span> <span className="hint">{i.reason}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {items.length > shown.length && (
              <button className="link small" onClick={() => setShowAll(true)}>
                Show {items.length - shown.length} confidently matched shapes
              </button>
            )}
            {!items.length && <p className="hint pad">No shapes found on this page.</p>}
            {result.warnings.length > 0 && (
              <ul className="import-warnings">
                {result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="import-preview">
            {result.model.nodes.length ? (
              <StaticCanvas key={pageIndex} model={result.model} minimap={false} />
            ) : (
              <p className="hint pad">Nothing to import yet. Pick types for the shapes on the left.</p>
            )}
          </div>
        </div>

        <div className="row end">
          <span className="hint">
            {merge
              ? "The shapes are added to the right of what's already on the canvas. Nothing is saved until you click Save."
              : "After import you get workflows, the architecture doc, a presentation, and Terraform for the Google Cloud parts. Nothing is saved until you click Save."}
          </span>
          <div className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!result.model.nodes.length || !title.trim()} onClick={() => onImport(title.trim(), allPages ? drawioPagesToModel(pages, { ...pageOverrides, [pageIndex]: overrides }) : result.model)}>
            {merge ? `Add ${result.model.nodes.length} shapes to this diagram` : allPages ? `Import ${pages.length} pages as tabs` : `Import ${resources} resources`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

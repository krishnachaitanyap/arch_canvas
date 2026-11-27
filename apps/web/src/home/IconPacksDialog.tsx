import { useState } from "react";
import type { IconFamily } from "@archcanvas/shared";
import { api, type Workspace } from "../api";
import { allPacks, useIconsVersion } from "../icons/registry";
import { type ReadIcons, readIconFiles } from "../icons/upload";
import { Modal } from "./Home";
import { askConfirm } from "../dialogs";

const FAMILIES: [IconFamily, string][] = [
  ["gcp", "Google Cloud (used for GCP resources automatically)"],
  ["aws", "AWS"],
  ["azure", "Azure"],
  ["custom", "Other / custom"],
];

const LICENSE_HINT: Record<IconFamily, string> = {
  gcp: "Google Cloud icons: use in architecture diagrams",
  aws: "AWS Architecture Icons terms",
  azure: "Microsoft Azure architecture icons terms",
  custom: "",
  generic: "",
  logos: "",
};

/** Lists the bundled icon packs and the packs uploaded to this workspace; editors can upload more. */
export function IconPacksDialog({
  workspace,
  onClose,
  onChanged,
  setStatus,
}: {
  workspace: Workspace;
  onClose: () => void;
  onChanged: () => Promise<void>;
  setStatus: (s: { kind: "ok" | "error"; text: string } | null) => void;
}) {
  useIconsVersion();
  const packs = allPacks();
  const canEdit = workspace.role !== "viewer";
  const [read, setRead] = useState<ReadIcons | null>(null);
  const [name, setName] = useState("");
  const [family, setFamily] = useState<IconFamily>("gcp");
  const [license, setLicense] = useState(LICENSE_HINT.gcp);
  const [busy, setBusy] = useState(false);

  async function pick(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    try {
      const r = await readIconFiles(files);
      if (!r.icons.length) throw new Error("No SVG or PNG icons found in those files.");
      setRead(r);
      setName(r.suggestedName);
      setFamily(r.family);
      setLicense(LICENSE_HINT[r.family]);
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function upload() {
    if (!read) return;
    setBusy(true);
    try {
      const res = await api.uploadIconPack(workspace.id, { name: name.trim() || "Icons", family, license, icons: read.icons });
      setStatus({ kind: "ok", text: `Uploaded ${res.count} icons${res.rejected ? ` (${res.rejected} rejected)` : ""}` });
      setRead(null);
      await onChanged();
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Icon packs · ${workspace.name}`} onClose={onClose} wide>
      <table className="members packs">
        <tbody>
          {packs.map((p) => (
            <tr key={p.id}>
              <td>
                <b>{p.name}</b>
                <div className="hint">
                  {p.count} icons · {p.builtIn ? "bundled" : `uploaded by ${p.created_by ?? "someone"}`}
                  {p.family === "gcp" && " · used for GCP resources"}
                </div>
              </td>
              <td className="hint">
                {p.license || "—"}
                {p.url && (
                  <>
                    {" · "}
                    <a href={p.url} target="_blank" rel="noreferrer">
                      source
                    </a>
                  </>
                )}
              </td>
              <td>
                {!p.builtIn && canEdit && (
                  <button
                    className="link danger"
                    onClick={async () => {
                      if (await askConfirm({ title: `Remove the "${p.name}" icon pack?`, message: "Diagrams using its icons fall back to default icons.", confirm: "Remove", danger: true }))
                        void api.deleteIconPack(p.id).then(onChanged, (e) => setStatus({ kind: "error", text: (e as Error).message }));
                    }}
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {canEdit && (
        <div className="upload-box">
          <h3>Upload an icon pack</h3>
          <p className="hint">
            For official Google Cloud icons, download the zip from{" "}
            <a href="https://cloud.google.com/icons" target="_blank" rel="noreferrer">
              cloud.google.com/icons
            </a>{" "}
            and upload it here: GCP resources in this workspace then use them automatically. Any zip of SVG or PNG icons works (newer AWS icons, Azure, your
            company's). Uploads are sanitised and stay in this workspace.
          </p>
          <input type="file" multiple accept=".zip,.svg,.png" disabled={busy} onChange={(e) => void pick([...(e.target.files ?? [])])} aria-label="Choose icon files" />
          {read && (
            <div className="form">
              <p>
                Found <b>{read.icons.length}</b> icons{read.skipped > 0 ? `, skipped ${read.skipped} files` : ""}.
              </p>
              <div className="preview-strip">
                {read.icons.slice(0, 24).map((i) => (
                  <img key={i.n} src={i.s.startsWith("data:") ? i.s : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(i.s)}`} alt={i.t} title={i.t} />
                ))}
              </div>
              <div className="import-top">
                <label>
                  Name
                  <input value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label>
                  Kind
                  <select
                    value={family}
                    onChange={(e) => {
                      const f = e.target.value as IconFamily;
                      setFamily(f);
                      setLicense(LICENSE_HINT[f]);
                    }}
                  >
                    {FAMILIES.map(([f, label]) => (
                      <option key={f} value={f}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  License / terms
                  <input value={license} onChange={(e) => setLicense(e.target.value)} />
                </label>
              </div>
              <div className="row end">
                <button onClick={() => setRead(null)}>Cancel</button>
                <button className="primary" disabled={busy || !name.trim()} onClick={() => void upload()}>
                  {busy ? "Uploading…" : `Upload ${read.icons.length} icons`}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { CATALOG, type CodeError, type DiagramModel, parseCode, PROTOCOLS, toCode } from "@archcanvas/shared";
import { slug } from "../util";
import { download } from "./exporters";

/**
 * The diagram as code, side by side with the canvas (like Eraser's diagram-as-code). Edits
 * apply to the canvas as soon as the code is valid; canvas edits show up here. Positions stay
 * on the canvas, so the code is only what the diagram means.
 */
export function CodePanel({ model, title, readOnly, onApply }: { model: DiagramModel; title: string; readOnly: boolean; onApply: (m: DiagramModel) => void }) {
  const code = useMemo(() => toCode(model), [model]);
  const [text, setText] = useState(code);
  const [errors, setErrors] = useState<CodeError[]>([]);
  const [focused, setFocused] = useState(false);
  /** The canvas changed while the code had edits that couldn't be applied. */
  const [stale, setStale] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const applied = useRef<DiagramModel | null>(null);
  const modelRef = useRef(model);
  modelRef.current = model;

  // Canvas → code. Not while you're typing valid code (it would move the cursor); the code is
  // tidied when you leave the editor.
  useEffect(() => {
    if (applied.current === model) return;
    if (errors.length && text !== code) return setStale(true);
    if (!focused) setText(code);
    setStale(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // Code → canvas, shortly after you stop typing.
  useEffect(() => {
    if (readOnly || text === code) return setErrors([]);
    const t = setTimeout(() => {
      const r = parseCode(text, modelRef.current);
      if (!r.ok) return setErrors(r.errors);
      setErrors([]);
      setStale(false);
      if (toCode(r.model) === toCode(modelRef.current) && JSON.stringify(r.model.settings ?? {}) === JSON.stringify(modelRef.current.settings ?? {})) return;
      applied.current = r.model;
      onApply(r.model);
    }, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, readOnly]);

  const lines = text.split("\n").length;
  const bad = new Set(errors.map((e) => e.line));

  function goTo(line: number) {
    const el = area.current;
    if (!el) return;
    const start = text.split("\n").slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0);
    el.focus();
    el.setSelectionRange(start, start + (text.split("\n")[line - 1]?.length ?? 0));
    el.scrollTop = Math.max(0, (line - 4) * 18);
  }

  return (
    <div className="code-panel">
      <div className="code-bar">
        <span className="hint">{readOnly ? "Read only" : errors.length ? `${errors.length} problem${errors.length === 1 ? "" : "s"}: not applied yet` : "Edits apply to the canvas"}</span>
        <div className="spacer" />
        <button onClick={() => void navigator.clipboard.writeText(text)} title="Copy the code">
          Copy
        </button>
        <button onClick={() => download(`${slug(title) || "diagram"}.arch`, text)} title="Download as an .arch file (keep it in Git; diff and compile it with npm run arch)">
          Download
        </button>
      </div>
      {stale && (
        <div className="code-stale">
          The canvas changed while this code had problems.{" "}
          <button
            className="link"
            onClick={() => {
              setText(code);
              setErrors([]);
              setStale(false);
            }}
          >
            Load the canvas's code
          </button>
        </div>
      )}
      <div className="code-edit">
        <div className="code-gutter" ref={gutter} aria-hidden>
          {Array.from({ length: lines }, (_, i) => (
            <div key={i} className={bad.has(i + 1) ? "bad" : undefined}>
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          ref={area}
          className="code-text"
          value={text}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          aria-label="Diagram code"
          onChange={(e) => setText(e.target.value)}
          onScroll={(e) => gutter.current && (gutter.current.scrollTop = e.currentTarget.scrollTop)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            // Tidy up once you're done, if what you wrote is what the canvas shows.
            const r = parseCode(text, modelRef.current);
            if (r.ok && toCode(r.model) === code) setText(code);
          }}
          onKeyDown={(e) => {
            const el = e.currentTarget;
            if (e.key === "Tab" && !e.shiftKey) {
              e.preventDefault();
              const { selectionStart: s, selectionEnd: end } = el;
              setText(text.slice(0, s) + "  " + text.slice(end));
              requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
            } else if (e.key === "Enter") {
              // Keep the indentation, one level more after "{".
              e.preventDefault();
              const s = el.selectionStart;
              const before = text.slice(0, s);
              const cur = before.slice(before.lastIndexOf("\n") + 1);
              const ind = /^\s*/.exec(cur)![0] + (/\{\s*$/.test(cur) ? "  " : "");
              setText(before + "\n" + ind + text.slice(el.selectionEnd));
              requestAnimationFrame(() => el.setSelectionRange(s + 1 + ind.length, s + 1 + ind.length));
            } else if (e.key === "}") {
              const s = el.selectionStart;
              const lineStart = text.lastIndexOf("\n", s - 1) + 1;
              if (/^\s+$/.test(text.slice(lineStart, s)) && s - lineStart >= 2) {
                e.preventDefault();
                setText(text.slice(0, s - 2) + "}" + text.slice(el.selectionEnd));
                requestAnimationFrame(() => el.setSelectionRange(s - 1, s - 1));
              }
            }
          }}
        />
      </div>
      {errors.length > 0 && (
        <ul className="code-errors">
          {errors.slice(0, 8).map((e, i) => (
            <li key={i}>
              <button className="link" onClick={() => goTo(e.line)}>
                Line {e.line}
              </button>{" "}
              {e.message}
            </li>
          ))}
        </ul>
      )}
      <details className="code-help">
        <summary>Syntax</summary>
        <pre>{`// comments start with //
terraform on                     // show cloud details and Terraform
id "Name" [type, key: value]     // an item
id "Name" [type] { … }           // a group with items inside
id [type, icon: "aws:AWSLambda"] // with an icon
page ops "Operations" { … }      // a tab

a -> b "label" [https]           // a line with a protocol
a <- b   a <-> b   a - b         // arrow at the start, both, none
a --> b  a ..> b                 // dashed, dotted
a -> b [curved, color: "#1a73e8", end: diamond]`}</pre>
        <p className="hint">
          Types (short names work too): {CATALOG.map((e) => e.kind).join(", ")}.
        </p>
        <p className="hint">Protocols: {PROTOCOLS.join(", ")}. Line ends: arrow, open, triangle, diamond, odiamond, circle, er-one, er-many, er-one-many, er-zero-many, er-zero-one.</p>
        <p className="hint">Positions stay on the canvas: new items are placed automatically, and moved ones keep their place.</p>
      </details>
    </div>
  );
}

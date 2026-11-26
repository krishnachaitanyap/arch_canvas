import { useEffect, useRef, useState } from "react";
import type { DiagramModel } from "@archcanvas/shared";
import { api, type AgentEvent, type AppConfig } from "../api";

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; text: string; ok: boolean }
  | { kind: "error"; text: string };

const SUGGESTIONS = [
  "Cloud Run API with Cloud SQL Postgres, a GCS bucket and Pub/Sub for async jobs, behind an HTTPS load balancer",
  "Review this architecture for security and reliability",
  "Make the database highly available and add a Redis cache",
  "Generate the Terraform",
];

export interface AgentCallbacks {
  /** Agent run started on this base model. */
  onStart: (base: DiagramModel) => void;
  /** Working copy after an edit. */
  onProposal: (model: DiagramModel) => void;
  onDone: (model: DiagramModel, changed: boolean) => void;
  onShowTerraform: () => void;
}

export function AgentPanel({
  model,
  diagramId,
  config,
  busy,
  callbacks,
}: {
  model: DiagramModel;
  diagramId: string | null;
  config: AppConfig | null;
  busy: boolean;
  callbacks: AgentCallbacks;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [items]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || running) return;
    const history = items
      .filter((i): i is Extract<Item, { kind: "user" | "assistant" }> => i.kind === "user" || i.kind === "assistant")
      .map((i) => ({ role: i.kind, content: i.text }));
    setItems((xs) => [...xs, { kind: "user", text: message }]);
    setInput("");
    setRunning(true);
    callbacks.onStart(model);
    abort.current = new AbortController();
    let finished = false;
    try {
      await api.agent(
        { message, model, history, diagramId: diagramId ?? undefined },
        (e: AgentEvent) => {
          switch (e.type) {
            case "text":
              setItems((xs) => [...xs, { kind: "assistant", text: e.text }]);
              break;
            case "tool":
              setItems((xs) => [...xs, { kind: "tool", text: e.summary, ok: e.ok }]);
              break;
            case "model":
              callbacks.onProposal(e.model);
              break;
            case "terraform":
              callbacks.onShowTerraform();
              break;
            case "done":
              finished = true;
              callbacks.onDone(e.model, e.changed);
              break;
            case "error":
              setItems((xs) => [...xs, { kind: "error", text: friendly(e.message, config) }]);
              break;
          }
        },
        abort.current.signal,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") setItems((xs) => [...xs, { kind: "error", text: friendly((err as Error).message, config) }]);
    } finally {
      if (!finished) callbacks.onDone(model, false);
      setRunning(false);
      abort.current = null;
    }
  }

  return (
    <div className="agent">
      <div className="agent-log" ref={list}>
        {items.length === 0 && (
          <div className="agent-empty">
            <p>
              Describe an architecture or a change. The assistant edits the diagram and shows the changes for you to accept.
            </p>
            {config && !config.aiEnabled && (
              <p className="banner warn">
                {config.demo
                  ? "The live demo runs in your browser without a server, so the assistant is off. Everything else works: import, Terraform, flows, presentations, history."
                  : "AI is disabled on this server."}
              </p>
            )}
            {SUGGESTIONS.map((s) => (
              <button key={s} className="suggestion" onClick={() => void send(s)} disabled={busy}>
                {s}
              </button>
            ))}
          </div>
        )}
        {items.map((it, i) => (
          <div key={i} className={`msg ${it.kind} ${it.kind === "tool" && !it.ok ? "failed" : ""}`}>
            {it.kind === "tool" ? `⚙ ${it.text}` : it.text}
          </div>
        ))}
        {running && <div className="msg thinking">Working…</div>}
      </div>
      <div className="agent-input">
        <textarea
          rows={3}
          placeholder="e.g. Add a worker that processes the jobs topic and writes to the bucket"
          value={input}
          disabled={busy && !running}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        {running ? (
          <button onClick={() => abort.current?.abort()}>Stop</button>
        ) : (
          <button className="primary" onClick={() => void send(input)} disabled={!input.trim() || busy}>
            Send
          </button>
        )}
      </div>
      {config && <p className="hint">Model: {config.aiProvider} · {config.aiModel}. Enter to send, Shift+Enter for a new line.</p>}
    </div>
  );
}

function friendly(message: string, config: AppConfig | null): string {
  if (/api key|apiKey|authentication|credential|PERMISSION_DENIED|API_KEY/i.test(message))
    return `The AI provider rejected the request: ${message}\n\nSet ${
      config?.aiProvider === "gemini" ? "GEMINI_API_KEY" : "the provider's API key"
    } in .env and restart the API.`;
  return message;
}

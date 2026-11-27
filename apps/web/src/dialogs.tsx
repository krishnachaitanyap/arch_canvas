import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * In-app confirmation dialogs, instead of the browser's confirm() pop-ups: same look as the
 * rest of the app, keyboard friendly (Enter confirms, Esc cancels), and they don't block the page.
 *
 *   if (await askConfirm({ title: "Delete diagram?", message: "…", confirm: "Delete", danger: true })) …
 */
export interface ConfirmOptions {
  title: string;
  message?: string;
  /** Label of the confirming button (default "OK"). */
  confirm?: string;
  cancel?: string;
  /** Destructive action: the button is red. */
  danger?: boolean;
}

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

let queue: Pending[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [...queue, { ...opts, resolve }];
    emit();
  });
}

function settle(ok: boolean) {
  const [first, ...rest] = queue;
  if (!first) return;
  queue = rest;
  emit();
  first.resolve(ok);
}

/** Renders the dialog being asked, if any. Mounted once at the root of the app. */
export function DialogHost() {
  const current = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => queue[0],
  );
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!current) return;
    // Focus the safe choice for destructive actions, the action otherwise.
    const focus = setTimeout(() => (current.danger ? document.querySelector<HTMLButtonElement>(".confirm-dialog .cancel") : button.current)?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        settle(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(focus);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [current]);

  if (!current) return null;
  return (
    <div className="modal-backdrop confirm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && settle(false)}>
      <div className="modal confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
        <h2 id="confirm-title">{current.title}</h2>
        {current.message && <p id="confirm-message">{current.message}</p>}
        <div className="confirm-actions">
          <button className="cancel" onClick={() => settle(false)}>
            {current.cancel ?? "Cancel"}
          </button>
          <button ref={button} className={current.danger ? "danger-solid" : "primary"} onClick={() => settle(true)}>
            {current.confirm ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}

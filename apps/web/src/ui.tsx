import { type ReactNode, useEffect, useRef, useState } from "react";

/** The Keelrail mark: a hull's keel line with a rail above it. */
export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="url(#kr-g)" />
      <path d="M7 13.5h18" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" opacity=".55" />
      <path d="M6.5 18.5h19l-3.5 5.5h-12z" fill="#fff" />
      <path d="M16 8v10.5" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <defs>
        <linearGradient id="kr-g" x1="0" y1="0" x2="32" y2="32">
          <stop stopColor="#4f46e5" />
          <stop offset="1" stopColor="#0ea5e9" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** A colour for a name, so avatars and project dots stay the same everywhere. */
const TINTS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6", "#ec4899", "#64748b", "#f97316"];
export function tint(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length];
}
export const initials = (s: string) =>
  s
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

export function Avatar({ name, size = 28, square }: { name: string; size?: number; square?: boolean }) {
  return (
    <span className="avatar" style={{ width: size, height: size, borderRadius: square ? size * 0.26 : "50%", background: tint(name), fontSize: size * 0.4 }} aria-hidden>
      {initials(name)}
    </span>
  );
}

/**
 * A button that opens a small menu below it. Closes on a click outside, Escape, or when an
 * item calls close().
 */
export function Popover({
  trigger,
  children,
  align = "left",
  className = "",
  label,
  disabled,
}: {
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
  label: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className={`pop ${className}`} ref={root}>
      <button type="button" className={`pop-trigger ${open ? "open" : ""}`} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} disabled={disabled} onClick={() => setOpen(!open)}>
        {trigger}
      </button>
      {open && (
        <div className={`menu-pop ${align === "right" ? "right" : ""}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

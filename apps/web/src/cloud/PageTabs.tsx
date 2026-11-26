import { useEffect, useRef, useState } from "react";
import type { Page } from "@archcanvas/shared";

/**
 * Tabs along the bottom of the canvas, like draw.io's pages: click to switch, double-click to
 * rename, right-click (or ⌄) for duplicate / move / delete, + to add.
 */
export function PageTabs({
  pages,
  active,
  counts,
  readOnly,
  onSelect,
  onAdd,
  onRename,
  onDuplicate,
  onMove,
  onDelete,
}: {
  pages: Page[];
  active: string;
  counts: Record<string, number>;
  readOnly: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onMove: (id: string, by: number) => void;
  onDelete: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);
  const openMenu = (id: string, clientX: number) => {
    setMenu({ id, x: clientX, y: strip.current?.getBoundingClientRect().top ?? 0 });
  };
  const i = menu ? pages.findIndex((p) => p.id === menu.id) : -1;
  return (
    <div className="page-tabs" ref={strip} role="tablist" aria-label="Canvas tabs">
      {pages.map((p) => (
        <div
          key={p.id}
          role="tab"
          aria-selected={p.id === active}
          className={`page-tab ${p.id === active ? "on" : ""}`}
          title={`${p.name} · ${counts[p.id] ?? 0} item${counts[p.id] === 1 ? "" : "s"}`}
          onClick={() => p.id !== active && onSelect(p.id)}
          onDoubleClick={() => !readOnly && setRenaming(p.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (!readOnly) openMenu(p.id, e.clientX);
          }}
        >
          {renaming === p.id ? (
            <input
              className="page-rename"
              autoFocus
              defaultValue={p.name}
              maxLength={60}
              onFocus={(e) => e.target.select()}
              onBlur={(e) => {
                setRenaming(null);
                if (e.target.value.trim() && e.target.value.trim() !== p.name) onRename(p.id, e.target.value);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <span>{p.name}</span>
          )}
          {!readOnly && p.id === active && renaming !== p.id && (
            <button
              className="page-more"
              aria-label={`Options for ${p.name}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (menu?.id === p.id) setMenu(null);
                else openMenu(p.id, e.clientX);
              }}
            >
              ⌄
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button className="page-add" title="Add a tab (e.g. HA / DR, CI/CD)" aria-label="Add tab" onClick={onAdd}>
          +
        </button>
      )}
      {menu && i >= 0 && (
        <div className="page-menu" style={{ left: Math.max(4, menu.x - 20), top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          {(
            [
              ["Rename", () => setRenaming(menu.id), false],
              ["Duplicate", () => onDuplicate(menu.id), false],
              ["Move left", () => onMove(menu.id, -1), i === 0],
              ["Move right", () => onMove(menu.id, 1), i === pages.length - 1],
              ["Delete tab", () => onDelete(menu.id), pages.length < 2],
            ] as const
          ).map(([label, fn, disabled]) => (
            <button
              key={label}
              className={label === "Delete tab" ? "danger" : ""}
              disabled={disabled}
              onClick={() => {
                setMenu(null);
                fn();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

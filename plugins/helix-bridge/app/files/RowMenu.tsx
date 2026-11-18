// The row menu: a right click (or the menu key) on a row offers the tree's
// actions by name, each with its key. It is drawn inside the tree (no portal),
// takes the keyboard while open, and gives it back to the list when it closes.
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ShortcutHint } from "../../kit";

export interface MenuItem {
  label: string;
  combo: string;
  run(): void;
  disabled?: boolean;
  destructive?: boolean;
  /** A hairline before this item. */
  separated?: boolean;
}

export function RowMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose(): void }) {
  const root = useRef<HTMLDivElement>(null);
  const enabled = items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0);
  const [at, setAt] = useState(enabled[0] ?? 0);
  const [place, setPlace] = useState({ left: x, top: y });

  // Inside the tree: flip up or left when it would leave it.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const box = el.offsetParent as HTMLElement | null;
    if (!box) return;
    const left = Math.max(4, Math.min(x, box.clientWidth - el.offsetWidth - 4));
    const top = y + el.offsetHeight > box.clientHeight - 4 ? Math.max(4, y - el.offsetHeight) : y;
    setPlace({ left, top });
  }, [x, y]);

  const step = (delta: number) => {
    const i = enabled.indexOf(at);
    setAt(enabled[(i + delta + enabled.length) % enabled.length] ?? at);
  };
  const run = (item: MenuItem | undefined) => {
    if (!item || item.disabled) return;
    onClose();
    item.run();
  };

  return (
    <div
      ref={root}
      role="menu"
      tabIndex={-1}
      aria-label="File actions"
      aria-activedescendant={`helix-files-menu-${at}`}
      data-files-menu
      style={place}
      onKeyDown={(event) => {
        const k = event.key;
        if (k === "ArrowDown" || k === "j") step(1);
        else if (k === "ArrowUp" || k === "k") step(-1);
        else if (k === "Enter" || k === " ") run(items[at]);
        else if (k === "Escape" || k === "Tab") onClose();
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClose();
      }}
      className="absolute z-20 w-56 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none motion-safe:animate-[helix-files-arrive_160ms_cubic-bezier(0.22,1,0.36,1)]"
    >
      {items.map((item, i) => (
        <div key={item.label}>
          {item.separated ? <div className="mx-1 my-1 h-px bg-border/70" /> : null}
          <div
            id={`helix-files-menu-${i}`}
            role="menuitem"
            aria-disabled={item.disabled || undefined}
            onMouseEnter={() => !item.disabled && setAt(i)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run(item)}
            className={cn(
              "flex h-7 cursor-default items-center justify-between gap-3 rounded-md px-2 text-[13px]",
              item.disabled ? "text-muted-foreground/60" : item.destructive ? "text-destructive" : "",
              i === at && !item.disabled && "bg-state-hover",
            )}
          >
            <span className="truncate">{item.label}</span>
            <ShortcutHint combo={item.combo} />
          </div>
        </div>
      ))}
    </div>
  );
}

import { ChevronRight, Star } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { COLORS } from "../lib/colors";

/** A button in an icon row: on = drawn filled (e.g. already a favourite). */
export interface IconButton {
  icon: React.ReactNode;
  /** Name and key, shown on hover ("お気に入り（F）"). */
  title: string;
  active?: boolean;
  onClick: () => void;
}

type Never<K extends string> = { [P in K]?: never };

export type MenuItem =
  | ({
      label: string;
      onClick: () => void;
      danger?: boolean;
      hint?: string;
      disabled?: boolean;
      checked?: boolean;
    } & Never<"separator" | "colors" | "header" | "icons" | "submenu">)
  /** Opens to the side on hover (or click). */
  | ({ label: string; submenu: MenuItem[]; disabled?: boolean } & Never<"separator" | "colors" | "header" | "icons" | "onClick">)
  | ({ separator: true } & Never<"label" | "colors" | "header" | "icons" | "submenu">)
  /** A quiet line on top ("3 件を選択中"). */
  | ({ header: string } & Never<"label" | "separator" | "colors" | "icons" | "submenu">)
  /** A row of icon buttons, optionally with star ratings after them. */
  | ({
      icons: IconButton[];
      rating?: { current: number | null; onPick: (n: number) => void };
    } & Never<"label" | "separator" | "colors" | "header" | "submenu">)
  /** A row of colour swatches; picking `null` clears the colour. */
  | ({ colors: { current: string | null; onPick: (key: string | null) => void } } & Never<
      "label" | "separator" | "header" | "icons" | "submenu"
    >);

interface MenuState {
  menu: { x: number; y: number; items: MenuItem[] } | null;
  show: (e: React.MouseEvent | { clientX: number; clientY: number }, items: MenuItem[]) => void;
  close: () => void;
}

export const useMenu = create<MenuState>((set) => ({
  menu: null,
  show: (e, items) => {
    if ("preventDefault" in e) {
      e.preventDefault();
      e.stopPropagation();
    }
    set({ menu: { x: e.clientX, y: e.clientY, items } });
  },
  close: () => set({ menu: null }),
}));

export function ContextMenu() {
  const { menu, close } = useMenu();

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu, close]);

  if (!menu) return null;
  return (
    <div data-modal
      className="fixed inset-0 z-50"
      onPointerDown={close}
      onContextMenu={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <Panel items={menu.items} at={{ x: menu.x, y: menu.y }} close={close} />
    </div>
  );
}

/**
 * One level of the menu, kept inside the window: `at` is where it wants its
 * top-left corner; a submenu passes the row it opens from as `beside`, so it
 * can open to the left instead when there is no room on the right.
 */
function Panel({
  items,
  at,
  beside,
  close,
}: {
  items: MenuItem[];
  at: { x: number; y: number };
  beside?: DOMRect;
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  const [open, setOpen] = useState<{ index: number; rect: DOMRect } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let x = at.x;
    if (x + width > window.innerWidth - 8) x = beside ? beside.left - width + 4 : window.innerWidth - width - 8;
    const y = Math.min(at.y, window.innerHeight - height - 8);
    setPos({ x: Math.max(8, x), y: Math.max(8, y) });
  }, [at.x, at.y, beside]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const hover = (i: number, row: HTMLElement | null, sub: boolean) => {
    clearTimeout(timer.current);
    // A short delay so passing over a row on the way to a submenu doesn't close it.
    timer.current = setTimeout(() => setOpen(sub && row ? { index: i, rect: row.getBoundingClientRect() } : null), sub ? 80 : 160);
  };

  const run = (fn: () => void) => {
    close();
    fn();
  };

  const row = "flex w-full items-center gap-6 rounded px-2.5 py-1.5 text-left";
  const sub = open ? items[open.index] : undefined;

  return (
    <>
      <div
        ref={ref}
        className="absolute min-w-44 animate-slide-down rounded-lg border border-line bg-raised p-1 shadow-xl"
        style={{ left: pos.x, top: pos.y }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {items.map((it, i) => {
          if (it.header !== undefined)
            return (
              <div key={i} className="px-2.5 pt-1 pb-1.5 text-xs text-dim">
                {it.header}
              </div>
            );
          if (it.separator) return <div key={i} className="mx-1.5 my-1 border-t border-line" />;
          if (it.colors)
            return (
              <div key={i} className="flex items-center gap-1.5 px-2.5 py-1.5" onPointerEnter={() => hover(i, null, false)}>
                {COLORS.map((c) => (
                  <button
                    key={c.key}
                    title={c.label}
                    onClick={() => run(() => it.colors.onPick(c.key))}
                    className={`h-4 w-4 rounded-full ring-offset-1 ring-offset-raised hover:scale-110 ${
                      it.colors.current === c.key ? "ring-2 ring-fg" : ""
                    }`}
                    style={{ background: c.hex }}
                  />
                ))}
                <button
                  title="色をなしにする"
                  onClick={() => run(() => it.colors.onPick(null))}
                  className="flex h-4 w-4 items-center justify-center rounded-full border border-dim text-[10px] leading-none text-dim hover:text-fg"
                >
                  ×
                </button>
              </div>
            );
          if (it.icons)
            return (
              <div key={i} className="flex items-center gap-0.5 px-1 py-0.5" onPointerEnter={() => hover(i, null, false)}>
                {it.icons.map((b, j) => (
                  <button
                    key={j}
                    title={b.title}
                    aria-label={b.title}
                    aria-pressed={b.active}
                    onClick={() => run(b.onClick)}
                    className={`flex h-7 w-7 items-center justify-center rounded hover:bg-accent-fill hover:text-white ${
                      b.active ? "text-accent" : "text-fg/80"
                    }`}
                  >
                    {b.icon}
                  </button>
                ))}
                {it.rating && <RatingPicker {...it.rating} run={run} />}
              </div>
            );
          if (it.submenu)
            return (
              <button
                key={i}
                disabled={it.disabled}
                className={`${row} ${open?.index === i ? "bg-white/10" : ""} enabled:hover:bg-white/10 disabled:off`}
                onPointerEnter={(e) => !it.disabled && hover(i, e.currentTarget, true)}
                onClick={(e) => !it.disabled && setOpen({ index: i, rect: e.currentTarget.getBoundingClientRect() })}
              >
                <span className="flex-1">{it.label}</span>
                <ChevronRight size={13} className="-mr-1 opacity-60" />
              </button>
            );
          return (
            <button
              key={i}
              disabled={it.disabled}
              className={`${row} enabled:hover:bg-accent-fill enabled:hover:text-white disabled:off ${it.danger ? "text-danger" : ""}`}
              onPointerEnter={() => hover(i, null, false)}
              onClick={() => run(it.onClick)}
            >
              <span className="flex-1">
                {it.checked !== undefined && <span className={`mr-1.5 ${it.checked ? "" : "invisible"}`}>✓</span>}
                {it.label}
              </span>
              {it.hint && <span className="text-xs opacity-50">{it.hint}</span>}
            </button>
          );
        })}
      </div>
      {sub?.submenu && open && (
        <Panel
          key={open.index}
          items={sub.submenu}
          at={{ x: open.rect.right - 4, y: open.rect.top - 5 }}
          beside={open.rect}
          close={close}
        />
      )}
    </>
  );
}

/** ★1〜★5 to click (the current rating filled); clicking the current one clears it. */
function RatingPicker({
  current,
  onPick,
  run,
}: {
  current: number | null;
  onPick: (n: number) => void;
  run: (fn: () => void) => void;
}) {
  const [over, setOver] = useState<number | null>(null);
  const shown = over ?? current ?? 0;
  return (
    <div className="ml-auto flex items-center pr-1.5 pl-2" onPointerLeave={() => setOver(null)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          title={n === current ? "評価を消す（0）" : `★${n}（${n}）`}
          onPointerEnter={() => setOver(n)}
          onClick={() => run(() => onPick(n === current ? 0 : n))}
          className="p-0.5 text-amber-400"
        >
          <Star size={14} fill={n <= shown ? "currentColor" : "none"} strokeWidth={1.75} />
        </button>
      ))}
    </div>
  );
}

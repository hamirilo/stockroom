// The settings screen's frame and rows (desktop-platform UI §9). The same file
// is in every tool, so settings look and work alike everywhere:
//
// - pages on the left (only when there are two or more), the page on the right
// - changes are saved as they are made; there is no "保存" button
// - Esc or a click outside closes it; ↑ / ↓ on the page list move between pages;
//   Tab stays inside, and focus goes back where it was when it closes
// - an on/off setting is a row with a switch on the right; a choice of a few
//   is a list of radio rows; rows are grouped in sections with a heading
import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

export interface SettingsPage<T extends string = string> {
  id: T;
  label: string;
  icon?: ReactNode;
}

export interface SettingsGroup<T extends string = string> {
  /** A heading over the group's pages (where its settings are saved). */
  title?: string;
  sub?: string;
  pages: SettingsPage<T>[];
}

const composing = (e: KeyboardEvent) => e.isComposing || e.keyCode === 229;

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function SettingsFrame<T extends string>({
  groups,
  page,
  onPage,
  onClose,
  children,
}: {
  groups: SettingsGroup<T>[];
  page: T;
  onPage: (id: T) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const pages = groups.flatMap((g) => g.pages);
  const current = pages.find((p) => p.id === page);
  const withNav = pages.length > 1;

  // Focus into the dialog, and back to what had it when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? box.current;
    first?.focus();
    return () => before?.focus?.();
  }, []);

  // A page starts at its top.
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [page]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !composing(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      } else if (e.key === "Tab" && box.current) {
        // Keep Tab inside the dialog.
        const all = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (all.length === 0) return;
        const i = all.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          all[all.length - 1].focus();
        } else if (!e.shiftKey && i === all.length - 1) {
          e.preventDefault();
          all[0].focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const onNavKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = pages.findIndex((p) => p.id === page);
    const next = pages[(i + (e.key === "ArrowDown" ? 1 : pages.length - 1)) % pages.length];
    onPage(next.id);
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>(`[data-page="${next.id}"]`)?.focus());
  };

  return (
    <div
      data-modal
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/50"
      onPointerDown={onClose}
    >
      <div
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // A fixed height with pages, so switching them doesn't resize the dialog.
        className={`flex max-w-[94vw] animate-zoom-in overflow-hidden rounded-xl border border-line bg-panel shadow-2xl shadow-black/50 ${
          withNav ? "h-[min(620px,88vh)] w-[760px]" : "max-h-[88vh] w-[560px]"
        }`}
        // Focus rests on the dialog itself; that isn't worth a ring.
        style={{ outline: "none" }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {withNav && (
          <nav aria-label="設定のページ" className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-bg/40 p-2" onKeyDown={onNavKey}>
            <div className="px-2 pt-1 pb-2 text-base font-semibold">設定</div>
            {groups.map((g, gi) => (
              <div key={g.title ?? gi} className="flex flex-col gap-0.5">
                {gi > 0 && <div className="mx-2 my-2 border-t border-line" />}
                {g.title && (
                  <div className="px-2 pt-1 pb-1">
                    <div className="truncate text-[11px] font-semibold text-dim" title={g.title}>
                      {g.title}
                    </div>
                    {g.sub && <div className="text-[10px] text-dim/70">{g.sub}</div>}
                  </div>
                )}
                {g.pages.map((p) => (
                  <button
                    key={p.id}
                    data-page={p.id}
                    onClick={() => onPage(p.id)}
                    aria-current={p.id === page ? "page" : undefined}
                    tabIndex={p.id === page ? 0 : -1}
                    className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                      p.id === page ? "bg-accent/25 text-fg" : "text-dim hover:bg-raised hover:text-fg"
                    }`}
                  >
                    {p.icon}
                    {p.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-6 py-3">
            <h1 id={titleId} className="flex-1 truncate text-base font-semibold">
              {withNav ? current?.label : "設定"}
            </h1>
            <button
              onClick={onClose}
              title="閉じる（Esc）"
              aria-label="閉じる"
              className="-mr-2 rounded p-1 text-dim outline-none hover:bg-raised hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
            >
              <X size={16} />
            </button>
          </div>
          <div ref={body} className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A heading and a box of rows. */
export function Section({ id, title, sub, children }: { id?: string; title?: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="mt-6 scroll-mt-4 first:mt-0">
      {title && <h2 className="mb-1 text-[13px] font-semibold">{title}</h2>}
      {sub && <p className="mb-2 text-xs text-dim">{sub}</p>}
      <div className="divide-y divide-line rounded-lg border border-line bg-bg/40">{children}</div>
    </section>
  );
}

/** One setting: what it is on the left, its control on the right. */
export function Row({
  label,
  hint,
  icon,
  disabled,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`flex min-h-12 items-center gap-3 px-3 py-2.5 ${disabled ? "opacity-50" : ""}`}>
      {icon && <span className="shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-dim">{hint}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** An on/off setting. The whole row toggles it. */
export function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={`flex min-h-12 items-center gap-3 px-3 py-2.5 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px]">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-dim">{hint}</span>}
      </span>
      <Switch id={id} checked={checked} disabled={disabled} onChange={onChange} />
    </label>
  );
}

export function Switch({
  id,
  checked,
  disabled,
  onChange,
}: {
  id?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel ${
        checked ? "bg-accent" : "bg-dim/35"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`}
      />
    </button>
  );
}

/** A choice of a few, one per row. */
export function RadioRows<T extends string>({
  name,
  value,
  options,
  disabled,
  onChange,
}: {
  name: string;
  value: T | undefined;
  options: { value: T; label: ReactNode; hint?: ReactNode }[];
  disabled?: boolean;
  onChange: (v: T) => void;
}) {
  return options.map((o) => (
    <label key={o.value} className={`flex min-h-12 items-start gap-3 px-3 py-2.5 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <input
        type="radio"
        name={name}
        className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
        checked={value === o.value}
        disabled={disabled}
        onChange={() => onChange(o.value)}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px]">{o.label}</span>
        {o.hint && <span className="mt-0.5 block text-xs text-dim">{o.hint}</span>}
      </span>
    </label>
  ));
}

/** A small secondary button for a row. */
export function RowButton({
  onClick,
  disabled,
  primary,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 ${
        primary ? "bg-accent text-white hover:brightness-110" : "border border-line hover:bg-raised"
      }`}
    >
      {children}
    </button>
  );
}

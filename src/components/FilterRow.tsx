// The filter row (docs/NAVIGATION.md): every condition narrowing the open
// place, always on screen as one row of round buttons. A button opens a menu
// of its values with counts (with the other conditions on); one in use is
// filled, shows its value and has × in place of ▾. Within a condition the
// values picked are "any of"; the conditions are "all of".
// An open smart folder shows its own conditions here (locked: "条件を編集"
// loads them into the row to change them).
import { Check, ChevronDown, FolderSearch, ListFilter, Search, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { cancelSmartEdit, createSmartFolder, saveEditedSmartFolder } from "../lib/actions";
import { api, KINDS, kindLabel, modeOf, type Facets, type Filter, type ItemKind, type Rule, type Shape } from "../lib/api";
import { colorHex } from "../lib/colors";
import { composing } from "../lib/ime";
import {
  DATE_PRESETS,
  describeDate,
  describeDims,
  describeSize,
  SHAPE_LABEL,
  SIZE_PRESETS,
  startOfToday,
} from "../lib/rule";
import { FontConditions } from "../features/fonts/FontFilters";
import { activeConditions, CLEARED, listIs, listQuery, usedModes, useStore, type ConditionKey } from "../store";
import { RangeCalendar } from "./RangeCalendar";
import { systemFacetCounts } from "../features/fonts/system";

/**
 * Conditions the fonts installed on this computer don't have (they have no
 * rating, tags or import date): greyed out there, with why (docs/SYSTEM_FONTS.md).
 */
function useNotForSystem(what: string): { disabled?: boolean; title?: string } {
  const system = useStore((s) => s.view.kind === "system");
  return system ? { disabled: true, title: `この端末のフォントには${what}がありません（ライブラリのフォントだけ）` } : {};
}

/** The conditions a row shows: the open ones (editable), or a smart folder's (locked). */
export interface Cond {
  tagFilter: number[];
  tagMatchAll: boolean;
  minRating: number;
  filter: Filter;
}

/** Counts of the values of `key`, with the other conditions on; fetched while its menu is open. */
export function useFacets(key: ConditionKey, open: boolean): Facets | null {
  const [facets, setFacets] = useState<Facets | null>(null);
  const rev = useStore((s) => s.rev);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const s = useStore.getState();
    // The installed fonts aren't in the library: counted where they are listed.
    (s.view.kind === "system" ? systemFacetCounts(listQuery(s, key)) : api.facetCounts(listQuery(s, key)))
      .then((f) => live && setFacets(f))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, key, rev]);
  return facets;
}

/**
 * A condition's round button and its menu. `value` is what is picked ("" =
 * none). A locked button (a smart folder's) opens nothing: `onLocked` runs.
 */
export function Pill({
  label,
  value,
  title,
  disabled,
  locked,
  onLocked,
  onClear,
  width = "w-56",
  children,
}: {
  label: string;
  value: string;
  title?: string;
  disabled?: boolean;
  locked?: boolean;
  onLocked?: () => void;
  onClear: () => void;
  width?: string;
  children: (open: boolean, close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // The menu is placed on the window (the row scrolls sideways and would cut it off).
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  // Under its button, kept inside the window, following the button when the row scrolls.
  useLayoutEffect(() => {
    if (!open) return setAt(null);
    const place = () => {
      const r = ref.current!.getBoundingClientRect();
      const w = menu.current?.offsetWidth ?? 0;
      setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)), top: r.bottom + 4 });
    };
    place();
    const row = ref.current?.parentElement;
    window.addEventListener("resize", place);
    row?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      row?.removeEventListener("scroll", place);
    };
  }, [open]);
  const on = value !== "";
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        disabled={disabled}
        title={title ?? (on ? `${label}：${value}` : label)}
        aria-expanded={open}
        onClick={() => (locked ? onLocked?.() : setOpen((o) => !o))}
        className={`flex h-7 items-center gap-1 rounded-md border border-transparent pr-1.5 pl-2.5 whitespace-nowrap disabled:off disabled:bg-transparent disabled:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] ${
          on
            ? "bg-tonal text-on-tonal enabled:hover:brightness-110"
            : open
              ? "bg-press"
              : "bg-white/8 enabled:hover:bg-white/12"
        } ${locked && on ? "opacity-80" : ""}`}
      >
        <span>{label}</span>
        {/* Long values are cut short: the next buttons don't move (docs/UI.md). */}
        {on && <span className="max-w-32 truncate font-medium">{value}</span>}
        {on && !locked ? (
          <span
            role="button"
            title={`${label}の条件を外す`}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onClear();
            }}
            className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-white/20"
          >
            <X size={12} />
          </span>
        ) : (
          <span className="flex h-5 w-5 items-center justify-center">
            <ChevronDown size={12} className={on ? "" : "text-dim"} />
          </span>
        )}
      </button>
      {open && (
        <div
          ref={menu}
          data-modal
          style={{ position: "fixed", left: at?.left ?? 0, top: at?.top ?? 0, visibility: at ? "visible" : "hidden" }}
          className={`z-40 ${width} max-h-[60vh] animate-slide-down overflow-y-auto rounded-lg border border-line bg-raised p-1 text-xs shadow-xl`}
        >
          {children(open, () => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** A value in a menu: a check (or a dot when one only is picked), its name and count. */
export function Option({
  on,
  single,
  count,
  onClick,
  children,
}: {
  on: boolean;
  single?: boolean;
  count?: number | null;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-white/8 ${
        on ? "text-fg" : count === 0 ? "text-dim/60" : "text-fg/85"
      }`}
    >
      <span
        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center border ${single ? "rounded-full" : "rounded-sm"} ${
          on ? "border-accent bg-accent-fill text-white" : "border-edge"
        }`}
      >
        {on && <Check size={10} strokeWidth={3} />}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
      {count !== undefined && <span className="shrink-0 text-dim tabular-nums">{count ?? "…"}</span>}
    </button>
  );
}

export const menuNote = "px-2 py-1.5 text-dim";

/** Adds `v` to the picked values, or takes it off. */
export const toggled = <T,>(cur: T[], v: T): T[] => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);

/** Number input that commits on blur / Enter; empty = no limit. */
function NumField({
  value,
  onChange,
  placeholder,
  scale = 1,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder: string;
  /** Displayed value = stored / scale (e.g. MB). */
  scale?: number;
}) {
  const shown = value == null ? "" : String(Math.round((value / scale) * 100) / 100);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    const n = Number(text);
    onChange(text.trim() === "" || !Number.isFinite(n) || n < 0 ? null : Math.round(n * scale));
  };
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && !composing(e) && commit()}
      inputMode="decimal"
      placeholder={placeholder}
      className="h-7 w-20 rounded border border-edge bg-bg px-1.5 tabular-nums outline-none focus:border-accent"
    />
  );
}

const previousDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime();
};
const nextDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

/** The conditions of a smart folder's rule, as the row shows them. */
const condOf = (r: Rule): Cond => ({ tagFilter: r.tagIds, tagMatchAll: r.tagMatchAll, minRating: r.minRating, filter: r.filter });

export function FilterRow() {
  const mode = useStore((s) => s.mode);
  const view = useStore((s) => s.view);
  const smart = useStore((s) => (s.view.kind === "smart" ? s.smartFolders.find((f) => f.id === (s.view as { id: string }).id) : undefined));
  const editing = useStore((s) => s.editingSmart);
  const own = useStore(
    useShallow((s): Cond => ({ tagFilter: s.tagFilter, tagMatchAll: s.tagMatchAll, minRating: s.minRating, filter: s.filter })),
  );
  const active = useStore(activeConditions);
  const clearConditions = useStore((s) => s.clearConditions);
  const startEditSmart = useStore((s) => s.startEditSmart);
  // An open smart folder shows its rule, locked.
  const locked = !!smart && !editing;
  const cond = locked ? condOf(smart.rule) : own;
  const edit = () => smart && startEditSmart(smart);
  const common = { cond, locked, onLocked: edit };

  return (
    // One row whatever is picked: the conditions scroll sideways when short of
    // room, the row's own actions stay at its right end (docs/UI.md).
    // A row of its own, sunk one step (docs/UI.md「色」): the chips are where the list is narrowed.
    <div data-filter-row className="-mx-4 flex h-10 items-center gap-3 bg-black/18 px-4 text-xs">
      <span className="flex shrink-0 items-center gap-1.5 text-dim @max-3xl:hidden">
        <ListFilter size={13} /> 絞り込み
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {locked && smart.rule.search.trim() && (
        <Pill label="検索" value={smart.rule.search.trim()} locked onLocked={edit} onClear={() => {}}>
          {() => null}
        </Pill>
      )}
      <RatingCondition {...common} />
      <TagCondition {...common} />
      {mode === "stock" ? (
        <>
          <KindCondition {...common} />
          <ExtCondition {...common} />
          <DimsCondition {...common} />
          <DateCondition {...common} />
          <SizeCondition {...common} />
          <LinksCondition {...common} />
        </>
      ) : (
        <>
          <FontConditions {...common} />
          <ExtCondition {...common} />
          <DateCondition {...common} />
        </>
      )}
      </div>
      {/* The row's own actions, at its right end and always there (greyed out with nothing to do). */}
      <div className="flex shrink-0 items-center gap-1.5">
        {locked ? (
          <button
            onClick={edit}
            title={`スマートフォルダ「${smart.name}」の条件を絞り込みの行に読み込んで変える`}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 ghost"
          >
            <FolderSearch size={13} className="text-accent" /> 条件を編集
          </button>
        ) : editing ? (
          <>
            <span className="max-w-48 truncate text-dim" title={editing.name}>
              「{editing.name}」の条件を編集中
            </span>
            <button onClick={cancelSmartEdit} className="h-7 rounded-md px-2 text-dim hover:bg-white/5 hover:text-fg">
              キャンセル
            </button>
            <button
              onClick={() => saveEditedSmartFolder()}
              className="h-7 rounded-md bg-accent-fill px-2.5 font-medium text-white hover:brightness-110"
            >
              保存
            </button>
          </>
        ) : (
          <>
            <button
              disabled={active === 0}
              onClick={clearConditions}
              title="絞り込みの条件と検索をすべて外す"
              className="h-7 rounded-md px-2 ghost disabled:off"
            >
              すべて解除
            </button>
            <button
              disabled={active === 0 || view.kind === "system"}
              onClick={() => createSmartFolder()}
              title={
                view.kind === "system"
                  ? "スマートフォルダはライブラリのフォントだけを集めます（この端末のフォントの条件は保存できません）"
                  : view.kind === "tag"
                  ? "今の条件（このタグも）をスマートフォルダとして保存（⌘⇧⌥N）"
                  : "今の検索と絞り込みの条件をスマートフォルダとして保存（⌘⇧⌥N）"
              }
              className="flex h-7 items-center gap-1.5 rounded-md px-2 ghost disabled:off"
            >
              <FolderSearch size={13} /> 条件を保存
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** What each condition component gets. */
export type CondProps = { cond: Cond; locked: boolean; onLocked: () => void };

function RatingCondition({ cond, locked, onLocked }: CondProps) {
  const setMinRating = useStore((s) => s.setMinRating);
  const n = cond.minRating;
  const notForSystem = useNotForSystem("評価");
  return (
    <Pill
      {...notForSystem}
      label="評価"
      value={n ? `★${n} 以上` : ""}
      locked={locked}
      onLocked={onLocked}
      onClear={() => setMinRating(0)}
      width="w-44"
    >
      {(open, close) => <RatingMenu open={open} close={close} n={n} pick={setMinRating} />}
    </Pill>
  );
}

function RatingMenu({ open, close, n, pick }: { open: boolean; close: () => void; n: number; pick: (n: number) => void }) {
  const facets = useFacets("rating", open);
  // "★n 以上": the items rated n or more.
  const atLeast = (k: number) =>
    facets ? Object.entries(facets.ratings).reduce((a, [r, c]) => a + (Number(r) >= k ? c : 0), 0) : null;
  return (
    <>
      {[5, 4, 3, 2, 1].map((k) => (
        <Option
          key={k}
          single
          on={n === k}
          count={atLeast(k)}
          onClick={() => {
            pick(n === k ? 0 : k);
            close();
          }}
        >
          <span className="text-amber-400">{"★".repeat(k)}</span>
          <span className="text-dim">{k < 5 ? "以上" : ""}</span>
        </Option>
      ))}
    </>
  );
}

function TagCondition({ cond, locked, onLocked }: CondProps) {
  const tags = useStore((s) => s.tags);
  const set = (tagFilter: number[]) => useStore.setState({ tagFilter });
  const refresh = () => useStore.getState().refresh();
  const names = cond.tagFilter.map((id) => tags.find((t) => t.id === id)?.name).filter(Boolean);
  const all = cond.tagMatchAll && names.length > 1;
  const notForSystem = useNotForSystem("タグ");
  return (
    <Pill
      {...notForSystem}
      label="タグ"
      value={names.length ? `${names.join("・")}${all ? "（すべて）" : ""}` : ""}
      locked={locked}
      onLocked={onLocked}
      onClear={() => useStore.getState().clearTagFilter()}
      width="w-64"
    >
      {(open) => (
        <TagMenu
          open={open}
          picked={cond.tagFilter}
          toggle={(id) => {
            set(toggled(cond.tagFilter, id));
            refresh();
          }}
        />
      )}
    </Pill>
  );
}

function TagMenu({ open, picked, toggle }: { open: boolean; picked: number[]; toggle: (id: number) => void }) {
  const tags = useStore((s) => s.tags);
  const matchAll = useStore((s) => s.tagMatchAll);
  const setMatchAll = useStore((s) => s.setTagMatchAll);
  const facets = useFacets("tags", open);
  const [q, setQ] = useState("");
  const shown = tags.filter((t) => t.name.toLowerCase().includes(q.trim().toLowerCase()));
  if (!tags.length) return <p className={menuNote}>タグはまだありません</p>;
  return (
    <>
      {tags.length > 8 && (
        <label className="mb-1 flex h-7 items-center gap-1.5 rounded border border-edge bg-bg px-2 focus-within:border-accent">
          <Search size={12} className="text-dim" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="タグを探す"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-dim"
          />
        </label>
      )}
      {shown.map((t) => (
        <Option key={t.id} on={picked.includes(t.id)} count={facets ? (facets.tags[t.id] ?? 0) : null} onClick={() => toggle(t.id)}>
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: colorHex(t.color) ?? "var(--color-dim)" }} />
          <span className="truncate">{t.name}</span>
        </Option>
      ))}
      {shown.length === 0 && <p className={menuNote}>当てはまるタグはありません</p>}
      <div className="mt-1 flex items-center gap-2 border-t border-line px-2 pt-2 pb-1">
        <span className="text-dim">複数選んだとき</span>
        <div className="flex rounded-md track">
          {[
            { all: false, label: "いずれか" },
            { all: true, label: "すべて" },
          ].map((m) => (
            <button
              key={m.label}
              aria-pressed={matchAll === m.all}
              onClick={() => setMatchAll(m.all)}
              className={`rounded px-2 py-0.5 ${
                matchAll === m.all ? "thumb" : "text-fg/85 hover:bg-hover hover:text-fg"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/** The stock's kinds, when the library uses more than one of them. */
function KindCondition({ cond, locked, onLocked }: CondProps) {
  const used = useStore(useShallow(usedModes));
  const setKinds = useStore((s) => s.setKinds);
  const kinds = KINDS.filter((k) => modeOf(k.kind) === "stock" && used.includes(k.kind));
  // The similar view is of images whatever is picked.
  const similar = useStore((s) => s.view.kind === "similar");
  if (kinds.length < 2) return null;
  const picked = cond.filter.kinds;
  return (
    <Pill
      label="種類"
      value={picked.map(kindLabel).join("・")}
      disabled={similar}
      title={similar ? "重複の候補は画像だけが対象です" : undefined}
      locked={locked}
      onLocked={onLocked}
      onClear={() => setKinds([])}
      width="w-44"
    >
      {(open) => <KindMenu open={open} kinds={kinds.map((k) => k.kind)} picked={picked} pick={setKinds} />}
    </Pill>
  );
}

function KindMenu({ open, kinds, picked, pick }: { open: boolean; kinds: ItemKind[]; picked: ItemKind[]; pick: (k: ItemKind[]) => void }) {
  const facets = useFacets("kinds", open);
  return (
    <>
      {kinds.map((k) => (
        <Option key={k} on={picked.includes(k)} count={facets ? (facets.kinds[k] ?? 0) : null} onClick={() => pick(toggled(picked, k))}>
          {kindLabel(k)}
        </Option>
      ))}
    </>
  );
}

/**
 * Parents only (docs/LINKS.md). Last in the row, so the others stay put whether
 * the library uses links or not; with links off it's there only to be cleared.
 */
function LinksCondition({ cond, locked, onLocked }: CondProps) {
  const links = useStore((s) => s.librarySettings.links);
  const setFilter = useStore((s) => s.setFilter);
  const on = !!cond.filter.parentsOnly;
  const notForSystem = useNotForSystem("親子の紐づけ");
  if (!links && !on) return null;
  return (
    <Pill
      {...notForSystem}
      label="紐づけ"
      value={on ? "子を持つものだけ" : ""}
      locked={locked}
      onLocked={onLocked}
      onClear={() => setFilter(CLEARED.parents.filter!)}
      width="w-48"
    >
      {(open, close) => <LinksMenu open={open} on={on} pick={(parentsOnly) => (setFilter({ parentsOnly }), close())} />}
    </Pill>
  );
}

function LinksMenu({ open, on, pick }: { open: boolean; on: boolean; pick: (v: boolean) => void }) {
  const facets = useFacets("parents", open);
  return (
    <Option single on={on} count={facets ? facets.parents : null} onClick={() => pick(!on)}>
      子を持つものだけ
    </Option>
  );
}

function ExtCondition({ cond, locked, onLocked }: CondProps) {
  const setFilter = useStore((s) => s.setFilter);
  const picked = cond.filter.exts;
  return (
    <Pill
      label="形式"
      value={picked.map((e) => e.toUpperCase()).join(", ")}
      locked={locked}
      onLocked={onLocked}
      onClear={() => setFilter(CLEARED.exts.filter!)}
      width="w-44"
    >
      {(open) => <ExtMenu open={open} picked={picked} pick={(exts) => setFilter({ exts })} />}
    </Pill>
  );
}

function ExtMenu({ open, picked, pick }: { open: boolean; picked: string[]; pick: (v: string[]) => void }) {
  const exts = useStore((s) => s.exts);
  const facets = useFacets("exts", open);
  if (!exts.length) return <p className={menuNote}>ファイルがありません</p>;
  const count = (e: string) => (facets ? (facets.exts.find(([x]) => x === e)?.[1] ?? 0) : null);
  return (
    <>
      {exts.map(([ext]) => (
        <Option key={ext} on={picked.includes(ext)} count={count(ext)} onClick={() => pick(toggled(picked, ext))}>
          <span className="uppercase">{ext}</span>
        </Option>
      ))}
    </>
  );
}

/** Shape and pixel size, of images: usable when the list is of images alone. */
function DimsCondition({ cond, locked, onLocked }: CondProps) {
  const setFilter = useStore((s) => s.setFilter);
  const images = useStore((s) => listIs(s, "image"));
  const f = cond.filter;
  const value = [f.shapes.map((x) => SHAPE_LABEL[x]).join("・"), describeDims(f)].filter(Boolean).join(" ");
  return (
    <Pill
      label="画像サイズ"
      value={value}
      disabled={!images && !value}
      title={!images && !value ? "画像だけの一覧で使えます（種類で画像に絞る）" : undefined}
      locked={locked}
      onLocked={onLocked}
      onClear={() => setFilter(CLEARED.dims.filter!)}
      width="w-72"
    >
      {(open) => <DimsMenu open={open} f={f} />}
    </Pill>
  );
}

function DimsMenu({ open, f }: { open: boolean; f: Filter }) {
  const setFilter = useStore((s) => s.setFilter);
  const facets = useFacets("dims", open);
  return (
    <>
      {(Object.keys(SHAPE_LABEL) as Shape[]).map((sh) => (
        <Option
          key={sh}
          on={f.shapes.includes(sh)}
          count={facets ? (facets.shapes[sh] ?? 0) : null}
          onClick={() => setFilter({ shapes: toggled(f.shapes, sh) })}
        >
          {SHAPE_LABEL[sh]}
        </Option>
      ))}
      <div className="mt-1 grid grid-cols-[auto_auto_auto_auto] items-center gap-1.5 border-t border-line p-2">
        <span className="text-dim">幅</span>
        <NumField value={f.minWidth} onChange={(v) => setFilter({ minWidth: v })} placeholder="最小" />
        <span className="text-dim">〜</span>
        <NumField value={f.maxWidth} onChange={(v) => setFilter({ maxWidth: v })} placeholder="最大" />
        <span className="text-dim">高さ</span>
        <NumField value={f.minHeight} onChange={(v) => setFilter({ minHeight: v })} placeholder="最小" />
        <span className="text-dim">〜</span>
        <NumField value={f.maxHeight} onChange={(v) => setFilter({ maxHeight: v })} placeholder="最大" />
        <span className="col-span-4 pt-1 text-[11px] text-dim">px。空欄は制限なし</span>
      </div>
    </>
  );
}

function DateCondition({ cond, locked, onLocked }: CondProps) {
  const setFilter = useStore((s) => s.setFilter);
  const f = cond.filter;
  const notForSystem = useNotForSystem("追加日");
  return (
    <Pill
      {...notForSystem}
      label="追加日"
      value={describeDate(f)}
      locked={locked}
      onLocked={onLocked}
      onClear={() => setFilter(CLEARED.date.filter!)}
      width="w-72"
    >
      {(_, close) => (
        <div className="flex flex-col gap-0.5">
          {DATE_PRESETS.map((p) => (
            <Option
              key={p.label}
              single
              on={f.importedBefore == null && f.importedAfter === p.after()}
              onClick={() => {
                setFilter({ importedAfter: p.after(), importedBefore: null });
                close();
              }}
            >
              {p.label}
            </Option>
          ))}
          <div className="mt-1 border-t border-line pt-2">
            <RangeCalendar
              from={f.importedAfter}
              to={f.importedBefore != null ? previousDay(f.importedBefore) : f.importedAfter != null ? startOfToday() : null}
              onChange={(from, to) => setFilter({ importedAfter: from, importedBefore: nextDay(to) })}
            />
          </div>
        </div>
      )}
    </Pill>
  );
}

function SizeCondition({ cond, locked, onLocked }: CondProps) {
  const setFilter = useStore((s) => s.setFilter);
  const f = cond.filter;
  return (
    <Pill
      label="容量"
      value={f.minSize != null || f.maxSize != null ? describeSize(f) : ""}
      locked={locked}
      onLocked={onLocked}
      onClear={() => setFilter(CLEARED.size.filter!)}
      width="w-60"
    >
      {(_, close) => (
        <div className="flex flex-col gap-0.5">
          {SIZE_PRESETS.map((p) => (
            <Option
              key={p.label}
              single
              on={f.minSize === p.min && f.maxSize === p.max}
              onClick={() => {
                setFilter({ minSize: p.min, maxSize: p.max });
                close();
              }}
            >
              {p.label}
            </Option>
          ))}
          <div className="mt-1 flex items-center gap-1.5 border-t border-line px-1 pt-2">
            <NumField value={f.minSize} onChange={(v) => setFilter({ minSize: v })} placeholder="最小" scale={1024 * 1024} />
            <span className="text-dim">〜</span>
            <NumField value={f.maxSize} onChange={(v) => setFilter({ maxSize: v })} placeholder="最大" scale={1024 * 1024} />
            <span className="text-dim">MB</span>
          </div>
        </div>
      )}
    </Pill>
  );
}

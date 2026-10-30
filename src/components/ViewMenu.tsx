// Toolbar controls for how the list looks, each on its own: the layout
// (one click), grouping into sections (one click), and what to show per thumbnail.
import {
  ALargeSmall,
  Check,
  ChevronDown,
  Columns3,
  Group,
  LayoutGrid,
  LayoutList,
  Rows3,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { command } from "../lib/commands";
import type { GroupBy } from "../lib/grouping";
import type { ItemKind } from "../lib/api";
import {
  LIBRARY_GROUPS,
  listKinds,
  MODE_GROUPS,
  MODE_LAYOUTS,
  shownGroupBy,
  useStore,
  type Layout,
  type Mode,
  type ShowInfo,
} from "../store";
import { Slider } from "./Slider";

/** Every grouping; each mode offers its own subset (MODE_GROUPS). */
export const GROUPS: { key: GroupBy; label: string; hint: string }[] = [
  { key: "none", label: "なし", hint: "区切らずに並べる" },
  { key: "category", label: "書体", hint: "明朝・ゴシック・丸ゴシック…に分ける" },
  { key: "script", label: "言語", hint: "日本語・欧文・中国語・韓国語に分ける" },
  { key: "month", label: "年月", hint: "追加した年月ごとに分ける（新しい順）" },
  { key: "rating", label: "評価", hint: "★5 から未評価まで" },
  { key: "tag", label: "タグ", hint: "複数のタグがあるものは各タグに出る" },
  { key: "folder", label: "フォルダ", hint: "「すべて」やサブフォルダ表示で便利" },
];

/** Every layout; each mode offers its own subset (MODE_LAYOUTS). */
export const LAYOUTS: { key: Layout; label: string; icon: React.ReactNode; hint: string }[] = [
  { key: "justified", label: "標準", icon: <Rows3 size={15} />, hint: "行の高さをそろえ、縦横比のまま並べる" },
  { key: "waterfall", label: "Pinterest風", icon: <Columns3 size={15} />, hint: "列の幅をそろえ、縦に詰めて並べる" },
  { key: "grid", label: "グリッド", icon: <LayoutGrid size={15} />, hint: "同じ大きさの枠に収めて並べる" },
  { key: "list", label: "リスト", icon: <LayoutList size={15} />, hint: "1 行ずつ詳しく表示" },
  {
    key: "specimen",
    label: "見本",
    icon: <ALargeSmall size={15} />,
    hint: "フォントを 1 行ずつ大きく並べ、同じ文字で見比べる",
  },
];

/**
 * Layouts always on the toolbar; the others are in the display menu. The
 * stock puts the images' own first when the list can hold images.
 */
const PRIMARY: Record<Mode, Layout[]> = {
  stock: ["grid", "list"],
  font: ["specimen", "grid"],
};
const PRIMARY_IMAGES: Layout[] = ["justified", "waterfall"];

/** What a thumbnail can show; `only`: when the list can hold that kind. */
const INFO: { key: keyof ShowInfo; label: string; only?: ItemKind }[] = [
  { key: "name", label: "名前" },
  { key: "dims", label: "画像サイズ", only: "image" },
  { key: "rating", label: "評価" },
  { key: "meta", label: "形式・容量" },
];

/** A toolbar button with a dropdown that closes on Escape or a click elsewhere. */
export function Dropdown({
  button,
  title,
  active,
  width,
  children,
}: {
  button: React.ReactNode;
  title: string;
  /** Highlighted: the setting differs from the default. */
  active?: boolean;
  width: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        title={title}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-7 items-center gap-1.5 rounded-md px-2 whitespace-nowrap ghost ${open ? "bg-press" : ""} ${
          active ? "text-accent" : ""
        }`}
      >
        {button}
      </button>
      {open && (
        <div
          className={`absolute top-full right-0 z-40 mt-1 ${width} animate-slide-down rounded-lg border border-line bg-raised p-1 text-xs shadow-xl`}
          onClick={(e) => (e.target as HTMLElement).closest("[data-close]") && setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

const heading = "px-2 pt-1 pb-1 text-[11px] font-semibold text-dim";

/**
 * The everyday layouts side by side, one click to switch. The others sit in
 * the display menu, and show up here only while one of them is in use.
 */
export function LayoutSwitch() {
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  const mode = useStore((s) => s.mode);
  const images = useStore((s) => listKinds(s).includes("image"));
  const primary = mode === "stock" && images ? PRIMARY_IMAGES : PRIMARY[mode];
  // In the mode's order ([見本｜グリッド]), then one from the menu while in use.
  const shown = [
    ...primary.map((k) => LAYOUTS.find((l) => l.key === k)!),
    ...LAYOUTS.filter((l) => l.key === layout && !primary.includes(l.key)),
  ];
  return (
    <div className="flex h-7 shrink-0 items-stretch rounded-md track @max-4xl:hidden">
      {shown.map((l) => (
        <button
          key={l.key}
          title={`${l.label}：${l.hint}`}
          aria-label={l.label}
          aria-pressed={layout === l.key}
          onClick={() => setLayout(l.key)}
          className={`flex w-7 items-center justify-center rounded ${
            layout === l.key ? "thumb" : "text-fg/85 hover:bg-hover hover:text-fg"
          }`}
        >
          {l.icon}
        </button>
      ))}
    </div>
  );
}

/**
 * Splitting the list into sections: every choice of the mode side by side,
 * one click each, so nothing on the row moves when it changes (docs/UI.md).
 * When the toolbar is narrow the same choices fold into a menu in its place.
 */
export function GroupMenu() {
  const groupBy = useStore(shownGroupBy);
  // The installed fonts have no rating, tags or folder (docs/SYSTEM_FONTS.md).
  const system = useStore((s) => s.view.kind === "system");
  const off = (g: GroupBy) => system && LIBRARY_GROUPS.includes(g);
  const setGroupBy = useStore((s) => s.setGroupBy);
  const isSimilar = useStore((s) => s.view.kind === "similar");
  const mode = useStore((s) => s.mode);
  const groups = GROUPS.filter((g) => MODE_GROUPS[mode].includes(g.key));
  const current = groups.find((g) => g.key === groupBy) ?? groups[0];
  return (
    <div className="flex h-7 shrink-0 items-center gap-1.5">
      <span className={`@max-2xl:hidden ${isSimilar ? "text-off" : "text-dim"}`}>グループ</span>
      {/* Narrow: a native select over a label, like the sort order next to it. */}
      <label
        title={isSimilar ? "グループ分け（重複の候補では使えません）" : `グループ分け：${current.hint}`}
        className={`relative hidden h-full items-center gap-1.5 rounded-md pr-2 pl-2.5 whitespace-nowrap @max-2xl:flex ${
          isSimilar ? "off" : "ghost focus-within:border-accent"
        }`}
      >
        <span className="text-dim @max-md:hidden">グループ</span>
        <Group size={14} className="hidden text-dim @max-md:block" />
        {isSimilar ? "なし" : current.label}
        <ChevronDown size={14} className="text-dim" />
        <select
          aria-label="グループ分け"
          value={groupBy}
          disabled={isSimilar}
          onChange={(e) => setGroupBy(e.target.value as GroupBy)}
          className="absolute inset-0 cursor-default opacity-0"
        >
          {groups.map((g) => (
            <option key={g.key} value={g.key} disabled={off(g.key)}>
              {g.label}
            </option>
          ))}
        </select>
      </label>
      <div role="group" aria-label="グループ分け" className="flex h-full items-stretch rounded-md track @max-2xl:hidden">
        {groups.map((g) => {
          const on = groupBy === g.key && !isSimilar;
          return (
            <button
              key={g.key}
              disabled={isSimilar || off(g.key)}
              aria-pressed={on}
              title={
                isSimilar
                  ? "グループ分け（重複の候補では使えません）"
                  : off(g.key)
                    ? `${g.label}：この端末のフォントには使えません（ライブラリのフォントだけ）`
                    : `${g.label}：${g.hint}`
              }
              onClick={() => setGroupBy(g.key)}
              className={`rounded px-2 whitespace-nowrap disabled:off ${
                on ? "thumb font-medium" : "text-fg/85 enabled:hover:bg-hover enabled:hover:text-fg"
              }`}
            >
              {g.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Opens every linked parent's children under it, or closes them all (docs/LINKS.md).
 * Offered whenever the stock mode is open; disabled when nothing is linked, so it
 * doesn't move. `none` also tells the display menu to grey its own copy out.
 */
function useParents() {
  const links = useStore((s) => s.librarySettings.links);
  const parents = useStore(useShallow((s) => s.items.filter((i) => i.childIds).map((i) => i.id)));
  const openParents = useStore((s) => s.openParents);
  const none = !links || parents.length === 0;
  return {
    none,
    allOpen: !none && parents.every((id) => openParents.has(id)),
    set: (open: boolean) => command(open ? "view.openParents" : "view.closeParents").run(useStore.getState()),
  };
}

const PARENTS_TIP = "紐づけた項目をすべて開く／閉じる";
const parentsTitle = (none: boolean) => (none ? `${PARENTS_TIP}（この一覧に紐づけた項目はありません）` : PARENTS_TIP);

/**
 * Two states side by side, like グループ, so the state reads without a pressed
 * face. Folded into the display menu when the band gets short (docs/UI.md).
 */
export function ParentsToggle() {
  const { none, allOpen, set } = useParents();
  const seg = (open: boolean) =>
    `flex h-6 items-center rounded px-2 whitespace-nowrap disabled:off ${
      !none && allOpen === open ? "bg-tonal text-on-tonal" : "text-dim enabled:hover:bg-hover"
    }`;
  return (
    <div className="flex shrink-0 items-center gap-1.5 @max-4xl:hidden" title={parentsTitle(none)}>
      <span className="text-dim @max-7xl:hidden">紐づけ</span>
      <div className="flex gap-0.5 rounded-md bg-white/5 p-0.5">
        <button disabled={none} aria-pressed={!none && !allOpen} className={seg(false)} onClick={() => allOpen && set(false)}>
          閉じる
        </button>
        <button disabled={none} aria-pressed={allOpen} className={seg(true)} onClick={() => !allOpen && set(true)}>
          開く
        </button>
      </div>
    </div>
  );
}

/** Thumbnail size and the information shown under each thumbnail. */
export function DisplayMenu() {
  const showInfo = useStore((s) => s.showInfo);
  const setShowInfo = useStore((s) => s.setShowInfo);
  const thumbSize = useStore((s) => s.thumbSize);
  const setThumbSize = useStore((s) => s.setThumbSize);
  const layout = useStore((s) => s.layout);
  const mode = useStore((s) => s.mode);
  const kinds = useStore(useShallow(listKinds));
  // The font mode sizes its text and tiles on the specimen text row.
  const sized = mode !== "font";
  const setLayout = useStore((s) => s.setLayout);
  const parents = useParents();
  return (
    <Dropdown title="表示（レイアウト・サムネイルの大きさ・表示する情報）" width="w-64" button={<SlidersHorizontal size={15} />}>
      <div className={heading}>レイアウト</div>
      {LAYOUTS.filter((l) => MODE_LAYOUTS[mode].includes(l.key)).map((l) => (
        <button
          key={l.key}
          data-close
          onClick={() => setLayout(l.key)}
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-white/8 ${
            layout === l.key ? "text-fg" : "text-dim"
          }`}
        >
          <span className={`shrink-0 ${layout === l.key ? "text-accent" : ""}`}>{l.icon}</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span>{l.label}</span>
            <span className="text-[11px] text-dim">{l.hint}</span>
          </span>
          {layout === l.key && <Check size={13} className="shrink-0 text-accent" />}
        </button>
      ))}
      {sized && (
        <>
          <div className="mx-1.5 my-1 border-t border-line" />
          <div className={heading}>サムネイルの大きさ</div>
          <label className="flex items-center gap-2 px-2 py-1.5" title="⌘+ / ⌘-">
            <Slider
              min={80}
              max={360}
              step={10}
              value={thumbSize}
              disabled={layout === "list"}
              onChange={(e) => setThumbSize(Number(e.target.value))}
              className="min-w-0 flex-1 disabled:off"
            />
            <span className="w-10 text-right text-dim tabular-nums">{thumbSize}</span>
          </label>
        </>
      )}
      {mode === "stock" && (
        <>
          <div className="mx-1.5 my-1 border-t border-line" />
          <div className={heading}>紐づけ</div>
          <div className="flex items-center gap-2 px-2 py-1.5" title={parentsTitle(parents.none)}>
            {[
              { open: false, label: "すべて閉じる" },
              { open: true, label: "すべて開く" },
            ].map((b) => (
              <button
                key={b.label}
                data-close
                disabled={parents.none || parents.allOpen === b.open}
                onClick={() => parents.set(b.open)}
                className="h-6 flex-1 rounded border border-edge whitespace-nowrap disabled:off"
              >
                {b.label}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="mx-1.5 my-1 border-t border-line" />
      <div className={heading}>サムネイルの下に表示</div>
      {INFO.filter((i) => !i.only || kinds.includes(i.only)).map((i) => (
        <label key={i.key} className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 hover:bg-white/8">
          <input
            type="checkbox"
            checked={showInfo[i.key]}
            onChange={(e) => setShowInfo({ [i.key]: e.target.checked })}
            className="accent-accent"
          />
          {i.label}
        </label>
      ))}
    </Dropdown>
  );
}

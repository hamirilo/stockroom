// How the list looks: one popover on the toolbar ("表示") with the layout,
// the order, the grouping, the links and what each thumbnail shows. Only the
// thumbnail size stays out on the toolbar (docs/NAVIGATION.md「ツールバー」).
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  ChevronDown,
  Columns3,
  LayoutGrid,
  LayoutList,
  Rows3,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { command } from "../lib/commands";
import type { GroupBy } from "../lib/grouping";
import type { ItemKind, SortKey } from "../lib/api";
import { PIXEL_KINDS } from "../lib/kinds";
import { listKinds, useStore, type Layout, type ShowInfo } from "../store";

/** Every grouping, in the order offered. */
export const GROUPS: { key: GroupBy; label: string; hint: string }[] = [
  { key: "none", label: "なし", hint: "区切らずに並べる" },
  { key: "month", label: "年月", hint: "追加した年月ごとに分ける（新しい順）" },
  { key: "rating", label: "評価", hint: "★5 から未評価まで" },
  { key: "tag", label: "タグ", hint: "複数のタグがあるものは各タグに出る" },
  { key: "folder", label: "フォルダ", hint: "「すべて」やサブフォルダ表示で便利" },
];

/** Every layout. */
export const LAYOUTS: { key: Layout; label: string; icon: React.ReactNode; hint: string }[] = [
  { key: "justified", label: "標準", icon: <Rows3 size={15} />, hint: "行の高さをそろえ、縦横比のまま並べる" },
  { key: "waterfall", label: "Pinterest風", icon: <Columns3 size={15} />, hint: "列の幅をそろえ、縦に詰めて並べる" },
  { key: "grid", label: "グリッド", icon: <LayoutGrid size={15} />, hint: "同じ大きさの枠に収めて並べる" },
  { key: "list", label: "リスト", icon: <LayoutList size={15} />, hint: "1 行ずつ詳しく表示" },
];

/** Sort keys; `only`: offered when the list holds those kinds alone (images and videos have a pixel size). */
export const SORTS: { key: SortKey; label: string; only?: ItemKind[] }[] = [
  { key: "importedAt", label: "追加日" },
  { key: "name", label: "名前" },
  { key: "size", label: "ファイルサイズ" },
  { key: "dimensions", label: "サイズ（px）", only: PIXEL_KINDS },
  { key: "rating", label: "評価" },
  { key: "manual", label: "手動（ドラッグで並べ替え）" },
];

/** What a thumbnail can show; `only`: when the list can hold one of those kinds. */
const INFO: { key: keyof ShowInfo; label: string; only?: ItemKind[] }[] = [
  { key: "name", label: "名前" },
  { key: "dims", label: "サイズ（px）", only: ["image", "video"] },
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

const heading = "px-2 pt-1.5 pb-1 text-[11px] font-semibold text-dim";
const rule = "mx-1.5 my-1.5 border-t border-line";

/** A row of the popover: its name on the left, the control on the right. */
function Row({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-2 py-1.5" title={title}>
      <span className="w-16 shrink-0 text-dim">{label}</span>
      <div className="flex min-w-0 flex-1 justify-end">{children}</div>
    </div>
  );
}

/** Choices side by side, one picked (macOS segmented control). */
function Segment<K extends string>({
  label,
  items,
  value,
  disabled,
  onPick,
}: {
  label: string;
  items: { key: K; label: React.ReactNode; title: string }[];
  value: K | null;
  disabled?: boolean;
  onPick: (k: K) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex h-7 w-full items-stretch rounded-md track">
      {items.map((i) => {
        const on = value === i.key && !disabled;
        return (
          <button
            key={i.key}
            disabled={disabled}
            aria-pressed={on}
            title={i.title}
            onClick={() => onPick(i.key)}
            className={`flex flex-1 items-center justify-center gap-1 rounded px-1.5 whitespace-nowrap disabled:off ${
              on ? "thumb font-medium" : "text-fg/85 enabled:hover:bg-hover enabled:hover:text-fg"
            }`}
          >
            {i.label}
          </button>
        );
      })}
    </div>
  );
}

/** The order and its direction. */
function SortControl() {
  const sort = useStore((s) => s.sort);
  const desc = useStore((s) => s.desc);
  const setSort = useStore((s) => s.setSort);
  const canManual = useStore((s) => s.view.kind === "folder");
  const kinds = useStore(useShallow(listKinds));
  const sorts = SORTS.filter((s) => !s.only || (kinds.length > 0 && kinds.every((k) => s.only!.includes(k))));
  const manual = sort === "manual";
  const label = manual ? "手動" : (SORTS.find((s) => s.key === sort)?.label ?? "");
  return (
    <div className="flex h-7 w-full items-stretch gap-1">
      {/* A native select over a label, so the arrow matches the rest. */}
      <label className="relative flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-edge pr-1.5 pl-2.5 whitespace-nowrap focus-within:border-accent">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronDown size={14} className="shrink-0 text-dim" />
        <select
          aria-label="並び順"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey, desc)}
          className="absolute inset-0 cursor-default opacity-0"
        >
          {sorts.map((s) => (
            <option key={s.key} value={s.key} disabled={s.key === "manual" && !canManual}>
              {s.key === "manual" && !canManual ? "手動（フォルダのみ）" : s.label}
            </option>
          ))}
        </select>
      </label>
      <button
        title={manual ? "手動の並びは昇順のみ" : desc ? "降順（クリックで昇順）" : "昇順（クリックで降順）"}
        aria-label={desc ? "降順" : "昇順"}
        disabled={manual}
        onClick={() => setSort(sort, !desc)}
        className="flex w-8 shrink-0 items-center justify-center rounded-md border border-edge enabled:hover:bg-hover disabled:off"
      >
        {desc ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}
      </button>
    </div>
  );
}

/**
 * Opens every linked parent's children under it, or closes them all (docs/LINKS.md).
 * `none`: nothing in the list is linked.
 */
function useParents() {
  const parents = useStore(useShallow((s) => s.items.filter((i) => i.childIds).map((i) => i.id)));
  const openParents = useStore((s) => s.openParents);
  const none = parents.length === 0;
  return {
    none,
    allOpen: !none && parents.every((id) => openParents.has(id)),
    set: (open: boolean) => command(open ? "view.openParents" : "view.closeParents").run(useStore.getState()),
  };
}

/**
 * "表示": how the list looks, in one popover (docs/NAVIGATION.md「表示のポップオーバー」).
 * It stays open while things are picked, so several can be changed in a row;
 * a click elsewhere or Esc closes it. The rows are always the same (what
 * can't be used is greyed out), except 紐づけ, there only for a library that
 * uses links.
 */
export function ViewPopover() {
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  const groupBy = useStore((s) => s.groupBy);
  const setGroupBy = useStore((s) => s.setGroupBy);
  const isSimilar = useStore((s) => s.view.kind === "similar");
  const links = useStore((s) => s.librarySettings.links);
  const showInfo = useStore((s) => s.showInfo);
  const setShowInfo = useStore((s) => s.setShowInfo);
  const kinds = useStore(useShallow(listKinds));
  const parents = useParents();
  const current = LAYOUTS.find((l) => l.key === layout) ?? LAYOUTS[0];
  return (
    <Dropdown
      title={`表示：${current.label}（レイアウト・並び順・グループ・表示する情報）`}
      width="w-80"
      button={
        <>
          {current.icon}
          <span className="@max-[50rem]:hidden">表示</span>
          <ChevronDown size={13} className="text-dim" />
        </>
      }
    >
      <Row label="レイアウト">
        <Segment
          label="レイアウト"
          value={layout}
          onPick={setLayout}
          items={LAYOUTS.map((l) => ({ key: l.key, label: l.icon, title: `${l.label}：${l.hint}` }))}
        />
      </Row>
      <Row label="並び順">
        <SortControl />
      </Row>
      <Row label="グループ" title={isSimilar ? "重複の候補では使えません" : undefined}>
        <Segment
          label="グループ分け"
          value={groupBy}
          disabled={isSimilar}
          onPick={setGroupBy}
          items={GROUPS.map((g) => ({ key: g.key, label: g.label, title: `${g.label}：${g.hint}` }))}
        />
      </Row>
      {links && (
        <Row label="紐づけ" title={parents.none ? "この一覧に紐づけた項目はありません" : "紐づけた項目をすべて開く／閉じる"}>
          <Segment
            label="紐づけ"
            value={parents.none ? null : parents.allOpen ? "open" : "closed"}
            disabled={parents.none}
            onPick={(k) => parents.set(k === "open")}
            items={[
              { key: "closed", label: "すべて閉じる", title: "紐づけた項目をすべて閉じる" },
              { key: "open", label: "すべて開く", title: "紐づけた項目をすべて開く" },
            ]}
          />
        </Row>
      )}
      <div className={rule} />
      <div className={heading}>サムネイルの下に表示</div>
      <div className="grid grid-cols-2 px-1 pb-1">
        {INFO.filter((i) => !i.only || i.only.some((k) => kinds.includes(k))).map((i) => (
          <label key={i.key} className="flex cursor-default items-center gap-2 rounded px-1 py-1.5 hover:bg-ink/8">
            <input
              type="checkbox"
              checked={showInfo[i.key]}
              onChange={(e) => setShowInfo({ [i.key]: e.target.checked })}
              className="accent-accent"
            />
            {i.label}
          </label>
        ))}
      </div>
    </Dropdown>
  );
}

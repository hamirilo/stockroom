import {
  ArrowDownWideNarrow,
  ArrowUpDown,
  ArrowUpNarrowWide,
  ChevronDown,
  CopyCheck,
  FolderInput,
  FolderSearch,
  ImagePlus,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Search,
  Tag as TagIcon,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { dragRegion } from "../lib/titleBar";
import {
  clearDismissedDuplicates,
  emptyTrash,
  importFilesDialog,
  importFolderDialog,
  keepPlan,
  reviewDuplicates,
  similarGroups,
} from "../lib/actions";
import { SpecimenControls } from "../features/fonts/SpecimenControls";
import { reloadSystemFonts } from "../features/fonts/system";
import { kindsNoun } from "../lib/modes";
import { type Folder, type ItemKind, type SimilarLevel, type SmartFolder, type SortKey, type Tag, type View } from "../lib/api";
import { colorHex } from "../lib/colors";
import { command } from "../lib/commands";
import { useShallow } from "zustand/react/shallow";
import { activeConditions, listKinds, placeTotal, shownKinds, useStore, type Mode } from "../store";
import { composing } from "../lib/ime";
import { FilterRow } from "./FilterRow";
import { DisplayMenu, GroupMenu, LayoutSwitch, ParentsToggle } from "./ViewMenu";
import { Slider } from "./Slider";

/** Thin line between groups of controls. */
const Divider = ({ className = "" }: { className?: string }) => (
  <div className={`mx-0.5 h-5 w-px shrink-0 bg-line ${className}`} />
);

/** Sort keys; `only`: offered when the list is of that kind alone (only images have a pixel size). */
export const SORTS: { key: SortKey; label: string; only?: ItemKind }[] = [
  { key: "importedAt", label: "追加日" },
  { key: "name", label: "名前" },
  { key: "size", label: "ファイルサイズ" },
  { key: "dimensions", label: "画像サイズ", only: "image" },
  { key: "rating", label: "評価" },
  { key: "manual", label: "手動（ドラッグで並べ替え）" },
];

const searchHelp = (mode: Mode) =>
  [
    mode === "font" ? "名前・ファミリー名・メモ・タグを検索" : "名前・メモ・タグ・テキストの本文を検索",
    "  空白区切り … すべてを含む",
    "  -語 … 除外",
    "  A OR B / A || B … どちらか",
    "  ( ) … グループ化、\"語句\" … 完全一致",
  ].join("\n");

function viewTitle(view: View, mode: Mode, folders: Folder[], smart: SmartFolder[], tags: Tag[]): string {
  switch (view.kind) {
    case "all":
      return mode === "font" ? "すべてのフォント" : "すべて";
    case "unfiled":
      return "未分類";
    case "untagged":
      return "タグなし";
    case "trash":
      return "ゴミ箱";
    case "similar":
      return "重複の候補";
    case "favorites":
      return "お気に入り";
    case "pinned":
      return "ピン留め";
    case "tray":
      return "シェルフ";
    case "folder":
      return folders.find((f) => f.id === view.id)?.name ?? "";
    case "smart":
      return smart.find((f) => f.id === view.id)?.name ?? "";
    case "tag":
      return tags.find((t) => t.id === view.id)?.name ?? "";
    case "system":
      return "この端末のフォント";
  }
}

export function Toolbar() {
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const tags = useStore((s) => s.tags);
  const items = useStore((s) => s.items);
  // Number of images (with tag grouping an image can be listed more than once).
  const count = useStore((s) => s.rawItems.length);
  const selectedCount = useStore((s) => s.selected.size);
  const setSelection = useStore((s) => s.setSelection);
  const view = useStore((s) => s.view);
  const folders = useStore((s) => s.folders);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const smartFolders = useStore((s) => s.smartFolders);
  const editingSmart = useStore((s) => s.editingSmart);
  const conditions = useStore(activeConditions);
  // "5 / 13 件" while narrowed: of the place's items without conditions.
  const total = useStore((s) => (activeConditions(s) > 0 ? placeTotal(s) : null));
  const mode = useStore((s) => s.mode);
  const addNoun = useStore((s) => kindsNoun(shownKinds(s)));
  const smart = view.kind === "smart" ? smartFolders.find((f) => f.id === view.id) : undefined;
  const isTrash = view.kind === "trash";
  const isSimilar = view.kind === "similar";
  const isSystem = view.kind === "system";
  const [reloading, setReloading] = useState(false);
  const groups = useMemo(() => (isSimilar ? similarGroups(items) : []), [isSimilar, items]);
  const keepPick = useStore((s) => s.keepPick);

  // Debounce typing so each keystroke doesn't hit the DB.
  const [text, setText] = useState(search);
  useEffect(() => setText(search), [search]);
  useEffect(() => {
    if (text === search) return;
    const t = setTimeout(() => setSearch(text), 200);
    return () => clearTimeout(t);
  }, [text, search, setSearch]);

  return (
    <header
      {...dragRegion(true)}
      className="@container flex flex-col gap-2 border-b border-line bg-panel px-4 py-2 transition-[padding] duration-200 ease-out"
      // With the sidebar closed, the macOS window buttons are over this bar.
      style={sidebarOpen ? undefined : { paddingLeft: "max(1rem, var(--traffic-lights))" }}
    >
      {/* Collapses progressively by toolbar width (container queries) so nothing
          overflows into the inspector: label → slider → two rows. */}
      <div className="flex items-center gap-x-3 gap-y-2 @max-xl:flex-col @max-xl:items-stretch">
        {/* Sized to its content; the right side takes the rest, so short of room the
            search box gives way first, then the title (never the count or the actions). */}
        <div className="flex items-center gap-2">
          <button
            title={`サイドバーを${sidebarOpen ? "隠す" : "表示"}（Tab / ⌘⌥1）`}
            onClick={toggleSidebar}
            className={`-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-white/5 ${
              sidebarOpen ? "text-dim" : "text-accent"
            }`}
          >
            {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
          <h1 className="flex items-baseline gap-2 text-base font-semibold">
            {smart && <FolderSearch size={15} className="shrink-0 self-center text-accent" />}
            {view.kind === "tag" && (
              <TagIcon
                size={15}
                className="shrink-0 self-center"
                style={{ color: colorHex(tags.find((t) => t.id === view.id)?.color) }}
              />
            )}
            <span className="truncate">
              {editingSmart ? `「${editingSmart.name}」の条件` : viewTitle(view, mode, folders, smartFolders, tags)}
            </span>
            {selectedCount > 0 ? (
              <span className="flex shrink-0 items-center gap-1 self-center rounded-full bg-accent/20 py-0.5 pr-0.5 pl-2.5 text-xs font-normal text-accent tabular-nums">
                {selectedCount} 件を選択中
                <span className="text-accent/60">/ {count}</span>
                <button
                  title="選択を解除（Esc）"
                  onClick={() => setSelection([])}
                  className="rounded-full p-0.5 hover:bg-accent/25"
                >
                  <X size={12} />
                </button>
              </span>
            ) : (
              <span
                className={`shrink-0 text-xs font-normal tabular-nums ${total !== null ? "text-accent" : "text-dim"}`}
                title={total !== null ? `絞り込み中（条件 ${conditions} 個）` : undefined}
              >
                {total !== null ? `${count} / ${total} 件` : `${count} 件`}
              </span>
            )}
          </h1>
          <div className="flex-1" />
          <InspectorToggle className="hidden @max-xl:flex" />
        </div>
        <div className="flex flex-1 items-center justify-end gap-2">
          <label
            title={searchHelp(mode)}
            className="flex h-8 min-w-28 shrink basis-60 items-center gap-2 rounded-md border border-transparent bg-white/7 px-2 focus-within:border-accent @max-xl:min-w-0 @max-xl:flex-1"
          >
            <Search size={14} className="shrink-0 text-dim" />
            <input
              id="search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && !composing(e) && (setText(""), e.currentTarget.blur())}
              placeholder="検索（-除外 / OR）"
              className="w-0 min-w-0 flex-1 bg-transparent outline-none placeholder:text-dim"
            />
            {/* Hidden while empty, its room kept (docs/UI.md). */}
            <button onClick={() => setText("")} className={`text-dim hover:text-fg ${text ? "" : "invisible"}`}>
              <X size={14} />
            </button>
          </label>
          <Divider />
          {isTrash ? (
            <button
              title="ゴミ箱を空にする"
              onClick={emptyTrash}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-danger/60 px-3 whitespace-nowrap text-danger hover:bg-danger/10 @max-3xl:px-2"
            >
              <Trash2 size={15} className="hidden @max-3xl:block" />
              <span className="@max-3xl:hidden">ゴミ箱を空にする</span>
            </button>
          ) : isSimilar ? (
            <button
              title="残す1枚を確認してから、残りをゴミ箱へ移動"
              disabled={groups.length === 0}
              onClick={() => reviewDuplicates(keepPlan(groups, keepPick))}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 whitespace-nowrap ghost disabled:off @max-3xl:px-2"
            >
              <CopyCheck size={15} /> <span className="@max-3xl:hidden">まとめて整理…</span>
            </button>
          ) : isSystem ? (
            // Fonts installed or removed since they were read (docs/SYSTEM_FONTS.md).
            <button
              title="フォントのフォルダを読み直して、インストール・削除したフォントを反映"
              disabled={reloading}
              onClick={() => {
                setReloading(true);
                void reloadSystemFonts().finally(() => setReloading(false));
              }}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 whitespace-nowrap ghost disabled:off @max-3xl:px-2"
            >
              <RefreshCw size={15} className={reloading ? "animate-spin" : ""} />
              <span className="@max-3xl:hidden">読み込み直す</span>
            </button>
          ) : (
            // The two ways to add, quiet until hovered (docs/UI.md「色」).
            <div className="flex h-8 shrink-0 items-stretch gap-0.5">
              <button
                title={`${addNoun}を追加`}
                onClick={importFilesDialog}
                className="flex items-center gap-1.5 rounded-md px-2.5 whitespace-nowrap hover:bg-hover active:bg-press"
              >
                <ImagePlus size={15} /> <span className="@max-3xl:hidden">追加</span>
              </button>
              <button
                title="フォルダから追加"
                onClick={importFolderDialog}
                className="flex w-8 items-center justify-center rounded-md hover:bg-hover active:bg-press"
              >
                <FolderInput size={15} />
              </button>
            </div>
          )}
          <InspectorToggle className="flex @max-xl:hidden" />
        </div>
      </div>
      {/* The font mode's text row stays whatever the layout (docs/UI.md). */}
      {mode === "font" && <SpecimenControls />}
      {/* One band for the conditions, this view's own controls and how the list
          looks (docs/NAVIGATION.md). It folds a step at a time as the toolbar
          narrows instead of growing a row (docs/UI.md). */}
      <FilterRow viewControls={<ViewControls />} display={<DisplayControls />} />
    </header>
  );
}

/**
 * The open view's own controls: they narrow or describe this list only
 * (docs/UI.md「この表示の操作」). Right of the conditions, so the first
 * condition is in the same place whatever view is open.
 */
function ViewControls() {
  const view = useStore((s) => s.view);
  const showSubfolders = useStore((s) => s.showSubfolders);
  const setShowSubfolders = useStore((s) => s.setShowSubfolders);
  const items = useStore((s) => s.items);
  const count = useStore((s) => s.rawItems.length);
  const dismissedGroups = useStore((s) => s.dismissedGroups);
  const isSimilar = view.kind === "similar";
  const groups = useMemo(() => (isSimilar ? similarGroups(items) : []), [isSimilar, items]);

  if (view.kind === "folder")
    return (
      <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-dim hover:text-fg" title="このフォルダのサブフォルダに入っているものも一覧に出す">
        <input
          type="checkbox"
          checked={showSubfolders}
          onChange={(e) => setShowSubfolders(e.target.checked)}
          className="accent-accent"
        />
        サブフォルダ<span className="@max-5xl:hidden">の内容も表示</span>
      </label>
    );
  if (!isSimilar) return null;
  return (
    <div className="flex min-w-0 shrink items-center gap-3 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <SimilarLevelControl />
      {groups.length > 0 && (
        <span
          className="shrink-0 whitespace-nowrap text-dim tabular-nums @max-6xl:hidden"
          title="画像の「残す」で残す 1 枚を選べます（初期値は解像度が最も高い画像）"
        >
          {groups.length} グループ・重複 {count - groups.length} 枚
        </span>
      )}
      {dismissedGroups > 0 && (
        <button
          onClick={clearDismissedDuplicates}
          title="「重複ではない」にした候補をすべて元に戻します"
          className="shrink-0 rounded px-1.5 py-0.5 whitespace-nowrap text-accent hover:bg-accent/15"
        >
          無視した {dismissedGroups} 件を戻す
        </button>
      )}
    </div>
  );
}

/**
 * How the list looks, at the right end of the band. As the toolbar narrows
 * these fold in reverse order of how often they are used, each staying in its
 * own place: the thumbnail slider first (the display menu has the same one),
 * then 紐づけ and レイアウト into that menu, the order down to its icon, and
 * the grouping last of all (docs/UI.md).
 */
function DisplayControls() {
  const sort = useStore((s) => s.sort);
  const desc = useStore((s) => s.desc);
  const setSort = useStore((s) => s.setSort);
  const layout = useStore((s) => s.layout);
  const mode = useStore((s) => s.mode);
  const view = useStore((s) => s.view);
  const kinds = useStore(useShallow(listKinds));
  const sorts = SORTS.filter((s) => !s.only || (kinds.length === 1 && kinds[0] === s.only));
  const isSystem = view.kind === "system";
  const canManual = view.kind === "folder";
  const manual = sort === "manual";
  const sortLabel = manual ? "手動" : (SORTS.find((s) => s.key === sort)?.label ?? "");
  return (
    <>
      {/* The order and its direction side by side, quiet until hovered. */}
      <div className="flex h-7 shrink-0 items-stretch gap-0.5">
        {/* Native select laid over a label sized to the current choice, so long
            names aren't clipped and the arrow matches the UI. The label holds a
            width for the longest one, so picking another doesn't push what is
            to its right (docs/UI.md). */}
        <label
          title={`並び順：${sortLabel}`}
          className="relative flex min-w-[7.75rem] items-center gap-1.5 rounded-md pr-2 pl-2.5 whitespace-nowrap hover:bg-hover focus-within:ring-2 focus-within:ring-accent @max-4xl:min-w-0 @max-4xl:px-2"
        >
          <ArrowUpDown size={14} className="hidden text-dim @max-4xl:block" />
          <span className="@max-4xl:hidden">{sortLabel}</span>
          <ChevronDown size={14} className="text-dim" />
          <select
            aria-label="並び順"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey, desc)}
            className="absolute inset-0 cursor-default opacity-0"
          >
            {sorts.map((s) => (
              <option
                key={s.key}
                value={s.key}
                disabled={(s.key === "manual" && !canManual) || (isSystem && s.key === "rating")}
              >
                {s.key === "manual" && !canManual
                  ? "手動（フォルダのみ）"
                  : isSystem && s.key === "rating"
                    ? "評価（ライブラリのフォントのみ）"
                    : s.label}
              </option>
            ))}
          </select>
        </label>
        <button
          title={manual ? "手動の並びは昇順のみ" : desc ? "降順" : "昇順"}
          disabled={manual}
          onClick={() => setSort(sort, !desc)}
          className="flex w-7 items-center justify-center rounded-md enabled:hover:bg-hover enabled:active:bg-press disabled:off"
        >
          {desc ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}
        </button>
      </div>
      <GroupMenu />
      {mode === "stock" && <ParentsToggle />}
      <Divider className="@max-4xl:hidden" />
      <LayoutSwitch />
      <DisplayMenu />
      {/* The font mode's sizes are on the specimen text row. */}
      {mode !== "font" && <ThumbSize hidden={layout === "list"} />}
    </>
  );
}

/** Thumbnail size: the slider, with − / + that step like ⌘- / ⌘+. */
function ThumbSize({ hidden }: { hidden: boolean }) {
  const thumbSize = useStore((s) => s.thumbSize);
  const setThumbSize = useStore((s) => s.setThumbSize);
  const zoom = (id: "view.zoomIn" | "view.zoomOut") => command(id).run(useStore.getState());
  const step = "flex h-6 w-5 shrink-0 items-center justify-center rounded text-dim hover:bg-white/8 hover:text-fg";
  return (
    // The first thing to fold: the display menu holds the same slider.
    <div className={`flex shrink-0 items-center @max-[96rem]:hidden ${hidden ? "hidden" : ""}`}>
      <button title="縮小（⌘-）" onClick={() => zoom("view.zoomOut")} className={step}>
        <Minus size={13} />
      </button>
      <Slider
        min={80}
        max={360}
        step={10}
        value={thumbSize}
        onChange={(e) => setThumbSize(Number(e.target.value))}
        title="サムネイルサイズ（⌘+ / ⌘-）"
        className="mx-1 w-20"
      />
      <button title="拡大（⌘+）" onClick={() => zoom("view.zoomIn")} className={step}>
        <Plus size={13} />
      </button>
    </div>
  );
}

/** Rendered twice (end of the row, or top-right when the toolbar is stacked). */
function InspectorToggle({ className }: { className: string }) {
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const toggleInspector = useStore((s) => s.toggleInspector);
  return (
    <button
      title={`詳細パネルを${inspectorOpen ? "閉じる" : "開く"}（⌘/Ctrl+I）`}
      onClick={toggleInspector}
      className={`h-8 w-8 shrink-0 items-center justify-center rounded-md ghost ${className} ${
        inspectorOpen ? "" : "text-accent"
      }`}
    >
      {inspectorOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
    </button>
  );
}

const LEVELS: { key: SimilarLevel; label: string; hint: string }[] = [
  { key: "strict", label: "ほぼ同じ", hint: "リサイズや再保存だけ違う、ほぼ同一の画像" },
  { key: "standard", label: "似ている", hint: "構図と色が同じ画像（標準）" },
  { key: "loose", label: "やや似ている", hint: "なんとなく似ている画像まで。無関係なものも混ざります" },
];

/** Similar view: how alike two images must be to be grouped. */
function SimilarLevelControl() {
  const level = useStore((s) => s.similarLevel);
  const setLevel = useStore((s) => s.setSimilarLevel);
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="shrink-0 whitespace-nowrap text-dim @max-4xl:hidden">似ている度合い</span>
      <div className="flex h-6 shrink-0 items-stretch rounded-md track">
        {LEVELS.map((l) => (
          <button
            key={l.key}
            title={l.hint}
            onClick={() => setLevel(l.key)}
            className={`rounded px-2.5 whitespace-nowrap ${
              level === l.key ? "thumb font-medium" : "text-fg/85 hover:bg-hover hover:text-fg"
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>
    </div>
  );
}

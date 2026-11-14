import {
  ChevronDown,
  CopyCheck,
  FolderSearch,
  ListFilter,
  Minus,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
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
  keepPlan,
  reviewDuplicates,
  similarGroups,
} from "../lib/actions";
import { type Folder, type SimilarLevel, type SmartFolder, type Tag, type View } from "../lib/api";
import { colorHex } from "../lib/colors";
import { command } from "../lib/commands";
import { activeConditions, filterRowShown, placeTotal, useStore } from "../store";
import { composing } from "../lib/ime";
import { FilterRow } from "./FilterRow";
import { ViewPopover } from "./ViewMenu";
import { Slider } from "./Slider";

const SEARCH_HELP = [
  "名前・メモ・タグ・テキストの本文を検索",
  "  空白区切り … すべてを含む",
  "  -語 … 除外",
  "  A OR B / A || B … どちらか",
  "  ( ) … グループ化、\"語句\" … 完全一致",
].join("\n");

function viewTitle(view: View, folders: Folder[], smart: SmartFolder[], tags: Tag[]): string {
  switch (view.kind) {
    case "all":
      return "すべて";
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
  }
}

export function Toolbar() {
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const tags = useStore((s) => s.tags);
  // Number of images (with tag grouping an image can be listed more than once).
  const count = useStore((s) => s.rawItems.length);
  const view = useStore((s) => s.view);
  const folders = useStore((s) => s.folders);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const smartFolders = useStore((s) => s.smartFolders);
  const editingSmart = useStore((s) => s.editingSmart);
  const conditions = useStore(activeConditions);
  // "5 / 13 件" while narrowed: of the place's items without conditions.
  const total = useStore((s) => (activeConditions(s) > 0 ? placeTotal(s) : null));
  const smart = view.kind === "smart" ? smartFolders.find((f) => f.id === view.id) : undefined;
  const rowShown = useStore(filterRowShown);

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
      className="@container flex flex-col border-b border-line bg-panel px-4 transition-[padding] duration-200 ease-out"
      // With the sidebar closed, the macOS window buttons are over this bar.
      style={sidebarOpen ? undefined : { paddingLeft: "max(1rem, var(--traffic-lights))" }}
    >
      {/* One row (docs/NAVIGATION.md「ツールバー」): the place and this view's own
          controls on the left; the thumbnail size, the filter row's switch, "表示",
          the appearance, the search box and the details panel on the right. It
          folds by toolbar width (container queries, docs/UI.md「畳む順番」) and
          stacks into two only at @xl. */}
      <div className="flex items-center gap-x-3 gap-y-2 py-2 @max-xl:flex-col @max-xl:items-stretch">
        {/* Sized to its content; short of room this view's controls give way
            first, then the title (never the count). */}
        <div className="flex min-w-0 items-center gap-2">
          {/* 隠すボタンはサイドバーの上端にある（Sidebar.tsx）。閉じているあいだだけ、開くボタンをここに出す。 */}
          {!sidebarOpen && (
            <button
              title="サイドバーを表示（Tab / ⌘⌥1）"
              aria-label="サイドバーを表示"
              onClick={toggleSidebar}
              className="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-accent hover:bg-ink/5"
            >
              <PanelLeftOpen size={16} />
            </button>
          )}
          <h1 className="flex min-w-0 items-baseline gap-2 text-base font-semibold">
            {smart && <FolderSearch size={15} className="shrink-0 self-center text-accent" />}
            {view.kind === "tag" && (
              <TagIcon
                size={15}
                className="shrink-0 self-center"
                style={{ color: colorHex(tags.find((t) => t.id === view.id)?.color) }}
              />
            )}
            <span className="min-w-0 max-w-[16rem] truncate">
              {editingSmart ? `「${editingSmart.name}」の条件` : viewTitle(view, folders, smartFolders, tags)}
            </span>
            {/* 選んでいる件数は選択バーに出す（docs/MENUS.md §7）。ここはいつも一覧の件数。 */}
            <span
              className={`shrink-0 text-xs font-normal tabular-nums ${total !== null ? "text-accent" : "text-dim"}`}
              title={total !== null ? `絞り込み中（条件 ${conditions} 個）` : undefined}
            >
              {total !== null ? `${count} / ${total} 件` : `${count} 件`}
            </span>
          </h1>
          {/* This view's own controls, right of the title: what is right of
              them stays put when the view changes (docs/UI.md). */}
          <div className="flex min-w-0 items-center gap-3 text-xs">
            <ViewControls />
          </div>
          <div className="flex-1" />
          <InspectorToggle className="hidden @max-xl:flex" />
        </div>
        {/* Never squeezed (they would run into the title): the title gives way instead. */}
        <div className="flex flex-1 shrink-0 items-center justify-end gap-2">
          <ThumbSize />
          <FilterToggle />
          <ViewPopover />
          <label
            title={SEARCH_HELP}
            className="flex h-8 min-w-40 shrink basis-60 @max-[50rem]:min-w-32 items-center gap-2 rounded-md border border-transparent bg-ink/7 px-2 focus-within:border-accent @max-[50rem]:basis-40 @max-xl:min-w-0 @max-xl:flex-1"
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
          <InspectorToggle className="flex @max-xl:hidden" />
        </div>
      </div>
      {/* The conditions, only while the user has the row open (or a smart
          folder shows its own). Opening it moves the list down: the user's own
          doing (docs/UI.md, the exception for what the user opens and closes). */}
      {rowShown && <FilterRow />}
    </header>
  );
}

/**
 * Everything that belongs to the open view alone — what narrows it, what
 * describes it, and its one action (docs/UI.md「ツールバー」). Right of the
 * title, so nothing right of it moves whatever view is open; the action stays
 * put while the rest scrolls when room runs short.
 *
 * Adding isn't here: things are dropped onto the window, or added from the
 * ファイル menu (docs/MENUS.md).
 */
function ViewControls() {
  const view = useStore((s) => s.view);
  const showSubfolders = useStore((s) => s.showSubfolders);
  const setShowSubfolders = useStore((s) => s.setShowSubfolders);
  const items = useStore((s) => s.items);
  const count = useStore((s) => s.rawItems.length);
  const dismissedGroups = useStore((s) => s.dismissedGroups);
  const keepPick = useStore((s) => s.keepPick);
  const isSimilar = view.kind === "similar";
  const groups = useMemo(() => (isSimilar ? similarGroups(items) : []), [isSimilar, items]);

  if (view.kind === "folder")
    return (
      <label
        className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-dim hover:text-fg"
        title="このフォルダのサブフォルダに入っているものも一覧に出す"
      >
        <input
          type="checkbox"
          checked={showSubfolders}
          onChange={(e) => setShowSubfolders(e.target.checked)}
          className="accent-accent"
        />
        サブフォルダ<span className="@max-5xl:hidden">の内容も表示</span>
      </label>
    );

  if (view.kind === "trash")
    return (
      <button
        title="ゴミ箱を空にする"
        onClick={emptyTrash}
        className={`${viewAction} border border-danger/60 text-danger hover:bg-danger/10`}
      >
        <Trash2 size={14} /> <span className="@max-5xl:hidden">ゴミ箱を空にする</span>
      </button>
    );

  if (!isSimilar) return null;
  return (
    <>
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
      <button
        title="残す1枚を確認してから、残りをゴミ箱へ移動"
        disabled={groups.length === 0}
        onClick={() => reviewDuplicates(keepPlan(groups, keepPick))}
        className={`${viewAction} ghost disabled:off`}
      >
        <CopyCheck size={14} /> <span className="@max-5xl:hidden">まとめて整理…</span>
      </button>
    </>
  );
}

/** The open view's one action, in the same place whatever it is. */
const viewAction = "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 whitespace-nowrap @max-5xl:px-2";

/**
 * Thumbnail size, always on the toolbar (docs/NAVIGATION.md「ツールバー」): the
 * slider, with − / + that step like ⌘- / ⌘+. Narrow, the slider folds and
 * − / + stay (docs/UI.md「畳む順番」). Greyed out for the list layout.
 */
function ThumbSize() {
  const thumbSize = useStore((s) => s.thumbSize);
  const setThumbSize = useStore((s) => s.setThumbSize);
  const off = useStore((s) => s.layout === "list");
  const zoom = (id: "view.zoomIn" | "view.zoomOut") => command(id).run(useStore.getState());
  const step = "flex h-6 w-5 shrink-0 items-center justify-center rounded text-dim enabled:hover:bg-ink/8 enabled:hover:text-fg disabled:off";
  const tip = off ? "サムネイルの大きさ（リストでは使えません）" : undefined;
  return (
    <div className="flex shrink-0 items-center" title={tip}>
      <button disabled={off} title={tip ?? "縮小（⌘-）"} onClick={() => zoom("view.zoomOut")} className={step}>
        <Minus size={13} />
      </button>
      <Slider
        min={80}
        max={360}
        step={10}
        value={thumbSize}
        disabled={off}
        onChange={(e) => setThumbSize(Number(e.target.value))}
        title={tip ?? "サムネイルの大きさ（⌘+ / ⌘-）"}
        className="mx-1 w-24 disabled:off @max-[44rem]:hidden"
      />
      <button disabled={off} title={tip ?? "拡大（⌘+）"} onClick={() => zoom("view.zoomIn")} className={step}>
        <Plus size={13} />
      </button>
    </div>
  );
}

/**
 * Opens and closes the filter row (docs/NAVIGATION.md「絞り込みの行」). With
 * conditions on it is filled and shows how many, open or closed, so a narrowed
 * list is never a surprise. A smart folder shows the row whatever the choice.
 */
function FilterToggle() {
  const shown = useStore(filterRowShown);
  const n = useStore(activeConditions);
  const locked = useStore((s) => s.view.kind === "smart" || s.editingSmart !== null);
  const toggle = useStore((s) => s.toggleFilterRow);
  const title = locked
    ? "スマートフォルダの条件を表示中"
    : `絞り込みの行を${shown ? "閉じる" : "開く"}（⌘⇧F で条件へ）${n ? `。条件 ${n} 個` : ""}`;
  return (
    <button
      title={title}
      aria-pressed={shown}
      disabled={locked}
      onClick={toggle}
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 whitespace-nowrap disabled:opacity-80 ${
        n ? "bg-tonal text-on-tonal enabled:hover:brightness-110" : shown ? "bg-press" : "ghost"
      }`}
    >
      <ListFilter size={15} />
      <span className="@max-[50rem]:hidden">絞り込み</span>
      {n > 0 && <span className="font-medium tabular-nums">{n}</span>}
      <ChevronDown size={13} className={`transition-transform ${shown ? "rotate-180" : ""} ${n ? "" : "text-dim"}`} />
    </button>
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

/**
 * Similar view: how alike two images must be to be grouped. Side by side
 * while there is room; below @5xl the same choices fold into a select in the
 * same place, like the grouping does (docs/UI.md「畳む順番」).
 */
function SimilarLevelControl() {
  const level = useStore((s) => s.similarLevel);
  const setLevel = useStore((s) => s.setSimilarLevel);
  const current = LEVELS.find((l) => l.key === level) ?? LEVELS[1];
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="shrink-0 whitespace-nowrap text-dim @max-6xl:hidden">似ている度合い</span>
      <label
        title={`似ている度合い：${current.hint}`}
        className="relative hidden h-7 shrink-0 items-center gap-1.5 rounded-md pr-2 pl-2.5 whitespace-nowrap ghost focus-within:border-accent @max-5xl:flex @max-[50rem]:pl-2"
      >
        <CopyCheck size={13} className="text-dim" />
        <span className="@max-[50rem]:hidden">{current.label}</span>
        <ChevronDown size={14} className="text-dim" />
        <select
          aria-label="似ている度合い"
          value={level}
          onChange={(e) => setLevel(e.target.value as SimilarLevel)}
          className="absolute inset-0 cursor-default opacity-0"
        >
          {LEVELS.map((l) => (
            <option key={l.key} value={l.key}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex h-6 shrink-0 items-stretch rounded-md track @max-5xl:hidden">
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

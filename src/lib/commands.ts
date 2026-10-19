/**
 * Every operation of the app, defined once (docs/MENUS.md §1). The menu bar,
 * the right-click menus, the list's keyboard handling and the shortcut list
 * (?) are all made from this table, so a name and its key read the same
 * everywhere.
 *
 * Keys are written like "Mod+Shift+R": Mod is ⌘ on macOS and Ctrl elsewhere.
 * The first key is the one menus show.
 */
import {
  Copy,
  FlipHorizontal2,
  FlipVertical2,
  FolderInput,
  Heart,
  Layers,
  Pin,
  Trash2,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { RotateLeft, RotateRight } from "./icons";
import {
  copySelection,
  copyTags,
  createFolder,
  createFolderHere,
  createLibraryDialog,
  createSmartFolder,
  deleteSelection,
  exportLibrary,
  exportList,
  moveToLastFolder,
  onShelf,
  openLibraryDialog,
  openSelection,
  orient,
  pasteTags,
  selectionOrShown,
  setRating,
  sheetList,
  shiftFolder,
  toggleFavorite,
  togglePinned,
  toggleTray,
  transferAllOfKind,
  transferableKind,
  transferList,
  trayList,
} from "./actions";
import { api, isSystemId, kindLabel, type Item, type ItemKind } from "./api";
import { fontApi } from "../features/fonts/api";
import { checkForUpdate, openReleaseNotes } from "./update";
import { COMPARE_ZOOM, currentFolderId, listKinds, MODES, shelfShown, shownModes, useStore, zoomLook } from "../store";
import { modeLabel } from "./modes";
import { rowIds } from "./grouping";
import { useShortcutHelp } from "../components/ShortcutHelp";
import { createText } from "../features/texts/actions";

type S = ReturnType<typeof useStore.getState>;

export interface Command {
  id: string;
  /** Name in the shortcut list and the default label. */
  title: string;
  /** The label for the current state ("お気に入りに追加" / "お気に入りから外す"). */
  label?: (s: S) => string;
  icon?: LucideIcon;
  keys?: string[];
  /** Kinds it applies to (all when absent): rotating is for images only. */
  kinds?: ItemKind[];
  enabled?: (s: S) => boolean;
  checked?: (s: S) => boolean;
  run: (s: S) => void;
  /**
   * Who handles the key: "grid" (the list's key handler, the default),
   * "global" (its own handler, e.g. ⌘, and ?) or
   * "menu" (only the menu bar's accelerator).
   */
  keyBy?: "grid" | "global" | "menu";
}

const sel = (s: S) => [...s.selected];
/** A text field has the focus (keys there are for typing). */
const typing = () => !!(document.activeElement as HTMLElement | null)?.closest?.("input, textarea, [contenteditable]");
const any = (s: S) => s.selected.size > 0;
const notTrash = (s: S) => s.view.kind !== "trash";
/**
 * Something selected, and all of it library items: the fonts installed on this
 * computer can be looked at but not changed, copied or taken out (docs/SYSTEM_FONTS.md).
 */
const mine = (s: S) => any(s) && !sel(s).some(isSystemId);
/** The list is the library's (not the installed fonts). */
const library = (s: S) => s.view.kind !== "system";
const live = (s: S) => mine(s) && notTrash(s);
const selItems = (s: S): Item[] => {
  const byId = new Map(s.rawItems.map((i) => [i.id, i]));
  return sel(s).flatMap((id) => byId.get(id) ?? []);
};
const allHave = (s: S, f: (i: Item) => boolean) => {
  const xs = selItems(s);
  return xs.length > 0 && xs.every(f);
};
const lastFolder = (s: S) => s.folders.find((f) => f.id === s.recentFolders[0]);

/**
 * ⌘+ / ⌘-: the size the slider sets. The font mode's is on the specimen text
 * row: the text in the specimen layout, the tiles in the grid.
 */
function zoom(s: S, dir: 1 | -1) {
  // The images compared from the stock shelf zoom together (docs/COMPARE.md).
  if (s.comparing && s.mode === "stock") {
    s.setCompareLook((l) => zoomLook(l, dir > 0 ? COMPARE_ZOOM.step : 1 / COMPARE_ZOOM.step));
  } else if (s.mode === "font" && s.layout === "specimen") s.setSpecimenSize(s.specimenSize + 8 * dir);
  else if (s.mode === "font") s.setTileSize(s.tileSize + 20 * dir);
  else s.setThumbSize(Math.min(360, Math.max(80, s.thumbSize + 20 * dir)));
}

export const COMMANDS: Command[] = [
  // ---------------------------------------------------------------- app
  {
    id: "app.settings",
    title: "設定…",
    keys: ["Mod+,"],
    keyBy: "global",
    run: (s) => s.openSettings("last"),
  },
  { id: "app.checkUpdate", title: "アップデートを確認…", run: () => checkForUpdate(true) },
  // Windows' ヘルプ menu (macOS has the system's about panel in the app menu):
  // the settings' アップデート section shows the app, its version and updates.
  { id: "help.about", title: "Stockroom について", run: (s) => s.openSettings("general") },
  { id: "help.releaseNotes", title: "このバージョンの更新内容", run: () => openReleaseNotes() },
  {
    id: "help.shortcuts",
    title: "キーボードショートカット",
    keys: ["?"],
    keyBy: "global",
    run: () => useShortcutHelp.getState().setOpen(true),
  },
  { id: "help.webImport", title: "ブラウザ拡張と連携…", run: (s) => s.openSettings("extension") },
  { id: "help.claude", title: "Claude と連携…", run: (s) => s.openSettings("claude") },
  { id: "help.log", title: "ログを表示", run: (s) => s.run(() => api.revealLog()) },

  // ------------------------------------------------------------ library
  { id: "library.new", title: "新しいライブラリ…", run: () => void createLibraryDialog() },
  { id: "library.open", title: "ライブラリを開く…", run: () => void openLibraryDialog() },
  {
    id: "library.transferAll",
    title: "すべてを別のライブラリへ…",
    label: (s) => {
      const kind = transferableKind(s);
      return kind ? `${kindLabel(kind)}をすべて別のライブラリへ…` : "すべてを別のライブラリへ…";
    },
    // A kind at a time (in the stock, narrow to the kind first).
    enabled: (s) => {
      const kind = transferableKind(s);
      return !!kind && (s.counts.kinds[kind] ?? 0) > 0;
    },
    run: () => transferAllOfKind(),
  },

  // -------------------------------------------------------------- modes
  ...MODES.map(
    (m, i): Command => ({
      id: `mode.${m}`,
      title: modeLabel(m),
      keys: [`Mod+${i + 1}`],
      // A kind the library isn't used for does nothing (the keys stay fixed).
      enabled: (s) => shownModes(s).includes(m),
      checked: (s) => s.mode === m,
      run: (s) => s.setMode(m),
    }),
  ),

  // --------------------------------------------------------------- view
  {
    id: "view.sidebar",
    title: "サイドバー",
    keys: ["Tab", "Mod+Alt+1"],
    checked: (s) => s.sidebarOpen,
    run: (s) => s.toggleSidebar(),
  },
  {
    id: "view.inspector",
    title: "詳細パネル",
    keys: ["Mod+I", "Mod+Alt+2"],
    checked: (s) => s.inspectorOpen,
    run: (s) => s.toggleInspector(),
  },
  {
    id: "view.shelf",
    title: "シェルフ",
    // The shelf is a tab of the details panel; again: its information (docs/UI.md).
    keys: ["Mod+Alt+3"],
    checked: (s) => shelfShown(s),
    run: (s) => s.toggleShelf(),
  },
  {
    id: "view.zoomIn",
    title: "拡大",
    label: (s) => (s.mode === "font" && s.layout === "specimen" ? "文字を大きく" : "拡大"),
    keys: ["Mod+="],
    run: (s) => zoom(s, 1),
  },
  {
    id: "view.zoomOut",
    title: "縮小",
    label: (s) => (s.mode === "font" && s.layout === "specimen" ? "文字を小さく" : "縮小"),
    keys: ["Mod+-"],
    run: (s) => zoom(s, -1),
  },
  {
    id: "view.subfolders",
    title: "サブフォルダの内容を表示",
    checked: (s) => s.showSubfolders,
    run: (s) => s.setShowSubfolders(!s.showSubfolders),
  },
  { id: "go.folder", title: "フォルダへ…", keys: ["Mod+J"], run: (s) => s.setPicker("goto") },

  // --------------------------------------------------------------- edit
  {
    id: "edit.search",
    title: "検索",
    keys: ["Mod+F"],
    run: () => document.getElementById("search")?.focus(),
  },
  {
    id: "edit.filter",
    title: "絞り込みへ",
    keys: ["Mod+Shift+F"],
    // The filter row is always there: the key takes the focus to its first condition.
    run: () => document.querySelector<HTMLElement>("[data-filter-row] button:not(:disabled)")?.focus(),
  },
  {
    id: "edit.selectAll",
    title: "すべてを選択",
    keys: ["Mod+A"],
    run: (s) => s.setSelection(rowIds(s.items)),
  },
  { id: "edit.deselect", title: "選択を解除", keys: ["Esc"], enabled: any, run: (s) => s.setSelection([]) },
  {
    id: "item.copy",
    title: "コピー",
    icon: Copy,
    keys: ["Mod+C"],
    enabled: mine,
    run: (s) => void copySelection(sel(s)),
  },
  {
    id: "item.copyTags",
    title: "タグをコピー",
    keys: ["Mod+Shift+C"],
    enabled: mine,
    run: (s) => void copyTags(sel(s)),
  },
  {
    id: "item.pasteTags",
    title: "タグを貼り付け",
    keys: ["Mod+Shift+V"],
    enabled: live,
    run: (s) => void pasteTags(sel(s)),
  },
  {
    id: "item.rename",
    title: "名前を変更",
    keys: ["F2", "Mod+R"],
    // Nothing selected in a folder: the folder's own name.
    enabled: (s) => (s.selected.size === 1 && mine(s)) || (s.selected.size === 0 && s.view.kind === "folder"),
    run: (s) => {
      if (s.selected.size === 1) s.requestItemRename();
      else if (s.view.kind === "folder") s.setRenamingFolder(s.view.id);
    },
  },
  {
    id: "item.trash",
    title: "ゴミ箱へ移動",
    label: (s) => (s.view.kind === "trash" ? "完全に削除" : "ゴミ箱へ移動"),
    icon: Trash2,
    keys: ["Mod+Backspace", "Delete"],
    // ⌘⌫ / Ctrl+Backspace reach the menu while typing too: in a text field
    // (the text editor, the search box) they are for deleting words.
    enabled: (s) => mine(s) && !typing(),
    run: (s) => void deleteSelection(sel(s)),
  },

  // --------------------------------------------------------------- item
  {
    id: "item.show",
    title: "表示",
    keys: ["Space", "Enter"],
    // The list opens the focused item itself (Grid.tsx); this is for menus.
    keyBy: "menu",
    enabled: any,
    run: (s) => {
      const i = s.items.findIndex((x) => x.id === (s.focus && s.selected.has(s.focus) ? s.focus : sel(s)[0]));
      if (i >= 0) s.openViewer(i);
    },
  },
  { id: "item.open", title: "既定のアプリで開く", enabled: mine, run: (s) => void openSelection(sel(s)) },
  {
    id: "item.reveal",
    title: "Finder / エクスプローラで表示",
    enabled: (s) => s.selected.size === 1,
    // An installed font: its file in the OS's font folder.
    run: (s) => {
      const id = sel(s)[0];
      void s.run(() => (isSystemId(id) ? fontApi.revealSystem(id) : api.revealItem(id)));
    },
  },
  {
    id: "item.favorite",
    title: "お気に入り",
    label: (s) => (allHave(s, (i) => i.favorite) ? "お気に入りから外す" : "お気に入りに追加"),
    icon: Heart,
    keys: ["F"],
    enabled: live,
    checked: (s) => allHave(s, (i) => i.favorite),
    run: (s) => void toggleFavorite(sel(s)),
  },
  {
    id: "item.pin",
    title: "ピン留め",
    label: (s) => (allHave(s, (i) => i.pinnedAt !== null) ? "ピン留めを解除" : "ピン留め"),
    icon: Pin,
    keys: ["P"],
    enabled: live,
    checked: (s) => allHave(s, (i) => i.pinnedAt !== null),
    run: (s) => void togglePinned(sel(s)),
  },
  {
    id: "item.tray",
    title: "シェルフ",
    // In the font mode a selected family goes on the shelf as one font (`shelfIds`).
    label: (s) => (sel(s).length && onShelf(sel(s)) ? "シェルフから外す" : "シェルフに追加"),
    icon: Layers,
    keys: ["B"],
    // Installed fonts go on the font shelf too, to be compared (docs/SYSTEM_FONTS.md).
    enabled: (s) => any(s) && notTrash(s),
    checked: (s) => sel(s).length > 0 && onShelf(sel(s)),
    run: (s) => void toggleTray(sel(s)),
  },
  ...[0, 1, 2, 3, 4, 5].map(
    (n): Command => ({
      id: `item.rate${n}`,
      title: n ? "★".repeat(n) : "評価なし",
      // The list handles the digits itself (Shift+digit also moves on).
      keys: [String(n)],
      keyBy: "menu",
      enabled: live,
      checked: (s) => allHave(s, (i) => i.rating === n),
      run: (s) => void setRating(sel(s), n),
    }),
  ),
  {
    id: "item.rotateCcw",
    title: "左に回転",
    icon: RotateLeft,
    keys: ["Mod+Shift+L"],
    kinds: ["image"],
    enabled: live,
    run: (s) => void orient(sel(s), "rotateCcw"),
  },
  {
    id: "item.rotateCw",
    title: "右に回転",
    icon: RotateRight,
    keys: ["Mod+Shift+R"],
    kinds: ["image"],
    enabled: live,
    run: (s) => void orient(sel(s), "rotateCw"),
  },
  {
    id: "item.flipH",
    title: "左右反転",
    icon: FlipHorizontal2,
    kinds: ["image"],
    enabled: live,
    run: (s) => void orient(sel(s), "flipH"),
  },
  {
    id: "item.flipV",
    title: "上下反転",
    icon: FlipVertical2,
    kinds: ["image"],
    enabled: live,
    run: (s) => void orient(sel(s), "flipV"),
  },
  {
    id: "item.resetOrientation",
    title: "元の向きに戻す",
    icon: Undo2,
    kinds: ["image"],
    enabled: (s) => live(s) && !allHave(s, (i) => i.rotation === 0 && !i.flipped),
    run: (s) => void orient(sel(s), "reset"),
  },

  // ---------------------------------------------------- taking things out
  {
    id: "list.export",
    title: "書き出し…",
    keys: ["Mod+E"],
    enabled: library,
    run: () => exportList(selectionOrShown()),
  },
  {
    id: "library.export",
    title: "ライブラリ全体を書き出し…",
    // Every item not in the trash, whatever the list shows (docs/EXPORT.md).
    enabled: (s) => !!s.library && Object.values(s.counts.kinds).some((n) => (n ?? 0) > 0),
    run: () => exportLibrary(),
  },
  { id: "list.sheet", title: "まとめて出力…", enabled: library, run: () => void sheetList(selectionOrShown()) },
  {
    id: "list.transfer",
    title: "別のライブラリへ…",
    icon: FolderInput,
    enabled: library,
    run: () => void transferList(selectionOrShown()),
  },
  {
    id: "list.tray",
    title: "シェルフにすべて追加",
    enabled: library,
    run: () => void trayList({ kind: "shown" }),
  },

  // -------------------------------------------------------------- organize
  {
    id: "item.moveTo",
    title: "フォルダへ移動…",
    keys: ["Mod+Shift+J"],
    enabled: live,
    run: (s) => s.setPicker("move"),
  },
  {
    id: "item.moveToLast",
    title: "最後に使ったフォルダへ移動",
    label: (s) => (lastFolder(s) ? `「${lastFolder(s)!.name}」へ移動` : "最後に使ったフォルダへ移動"),
    keys: ["Shift+D"],
    enabled: live,
    run: (s) => void moveToLastFolder(sel(s)),
  },
  {
    id: "item.newFolder",
    title: "選択から新しいフォルダ",
    enabled: live,
    run: (s) => void createFolder(null, sel(s)),
  },
  {
    id: "item.unfile",
    title: "未分類に戻す",
    enabled: (s) => mine(s) && s.view.kind === "folder",
    run: (s) => {
      const folder = currentFolderId();
      if (folder) void s.run(() => api.removeFromFolder(sel(s), folder));
    },
  },
  { id: "folder.new", title: "新しいフォルダ", keys: ["Mod+Shift+N"], run: () => void createFolderHere() },
  {
    id: "text.new",
    title: "新規テキスト",
    keys: ["Mod+N"],
    // Texts are of the stock (docs/TEXT.md).
    enabled: (s) => s.mode === "stock",
    run: () => void createText(),
  },
  {
    id: "smart.new",
    title: "新しいスマートフォルダ",
    keys: ["Mod+Shift+Alt+N"],
    // It saves the conditions on screen, which are of the installed fonts there.
    enabled: library,
    run: () => void createSmartFolder(),
  },
  ...(
    [
      ["folder.up", "フォルダを上へ", "Mod+[", -1, false],
      ["folder.down", "フォルダを下へ", "Mod+]", 1, false],
      ["folder.top", "フォルダを先頭へ", "Mod+Shift+[", -1, true],
      ["folder.bottom", "フォルダを末尾へ", "Mod+Shift+]", 1, true],
    ] as const
  ).map(
    ([id, title, key, by, toEnd]): Command => ({
      id,
      title,
      keys: [key],
      enabled: (s) => s.view.kind === "folder",
      run: (s) => s.view.kind === "folder" && void shiftFolder(s.view.id, by, toEnd),
    }),
  ),
];

const byId = new Map(COMMANDS.map((c) => [c.id, c]));

export function command(id: string): Command {
  const c = byId.get(id);
  if (!c) throw new Error(`unknown command ${id}`);
  return c;
}

/**
 * Whether a command applies to the list at all (rotate: images only): when
 * the list holds only kinds it is for, or none of them never; else it
 * depends on the selection (rotating when only images are selected).
 */
export const appliesTo = (c: Command, s: S) => {
  if (!c.kinds) return true;
  const kinds = listKinds(s);
  if (kinds.every((k) => c.kinds!.includes(k))) return true;
  if (!kinds.some((k) => c.kinds!.includes(k))) return false;
  const xs = selItems(s);
  return xs.length > 0 && xs.every((i) => c.kinds!.includes(i.kind));
};

export const isEnabled = (c: Command, s: S) => appliesTo(c, s) && (c.enabled?.(s) ?? true);

export const labelOf = (c: Command, s: S) => c.label?.(s) ?? c.title;

/**
 * The last command run and from where. A key can reach both the menu bar's
 * accelerator and the list's handler (which one depends on the platform),
 * so the second of the two within a moment is dropped.
 */
let lastRun = { id: "", by: "", at: 0 };

function runFrom(c: Command, s: S, by: "key" | "menu") {
  const now = performance.now();
  if (lastRun.id === c.id && lastRun.by !== by && now - lastRun.at < 250) return;
  lastRun = { id: c.id, by, at: now };
  c.run(s);
}

/** Runs a command by id if it is enabled now (menu bar items). */
export function runCommand(id: string) {
  const c = command(id);
  const s = useStore.getState();
  if (isEnabled(c, s)) runFrom(c, s, "menu");
}

// ---------------------------------------------------------------- keys

/** The key part of a combo matched against an event (layout-independent where it can be). */
function keyMatches(key: string, e: KeyboardEvent): boolean {
  if (/^[A-Z]$/.test(key)) return e.code === `Key${key}`;
  if (/^[0-9]$/.test(key)) return e.code === `Digit${key}` || e.code === `Numpad${key}`;
  switch (key) {
    case "[":
      return e.code === "BracketLeft";
    case "]":
      return e.code === "BracketRight";
    // ⌘+: "=" on US keyboards (with or without Shift), ";" on JIS.
    case "=":
      return e.key === "=" || e.key === "+" || e.key === ";";
    case "-":
      return e.key === "-";
    case "/":
      return e.code === "Slash";
    case "Esc":
      return e.key === "Escape";
    case "Space":
      return e.key === " ";
    default:
      return e.key === key;
  }
}

/** Whether `e` is exactly `combo` (no extra modifiers; Shift is free for "="). */
export function comboMatches(combo: string, e: KeyboardEvent): boolean {
  const parts = combo.split("+");
  // "Mod+=" splits into ["Mod", "="]; a bare "+" never appears.
  const key = parts.pop()!;
  const mods = new Set(parts);
  if ((e.metaKey || e.ctrlKey) !== mods.has("Mod")) return false;
  if (e.altKey !== mods.has("Alt")) return false;
  if (key !== "=" && e.shiftKey !== mods.has("Shift")) return false;
  return keyMatches(key, e);
}

/**
 * The list's key handler: runs the command bound to `e`, if any is enabled.
 * Returns whether it took the key.
 */
export function runKey(e: KeyboardEvent): boolean {
  const s = useStore.getState();
  for (const c of COMMANDS) {
    if ((c.keyBy ?? "grid") !== "grid" || !c.keys?.some((k) => comboMatches(k, e))) continue;
    if (!appliesTo(c, s)) continue;
    e.preventDefault();
    if (c.enabled?.(s) ?? true) runFrom(c, s, "key");
    return true;
  }
  return false;
}

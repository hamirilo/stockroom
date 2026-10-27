/**
 * The menu bar (docs/MENUS.md §2), made from the command table: the app's
 * menus at the top of the screen on macOS, the window's menu on Windows.
 *
 * Keys: ⌘ / Ctrl combos are the items' accelerators. Single keys (F, P, B,
 * 0-5, Space…) are not, since they must still type into text fields; they are
 * only shown (Windows: right-aligned after a tab, macOS: after the name).
 * On macOS, copy / paste / select all in text fields go through the Edit
 * menu, so those are the standard items (copying items uses the page's
 * `copy` event, see `installCopyHandler`).
 *
 * The menu is rebuilt when what it lists changes (mode, library, kinds in
 * use); otherwise only the names, greyed-out and check states are updated,
 * at most once a frame.
 */
import { isTauri } from "@tauri-apps/api/core";
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { copySelection, openLibraryAt } from "./actions";
import { api, type LibraryEntry } from "./api";
import { command, isEnabled, labelOf, runCommand, type Command } from "./commands";
import { warn } from "./log";
import { comboText, isMac } from "./shortcuts";
import { GROUPS, LAYOUTS } from "../components/ViewMenu";
import { SORTS } from "../components/Toolbar";
import {
  LIBRARY_GROUPS,
  listIs,
  MODE_GROUPS,
  MODE_LAYOUTS,
  shownGroupBy,
  shownModes,
  usedModes,
  useStore,
} from "../store";

type S = ReturnType<typeof useStore.getState>;
type Item = MenuItem | CheckMenuItem | Submenu | PredefinedMenuItem;

/** A live item: how to read its state, and what it showed last. */
interface Entry {
  /** The command (or "library.recent"), to tell what works without a library. */
  id?: string;
  item: MenuItem | CheckMenuItem;
  text: (s: S) => string;
  enabled: (s: S) => boolean;
  checked?: (s: S) => boolean;
  shown: { text: string; enabled: boolean; checked?: boolean };
}

const st = () => useStore.getState();

/** Keys that stay with the page (typing, the list's own handling). */
const pageOnly = (key: string) => !key.includes("Mod+") || key === "Mod+C";

/** "Mod+Shift+[" → "CmdOrCtrl+Shift+BracketLeft". */
function accelerator(key: string): string {
  const names: Record<string, string> = {
    Mod: "CmdOrCtrl",
    "=": "Equal",
    "-": "Minus",
    "[": "BracketLeft",
    "]": "BracketRight",
    "/": "Slash",
    ",": "Comma",
    Esc: "Escape",
  };
  return key
    .split("+")
    .map((p) => names[p] ?? p)
    .join("+");
}

/** The label with a key that is shown but not an accelerator. */
function withKey(text: string, key: string | undefined): string {
  if (!key) return text;
  return isMac ? `${text}（${comboText(key)}）` : `${text}\t${comboText(key)}`;
}

let entries: Entry[] = [];

/** What works with no library open (the welcome screen). */
const APP_WIDE = new Set([
  "library.new",
  "library.open",
  "library.recent",
  "app.settings",
  "app.checkUpdate",
  "help.shortcuts",
  "help.webImport",
  "help.claude",
  "help.log",
  "help.about",
  "help.releaseNotes",
]);

async function live(
  text: (s: S) => string,
  run: () => void,
  opts: { id?: string; keys?: string[]; enabled?: (s: S) => boolean; checked?: (s: S) => boolean } = {},
): Promise<MenuItem | CheckMenuItem> {
  const s = st();
  // The first ⌘ combo becomes the accelerator (サイドバー: ⌘⌥1, not Tab);
  // with none, the first key is only shown.
  const combo = opts.keys?.find((k) => !pageOnly(k));
  const accel = combo ? accelerator(combo) : undefined;
  const label = (x: S) => (accel ? text(x) : withKey(text(x), opts.keys?.[0]));
  // Without a library open, only what is about the app or libraries works.
  const own = opts.enabled ?? (() => true);
  const enabled = (x: S) => (x.library !== null || (opts.id !== undefined && APP_WIDE.has(opts.id))) && own(x);
  const base = { text: label(s), enabled: enabled(s), accelerator: accel, action: run };
  const item = opts.checked
    ? await CheckMenuItem.new({ ...base, checked: opts.checked(s) })
    : await MenuItem.new(base);
  entries.push({
    id: opts.id,
    item,
    text: label,
    enabled,
    checked: opts.checked,
    shown: { text: base.text, enabled: base.enabled, checked: opts.checked?.(s) },
  });
  return item;
}

/** A menu item for a command. */
function cmd(id: string): Promise<MenuItem | CheckMenuItem> {
  const c: Command = command(id);
  return live(
    (s) => labelOf(c, s),
    () => runCommand(id),
    { id, keys: c.keys, enabled: (s) => isEnabled(c, s), checked: c.checked },
  );
}

const sep = () => PredefinedMenuItem.new({ item: "Separator" });

async function submenu(text: string, items: Promise<Item>[]): Promise<Submenu> {
  return Submenu.new({ text, items: await Promise.all(items) });
}

/** ⌘A: the text of a focused field, else every item. */
function selectAll() {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
  else runCommand("edit.selectAll");
}

async function build(libraries: LibraryEntry[]): Promise<Menu> {
  entries = [];
  const s = st();
  const mode = s.mode;
  const modes = shownModes(s);

  const appMenu = isMac
    ? [
        submenu("Stockroom", [
          PredefinedMenuItem.new({ item: { About: null }, text: "Stockroom について" }),
          cmd("app.checkUpdate"),
          sep(),
          cmd("app.settings"),
          sep(),
          PredefinedMenuItem.new({ item: "Services", text: "サービス" }),
          sep(),
          PredefinedMenuItem.new({ item: "Hide", text: "Stockroom を隠す" }),
          PredefinedMenuItem.new({ item: "HideOthers", text: "ほかを隠す" }),
          PredefinedMenuItem.new({ item: "ShowAll", text: "すべてを表示" }),
          sep(),
          PredefinedMenuItem.new({ item: "Quit", text: "Stockroom を終了" }),
        ]),
      ]
    : [];

  const recent = libraries.filter((l) => l.exists && !l.current).slice(0, 10);
  const file = submenu("ファイル", [
    cmd("library.new"),
    cmd("library.open"),
    submenu(
      "最近使ったライブラリ",
      recent.length
        ? recent.map((l) => live(() => l.name, () => void openLibraryAt(l.root), { id: "library.recent" }))
        : [live(() => "（なし）", () => {}, { enabled: () => false })],
    ),
    sep(),
    ...(mode === "stock" ? [cmd("text.new")] : []),
    cmd("folder.new"),
    cmd("smart.new"),
    sep(),
    cmd("list.export"),
    cmd("library.export"),
    cmd("list.sheet"),
    cmd("list.transfer"),
    cmd("library.transferAll"),
    sep(),
    cmd("item.open"),
    cmd("item.reveal"),
    ...(isMac ? [] : [sep(), cmd("app.settings"), sep(), PredefinedMenuItem.new({ item: "Quit", text: "終了" })]),
  ]);

  const edit = submenu("編集", [
    ...(isMac
      ? [
          PredefinedMenuItem.new({ item: "Undo", text: "取り消す" }),
          PredefinedMenuItem.new({ item: "Redo", text: "やり直す" }),
          sep(),
          PredefinedMenuItem.new({ item: "Cut", text: "カット" }),
          PredefinedMenuItem.new({ item: "Copy", text: "コピー" }),
          PredefinedMenuItem.new({ item: "Paste", text: "ペースト" }),
        ]
      : [cmd("item.copy")]),
    cmd("item.copyTags"),
    cmd("item.pasteTags"),
    sep(),
    live(() => "すべてを選択", selectAll, { keys: ["Mod+A"] }),
    cmd("edit.deselect"),
    sep(),
    cmd("item.rename"),
    cmd("item.trash"),
    sep(),
    cmd("edit.search"),
    cmd("edit.filter"),
  ]);

  const item = submenu("項目", [
    cmd("item.show"),
    sep(),
    cmd("item.favorite"),
    cmd("item.pin"),
    cmd("item.tray"),
    submenu(
      "評価",
      [0, 1, 2, 3, 4, 5].map((n) => cmd(`item.rate${n}`)),
    ),
    // In the stock, greyed out unless only images are listed or selected (`appliesTo`).
    ...(mode === "stock" && usedModes(s).includes("image")
      ? [
          submenu("回転・反転", [
            cmd("item.rotateCcw"),
            cmd("item.rotateCw"),
            cmd("item.flipH"),
            cmd("item.flipV"),
            cmd("item.resetOrientation"),
          ]),
        ]
      : []),
    sep(),
    cmd("item.moveTo"),
    cmd("item.moveToLast"),
    cmd("item.newFolder"),
    cmd("item.unfile"),
    sep(),
    cmd("item.link"),
    cmd("item.unlink"),
  ]);

  const view = submenu("表示", [
    // The stock and the fonts when both are offered; ⌘1 / ⌘2 stay those of MODES.
    ...(modes.length > 1 ? [...modes.map((m) => cmd(`mode.${m}`)), sep()] : []),
    submenu(
      "レイアウト",
      LAYOUTS.filter((l) => MODE_LAYOUTS[mode].includes(l.key)).map((l) =>
        live(
          () => l.label,
          () => st().setLayout(l.key),
          { checked: (x) => x.layout === l.key },
        ),
      ),
    ),
    submenu(
      "グループ分け",
      GROUPS.filter((g) => MODE_GROUPS[mode].includes(g.key)).map((g) =>
        live(
          () => g.label,
          () => st().setGroupBy(g.key),
          {
            checked: (x) => shownGroupBy(x) === g.key,
            // The installed fonts have no rating, tags or folder (docs/SYSTEM_FONTS.md).
            enabled: (x) => x.view.kind !== "similar" && !(x.view.kind === "system" && LIBRARY_GROUPS.includes(g.key)),
          },
        ),
      ),
    ),
    submenu("並び順", [
      // Kept in the menu and greyed out: what the list holds changes without a rebuild.
      ...SORTS.filter((o) => !o.only || (mode === "stock" && usedModes(s).includes(o.only))).map((o) =>
        live(
          () => o.label,
          () => st().setSort(o.key, st().desc),
          {
            checked: (x) => x.sort === o.key,
            // Manual order is a folder's; pixel size, of images alone.
            enabled: (x) =>
              (o.key !== "manual" || x.view.kind === "folder") &&
              (!o.only || listIs(x, o.only)),
          },
        ),
      ),
      sep(),
      live(
        () => "降順",
        () => st().setSort(st().sort, !st().desc),
        { checked: (x) => x.desc, enabled: (x) => x.sort !== "manual" },
      ),
    ]),
    cmd("view.subfolders"),
    sep(),
    cmd("view.zoomIn"),
    cmd("view.zoomOut"),
    sep(),
    cmd("view.sidebar"),
    cmd("view.inspector"),
    cmd("view.shelf"),
    sep(),
    cmd("go.folder"),
  ]);

  const windowMenu = isMac
    ? [
        submenu("ウインドウ", [
          PredefinedMenuItem.new({ item: "Minimize", text: "しまう" }),
          PredefinedMenuItem.new({ item: "Maximize", text: "拡大／縮小" }),
          PredefinedMenuItem.new({ item: "Fullscreen", text: "フルスクリーンにする" }),
          sep(),
          PredefinedMenuItem.new({ item: "BringAllToFront", text: "すべてを手前に移動" }),
        ]),
      ]
    : [];

  const help = submenu("ヘルプ", [
    cmd("help.shortcuts"),
    cmd("help.webImport"),
    cmd("help.claude"),
    sep(),
    cmd("help.releaseNotes"),
    cmd("help.log"),
    ...(isMac ? [] : [sep(), cmd("app.checkUpdate"), cmd("help.about")]),
  ]);

  return Menu.new({ items: await Promise.all([...appMenu, file, edit, item, view, ...windowMenu, help]) });
}

let frame = 0;

/** Brings names, greyed-out and check states up to date (once a frame). */
function sync() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const s = st();
    for (const e of entries) {
      const text = e.text(s);
      const enabled = e.enabled(s);
      if (text !== e.shown.text) void e.item.setText(text);
      if (enabled !== e.shown.enabled) void e.item.setEnabled(enabled);
      if (e.checked && e.item instanceof CheckMenuItem) {
        const checked = e.checked(s);
        if (checked !== e.shown.checked) void e.item.setChecked(checked);
        e.shown.checked = checked;
      }
      e.shown.text = text;
      e.shown.enabled = enabled;
    }
  });
}

/** What the menu's structure depends on; a change rebuilds it. */
const shapeOf = (s: S) => `${s.library?.root ?? ""}|${s.mode}|${usedModes(s).join(",")}`;

let building: Promise<void> = Promise.resolve();

function rebuild() {
  building = building.then(async () => {
    try {
      const libraries = await api.listLibraries().catch(() => []);
      const menu = await build(libraries);
      const old = await menu.setAsAppMenu();
      await old?.close().catch(() => {});
      sync();
    } catch (e) {
      warn("menu bar", e);
    }
  });
}

/**
 * When nothing in the page is being copied (no text selected or focused),
 * Edit › Copy copies the selected items, like ⌘C in the list.
 */
function installCopyHandler() {
  const textTarget = () => {
    const el = document.activeElement;
    const sel = window.getSelection();
    return (
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (sel !== null && !sel.isCollapsed)
    );
  };
  // Lets the menu item be enabled with nothing selected in the page.
  document.addEventListener("beforecopy", (e) => {
    if (!textTarget() && st().selected.size) e.preventDefault();
  });
  document.addEventListener("copy", (e) => {
    if (textTarget() || !st().selected.size) return;
    e.preventDefault();
    void copySelection([...st().selected]);
  });
}

/** Sets up the menu bar (in the app only; the browser preview has none). */
export function installMenuBar(): () => void {
  // The browser preview's mock backend records the menu (src/dev/mockBackend.ts).
  const mock = (window as unknown as { __MOCK_BACKEND__?: boolean }).__MOCK_BACKEND__;
  if (!isTauri() && !mock) return () => {};
  installCopyHandler();
  let shape = shapeOf(st());
  rebuild();
  return useStore.subscribe((s) => {
    const now = shapeOf(s);
    if (now !== shape) {
      shape = now;
      rebuild();
    } else {
      sync();
    }
  });
}

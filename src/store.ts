import { create } from "zustand";
import {
  api,
  EMPTY_FILTER,
  KINDS,
  kindLabel,
  type AppSettings,
  type Counts,
  type DuplicateEffect,
  type Filter,
  type Folder,
  type Rule,
  type SmartFolder,
  type ImportSummary,
  type Item,
  type ItemQuery,
  type ItemKind,
  type KindCounts,
  type LibraryInfo,
  type SimilarLevel,
  type SortKey,
  type Tag,
  type View,
} from "./lib/api";
import { buildHas, OFF_SETTINGS } from "./lib/limits";
import { filesApi, onFileThumbs } from "./features/files/api";
import { listHasPixels, queryKinds, inScope, ruleKinds, usedKinds, type KindState } from "./lib/kinds";
import {
  DEFAULT_LIBRARY_SETTINGS,
  HIDDEN_KEY,
  parseLibrarySettings,
  parseSidebarHidden,
  SIDEBAR_ENTRIES,
  type LibrarySettings,
} from "./lib/librarySettings";
import { groupItems, similarSections, type GroupBy, type Links, type Section } from "./lib/grouping";
import { warn } from "./lib/log";
import { notifyIfAway } from "./lib/osNotify";

/**
 * Every kind the library is used for is listed together; the kind filter
 * (`filter.kinds`, the sidebar's range) narrows the list to some kinds (see
 * `listKinds`). Fonts moved to their own app (docs/FONT_APP.md).
 */
// The kinds a list holds (lib/kinds.ts), used across the components.
export { listHasPixels, listIs, listKinds, listNoun, listWithin, queryKinds, shownKinds, usedKinds } from "./lib/kinds";

/** x/y = current pointer, sx/sy = where the drag started (for snap-back). */
type DragPos = { x: number; y: number; sx: number; sy: number };
export type Drag =
  /** `from`: picked up on the shelf (reordered there, not added again). */
  | ({ kind: "items"; ids: string[]; from?: "shelf" } & DragPos)
  /** `ids`: the folders picked in the sidebar, in its order. */
  | ({ kind: "folder"; ids: string[] } & DragPos);

export interface ToastAction {
  label: string;
  onClick: () => void;
}

/** A duplicate tidy-up awaiting confirmation; `effects` fills in once previewed. */
export interface DuplicateReview {
  groups: { keep: Item; remove: Item[] }[];
  effects: DuplicateEffect[] | null;
}

export type Layout = "justified" | "grid" | "waterfall" | "list";

/**
 * The layouts, the first being the default (the toolbar's are in ViewMenu.tsx).
 * Images keep their shape; files take a fixed one (layouts.ts `aspect`).
 */
const LAYOUTS: Layout[] = ["justified", "waterfall", "grid", "list"];

/** The groupings. No 種類 grouping: the sidebar's range narrows to one kind instead (docs/UI.md). */
const GROUPS: GroupBy[] = ["none", "month", "rating", "tag", "folder"];

/** What the grid shows under each thumbnail. */
export interface ShowInfo {
  name: boolean;
  dims: boolean;
  rating: boolean;
  /** File type and size. */
  meta: boolean;
}

export type ToastKind = "success" | "info" | "error";

export interface ToastOptions {
  title: string;
  /** A second, quieter line (counts, reasons). */
  detail?: string;
  kind?: ToastKind;
  action?: ToastAction;
  /**
   * ms before it goes away, 0 = until closed; paused while hovered or focused
   * and while the window can't be seen. Left out: by kind and length (`toastDuration`).
   */
  duration?: number;
  /** Rewrite this toast in place (a result following its "…しています"), if it is still showing. */
  replace?: number;
}

export interface Toast extends Required<Pick<ToastOptions, "title" | "kind" | "duration">> {
  id: number;
  /** Bumped when the toast is rewritten in place; restarts its countdown. */
  rev: number;
  detail?: string;
  action?: ToastAction;
  leaving?: boolean;
}

export type TransferRequest =
  /** Selected items (`noun` names them: "画像 3 件"). */
  | { ids: string[]; noun: string; count: number }
  /** Every item of `kind` not in the trash. */
  | { ids: null; kind: ItemKind; count: number };

/**
 * What a "the contents of this list" action works on: given items, the list
 * on screen, a folder / smart folder / tag from the sidebar, or the shelf.
 */
export type ListSource =
  | { kind: "ids"; ids: string[] }
  | { kind: "shown" }
  | { kind: "folder"; id: string }
  | { kind: "smart"; id: string }
  | { kind: "tag"; id: number }
  | { kind: "tray" };

/** The export dialog: what to write and its title ("「旅行」を書き出し"); the whole library (docs/EXPORT.md). */
export interface ExportRequest {
  source: ListSource | { kind: "library" };
  title: string;
}

/**
 * The settings screen's pages: the app's (一般 … Claude), then the open
 * library's (概要, 種類, 親子の紐づけ, サイドバー, フォルダの共有). See docs/SETTINGS.md.
 */
export type SettingsTab =
  | "general"
  | "sidebar"
  | "extension"
  | "claude"
  | "library"
  | "libraryKinds"
  | "libraryLinks"
  | "librarySidebar"
  | "libraryShare";

/** Where sidebar entries are hidden: the app's settings or the open library's. */
export type SidebarScope = "app" | "library";

/** A long task shown with a progress bar (bottom right). */
export interface Progress {
  label: string;
  done: number;
  total: number;
  /** Shows a キャンセル button. */
  cancel?: () => void;
}

interface State {
  library: LibraryInfo | null;
  /** The open library's own settings (docs/SETTINGS.md). */
  librarySettings: LibrarySettings;
  /** The app's settings (settings.json); null until read at launch. */
  appSettings: AppSettings | null;

  view: View;
  search: string;
  tagFilter: number[];
  /** Sidebar tag filter requires all selected tags (AND) instead of any (OR). */
  tagMatchAll: boolean;
  sort: SortKey;
  desc: boolean;
  thumbSize: number;
  /** Parents whose children are listed under them (▸, docs/LINKS.md). */
  openParents: ReadonlySet<string>;
  inspectorOpen: boolean;
  sidebarOpen: boolean;
  /** The list's table of contents (the sections to jump to) is open. Not kept: it closes on its own. */
  tocOpen: boolean;
  /** Widths of the sidebar and the details panel (px), dragged at their edge. */
  sidebarWidth: number;
  inspectorWidth: number;
  /** Folder views include items from subfolders. */
  showSubfolders: boolean;
  minRating: number;
  /** Attribute filters from the filter bar. */
  filter: Filter;
  /** Smart folder whose rule is loaded into the filter row for editing. */
  /** The smart folder whose conditions the row is editing; `kinds` = the range picked before (put back after). */
  editingSmart: { id: string; name: string; kinds: ItemKind[] } | null;
  layout: Layout;
  showInfo: ShowInfo;
  /** How the list is split into sections (ignored in the similar view). */
  groupBy: GroupBy;
  /** Viewer: details panel and the strip of thumbnails. */
  viewerInfo: boolean;
  viewerStrip: boolean;
  /** Viewer: the image alone, with the bar, arrows, details and strip hidden (H). */
  viewerBare: boolean;
  /** Tag names copied with ⌘⇧C. */
  tagClipboard: string[];
  /** Most recently used target folders (for Shift+D and the picker). */
  recentFolders: string[];
  /** Most recently assigned tags, newest first (suggested in the tag input). */
  recentTags: number[];
  /** Folder whose name is being edited inline in the sidebar. */
  renamingFolder: string | null;
  /** Bumped to ask the inspector to focus the item name field. */
  renameItemSeq: number;
  /** "parent": choose the item the selection is linked to as children (docs/LINKS.md). */
  picker: "move" | "goto" | "parent" | null;
  /** The settings screen (⌘,) is open, on this page. */
  settingsTab: SettingsTab | null;
  /** The page the settings showed last; "last" opens it again (UI §9). */
  lastSettingsTab: SettingsTab;
  /** A browser extension asks to connect; `code` is also shown in the extension. */
  /** `extension`: the asking extension's id (chrome://extensions shows it). */
  /** An extension (its id) or another app (the name it gives itself) asks to connect. */
  pairRequest: { id: string; code: string; extension: string | null; app: string | null } | null;
  /** Similar view: how alike images must be. */
  similarLevel: SimilarLevel;
  /** Similar view: copies the user chose to keep (at most one per group). */
  keepPick: Set<string>;
  /** Similar view: how many groups the user dismissed as "not duplicates" (not persisted). */
  dismissedGroups: number;
  /** Duplicate tidy-up waiting for confirmation. */
  review: DuplicateReview | null;
  /** Items the contact sheet dialog (まとめて出力) is open for, in order. */
  sheet: Item[] | null;
  /** The "別のライブラリへ" dialog: selected items, or every item of a kind. */
  transfer: TransferRequest | null;
  /** The folder the share dialog is open for (share.rs). */
  sharing: string | null;
  /** The export dialog (書き出し…). */
  exporting: ExportRequest | null;

  /** What the grid shows: the query result, regrouped by `groupBy`. */
  items: Item[];
  /** The query result as returned (one entry per image). */
  rawItems: Item[];
  /** What is on the shelf (the `tray` table, of the kinds in use), in its own order. */
  shelf: Item[];
  /** What the details panel on the right shows: the selection's information or the shelf; changed only by the user. */
  panelTab: PanelTab;
  /** The comparison of the shelf's images is shown in place of the list. */
  comparing: boolean;
  /** Comparison: the zoom (1 = whole) and the point at the frames' centre (0-1), shared by all images. */
  compareLook: CompareLook;
  /** Bands of `items`: similar-view groups, or the `groupBy` sections. */
  sections: Section[];
  folders: Folder[];
  smartFolders: SmartFolder[];
  /** File types in the library with counts (filter bar options). */
  exts: [string, number][];
  tags: Tag[];
  counts: Counts;
  /** Bumped after every refresh so dependents (inspector) can re-fetch. */
  rev: number;

  selected: Set<string>;
  /** Start of a shift-range. */
  anchor: string | null;
  /** Last item clicked / moved to with the keyboard. */
  focus: string | null;
  viewer: number | null;

  drag: Drag | null;
  /** Files from Finder / Explorer are being dragged over the window. */
  fileDrag: boolean;
  dropTarget: string | null; // "folder:<id>" or "root"
  /** Sidebar row that just received a drop; `n` restarts the animation. */
  flash: { target: string; n: number } | null;
  importing: Progress | null;
  /** Update download in progress (bytes; total is null when the server did not say). */
  updating: { done: number; total: number | null; installing?: boolean } | null;
  /** Hashing older images before the similar view can be shown. */
  analyzing: boolean;
  toasts: Toast[];

  setLibrary: (lib: LibraryInfo | null) => Promise<void>;
  /** Narrows the list to these kinds (none = every kind the library is used for). */
  setKinds: (kinds: ItemKind[]) => void;
  /** Kinds the library is used for (drops or brings back a kind). */
  setUsedKinds: (kinds: ItemKind[]) => void;
  /** Reflects the links setting (already stored by `api.setLinksEnabled`) and lists again. */
  setLinks: (on: boolean) => void;
  /** What a parent in the trash does to its children; saved with the library. */
  setLinksTrash: (v: "with" | "keep") => void;
  /** Hides (or shows again) sidebar entries, in `scope` (default: the one in effect). */
  setSidebarHidden: (ids: string[], scope?: SidebarScope) => void;
  /** The library gets its own sidebar entries, or follows the app's again. */
  setSidebarOwn: (own: boolean) => void;
  loadAppSettings: () => Promise<void>;
  /** Changes and saves the app's settings (once read). */
  saveAppSettings: (patch: Partial<AppSettings>) => void;
  setView: (view: View) => void;
  setSearch: (s: string) => void;
  toggleTagFilter: (id: number) => void;
  clearTagFilter: () => void;
  setTagMatchAll: (on: boolean) => void;
  setSort: (sort: SortKey, desc: boolean) => void;
  setThumbSize: (n: number) => void;
  /** Opens or closes a parent's children under its row (links on). */
  toggleParent: (id: string) => void;
  /** Opens every parent's children in the list, or closes them all. */
  setAllParents: (open: boolean) => void;
  toggleInspector: () => void;
  setPanelTab: (tab: PanelTab) => void;
  /**
   * ⌘I / ⌘⌥3: shows `tab` in the details panel (opening it, or switching from
   * the other tab); closes the panel when `tab` is already shown.
   */
  togglePanelTab: (tab: PanelTab) => void;
  setComparing: (on: boolean) => void;
  setCompareLook: (look: CompareLook | ((l: CompareLook) => CompareLook)) => void;
  toggleSidebar: () => void;
  setTocOpen: (open: boolean) => void;
  /** Sets a panel's width (kept within its limits, see PANEL_WIDTH). */
  setPanelWidth: (panel: "sidebar" | "inspector", px: number) => void;
  setShowSubfolders: (on: boolean) => void;
  setMinRating: (n: number) => void;
  setFilter: (patch: Partial<Filter>) => void;
  /** Resets every condition of the filter row (the kind filter too) and the search. */
  clearConditions: () => void;
  /** The ad-hoc conditions as a smart folder rule. */
  currentRule: () => Rule;
  /** Loads a smart folder's rule into the filters so it can be edited. */
  startEditSmart: (sf: SmartFolder) => void;
  stopEditSmart: () => void;
  setLayout: (l: Layout) => void;
  setShowInfo: (patch: Partial<ShowInfo>) => void;
  setGroupBy: (g: GroupBy) => void;
  toggleViewerInfo: () => void;
  toggleViewerStrip: () => void;
  toggleViewerBare: () => void;
  setTagClipboard: (names: string[]) => void;
  rememberFolders: (ids: string[]) => void;
  rememberTags: (names: string[]) => void;
  setRenamingFolder: (id: string | null) => void;
  requestItemRename: () => void;
  setPicker: (p: State["picker"]) => void;
  /** "last": the page shown last (一般 if it was the library's and none is open). */
  openSettings: (tab: SettingsTab | "last" | null) => void;
  setPairRequest: (r: State["pairRequest"]) => void;
  setSimilarLevel: (l: SimilarLevel) => void;
  /** Marks `id` as the copy to keep in its group. */
  pickKeeper: (id: string) => void;
  setReview: (r: DuplicateReview | null) => void;
  setSheet: (items: Item[] | null) => void;
  setTransfer: (t: TransferRequest | null) => void;
  setSharing: (folderId: string | null) => void;
  setExporting: (r: ExportRequest | null) => void;
  refresh: () => Promise<void>;

  /**
   * `at`: the item's display index. With tag grouping an item can appear
   * more than once, and a range runs between the places clicked.
   */
  select: (id: string, mode: "only" | "toggle" | "range", at?: number) => void;
  /** Selects exactly `ids`. */
  setSelection: (ids: string[]) => void;
  openViewer: (index: number | null) => void;

  setDrag: (d: Drag | null) => void;
  setDropTarget: (t: string | null) => void;
  setFileDrag: (on: boolean) => void;
  flashTarget: (target: string) => void;
  setImporting: (p: State["importing"]) => void;
  setUpdating: (p: State["updating"]) => void;
  toast: (message: string, error?: boolean, action?: ToastAction) => void;
  /** A toast with a title, detail line and kind (results worth noticing). Returns its id. */
  notify: (t: ToastOptions) => number;
  dismissToast: (id: number) => void;
  /**
   * Runs a mutation, reports errors, then refreshes. Resolves to whether it
   * worked: a result message must not follow the error toast.
   */
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
  /** Reports an import; `since` (when it started) also tells the OS if it was long. */
  importDone: (s: ImportSummary, since?: number) => void;
}

// localStorage can throw (private mode etc.); treat it as best-effort.
const load = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const persist = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
};
const loadNumber = (key: string, fallback: number) => {
  const v = Number(load(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Default, smallest and largest width of the side panels. */
export const PANEL_WIDTH = {
  sidebar: { initial: 240, min: 190, max: 420 },
  inspector: { initial: 288, min: 240, max: 560 },
} as const;

const clampWidth = (panel: keyof typeof PANEL_WIDTH, px: number) =>
  Math.round(Math.min(PANEL_WIDTH[panel].max, Math.max(PANEL_WIDTH[panel].min, px)));

/** The details panel's tabs: the selection's information, or the shelf. */
export type PanelTab = "info" | "shelf";

/** The shelf is in view: the details panel is open on it. */
export const shelfShown = (s: { inspectorOpen: boolean; panelTab: PanelTab }) => s.inspectorOpen && s.panelTab === "shelf";

const loadJson = (key: string): object => {
  try {
    const v = JSON.parse(load(key) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};

/**
 * The saved layout and grouping (`layout:stock` / `groupBy:stock`, named in
 * versions with a font mode), else what "すべて" had, then the image mode of
 * earlier versions and the keys from before modes.
 */
const LAYOUT_KEYS = ["layout:stock", "layout:all", "layout:image", "layout"];
const GROUP_KEYS = ["groupBy:stock", "groupBy:all", "groupBy:image", "groupBy"];
const loadLayout = (): Layout => {
  const saved = LAYOUT_KEYS.map(load).find((v) => v !== null);
  return LAYOUTS.find((l) => l === saved) ?? LAYOUTS[0];
};
const loadGroupBy = (): GroupBy => {
  const saved = GROUP_KEYS.map(load).find((v) => v !== null);
  // "year" was merged into "month" (年月).
  return GROUPS.find((g) => g === (saved === "year" ? "month" : saved)) ?? "none";
};

/** Conditions only images have (shape, pixel size), cleared when the list isn't of images alone. */
/** What applies to kinds with a pixel size only (images, videos). */
const PIXELS_ONLY: Partial<Filter> = { shapes: [], minWidth: null, maxWidth: null, minHeight: null, maxHeight: null };

/**
 * Drops what no longer applies once the list holds other kinds: image-only
 * conditions and the pixel size sort.
 */
function fitToKinds(s: KindState & { sort: SortKey }): Partial<State> {
  if (listHasPixels(s)) return {};
  return { filter: { ...s.filter, ...PIXELS_ONLY }, ...(s.sort === "dimensions" ? { sort: "importedAt" as SortKey } : {}) };
}

/** Number of active ad-hoc conditions: the filter row's and the search. */
export function activeConditions(s: {
  search: string;
  tagFilter: number[];
  minRating: number;
  filter: Filter;
}): number {
  const f = s.filter;
  return (
    (s.search.trim() ? 1 : 0) +
    (s.tagFilter.length ? 1 : 0) +
    (s.minRating ? 1 : 0) +
    // The kinds picked aren't one: they are the range the sidebar sets (docs/KINDS.md).
    (f.exts.length ? 1 : 0) +
    (f.shapes.length ? 1 : 0) +
    (f.minWidth != null || f.maxWidth != null || f.minHeight != null || f.maxHeight != null ? 1 : 0) +
    (f.importedAfter != null || f.importedBefore != null ? 1 : 0) +
    (f.minSize != null || f.maxSize != null ? 1 : 0) +
    (f.parentsOnly || f.childrenOnly || f.unlinkedOnly ? 1 : 0)
  );
}

const recentTagsKey = (root: string) => `recentTags:${root}`;
const loadRecentTags = (root: string): number[] => {
  try {
    const v = JSON.parse(load(recentTagsKey(root)) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "number") : [];
  } catch {
    return [];
  }
};
let pendingRecentTags: string[] = [];

let refreshSeq = 0;
/**
 * How long a toast stays when not told: long enough to read it (a little more
 * for each character), longer with a button to press, and errors until closed
 * (docs/NOTIFICATIONS.md).
 */
export function toastDuration(kind: ToastKind, text: string, action: boolean): number {
  if (kind === "error") return 0;
  const read = 4000 + 80 * text.length;
  return Math.round(Math.min(12_000, Math.max(action ? 8000 : 5000, read)));
}

let toastSeq = 0;
let flashSeq = 0;
/** Display index of `anchor` when known (see `select`). */
let anchorAt: number | null = null;

/** Display index of item `id`: `at` when it is there, else its first place. */
function indexOf(items: Item[], id: string, at: number | null | undefined): number {
  return at != null && items[at]?.id === id ? at : items.findIndex((i) => i.id === id);
}

/** Comparison: how far the images are zoomed (1 = each whole in its frame) and where (docs/COMPARE.md). */
export type CompareLook = { k: number; cx: number; cy: number };
export const WHOLE_LOOK: CompareLook = { k: 1, cx: 0.5, cy: 0.5 };
export const COMPARE_ZOOM = { min: 1, max: 32, step: 1.25 };
/** The look zoomed by `f` around the frames' centre (back to the whole at 1). */
export const zoomLook = (l: CompareLook, f: number): CompareLook => {
  const k = Math.min(COMPARE_ZOOM.max, Math.max(COMPARE_ZOOM.min, l.k * f));
  return k === 1 ? WHOLE_LOOK : { ...l, k };
};

const NO_PARENTS: ReadonlySet<string> = new Set();

/** The display list and its sections for the current view / grouping. */
function arrange(s: {
  view: View;
  groupBy: GroupBy;
  openParents: ReadonlySet<string>;
  librarySettings: LibrarySettings;
  rawItems: Item[];
  tags: Tag[];
  folders: Folder[];
}): { items: Item[]; sections: Section[] } {
  if (s.view.kind === "similar") return { items: s.rawItems, sections: similarSections(s.rawItems) };
  return groupItems(s.rawItems, s.groupBy, s.tags, s.folders, linksFold(s));
}

/** Children go under their parents in the lists, links on (not the trash or the shelf). */
function linksFold(s: { view: View; openParents: ReadonlySet<string>; librarySettings: LibrarySettings }): Links {
  const listsFolded = s.view.kind !== "trash" && s.view.kind !== "tray";
  return s.librarySettings.links && listsFolded ? { open: s.openParents } : null;
}

/** Re-arranges the list after a display change, keeping the viewer on the item it showed. */
function rearrange(s: State, patch: Partial<State>): Partial<State> {
  const next = { ...s, ...patch };
  const { items, sections } = arrange(next);
  const shown = s.viewer !== null ? s.items[s.viewer]?.id : undefined;
  const viewer = shown ? Math.max(0, items.findIndex((i) => i.id === shown)) : s.viewer;
  return { ...patch, items, sections, viewer };
}

let librarySeq = 0;

/**
 * After the sidebar entries in effect changed: hiding what is open moves to
 * "すべて". The filter row's conditions stay (hiding is of places only).
 */
function leaveHidden() {
  const s = useStore.getState();
  const ids = sidebarHidden(s);
  const entry = entryOfView(s.view);
  if (entry && ids.includes(entry)) s.setView({ kind: "all" });
}

/** The conditions of the filter row, each cleared on its own (docs/NAVIGATION.md). */
export type ConditionKey =
  | "rating"
  | "tags"
  | "kinds"
  | "exts"
  | "dims"
  | "date"
  | "size"
  | "parents";

/** What clearing each condition sets. */
export const CLEARED: Record<ConditionKey, { minRating?: 0; tagFilter?: number[]; filter?: Partial<Filter> }> = {
  rating: { minRating: 0 },
  tags: { tagFilter: [] },
  kinds: { filter: { kinds: [] } },
  exts: { filter: { exts: [] } },
  dims: { filter: { shapes: [], minWidth: null, maxWidth: null, minHeight: null, maxHeight: null } },
  date: { filter: { importedAfter: null, importedBefore: null } },
  size: { filter: { minSize: null, maxSize: null } },
  parents: { filter: { parentsOnly: false, childrenOnly: false, unlinkedOnly: false } },
};

type QueryState = Pick<
  State,
  | "view"
  | "search"
  | "tagFilter"
  | "tagMatchAll"
  | "sort"
  | "desc"
  | "showSubfolders"
  | "minRating"
  | "filter"
  | "similarLevel"
  | "librarySettings"
>;

/**
 * The query of the list on screen; `without` leaves one condition out, for
 * the counts in its menu (with the other conditions on).
 */
export function listQuery(s: QueryState, without?: ConditionKey): ItemQuery {
  const c = without ? CLEARED[without] : {};
  const st = { ...s, ...c, filter: { ...s.filter, ...c.filter } };
  return {
    view: st.view,
    search: st.search,
    tagIds: st.tagFilter,
    tagMatchAll: st.tagMatchAll,
    includeSubfolders: st.showSubfolders,
    minRating: st.minRating,
    // The kinds in use, narrowed by the kind filter.
    filter: { ...st.filter, kinds: queryKinds(st) },
    similarLevel: st.similarLevel,
    sort: st.sort,
    desc: st.desc,
  };
}

/** The list on screen asks for the parents of what matches (docs/LINKS.md); the shelf, exports and counts don't. */
const shownQuery = (s: QueryState & { librarySettings: LibrarySettings }): ItemQuery =>
  ({ ...listQuery(s), withParents: s.librarySettings.links });

/**
 * How many items the open place has without any condition, for "5 / 13 件";
 * null where it isn't known (the similar view).
 */
export function placeTotal(
  s: Pick<State, "filter" | "view" | "counts" | "folders" | "tags" | "smartFolders" | "showSubfolders">,
): number | null {
  const v = s.view;
  // The same numbers as the sidebar: of the kinds picked (docs/KINDS.md).
  const n = (x: { count: number; byKind: KindCounts } | undefined) => (x ? inScope(s, x.count, x.byKind) : null);
  switch (v.kind) {
    case "all":
    case "unfiled":
    case "untagged":
    case "favorites":
    case "pinned":
    case "trash":
    case "tray":
      return inScope(s, s.counts[v.kind], s.counts.byKind[v.kind]);
    case "tag":
      return n(s.tags.find((t) => t.id === v.id));
    case "smart":
      return n(s.smartFolders.find((f) => f.id === v.id));
    case "folder": {
      const own = (id: string): number =>
        (n(s.folders.find((f) => f.id === id)) ?? 0) +
        (s.showSubfolders ? s.folders.filter((f) => f.parentId === id).reduce((n, f) => n + own(f.id), 0) : 0);
      return own(v.id);
    }
    case "similar":
      return null;
  }
}

/**
 * The open place's items by kind, without any condition: the counts of the
 * range's menu (docs/KINDS.md). Null where they aren't known.
 */
export function placeByKind(
  s: Pick<State, "view" | "counts" | "folders" | "tags" | "smartFolders" | "showSubfolders">,
): KindCounts | null {
  const v = s.view;
  const add = (a: KindCounts, b: KindCounts): KindCounts => {
    const out = { ...a };
    for (const [k, n] of Object.entries(b) as [ItemKind, number][]) out[k] = (out[k] ?? 0) + n;
    return out;
  };
  switch (v.kind) {
    case "all":
    case "unfiled":
    case "untagged":
    case "favorites":
    case "pinned":
    case "trash":
    case "tray":
      return s.counts.byKind[v.kind];
    case "tag":
      return s.tags.find((t) => t.id === v.id)?.byKind ?? null;
    case "smart":
      return s.smartFolders.find((f) => f.id === v.id)?.byKind ?? null;
    case "folder": {
      const own = (id: string): KindCounts =>
        add(
          s.folders.find((f) => f.id === id)?.byKind ?? {},
          s.showSubfolders
            ? s.folders.filter((f) => f.parentId === id).reduce((n, f) => add(n, own(f.id)), {} as KindCounts)
            : {},
        );
      return own(v.id);
    }
    case "similar":
      return null;
  }
}

/** The sidebar entry's name ("お気に入り"), for messages. */
export const sidebarEntryLabel = (id: string) => SIDEBAR_ENTRIES.find((e) => e.id === id)?.label ?? id;

/** Saves one setting of the open library, reporting failures. */
function saveLibrarySetting(key: string, value: unknown) {
  api.setLibrarySetting(key, value).catch((e) => useStore.getState().toast(String(e), true));
}

type SidebarState = Pick<State, "library" | "librarySettings" | "appSettings">;

/** Whose sidebar entries are in effect: the library's own, or the app's. */
export const sidebarScope = (s: SidebarState): SidebarScope =>
  s.library && s.librarySettings.sidebarOwn ? "library" : "app";

const NOTHING_HIDDEN: string[] = [];

/** Sidebar entries hidden in `scope` (default: the one in effect). */
export const sidebarHidden = (s: SidebarState, scope = sidebarScope(s)): string[] =>
  scope === "library" ? s.librarySettings.hidden : (s.appSettings?.sidebarHidden.stock ?? NOTHING_HIDDEN);

/** Whether a sidebar entry (SIDEBAR_ENTRIES id) is hidden. */
export const isHidden = (s: SidebarState, id: string) => sidebarHidden(s).includes(id);

/** Sidebar entry a view is listed under, if it can be hidden. */
export function entryOfView(v: View): string | null {
  switch (v.kind) {
    case "folder":
      return "section:folders";
    case "smart":
      return "section:smart";
    case "tag":
      return "section:tags";
    case "all":
    case "trash":
      return null;
    default:
      return v.kind;
  }
}

export const useStore = create<State>((set, get) => ({
  library: null,
  librarySettings: DEFAULT_LIBRARY_SETTINGS,
  appSettings: null,

  view: { kind: "all" },
  search: "",
  tagFilter: [],
  tagMatchAll: load("tagMatchAll") === "true",
  sort: "importedAt",
  desc: true,
  thumbSize: loadNumber("thumbSize", 180),
  inspectorOpen: load("inspectorOpen") !== "false",
  sidebarOpen: load("sidebarOpen") !== "false",
  tocOpen: false,
  sidebarWidth: clampWidth("sidebar", loadNumber("sidebarWidth", PANEL_WIDTH.sidebar.initial)),
  inspectorWidth: clampWidth("inspector", loadNumber("inspectorWidth", PANEL_WIDTH.inspector.initial)),
  showSubfolders: load("showSubfolders") === "true",
  minRating: 0,
  filter: EMPTY_FILTER,
  editingSmart: null,
  layout: loadLayout(),
  openParents: NO_PARENTS,
  showInfo: { name: true, dims: true, rating: true, meta: false, ...loadJson("showInfo") },
  groupBy: loadGroupBy(),
  viewerInfo: load("viewerInfo") === "true",
  viewerStrip: load("viewerStrip") !== "false",
  viewerBare: load("viewerBare") === "true",
  tagClipboard: [],
  recentFolders: [],
  recentTags: [],
  renamingFolder: null,
  renameItemSeq: 0,
  picker: null,
  settingsTab: null,
  lastSettingsTab: "general",
  pairRequest: null,
  similarLevel: (["strict", "standard", "loose"] as const).find((l) => l === load("similarLevel")) ?? "standard",
  keepPick: new Set(),
  dismissedGroups: 0,
  review: null,
  sheet: null,
  transfer: null,
  sharing: null,
  exporting: null,

  items: [],
  rawItems: [],
  shelf: [],
  panelTab: load("panelTab") === "shelf" ? "shelf" : "info",
  comparing: false,
  compareLook: WHOLE_LOOK,
  sections: [],
  folders: [],
  smartFolders: [],
  exts: [],
  tags: [],
  counts: {
    all: 0,
    unfiled: 0,
    untagged: 0,
    trash: 0,
    favorites: 0,
    pinned: 0,
    tray: 0,
    kinds: {},
    byKind: { all: {}, unfiled: {}, untagged: {}, trash: {}, favorites: {}, pinned: {}, tray: {} },
  },
  rev: 0,

  selected: new Set(),
  anchor: null,
  focus: null,
  viewer: null,

  drag: null,
  fileDrag: false,
  dropTarget: null,
  flash: null,
  importing: null,
  updating: null,
  analyzing: false,
  toasts: [],

  setLibrary: async (library) => {
    const seq = ++librarySeq;
    let librarySettings = DEFAULT_LIBRARY_SETTINGS;
    if (library) {
      try {
        librarySettings = parseLibrarySettings(await api.getLibrarySettings());
      } catch (e) {
        get().toast(String(e), true);
      }
      if (seq !== librarySeq) return; // another library was opened meanwhile
    }
    set({
      library,
      librarySettings,
      items: [],
      rawItems: [],
      sections: [],
      shelf: [],
      comparing: false,
      openParents: NO_PARENTS,
      view: { kind: "all" },
      search: "",
      tagFilter: [],
      minRating: 0,
      filter: EMPTY_FILTER,
      ...fitToKinds({ view: { kind: "all" }, filter: EMPTY_FILTER, smartFolders: [], librarySettings, sort: get().sort }),
      editingSmart: null,
      recentTags: library ? loadRecentTags(library.root) : [],
      selected: new Set(),
      anchor: null,
      focus: null,
      viewer: null,
    });
    if (library) {
      get().refresh();
      // Windows: office documents' thumbnails made by Office (when installed).
      watchFileThumbs();
      filesApi.prepareThumbs().catch(() => {});
    }
  },
  setKinds: (kinds) => {
    const s = get();
    const used = usedKinds(s);
    const picked = used.filter((k) => kinds.includes(k));
    // Every kind in use is the same list as none picked.
    const filter = { ...s.filter, kinds: picked.length === used.length ? [] : picked };
    set({ filter, ...fitToKinds({ ...s, filter }) });
    get().refresh();
  },
  setLinks: (links) => {
    set({ librarySettings: { ...get().librarySettings, links }, openParents: NO_PARENTS });
    get().refresh();
  },
  setLinksTrash: (linksTrash) => {
    set({ librarySettings: { ...get().librarySettings, linksTrash } });
    saveLibrarySetting("linksTrash", linksTrash === "with" ? null : linksTrash);
  },
  setUsedKinds: (kinds) => {
    const used = KINDS.map((k) => k.kind).filter((k) => kinds.includes(k) && buildHas(k));
    if (!used.length) return;
    set({ librarySettings: { ...get().librarySettings, kinds: used } });
    // Every kind = nothing to remember (a kind added later is used too).
    saveLibrarySetting("modes", used.length === KINDS.length ? null : used);
    // A kind dropped from the kind filter; what applied to it alone goes too.
    const s = get();
    const filter = { ...s.filter, kinds: s.filter.kinds.filter((k) => used.includes(k)) };
    set({ filter, ...fitToKinds({ ...s, filter }) });
    get().refresh();
  },
  setSidebarHidden: (ids, scope = sidebarScope(get())) => {
    if (scope === "app") {
      if (!get().appSettings) return;
      // Under `stock`, where earlier versions read it.
      get().saveAppSettings({ sidebarHidden: ids.length ? { stock: ids } : {} });
    } else {
      set({ librarySettings: { ...get().librarySettings, hidden: ids } });
      saveLibrarySetting(HIDDEN_KEY, ids.length ? ids : null);
    }
    leaveHidden();
  },
  setSidebarOwn: (own) => {
    const ls = get().librarySettings;
    if (!get().library || own === ls.sidebarOwn) return;
    let hidden = ls.hidden;
    // Starts from the app's entries, unless the library had its own before.
    if (own && !hidden.length) {
      hidden = sidebarHidden(get(), "app");
      if (hidden.length) saveLibrarySetting(HIDDEN_KEY, hidden);
    }
    set({ librarySettings: { ...ls, hidden, sidebarOwn: own } });
    saveLibrarySetting("sidebar", own ? "own" : "app");
    leaveHidden();
  },
  loadAppSettings: async () => {
    try {
      const app = await api.getAppSettings();
      const hidden = parseSidebarHidden(app.sidebarHidden);
      set({ appSettings: { ...app, sidebarHidden: hidden.length ? { stock: hidden } : {} } });
      leaveHidden();
    } catch (e) {
      get().toast(String(e), true);
    }
  },
  saveAppSettings: (patch) => {
    const app = get().appSettings;
    if (!app) return;
    const next = { ...app, ...patch };
    set({ appSettings: next });
    api.setAppSettings(next).catch((e) => get().toast(String(e), true));
  },
  setView: (view) => {
    // The similar view may take a moment to prepare; don't leave the old list up.
    const slow = view.kind === "similar";
    const clear = slow && get().view.kind !== view.kind ? { items: [], rawItems: [], sections: [] } : {};
    // Conditions belong to the view they were set in: moving to another one
    // starts clean (re-selecting the open view keeps them).
    // The kind filter stays: it is the range the user browses (docs/KINDS.md).
    const moved = JSON.stringify(view) !== JSON.stringify(get().view);
    const reset = moved
      ? {
          search: "",
          tagFilter: [],
          minRating: 0,
          filter: { ...EMPTY_FILTER, kinds: get().filter.kinds },
          editingSmart: null,
        }
      : {};
    const next = { ...get(), ...reset, view };
    set({
      view,
      // Going somewhere in the sidebar leaves the comparison for the list.
      comparing: false,
      selected: new Set(),
      anchor: null,
      focus: null,
      ...clear,
      ...reset,
      ...fitToKinds(next),
    });
    get().refresh();
  },
  setSearch: (search) => {
    set({ search });
    get().refresh();
  },
  toggleTagFilter: (id) => {
    const cur = get().tagFilter;
    set({ tagFilter: cur.includes(id) ? cur.filter((t) => t !== id) : [...cur, id] });
    get().refresh();
  },
  clearTagFilter: () => {
    set({ tagFilter: [] });
    get().refresh();
  },
  setTagMatchAll: (tagMatchAll) => {
    set({ tagMatchAll });
    persist("tagMatchAll", String(tagMatchAll));
    if (get().tagFilter.length > 1) get().refresh();
  },
  setSort: (sort, desc) => {
    set({ sort, desc });
    get().refresh();
  },
  toggleParent: (id) => {
    const open = new Set(get().openParents);
    if (!open.delete(id)) open.add(id);
    set(rearrange(get(), { openParents: open }));
  },
  setAllParents: (open) => {
    const here = new Set(get().rawItems.map((i) => i.id));
    const parents = open ? get().rawItems.flatMap((i) => (i.parentId && here.has(i.parentId) ? [i.parentId] : [])) : [];
    set(rearrange(get(), { openParents: parents.length ? new Set(parents) : NO_PARENTS }));
  },
  setThumbSize: (thumbSize) => {
    set({ thumbSize });
    persist("thumbSize", String(thumbSize));
  },
  toggleInspector: () => {
    const inspectorOpen = !get().inspectorOpen;
    set({ inspectorOpen });
    persist("inspectorOpen", String(inspectorOpen));
  },
  setPanelTab: (panelTab) => {
    set({ panelTab, inspectorOpen: true });
    persist("panelTab", panelTab);
    persist("inspectorOpen", "true");
  },
  togglePanelTab: (tab) => {
    const s = get();
    if (s.inspectorOpen && s.panelTab === tab) s.toggleInspector();
    else s.setPanelTab(tab);
  },
  setComparing: (comparing) => set({ comparing, compareLook: WHOLE_LOOK }),
  setCompareLook: (look) => set({ compareLook: typeof look === "function" ? look(get().compareLook) : look }),
  toggleSidebar: () => {
    const sidebarOpen = !get().sidebarOpen;
    set({ sidebarOpen });
    persist("sidebarOpen", String(sidebarOpen));
  },
  setTocOpen: (tocOpen) => set({ tocOpen }),
  setPanelWidth: (panel, px) => {
    const w = clampWidth(panel, px);
    set(panel === "sidebar" ? { sidebarWidth: w } : { inspectorWidth: w });
    persist(`${panel}Width`, String(w));
  },
  setShowSubfolders: (showSubfolders) => {
    set({ showSubfolders });
    persist("showSubfolders", String(showSubfolders));
    get().refresh();
  },
  setMinRating: (minRating) => {
    set({ minRating });
    get().refresh();
  },
  setFilter: (patch) => {
    set({ filter: { ...get().filter, ...patch } });
    get().refresh();
  },
  clearConditions: () => {
    // The kinds picked are the sidebar's range, not a condition of the row (docs/KINDS.md).
    set({ search: "", tagFilter: [], minRating: 0, filter: { ...EMPTY_FILTER, kinds: get().filter.kinds } });
    get().refresh();
  },
  currentRule: () => {
    const s = get();
    const { search, minRating, filter } = s;
    let { tagFilter, tagMatchAll } = s;
    // In a tag's place, the tag is a condition too (when the others all have to be on).
    const v = s.view;
    if (v.kind === "tag" && (tagFilter.length === 0 || tagMatchAll)) {
      tagFilter = [v.id, ...tagFilter.filter((t) => t !== v.id)];
      tagMatchAll = true;
    }
    // The kinds picked are a condition like the others.
    return { search, tagIds: tagFilter, tagMatchAll, minRating, filter };
  },
  startEditSmart: (sf) => {
    // Edit in the "all" view so the user sees exactly what the rule matches.
    set({
      editingSmart: { id: sf.id, name: sf.name, kinds: get().editingSmart?.kinds ?? get().filter.kinds },
      view: { kind: "all" },
      comparing: false,
      search: sf.rule.search,
      tagFilter: sf.rule.tagIds,
      tagMatchAll: sf.rule.tagMatchAll,
      minRating: sf.rule.minRating,
      // The kinds go to the kind filter. Shape and pixel size only match images
      // and videos, so a rule with them shows as of those.
      filter: { ...EMPTY_FILTER, ...sf.rule.filter, kinds: ruleKinds(sf.rule.filter) },
      selected: new Set(),
    });
    get().refresh();
  },
  stopEditSmart: () => set({ editingSmart: null }),
  setLayout: (layout) => {
    persist(LAYOUT_KEYS[0], layout);
    set({ layout });
  },
  setShowInfo: (patch) => {
    const showInfo = { ...get().showInfo, ...patch };
    set({ showInfo });
    persist("showInfo", JSON.stringify(showInfo));
  },
  setGroupBy: (groupBy) => {
    persist(GROUP_KEYS[0], groupBy);
    // The viewer follows the item it was showing to its new place.
    set(rearrange(get(), { groupBy }));
  },
  toggleViewerInfo: () => {
    const viewerInfo = !get().viewerInfo;
    set({ viewerInfo });
    persist("viewerInfo", String(viewerInfo));
  },
  toggleViewerStrip: () => {
    const viewerStrip = !get().viewerStrip;
    set({ viewerStrip });
    persist("viewerStrip", String(viewerStrip));
  },
  toggleViewerBare: () => {
    const viewerBare = !get().viewerBare;
    set({ viewerBare });
    persist("viewerBare", String(viewerBare));
  },
  setTagClipboard: (tagClipboard) => set({ tagClipboard }),
  rememberFolders: (ids) => {
    const rest = get().recentFolders.filter((f) => !ids.includes(f));
    set({ recentFolders: [...ids, ...rest].slice(0, 8) });
  },
  // Takes names because new tags only get an id once the backend creates them;
  // they are resolved against the tag list after the next refresh.
  rememberTags: (names) => {
    pendingRecentTags = [...names, ...pendingRecentTags.filter((n) => !names.includes(n))];
  },
  setRenamingFolder: (renamingFolder) => set({ renamingFolder }),
  requestItemRename: () => set({ renameItemSeq: get().renameItemSeq + 1, inspectorOpen: true, panelTab: "info" }),
  setPicker: (picker) => set({ picker }),
  openSettings: (tab) =>
    set((s) => {
      if (tab === null) return { settingsTab: null };
      // A page this build leaves out (src/lib/limits.ts) opens the first one.
      if (tab !== "last" && OFF_SETTINGS.has(tab)) tab = "general";
      if (tab !== "last") return { settingsTab: tab, lastSettingsTab: tab };
      const last = s.lastSettingsTab;
      return { settingsTab: last.startsWith("library") && !s.library ? "general" : last };
    }),
  setPairRequest: (pairRequest) => set({ pairRequest }),
  setSimilarLevel: (similarLevel) => {
    set({ similarLevel, keepPick: new Set(), selected: new Set(), anchor: null, focus: null });
    persist("similarLevel", similarLevel);
    get().refresh();
  },
  pickKeeper: (id) => {
    const items = get().items;
    const group = items.find((i) => i.id === id)?.group;
    const rivals = new Set(items.filter((i) => i.group === group).map((i) => i.id));
    set({ keepPick: new Set([...get().keepPick].filter((x) => !rivals.has(x)).concat(id)) });
  },
  setReview: (review) => set({ review }),
  setSheet: (sheet) => set({ sheet }),
  setTransfer: (transfer) => set({ transfer }),
  setSharing: (sharing) => set({ sharing }),
  setExporting: (exporting) => set({ exporting }),

  refresh: async () => {
    if (!get().library) return;
    const seq = ++refreshSeq;
    const { view, similarLevel } = get();
    try {
      let dismissedGroups: number | null = null;
      if (view.kind === "similar") {
        set({ analyzing: true });
        try {
          await api.indexSimilar();
        } finally {
          set({ analyzing: false });
        }
        dismissedGroups = await api.countDismissedDuplicates();
      }
      const [rawItems, folders, tags, counts, smartFolders, exts, shelf] = await Promise.all([
        api.queryItems(shownQuery(get())),
        api.listFolders(),
        api.listTags(),
        api.getCounts(),
        api.listSmartFolders(),
        api.listExts(),
        // The shelf, whatever the view and conditions.
        api.queryItems({
          view: { kind: "tray" },
          search: "",
          tagIds: [],
          tagMatchAll: false,
          includeSubfolders: false,
          minRating: 0,
          filter: { ...EMPTY_FILTER, kinds: queryKinds({ ...get(), view: { kind: "tray" }, filter: EMPTY_FILTER }) },
          similarLevel,
          sort: "manual",
          desc: false,
        }),
      ]);
      if (seq !== refreshSeq) return; // a newer refresh superseded this one
      const { items, sections } = arrange({ ...get(), view, rawItems, tags, folders });
      const present = new Set(items.map((i) => i.id));
      const selected = new Set([...get().selected].filter((id) => present.has(id)));
      // Drop filters / views pointing at things that no longer exist.
      const tagIds = new Set(tags.map((t) => t.id));
      const tagFilterNow = get().tagFilter.filter((t) => tagIds.has(t));
      const viewNow = get().view;
      const viewGone =
        (viewNow.kind === "folder" && !folders.some((f) => f.id === viewNow.id)) ||
        (viewNow.kind === "tag" && !tags.some((t) => t.id === viewNow.id)) ||
        (viewNow.kind === "smart" && !smartFolders.some((f) => f.id === viewNow.id));
      const folderIds = new Set(folders.map((f) => f.id));
      const byName = new Map(tags.map((t) => [t.name, t.id]));
      const fresh = pendingRecentTags.flatMap((n) => byName.get(n) ?? []);
      // Keep names not created yet (a refresh that began before add_tags finished).
      pendingRecentTags = pendingRecentTags.filter((n) => !byName.has(n)).slice(0, 12);
      const recentTags = [...fresh, ...get().recentTags.filter((t) => !fresh.includes(t))]
        .filter((t) => tagIds.has(t))
        .slice(0, 12);
      if (fresh.length) persist(recentTagsKey(get().library!.root), JSON.stringify(recentTags));
      // Keep the viewer on the image it was showing even if the list moved.
      const prev = get();
      const shownId = prev.viewer !== null ? prev.items[prev.viewer]?.id : undefined;
      const viewerNow =
        prev.viewer === null || items.length === 0
          ? null
          : shownId && present.has(shownId)
            ? items.findIndex((i) => i.id === shownId)
            : Math.min(prev.viewer, items.length - 1);
      set({
        items,
        rawItems,
        shelf,
        sections,
        folders,
        smartFolders,
        exts,
        tags,
        counts,
        selected,
        rev: get().rev + 1,
        ...(dismissedGroups !== null ? { dismissedGroups } : {}),
        recentFolders: get().recentFolders.filter((f) => folderIds.has(f)),
        recentTags,
        viewer: viewerNow,
      });
      if (viewGone || tagFilterNow.length !== get().tagFilter.length) {
        set({ tagFilter: tagFilterNow, ...(viewGone ? { view: { kind: "all" } } : {}) });
        get().refresh();
      }
    } catch (e) {
      get().toast(String(e), true);
    }
  },

  select: (id, mode, at) => {
    const { selected, anchor, items } = get();
    const b = indexOf(items, id, at);
    // No anchor in the list any more (trashed, filtered out): a range from
    // nowhere would run from the top, so it starts here instead.
    const a = mode === "range" && anchor !== null ? indexOf(items, anchor, anchorAt) : -1;
    if (mode === "range" && a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      set({ selected: new Set(items.slice(lo, hi + 1).map((i) => i.id)), focus: id });
      return;
    }
    anchorAt = b >= 0 ? b : null;
    if (mode === "toggle") {
      const next = new Set(selected);
      if (!next.delete(id)) next.add(id);
      set({ selected: next, anchor: id, focus: id });
    } else {
      set({ selected: new Set([id]), anchor: id, focus: id });
    }
  },
  setSelection: (ids) => {
    // The keyboard goes on from the last of them that is a row of the list
    // (a closed parent's children aren't).
    const rows = new Set(get().items.map((i) => i.id));
    let last = ids.at(-1) ?? null;
    for (let n = ids.length - 1; n >= 0; n--) {
      if (rows.has(ids[n])) {
        last = ids[n];
        break;
      }
    }
    anchorAt = null;
    set({ selected: new Set(ids), anchor: last, focus: last });
  },
  openViewer: (viewer) => set({ viewer }),

  setDrag: (drag) => set({ drag, dropTarget: drag ? get().dropTarget : null }),
  setDropTarget: (dropTarget) => {
    if (get().dropTarget !== dropTarget) set({ dropTarget });
  },
  setFileDrag: (fileDrag) => {
    if (get().fileDrag !== fileDrag) set({ fileDrag, ...(fileDrag ? {} : { dropTarget: null }) });
  },
  flashTarget: (target) => {
    const n = ++flashSeq;
    set({ flash: { target, n } });
    setTimeout(() => get().flash?.n === n && set({ flash: null }), 900);
  },
  setImporting: (importing) => set({ importing }),
  setUpdating: (updating) => set({ updating }),
  toast: (message, error, action) => get().notify({ title: message, kind: error ? "error" : "info", action }),
  notify: ({ title, detail, kind = "info", action, duration, replace }) => {
    const rev = ++toastSeq;
    const fields = {
      title,
      detail,
      kind,
      action,
      rev,
      duration: duration ?? toastDuration(kind, title + (detail ?? ""), !!action),
    };
    if (replace !== undefined && get().toasts.some((x) => x.id === replace && !x.leaving)) {
      set({ toasts: get().toasts.map((x) => (x.id === replace ? { ...fields, id: replace } : x)) });
      return replace;
    }
    const t: Toast = { ...fields, id: rev };
    // At most a handful on screen; the oldest give way.
    const live = get().toasts.filter((x) => !x.leaving);
    for (const old of live.slice(0, Math.max(0, live.length - 3))) get().dismissToast(old.id);
    set({ toasts: [...get().toasts, t] });
    return t.id;
  },
  dismissToast: (id) => {
    if (!get().toasts.some((t) => t.id === id && !t.leaving)) return;
    // Mark first so the exit animation can play, then remove.
    set({ toasts: get().toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), 200);
  },
  run: async (fn) => {
    let ok = true;
    try {
      await fn();
    } catch (e) {
      ok = false;
      get().toast(String(e), true);
    }
    await get().refresh();
    return ok;
  },
  importDone: (s, since) => {
    const parts = [];
    if (s.duplicates) parts.push(`${s.duplicates} 件はすでにあるためスキップ`);
    if (s.failed.length) parts.push(`${s.failed.length} 件は読み込めませんでした`);
    // Dropped files can be of any kind, so no "画像" here.
    const title = s.imported ? `${s.imported} 件を追加しました` : "追加されたものはありません";
    const detail = parts.join(" / ") || undefined;
    get().notify({
      title,
      detail,
      kind: s.failed.length && !s.imported ? "error" : s.imported ? "success" : "info",
    });
    if (since !== undefined) notifyIfAway(since, title, detail);
    if (s.failed.length) warn("import failures", s.failed);
    notifyUnusedKinds(s.kinds ?? {});
    if (s.kinds?.file) filesApi.prepareThumbs().catch(() => {});
  },
}));

let watchingFileThumbs = false;
/** Shows office documents' thumbnails as they are replaced in the background. */
function watchFileThumbs() {
  if (watchingFileThumbs) return;
  watchingFileThumbs = true;
  onFileThumbs(() => useStore.getState().refresh()).catch(() => {
    watchingFileThumbs = false;
  });
}

/**
 * After an import: tells about items of kinds the library isn't used for
 * (they are imported all the same; the kind comes from the file), with a
 * button to start using the kind.
 */
export function notifyUnusedKinds(kinds: Partial<Record<ItemKind, number>>) {
  const s = useStore.getState();
  const used = usedKinds(s);
  for (const { kind: m } of KINDS) {
    const n = kinds[m] ?? 0;
    // Kinds this build doesn't handle are never imported (src/lib/limits.ts).
    if (!n || used.includes(m) || !buildHas(m)) continue;
    s.notify({
      title: `${kindLabel(m)} ${n} 件を取り込みました`,
      detail: "このライブラリでは使っていない種類です",
      action: { label: `${kindLabel(m)}も使う`, onClick: () => useStore.getState().setUsedKinds([...usedKinds(useStore.getState()), m]) },
      duration: 12000,
    });
  }
}

export function currentFolderId(): string | null {
  const v = useStore.getState().view;
  return v.kind === "folder" ? v.id : null;
}

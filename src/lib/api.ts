// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.
import { invoke } from "@tauri-apps/api/core";

export interface LibraryInfo {
  root: string;
  name: string;
}

/** A library opened or created before (the library switcher's list). */
export interface LibraryEntry extends LibraryInfo {
  favorite: boolean;
  /** ms; 0 = never opened here (only copied into). */
  lastOpened: number;
  /** False when the folder is gone (deleted, or on a disconnected drive). */
  exists: boolean;
  current: boolean;
}

/** Result of copying / moving items into another library (src-tauri/src/transfer.rs). */
export interface TransferSummary {
  copied: number;
  /** Already in the destination; their tags and folder were merged in. */
  duplicates: number;
  failed: string[];
  /** Arrived items of kinds the destination isn't used for (its `modes` setting). */
  unusedKinds: Partial<Record<ItemKind, number>>;
  /**
   * Moving: how many went to this library's trash; null when another library
   * was opened (or this one closed) during the copy, so they stayed.
   */
  trashed: number | null;
}

/** Result of "ライブラリ全体を書き出し" (src-tauri/src/export.rs). */
export interface LibraryExport {
  /** The folder made for it ("<dest>/<library name>"). */
  folder: string;
  copied: number;
  total: number;
  /** Names of the items whose file couldn't be copied. */
  failed: string[];
  cancelled: boolean;
}

/** Settings of the whole app (settings.json): the settings screen's "一般" tab. */
export interface AppSettings {
  /** At launch: open the last library, or show the list to choose from. */
  startup: "last" | "choose";
  autoUpdate: boolean;
  /** Sidebar entries hidden per mode, for libraries that follow the app's sidebar. */
  sidebarHidden: Partial<Record<Mode, string[]>>;
}

/**
 * What a file is. Fonts have no pixel size (0 × 0) and a rendered sample as the thumbnail;
 * files (PDF, office documents) are 0 × 0 too, with a thumbnail from the OS or the file;
 * texts (Markdown, plain text, CSV) are 0 × 0, can be edited in the app and searched by their body (docs/TEXT.md);
 * videos have their picture size and a length (`durationMs`), a frame as the thumbnail and play in the viewer (docs/VIDEO.md).
 */
export type ItemKind = "image" | "font" | "file" | "text" | "video";

/**
 * What the app shows (docs/MODES.md): the stock (images and files) or the
 * fonts. Folders, tags and smart folders belong to one (src-tauri/src/db.rs `Mode`).
 */
export type Mode = "stock" | "font";

/** The mode an item of `kind` belongs to. */
export const modeOf = (kind: ItemKind): Mode => (kind === "font" ? "font" : "stock");

/**
 * Ids of the fonts installed on this computer (docs/SYSTEM_FONTS.md) start
 * with this: they are listed in the font mode but are not library items, so
 * nothing that changes items may be asked of them (src-tauri/src/fonts/system.rs).
 */
export const SYSTEM_ID_PREFIX = "sys:";
export const isSystemId = (id: string) => id.startsWith(SYSTEM_ID_PREFIX);
/** The ids that are library items (installed fonts left out). */
export const libraryIds = (ids: string[]) => ids.filter((id) => !isSystemId(id));

/** Kinds in the order the sidebar lists them. */
export const KINDS: { kind: ItemKind; label: string }[] = [
  { kind: "image", label: "画像" },
  { kind: "font", label: "フォント" },
  { kind: "file", label: "ファイル" },
  { kind: "text", label: "テキスト" },
  { kind: "video", label: "動画" },
];

export const kindLabel = (k: ItemKind) => KINDS.find((x) => x.kind === k)?.label ?? k;

/** File types imported as fonts (src-tauri/src/formats.rs `is_font`). */
export const FONT_EXTS = ["ttf", "otf", "woff", "woff2", "ttc", "otc"];

/** File types imported as files (src-tauri/src/files/mod.rs `EXTS`). */
export const FILE_EXTS = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key"];

/** File types imported as texts (src-tauri/src/texts/mod.rs `EXTS`). */
export const TEXT_EXTS = ["md", "markdown", "txt", "csv", "tsv"];

/** File types imported as videos (src-tauri/src/videos/mod.rs `EXTS`). */
export const VIDEO_EXTS = ["mp4", "m4v", "mov", "webm"];

/** The kind a file type is imported as. */
export const kindOfExt = (ext: string): ItemKind =>
  FONT_EXTS.includes(ext)
    ? "font"
    : FILE_EXTS.includes(ext)
      ? "file"
      : TEXT_EXTS.includes(ext)
        ? "text"
        : VIDEO_EXTS.includes(ext)
          ? "video"
          : "image";

/** "3:07" or "1:02:09" for a length in milliseconds. */
export function durationLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Name of a text's type. */
export function textTypeLabel(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "md" || e === "markdown") return "Markdown";
  if (e === "csv") return "CSV";
  if (e === "tsv") return "TSV";
  return "テキスト";
}

/** Name of a file's type (src-tauri/src/files/mod.rs `type_name`). */
export function fileTypeLabel(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "pdf") return "PDF";
  if (e === "doc" || e === "docx") return "Word";
  if (e === "xls" || e === "xlsx") return "Excel";
  if (e === "ppt" || e === "pptx") return "PowerPoint";
  if (e === "pages") return "Pages";
  if (e === "numbers") return "Numbers";
  if (e === "key") return "Keynote";
  return "ファイル";
}

/** Writing systems fonts are filed under (src-tauri/src/fonts.rs `SCRIPTS`). */
export const FONT_SCRIPTS: { key: string; label: string }[] = [
  { key: "ja", label: "日本語" },
  { key: "latin", label: "欧文" },
  { key: "zh", label: "中国語" },
  { key: "ko", label: "韓国語" },
  { key: "other", label: "その他" },
];

/** Typeface styles (fonts.rs `CATEGORIES`); "none" = not known. */
export const FONT_CATEGORIES: { key: string; label: string }[] = [
  { key: "mincho", label: "明朝・セリフ" },
  { key: "gothic", label: "ゴシック・サンセリフ" },
  { key: "maru", label: "丸ゴシック" },
  { key: "slab", label: "スラブセリフ" },
  { key: "brush", label: "筆書体" },
  { key: "hand", label: "手書き" },
  { key: "display", label: "デザイン" },
  { key: "none", label: "未分類" },
];

/** Weight ranges (db.rs `FONT_WEIGHTS`); a variable font is in every range its wght axis spans. */
export const FONT_WEIGHTS: { key: string; label: string; names: string; range: string }[] = [
  { key: "light", label: "細い", names: "Thin–Light", range: "〜399" },
  { key: "regular", label: "標準", names: "Regular–Medium", range: "400〜549" },
  { key: "bold", label: "太い", names: "SemiBold–Bold", range: "550〜749" },
  { key: "black", label: "極太", names: "ExtraBold–Black", range: "750〜" },
];

/** Features a font has any number of (fonts.rs `FEATURES`). */
export const FONT_FEATURES: { key: string; label: string }[] = [
  { key: "mono", label: "等幅" },
  { key: "coding", label: "プログラミング向け" },
  { key: "variable", label: "可変フォント" },
  { key: "italic", label: "イタリック・斜体" },
];

export const fontScriptLabel = (k: string) => FONT_SCRIPTS.find((x) => x.key === k)?.label ?? k;
export const fontCategoryLabel = (k: string) => FONT_CATEGORIES.find((x) => x.key === k)?.label ?? k;
export const fontWeightLabel = (k: string) => FONT_WEIGHTS.find((x) => x.key === k)?.label ?? k;
export const fontFeatureLabel = (k: string) => FONT_FEATURES.find((x) => x.key === k)?.label ?? k;

/** A font's typeface style: the user's choice, else the guess, else "none". */
export const fontCategoryOf = (item: Pick<Item, "fontCategory" | "fontCategoryUser">) =>
  item.fontCategoryUser ?? item.fontCategory ?? "none";

export interface Item {
  id: string;
  kind: ItemKind;
  name: string;
  fileName: string;
  ext: string;
  width: number;
  height: number;
  size: number;
  thumb: string;
  note: string;
  rating: number;
  importedAt: number;
  deletedAt: number | null;
  /** JPEG display copy for HEIC / TIFF. */
  preview: string | null;
  favorite: boolean;
  /** When the item was pinned to the top of lists; null = not pinned. */
  pinnedAt: number | null;
  /** Clockwise quarter turns (0-3), applied after `flipped`. width / height are already the turned size. */
  rotation: number;
  /** Mirrored horizontally (before rotating). */
  flipped: boolean;
  /** The folder the item is in, if any (one at most). */
  folderId: string | null;
  tagIds: number[];
  /** The web page the item was saved from with the browser extension. */
  sourceUrl: string | null;
  /** Fonts: family shared by its styles (null until read) and weight 100-900. */
  fontFamily: string | null;
  fontWeight: number | null;
  /** Fonts: writing system (see FONT_SCRIPTS), null until read. */
  fontScript: string | null;
  /** Fonts: typeface style guessed from the font (null = can't tell) and the user's correction. */
  fontCategory: string | null;
  fontCategoryUser: string | null;
  /** Fonts: features (see FONT_FEATURES), empty until read. */
  fontFeatures: string[];
  /** Fonts: PostScript name of the first font (null until read, or when it has none). */
  fontPsName: string | null;
  /** Videos: the length in milliseconds (null = not known). */
  durationMs: number | null;
  /**
   * An installed font on the font shelf that this computer doesn't have (the
   * library was put together on another one): only its name is known (docs/SYSTEM_FONTS.md).
   */
  unavailable?: boolean;
  /**
   * Font mode only: the row stands for a whole family; every font of it (the
   * row's own id first). Operations on the row reach them all.
   */
  familyIds?: string[];
  /** Font mode only: a style shown under its family's opened row (▸), indented. */
  familyMember?: boolean;
  /** On the shelf (シェルフ; the `tray` table). */
  inTray: boolean;
  filePath: string;
  thumbPath: string;
  /** What the viewer shows: the display copy if any, else the original. */
  displayPath: string;
  /** Similar view only: items with the same number look alike. Best copy first. */
  group?: number;
  /** Similar view only: differing hash bits (of 64) from the group's best copy. */
  distance?: number;
}

/** "1200 × 800", or the kind for items without a pixel size. */
export function sizeLabel(item: Pick<Item, "kind" | "width" | "height" | "ext">): string {
  if (item.kind === "font") return "フォント";
  if (item.kind === "file") return fileTypeLabel(item.ext);
  if (item.kind === "text") return textTypeLabel(item.ext);
  if (item.kind === "video" && !item.width) return "動画";
  return `${item.width} × ${item.height}`;
}

/** Rotate / flip, applied on top of the current orientation (the file is never changed). */
export type OrientOp = "rotateCw" | "rotateCcw" | "flipH" | "flipV" | "reset";

/**
 * CSS transform that shows the original file with the item's orientation.
 * Flip first, then rotate — the same order as src-tauri/src/orient.rs.
 */
export function orientTransform(item: Pick<Item, "rotation" | "flipped">): string {
  const parts = [];
  if (item.rotation) parts.push(`rotate(${item.rotation * 90}deg)`);
  if (item.flipped) parts.push("scaleX(-1)");
  return parts.join(" ");
}

export type View =
  | { kind: "all" }
  | { kind: "unfiled" }
  | { kind: "untagged" }
  | { kind: "trash" }
  | { kind: "similar" }
  | { kind: "favorites" }
  | { kind: "pinned" }
  /** The shelf (the `tray` table): only queried for the shelf under the list, never opened as a list. */
  | { kind: "tray" }
  | { kind: "folder"; id: string }
  | { kind: "smart"; id: string }
  /** Items carrying a tag: the sidebar's tags are places like folders (docs/NAVIGATION.md). */
  | { kind: "tag"; id: number }
  /**
   * Font mode: the fonts installed on this computer, read only and not in the
   * library (docs/SYSTEM_FONTS.md). Never sent to Rust: features/fonts/system.ts lists them.
   */
  | { kind: "system" };

export type Shape = "landscape" | "portrait" | "square";

/** Attribute filters (the filter bar). Empty / null = no restriction. */
export interface Filter {
  /**
   * Any of these kinds (empty = every kind): the kind filter of "すべて", or
   * the font mode's own (`queryKinds` in lib/modes.ts). In a smart folder's rule, the
   * kinds picked when it was saved.
   */
  kinds: ItemKind[];
  /** Fonts of any of these writing systems / styles / weight ranges / features (the font mode's sidebar). */
  fontScripts: string[];
  fontCategories: string[];
  fontWeights: string[];
  fontFeatures: string[];
  exts: string[];
  shapes: Shape[];
  minWidth: number | null;
  maxWidth: number | null;
  minHeight: number | null;
  maxHeight: number | null;
  /** ms; after inclusive, before exclusive. */
  importedAfter: number | null;
  importedBefore: number | null;
  /** bytes */
  minSize: number | null;
  maxSize: number | null;
}

export const EMPTY_FILTER: Filter = {
  kinds: [],
  fontScripts: [],
  fontCategories: [],
  fontWeights: [],
  fontFeatures: [],
  exts: [],
  shapes: [],
  minWidth: null,
  maxWidth: null,
  minHeight: null,
  maxHeight: null,
  importedAfter: null,
  importedBefore: null,
  minSize: null,
  maxSize: null,
};

/** Saved conditions of a smart folder (same shape as the ad-hoc ones). */
export interface Rule {
  search: string;
  tagIds: number[];
  tagMatchAll: boolean;
  minRating: number;
  filter: Filter;
}

export interface SmartFolder {
  id: string;
  name: string;
  rule: Rule;
  count: number;
  color: string | null;
  mode: Mode;
}

/** How alike images must be to count as duplicates: strict, standard, loose. */
export type SimilarLevel = "strict" | "standard" | "loose";

export type SortKey = "importedAt" | "name" | "size" | "dimensions" | "rating" | "manual";

export interface ItemQuery {
  view: View;
  search: string;
  tagIds: number[];
  /** true: items must carry every tag in `tagIds`; false: any one of them. */
  tagMatchAll: boolean;
  includeSubfolders: boolean;
  minRating: number;
  filter: Filter;
  similarLevel: SimilarLevel;
  sort: SortKey;
  desc: boolean;
}

/**
 * How many of a query's items have each value of each filter condition
 * (src-tauri/src/db.rs `facet_counts`). The filter row asks with the
 * condition whose menu is open left out: its counts are with the others on.
 */
export interface Facets {
  /** Items rated exactly n ("0" = unrated). */
  ratings: Record<string, number>;
  tags: Record<string, number>;
  kinds: Partial<Record<ItemKind, number>>;
  /** File types, most first. */
  exts: [string, number][];
  /** Images by shape. */
  shapes: Partial<Record<Shape, number>>;
  fontScripts: Record<string, number>;
  fontCategories: Record<string, number>;
  fontWeights: Record<string, number>;
  fontFeatures: Record<string, number>;
}

export interface Counts {
  all: number;
  unfiled: number;
  untagged: number;
  trash: number;
  favorites: number;
  pinned: number;
  /** Items on the shelf (not in the trash). */
  tray: number;
  /** Items not in the trash, by kind, whatever kind was asked for (the mode switch). */
  kinds: Partial<Record<ItemKind, number>>;
  /** Fonts not in the trash by writing system and by style ("none" = unknown). */
  fontScripts: Record<string, number>;
  fontCategories: Record<string, number>;
  /** ... by weight range (a variable font under every range it spans) and by feature. */
  fontWeights: Record<string, number>;
  fontFeatures: Record<string, number>;
}

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  count: number;
  /** Colour name (see lib/colors.ts), if set. */
  color: string | null;
  /** Shared on the local network (src-tauri/src/share.rs). */
  shared: boolean;
  mode: Mode;
}

/** A tag of one mode; the other mode may have one of the same name. */
export interface Tag {
  id: number;
  name: string;
  count: number;
  color: string | null;
  mode: Mode;
}

export interface SelectionInfo {
  tags: Tag[];
  folders: { id: string; count: number }[];
}

/** What tidying one duplicate group carries over to the copy kept. */
export interface DuplicateEffect {
  keep: string;
  remove: string[];
  addedTags: string[];
  /** The kept copy's new rating, if it goes up. */
  rating: number | null;
  /** Its rating before (for undoing). */
  ratingBefore: number;
  /** Folder the kept copy moves into (only if it had none). */
  folderId: string | null;
}

export interface ImportSummary {
  imported: number;
  duplicates: number;
  failed: string[];
  /** New items by kind. */
  kinds?: Partial<Record<ItemKind, number>>;
}

/** Saving from the browser extension (src-tauri/src/webimport.rs). */
export interface WebImportStatus {
  enabled: boolean;
  /** The local server is listening. */
  running: boolean;
  port: number;
  /** Why it isn't running although enabled (e.g. the port is taken). */
  error: string | null;
  /** Where the extension was put for Chrome, once set up. */
  extensionDir: string | null;
}

/** Organizing from Claude (src-tauri/src/mcp/). */
export interface McpStatus {
  enabled: boolean;
  /** The local server is listening. */
  running: boolean;
  port: number;
  /** Why it isn't running although enabled (e.g. the port is taken). */
  error: string | null;
  /** What to paste to connect, once turned on. */
  claudeCodeCommand: string | null;
  desktopConfig: string | null;
}

/** Folders shared read-only on the local network (src-tauri/src/share.rs). */
export interface ShareStatus {
  /** The server is listening (while the open library shares a folder). */
  running: boolean;
  port: number;
  /** Why it isn't running although a folder is shared (e.g. the port is taken). */
  error: string | null;
  shares: ShareInfo[];
}

export interface ShareInfo {
  folderId: string;
  /** The secret in the URL. */
  token: string;
  /** The original files may be downloaded. */
  download: boolean;
  createdAt: number;
  /** The folder's place in the sidebar ("旅行 / 京都"). */
  path: string;
  /** The URL at each address of this PC, the likeliest first. Empty when it isn't on a network. */
  urls: string[];
}

/** A change made from Claude, recorded so it can be undone (src-tauri/src/changes.rs). */
export interface Change {
  id: number;
  at: number;
  source: string;
  summary: string;
  undone: boolean;
}

export const api = {
  /** `force`: open even when another PC has it open (see lib/libraryLock.ts). */
  openLastLibrary: (force = false) => invoke<LibraryInfo | null>("open_last_library", { force }),
  /** `open: false` only creates it (and adds it to the list). */
  createLibrary: (path: string, open = true, force = false) =>
    invoke<LibraryInfo>("create_library", { path, open, force }),
  openLibrary: (path: string, force = false) => invoke<LibraryInfo>("open_library", { path, force }),
  listLibraries: () => invoke<LibraryEntry[]>("list_libraries"),
  setLibraryFavorite: (path: string, favorite: boolean) => invoke<void>("set_library_favorite", { path, favorite }),
  forgetLibrary: (path: string) => invoke<void>("forget_library", { path }),
  getAppSettings: () => invoke<AppSettings>("get_app_settings"),
  setAppSettings: (settings: AppSettings) => invoke<AppSettings>("set_app_settings", { settings }),
  /** The open library's settings (library.db), JSON by key. */
  getLibrarySettings: () => invoke<Record<string, unknown>>("get_library_settings"),
  /** `null` removes the setting. */
  setLibrarySetting: (key: string, value: unknown) => invoke<void>("set_library_setting", { key, value }),
  librarySize: () => invoke<number>("library_size"),
  /** Without `ids`, every item of `kind` not in the trash. `move` puts them in this library's trash afterwards. */
  transferItems: (dest: string, scope: { ids: string[] } | { kind: ItemKind }, move: boolean) =>
    invoke<TransferSummary>("transfer_items", {
      dest,
      ids: "ids" in scope ? scope.ids : null,
      kind: "kind" in scope ? scope.kind : null,
      moveItems: move,
    }),

  queryItems: (query: ItemQuery) => invoke<Item[]>("query_items", { query }),
  /** Totals for the sidebar; with `kind`, of that kind only (`kinds` always has every kind). */
  /** Counts of the items of `mode` (`kinds` is always of every kind). */
  facetCounts: (query: ItemQuery) => invoke<Facets>("facet_counts", { query }),
  getCounts: (mode?: Mode) => invoke<Counts>("get_counts", { mode: mode ?? null }),
  selectionInfo: (ids: string[]) => invoke<SelectionInfo>("selection_info", { ids }),
  setNote: (id: string, note: string) => invoke<void>("set_note", { id, note }),
  renameItem: (id: string, name: string) => invoke<void>("rename_item", { id, name }),
  trashItems: (ids: string[]) => invoke<void>("trash_items", { ids }),
  restoreItems: (ids: string[]) => invoke<void>("restore_items", { ids }),
  deleteItems: (ids: string[]) => invoke<void>("delete_items", { ids }),
  emptyTrash: () => invoke<void>("empty_trash"),
  revealItem: (id: string) => invoke<void>("reveal_item", { id }),
  openItems: (ids: string[]) => invoke<void>("open_items", { ids }),
  setRating: (ids: string[], rating: number) => invoke<void>("set_rating", { ids, rating }),
  setFavorite: (ids: string[], on: boolean) => invoke<void>("set_favorite", { ids, on }),
  /** Pinned items come first in every list. */
  setPinned: (ids: string[], on: boolean) => invoke<void>("set_pinned", { ids, on }),
  orientItems: (ids: string[], op: OrientOp) => invoke<number>("orient_items", { ids, op }),
  copyItems: (ids: string[]) => invoke<number>("copy_items", { ids }),
  /** `subdirs[i]`: folder under `dest` for `ids[i]` ("旅行/2025", "" = `dest` itself). */
  exportItems: (ids: string[], dest: string, subdirs?: string[]) =>
    invoke<number>("export_items", { ids, dest, subdirs: subdirs ?? null }),
  /**
   * Every item not in the trash into a new "<library name>" folder in `dest`,
   * in "<mode>/<folders>/…" (`labels` names the modes' folders). Reports "export-progress".
   */
  exportLibrary: (dest: string, labels: Record<Mode, string>) =>
    invoke<LibraryExport>("export_library", { dest, labels }),
  /** Stops `exportLibrary` after the file it is copying. */
  cancelExport: () => invoke<void>("cancel_export"),

  /** Puts items on the work tray, after the ones there; returns how many were new. */
  addToTray: (ids: string[]) => invoke<number>("add_to_tray", { ids }),
  removeFromTray: (ids: string[]) => invoke<void>("remove_from_tray", { ids }),
  /** Empties the tray; returns what was on it, in order (to put it back). */
  clearTray: () => invoke<string[]>("clear_tray"),
  reorderTray: (ids: string[], before: string | null) => invoke<void>("reorder_tray", { ids, before }),
  /** An item for the contact sheet: oriented, fitted inside `maxSide` px, PNG or JPEG data. */
  sheetImage: (id: string, maxSide: number) => invoke<ArrayBuffer>("sheet_image", { id, maxSide }),
  /** Writes a PNG / JPEG / HTML file made here to `path` (from the save dialog). */
  saveFile: (path: string, data: Uint8Array) =>
    invoke<void>("save_file", data, { headers: { "x-path": encodeURIComponent(path) } }),
  /** Puts PNG / JPEG data on the clipboard as an image. */
  copyImage: (data: Uint8Array) => invoke<void>("copy_image", data),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  revealLog: () => invoke<void>("reveal_log"),
  /** The proxy the OS uses for `url` (PAC included); null = direct. For the updater. */
  systemProxy: (url: string) => invoke<string | null>("system_proxy", { url }),
  /** The GitHub release page of `version` (what changed), in the browser. */
  openReleasePage: (version: string) => invoke<void>("open_release_page", { version }),

  importPaths: (paths: string[], folderId: string | null) =>
    invoke<ImportSummary>("import_paths", { paths, folderId }),
  importBytes: (name: string, data: Uint8Array, folderId: string | null) =>
    invoke<ImportSummary>("import_bytes", data, {
      headers: { "x-name": encodeURIComponent(name), "x-folder": folderId ?? "" },
    }),
  supportedExts: () => invoke<string[]>("supported_exts"),
  webImportStatus: () => invoke<WebImportStatus>("web_import_status"),
  setWebImport: (enabled: boolean) => invoke<WebImportStatus>("set_web_import", { enabled }),
  /** A new connection key: extensions set up elsewhere stop working until set up again. */
  resetWebImportToken: () => invoke<WebImportStatus>("reset_web_import_token"),
  /** Copies the extension to a folder Chrome can load and shows it; returns the folder. */
  installExtension: () => invoke<string>("install_extension"),
  /** Answers an extension's request to connect (the "web-pair" event). */
  answerWebPair: (id: string, allow: boolean) => invoke<void>("answer_web_pair", { id, allow }),
  mcpStatus: () => invoke<McpStatus>("mcp_status"),
  setMcp: (enabled: boolean) => invoke<McpStatus>("set_mcp", { enabled }),
  /** A new token: Claude Code has to be set up again. */
  resetMcpToken: () => invoke<McpStatus>("reset_mcp_token"),
  shareStatus: () => invoke<ShareStatus>("share_status"),
  /** Shares a folder (keeping its URL if it already is) or stops sharing it. */
  setFolderShare: (folderId: string, on: boolean) => invoke<ShareStatus>("set_folder_share", { folderId, on }),
  setShareDownload: (folderId: string, on: boolean) => invoke<ShareStatus>("set_share_download", { folderId, on }),
  stopAllShares: () => invoke<ShareStatus>("stop_all_shares"),
  /** A URL as a QR code (SVG markup). */
  shareQr: (text: string) => invoke<string>("share_qr", { text }),
  listChanges: () => invoke<Change[]>("list_changes"),
  /** Reverts a change made from Claude; `skipped` = entries edited again since, left alone. */
  undoChange: (id: number) => invoke<{ summary: string; skipped: number }>("undo_change", { id }),
  indexSimilar: () => invoke<number>("index_similar"),
  /** Treats these images as "not duplicates" so they aren't proposed together again. */
  dismissDuplicates: (ids: string[]) => invoke<void>("dismiss_duplicates", { ids }),
  undismissDuplicates: (ids: string[]) => invoke<void>("undismiss_duplicates", { ids }),
  clearDismissedDuplicates: () => invoke<void>("clear_dismissed_duplicates"),
  /** Number of dismissed groups still in effect. */
  countDismissedDuplicates: () => invoke<number>("count_dismissed_duplicates"),
  /** What `resolveDuplicates` would carry over, without changing anything. */
  previewDuplicates: (groups: { keep: string; remove: string[] }[]) =>
    invoke<DuplicateEffect[]>("preview_duplicates", { groups }),
  /** Trashes `remove`, first copying their tags and rating (and folder, if `keep` has none) onto `keep`. */
  resolveDuplicates: (groups: { keep: string; remove: string[] }[]) =>
    invoke<DuplicateEffect[]>("resolve_duplicates", { groups }),

  /** The folders of `mode` (every folder when not given). */
  listFolders: (mode?: Mode) => invoke<Folder[]>("list_folders", { mode: mode ?? null }),
  /** A subfolder is of its parent's mode, whatever `mode` says. */
  createFolder: (name: string, parentId: string | null, mode: Mode) =>
    invoke<string>("create_folder", { name, parentId, mode }),
  renameFolder: (id: string, name: string) => invoke<void>("rename_folder", { id, name }),
  deleteFolder: (id: string) => invoke<void>("delete_folder", { id }),
  moveFolder: (id: string, parentId: string | null) =>
    invoke<boolean>("move_folder", { id, parentId }),
  /**
   * An item is in one folder at most: this takes it out of the one it was in.
   * Items of the other mode than the folder's are left alone.
   */
  moveToFolder: (ids: string[], folderId: string) => invoke<void>("move_to_folder", { ids, folderId }),
  reorderInFolder: (folderId: string, ids: string[], before: string | null) =>
    invoke<void>("reorder_in_folder", { folderId, ids, before }),
  placeFolder: (id: string, parentId: string | null, before: string | null) =>
    invoke<boolean>("place_folder", { id, parentId, before }),
  /** -1 / +1 = up / down one; very large values move to the top / bottom. */
  shiftFolder: (id: string, by: number) => invoke<void>("shift_folder", { id, by }),
  /** `parentId` null: the top level of `mode`. */
  sortFoldersByName: (parentId: string | null, mode: Mode) =>
    invoke<void>("sort_folders_by_name", { parentId, mode }),
  listSmartFolders: (mode?: Mode) => invoke<SmartFolder[]>("list_smart_folders", { mode: mode ?? null }),
  createSmartFolder: (name: string, rule: Rule, mode: Mode) =>
    invoke<string>("create_smart_folder", { name, rule, mode }),
  updateSmartFolder: (id: string, patch: { name?: string; rule?: Rule }) =>
    invoke<void>("update_smart_folder", { id, name: patch.name ?? null, rule: patch.rule ?? null }),
  deleteSmartFolder: (id: string) => invoke<void>("delete_smart_folder", { id }),
  listExts: (mode?: Mode) => invoke<[string, number][]>("list_exts", { mode: mode ?? null }),
  removeFromFolder: (ids: string[], folderId: string) =>
    invoke<void>("remove_from_folder", { ids, folderId }),

  listTags: (mode?: Mode) => invoke<Tag[]>("list_tags", { mode: mode ?? null }),
  /** Each item gets the tag of its own mode (made where missing). */
  addTags: (ids: string[], names: string[]) => invoke<void>("add_tags", { ids, names }),
  removeTag: (ids: string[], tagId: number) => invoke<void>("remove_tag", { ids, tagId }),
  renameTag: (id: number, name: string) => invoke<void>("rename_tag", { id, name }),
  deleteTag: (id: number) => invoke<void>("delete_tag", { id }),
  /** `color` null clears it. */
  setFolderColor: (id: string, color: string | null) => invoke<void>("set_folder_color", { id, color }),
  setSmartFolderColor: (id: string, color: string | null) =>
    invoke<void>("set_smart_folder_color", { id, color }),
  setTagColor: (id: number, color: string | null) => invoke<void>("set_tag_color", { id, color }),
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

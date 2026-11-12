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
  /** ライト／ダーク: follow the OS, or the user's choice (lib/appearance.ts). */
  appearance: "system" | "light" | "dark";
  /**
   * Sidebar entries hidden, for libraries that follow the app's sidebar. Kept
   * under `stock` (`{ stock: [...] }`) as earlier versions read it; their
   * `font` entry is ignored (docs/FONT_APP.md).
   */
  sidebarHidden: { stock?: string[] };
  /** Where "編集用に書き出して開く" puts its copies; null = 書類/Stockroom (docs/OPEN_EXTERNAL.md). */
  editFolder: string | null;
}

/** An app that can open the items (the list under "アプリで開く", macOS). */
export interface AppChoice {
  /** For `openItemsWith` ("/Applications/Preview.app"). */
  path: string;
  /** As Finder shows it ("プレビュー"). */
  name: string;
  /** The default app for all of them. */
  default: boolean;
}

/** What "編集用に書き出して開く" wrote. */
export interface EditCopies {
  folder: string;
  count: number;
}

/**
 * What a file is. Files (PDF, office documents) are 0 × 0 too, with a thumbnail from the OS or the file;
 * texts (Markdown, plain text, CSV) are 0 × 0, can be edited in the app and searched by their body (docs/TEXT.md);
 * videos have their picture size and a length (`durationMs`), a frame as the thumbnail and play in the viewer (docs/VIDEO.md);
 * bookmarks are a URL (`sourceUrl`) with the page's title as the name, 0 × 0, an eyecatch or a card as the thumbnail (docs/BOOKMARKS.md).
 */
export type ItemKind = "image" | "file" | "text" | "video" | "bookmark";

/** Kinds in the order the sidebar lists them. */
export const KINDS: { kind: ItemKind; label: string }[] = [
  { kind: "image", label: "画像" },
  { kind: "file", label: "ファイル" },
  { kind: "text", label: "テキスト" },
  { kind: "video", label: "動画" },
  { kind: "bookmark", label: "ブックマーク" },
];

export const kindLabel = (k: ItemKind) => KINDS.find((x) => x.kind === k)?.label ?? k;

/** File types imported as files (src-tauri/src/files/mod.rs `EXTS`). */
export const FILE_EXTS = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key"];

/** File types imported as texts (src-tauri/src/texts/mod.rs `EXTS`). */
export const TEXT_EXTS = ["md", "markdown", "txt", "csv", "tsv"];

/** File types imported as videos (src-tauri/src/videos/mod.rs `EXTS`). */
export const VIDEO_EXTS = ["mp4", "m4v", "mov", "webm"];

/** The kind a file type is imported as. */
export const kindOfExt = (ext: string): ItemKind =>
  ext === "url"
    ? "bookmark"
    : FILE_EXTS.includes(ext)
      ? "file"
      : TEXT_EXTS.includes(ext)
        ? "text"
        : VIDEO_EXTS.includes(ext)
          ? "video"
          : "image";

/** "example.com/path" for showing a URL compactly. */
export function urlLabel(url: string): string {
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./, "") + (u.pathname === "/" ? "" : decodeURI(u.pathname));
  } catch {
    return url;
  }
}

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

export interface VideoCodecs {
  video: string | null;
  audio: string | null;
  /** Average frames per second of the picture track. */
  frameRate: number | null;
}

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
  /** Videos: the length in milliseconds (null = not known). */
  durationMs: number | null;
  /** On the shelf (シェルフ; the `tray` table). */
  inTray: boolean;
  /** The item this one is linked to as a child (docs/LINKS.md); null = not a child. */
  parentId: string | null;
  /** The child picked among its parent's children (採用); at most one per parent. */
  adopted: boolean;
  /** A parent in a list only because a child of it matches (docs/LINKS.md): "中に該当あり". */
  viaChild?: boolean;
  /** A parent's row (links on): the children listed with it (`groupItems`), shown under it while opened (▸). */
  childIds?: string[];
  /** A child shown under its parent's opened row, indented. */
  childMember?: boolean;
  filePath: string;
  thumbPath: string;
  /** What the viewer shows: the display copy if any, else the original. */
  displayPath: string;
  /** A video's thumbnail is one the user set, not the frame from the OS (docs/VIDEO.md). */
  ownThumb: boolean;
  /** サムネイル画像の幅 ÷ 高さ。width / height が 0 の項目（ファイル・ブックマーク・テキスト）だけ。 */
  thumbAspect?: number | null;
  /** Similar view only: items with the same number look alike. Best copy first. */
  group?: number;
  /** Similar view only: differing hash bits (of 64) from the group's best copy. */
  distance?: number;
}

/** "29.97 fps": the rate with up to two decimals. */
export const frameRateLabel = (fps: number) => `${+fps.toFixed(2)} fps`;

/** Average bit rate of the whole file ("8.4 Mbps"), from its size and length. */
export function bitRateLabel(bytes: number, durationMs: number): string {
  const bps = (bytes * 8) / (durationMs / 1000);
  return bps >= 1e6 ? `${+(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
}

/** "1200 × 800", or the kind for items without a pixel size. */
export function sizeLabel(item: Pick<Item, "kind" | "width" | "height" | "ext">): string {
  if (item.kind === "file") return fileTypeLabel(item.ext);
  if (item.kind === "text") return textTypeLabel(item.ext);
  if (item.kind === "video" && !item.width) return "動画";
  if (item.kind === "bookmark") return "ブックマーク";
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
  | { kind: "tag"; id: number };

export type Shape = "landscape" | "portrait" | "square";

/** Attribute filters (the filter bar). Empty / null = no restriction. */
export interface Filter {
  /**
   * Any of these kinds (empty = every kind): the sidebar's range (`queryKinds`
   * in lib/kinds.ts). In a smart folder's rule, the kinds picked when it was saved.
   */
  kinds: ItemKind[];
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
  /** Only items with children (links on, docs/LINKS.md). */
  parentsOnly: boolean;
  /** Only items linked to a parent / outside every link (docs/LINKS.md). At most one of the three. */
  childrenOnly: boolean;
  unlinkedOnly: boolean;
}

export const EMPTY_FILTER: Filter = {
  kinds: [],
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
  parentsOnly: false,
  childrenOnly: false,
  unlinkedOnly: false,
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
  /** `count` by kind (docs/KINDS.md). */
  byKind: KindCounts;
  color: string | null;
}

/** How alike images must be to count as duplicates: strict, standard, loose. */
export type SimilarLevel = "strict" | "standard" | "loose";

/** Where a video's own thumbnail comes from (videos/thumb.rs `Source`). */
export type VideoThumbSource =
  | { from: "file"; path: string }
  | { from: "clipboard" }
  | { from: "item"; id: string }
  | { from: "adopted" };

/** Where a child stood before its links changed (docs/LINKS.md). */
export interface LinkPlacement {
  id: string;
  parentId: string | null;
  folderId: string | null;
  adopted: boolean;
}

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
  /** Links on: a matching child brings its parent into the list (docs/LINKS.md). Only the list on screen asks. */
  withParents?: boolean;
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
  /** Items with children. */
  parents: number;
  children: number;
  unlinked: number;
}

/** Items by kind (kinds with none are left out). */
export type KindCounts = Partial<Record<ItemKind, number>>;

/** The sidebar's fixed places, each by kind. */
export interface PlaceKinds {
  all: KindCounts;
  unfiled: KindCounts;
  untagged: KindCounts;
  trash: KindCounts;
  favorites: KindCounts;
  pinned: KindCounts;
  tray: KindCounts;
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
  /** Items not in the trash, by kind. */
  kinds: Partial<Record<ItemKind, number>>;
  /** The places above, each by kind: the sidebar's counts for the kinds picked (docs/KINDS.md). */
  byKind: PlaceKinds;
}

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  count: number;
  /** `count` by kind (docs/KINDS.md). */
  byKind: KindCounts;
  /** Colour name (see lib/colors.ts), if set. */
  color: string | null;
  /** Shared on the local network (src-tauri/src/share.rs). */
  shared: boolean;
}

export interface Tag {
  id: number;
  name: string;
  count: number;
  /** `count` by kind (docs/KINDS.md); empty where not counted (a selection's tags). */
  byKind: KindCounts;
  color: string | null;
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
  facetCounts: (query: ItemQuery) => invoke<Facets>("facet_counts", { query }),
  /** Totals for the sidebar. */
  getCounts: () => invoke<Counts>("get_counts"),
  selectionInfo: (ids: string[]) => invoke<SelectionInfo>("selection_info", { ids }),
  setNote: (id: string, note: string) => invoke<void>("set_note", { id, note }),
  renameItem: (id: string, name: string) => invoke<void>("rename_item", { id, name }),
  trashItems: (ids: string[]) => invoke<void>("trash_items", { ids }),
  restoreItems: (ids: string[]) => invoke<void>("restore_items", { ids }),
  deleteItems: (ids: string[]) => invoke<void>("delete_items", { ids }),
  emptyTrash: () => invoke<void>("empty_trash"),
  revealItem: (id: string) => invoke<void>("reveal_item", { id }),
  /** A video's codecs, read from its headers (null = not found). */
  videoCodecs: (id: string) => invoke<VideoCodecs>("video_codecs", { id }),
  /** Gives a video a thumbnail of the user's (docs/VIDEO.md); returns its file name. */
  setVideoThumb: (id: string, source: VideoThumbSource) => invoke<string>("set_video_thumb", { id, source }),
  /** Back to the frame from the OS. */
  resetVideoThumb: (id: string) => invoke<void>("reset_video_thumb", { id }),
  /** In the default app, made read-only first (docs/OPEN_EXTERNAL.md). */
  openItems: (ids: string[]) => invoke<void>("open_items", { ids }),
  /**
   * In an app the user picks, read-only: `app` on macOS (picked here); on
   * Windows the system asks for each file. Resolves to how many were opened.
   */
  openItemsWith: (ids: string[], app: string | null) => invoke<number>("open_items_with", { ids, with: app }),
  /**
   * The apps that can open every one of the items, the default first (as
   * Finder's "このアプリケーションで開く"). Empty on Windows.
   */
  appsForItems: (ids: string[]) => invoke<AppChoice[]>("apps_for_items", { ids }),
  /** Copies into the edit folder, each opened in its default app. */
  openForEdit: (ids: string[]) => invoke<EditCopies>("open_for_edit", { ids }),
  /** The edit folder when none is set: 書類/Stockroom. */
  defaultEditFolder: () => invoke<string>("default_edit_folder"),
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
   * in "<folders>/…" (unfiled items at its top). Reports "export-progress".
   */
  exportLibrary: (dest: string) => invoke<LibraryExport>("export_library", { dest }),
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
  /** The proxy the OS uses for the update feed (PAC included); null = direct. For the updater. */
  systemProxy: () => invoke<string | null>("system_proxy"),
  /** The GitHub release page of `version` (what changed), in the browser. Same repository as the update feed. */
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

  listFolders: () => invoke<Folder[]>("list_folders"),
  createFolder: (name: string, parentId: string | null) => invoke<string>("create_folder", { name, parentId }),
  renameFolder: (id: string, name: string) => invoke<void>("rename_folder", { id, name }),
  deleteFolder: (id: string) => invoke<void>("delete_folder", { id }),
  moveFolder: (id: string, parentId: string | null) =>
    invoke<boolean>("move_folder", { id, parentId }),
  /** An item is in one folder at most: this takes it out of the one it was in. */
  moveToFolder: (ids: string[], folderId: string) => invoke<void>("move_to_folder", { ids, folderId }),
  /** Parent–child links (docs/LINKS.md). Each returns where the children stood, for `restoreLinks`. */
  linkItems: (parentId: string, ids: string[]) => invoke<LinkPlacement[]>("link_items", { parentId, ids }),
  unlinkItems: (ids: string[]) => invoke<LinkPlacement[]>("unlink_items", { ids }),
  restoreLinks: (placements: LinkPlacement[]) => invoke<void>("restore_links", { placements }),
  /** Makes the child `id` the parent of its family (its parent and the other children go under it). */
  makeParent: (id: string) => invoke<LinkPlacement[]>("make_parent", { id }),
  countLinks: () => invoke<number>("count_links"),
  /** Picks a child as the adopted one of its parent's children (or takes the pick back). */
  setAdopted: (id: string, on: boolean) => invoke<void>("set_adopted", { id, on }),
  /** Off removes every link; resolves to how many. */
  setLinksEnabled: (on: boolean) => invoke<number>("set_links_enabled", { on }),
  reorderInFolder: (folderId: string, ids: string[], before: string | null) =>
    invoke<void>("reorder_in_folder", { folderId, ids, before }),
  placeFolder: (id: string, parentId: string | null, before: string | null) =>
    invoke<boolean>("place_folder", { id, parentId, before }),
  /** -1 / +1 = up / down one; very large values move to the top / bottom. */
  shiftFolder: (id: string, by: number) => invoke<void>("shift_folder", { id, by }),
  /** `parentId` null: the top level. */
  sortFoldersByName: (parentId: string | null) => invoke<void>("sort_folders_by_name", { parentId }),
  listSmartFolders: () => invoke<SmartFolder[]>("list_smart_folders"),
  createSmartFolder: (name: string, rule: Rule) => invoke<string>("create_smart_folder", { name, rule }),
  updateSmartFolder: (id: string, patch: { name?: string; rule?: Rule }) =>
    invoke<void>("update_smart_folder", { id, name: patch.name ?? null, rule: patch.rule ?? null }),
  deleteSmartFolder: (id: string) => invoke<void>("delete_smart_folder", { id }),
  listExts: () => invoke<[string, number][]>("list_exts"),
  removeFromFolder: (ids: string[], folderId: string) =>
    invoke<void>("remove_from_folder", { ids, folderId }),

  listTags: () => invoke<Tag[]>("list_tags"),
  /** Tags made where missing. */
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

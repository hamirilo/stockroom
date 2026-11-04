// Settings stored in the library itself (library.db `settings`, see
// docs/SETTINGS.md): the kinds it is used for and the sidebar entries hidden.
// They travel with the library. The sidebar can instead follow the app's
// (settings.json `sidebarHidden`).
//
// Libraries from versions with a font mode (docs/FONT_APP.md) may also hold
// "font" in `modes`, a `lastMode` and `hidden:font`: they are ignored, and
// `lastMode` is no longer written.
import { KINDS, type ItemKind } from "./api";
import { LIMITED_KINDS } from "./limits";

export interface LibrarySettings {
  /** Kinds the library is used for, in the order of `KINDS`; never empty. Stored as `modes`. */
  kinds: ItemKind[];
  /** Sidebar entries hidden (ids of `SIDEBAR_ENTRIES`); used when `sidebarOwn`. Stored as `hidden:stock`. */
  hidden: string[];
  /** The library has its own sidebar entries; otherwise it follows the app's. */
  sidebarOwn: boolean;
  /** Parent–child links are used (docs/LINKS.md); off unless turned on. Written by Rust (`set_links_enabled`). */
  links: boolean;
  /** What putting a parent in the trash does to its children (docs/LINKS.md): "with" = they go along. */
  linksTrash: "with" | "keep";
}

/** Every kind this build handles (src/lib/limits.ts). */
const ALL_KINDS = KINDS.map((k) => k.kind).filter((k) => !LIMITED_KINDS || LIMITED_KINDS.includes(k));

export const DEFAULT_LIBRARY_SETTINGS: LibrarySettings = { kinds: ALL_KINDS, hidden: [], sidebarOwn: false, links: false, linksTrash: "with" };

/** Sidebar entries that can be hidden. "すべて" and "ゴミ箱" always stay. */
export const SIDEBAR_ENTRIES: { id: string; label: string }[] = [
  { id: "unfiled", label: "未分類" },
  { id: "untagged", label: "タグなし" },
  { id: "favorites", label: "お気に入り" },
  { id: "pinned", label: "ピン留め" },
  { id: "similar", label: "重複の候補" },
  { id: "section:folders", label: "フォルダ" },
  { id: "section:smart", label: "スマートフォルダ" },
  { id: "section:tags", label: "タグ" },
];

/** The library setting the hidden sidebar entries are stored under (the name is from versions with modes). */
export const HIDDEN_KEY = "hidden:stock";

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
/** Ids of sidebar entries this version knows. */
const entries = (v: unknown) => {
  const known = new Set(SIDEBAR_ENTRIES.map((e) => e.id));
  return strings(v).filter((id) => known.has(id));
};

/** Reads the stored JSON, skipping keys, kinds and entries this version doesn't know. */
export function parseLibrarySettings(raw: Record<string, unknown>): LibrarySettings {
  const listed = strings(raw.modes);
  const kinds = ALL_KINDS.filter((k) => listed.includes(k));
  // Taken over from "すべて", or the image / file mode's of earlier versions, until saved anew.
  const keys = [HIDDEN_KEY, "hidden:all", "hidden:image", "hidden:file"];
  const from = keys.find((key) => raw[key] !== undefined);
  const hidden = from ? entries(raw[from]) : [];
  // Libraries that hid something before the app's sidebar existed keep it as their own.
  const sidebarOwn = raw.sidebar === "own" || (raw.sidebar === undefined && hidden.length > 0);
  return {
    kinds: kinds.length ? kinds : ALL_KINDS,
    hidden,
    sidebarOwn,
    links: raw.links === true,
    linksTrash: raw.linksTrash === "keep" ? "keep" : "with",
  };
}

/** The app's hidden sidebar entries (settings.json `sidebarHidden.stock`), skipping entries this version doesn't know. */
export function parseSidebarHidden(raw: unknown): string[] {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  // What "すべて" had, until saved anew.
  return entries(obj.stock ?? obj.all);
}

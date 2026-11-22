// The kinds a list holds. Every kind the library is used for is listed
// together; the sidebar's range ("種類で絞る", docs/KINDS.md) narrows them.
// See docs/ARCHITECTURE.md.
import { KINDS, kindLabel, kindOfExt, type Filter, type ItemKind, type KindCounts, type SmartFolder, type View } from "./api";

/** What items of these kinds are called in a sentence ("条件に一致する画像はありません"). */
export const kindsNoun = (kinds: ItemKind[]) => (kinds.length === 1 ? kindLabel(kinds[0]) : "アイテム");

/** What these items are called: their kind when they are of one ("画像"), else "アイテム". */
export const itemsNoun = (items: { kind: ItemKind }[]) => kindsNoun([...new Set(items.map((i) => i.kind))]);

/** What decides the kinds a list holds (the store's state has it all). */
export type KindState = {
  view: View;
  filter: Filter;
  smartFolders: SmartFolder[];
  librarySettings: { kinds: ItemKind[] };
};

/** A sidebar count narrowed to the kinds picked (docs/KINDS.md): `total` when none are. */
export function inScope(s: { filter: { kinds: ItemKind[] } }, total: number, byKind: KindCounts): number {
  if (!s.filter.kinds.length) return total;
  return s.filter.kinds.reduce((n, k) => n + (byKind[k] ?? 0), 0);
}

/** Every kind in `KINDS` order: the range's menu and its keys ⌥1… (docs/KINDS.md). */
export const ALL_KINDS: ItemKind[] = KINDS.map((k) => k.kind);

/**
 * Kinds the sidebar's range offers (docs/KINDS.md): the kinds in use, none
 * when one kind only is used (nothing to pick).
 */
export function rangeKinds(s: Pick<KindState, "librarySettings">): ItemKind[] {
  const used = usedKinds(s);
  return used.length > 1 ? used : [];
}

/** Kinds the open library is used for, in `KINDS` order. */
export const usedKinds = (s: Pick<KindState, "librarySettings">): ItemKind[] =>
  ALL_KINDS.filter((k) => s.librarySettings.kinds.includes(k));

/** Kinds the query asks for: those in use, narrowed by the kind filter. */
export function shownKinds(s: Pick<KindState, "filter" | "librarySettings">): ItemKind[] {
  const base = usedKinds(s);
  const picked = s.filter.kinds.filter((k) => base.includes(k));
  return picked.length ? picked : base;
}

/**
 * `filter.kinds` of the query: none when every kind is shown. The similar
 * view is of images whatever the kind filter (look-alikes are found by image hash).
 */
export const queryKinds = (s: Pick<KindState, "view" | "filter" | "librarySettings">): ItemKind[] => {
  if (s.view.kind === "similar") return ["image"];
  const kinds = shownKinds(s);
  return kinds.length === KINDS.length ? [] : kinds;
};

/**
 * Kinds the list on screen can hold: those shown, narrowed further by an
 * open smart folder's rule, the picked file types (JPEG alone is images alone)
 * and the similar view (images only). What applies to one kind only (turning
 * images) is offered by it; commands go by the selection too (`appliesTo`).
 */
export function listKinds(s: KindState): ItemKind[] {
  const v = s.view;
  if (v.kind === "similar") return ["image"];
  let kinds = shownKinds(s);
  const rule = v.kind === "smart" ? s.smartFolders.find((f) => f.id === v.id)?.rule.filter.kinds : undefined;
  if (rule?.length) kinds = kinds.filter((k) => rule.includes(k));
  const exts = s.filter.exts;
  if (exts.length) kinds = kinds.filter((k) => exts.some((e) => kindOfExt(e) === k));
  return kinds;
}

/** Whether the list on screen holds only `kind`. */
export const listIs = (s: KindState, kind: ItemKind) => {
  const kinds = listKinds(s);
  return kinds.length === 1 && kinds[0] === kind;
};

/** What the list's items are called ("画像", or "アイテム" for several kinds). */
export const listNoun = (s: KindState) => kindsNoun(listKinds(s));

/** A rule's kinds for the range: its own (none = every kind). */
export const ruleKinds = (f: Partial<Filter>): ItemKind[] => f.kinds ?? [];

/** What a kind chip's colour stands for: the role of the format, not the app that made it. */
export type ChipTone = "video";

/**
 * The chip at the top left of a thumbnail that tells what an item is (docs/KINDS.md
 * 「一覧での見分け」): the format in capitals and a tone. None for images, the
 * thumbnail is the picture itself.
 */
export function kindChip(item: { kind: ItemKind; ext: string }): { label: string; tone: ChipTone } | null {
  return item.kind === "video" ? { label: item.ext.toUpperCase(), tone: "video" } : null;
}

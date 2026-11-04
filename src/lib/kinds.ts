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
 * and the similar view (images only). What applies to some kinds only (a
 * shape and pixel size: images and videos, `listHasPixels`) is offered when
 * this is within them; commands go by the selection too (`appliesTo`).
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

/** Kinds with a pixel size (width × height): the shape / size condition and sort apply to them (docs/KINDS.md). */
export const PIXEL_KINDS: ItemKind[] = ["image", "video"];

/** Whether the list on screen holds only kinds among `kinds` (and some kind). */
export const listWithin = (s: KindState, kinds: ItemKind[]) => {
  const held = listKinds(s);
  return held.length > 0 && held.every((k) => kinds.includes(k));
};

/** Whether everything the list on screen can hold has a pixel size (images, videos). */
export const listHasPixels = (s: KindState) => listWithin(s, PIXEL_KINDS);

/** Whether the list on screen holds only `kind`. */
export const listIs = (s: KindState, kind: ItemKind) => {
  const kinds = listKinds(s);
  return kinds.length === 1 && kinds[0] === kind;
};

/** What the list's items are called ("画像", or "アイテム" for several kinds). */
export const listNoun = (s: KindState) => kindsNoun(listKinds(s));

/** A rule's kinds for the range: its own, else images and videos when it has pixel-size conditions. */
export function ruleKinds(f: Partial<Filter>): ItemKind[] {
  if (f.kinds?.length) return f.kinds;
  const sized = !!f.shapes?.length || [f.minWidth, f.maxWidth, f.minHeight, f.maxHeight].some((v) => v != null);
  return sized ? PIXEL_KINDS : [];
}

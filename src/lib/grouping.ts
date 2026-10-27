// Splits the list into sections (kinds, typeface styles, writing systems,
// rating bands, tags, folders) for the grid, and folds fonts into one row per
// family in the font mode.
// The result is a flattened display list plus the [start, end) of each
// section, so layouts and navigation keep working on plain indices.
import { FONT_CATEGORIES, FONT_SCRIPTS, fontCategoryOf, KINDS, type Folder, type Item, type Tag } from "./api";

export type GroupBy = "none" | "kind" | "category" | "script" | "rating" | "tag" | "folder" | "year" | "month";

export const GROUP_BYS: GroupBy[] = ["none", "kind", "category", "script", "rating", "tag", "folder", "year", "month"];

export interface Section {
  /** Index of the first item, and one past the last. */
  start: number;
  end: number;
  title: string;
  /** Colour name of the tag / folder (see lib/colors.ts). */
  color?: string | null;
  /** Rating sections: the number of stars (0 = unrated). */
  rating?: number;
}

export interface Grouped {
  items: Item[];
  sections: Section[];
}

/**
 * How fonts are folded into families (the font mode): one row per family,
 * and the styles of the families in `open` listed under their row.
 * Null = every item is a row of its own (the stock).
 */
export type Families = { open: ReadonlySet<string> } | null;

/**
 * How children are folded under their parent (links on, the stock; docs/LINKS.md):
 * one row per parent, and the children of the parents in `open` listed under their row.
 * Null = every item is a row of its own.
 */
export type Links = { open: ReadonlySet<string> } | null;

/** Folders in sidebar order (depth first), each with its full path. */
export function folderPaths(folders: Folder[]): { folder: Folder; path: string }[] {
  const out: { folder: Folder; path: string }[] = [];
  const walk = (parent: string | null, prefix: string) => {
    for (const f of folders) {
      if (f.parentId !== parent) continue;
      const path = prefix ? `${prefix} / ${f.name}` : f.name;
      out.push({ folder: f, path });
      walk(f.id, path);
    }
  };
  walk(null, "");
  return out;
}

/** Similar view: one section per group of look-alikes (items stay as they are). */
export function similarSections(items: Item[]): Section[] {
  const sections: Section[] = [];
  for (let i = 0; i < items.length; i++) {
    if (i === 0 || items[i].group !== items[i - 1].group) {
      sections.push({ start: i, end: i + 1, title: `グループ ${(items[i].group ?? 0) + 1}` });
    } else {
      sections[sections.length - 1].end = i + 1;
    }
  }
  return sections;
}

/** Ids a list row stands for: a family row's every font, else the item itself. */
export const rowIds = (rows: Item[]): string[] => rows.flatMap((i) => i.familyIds ?? [i.id]);

/** How far a font is from "the" regular of its family: upright and near 400 first. */
function regularness(i: Item): number {
  return Math.abs((i.fontWeight ?? 400) - 400) + (/italic|oblique|イタリック/i.test(i.name) ? 1000 : 0);
}

/** A family's styles from thin to black, uprights before italics of the same weight. */
const byWeight = (a: Item, b: Item) =>
  (a.fontWeight ?? 400) - (b.fontWeight ?? 400) || regularness(a) - regularness(b);

/**
 * One row per font family, where the family's first font is in the (sorted)
 * list: its regular (the style nearest 400, upright), with `familyIds`
 * listing every font of the family. Fonts whose family isn't known yet, and
 * anything but fonts, stay rows of their own.
 */
function familyRows(items: Item[]): { rows: Item[]; members: Map<string, Item[]> } {
  const members = new Map<string, Item[]>();
  for (const i of items) {
    if (i.kind !== "font" || !i.fontFamily) continue;
    if (!members.has(i.fontFamily)) members.set(i.fontFamily, []);
    members.get(i.fontFamily)!.push(i);
  }
  const rows: Item[] = [];
  for (const i of items) {
    const family = i.kind === "font" && i.fontFamily ? members.get(i.fontFamily)! : null;
    if (!family) rows.push(i);
    else if (family[0] === i) {
      if (family.length === 1) rows.push(i);
      else {
        const rep = family.reduce((best, m) => (regularness(m) < regularness(best) ? m : best));
        rows.push({ ...rep, familyIds: [rep.id, ...family.filter((m) => m !== rep).map((m) => m.id)] });
      }
    }
  }
  return { rows, members };
}

/**
 * Children whose parent is in the list go under it: the rows are the rest, a
 * parent with `childIds`. A child whose parent isn't here (the parent was
 * left out of the view, say a trashed parent) stays a row of its own.
 */
function linkRows(items: Item[]): { rows: Item[]; children: Map<string, Item[]> } {
  const here = new Set(items.map((i) => i.id));
  const children = new Map<string, Item[]>();
  for (const i of items) {
    if (!i.parentId || !here.has(i.parentId)) continue;
    if (!children.has(i.parentId)) children.set(i.parentId, []);
    children.get(i.parentId)!.push(i);
  }
  const rows = items
    .filter((i) => !(i.parentId && here.has(i.parentId)))
    .map((i) => (children.has(i.id) ? { ...i, childIds: children.get(i.id)!.map((c) => c.id) } : i));
  return { rows, children };
}

function build(buckets: { items: Item[]; title: string; color?: string | null; rating?: number }[]): Grouped {
  const items: Item[] = [];
  const sections: Section[] = [];
  for (const b of buckets) {
    if (!b.items.length) continue;
    const start = items.length;
    items.push(...b.items);
    sections.push({ start, end: items.length, title: b.title, color: b.color, rating: b.rating });
  }
  return { items, sections };
}

/** Sections by the month (or year) an item was added, newest first; local time. */
function byDate(rows: Item[], by: "year" | "month") {
  const buckets = new Map<string, Item[]>();
  for (const i of rows) {
    const d = new Date(i.importedAt);
    const key = by === "year" ? `${d.getFullYear()}年` : `${d.getFullYear()}年${d.getMonth() + 1}月`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(i);
  }
  const newest = (list: Item[]) => Math.max(...list.map((i) => i.importedAt));
  return [...buckets]
    .sort((a, b) => newest(b[1]) - newest(a[1]))
    .map(([title, items]) => ({ items, title }));
}

/**
 * Regroups `items` (already sorted) by `by`. Inside a section the order is
 * kept. With tags an item appears under each of its tags (a family under
 * each tag any of its fonts has).
 */
export function groupItems(
  items: Item[],
  by: GroupBy,
  tags: Tag[],
  folders: Folder[],
  families: Families = null,
  links: Links = null,
): Grouped {
  if (!items.length) return { items, sections: [] };
  const { rows: foldedRows, members } = families ? familyRows(items) : { rows: items, members: new Map<string, Item[]>() };
  const { rows, children } = links ? linkRows(foldedRows) : { rows: foldedRows, children: new Map<string, Item[]>() };
  const byId = new Map(items.map((i) => [i.id, i]));
  // A family row's styles, and a parent's children, go right under it while it is open.
  const expand = (list: Item[]): Item[] =>
    families?.open.size || links?.open.size
      ? list.flatMap((r) =>
          r.familyIds && families?.open.has(r.fontFamily!)
            ? [r, ...[...members.get(r.fontFamily!)!].sort(byWeight).map((m) => ({ ...m, familyMember: true }))]
            : r.childIds && links?.open.has(r.id)
              ? [r, ...children.get(r.id)!.map((c) => ({ ...c, childMember: true }))]
              : [r],
        )
      : list;
  // A parent counts under the tags of its children too (it is in the list because of them).
  const tagsOf = (r: Item) =>
    r.familyIds
      ? new Set(r.familyIds.flatMap((id) => byId.get(id)?.tagIds ?? []))
      : new Set([...r.tagIds, ...(children.get(r.id) ?? []).flatMap((c) => c.tagIds)]);
  const grouped = (buckets: { items: Item[]; title: string; color?: string | null; rating?: number }[]) =>
    build(buckets.map((b) => ({ ...b, items: expand(b.items) })));

  switch (by) {
    case "none":
      return { items: expand(rows), sections: [] };
    case "kind":
      return grouped(KINDS.map((k) => ({ items: rows.filter((i) => i.kind === k.kind), title: k.label })));
    case "category":
      return grouped([
        ...FONT_CATEGORIES.map((c) => ({
          items: rows.filter((i) => i.kind === "font" && fontCategoryOf(i) === c.key),
          title: c.label,
        })),
        { items: rows.filter((i) => i.kind !== "font"), title: "フォント以外" },
      ]);
    case "script":
      return grouped([
        ...FONT_SCRIPTS.map((c) => ({
          // Not read yet: with the others.
          items: rows.filter((i) => i.kind === "font" && (i.fontScript ?? "other") === c.key),
          title: c.label,
        })),
        { items: rows.filter((i) => i.kind !== "font"), title: "フォント以外" },
      ]);
    case "rating":
      return grouped(
        [5, 4, 3, 2, 1, 0].map((n) => ({
          items: rows.filter((i) => i.rating === n),
          title: n ? `★${n}` : "未評価",
          rating: n,
        })),
      );
    case "tag": {
      const of = new Map(rows.map((r) => [r, tagsOf(r)]));
      return grouped([
        ...tags.map((t) => ({
          items: rows.filter((r) => of.get(r)!.has(t.id)),
          title: t.name,
          color: t.color,
        })),
        { items: rows.filter((r) => of.get(r)!.size === 0), title: "タグなし" },
      ]);
    }
    case "year":
    case "month":
      return grouped(byDate(rows, by));
    case "folder":
      return grouped([
        ...folderPaths(folders).map(({ folder, path }) => ({
          items: rows.filter((i) => i.folderId === folder.id),
          title: path,
          color: folder.color,
        })),
        { items: rows.filter((i) => i.folderId === null), title: "未分類" },
      ]);
  }
}

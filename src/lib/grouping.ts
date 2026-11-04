// Splits the list into sections (rating bands, tags, folders, months) for
// the grid, and folds children under their parent (links on).
// The result is a flattened display list plus the [start, end) of each
// section, so layouts and navigation keep working on plain indices.
import type { Folder, Item, Tag } from "./api";

export type GroupBy = "none" | "rating" | "tag" | "folder" | "month";

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
 * How children are folded under their parent (links on; docs/LINKS.md):
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

/** Sections by the year and month an item was added, newest first; local time. */
function byDate(rows: Item[]) {
  const buckets = new Map<string, Item[]>();
  for (const i of rows) {
    const d = new Date(i.importedAt);
    const key = `${d.getFullYear()}年${d.getMonth() + 1}月`;
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
 * kept. With tags an item appears under each of its tags.
 */
export function groupItems(
  items: Item[],
  by: GroupBy,
  tags: Tag[],
  folders: Folder[],
  links: Links = null,
): Grouped {
  if (!items.length) return { items, sections: [] };
  const { rows, children } = links ? linkRows(items) : { rows: items, children: new Map<string, Item[]>() };
  // A parent's children go right under it while it is open.
  const expand = (list: Item[]): Item[] =>
    links?.open.size
      ? list.flatMap((r) =>
          r.childIds && links.open.has(r.id) ? [r, ...children.get(r.id)!.map((c) => ({ ...c, childMember: true }))] : [r],
        )
      : list;
  // A parent counts under the tags of its children too (it is in the list because of them).
  const tagsOf = (r: Item) => new Set([...r.tagIds, ...(children.get(r.id) ?? []).flatMap((c) => c.tagIds)]);
  const grouped = (buckets: { items: Item[]; title: string; color?: string | null; rating?: number }[]) =>
    build(buckets.map((b) => ({ ...b, items: expand(b.items) })));

  switch (by) {
    case "none":
      return { items: expand(rows), sections: [] };
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
    case "month":
      return grouped(byDate(rows));
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

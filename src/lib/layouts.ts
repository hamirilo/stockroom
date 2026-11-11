// Layout math for the image list. Every layout turns the items into absolute
// boxes (content coordinates) so the grid can virtualize, hit-test and
// navigate them the same way.
import type { Item } from "./api";
import type { Section } from "./grouping";
import type { Layout, ShowInfo } from "../store";

export const PAD = 16;
export const GAP = 12;
/** Band above each section (similar-view group, rating, tag, folder). */
export const HEADER = 40;
/** List layout row height. */
export const LIST_ROW = 48;

/** Aspect ratios outside this range are letterboxed instead of making absurd cells. */
const MIN_AR = 0.4;
const MAX_AR = 3;

/** 画像・動画は自分の寸法、ファイル・ブックマークなどはサムネイル自体の比率（無ければ正方形）。 */
export const rawAspect = (item: Item) =>
  item.width > 0 && item.height > 0 ? item.width / item.height : item.thumbAspect && item.thumbAspect > 0 ? item.thumbAspect : 1;
export const clampedAspect = (item: Item) => Math.min(MAX_AR, Math.max(MIN_AR, rawAspect(item)));

/** Thumbnail box; the label (if any) sits below it. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Placement {
  boxes: Box[];
  /** Section header bands, `y` = top of the band, `start` = first item. */
  headers: { y: number; start: number }[];
  /** Total content height. */
  height: number;
  /** Height of the text under each thumbnail (0 in the list layout). */
  label: number;
  /** How thumbnails fill their box. */
  fit: "cover" | "contain";
}

/** Text lines under thumbnails: name, then one line for size / rating / type. */
export function labelHeight(info: ShowInfo): number {
  const lines = (info.name ? 1 : 0) + (info.dims || info.rating || info.meta ? 1 : 0);
  return lines === 0 ? 0 : 6 + lines * 15;
}

/** [start, end) of each section, or one segment when the list isn't sectioned. */
function segments(items: Item[], sections: Section[]): [number, number][] {
  if (sections.length) return sections.map((s) => [s.start, s.end]);
  return items.length ? [[0, items.length]] : [];
}

/** Column count / width for a target cell size. */
function columns(inner: number, target: number) {
  const cols = Math.max(1, Math.floor((inner + GAP) / (target + GAP)));
  const w = Math.floor((inner - GAP * (cols - 1)) / cols);
  return { cols, w };
}

export function computeLayout(
  kind: Layout,
  items: Item[],
  inner: number,
  target: number,
  info: ShowInfo,
  sections: Section[] = [],
): Placement {
  const label = kind === "list" ? 0 : labelHeight(info);
  const boxes: Box[] = new Array(items.length);
  const headers: { y: number; start: number }[] = [];
  const grouped = sections.length > 0;
  let y = PAD;

  for (const [start, end] of segments(items, sections)) {
    if (grouped) {
      headers.push({ y, start });
      y += HEADER;
    }
    if (kind === "justified") y = justify(items, start, end, inner, target, label, y, boxes);
    else if (kind === "grid") y = grid(start, end, inner, target, label, y, boxes);
    else if (kind === "waterfall") y = waterfall(items, start, end, inner, target, label, y, boxes);
    else y = list(start, end, inner, y, boxes);
  }
  return {
    boxes,
    headers,
    height: y + PAD,
    label,
    fit: kind === "grid" ? "contain" : "cover",
  };
}

/**
 * Justified: each row is filled edge to edge with cells in the images' own
 * aspect ratios. `target` (the slider) is the row height rows stay close to;
 * the last row keeps it instead of stretching.
 */
function justify(
  items: Item[],
  from: number,
  end: number,
  inner: number,
  target: number,
  label: number,
  top: number,
  boxes: Box[],
): number {
  let i = from;
  while (i < end) {
    let sum = 0;
    let j = i;
    while (j < end) {
      sum += clampedAspect(items[j++]);
      if (sum * target + GAP * (j - i - 1) >= inner) break;
    }
    const fill = (n: number, s: number) => (inner - GAP * (n - 1)) / s;
    let full = sum * target + GAP * (j - i - 1) >= inner;
    let height = full ? fill(j - i, sum) : target;
    // Ending the row one image earlier may land closer to the target height.
    if (full && j - i > 1) {
      const without = sum - clampedAspect(items[j - 1]);
      const h = fill(j - i - 1, without);
      if (h / target < target / height) {
        j--;
        sum = without;
        height = h;
      }
    }
    // A lone image too wide for the view shrinks; otherwise never stretch past 2×.
    height = Math.min(height, target * 2);
    full = full && height < target * 2;
    // Snap edges to whole pixels so full rows end exactly at the right margin.
    const scale = full ? (inner - GAP * (j - i - 1)) / sum : height;
    const h = Math.round(height);
    let acc = 0;
    for (let k = i; k < j; k++) {
      const x0 = Math.round(acc);
      acc += clampedAspect(items[k]) * scale;
      boxes[k] = { x: PAD + x0 + GAP * (k - i), y: top, w: Math.max(1, Math.round(acc) - x0), h };
    }
    top += h + label + GAP;
    i = j;
  }
  return top;
}

/** Grid: equal square cells; images are letterboxed inside. */
function grid(from: number, end: number, inner: number, target: number, label: number, top: number, boxes: Box[]) {
  const { cols, w } = columns(inner, target);
  for (let k = from; k < end; k++) {
    const r = Math.floor((k - from) / cols);
    const c = (k - from) % cols;
    boxes[k] = { x: PAD + c * (w + GAP), y: top + r * (w + label + GAP), w, h: w };
  }
  const rows = Math.ceil((end - from) / cols);
  return top + rows * (w + label + GAP);
}

/** Waterfall: equal-width columns, each image goes to the shortest column. */
function waterfall(
  items: Item[],
  from: number,
  end: number,
  inner: number,
  target: number,
  label: number,
  top: number,
  boxes: Box[],
) {
  const { cols, w } = columns(inner, target);
  const heights = new Array(cols).fill(top);
  for (let k = from; k < end; k++) {
    let c = 0;
    for (let n = 1; n < cols; n++) if (heights[n] < heights[c] - 1) c = n;
    const h = Math.round(w / clampedAspect(items[k]));
    boxes[k] = { x: PAD + c * (w + GAP), y: heights[c], w, h };
    heights[c] += h + label + GAP;
  }
  return Math.max(...heights);
}

/** List: one full-width row per item. */
function list(from: number, end: number, inner: number, top: number, boxes: Box[]) {
  for (let k = from; k < end; k++) {
    boxes[k] = { x: PAD, y: top, w: inner, h: LIST_ROW };
    top += LIST_ROW;
  }
  return top + GAP;
}

/** Item indices whose box (plus label) intersects [top, bottom]. */
export function visibleRange(p: Placement, top: number, bottom: number): number[] {
  const out: number[] = [];
  p.boxes.forEach((b, i) => {
    if (b.y <= bottom && b.y + b.h + p.label >= top) out.push(i);
  });
  return out;
}

/**
 * Keyboard navigation target from `cur`: ←/→ step through the order, ↑/↓
 * pick the nearest box above / below (by centre), so it works for every layout.
 */
export function neighbour(p: Placement, cur: number, dir: "up" | "down"): number {
  const a = p.boxes[cur];
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  let best = -1;
  let bestScore = Infinity;
  p.boxes.forEach((b, i) => {
    if (i === cur) return;
    const by = b.y + b.h / 2;
    const below = by > ay + 1 && b.y >= a.y + a.h / 2;
    const above = by < ay - 1 && b.y + b.h <= a.y + a.h / 2;
    if ((dir === "down" && !below) || (dir === "up" && !above)) return;
    // Prefer the closest row, then the closest column.
    const score = Math.abs(by - ay) * 4 + Math.abs(b.x + b.w / 2 - ax);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best < 0 ? cur : best;
}

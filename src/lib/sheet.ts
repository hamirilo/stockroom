// Contact sheet (まとめて出力): several images on one picture or one HTML
// page, numbered, to send round and ask "which one?" without attaching
// every file. The layout is computed here and shared by the dialog's preview
// (DOM) and the output (canvas / HTML), so the preview matches the result.
import { api, formatBytes, sizeLabel, type Item } from "./api";

export type SheetFormat = "png" | "jpeg" | "html";
export type SheetLabel = "number" | "letter" | "none";
export type SheetTheme = "light" | "dark";

export interface SheetOptions {
  format: SheetFormat;
  title: string;
  /** 0 = chosen from the number of images and their shape. */
  columns: number;
  /** Width of the picture in px (PNG / JPEG). */
  width: number;
  /** Longer side of each image in the HTML page (also its enlarged view). */
  htmlImage: number;
  label: SheetLabel;
  showName: boolean;
  /** Pixel size, type and file size under each image. */
  showInfo: boolean;
  theme: SheetTheme;
}

export const SHEET_DEFAULTS: SheetOptions = {
  format: "png",
  title: "",
  columns: 0,
  width: 2400,
  htmlImage: 1200,
  label: "number",
  showName: true,
  showInfo: true,
  theme: "light",
};

export const SHEET_WIDTHS = [1200, 1800, 2400, 3600];
export const SHEET_HTML_IMAGES = [
  { px: 1200, label: "標準（長辺 1200px）" },
  { px: 2000, label: "高画質（長辺 2000px）" },
];
export const MAX_COLUMNS = 8;

/** Same stack as the app (index.css), so the preview and the picture match. */
export const SHEET_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif';

export const SHEET_COLORS = {
  light: { bg: "#ffffff", cell: "#f1f2f4", fg: "#1d1d1f", dim: "#6b6e76" },
  dark: { bg: "#18191c", cell: "#2a2b30", fg: "#ececef", dim: "#9a9ba3" },
} as const;

/** "A" … "Z", "AA", "AB" … for the n-th image (0-based). */
function letters(n: number): string {
  let s = "";
  for (let k = n + 1; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
}

export function labelOf(n: number, label: SheetLabel): string {
  return label === "number" ? String(n + 1) : label === "letter" ? letters(n) : "";
}

/** "1672 × 941 PNG · 1.8 MB" */
export function infoOf(item: Item): string {
  return `${sizeLabel(item)} ${item.ext.toUpperCase()} · ${formatBytes(item.size)}`;
}

/** Items without a pixel size are shown 4:3. */
const aspectOf = (i: Item) => (!i.width || !i.height ? 4 / 3 : i.width / i.height);

/** One shape for every cell: the images' own if they share one, else the middle one. */
function cellAspect(items: Item[]): number {
  const a = items.map(aspectOf).sort((x, y) => x - y);
  if (!a.length) return 4 / 3;
  if (a[a.length - 1] / a[0] < 1.02) return a[0];
  return Math.min(2, Math.max(0.6, a[Math.floor(a.length / 2)]));
}

/** Columns that make a sheet about 16:10 without leaving a mostly empty last row. */
export function autoColumns(n: number, aspect: number, captioned: boolean): number {
  if (n <= 1) return 1;
  const cellH = 1 / aspect + (captioned ? 0.13 : 0);
  let best = 1;
  let score = Infinity;
  for (let c = 1; c <= Math.min(n, MAX_COLUMNS); c++) {
    const rows = Math.ceil(n / c);
    const ratio = c / (rows * cellH);
    const empty = rows * c - n;
    const s = Math.abs(Math.log(ratio / 1.6)) + (0.5 * empty) / c;
    if (s < score) [best, score] = [c, s];
  }
  return best;
}

export interface SheetCell {
  item: Item;
  label: string;
  /** The cell (image area). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The image inside it, whole (letterboxed when its shape differs). */
  img: { x: number; y: number; w: number; h: number };
  /** Baselines of the caption lines. */
  nameY: number;
  infoY: number;
}

export interface SheetLayout {
  width: number;
  height: number;
  columns: number;
  aspect: number;
  pad: number;
  radius: number;
  title: { text: string; size: number; y: number } | null;
  nameSize: number;
  infoSize: number;
  badge: number;
  cells: SheetCell[];
}

export function layoutSheet(items: Item[], opt: SheetOptions, width = opt.width): SheetLayout {
  const W = Math.round(width);
  const aspect = cellAspect(items);
  const captioned = opt.showName || opt.showInfo;
  const columns = Math.min(
    Math.max(1, items.length),
    opt.columns || autoColumns(items.length, aspect, captioned),
  );
  const pad = Math.round(W * 0.03);
  const gap = Math.round(W * 0.016);
  const cw = (W - pad * 2 - gap * (columns - 1)) / columns;
  const ch = cw / aspect;
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)));
  const nameSize = clamp(cw * 0.05, W * 0.008, W * 0.014);
  const infoSize = Math.round(nameSize * 0.85);
  const badge = clamp(cw * 0.085, W * 0.012, W * 0.03);

  const capTop = Math.round(nameSize * 0.55);
  const nameLine = opt.showName ? Math.round(nameSize * 1.35) : 0;
  const infoLine = opt.showInfo ? Math.round(infoSize * 1.4) : 0;
  const capH = captioned ? capTop + nameLine + infoLine : 0;

  const titleSize = clamp(W * 0.02, 18, 96);
  const title = opt.title.trim()
    ? { text: opt.title.trim(), size: titleSize, y: pad + Math.round(titleSize * 0.95) }
    : null;
  const top = pad + (title ? Math.round(titleSize * 1.3 + pad * 0.6) : 0);

  const rows = Math.ceil(items.length / columns);
  const cells = items.map((item, n) => {
    const col = n % columns;
    const row = Math.floor(n / columns);
    const x = pad + col * (cw + gap);
    const y = top + row * (ch + capH + gap);
    const a = aspectOf(item);
    const [iw, ih] = a > aspect ? [cw, cw / a] : [ch * a, ch];
    return {
      item,
      label: labelOf(n, opt.label),
      x,
      y,
      w: cw,
      h: ch,
      img: { x: x + (cw - iw) / 2, y: y + (ch - ih) / 2, w: iw, h: ih },
      nameY: y + ch + capTop + Math.round(nameSize * 1.0),
      infoY: y + ch + capTop + nameLine + Math.round(infoSize * 1.05),
    };
  });
  const height = Math.round(top + rows * (ch + capH) + Math.max(0, rows - 1) * gap + pad);
  return {
    width: W,
    height,
    columns,
    aspect,
    pad,
    radius: Math.max(4, Math.round(W * 0.004)),
    title,
    nameSize,
    infoSize,
    badge,
    cells,
  };
}

/** WebKit can't make canvases much bigger than this. */
const MAX_PIXELS = 100_000_000;
const MAX_SIDE = 32_000;

export function tooLarge(l: SheetLayout): boolean {
  return l.width * l.height > MAX_PIXELS || l.height > MAX_SIDE;
}

/** Fetches every image (a few at a time), calling `use` as each arrives. */
async function eachImage(
  cells: SheetCell[],
  side: (c: SheetCell) => number,
  use: (c: SheetCell, data: ArrayBuffer) => Promise<void> | void,
  onProgress: (done: number) => void,
) {
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < cells.length) {
      const c = cells[next++];
      await use(c, await api.sheetImage(c.item.id, Math.ceil(side(c))));
      onProgress(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, cells.length) }, worker));
}

/** `text` cut to `max` px with "…". */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + "…").width <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

/** Badge size for a label: a circle, or a pill for longer labels. */
export function badgeBox(l: SheetLayout, label: string) {
  const h = l.badge;
  const font = Math.round(h * 0.56);
  const w = Math.max(h, Math.round(label.length * font * 0.62 + h * 0.5));
  const inset = Math.round(h * 0.3);
  return { w, h, font, inset };
}

/** Draws the sheet as a PNG / JPEG picture. */
export async function renderSheet(
  items: Item[],
  opt: SheetOptions,
  onProgress: (done: number) => void,
): Promise<Blob> {
  const l = layoutSheet(items, opt);
  if (tooLarge(l)) throw new Error("画像が大きすぎます。列を増やすか、幅を小さくしてください");
  const colors = SHEET_COLORS[opt.theme];
  const canvas = document.createElement("canvas");
  canvas.width = l.width;
  canvas.height = l.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像を作れませんでした");
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, l.width, l.height);
  ctx.textBaseline = "alphabetic";

  if (l.title) {
    ctx.fillStyle = colors.fg;
    ctx.font = `700 ${l.title.size}px ${SHEET_FONT}`;
    ctx.fillText(ellipsize(ctx, l.title.text, l.width - l.pad * 2), l.pad, l.title.y);
  }

  for (const c of l.cells) {
    ctx.fillStyle = colors.cell;
    ctx.beginPath();
    ctx.roundRect(c.x, c.y, c.w, c.h, l.radius);
    ctx.fill();
    ctx.fillStyle = colors.fg;
    if (opt.showName) {
      ctx.font = `600 ${l.nameSize}px ${SHEET_FONT}`;
      ctx.fillText(ellipsize(ctx, c.item.name, c.w), c.x, c.nameY);
    }
    if (opt.showInfo) {
      ctx.fillStyle = colors.dim;
      ctx.font = `400 ${l.infoSize}px ${SHEET_FONT}`;
      ctx.fillText(ellipsize(ctx, infoOf(c.item), c.w), c.x, c.infoY);
    }
  }

  await eachImage(
    l.cells,
    (c) => Math.max(c.img.w, c.img.h),
    async (c, data) => {
      const bmp = await createImageBitmap(new Blob([data]));
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(c.x, c.y, c.w, c.h, l.radius);
      ctx.clip();
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bmp, c.img.x, c.img.y, c.img.w, c.img.h);
      ctx.restore();
      bmp.close();
      if (c.label) {
        const b = badgeBox(l, c.label);
        ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
        ctx.beginPath();
        ctx.roundRect(c.x + b.inset, c.y + b.inset, b.w, b.h, b.h / 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = `700 ${b.font}px ${SHEET_FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(c.label, c.x + b.inset + b.w / 2, c.y + b.inset + b.h / 2 + b.font * 0.04);
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
      }
    },
    onProgress,
  );

  const type = opt.format === "jpeg" ? "image/jpeg" : "image/png";
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("画像を作れませんでした"))), type, 0.9),
  );
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function base64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * One HTML file with the images inside (nothing else to send along). The
 * grid follows the window width; clicking an image enlarges it (← → to page).
 */
export async function buildHtml(
  items: Item[],
  opt: SheetOptions,
  onProgress: (done: number) => void,
): Promise<string> {
  const l = layoutSheet(items, opt, 1600);
  const colors = SHEET_COLORS[opt.theme];
  const srcs = new Map<string, string>();
  await eachImage(
    l.cells,
    () => opt.htmlImage,
    (c, data) => {
      const png = new Uint8Array(data, 0, 4).every((b, i) => b === [0x89, 0x50, 0x4e, 0x47][i]);
      srcs.set(c.item.id, `data:image/${png ? "png" : "jpeg"};base64,${base64(data)}`);
    },
    onProgress,
  );
  const title = opt.title.trim();
  const figures = l.cells
    .map((c, n) => {
      const name = escapeHtml(c.item.name);
      const caption = [
        opt.showName ? `<b>${name}</b>` : "",
        opt.showInfo ? `<span>${escapeHtml(infoOf(c.item))}</span>` : "",
      ].join("");
      const no = c.label ? `<span class="no">${escapeHtml(c.label)}</span>` : "";
      return `<figure id="i${n + 1}"><a class="box" href="#i${n + 1}" title="${name}"><img src="${srcs.get(c.item.id)}" alt="${name}">${no}</a>${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title || `画像 ${items.length} 枚`)}</title>
<style>
:root { --bg: ${colors.bg}; --cell: ${colors.cell}; --fg: ${colors.fg}; --dim: ${colors.dim}; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font-family: ${SHEET_FONT}; }
main { max-width: 1800px; margin: 0 auto; padding: 32px; }
h1 { margin: 0 0 24px; font-size: 26px; }
.grid { display: grid; grid-template-columns: repeat(${l.columns}, minmax(0, 1fr)); gap: 20px; }
@media (max-width: 900px) { .grid { grid-template-columns: repeat(${Math.min(l.columns, 2)}, minmax(0, 1fr)); } main { padding: 20px; } }
@media (max-width: 560px) { .grid { grid-template-columns: minmax(0, 1fr); } }
figure { margin: 0; }
.box { position: relative; display: block; aspect-ratio: ${l.aspect.toFixed(4)}; background: var(--cell); border-radius: 8px; overflow: hidden; cursor: zoom-in; }
.box img { display: block; width: 100%; height: 100%; object-fit: contain; }
.no { position: absolute; top: 10px; left: 10px; min-width: 32px; height: 32px; padding: 0 10px; border-radius: 16px; background: rgba(0, 0, 0, .72); color: #fff; font-size: 17px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
figcaption { margin-top: 8px; line-height: 1.4; }
figcaption b { display: block; overflow: hidden; font-size: 14px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
figcaption span { color: var(--dim); font-size: 12px; }
footer { margin-top: 28px; color: var(--dim); font-size: 12px; }
#view { position: fixed; inset: 0; z-index: 10; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 12px; background: rgba(0, 0, 0, .9); cursor: zoom-out; }
#view.on { display: flex; }
#view img { max-width: 94vw; max-height: 86vh; object-fit: contain; }
#view p { margin: 0; color: #fff; font-size: 15px; }
</style>
</head>
<body>
<main>
${title ? `<h1>${escapeHtml(title)}</h1>\n` : ""}<div class="grid">
${figures}
</div>
<footer>${items.length} 枚</footer>
</main>
<div id="view"><img alt=""><p></p></div>
<script>
const boxes = [...document.querySelectorAll(".box")];
const view = document.getElementById("view");
let cur = -1;
function show(i) {
  cur = (i + boxes.length) % boxes.length;
  const b = boxes[cur];
  view.querySelector("img").src = b.querySelector("img").src;
  const no = b.querySelector(".no");
  view.querySelector("p").textContent = (no ? no.textContent + "  " : "") + b.title;
  view.classList.add("on");
}
boxes.forEach((b, i) => b.addEventListener("click", (e) => { e.preventDefault(); show(i); }));
view.addEventListener("click", () => { view.classList.remove("on"); cur = -1; });
addEventListener("keydown", (e) => {
  if (cur < 0) return;
  if (e.key === "Escape") view.click();
  else if (e.key === "ArrowRight") show(cur + 1);
  else if (e.key === "ArrowLeft") show(cur - 1);
});
</script>
</body>
</html>
`;
}

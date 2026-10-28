// The comparison of the stock shelf's images, shown in place of the list:
// the images side by side in frames of one size, all of them in view. Zooming
// or moving one moves them all, at the same place of each image, so the same
// part can be looked at in each. docs/COMPARE.md.
import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowLeft, Heart, Minus, Plus, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { removeFromShelf, setRating } from "../lib/actions";
import { api, formatBytes, orientTransform, sizeLabel, type Item } from "../lib/api";
import { runKey } from "../lib/commands";
import { composing } from "../lib/ime";
import { COMPARE_ZOOM as ZOOM, type CompareLook as Look, useStore, WHOLE_LOOK as WHOLE, zoomLook } from "../store";
import { RatingStars } from "./RatingStars";

/** At most this many are put side by side (the first ones of the shelf). */
export const IMAGE_COMPARE_MAX = 12;
const GAP = 8;
/** The line under each image: name, size, rating. */
const CAPTION = 52;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Remembered between sessions like the font comparison's background (localStorage, best effort).
const loadLight = () => {
  try {
    return localStorage.getItem("compareImagesLight") === "true";
  } catch {
    return false;
  }
};
const persistLight = (v: boolean) => {
  try {
    localStorage.setItem("compareImagesLight", String(v));
  } catch {
    /* ignore */
  }
};

/**
 * The column count that shows the images largest: every count is tried and
 * the one whose frames hold the most image area wins.
 */
function columnsFor(items: Item[], w: number, h: number): number {
  let best = 1;
  let bestArea = -1;
  for (let cols = 1; cols <= items.length; cols++) {
    const rows = Math.ceil(items.length / cols);
    const cw = (w - GAP * (cols - 1)) / cols;
    const ch = (h - GAP * (rows - 1)) / rows - CAPTION;
    if (cw <= 0 || ch <= 0) continue;
    const area = items.reduce((sum, i) => {
      const s = Math.min(cw / i.width, ch / i.height);
      return sum + i.width * s * i.height * s;
    }, 0);
    if (area > bestArea) {
      bestArea = area;
      best = cols;
    }
  }
  return best;
}

/** Where an image sits in a frame of w × h for a look: its drawn size and top-left, the centre kept inside. */
function place(item: Item, w: number, h: number, look: Look) {
  const s = Math.min(w / item.width, h / item.height) * look.k;
  const dw = item.width * s;
  const dh = item.height * s;
  // When larger than the frame the image covers it; when smaller it stays centred.
  const cx = dw > w ? clamp(look.cx, w / 2 / dw, 1 - w / 2 / dw) : 0.5;
  const cy = dh > h ? clamp(look.cy, h / 2 / dh, 1 - h / 2 / dh) : 0.5;
  return { dw, dh, cx, cy, left: w / 2 - cx * dw, top: h / 2 - cy * dh };
}

export function ImageCompare() {
  const shelf = useStore((s) => s.shelf);
  const setComparing = useStore((s) => s.setComparing);
  const images = useMemo(() => shelf.filter((i) => i.kind === "image"), [shelf]);
  const shown = images.slice(0, IMAGE_COMPARE_MAX);
  const others = shelf.length - images.length;
  const [light, setLight] = useState(loadLight);
  // Kept in the store so the menu's 拡大 / 縮小 (⌘+ / ⌘-) zoom the images (commands.ts).
  const look = useStore((s) => s.compareLook);
  const setLook = useStore((s) => s.setCompareLook);
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [shown.length > 0]);

  const zoomBy = (f: number) => setLook((l) => zoomLook(l, f));

  // Esc goes back to the list (unless a menu or dialog is over it); ⌘0 shows the
  // whole images like the viewer. ⌘+ / ⌘- are the menu's 拡大 / 縮小 (the list's
  // key handler is not here to take them, so they are run like it does).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (composing(e) || (e.target as Element).closest?.("input, textarea, select")) return;
      if (document.querySelector("[data-modal]")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") setComparing(false);
      else if (mod && e.key === "0") {
        e.preventDefault();
        setLook(WHOLE);
      } else if (mod && (e.key === "=" || e.key === "+" || e.key === ";" || e.key === "-")) runKey(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setComparing, setLook]);

  const cols = shown.length ? columnsFor(shown, box.w, box.h) : 1;
  const rows = Math.ceil(shown.length / cols) || 1;
  const frame = {
    w: Math.max(0, (box.w - GAP * (cols - 1)) / cols),
    h: Math.max(0, (box.h - GAP * (rows - 1)) / rows - CAPTION),
  };
  const step = "flex h-6 w-5 shrink-0 items-center justify-center rounded text-dim hover:bg-white/8 hover:text-fg";
  const note =
    images.length > IMAGE_COMPARE_MAX
      ? `シェルフの先頭の ${IMAGE_COMPARE_MAX} 件を並べています`
      : others > 0
        ? `画像以外の ${others} 件は並べません`
        : "Option / Ctrl ＋ホイール・クリックで拡大。どれかを動かすと、すべて同じ場所へ動きます";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2 text-xs">
        <button
          onClick={() => setComparing(false)}
          title="一覧へ戻る（Esc）"
          className="-ml-1 flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-white/5"
        >
          <ArrowLeft size={14} /> 一覧へ戻る
        </button>
        <span className="text-[13px] font-semibold">
          比較 <span className="font-normal text-dim tabular-nums">{shown.length} 件</span>
        </span>
        <span className="min-w-0 flex-1 truncate text-dim">{note}</span>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-dim">背景</span>
          <div role="group" aria-label="背景" className="flex h-6 overflow-hidden rounded-md border border-edge bg-control">
            {[
              { on: !light, label: "暗", value: false },
              { on: light, label: "明", value: true },
            ].map((b, i) => (
              <button
                key={b.label}
                aria-pressed={b.on}
                onClick={() => {
                  setLight(b.value);
                  persistLight(b.value);
                }}
                className={`px-2 ${i > 0 ? "border-l border-line" : ""} ${b.on ? "bg-chosen text-fg" : "text-fg/85 hover:bg-white/12"}`}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          <span className="mr-1 text-dim">拡大</span>
          <button title="縮小（⌘-）" disabled={look.k <= ZOOM.min} onClick={() => zoomBy(1 / ZOOM.step)} className={step}>
            <Minus size={13} />
          </button>
          <span className="w-12 text-center tabular-nums" title="全体を枠に収めたときに対する倍率">
            ×{look.k < 10 ? look.k.toFixed(1) : Math.round(look.k)}
          </span>
          <button title="拡大（⌘+）" disabled={look.k >= ZOOM.max} onClick={() => zoomBy(ZOOM.step)} className={step}>
            <Plus size={13} />
          </button>
          <button
            title="全体を表示（⌘0）"
            disabled={look.k === 1}
            onClick={() => setLook(WHOLE)}
            className="ml-1 h-6 rounded-md border border-edge bg-control px-2 text-dim enabled:hover:bg-white/12 enabled:hover:text-fg disabled:off disabled:bg-transparent"
          >
            全体
          </button>
        </div>
      </div>
      <div className={`min-h-0 flex-1 p-3 ${light ? "bg-white text-neutral-900" : ""}`}>
        {shown.length === 0 ? (
          <p className={`mx-auto mt-24 max-w-md text-center text-sm leading-relaxed ${light ? "text-neutral-500" : "text-dim"}`}>
            比べる画像がありません。一覧で画像を選んで B キー、またはシェルフへドラッグしてください
          </p>
        ) : (
          <div
            ref={boxRef}
            className="grid h-full content-center"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: GAP }}
          >
            {shown.map((item) => (
              <Frame key={item.id} item={item} w={frame.w} h={frame.h} look={look} setLook={setLook} light={light} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One image in its frame and its caption. The wheel with Option / Ctrl (and
 * a trackpad pinch) zooms around the pointer, a plain wheel or a drag moves,
 * a click zooms in on the point (or back to the whole) — for every frame.
 */
function Frame({
  item,
  w,
  h,
  look,
  setLook,
  light,
}: {
  item: Item;
  w: number;
  h: number;
  look: Look;
  setLook: (look: Look | ((l: Look) => Look)) => void;
  light: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const p = place(item, w, h, look);
  const sideways = item.rotation % 2 === 1;

  /** The look that keeps the image's point under (x, y) of the frame in place at zoom k. */
  const zoomAt = (l: Look, k: number, x: number, y: number): Look => {
    k = clamp(k, ZOOM.min, ZOOM.max);
    if (k === 1) return WHOLE;
    const at = place(item, w, h, l);
    const px = at.cx + (x - w / 2) / at.dw;
    const py = at.cy + (y - h / 2) / at.dh;
    const next = place(item, w, h, { k, cx: 0.5, cy: 0.5 });
    return { k, cx: clamp(px - (x - w / 2) / next.dw, 0, 1), cy: clamp(py - (y - h / 2) / next.dh, 0, 1) };
  };
  const moveBy = (l: Look, dx: number, dy: number): Look => {
    const at = place(item, w, h, l);
    return { ...l, cx: clamp(at.cx - dx / at.dw, 0, 1), cy: clamp(at.cy - dy / at.dh, 0, 1) };
  };

  // A wheel listener of its own: React's is passive, and the page must not zoom or scroll.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.altKey) {
        const f = Math.exp(-e.deltaY * 0.0025);
        setLook((l) => zoomAt(l, l.k * f, e.clientX - r.left, e.clientY - r.top));
      } else {
        setLook((l) => (l.k === 1 ? l : moveBy(l, -e.deltaX, -e.deltaY)));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    moved.current = false;
    let x0 = e.clientX;
    let y0 = e.clientY;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!moved.current && Math.hypot(dx, dy) < 4) return;
      moved.current = true;
      x0 = ev.clientX;
      y0 = ev.clientY;
      setLook((l) => (l.k === 1 ? l : moveBy(l, dx, dy)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const dim = light ? "text-neutral-500" : "text-dim";
  return (
    <div className="flex min-w-0 flex-col">
      <div
        ref={ref}
        onPointerDown={onPointerDown}
        onClick={(e) => {
          if (moved.current) return;
          const r = e.currentTarget.getBoundingClientRect();
          setLook((l) => (l.k === 1 ? zoomAt(l, 4, e.clientX - r.left, e.clientY - r.top) : WHOLE));
        }}
        style={{ height: h }}
        className={`relative overflow-hidden rounded-md ${light ? "bg-neutral-100" : "bg-black/30"} ${
          look.k === 1 ? "cursor-zoom-in" : "cursor-grab active:cursor-grabbing"
        }`}
      >
        {/* The box has the displayed (turned) size; the original file inside is rotated to fill it. */}
        <div className="absolute" style={{ left: p.left, top: p.top, width: p.dw, height: p.dh }}>
          <img
            src={convertFileSrc(item.displayPath)}
            alt={item.name}
            draggable={false}
            style={{
              width: sideways ? p.dh : p.dw,
              height: sideways ? p.dw : p.dh,
              transform: `translate(-50%, -50%) ${orientTransform(item)}`,
            }}
            className="absolute top-1/2 left-1/2 max-w-none"
          />
        </div>
      </div>
      <div className="flex shrink-0 flex-col justify-center gap-0.5 px-0.5 text-xs" style={{ height: CAPTION }}>
        <div className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate font-medium" title={item.name}>
            {item.name}
          </span>
          <button
            title={item.favorite ? "お気に入りから外す" : "お気に入りに追加"}
            onClick={() => useStore.getState().run(() => api.setFavorite([item.id], !item.favorite))}
            className={`shrink-0 rounded p-0.5 hover:bg-black/10 ${item.favorite ? "text-pink-400" : dim}`}
          >
            <Heart size={12} fill={item.favorite ? "currentColor" : "none"} />
          </button>
          <button
            title="比較とシェルフから外す"
            onClick={() => removeFromShelf([item.id])}
            className={`shrink-0 rounded p-0.5 ${dim} hover:bg-black/10 hover:text-current`}
          >
            <X size={13} />
          </button>
        </div>
        <div className={`flex min-w-0 items-center gap-2 ${dim}`}>
          <RatingStars value={item.rating} onChange={(n) => setRating([item.id], n)} size={12} />
          <span className="min-w-0 truncate tabular-nums" title={`${sizeLabel(item)} · ${item.ext.toUpperCase()} · ${formatBytes(item.size)}`}>
            {sizeLabel(item)} · {item.ext.toUpperCase()} · {formatBytes(item.size)}
          </span>
        </div>
      </div>
    </div>
  );
}

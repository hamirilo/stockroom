import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Focus,
  Folder as FolderIcon,
  GalleryHorizontal,
  Info,
  Maximize,
  Minus,
  Plus,
  X,
} from "lucide-react";
import { RotateLeft, RotateRight } from "../lib/icons";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { openSelection, orient, setRating, toggleFavorite, togglePinned, toggleTray } from "../lib/actions";
import { formatBytes, isSystemId, sizeLabel, orientTransform, type Item } from "../lib/api";
import { colorHex } from "../lib/colors";
import { folderPaths } from "../lib/grouping";
import { dragRegion } from "../lib/titleBar";
import { useStore } from "../store";
import { FontView } from "../features/fonts/FontView";
import { FontMark } from "../features/fonts/ShelfChip";
import { FileView } from "../features/files/FileView";
import { VideoView } from "../features/videos/VideoView";
import { TextView } from "../features/texts/TextView";
import { FlagButtons } from "./Inspector";
import { RatingStars } from "./RatingStars";

const MIN = 0.05;
const MAX = 16;
const STEP = 1.25;

/** How long the image-only view's "H to show" note stays. */
const HINT_MS = 2200;

/** How long the image-only view's restore button stays after the pointer stops. */
const PEEK_MS = 1500;

/** Filmstrip thumbnail size and pitch (size + gap). */
const STRIP = 64;
const PITCH = STRIP + 6;

export function Viewer() {
  const index = useStore((s) => s.viewer);
  const items = useStore((s) => s.items);
  const openViewer = useStore((s) => s.openViewer);
  const showInfo = useStore((s) => s.viewerInfo);
  const showStrip = useStore((s) => s.viewerStrip);
  const toggleInfo = useStore((s) => s.toggleViewerInfo);
  const toggleStrip = useStore((s) => s.toggleViewerStrip);
  const bare = useStore((s) => s.viewerBare);
  const toggleBare = useStore((s) => s.toggleViewerBare);
  // A note of how to get the controls back, shortly after the image-only view starts.
  const [hint, setHint] = useState(0);
  // In the image-only view, moving the pointer brings up a button to get the controls back.
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hoverPeek = useRef(false);
  const item = index !== null ? items[index] : undefined;
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  // "fit" follows the window size; a number is a fixed zoom level.
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const suppressClick = useRef(false);

  const open = item !== undefined;
  // Fonts, files and texts get their own body (sample text, document, text) instead of the zoomable image.
  const isImage = item?.kind === "image";
  useEffect(() => setZoom("fit"), [item?.id]);
  useEffect(() => {
    if (!open || !bare) return setHint(0);
    setHint((n) => n + 1);
    const t = setTimeout(() => setHint(0), HINT_MS);
    return () => clearTimeout(t);
  }, [open, bare]);
  useEffect(() => {
    if (!open || !bare) {
      clearTimeout(peekTimer.current);
      return setPeek(false);
    }
    const onMove = () => {
      setPeek(true);
      clearTimeout(peekTimer.current);
      peekTimer.current = setTimeout(() => {
        if (!hoverPeek.current) setPeek(false);
      }, PEEK_MS);
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointermove", onMove);
      clearTimeout(peekTimer.current);
    };
  }, [open, bare]);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [open, isImage]);

  const pad = 32;
  const fitScale = item
    ? Math.min(1, (box.w - pad) / item.width, (box.h - pad) / item.height)
    : 1;
  const scale = zoom === "fit" ? fitScale : zoom;

  /** Zooms keeping the point under (cx, cy) — or the centre — in place. */
  const zoomTo = useCallback(
    (next: number, cx?: number, cy?: number) => {
      const el = boxRef.current;
      if (!el || !item) return;
      const target = Math.min(MAX, Math.max(MIN, next));
      const rect = el.getBoundingClientRect();
      const px = (cx ?? rect.left + rect.width / 2) - rect.left;
      const py = (cy ?? rect.top + rect.height / 2) - rect.top;
      // Content coordinates of the anchor before zooming (image is centred when smaller).
      const imgW = item.width * scale;
      const imgH = item.height * scale;
      const offX = Math.max(0, (el.clientWidth - imgW) / 2);
      const offY = Math.max(0, (el.clientHeight - imgH) / 2);
      const rx = (el.scrollLeft + px - offX) / imgW;
      const ry = (el.scrollTop + py - offY) / imgH;
      setZoom(target);
      requestAnimationFrame(() => {
        const nW = item.width * target;
        const nH = item.height * target;
        const nOffX = Math.max(0, (el.clientWidth - nW) / 2);
        const nOffY = Math.max(0, (el.clientHeight - nH) / 2);
        el.scrollLeft = rx * nW + nOffX - px;
        el.scrollTop = ry * nH + nOffY - py;
      });
    },
    [item, scale],
  );

  /** Shows item `i` and makes it the selection (so the grid follows). */
  const show = useCallback(
    (i: number) => {
      const next = Math.min(items.length - 1, Math.max(0, i));
      openViewer(next);
      useStore.getState().select(items[next].id, "only", next);
    },
    [items, openViewer],
  );

  useEffect(() => {
    if (index === null || !item) return;
    const go = (d: number) => show(index + d);
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as Element).closest?.("input, textarea, select")) return;
      if (useStore.getState().settingsTab) return;
      const mod = e.metaKey || e.ctrlKey;
      // Ratings: 0-5, Shift+number rates and moves on.
      const digit = /^(Digit|Numpad)([0-5])$/.exec(e.code);
      if (digit && !mod && !e.altKey) {
        e.preventDefault();
        void setRating([item.id], Number(digit[2]));
        if (e.shiftKey && index < items.length - 1) go(1);
        return;
      }
      if (mod && (e.key === "=" || e.key === "+" || e.key === ";")) {
        e.preventDefault();
        zoomTo(scale * STEP);
      } else if (mod && e.key === "-") {
        e.preventDefault();
        zoomTo(scale / STEP);
      } else if (mod && e.key === "0") {
        e.preventDefault();
        zoomTo(1);
      } else if (mod && e.key === "9") {
        e.preventDefault();
        setZoom("fit");
      } else if (e.key === "Escape" || e.key === " " || e.key === "Enter") {
        e.preventDefault();
        openViewer(null);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || (!mod && e.code === "KeyA")) {
        e.preventDefault();
        go(-1);
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown" || (!mod && e.code === "KeyD")) {
        e.preventDefault();
        go(1);
      } else if (e.key === "Home") {
        e.preventDefault();
        show(0);
      } else if (e.key === "End") {
        e.preventDefault();
        show(items.length - 1);
      } else if (mod && e.shiftKey && (e.code === "KeyR" || e.code === "KeyL")) {
        e.preventDefault();
        void orient([item.id], e.code === "KeyR" ? "rotateCw" : "rotateCcw");
      } else if (!mod && !e.shiftKey && e.code === "KeyZ") {
        setZoom((z) => (z === "fit" ? 1 : "fit"));
      } else if (!mod && !e.shiftKey && e.code === "KeyF") {
        void toggleFavorite([item.id]);
      } else if (!mod && !e.shiftKey && e.code === "KeyP") {
        void togglePinned([item.id]);
      } else if (!mod && !e.shiftKey && e.code === "KeyB") {
        void toggleTray([item.id]);
      } else if (!mod && !e.shiftKey && e.code === "KeyI") {
        toggleInfo();
      } else if (!mod && !e.shiftKey && e.code === "KeyT") {
        toggleStrip();
      } else if (!mod && !e.shiftKey && e.code === "KeyH") {
        toggleBare();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, item, items, openViewer, scale, zoomTo, show, toggleInfo, toggleStrip, toggleBare]);

  // Option/Ctrl + wheel (and trackpad pinch, which arrives as ctrl+wheel) zooms.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey && !e.ctrlKey) return;
      e.preventDefault();
      zoomTo(scale * Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scale, zoomTo]);

  // Drag to pan when the image is larger than the window.
  const onPointerDown = (e: React.PointerEvent) => {
    const el = boxRef.current;
    if (!el || e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const sl = el.scrollLeft;
    const st = el.scrollTop;
    suppressClick.current = false;
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 3) suppressClick.current = true;
      el.scrollLeft = sl - (ev.clientX - sx);
      el.scrollTop = st - (ev.clientY - sy);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!item || index === null) return null;
  const nav =
    "absolute top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white/80 hover:bg-black/70 hover:text-white disabled:invisible";
  const tool = "rounded p-1 text-white/70 hover:bg-white/10 hover:text-white";
  const toggle = (on: boolean) => `${tool} ${on ? "bg-white/10 text-accent hover:text-accent" : ""}`;
  const larger = item.width * scale > box.w || item.height * scale > box.h;
  // Turned a quarter: the file's own width is the displayed height.
  const sideways = item.rotation % 2 === 1;

  return (
    <div className={`fixed inset-0 z-40 flex animate-fade-in flex-col ${bare ? "bg-black" : "bg-black/95"}`}>
      {!bare && (
        <div
          {...dragRegion(true)}
          className="flex items-center gap-3 px-4 py-2 text-sm text-white/80"
          // The macOS window buttons are over the top left, centred on this bar
          // as on the toolbar (48px tall).
          style={{ paddingLeft: "max(1rem, var(--traffic-lights))", minHeight: "calc(var(--titlebar) + 8px)" }}
        >
          <span className="min-w-0 flex-1 truncate">{item.name}</span>
          <span className="text-xs text-white/40 tabular-nums">
            {sizeLabel(item)}
          </span>
          {(item.kind === "file" || item.kind === "text" || item.kind === "video") && (
            <button className={tool} title="既定のアプリで開く" onClick={() => openSelection([item.id])}>
              <ExternalLink size={15} />
            </button>
          )}
          {isImage && (
            <>
              <div className="flex items-center gap-1">
                <button className={tool} title="左に回転（⌘⇧L）" onClick={() => orient([item.id], "rotateCcw", { quiet: true })}>
                  <RotateLeft size={15} />
                </button>
                <button className={tool} title="右に回転（⌘⇧R）" onClick={() => orient([item.id], "rotateCw", { quiet: true })}>
                  <RotateRight size={15} />
                </button>
              </div>
              <div className="flex items-center gap-1">
                <button className={tool} title="縮小（⌘-）" onClick={() => zoomTo(scale / STEP)}>
                  <Minus size={16} />
                </button>
                <button
                  className="w-14 rounded px-1 text-center text-xs tabular-nums hover:bg-white/10"
                  title="実寸（⌘0）"
                  onClick={() => zoomTo(1)}
                >
                  {Math.round(scale * 100)}%
                </button>
                <button className={tool} title="拡大（⌘+）" onClick={() => zoomTo(scale * STEP)}>
                  <Plus size={16} />
                </button>
                <button
                  className={`${tool} ${zoom === "fit" ? "text-accent" : ""}`}
                  title="全体を表示（⌘9）"
                  onClick={() => setZoom("fit")}
                >
                  <Maximize size={15} />
                </button>
              </div>
            </>
          )}
          <span className="tabular-nums text-white/50">
            {index + 1} / {items.length}
          </span>
          <div className="flex items-center gap-1">
            <button className={toggle(showStrip)} title="前後のサムネイル（T）" onClick={toggleStrip}>
              <GalleryHorizontal size={16} />
            </button>
            <button className={toggle(showInfo)} title="詳細（I）" onClick={toggleInfo}>
              <Info size={16} />
            </button>
            <button className={tool} title="画像のみ表示（H）" onClick={toggleBare}>
              <Focus size={16} />
            </button>
          </div>
          <button className="rounded p-1 hover:bg-white/10" onClick={() => openViewer(null)}>
            <X size={18} />
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          {item.kind === "font" ? (
            <FontView item={item} />
          ) : item.kind === "file" ? (
            <FileView item={item} />
          ) : item.kind === "text" ? (
            <TextView key={item.id} item={item} />
          ) : item.kind === "video" ? (
            <VideoView item={item} />
          ) : (
            <div
              ref={boxRef}
              className={`absolute inset-0 flex overflow-auto ${larger ? "cursor-grab active:cursor-grabbing" : ""}`}
              onPointerDown={larger ? onPointerDown : undefined}
              onClick={(e) => {
                // Clicking the empty backdrop closes, like before.
                if (e.target === e.currentTarget && !suppressClick.current) openViewer(null);
              }}
            >
              {/* The box has the displayed (turned) size; the original file inside is rotated to fill it. */}
              <div
                key={item.id}
                onClick={(e) => {
                  e.stopPropagation();
                  if (suppressClick.current) return;
                  // Click toggles fit ↔ 100% around the clicked point.
                  if (zoom === "fit" && fitScale < 1) zoomTo(1, e.clientX, e.clientY);
                  else setZoom("fit");
                }}
                style={{ width: item.width * scale, height: item.height * scale }}
                className={`relative m-auto shrink-0 animate-zoom-in ${
                  larger ? "" : zoom === "fit" && fitScale < 1 ? "cursor-zoom-in" : "cursor-zoom-out"
                }`}
              >
                <img
                  src={convertFileSrc(item.displayPath)}
                  alt={item.name}
                  draggable={false}
                  style={{
                    width: (sideways ? item.height : item.width) * scale,
                    height: (sideways ? item.width : item.height) * scale,
                    transform: `translate(-50%, -50%) ${orientTransform(item)}`,
                  }}
                  className="absolute top-1/2 left-1/2 max-w-none"
                />
              </div>
            </div>
          )}
          {!bare && (
            <>
              <button className={`${nav} left-4`} disabled={index === 0} onClick={() => show(index - 1)}>
                <ChevronLeft size={24} />
              </button>
              <button
                className={`${nav} right-4`}
                disabled={index === items.length - 1}
                onClick={() => show(index + 1)}
              >
                <ChevronRight size={24} />
              </button>
            </>
          )}
          {hint > 0 && (
            <div
              key={hint}
              role="status"
              className="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 animate-hud rounded-full border border-white/10 bg-black/80 px-4 py-2 text-sm whitespace-nowrap text-white/90 shadow-2xl shadow-black/50 backdrop-blur"
              style={{ animationDuration: `${HINT_MS}ms` }}
            >
              H か右上のボタンで操作と情報を表示
            </div>
          )}
        </div>
        {showInfo && !bare && <Details item={item} items={items} />}
      </div>
      {bare && (
        // Same row and corner as the toolbar's button; shows on pointer move and fades when it stops.
        // Still clickable while faded, so a pointer resting there can bring it back.
        <div
          className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-end px-4 py-2 text-sm"
          style={{ minHeight: "calc(var(--titlebar) + 8px)" }}
        >
          <button
            className={`pointer-events-auto flex items-center gap-1.5 rounded-full border border-white/10 bg-black/70 px-3 py-1 text-xs text-white/85 shadow-2xl shadow-black/50 backdrop-blur transition-opacity duration-300 hover:bg-black/90 hover:text-white ${
              peek || hint > 0 ? "opacity-100" : "opacity-0 hover:opacity-100"
            }`}
            title="操作と情報を表示（H）"
            onPointerEnter={() => (hoverPeek.current = true)}
            onPointerLeave={() => (hoverPeek.current = false)}
            onClick={() => {
              hoverPeek.current = false;
              toggleBare();
            }}
          >
            <Focus size={14} className="text-accent" />
            操作を表示
          </button>
        </div>
      )}
      {showStrip && !bare && items.length > 1 && <Strip items={items} index={index} onPick={show} />}
    </div>
  );
}

/** Side panel: the image's details, with rating / favourite / pin editable. */
function Details({ item, items }: { item: Item; items: Item[] }) {
  const tags = useStore((s) => s.tags);
  const folders = useStore((s) => s.folders);
  const itemTags = useMemo(() => tags.filter((t) => item.tagIds.includes(t.id)), [tags, item.tagIds]);
  const folder = useMemo(
    () => (item.folderId ? folderPaths(folders).find((f) => f.folder.id === item.folderId) : undefined),
    [folders, item.folderId],
  );
  const label = "mb-1.5 text-[11px] font-semibold text-white/45";
  // Installed fonts: their details only, nothing to rate or tag (docs/SYSTEM_FONTS.md).
  const system = isSystemId(item.id);
  return (
    <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-white/10 bg-black/40 p-4 text-sm text-white/85 animate-fade-in">
      <div>
        <div className="font-semibold break-words" title={item.fileName}>
          {item.name}
        </div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-white/70">
          <dt className="text-white/45">{item.kind === "image" || item.kind === "video" ? "サイズ" : "種類"}</dt>
          <dd className="tabular-nums">
            {sizeLabel(item)}
          </dd>
          <dt className="text-white/45">形式</dt>
          <dd>
            {item.ext.toUpperCase()} · {formatBytes(item.size)}
          </dd>
          <dt className="text-white/45">{system ? "更新日" : "追加日"}</dt>
          <dd>{new Date(item.importedAt).toLocaleString("ja-JP")}</dd>
          {system && (
            <>
              <dt className="text-white/45">場所</dt>
              <dd className="break-all">{item.filePath}</dd>
            </>
          )}
        </dl>
      </div>
      {system ? (
        <p className="text-xs leading-5 text-white/55">
          この端末にインストールされているフォントです。読み取り専用で、評価・タグ・フォルダ・メモはライブラリのフォントだけに使えます。
        </p>
      ) : (
        <>
          <div>
            <div className={label}>評価</div>
            <RatingStars value={item.rating} onChange={(n) => setRating([item.id], n, { quiet: true })} size={18} />
            <div className="mt-2.5">
              <FlagButtons ids={[item.id]} items={items} />
            </div>
          </div>
          <div>
            <div className={label}>タグ</div>
            {itemTags.length === 0 ? (
              <span className="text-xs text-white/45">なし</span>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {itemTags.map((t) => {
                  const hex = colorHex(t.color);
                  return (
                    <span
                      key={t.id}
                      className="flex max-w-full items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-0.5 text-xs"
                    >
                      {hex && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: hex }} />}
                      <span className="truncate">{t.name}</span>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          <div>
            <div className={label}>フォルダ</div>
            {folder ? (
              <span className="flex items-center gap-1.5 text-xs">
                <FolderIcon size={12} className="shrink-0 text-white/45" />
                <span className="truncate">{folder.path}</span>
              </span>
            ) : (
              <span className="text-xs text-white/45">未分類</span>
            )}
          </div>
          <div>
            <div className={label}>メモ</div>
            {item.note.trim() ? (
              <p className="text-xs whitespace-pre-wrap text-white/75">{item.note}</p>
            ) : (
              <span className="text-xs text-white/45">なし</span>
            )}
          </div>
        </>
      )}
      <p className="mt-auto pt-2 text-[11px] leading-5 text-white/35">
        {!system && (
          <>
            1〜5 で評価、0 で解除、Shift+数字で評価して次へ
            <br />F お気に入り / P ピン留め /{" "}
          </>
        )}
        I 詳細 / T サムネイル / H 画像のみ
        {item.kind === "image" && (
          <>
            <br />⌘⇧L / ⌘⇧R 左右に回転
          </>
        )}
      </p>
    </aside>
  );
}

/** Strip of thumbnails along the bottom; the current one stays centred. */
function Strip({ items, index, onPick }: { items: Item[]; index: number; onPick: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ from: 0, to: 0 });

  // Only the thumbnails near the viewport are rendered (lists can be long).
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const from = Math.max(0, Math.floor(el.scrollLeft / PITCH) - 8);
    const to = Math.min(items.length, Math.ceil((el.scrollLeft + el.clientWidth) / PITCH) + 8);
    setRange((r) => (r.from === from && r.to === to ? r : { from, to }));
  }, [items.length]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [measure]);

  // Keep the current thumbnail in the middle.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = index * PITCH + STRIP / 2 - el.clientWidth / 2;
    el.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
  }, [index]);

  const left = (i: number) => 12 + i * PITCH;
  return (
    <div
      ref={ref}
      className="relative shrink-0 overflow-x-auto overflow-y-hidden border-t border-white/10 bg-black/40 animate-fade-in"
      style={{ height: STRIP + 24 }}
      onScroll={measure}
      // A plain wheel (vertical) scrolls the strip sideways.
      onWheel={(e) => {
        if (ref.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) ref.current.scrollLeft += e.deltaY;
      }}
    >
      <div className="relative" style={{ width: left(items.length) + 6, height: STRIP + 24 }}>
        {Array.from({ length: Math.max(0, range.to - range.from) }, (_, k) => {
          const i = range.from + k;
          const it = items[i];
          const current = i === index;
          return (
            <button
              key={`${it.id}:${i}`}
              onClick={() => onPick(i)}
              title={it.name}
              className={`absolute top-3 overflow-hidden rounded-md bg-white/5 transition-[opacity,transform] duration-150 ${
                current ? "ring-2 ring-accent" : "opacity-55 hover:opacity-100"
              }`}
              style={{ left: left(i), width: STRIP, height: STRIP }}
            >
              {isSystemId(it.id) ? (
                // Installed fonts have no rendered sample: a few characters in the font.
                <FontMark item={it} className="flex h-full w-full items-center justify-center text-2xl text-white/80" />
              ) : (
                <img
                  src={convertFileSrc(it.thumbPath)}
                  alt=""
                  draggable={false}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

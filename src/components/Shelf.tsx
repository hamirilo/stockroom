// The shelf: a tab of the details panel on the right (DetailsPanel.tsx)
// where things are gathered for a while (the `tray` table), one per mode.
// Fonts are put there to be compared, at most FONT_SHELF_MAX; images and
// files to be compared, exported or put on one sheet. It is shown when the
// user picks its tab, and for the length of a drag from the list (docs/UI.md).
import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowRight, Ban, ListX, Plus, X } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  clearTray,
  exportTray,
  removeFromShelf,
  shelfAdding,
  sheetFromTray,
  transferList,
} from "../lib/actions";
import type { Item } from "../lib/api";
import { FontShelfLabel } from "../features/fonts/ShelfChip";
import { FONT_SHELF_MAX, useStore } from "../store";
import { useMenu } from "./ContextMenu";
import { startPointerDrag } from "./DragLayer";

const button =
  "flex h-6 shrink-0 items-center justify-center gap-1 rounded-md border border-edge bg-control px-2 whitespace-nowrap enabled:hover:bg-white/12 disabled:off disabled:bg-transparent";

export function Shelf() {
  const shelf = useStore((s) => s.shelf);
  const fonts = useStore((s) => s.mode === "font");
  const comparing = useStore((s) => s.comparing);
  const setComparing = useStore((s) => s.setComparing);
  // Items dragged from the list: the whole shelf takes them.
  const adding = useStore((s) => (s.drag?.kind === "items" && s.drag.from !== "shelf" ? s.drag.ids : null));
  const over = useStore((s) => s.drag?.kind === "items" && s.drag.from !== "shelf" && s.dropTarget === "tray");
  const flash = useStore((s) => (s.flash?.target === "tray" ? s.flash.n : null));
  const empty = shelf.length === 0;
  // The stock's comparison lines up images only.
  const comparable = fonts ? !empty : shelf.some((i) => i.kind === "image");
  // What was just added is at the end: bring it into view.
  const chips = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = chips.current;
    if (flash !== null && el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [flash]);

  const menu = (e: React.MouseEvent) =>
    useMenu.getState().show(e, [
      ...(fonts
        ? []
        : [
            { label: "書き出し…", disabled: empty, onClick: exportTray },
            { label: "まとめて出力…", disabled: empty, onClick: sheetFromTray },
          ]),
      { label: "比較する", disabled: !comparable || comparing, onClick: () => setComparing(true) },
      { label: "別のライブラリへ…", disabled: empty, onClick: () => transferList({ kind: "tray" }) },
      { separator: true },
      { label: "シェルフを空にする", disabled: empty, onClick: clearTray },
    ]);

  return (
    <section
      data-drop="tray"
      aria-label="シェルフ"
      onContextMenu={menu}
      className={`relative flex min-h-0 flex-1 flex-col text-xs transition-colors ${over ? "bg-accent/10" : ""}`}
    >
      {flash !== null && (
        <span key={flash} className="pointer-events-none absolute inset-0 animate-drop-pulse bg-accent/20" />
      )}
      {adding && <DropHint ids={adding} over={over} />}
      {/* "比較する" and "空にする" keep their place in both modes; the stock's own two go below them. */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-line p-3">
        <div className="flex items-center gap-2">
          <span className="flex-1 text-dim tabular-nums">
            {fonts ? `${shelf.length} / ${FONT_SHELF_MAX} 件` : `${shelf.length} 件`}
          </span>
          {/* Not a trash can: it only takes things off the shelf. */}
          <button
            disabled={empty}
            onClick={clearTray}
            title="シェルフを空にする（中身はそのまま残ります）"
            aria-label="シェルフを空にする"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dim enabled:hover:bg-white/10 enabled:hover:text-fg disabled:off"
          >
            <ListX size={15} />
          </button>
        </div>
        <button
          disabled={!comparable || comparing}
          onClick={() => setComparing(true)}
          title={
            comparing
              ? "比較中"
              : fonts
                ? "シェルフのフォントを並べて比べる"
                : comparable
                  ? "シェルフの画像を並べて比べる（拡大・移動はすべての画像で一緒に）"
                  : "シェルフに画像がありません（比べられるのは画像です）"
          }
          className="flex h-7 items-center justify-center gap-1 rounded-md bg-accent-fill px-2.5 font-medium whitespace-nowrap text-white enabled:hover:brightness-110 disabled:off disabled:bg-control"
        >
          比較する <ArrowRight size={13} />
        </button>
        {!fonts && (
          <div className="grid grid-cols-2 gap-2">
            <button disabled={empty} onClick={exportTray} title="元のファイルのままフォルダへ書き出す" className={button}>
              書き出し…
            </button>
            <button disabled={empty} onClick={sheetFromTray} title="1 枚の画像・HTML にまとめる" className={button}>
              まとめて出力…
            </button>
          </div>
        )}
      </div>
      <div ref={chips} className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-3">
        {shelf.map((item) => (
          <Chip key={item.id} item={item} />
        ))}
        {fonts &&
          Array.from({ length: Math.max(0, FONT_SHELF_MAX - shelf.length) }, (_, i) => (
            <span
              key={`free${i}`}
              className="flex h-10 shrink-0 items-center justify-center rounded-md border border-dashed border-line text-dim/60"
            >
              空き
            </span>
          ))}
        <p className="mt-1 text-dim/80">
          {fonts
            ? `一覧で選んで B キー、またはここへドラッグ。比べたいフォントを最大 ${FONT_SHELF_MAX} 件まで置いておけます`
            : "一覧で選んで B キー、またはここへドラッグ。画像を並べて比べたり、書き出しやまとめて出力の前に集めておけます"}
        </p>
      </div>
    </section>
  );
}

/**
 * Over the shelf while things are dragged from the list: a "+" and what the
 * drop will do, so it reads as "add here" rather than "move here". Elsewhere
 * in the drag a dashed edge shows that the shelf takes them (docs/UI.md).
 */
function DropHint({ ids, over }: { ids: string[]; over: boolean }) {
  if (!over)
    return <div className="pointer-events-none absolute inset-1 z-10 rounded-md border-2 border-dashed border-accent/40" />;
  const { fresh, full } = shelfAdding(ids);
  const ok = fresh > 0 && !full;
  return (
    <div
      className={`pointer-events-none absolute inset-1 z-10 flex animate-fade-in flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed bg-panel/95 px-3 text-center font-medium ${
        ok ? "border-accent text-fg" : "border-line text-dim"
      }`}
    >
      <span
        className={`flex h-9 w-9 items-center justify-center rounded-full ${ok ? "bg-accent-fill text-white" : "bg-raised"}`}
      >
        {ok ? <Plus size={20} strokeWidth={2.5} /> : <Ban size={17} />}
      </span>
      {full
        ? `シェルフは ${FONT_SHELF_MAX} 件までです`
        : fresh
          ? `${fresh} 件をシェルフに追加`
          : "すでにシェルフにあります"}
    </div>
  );
}

/**
 * One thing on the shelf, one per row. Dragged above or below another it reorders, onto a folder it
 * moves; a click selects it in the list (when it is there).
 */
function Chip({ item }: { item: Item }) {
  const insert = useStore((s) =>
    s.drag?.kind === "items" && s.dropTarget?.startsWith(`shelf:${item.id}:`) ? s.dropTarget.split(":")[2] : null,
  );
  const dragged = useStore((s) => s.drag?.kind === "items" && s.drag.from === "shelf" && s.drag.ids.includes(item.id));
  const select = () => {
    const s = useStore.getState();
    const at = s.items.findIndex((i) => i.id === item.id || i.familyIds?.includes(item.id));
    if (at >= 0) s.select(s.items[at].id, "only", at);
  };
  return (
    <div
      data-drop={`shelf:${item.id}`}
      data-axis="y"
      onPointerDown={(e) => {
        e.stopPropagation();
        startPointerDrag(e, () => ({ kind: "items", ids: [item.id], from: "shelf" }), select);
      }}
      onContextMenu={(e) =>
        useMenu.getState().show(e, [
          { label: "一覧で選択", onClick: select },
          { label: "シェルフから外す", onClick: () => removeFromShelf([item.id]) },
        ])
      }
      className={`group relative flex h-10 shrink-0 cursor-default items-center gap-1.5 rounded-md border border-line bg-raised pr-1 pl-1.5 transition-opacity hover:border-white/20 ${
        dragged ? "opacity-40" : ""
      }`}
    >
      {item.kind === "font" ? (
        <FontShelfLabel item={item} />
      ) : (
        <>
          <img
            src={convertFileSrc(item.thumbPath)}
            alt=""
            draggable={false}
            className="h-8 w-8 shrink-0 rounded bg-bg object-cover"
          />
          <span className="min-w-0 flex-1 truncate" title={item.name}>
            {item.name}
          </span>
        </>
      )}
      <button
        title="シェルフから外す"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => removeFromShelf([item.id])}
        className="shrink-0 rounded p-0.5 text-dim hover:bg-white/10 hover:text-fg"
      >
        <X size={12} />
      </button>
      {insert && (
        <span
          className={`pointer-events-none absolute inset-x-0 h-0.5 rounded-full bg-accent shadow-[0_0_6px] shadow-accent ${
            insert === "before" ? "-top-1" : "-bottom-1"
          }`}
        />
      )}
    </div>
  );
}

// シェルフ：一覧や場所をまたいで「あとで一緒に使うもの」を一時的に集めておく、順番のある作業台
// （docs/SHELF.md）。集めたものを見比べ、並べ、まとめて外へ出す。ライブラリの中身は変えない。
// 詳細パネルのタブ、または情報の下（置き方は利用者が選ぶ）に出る。一覧からドラッグしている
// あいだも出る（docs/UI.md）。一覧の場所に広げると（openShelf）、ここには「広げています」だけを出す。
import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowRight, Ban, LayoutGrid, List, ListX, Maximize2, MoreHorizontal, Plus, X } from "lucide-react";
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
import { kindChip } from "../lib/kinds";
import { useStore } from "../store";
import { useMenu } from "./ContextMenu";
import { startPointerDrag } from "./DragLayer";

const button =
  "flex h-6 shrink-0 items-center justify-center gap-1 rounded-md px-2 whitespace-nowrap ghost disabled:off";

/** 一覧でその項目を選ぶ（いまの一覧にあるとき）。 */
function selectInList(item: Item) {
  const s = useStore.getState();
  const at = s.items.findIndex((i) => i.id === item.id);
  if (at >= 0) s.select(s.items[at].id, "only", at);
}

/**
 * シェルフの中のものを大きく見る（Space・ダブルクリック）。一覧と同じビューアで、シェルフの中を前後に
 * 送れるよう、シェルフを一覧に広げてから開く（docs/SHELF.md「中を見る」）。
 */
export function viewOnShelf(id: string) {
  const s = useStore.getState();
  const open = () => {
    const st = useStore.getState();
    const at = st.items.findIndex((i) => i.id === id);
    if (st.view.kind !== "tray" || at < 0) return false;
    st.select(id, "only", at);
    st.openViewer(at);
    return true;
  };
  if (s.view.kind === "tray" && !s.comparing && open()) return;
  s.openShelf("list");
  // 広げた一覧が読み込まれたら開く。
  const stop = useStore.subscribe(() => {
    if (open()) stop();
  });
  setTimeout(stop, 3000);
}

export function Shelf() {
  const shelf = useStore((s) => s.shelf);
  const expanded = useStore((s) => s.view.kind === "tray");
  const comparing = useStore((s) => s.comparing);
  const shelfView = useStore((s) => s.shelfView);
  const shelfLayout = useStore((s) => s.shelfLayout);
  // Items dragged from the list: the whole shelf takes them.
  const adding = useStore((s) => (s.drag?.kind === "items" && s.drag.from !== "shelf" ? s.drag.ids : null));
  const over = useStore((s) => s.drag?.kind === "items" && s.drag.from !== "shelf" && s.dropTarget === "tray");
  const flash = useStore((s) => (s.flash?.target === "tray" ? s.flash.n : null));
  const empty = shelf.length === 0;
  // The comparison lines up images only.
  const comparable = shelf.some((i) => i.kind === "image");
  // What was just added is at the end: bring it into view.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = body.current;
    if (flash !== null && el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [flash]);

  const st = useStore.getState;
  const moreMenu = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    useMenu.getState().show({ clientX: r.left, clientY: r.bottom + 4 }, [
      { header: "置き方" },
      { label: "情報とタブで切り替える", checked: shelfLayout === "tab", onClick: () => st().setShelfLayout("tab") },
      { label: "情報の下に並べる", checked: shelfLayout === "split", onClick: () => st().setShelfLayout("split") },
      { separator: true },
      { label: "別のライブラリへ…", disabled: empty, onClick: () => transferList({ kind: "tray" }) },
    ]);
  };
  const menu = (e: React.MouseEvent) =>
    useMenu.getState().show(e, [
      { label: "比較する", disabled: !comparable, onClick: () => st().openShelf("compare") },
      { label: "一覧に広げる", disabled: empty, onClick: () => st().openShelf("list") },
      { label: "まとめて出力…", disabled: empty, onClick: sheetFromTray },
      { label: "書き出し…", disabled: empty, onClick: exportTray },
      { label: "別のライブラリへ…", disabled: empty, onClick: () => transferList({ kind: "tray" }) },
      { separator: true },
      { label: "シェルフを空にする", disabled: empty, onClick: clearTray },
    ]);

  // 一覧に広げているあいだは、同じ中身を 2 か所に並べない（docs/SHELF.md「広げているあいだ」）。
  if (expanded)
    return (
      <section
        data-drop="tray"
        aria-label="シェルフ"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-dim"
      >
        <span>シェルフを広げています（{comparing ? "比較" : "一覧"}）</span>
        <button onClick={() => st().closeShelf()} className="h-7 rounded-md border border-frame px-3 text-fg hover:bg-hover">
          戻す
        </button>
      </section>
    );

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
      <div className="flex shrink-0 flex-col gap-2 border-b border-line p-3">
        <div className="flex items-center gap-1.5">
          <div role="group" aria-label="シェルフの見せ方" className="flex h-6 items-stretch rounded-md track">
            {(
              [
                { key: "tile", icon: <LayoutGrid size={13} />, label: "タイル" },
                { key: "list", icon: <List size={13} />, label: "リスト" },
              ] as const
            ).map((v) => (
              <button
                key={v.key}
                aria-pressed={shelfView === v.key}
                aria-label={v.label}
                title={v.label}
                onClick={() => st().setShelfView(v.key)}
                className={`flex w-7 items-center justify-center rounded ${shelfView === v.key ? "thumb" : "text-dim hover:bg-hover hover:text-fg"}`}
              >
                {v.icon}
              </button>
            ))}
          </div>
          {/* 情報の下に並べるときは、件数は境目の帯に出ている。 */}
          <span className="flex-1 text-right text-dim tabular-nums">{shelfLayout === "split" ? "" : `${shelf.length} 件`}</span>
          {/* ごみ箱ではない：シェルフから外すだけ。 */}
          <button
            disabled={empty}
            onClick={clearTray}
            title="シェルフから全部外す（中身はライブラリに残ります。元に戻せます）"
            className={button}
          >
            <ListX size={14} />
            空にする
          </button>
          <button
            onClick={moreMenu}
            title="置き方・別のライブラリへ"
            aria-label="シェルフのそのほかの操作"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dim hover:bg-ink/10 hover:text-fg"
          >
            <MoreHorizontal size={15} />
          </button>
        </div>
        <button
          disabled={!comparable}
          onClick={() => st().openShelf("compare")}
          title={
            comparable
              ? "シェルフの画像を一覧の場所に大きく並べて比べる（拡大・移動はすべての画像で一緒に）"
              : "シェルフに画像がありません（比べられるのは画像です）"
          }
          className="flex h-7 items-center justify-center gap-1 rounded-md bg-accent-fill px-2.5 font-medium whitespace-nowrap text-white enabled:hover:brightness-110 disabled:off disabled:bg-control"
        >
          比較する <ArrowRight size={13} />
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button disabled={empty} onClick={sheetFromTray} title="シェルフの順に 1 枚の画像・HTML にまとめる" className={button}>
            まとめて出力…
          </button>
          <button disabled={empty} onClick={exportTray} title="シェルフの順に書き出す（番号を付けられます）" className={button}>
            書き出し…
          </button>
        </div>
        <button
          disabled={empty}
          onClick={() => st().openShelf("list")}
          title="シェルフを一覧の場所に広げる。ほかのフォルダのものも含めて選び、選択バーでタグ付けや移動ができます"
          className="flex h-7 items-center justify-center gap-1.5 rounded-md border border-dashed border-edge whitespace-nowrap enabled:hover:bg-ink/8 disabled:off"
        >
          <Maximize2 size={13} /> 一覧に広げる
        </button>
      </div>
      <div ref={body} className="min-h-0 flex-1 overflow-y-auto p-3">
        {shelfView === "tile" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-1.5">
            {shelf.map((item, i) => (
              <Tile key={item.id} item={item} n={i + 1} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {shelf.map((item, i) => (
              <Chip key={item.id} item={item} n={i + 1} />
            ))}
          </div>
        )}
        <p className="mt-2 text-dim/80">
          一覧で選んで B キー、またはここへドラッグ。ドラッグで並べ替え、ダブルクリックか Space で大きく見ます。比較・まとめて出力・書き出しはこの順番で行います
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
  const fresh = shelfAdding(ids);
  const ok = fresh > 0;
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
      {fresh ? `${fresh} 件をシェルフに追加` : "すでにシェルフにあります"}
    </div>
  );
}

/** 1 つの項目に共通する動き：ドラッグで並べ替え（フォルダへ落とすと移動）、クリックで一覧で選ぶ、右クリック。 */
function useShelfItem(item: Item) {
  const insert = useStore((s) =>
    s.drag?.kind === "items" && s.dropTarget?.startsWith(`shelf:${item.id}:`) ? s.dropTarget.split(":")[2] : null,
  );
  const dragged = useStore((s) => s.drag?.kind === "items" && s.drag.from === "shelf" && s.drag.ids.includes(item.id));
  const props = {
    "data-drop": `shelf:${item.id}`,
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation();
      startPointerDrag(e, () => ({ kind: "items", ids: [item.id], from: "shelf" }), () => selectInList(item));
    },
    onDoubleClick: () => viewOnShelf(item.id),
    // Space：大きく見る（一覧の Space と同じ。docs/SHELF.md「中を見る」）。
    tabIndex: 0,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        viewOnShelf(item.id);
      }
    },
    onContextMenu: (e: React.MouseEvent) =>
      useMenu.getState().show(e, [
        { label: "大きく見る", onClick: () => viewOnShelf(item.id) },
        { label: "一覧で選択", onClick: () => selectInList(item) },
        { label: "シェルフから外す", onClick: () => removeFromShelf([item.id]) },
      ]),
  };
  return { insert, dragged, props };
}

/** タイル：画像だけを正方形で。左上に順番の番号、ホバーで ×。名前はツールチップ。左右へドラッグで並べ替え。 */
function Tile({ item, n }: { item: Item; n: number }) {
  const { insert, dragged, props } = useShelfItem(item);
  const chip = kindChip(item);
  return (
    <div
      {...props}
      title={item.name}
      className={`group relative aspect-square cursor-default overflow-hidden rounded-md bg-raised outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-accent ${dragged ? "opacity-40" : ""}`}
    >
      <img src={convertFileSrc(item.thumbPath)} alt="" draggable={false} className="h-full w-full object-cover" />
      <span className="absolute top-1 left-1 min-w-4 rounded-full bg-black/60 px-1 text-center text-[10px] leading-4 font-bold text-white tabular-nums">
        {n}
      </span>
      {chip && (
        <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[9px] leading-4 font-semibold text-white">
          {chip.label}
        </span>
      )}
      <button
        title="シェルフから外す"
        aria-label="シェルフから外す"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => removeFromShelf([item.id])}
        className="absolute top-1 right-1 hidden h-[18px] w-[18px] items-center justify-center rounded-full bg-black/60 text-white group-hover:flex"
      >
        <X size={11} />
      </button>
      {insert && (
        <span
          className={`pointer-events-none absolute inset-y-0 w-0.5 rounded-full bg-accent shadow-[0_0_6px] shadow-accent ${
            insert === "before" ? "left-0" : "right-0"
          }`}
        />
      )}
    </div>
  );
}

/** リスト：1 行に 1 つ（番号・サムネイル・名前）。上下へドラッグで並べ替え。 */
function Chip({ item, n }: { item: Item; n: number }) {
  const { insert, dragged, props } = useShelfItem(item);
  return (
    <div
      {...props}
      data-axis="y"
      className={`group relative flex h-10 shrink-0 cursor-default items-center gap-1.5 rounded-md border border-line bg-raised pr-1 pl-1.5 outline-none transition-opacity hover:border-ink/20 focus-visible:ring-2 focus-visible:ring-accent ${
        dragged ? "opacity-40" : ""
      }`}
    >
      <span className="w-4 shrink-0 text-right text-[10px] text-dim tabular-nums">{n}</span>
      <img
        src={convertFileSrc(item.thumbPath)}
        alt=""
        draggable={false}
        className="h-8 w-8 shrink-0 rounded bg-bg object-cover"
      />
      <span className="min-w-0 flex-1 truncate" title={item.name}>
        {item.name}
      </span>
      <button
        title="シェルフから外す"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => removeFromShelf([item.id])}
        className="shrink-0 rounded p-0.5 text-dim hover:bg-ink/10 hover:text-fg"
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

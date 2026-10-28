import { convertFileSrc } from "@tauri-apps/api/core";
import { Check, ChevronDown, ChevronRight, Heart, ImagePlus, Layers, Link2, Pin, Star, Trash2 } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  exportSelection,
  importFilesDialog,
  openSheet,
  keepPlan,
  keeperOf,
  dismissDuplicates,
  reviewDuplicates,
  similarGroups,
  setRating,
  toggleFavorite,
} from "../lib/actions";
import { command, isEnabled, runKey } from "../lib/commands";
import { applicable, commandIcon, commandItem } from "../lib/menuItems";
import { FontTile, SpecimenRow } from "../features/fonts/FontRows";
import { api, durationLabel, formatBytes, isSystemId, sizeLabel, urlLabel, type Item, type ItemKind } from "../lib/api";
import { fontApi } from "../features/fonts/api";
import { itemsNoun, kindsNoun } from "../lib/modes";
import { colorHex } from "../lib/colors";
import { rowIds, type Section } from "../lib/grouping";
import {
  computeLayout,
  GAP,
  HEADER,
  neighbour,
  PAD,
  rawAspect,
  clampedAspect,
  visibleRange,
  type Placement,
} from "../lib/layouts";
import { activeConditions, currentFolderId, listKinds, useStore, type ShowInfo } from "../store";
import { comboText, isMac } from "../lib/shortcuts";
import { ChangePulse } from "./ActionHud";
import { useMenu, type MenuItem } from "./ContextMenu";
import { startPointerDrag } from "./DragLayer";

/** Extra rows rendered above / below the viewport. */
const OVERSCAN = 600;

/**
 * Display index of the focused item. With tag grouping an image can appear
 * more than once, so the position it was clicked / moved to is remembered
 * and preferred over the first occurrence.
 */
let focusAt: number | null = null;
function focusIndex(s: { items: Item[]; focus: string | null }): number {
  if (focusAt !== null && s.items[focusAt]?.id === s.focus) return focusAt;
  return s.items.findIndex((i) => i.id === s.focus);
}

export function onItemPointerDown(e: React.PointerEvent, item: Item, index: number) {
  if (e.button !== 0) return;
  e.stopPropagation();
  focusAt = index;
  const s = useStore.getState();
  const mod = e.metaKey || e.ctrlKey;
  if (e.shiftKey) s.select(item.id, "range", index);
  else if (mod) s.select(item.id, "toggle", index);
  else if (!s.selected.has(item.id)) s.select(item.id, "only", index);
  // The installed fonts are dragged to the shelf only, not to folders or out of
  // the app as files (DragLayer.tsx, docs/SYSTEM_FONTS.md).
  startPointerDrag(
    e,
    () => ({ kind: "items", ids: [...useStore.getState().selected] }),
    // Plain click on an already-selected item narrows the selection to it.
    () => !e.shiftKey && !mod && useStore.getState().select(item.id, "only", index),
  );
}

function Thumb({ item, fit }: { item: Item; fit: "cover" | "contain" }) {
  return (
    <img
      src={convertFileSrc(item.thumbPath)}
      loading="lazy"
      decoding="async"
      draggable={false}
      alt=""
      ref={(img) => {
        if (img?.complete) img.classList.add("loaded");
      }}
      onLoad={(e) => e.currentTarget.classList.add("loaded")}
      // Cover when the box already has the image's shape (hides sub-pixel
      // rounding); clamped panoramas / strips and the grid layout show it whole.
      className={`thumb h-full w-full ${
        fit === "cover" && clampedAspect(item) === rawAspect(item) ? "object-cover" : "object-contain"
      }`}
    />
  );
}

/** Frames behind a parent's thumbnail, as many as it has children (up to 2): a stack reads as "has more". */
function StackFrames({ item, width, height }: { item: Item; width: number; height: number }) {
  const n = Math.min(item.childIds?.length ?? 0, 2);
  if (item.childMember || !n) return null;
  return (
    <>
      {Array.from({ length: n }, (_, k) => (
        <div
          key={k}
          aria-hidden
          className="pointer-events-none absolute rounded-lg border border-white/15 bg-raised"
          style={{ width, height, top: (n - k) * 4, left: (n - k) * 4, opacity: 0.9 - k * 0.2 }}
        />
      ))}
    </>
  );
}

/**
 * A parent's "＋3" with ▸ / ▾ to open its children under it (links on, docs/LINKS.md);
 * "中に該当あり" when the parent is in the list only because children of it match.
 * A child under its parent's row gets a link mark. `inline`: in a list row.
 */
function LinkMark({ item, inline = false }: { item: Item; inline?: boolean }) {
  const open = useStore((s) => s.openParents.has(item.id));
  const parentName = useStore((s) => (item.childMember ? s.rawItems.find((i) => i.id === item.parentId)?.name : undefined));
  if (item.childMember) {
    return (
      <span
        title={`「${parentName ?? "親"}」に紐づいています${item.adopted ? "（採用）" : ""}`}
        className={
          inline
            ? "inline-flex shrink-0 align-middle text-dim"
            : "pointer-events-none absolute bottom-1.5 left-1.5 rounded-full bg-black/55 p-1 text-white/90"
        }
      >
        {item.adopted ? (
          <Star size={inline ? 12 : 11} fill="currentColor" className="text-amber-400" />
        ) : (
          <Link2 size={inline ? 12 : 11} strokeWidth={2.25} />
        )}
      </span>
    );
  }
  const n = item.childIds?.length ?? 0;
  if (!n) return null;
  const Chevron = open ? ChevronDown : ChevronRight;
  const label = item.viaChild ? "中に該当あり" : `親 ${n}`;
  const title = `${open ? "紐づけた項目を閉じる" : "紐づけた項目を開く"}（${n} 件${item.viaChild ? "。この親自体は条件に合いません" : ""}。${isMac ? "⌥" : "Alt"}+クリックですべて）`;
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      // ⌥-click: every parent of the list, as in Finder.
      onClick={(e) => (e.altKey ? useStore.getState().setAllParents(!open) : useStore.getState().toggleParent(item.id))}
      title={title}
      // A parent: the accent face, the stack icon and the word, so it reads as one at a glance.
      // At the bottom left, clear of the selection check at the right.
      className={`flex items-center gap-1 rounded-full bg-accent-fill px-1.5 py-0.5 text-[11px] leading-none text-white tabular-nums hover:brightness-110 ${
        inline ? "mr-1.5 inline-flex shrink-0 align-middle" : "absolute bottom-1.5 left-1.5 max-w-[calc(100%-2.75rem)]"
      }`}
    >
      <Layers size={11} className="shrink-0" />
      <span className="truncate">{label}</span>
      <Chevron size={11} strokeWidth={2.5} className="shrink-0" />
    </button>
  );
}

/**
 * What a row needs to be dropped onto for linking (docs/LINKS.md): `link` is its id when the
 * dragged items can be linked to it (links on, the stock, not a child), `over` while one is over it.
 */
function useLinkDrop(item: Item) {
  const link = useStore((s) =>
    s.librarySettings.links &&
    s.mode === "stock" &&
    s.view.kind !== "trash" &&
    s.view.kind !== "similar" &&
    !item.parentId &&
    !item.childMember
      ? item.id
      : undefined,
  );
  const over = useStore((s) => s.dropTarget === `link:${item.id}`);
  return { link, over };
}

export type CellProps = {
  item: Item;
  index: number;
  selected: boolean;
  /** The keyboard position, marked when it isn't the only selected item. */
  focused: boolean;
  dimmed: boolean;
  width: number;
  height: number;
  label: number;
  fit: "cover" | "contain";
  info: ShowInfo;
  /** Manual-order folder view: the cell is a drop target for reordering. */
  reorderable: boolean;
  /** Where the reorder drop indicator is shown, if here. */
  insert: "before" | "after" | null;
  /** Similar view: what the tidy-up would do with this copy. */
  similar?: SimilarMark;
  /** Show the favourite / pin marks (hidden in the similar view). */
  flags: boolean;
};

/** Favourite heart (also a toggle on hover) and pin mark on a thumbnail. */
function FlagOverlay({ item }: { item: Item }) {
  const trayMark = item.inTray;
  return (
    <>
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={() => toggleFavorite([item.id], { quiet: true })}
        title={item.favorite ? "お気に入りから外す（F）" : "お気に入りに追加（F）"}
        className={`absolute top-1.5 right-1.5 rounded-full p-1 transition-colors ${
          item.favorite
            ? "bg-black/45 text-pink-400 hover:bg-black/70"
            : "hidden bg-black/45 text-white/80 group-hover:block hover:text-pink-400"
        }`}
      >
        <Heart size={13} fill={item.favorite ? "currentColor" : "none"} strokeWidth={2} />
      </button>
      {(item.pinnedAt !== null || trayMark) && (
        <span className="pointer-events-none absolute top-1.5 left-1.5 flex gap-1">
          {item.pinnedAt !== null && (
            <span title="ピン留め中（一覧の先頭に表示）" className="pointer-events-auto rounded-full bg-accent-fill p-1 text-white shadow">
              <Pin size={11} fill="currentColor" strokeWidth={2} />
            </span>
          )}
          {trayMark && (
            <span title="シェルフにあります（B で外す）" className="pointer-events-auto rounded-full bg-emerald-600 p-1 text-white shadow">
              <Layers size={11} strokeWidth={2.25} />
            </span>
          )}
        </span>
      )}
    </>
  );
}

/**
 * Selection check at the bottom right of a thumbnail (like Photos). Unselected
 * ones show an empty circle on hover that adds to the selection, as ⌘-click does.
 */
function SelectMark({ item, index, selected }: { item: Item; index: number; selected: boolean }) {
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        focusAt = index;
        useStore.getState().select(item.id, e.shiftKey ? "range" : "toggle", index);
      }}
      title={selected ? "選択から外す（⌘+クリック）" : "選択に追加（⌘+クリック）"}
      className={`absolute right-1.5 bottom-1.5 h-5 w-5 items-center justify-center rounded-full border-2 border-white transition-colors ${
        selected ? "flex bg-accent-fill text-white shadow" : "hidden bg-black/35 group-hover:flex hover:bg-black/60"
      }`}
    >
      {selected && <Check size={12} strokeWidth={3.5} />}
    </button>
  );
}

type SimilarMark = {
  /** This copy would be kept (otherwise trashed). */
  keep: boolean;
  /** Highest quality of its group. */
  best: boolean;
  /** Percent match with the best copy. */
  match: number;
};

/** Badges on a thumbnail in the similar view. */
function SimilarOverlay({ item, mark }: { item: Item; mark: SimilarMark }) {
  return (
    <>
      {!mark.keep && <div className="pointer-events-none absolute inset-0 bg-black/40" />}
      <span
        className={`absolute top-1.5 left-1.5 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-white ${
          mark.keep ? "bg-emerald-600/90" : "bg-danger/85"
        }`}
      >
        {mark.keep ? <Check size={11} strokeWidth={3} /> : <Trash2 size={11} />}
        {mark.keep ? "残す" : "ゴミ箱へ"}
      </span>
      <span className="absolute bottom-1.5 left-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white">
        {mark.best ? "最高画質" : `一致 ${mark.match}%`}
      </span>
      {!mark.keep && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => useStore.getState().pickKeeper(item.id)}
          className="absolute top-1.5 right-1.5 hidden rounded bg-white px-1.5 py-0.5 text-[10px] font-medium text-black shadow group-hover:block hover:bg-white/90"
        >
          これを残す
        </button>
      )}
    </>
  );
}

const Cell = memo(function Cell({
  item,
  index,
  selected,
  focused,
  dimmed,
  width,
  height,
  label,
  fit,
  info,
  reorderable,
  insert,
  similar,
  flags,
}: CellProps) {
  const detail = info.dims || info.rating || info.meta;
  const { link, over } = useLinkDrop(item);
  return (
    <div
      className={`group relative flex flex-col items-center transition-[opacity,transform] duration-200 ${
        dimmed ? "scale-95 opacity-35" : ""
      }`}
      style={{ width }}
      onPointerDown={(e) => onItemPointerDown(e, item, index)}
      onDoubleClick={() => useStore.getState().openViewer(index)}
      onContextMenu={(e) => showItemMenu(e, item, index)}
      data-drop={reorderable ? `item:${item.id}` : undefined}
      data-link={link}
    >
      <StackFrames item={item} width={width} height={height} />
      <div
        className={`relative flex items-center justify-center overflow-hidden rounded-lg bg-raised transition-shadow duration-150 ${
          selected ? "sel-ring" : focused ? "" : "hover:ring-2 hover:ring-white/15"
        } ${focused ? "focus-ring" : ""} ${over ? "outline-[3px] outline-accent" : ""}`}
        style={{ width, height }}
      >
        <Thumb item={item} fit={fit} />
        {similar && <SimilarOverlay item={item} mark={similar} />}
        {flags && <FlagOverlay item={item} />}
        <LinkMark item={item} />
        {item.kind === "video" && item.durationMs != null && (
          <span className="pointer-events-none absolute right-1.5 bottom-1.5 rounded bg-black/65 px-1.5 py-px text-[10px] text-white tabular-nums">
            {durationLabel(item.durationMs)}
          </span>
        )}
        {item.kind === "bookmark" && item.sourceUrl && (
          <span className="pointer-events-none absolute bottom-1.5 left-1.5 max-w-[80%] truncate rounded bg-black/65 px-1.5 py-px text-[10px] text-white">
            {urlLabel(item.sourceUrl)}
          </span>
        )}
        <ChangePulse id={item.id} />
        <SelectMark item={item} index={index} selected={selected} />
      </div>
      {insert && (
        <span
          className="pointer-events-none absolute top-0 w-1 animate-fade-in rounded-full bg-accent shadow-[0_0_8px] shadow-accent"
          style={{ height, [insert === "before" ? "left" : "right"]: -GAP / 2 - 2 }}
        />
      )}
      {label > 0 && (
        <div className="mt-1.5 w-full text-center leading-[15px]">
          {info.name && <div className={`truncate text-xs ${selected ? "text-white" : ""}`}>{item.name}</div>}
          {detail && (
            <div className="flex items-center justify-center gap-1.5 overflow-hidden text-[11px] whitespace-nowrap text-dim tabular-nums">
              {info.rating && item.rating > 0 && <Stars n={item.rating} />}
              {info.dims && (
                <span>
                  {sizeLabel(item)}
                </span>
              )}
              {info.meta && (
                <span className="truncate">
                  {item.ext.toUpperCase()} · {formatBytes(item.size)}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * Selection of a row (list, specimen): a tint plus an accent bar on the left,
 * so it shows even where the row's own content is blue; the keyboard position
 * gets a light outline.
 */
export const rowSelection = (selected: boolean, focused: boolean) =>
  `${
    selected
      ? "bg-accent/25 text-white before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-accent"
      : "hover:bg-white/5"
  } ${focused ? "outline-1 -outline-offset-1 outline-fg/60" : ""}`;

/** List layout row: thumbnail plus the details as columns. */
const ListRow = memo(function ListRow({
  item,
  index,
  selected,
  focused,
  dimmed,
  width,
  height,
  reorderable,
  insert,
  similar,
  flags,
}: CellProps) {
  const { link, over } = useLinkDrop(item);
  return (
    <div
      className={`relative flex items-center gap-3 rounded-md px-2 text-xs transition-opacity duration-200 ${rowSelection(
        selected,
        focused,
      )} ${dimmed ? "opacity-35" : ""} ${over ? "bg-accent/30 outline-2 outline-accent" : ""}`}
      style={{ width, height, paddingLeft: item.childMember ? 32 : undefined }}
      onPointerDown={(e) => onItemPointerDown(e, item, index)}
      onDoubleClick={() => useStore.getState().openViewer(index)}
      onContextMenu={(e) => showItemMenu(e, item, index)}
      data-drop={reorderable ? `item:${item.id}` : undefined}
      data-link={link}
      data-axis="y"
    >
      <ChangePulse id={item.id} className="rounded-md" />
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-raised">
        <Thumb item={item} fit="contain" />
      </div>
      <span className="min-w-0 flex-1 truncate text-[13px]">
        <LinkMark item={item} inline />
        {item.name}
        {similar && (
          <span
            className={`ml-2 rounded px-1.5 py-0.5 text-[10px] text-white ${
              similar.keep ? "bg-emerald-600/90" : "bg-danger/85"
            }`}
          >
            {similar.keep ? "残す" : "ゴミ箱へ"}
          </span>
        )}
        {similar && (
          <span className="ml-1 rounded bg-white/10 px-1.5 py-0.5 text-[10px]">
            {similar.best ? "最高画質" : `一致 ${similar.match}%`}
          </span>
        )}
        {similar && !similar.keep && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => useStore.getState().pickKeeper(item.id)}
            className="ml-2 rounded px-1.5 py-0.5 text-[10px] ghost"
          >
            これを残す
          </button>
        )}
      </span>
      <span className="flex w-10 shrink-0 items-center gap-1">
        {flags && item.pinnedAt !== null && <Pin size={12} className="text-accent" fill="currentColor" />}
        {flags && item.inTray && <Layers size={12} className="text-emerald-400" />}
        {flags && item.favorite && <Heart size={12} className="text-pink-400" fill="currentColor" />}
      </span>
      <span className="w-24 shrink-0">{item.rating > 0 && <Stars n={item.rating} />}</span>
      <span className="w-28 shrink-0 text-right text-dim tabular-nums">
        {sizeLabel(item)}
      </span>
      <span className="w-12 shrink-0 text-dim uppercase">{item.ext}</span>
      <span className="w-20 shrink-0 text-right text-dim tabular-nums">{formatBytes(item.size)}</span>
      <span className="w-24 shrink-0 text-right text-dim tabular-nums @max-4xl:hidden">
        {new Date(item.importedAt).toLocaleDateString("ja-JP")}
      </span>
      {insert && (
        <span
          className={`pointer-events-none absolute right-2 left-2 h-0.5 rounded-full bg-accent shadow-[0_0_6px] shadow-accent ${
            insert === "before" ? "-top-px" : "-bottom-px"
          }`}
        />
      )}
    </div>
  );
});

export function Stars({ n, size = 9 }: { n: number; size?: number }) {
  return (
    <span className="flex text-amber-400" title={`★${n}`}>
      {Array.from({ length: n }, (_, i) => (
        <Star key={i} size={size} fill="currentColor" strokeWidth={0} />
      ))}
    </span>
  );
}

/** The menu of an item (and the rest of the selection); also the details panel's "…". */
export function showItemMenu(e: React.MouseEvent | { clientX: number; clientY: number }, item: Item, index: number) {
  const s0 = useStore.getState();
  if (!s0.selected.has(item.id)) s0.select(item.id, "only", index);
  const s = useStore.getState();
  const ids = [...s.selected];
  const header: MenuItem[] = ids.length > 1 ? [{ header: `${ids.length} 件を選択中` }] : [];
  if (s.view.kind === "trash") {
    useMenu.getState().show(e, [
      ...header,
      { label: "復元", onClick: () => s.run(() => api.restoreItems(ids)) },
      commandItem("item.trash", { label: "完全に削除", danger: true }),
    ]);
    return;
  }
  if (ids.some(isSystemId)) {
    // Installed fonts: looked at only (docs/SYSTEM_FONTS.md).
    useMenu.getState().show(e, [
      ...header,
      commandItem("item.show", { onClick: () => s.openViewer(index) }),
      commandItem("item.reveal", { onClick: () => s.run(() => fontApi.revealSystem(item.id)) }),
      commandItem("item.tray"),
      { separator: true },
      {
        header: "この端末のフォントは読み取り専用です。評価・タグ・フォルダはライブラリのフォントだけに使えます",
      },
    ]);
    return;
  }
  const byId = new Map(s.rawItems.map((i) => [i.id, i]));
  const ratings = new Set(ids.map((id) => byId.get(id)?.rating ?? 0));
  const rotate = applicable(["item.rotateCcw", "item.rotateCw", "item.flipH", "item.flipV"]);
  const turned = isEnabled(command("item.resetOrientation"), s);
  const folder = currentFolderId();
  useMenu.getState().show(e, [
    ...header,
    commandItem("item.show", { onClick: () => s.openViewer(index) }),
    commandItem("item.open"),
    commandItem("item.reveal", { onClick: () => s.run(() => api.revealItem(item.id)) }),
    { separator: true },
    {
      icons: ["item.favorite", "item.pin", "item.tray"].map(commandIcon),
      rating: { current: ratings.size === 1 ? [...ratings][0] : null, onPick: (n) => setRating(ids, n) },
    },
    // Only images turn; "元の向きに戻す" once one has been turned.
    ...(rotate.length ? [{ icons: [...rotate, ...(turned ? ["item.resetOrientation"] : [])].map(commandIcon) }] : []),
    { separator: true },
    commandItem("item.copy"),
    {
      label: "書き出し",
      submenu: [
        commandItem("list.export", { onClick: () => exportSelection(ids) }),
        commandItem("list.sheet", { onClick: () => openSheet(ids) }),
        commandItem("list.transfer", { onClick: () => s.setTransfer({ ids, noun: itemsNoun(ids.flatMap((id) => byId.get(id) ?? [])), count: ids.length }) }),
      ],
    },
    {
      label: "フォルダ",
      submenu: [
        commandItem("item.moveTo"),
        ...(s.recentFolders[0] ? [commandItem("item.moveToLast")] : []),
        commandItem("item.newFolder"),
        ...(folder ? [commandItem("item.unfile")] : []),
      ],
    },
    { label: "タグ", submenu: [commandItem("item.copyTags"), commandItem("item.pasteTags")] },
    // A video, or a video and an image (docs/VIDEO.md).
    ...(ids.some((id) => byId.get(id)?.kind === "video")
      ? [
          {
            label: "サムネイル",
            submenu: [
              commandItem("item.thumbFile"),
              commandItem("item.thumbClipboard"),
              commandItem("item.thumbSelected"),
              commandItem("item.thumbAdopted"),
              { separator: true as const },
              commandItem("item.thumbReset"),
            ],
          },
        ]
      : []),
    // Stock only; with links off the rows stay, greyed, and say why (docs/UI.md).
    ...(s.mode === "stock"
      ? [
          {
            label: "紐づけ",
            submenu: s.librarySettings.links
              ? [commandItem("item.link"), commandItem("item.unlink"), commandItem("item.makeParent"), commandItem("item.adopt")]
              : [{ label: "親子関係が無効です（設定で有効にできます）", onClick: () => {}, disabled: true }],
          },
        ]
      : []),
    { separator: true },
    commandItem("item.trash", { danger: true }),
  ]);
}

type Rect = { x1: number; y1: number; x2: number; y2: number };

export function Grid() {
  const items = useStore((s) => s.items);
  const sections = useStore((s) => s.sections);
  const selected = useStore((s) => s.selected);
  // Marked only where it tells something: beside other selected items, or unselected.
  const focus = useStore((s) => (s.focus && (s.selected.size > 1 || !s.selected.has(s.focus)) ? s.focus : null));
  const thumbSize = useStore((s) => s.thumbSize);
  const specimenSize = useStore((s) => s.specimenSize);
  const tileSize = useStore((s) => s.tileSize);
  const kind = useStore((s) => s.layout);
  // The font mode's grid draws each family in its font (FontTile), sized on the specimen text row.
  const fontTiles = useStore((s) => s.mode === "font" && s.layout === "grid");
  const groupBy = useStore((s) => s.groupBy);
  const showInfo = useStore((s) => s.showInfo);
  const viewKind = useStore((s) => s.view.kind);
  const kinds = useStore(useShallow(listKinds));
  const keepPick = useStore((s) => s.keepPick);
  // Comparing copies needs their size and format at a glance.
  const info = useMemo(
    () => (viewKind === "similar" ? { ...showInfo, name: true, dims: true, meta: true } : showInfo),
    [viewKind, showInfo],
  );
  const keepIds = useMemo(
    () => new Set(viewKind === "similar" ? similarGroups(items).map((g) => keeperOf(g, keepPick).id) : []),
    [viewKind, items, keepPick],
  );
  const analyzing = useStore((s) => s.analyzing);
  const filtering = useStore((s) => activeConditions(s) > 0);
  const dragIds = useStore((s) => (s.drag?.kind === "items" ? s.drag.ids : null));
  const dragging = useMemo(() => new Set(dragIds ?? []), [dragIds]);
  const reorderable = useStore(
    (s) => s.sort === "manual" && s.view.kind === "folder" && !s.showSubfolders,
  );
  const dropTarget = useStore((s) => (s.drag?.kind === "items" ? s.dropTarget : null));
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const [marquee, setMarquee] = useState<Rect | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth);
      setViewport({ top: el.scrollTop, height: el.clientHeight });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const inner = Math.max(0, width - PAD * 2);
  const placement = useMemo<Placement>(
    () =>
      inner > 0
        ? computeLayout(
            kind,
            items,
            inner,
            kind === "specimen" ? specimenSize : fontTiles ? tileSize : thumbSize,
            info,
            sections,
          )
        : { boxes: [], headers: [], height: 0, label: 0, fit: "cover" },
    [kind, items, inner, thumbSize, specimenSize, tileSize, fontTiles, info, sections],
  );
  const visible = useMemo(
    () => visibleRange(placement, viewport.top - OVERSCAN, viewport.top + viewport.height + OVERSCAN),
    [placement, viewport],
  );

  const layout = useRef({ placement, items });
  layout.current = { placement, items };

  // Re-render on scroll, at most once per frame.
  const frame = useRef(0);
  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = scrollRef.current;
      if (el) setViewport({ top: el.scrollTop, height: el.clientHeight });
    });
  };

  /** Scrolls item `i` into view. */
  const reveal = (i: number) => {
    const el = scrollRef.current;
    const b = layout.current.placement.boxes[i];
    if (!el || !b) return;
    const bottom = b.y + b.h + layout.current.placement.label;
    if (b.y - PAD < el.scrollTop) el.scrollTop = b.y - PAD;
    else if (bottom + PAD > el.scrollTop + el.clientHeight) el.scrollTop = bottom + PAD - el.clientHeight;
  };

  // Keep the focused item on screen when the layout or grouping is switched.
  // Not on every refresh (`sections` is new each time): changing another
  // item, or thumbnails arriving, would pull the list back to it.
  useEffect(() => {
    const i = focusIndex(useStore.getState());
    if (i >= 0) reveal(i);
  }, [kind, groupBy]);

  /** Ids of cells intersecting a rectangle in content coordinates (a family row: all its fonts). */
  const hitTest = (r: Rect): string[] => {
    const { placement, items } = layout.current;
    const top = Math.min(r.y1, r.y2);
    const bottom = Math.max(r.y1, r.y2);
    const left = Math.min(r.x1, r.x2);
    const right = Math.max(r.x1, r.x2);
    const hits: string[] = [];
    placement.boxes.forEach((b, i) => {
      if (b.x <= right && b.x + b.w >= left && b.y <= bottom && b.y + b.h + placement.label >= top) {
        hits.push(...rowIds([items[i]]));
      }
    });
    return hits;
  };

  // Rubber-band selection on empty space; Shift/Cmd/Ctrl adds to the selection.
  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    const el = scrollRef.current;
    if (e.button !== 0 || !el) return;
    const box = el.getBoundingClientRect();
    if (e.clientX - box.left >= el.clientWidth) return; // scrollbar
    const s = useStore.getState();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const base = additive ? [...s.selected] : [];
    if (!additive) s.setSelection([]);
    const toContent = (cx: number, cy: number) => ({
      x: cx - box.left,
      y: cy - box.top + el.scrollTop,
    });
    const start = toContent(e.clientX, e.clientY);
    let pointer = { x: e.clientX, y: e.clientY };
    let moved = false;
    let raf = 0;

    const update = () => {
      const cur = toContent(pointer.x, pointer.y);
      const r = { x1: start.x, y1: start.y, x2: cur.x, y2: cur.y };
      setMarquee(r);
      const hits = new Set(hitTest(r));
      // In list order, so the keyboard goes on from the last one.
      const ids = new Set([...base, ...rowIds(layout.current.items).filter((id) => hits.has(id))]);
      useStore.getState().setSelection([...ids]);
    };
    // Scroll while the pointer is held near the top/bottom edge.
    const tick = () => {
      const edge = 40;
      const dy =
        pointer.y < box.top + edge
          ? -(box.top + edge - pointer.y)
          : pointer.y > box.bottom - edge
            ? pointer.y - (box.bottom - edge)
            : 0;
      if (dy) {
        el.scrollTop += dy / 3;
        update();
      }
      raf = requestAnimationFrame(tick);
    };
    const move = (ev: PointerEvent) => {
      pointer = { x: ev.clientX, y: ev.clientY };
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      if (!moved) {
        moved = true;
        raf = requestAnimationFrame(tick);
      }
      update();
    };
    const up = () => {
      cancelAnimationFrame(raf);
      setMarquee(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Keyboard shortcuts for the list (Eagle-compatible where possible).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as Element).closest?.("input, textarea, select")) return;
      const s = useStore.getState();
      // A dialog, menu or panel is over the list (each marks its overlay
      // `data-modal`): Delete there must not trash the selection behind it.
      if (s.viewer !== null || s.drag || s.picker || s.sheet || s.settingsTab || s.exporting || s.transfer) return;
      if (document.querySelector("[data-modal]")) return;
      const sel = () => [...useStore.getState().selected];

      // Everything with a command (commands.ts): the same table as the menus.
      if (runKey(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      const handled = () => e.preventDefault();

      // Ratings: 0-5, Shift+number rates and moves to the next image.
      const digit = /^(Digit|Numpad)([0-5])$/.exec(e.code);
      if (digit && !mod && !e.altKey) {
        handled();
        const ids = sel();
        if (!ids.length) return;
        void setRating(ids, Number(digit[2]));
        if (e.shiftKey) move(1, false);
        return;
      }

      const cur = focusIndex(s);
      const delta: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2 };
      // A / D act like ← / → (Shift+D is "add to last folder" above).
      const key = !mod && !e.shiftKey && e.code === "KeyA" ? "ArrowLeft" : !mod && !e.shiftKey && e.code === "KeyD" ? "ArrowRight" : e.key;
      if (key in delta && !mod) {
        handled();
        move(delta[key], e.shiftKey);
      } else if ((e.key === " " || e.key === "Enter") && !mod && cur >= 0) {
        handled();
        s.openViewer(cur);
      }
    };
    /** ±1 = previous/next item, ±2 = the box above/below (layout-aware). */
    const move = (d: number, extend: boolean) => {
      const s = useStore.getState();
      const { placement } = layout.current;
      if (!s.items.length || !placement.boxes.length) return;
      const cur = focusIndex(s);
      let next: number;
      if (cur < 0) next = 0;
      else if (Math.abs(d) === 1) next = Math.min(s.items.length - 1, Math.max(0, cur + d));
      else next = neighbour(placement, cur, d < 0 ? "up" : "down");
      focusAt = next;
      s.select(s.items[next].id, extend ? "range" : "only", next);
      reveal(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const Comp = kind === "list" ? ListRow : kind === "specimen" ? SpecimenRow : fontTiles ? FontTile : Cell;
  // The section being read: the last one whose band has reached the top.
  const current = Math.max(0, placement.headers.filter((h) => h.y - PAD <= viewport.top + 4).length - 1);
  const jump = (n: number) => {
    const h = placement.headers[n];
    if (h) scrollRef.current?.scrollTo({ top: Math.max(0, h.y - PAD) });
    useStore.getState().setTocOpen(false);
  };
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {items.length > 0 && <SectionBar items={items} sections={sections} current={current} onJump={jump} />}
    <div
      ref={scrollRef}
      className="@container relative min-h-0 flex-1 overflow-y-auto"
      onScroll={onScroll}
      onPointerDown={onBackgroundPointerDown}
    >
      {items.length === 0 ? (
        <Empty kind={viewKind} kinds={kinds} filtering={filtering} analyzing={analyzing} />
      ) : (
        <div style={{ height: placement.height, position: "relative" }}>
          {marquee && (
            <div
              className="pointer-events-none absolute z-10 rounded-sm border border-accent bg-accent/15"
              style={{
                left: Math.min(marquee.x1, marquee.x2),
                top: Math.min(marquee.y1, marquee.y2),
                width: Math.abs(marquee.x2 - marquee.x1),
                height: Math.abs(marquee.y2 - marquee.y1),
              }}
            />
          )}
          {placement.headers.map((h, n) => (
            <div key={`h${h.start}`} className="absolute left-0" style={{ top: h.y, width }}>
              {viewKind === "similar" ? (
                <GroupHeader items={items} section={sections[n]} keepPick={keepPick} />
              ) : (
                <SectionHeader items={items} section={sections[n]} />
              )}
            </div>
          ))}
          {visible.map((i) => {
            const item = items[i];
            const b = placement.boxes[i];
            return (
              // With tag grouping an image can appear in several sections.
              <div key={`${item.id}:${i}`} className="absolute" style={{ left: b.x, top: b.y }}>
                <Comp
                  item={item}
                  index={i}
                  selected={selected.has(item.id)}
                  focused={item.id === focus}
                  dimmed={dragging.has(item.id)}
                  width={b.w}
                  height={b.h}
                  label={placement.label}
                  fit={placement.fit}
                  info={info}
                  reorderable={reorderable}
                  insert={
                    dropTarget?.startsWith(`item:${item.id}:`)
                      ? dropTarget.endsWith("before")
                        ? "before"
                        : "after"
                      : null
                  }
                  similar={
                    item.group === undefined
                      ? undefined
                      : {
                          keep: keepIds.has(item.id),
                          best: i === 0 || items[i - 1].group !== item.group,
                          match: Math.round((1 - (item.distance ?? 0) / 64) * 100),
                        }
                  }
                  flags={viewKind !== "similar" && viewKind !== "trash" && viewKind !== "system"}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
    </div>
  );
}

/**
 * Above the list, outside its scrolling: the section being read, and the
 * table of contents to jump to any other. One row whether or not the list is
 * in sections, so nothing below moves (docs/UI.md, docs/GROUP_TOC.md).
 */
function SectionBar({
  items,
  sections,
  current,
  onJump,
}: {
  items: Item[];
  sections: Section[];
  current: number;
  onJump: (n: number) => void;
}) {
  const open = useStore((s) => s.tocOpen);
  const setOpen = useStore((s) => s.setTocOpen);
  const grouped = sections.length > 0;
  const unit = (list: Item[]) =>
    list.every((i) => i.kind === "image") ? "枚" : "件";
  const count = (s: Section) =>
    `${s.end - s.start} ${unit(items.slice(s.start, s.end))}`;
  const here = grouped
    ? sections[Math.min(current, sections.length - 1)]
    : null;
  const menu = useRef<HTMLDivElement>(null);

  // Closes on a click elsewhere or Esc; the list keeps its keys meanwhile.
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === "Escape"
          : !menu.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open, setOpen]);
  // The sections went away (grouping switched off): nothing to show open.
  useEffect(() => {
    if (!grouped && open) setOpen(false);
  }, [grouped, open, setOpen]);

  return (
    <div
      ref={menu}
      className="relative z-10 flex h-8 shrink-0 items-center gap-2 border-b border-line px-4 text-xs"
    >
      <span className="truncate font-semibold">{here?.title ?? "すべて"}</span>
      <span className="shrink-0 tabular-nums text-dim">
        {here ? count(here) : `${items.length} ${unit(items)}`}
      </span>
      <button
        disabled={!grouped}
        title={
          grouped ? "グループの目次（⌘⌥J）" : "グループ分けを選ぶと使えます"
        }
        onClick={() => setOpen(!open)}
        className="ml-auto flex min-w-20 items-center justify-center gap-1 rounded-md px-2 py-0.5 ghost disabled:off"
      >
        目次 <ChevronDown size={12} />
      </button>
      {open && (
        <div
          data-modal
          className="absolute right-4 top-8 max-h-80 w-60 overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-xl"
        >
          {sections.map((s, n) => {
            const hex = colorHex(s.color);
            return (
              <button
                key={`${s.start}:${n}`}
                onClick={() => onJump(n)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-white/10 ${n === current ? "bg-white/10 font-semibold" : ""}`}
              >
                {hex && (
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: hex }}
                  />
                )}
                {s.rating ? (
                  <Stars n={s.rating} size={12} />
                ) : (
                  <span className="truncate">{s.title}</span>
                )}
                <span className="ml-auto shrink-0 tabular-nums text-dim">
                  {count(s)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Band above a rating / tag / folder section; clicking it selects the section. */
function SectionHeader({ items, section }: { items: Item[]; section: Section }) {
  const { start, end, title, color, rating } = section;
  const hex = colorHex(color);
  return (
    <div
      className={`flex cursor-default items-center gap-2 text-xs ${start > 0 ? "border-t border-line" : ""}`}
      style={{ height: HEADER - 8, marginLeft: PAD, marginRight: PAD, marginBottom: 8 }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => useStore.getState().setSelection(rowIds(items.slice(start, end)))}
      title="クリックでこの区切りをすべて選択"
    >
      {rating !== undefined && rating > 0 ? <Stars n={rating} size={12} /> : null}
      {hex && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: hex }} />}
      <span className={`truncate font-semibold ${rating === 0 ? "text-dim" : ""}`}>
        {rating !== undefined && rating > 0 ? "" : title}
      </span>
      <span className="shrink-0 text-dim tabular-nums">
        {end - start} {items.slice(start, end).every((i) => i.kind === "image") ? "枚" : "件"}
      </span>
    </div>
  );
}

/** Similar view: names the group and offers to tidy it up. */
function GroupHeader({ items, section, keepPick }: { items: Item[]; section: Section; keepPick: Set<string> }) {
  const { start, end } = section;
  const group = items.slice(start, end);
  const keep = keeperOf(group, keepPick);
  const freed = group.filter((i) => i !== keep).reduce((n, i) => n + i.size, 0);
  return (
    <div
      className={`flex items-center gap-3 text-xs ${start > 0 ? "border-t border-line" : ""}`}
      style={{ height: HEADER - 8, marginLeft: PAD, marginRight: PAD, marginBottom: 8 }}
    >
      <span className="font-semibold">{section.title}</span>
      <span className="text-dim">
        {group.length} 枚 · 整理すると {formatBytes(freed)} 減ります
      </span>
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => dismissDuplicates(group.map((i) => i.id))}
        title="このグループの画像は別物として扱い、今後は候補に出しません"
        className="ml-auto rounded-md px-2 py-0.5 ghost"
      >
        重複ではない
      </button>
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => reviewDuplicates(keepPlan([group], keepPick))}
        title="残す1枚を確認してから、他をゴミ箱へ移動します"
        className="rounded-md px-2 py-0.5 ghost"
      >
        このグループを整理…
      </button>
    </div>
  );
}

function Empty({
  kind,
  kinds,
  filtering,
  analyzing,
}: {
  kind: string;
  kinds: ItemKind[];
  filtering: boolean;
  analyzing: boolean;
}) {
  const systemCount = useStore((s) => s.systemCount);
  const noun = kindsNoun(kinds);
  const only = kinds.length === 1 ? kinds[0] : null;
  if (kind === "trash") return <p className="mt-24 text-center text-dim">ゴミ箱は空です</p>;
  if (kind === "similar")
    return (
      <p className="mt-24 text-center text-dim">
        {analyzing ? "画像を解析しています…" : "似ている画像は見つかりませんでした"}
      </p>
    );
  if (filtering)
    return (
      <div className="mt-24 flex flex-col items-center gap-3 text-dim">
        <p>条件に合う{noun}はありません</p>
        <button
          onClick={() => useStore.getState().clearConditions()}
          className="rounded-md bg-accent-fill px-3 py-1.5 font-medium text-white hover:brightness-110"
        >
          絞り込みをすべて解除
        </button>
      </div>
    );
  if (kind === "system")
    return (
      <p className="mt-24 text-center text-dim">
        {systemCount === null
          ? "この端末のフォントを読み込んでいます…（初めてのときは時間がかかります）"
          : "この端末のフォントは見つかりませんでした"}
      </p>
    );
  if (kind === "unfiled" || kind === "untagged")
    return <p className="mt-24 text-center text-dim">該当する{noun}はありません</p>;
  if (kind === "favorites")
    return (
      <p className="mt-24 text-center text-dim">
        お気に入りはまだありません。{noun}を選んで F キー、またはサムネイルのハートで追加できます
      </p>
    );
  if (kind === "pinned")
    return (
      <p className="mt-24 text-center text-dim">
        ピン留めした{noun}はありません。{noun}を選んで P キーでピン留めすると、どの一覧でも先頭に表示されます
      </p>
    );
  if (kind === "folder")
    return (
      <div className="mt-24 flex flex-col items-center gap-2 text-dim">
        <ImagePlus size={40} strokeWidth={1.25} />
        <p>このフォルダは空です</p>
        <p className="text-xs">{noun}をサイドバーのフォルダへドラッグするか、ここにファイルをドロップして追加</p>
      </div>
    );
  return (
    <div className="mt-24 flex flex-col items-center gap-3 text-dim">
      <ImagePlus size={40} strokeWidth={1.25} />
      <p>
        {only === "font"
          ? "フォントファイルやフォルダをここにドラッグ&ドロップ"
          : only === "file"
            ? "PDF・オフィス文書やフォルダをここにドラッグ&ドロップ"
            : only === "text"
              ? `Markdown・テキスト・CSV やフォルダをここにドラッグ&ドロップ、または ${comboText("Mod+N")} で新しく作る`
            : only === "video"
              ? "動画（MP4・MOV・WebM）やフォルダをここにドラッグ&ドロップ"
            : only === "bookmark"
              ? "ブラウザ拡張で保存するか、URL をクリップボードから貼り付け"
            : only === "image"
              ? "画像やフォルダをここにドラッグ&ドロップ、またはクリップボードから貼り付け"
              : "ファイルやフォルダをここにドラッグ&ドロップ、またはクリップボードから貼り付け"}
      </p>
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={importFilesDialog}
        className="rounded-md bg-accent-fill px-4 py-1.5 font-medium text-white hover:brightness-110"
      >
        {noun}を選択して追加
      </button>
    </div>
  );
}

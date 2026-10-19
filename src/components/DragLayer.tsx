// In-app drag & drop (images -> folder, folder -> folder) built on pointer
// events. HTML5 DnD is avoided because Tauri's native file-drop handling
// disables it on Windows.
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import { addToTray, moveToFolder, reorder, reorderShelf } from "../lib/actions";
import { api, isSystemId, libraryIds, type Folder } from "../lib/api";
import { warn } from "../lib/log";
import { useStore, type Drag } from "../store";

const THRESHOLD = 5;

/**
 * Call from onPointerDown. Starts a drag once the pointer moves a few pixels;
 * otherwise `onClick` runs on release.
 */
export function startPointerDrag(
  e: React.PointerEvent,
  makeDrag: () => { kind: "items"; ids: string[]; from?: "shelf" } | { kind: "folder"; ids: string[] },
  onClick?: () => void,
) {
  if (e.button !== 0) return;
  const sx = e.clientX;
  const sy = e.clientY;
  let dragging = false;
  const move = (ev: PointerEvent) => {
    if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) > THRESHOLD) {
      dragging = true;
      useStore.getState().setDrag({ ...makeDrag(), x: ev.clientX, y: ev.clientY, sx, sy });
    }
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!dragging) onClick?.();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** `ids` without those inside another of them (they go along with it). */
function topmost(folders: Folder[], ids: string[]): string[] {
  return ids.filter((id) => !ids.some((a) => a !== id && isDescendant(folders, id, a)));
}

function isDescendant(folders: Folder[], id: string, ancestor: string): boolean {
  const byId = new Map(folders.map((f) => [f.id, f]));
  for (let f = byId.get(id); f; f = f.parentId ? byId.get(f.parentId) : undefined) {
    if (f.id === ancestor) return true;
  }
  return false;
}

/**
 * The drop target under the pointer, or null if this drag can't go there.
 * "folder:<id>" | "root" | "tray" (the shelf) | "item:<id>:before|after" (manual reordering)
 * | "shelf:<id>:before|after" (reordering the shelf) | "pos:folder:<id>:before|after"
 * (folder reordering among siblings).
 */
function targetAt(x: number, y: number, drag: Drag): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]");
  const t = el?.dataset.drop ?? null;
  if (!t || !el) return null;
  if (drag.kind === "items") {
    // Installed fonts only go on the shelf (docs/SYSTEM_FONTS.md).
    const system = drag.ids.some(isSystemId);
    if (t.startsWith("folder:")) return system ? null : t;
    // From the list: anywhere on the shelf adds. On the shelf: beside another one reorders.
    if (t === "tray") return drag.from === "shelf" ? null : t;
    if (t.startsWith("shelf:")) {
      if (drag.from !== "shelf") return "tray";
      if (drag.ids.includes(t.slice(6))) return null;
      // The shelf's chips stack vertically, one per row.
      const r = el.getBoundingClientRect();
      return `${t}:${y < r.top + r.height / 2 ? "before" : "after"}`;
    }
    if (t.startsWith("item:") && !system && !drag.ids.includes(t.slice(5))) {
      const r = el.getBoundingClientRect();
      // List rows stack vertically; everything else flows left to right.
      const first = el.dataset.axis === "y" ? y < r.top + r.height / 2 : x < r.left + r.width / 2;
      return `${t}:${first ? "before" : "after"}`;
    }
    return null;
  }
  if (t !== "root" && !t.startsWith("folder:")) return null;
  const folders = useStore.getState().folders;
  if (t === "root") {
    const top = drag.ids.every((id) => !folders.find((x) => x.id === id)?.parentId);
    return top ? null : t; // already top-level
  }
  const fid = t.slice(7);
  // A folder can't go into itself or its own subfolders.
  if (drag.ids.some((id) => isDescendant(folders, fid, id))) return null;
  // Top / bottom quarter of a row: place next to it; middle: put inside it.
  const r = el.getBoundingClientRect();
  const rel = (y - r.top) / r.height;
  if (rel < 0.25) return `pos:${t}:before`;
  if (rel > 0.75) return `pos:${t}:after`;
  return t;
}

function targetRect(target: string): DOMRect | null {
  const base = target.replace(/:(before|after)$/, "").replace(/^pos:/, "");
  return document.querySelector(`[data-drop="${CSS.escape(base)}"]`)?.getBoundingClientRect() ?? null;
}

async function drop(drag: Drag, target: string) {
  const s = useStore.getState();
  if (drag.kind === "items" && target.startsWith("item:")) {
    const [, id, side] = target.split(":");
    // Keep the dragged items in their current visual order.
    const moving = s.items.filter((i) => drag.ids.includes(i.id)).map((i) => i.id);
    let before: string | null = id;
    if (side === "after") {
      const rest = s.items.filter((i) => !drag.ids.includes(i.id));
      before = rest[rest.findIndex((i) => i.id === id) + 1]?.id ?? null;
    }
    await reorder(moving, before);
  } else if (drag.kind === "items" && target.startsWith("shelf:")) {
    const [, id, side] = target.split(":");
    const rest = s.shelf.filter((i) => !drag.ids.includes(i.id));
    const before = side === "before" ? id : (rest[rest.findIndex((i) => i.id === id) + 1]?.id ?? null);
    await reorderShelf(drag.ids, before);
  } else if (drag.kind === "items" && target === "tray") {
    await addToTray(drag.ids, { show: true });
  } else if (drag.kind === "items") {
    await moveToFolder(drag.ids, target.slice(7));
  } else if (target.startsWith("pos:")) {
    // "pos:folder:<id>:before|after" → same parent as <id>, next to it.
    const [, , id, side] = target.split(":");
    const ref = s.folders.find((f) => f.id === id);
    if (!ref) return;
    const ids = topmost(s.folders, drag.ids);
    const siblings = s.folders.filter((f) => f.parentId === ref.parentId && !ids.includes(f.id));
    const before =
      side === "before" ? id : (siblings[siblings.findIndex((f) => f.id === id) + 1]?.id ?? null);
    // Each goes in front of the same one, so they keep their order.
    const ok = await s.run(async () => {
      for (const f of ids) await api.placeFolder(f, ref.parentId, before);
    });
    if (ok) s.flashTarget(`folder:${ids[0]}`);
  } else {
    const parent = target === "root" ? null : target.slice(7);
    const ids = topmost(s.folders, drag.ids).filter((f) => s.folders.find((x) => x.id === f)?.parentId !== parent);
    const ok = await s.run(async () => {
      for (const f of ids) await api.moveFolder(f, parent);
    });
    if (ok) s.flashTarget(target);
  }
}

/**
 * Leaving the window with images hands the drag to the OS (drop into other
 * apps). Not the installed fonts: they aren't handed out as files.
 */
function dragOut(drag: Drag & { kind: "items" }) {
  const s = useStore.getState();
  const ids = libraryIds(drag.ids);
  const items = [...s.items, ...s.shelf].filter(
    (i, n, all) => ids.includes(i.id) && all.findIndex((x) => x.id === i.id) === n,
  );
  if (!items.length) return;
  startDrag({ item: items.map((i) => i.filePath), icon: items[0].thumbPath }).catch((e) =>
    warn("drag out failed", e),
  );
}

function targetLabel(target: string | null, folders: Folder[]): string | null {
  if (!target) return null;
  if (target === "root") return "最上位へ移動";
  if (target === "tray") return "シェルフに追加";
  if (target.startsWith("item:") || target.startsWith("shelf:")) return "ここへ並べ替え";
  if (target.startsWith("pos:")) {
    const name = folders.find((f) => f.id === target.split(":")[2])?.name;
    return name ? `「${name}」の${target.endsWith("before") ? "前" : "後"}へ` : null;
  }
  const name = folders.find((f) => f.id === target.slice(7))?.name;
  return name ? `「${name}」へ` : null;
}

export function DragLayer() {
  const drag = useStore((s) => s.drag);
  const dropTarget = useStore((s) => s.dropTarget);
  const items = useStore((s) => s.items);
  const shelf = useStore((s) => s.shelf);
  const folders = useStore((s) => s.folders);
  const ghost = useRef<HTMLDivElement>(null);
  const active = drag !== null;

  useEffect(() => {
    if (!active) return;
    // The cursor over everything while dragging (index.css): a "+" (copy)
    // where the drop adds, the shelf, and a grabbing hand elsewhere.
    const root = document.documentElement;
    root.dataset.dragging = "move";
    let landing = false; // ignore input while the drop animation plays
    const move = (e: PointerEvent) => {
      const s = useStore.getState();
      if (!s.drag || landing) return;
      const edge = 2;
      const outside =
        e.clientX <= edge ||
        e.clientY <= edge ||
        e.clientX >= window.innerWidth - edge ||
        e.clientY >= window.innerHeight - edge;
      if (outside && s.drag.kind === "items" && !("__MOCK_BACKEND__" in window)) {
        landing = true;
        const d = s.drag;
        s.setDrag(null);
        dragOut(d);
        return;
      }
      s.setDrag({ ...s.drag, x: e.clientX, y: e.clientY });
      const target = targetAt(e.clientX, e.clientY, s.drag);
      s.setDropTarget(target);
      root.dataset.dragging = target === "tray" ? "copy" : "move";
    };
    const finish = async (commit: boolean, e?: PointerEvent) => {
      const s = useStore.getState();
      const d = s.drag;
      const el = ghost.current;
      if (!d || landing) return;
      landing = true;
      const target = commit && e ? targetAt(e.clientX, e.clientY, d) : null;
      const rect = target ? targetRect(target) : null;
      // Animate the ghost into the target row, or back to where it came from.
      if (el) {
        const to = rect
          ? { x: rect.left + 24 - d.x - 12, y: rect.top + rect.height / 2 - d.y - 12, scale: 0.2, opacity: 0.2 }
          : { x: d.sx - d.x, y: d.sy - d.y, scale: 0.6, opacity: 0 };
        const duration = rect ? 320 : 260;
        const anim = el.animate(
          [
            { transform: "translate(0,0) scale(1)", opacity: 1 },
            { transform: `translate(${to.x}px, ${to.y}px) scale(${to.scale})`, opacity: to.opacity },
          ],
          { duration, easing: "cubic-bezier(0.5, 0, 0.3, 1)", fill: "forwards" },
        );
        // `finished` can stay pending if the animation is dropped (e.g. the
        // element re-renders), so never wait longer than the animation itself.
        await new Promise<void>((done) => {
          anim.onfinish = anim.oncancel = () => done();
          setTimeout(done, duration + 100);
        });
      }
      s.setDrag(null);
      if (d && target) drop(d, target);
    };
    const up = (e: PointerEvent) => finish(true, e);
    const key = (e: KeyboardEvent) => e.key === "Escape" && finish(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
    return () => {
      delete root.dataset.dragging;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
    };
  }, [active]);

  if (!drag) return null;
  const label = targetLabel(dropTarget, folders);

  return (
    <div
      ref={ghost}
      className="pointer-events-none fixed z-50"
      style={{ left: drag.x + 12, top: drag.y + 12, transformOrigin: "0 0" }}
    >
      {drag.kind === "items" ? (
        <ItemsGhost ids={drag.ids} items={drag.from === "shelf" ? shelf : items} adding={dropTarget === "tray"} />
      ) : (
        <div className="rounded-md bg-raised px-3 py-1.5 shadow-xl ring-1 ring-accent">
          📁 {folders.find((f) => f.id === drag.ids[0])?.name}
          {drag.ids.length > 1 && <span className="ml-1.5 text-xs text-dim">ほか {drag.ids.length - 1} 件</span>}
        </div>
      )}
      <div
        className={`mt-2 flex w-max items-center gap-1 rounded-md px-2 py-0.5 text-xs shadow-lg transition-colors ${
          label ? "bg-accent text-white" : "bg-black/70 text-white/70"
        }`}
      >
        {dropTarget === "tray" && <Plus size={12} strokeWidth={3} />}
        {label ??
          (drag.kind === "items"
            ? drag.ids.some(isSystemId)
              ? "シェルフへドロップ"
              : "フォルダへドロップ / 窓の外で他のアプリへ"
            : "移動先のフォルダへドロップ")}
      </div>
    </div>
  );
}

/** `adding`: over the shelf, where the drop adds rather than moves (a "+" badge, as the OS does for a copy). */
function ItemsGhost({
  ids,
  items,
  adding,
}: {
  ids: string[];
  items: { id: string; thumbPath: string }[];
  adding: boolean;
}) {
  const thumbs = ids
    .slice(0, 3)
    .map((id) => items.find((i) => i.id === id)?.thumbPath)
    .filter(Boolean) as string[];
  return (
    <div className="relative h-20 w-20">
      {thumbs
        .map((t, i) => (
          <img
            key={t}
            src={convertFileSrc(t)}
            draggable={false}
            alt=""
            className="absolute inset-0 h-20 w-20 rounded-lg bg-raised object-cover shadow-xl ring-2 ring-white/80"
            style={{ transform: `rotate(${[0, -7, 6][i]}deg) translate(${i * 3}px, ${i * 2}px)` }}
          />
        ))
        .reverse()}
      {ids.length > 1 && (
        <span className="absolute -top-2 -right-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-danger px-1.5 text-xs font-bold text-white shadow">
          {ids.length}
        </span>
      )}
      {adding && (
        <span className="absolute -top-2 -left-2 flex h-6 w-6 animate-pop items-center justify-center rounded-full bg-success text-white shadow ring-2 ring-white/80">
          <Plus size={15} strokeWidth={3} />
        </span>
      )}
    </div>
  );
}

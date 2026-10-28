// Parent picker dialog (⌘ menu "親に紐づける…", docs/LINKS.md): choose the item
// the selection becomes the children of. Parents are items of the stock that
// aren't children themselves (one level) and aren't part of the selection.
import { convertFileSrc } from "@tauri-apps/api/core";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { linkItems } from "../lib/actions";
import { api, EMPTY_FILTER, sizeLabel, type Item } from "../lib/api";
import { composing } from "../lib/ime";
import { useStore } from "../store";

const MAX_ROWS = 60;

export function ParentPicker() {
  const open = useStore((s) => s.picker === "parent");
  if (!open) return null;
  return <Dialog />;
}

function Dialog() {
  const selectedCount = useStore((s) => s.selected.size);
  const close = () => useStore.getState().setPicker(null);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Item[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // The names that can be a parent now, newest first (the picked ones can't be their own parent).
  useEffect(() => {
    let live = true;
    const picked = new Set(useStore.getState().selected);
    api
      .queryItems({
        view: { kind: "all" },
        search: query.trim(),
        tagIds: [],
        tagMatchAll: false,
        includeSubfolders: false,
        minRating: 0,
        filter: EMPTY_FILTER,
        similarLevel: "standard",
        sort: "importedAt",
        desc: true,
      })
      .then((items) => {
        if (!live) return;
        setRows(items.filter((i) => i.kind !== "font" && !i.parentId && !picked.has(i.id)).slice(0, MAX_ROWS));
        setCursor(0);
      })
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const commit = async (parent: Item) => {
    const ids = [...useStore.getState().selected];
    close();
    await linkItems(parent.id, ids);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (composing(e)) return;
    const n = rows?.length ?? 0;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(n - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter" && rows?.[cursor]) {
      e.preventDefault();
      void commit(rows[cursor]);
    }
  };

  return (
    <div data-modal className="fixed inset-0 z-50 flex animate-fade-in items-start justify-center bg-black/40 pt-[12vh]" onPointerDown={close}>
      <div
        className="flex max-h-[70vh] w-[460px] animate-zoom-in flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-4 pt-3 pb-2">
          <div className="mb-2 text-xs font-semibold text-dim">{selectedCount} 件を紐づける親を選ぶ</div>
          <label className="flex h-9 items-center gap-2 rounded-md border border-edge bg-bg px-2 focus-within:border-accent">
            <Search size={15} className="text-dim" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
              placeholder="親にする項目を検索"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-dim"
            />
          </label>
        </div>
        <div ref={listRef} className="min-h-24 flex-1 overflow-y-auto p-1.5">
          {rows?.length === 0 && <p className="px-3 py-6 text-center text-dim">見つかりません</p>}
          {rows?.map((it, i) => (
            <button
              key={it.id}
              data-index={i}
              onMouseMove={() => setCursor(i)}
              onClick={() => commit(it)}
              className={`flex h-12 w-full items-center gap-2.5 rounded-md px-2 text-left ${i === cursor ? "bg-white/8" : ""}`}
            >
              <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded bg-raised">
                <img src={convertFileSrc(it.thumbPath)} alt="" draggable={false} className="size-full object-contain" />
              </span>
              <span className="min-w-0 flex-1 truncate">{it.name}</span>
              <span className="text-xs text-dim tabular-nums">{sizeLabel(it)}</span>
            </button>
          ))}
        </div>
        <div className="border-t border-line px-4 py-2 text-right text-[11px] text-dim">
          Enter で紐づけ（子は親のフォルダへ移ります。子は 1 つの親にだけ付けられます）
        </div>
      </div>
    </div>
  );
}

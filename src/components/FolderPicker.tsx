// Folder picker dialog.
//   "move" (⌘⇧J / context menu): move the selection into a folder (an item is
//          in one folder at most), or create a new folder inline.
//   "goto" (⌘J): jump to a folder.
import { Clock, Folder as FolderIcon, FolderPlus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { moveToFolder } from "../lib/actions";
import { api, type Folder } from "../lib/api";
import { composing } from "../lib/ime";
import { currentFolderId, useStore } from "../store";

interface Row {
  folder: Folder;
  depth: number;
  path: string;
}

function flatten(folders: Folder[]): Row[] {
  const kids = new Map<string | null, Folder[]>();
  for (const f of folders) {
    if (!kids.has(f.parentId)) kids.set(f.parentId, []);
    kids.get(f.parentId)!.push(f);
  }
  const out: Row[] = [];
  const walk = (parent: string | null, depth: number, prefix: string) => {
    for (const f of kids.get(parent) ?? []) {
      const path = prefix ? `${prefix} / ${f.name}` : f.name;
      out.push({ folder: f, depth, path });
      walk(f.id, depth + 1, path);
    }
  };
  walk(null, 0, "");
  return out;
}

export function FolderPicker() {
  const mode = useStore((s) => s.picker);
  // "parent" is the ParentPicker's.
  if (!mode || mode === "parent") return null;
  return <PickerDialog mode={mode} />;
}

function PickerDialog({ mode }: { mode: "move" | "goto" }) {
  const folders = useStore((s) => s.folders);
  const recent = useStore((s) => s.recentFolders);
  const selectedCount = useStore((s) => s.selected.size);
  const close = () => useStore.getState().setPicker(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const current = currentFolderId();

  const rows = useMemo(() => {
    const all = flatten(folders);
    const q = query.trim().toLowerCase();
    if (q) return all.filter((r) => r.path.toLowerCase().includes(q)).map((r) => ({ ...r, depth: 0 }));
    // Recently used folders first, then the whole tree.
    const recentRows = recent
      .map((id) => all.find((r) => r.folder.id === id))
      .filter(Boolean)
      .map((r) => ({ ...r!, depth: 0, recent: true }));
    return [...recentRows, ...all];
  }, [folders, recent, query]);

  const exact = folders.some((f) => f.name === query.trim());
  const canCreate = mode === "move" && query.trim() !== "" && !exact;
  const total = rows.length + (canCreate ? 1 : 0);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const ids = () => [...useStore.getState().selected];

  const commit = async (folderId: string) => {
    close();
    await moveToFolder(ids(), folderId);
  };

  const createAndMove = async () => {
    const id = await api.createFolder(query.trim(), null, useStore.getState().mode).catch((e) => {
      useStore.getState().toast(String(e), true);
      return null;
    });
    if (id) await commit(id);
  };

  const activate = (i: number) => {
    if (i >= rows.length) return createAndMove();
    const f = rows[i].folder;
    if (mode === "goto") {
      close();
      useStore.getState().setView({ kind: "folder", id: f.id });
    } else {
      void commit(f.id);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (composing(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(total - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      void activate(cursor);
    }
  };

  return (
    <div data-modal className="fixed inset-0 z-50 flex animate-fade-in items-start justify-center bg-black/40 pt-[12vh]" onPointerDown={close}>
      <div
        className="flex max-h-[70vh] w-[460px] animate-zoom-in flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-4 pt-3 pb-2">
          <div className="mb-2 text-xs font-semibold text-dim">
            {mode === "move" ? `${selectedCount} 件をフォルダへ移動` : "フォルダへ移動"}
          </div>
          <label className="flex h-9 items-center gap-2 rounded-md border border-edge bg-bg px-2 focus-within:border-accent">
            <Search size={15} className="text-dim" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
              placeholder={mode === "move" ? "フォルダを検索、または新しい名前を入力" : "フォルダを検索"}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-dim"
            />
          </label>
        </div>
        <div ref={listRef} className="min-h-24 flex-1 overflow-y-auto p-1.5">
          {rows.length === 0 && !canCreate && (
            <p className="px-3 py-6 text-center text-dim">
              {folders.length ? "見つかりません" : "フォルダがありません"}
            </p>
          )}
          {rows.map((r, i) => {
            const isRecent = "recent" in r;
            const firstTree = !query && i === rows.findIndex((x) => !("recent" in x));
            return (
              <div key={`${isRecent ? "r" : "t"}-${r.folder.id}`}>
                {!query && i === 0 && isRecent && <Heading icon={<Clock size={12} />}>最近使ったフォルダ</Heading>}
                {firstTree && recent.length > 0 && <Heading icon={<FolderIcon size={12} />}>すべてのフォルダ</Heading>}
                <button
                  data-index={i}
                  onMouseMove={() => setCursor(i)}
                  onClick={() => activate(i)}
                  className={`flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left ${
                    i === cursor ? "bg-white/8" : ""
                  }`}
                  style={{ paddingLeft: 8 + r.depth * 14 }}
                >
                  <FolderIcon size={15} className="shrink-0 text-dim" />
                  <span className="min-w-0 flex-1 truncate">{query || isRecent ? r.path : r.folder.name}</span>
                  {r.folder.id === current && <span className="text-[11px] text-dim">表示中</span>}
                  <span className="text-xs text-dim tabular-nums">{r.folder.count}</span>
                </button>
              </div>
            );
          })}
          {canCreate && (
            <button
              data-index={rows.length}
              onMouseMove={() => setCursor(rows.length)}
              onClick={createAndMove}
              className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-accent ${
                cursor === rows.length ? "bg-white/8" : ""
              }`}
            >
              <FolderPlus size={15} /> 「{query.trim()}」を作成して移動
            </button>
          )}
        </div>
        {mode === "move" && (
          <div className="border-t border-line px-4 py-2 text-right text-[11px] text-dim">
            Enter で移動（1 枚につき 1 フォルダ。複数の分類にはタグを使います）
          </div>
        )}
      </div>
    </div>
  );
}

function Heading({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[11px] font-semibold text-dim">
      {icon}
      {children}
    </div>
  );
}

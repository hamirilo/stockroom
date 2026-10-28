// The library menu (bottom of the sidebar) and the list of known libraries:
// the ones opened or created before, favourites first. Also used on the
// welcome screen.
import { Check, ChevronUp, FolderOpen, Library, Plus, Settings, Star, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createLibraryDialog, openLibraryAt, openLibraryDialog } from "../lib/actions";
import { api, type LibraryEntry } from "../lib/api";
import { useStore } from "../store";
import { SETTINGS_KEY } from "./SettingsDialog";

export function useLibraries() {
  const [list, setList] = useState<LibraryEntry[] | null>(null);
  const reload = useCallback(() => {
    api.listLibraries().then(setList, (e) => useStore.getState().toast(String(e), true));
  }, []);
  useEffect(reload, [reload]);
  return { list, reload };
}

/** The folder a library is in, shortened for a one-line hint. */
export function parentDir(root: string) {
  const parts = root.split(/[\\/]/).filter(Boolean);
  parts.pop();
  const tail = parts.slice(-2).join("/");
  return parts.length > 2 ? `…/${tail}` : `/${tail}`;
}

export function LibraryRow({
  lib,
  active,
  onClick,
  onFavorite,
  onForget,
  trailing,
}: {
  lib: LibraryEntry;
  active?: boolean;
  onClick: () => void;
  onFavorite?: () => void;
  onForget?: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={lib.exists ? 0 : -1}
      title={lib.exists ? lib.root : `見つかりません：${lib.root}`}
      onClick={() => lib.exists && onClick()}
      onKeyDown={(e) => e.key === "Enter" && lib.exists && onClick()}
      className={`group flex items-center gap-2.5 rounded-md px-2 py-1.5 ${
        lib.exists ? "cursor-pointer" : "cursor-default opacity-45"
      } ${active ? "bg-accent/20 ring-1 ring-accent/60" : lib.exists ? "hover:bg-white/5" : ""}`}
    >
      <Library size={16} className={`shrink-0 ${lib.current || active ? "text-accent" : "text-dim"}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{lib.name}</div>
        <div className="truncate text-[11px] text-dim">{lib.exists ? parentDir(lib.root) : "見つかりません（移動・削除、または外付けドライブ未接続）"}</div>
      </div>
      {trailing}
      {onFavorite && (
        <button
          title={lib.favorite ? "お気に入りから外す" : "お気に入りに追加"}
          onClick={(e) => {
            e.stopPropagation();
            onFavorite();
          }}
          className={`shrink-0 rounded p-1 hover:bg-white/10 ${
            lib.favorite ? "text-yellow-400" : "text-dim opacity-0 group-hover:opacity-100 focus:opacity-100"
          }`}
        >
          <Star size={14} fill={lib.favorite ? "currentColor" : "none"} />
        </button>
      )}
      {onForget && (
        <button
          title="一覧から外す（フォルダは削除しません）"
          onClick={(e) => {
            e.stopPropagation();
            onForget();
          }}
          className="shrink-0 rounded p-1 text-dim opacity-0 group-hover:opacity-100 hover:bg-white/10 hover:text-fg focus:opacity-100"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** Favourites, then recent libraries, each with a star and "remove from list". */
export function LibraryList({ list, reload, onOpen }: { list: LibraryEntry[]; reload: () => void; onOpen: (l: LibraryEntry) => void }) {
  const favorites = list.filter((l) => l.favorite);
  const recent = list.filter((l) => !l.favorite);
  const act = (fn: () => Promise<void>) => fn().then(reload, (e) => useStore.getState().toast(String(e), true));
  const row = (l: LibraryEntry) => (
    <LibraryRow
      key={l.root}
      lib={l}
      onClick={() => onOpen(l)}
      onFavorite={() => act(() => api.setLibraryFavorite(l.root, !l.favorite))}
      onForget={l.current ? undefined : () => act(() => api.forgetLibrary(l.root))}
      trailing={l.current && <Check size={15} className="shrink-0 text-accent" />}
    />
  );
  const heading = "px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-dim";
  return (
    <>
      {favorites.length > 0 && (
        <>
          <div className={heading}>お気に入り</div>
          {favorites.map(row)}
        </>
      )}
      {recent.length > 0 && (
        <>
          <div className={heading}>最近使ったライブラリ</div>
          {recent.map(row)}
        </>
      )}
    </>
  );
}

function MenuButton({ icon, label, hint, onClick }: { icon: React.ReactNode; label: string; hint?: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent-fill hover:text-white"
    >
      <span className="shrink-0 opacity-80">{icon}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="text-xs opacity-50">{hint}</span>}
    </button>
  );
}

/** The library menu, opening upwards from `bottom` px above the window's bottom edge. */
function Panel({ close, bottom }: { close: () => void; bottom: number }) {
  const { list, reload } = useLibraries();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [close]);

  const then = (fn: () => void) => () => {
    close();
    fn();
  };

  return (
    <div data-modal className="fixed inset-0 z-50" onPointerDown={close}>
      <div
        className="absolute left-2 flex max-h-[75vh] w-80 animate-slide-up flex-col overflow-hidden rounded-xl border border-line bg-raised shadow-2xl"
        style={{ bottom }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {list === null ? (
            <div className="p-3 text-dim">読み込み中…</div>
          ) : (
            <LibraryList list={list} reload={reload} onOpen={(l) => then(() => openLibraryAt(l.root))()} />
          )}
        </div>
        <div className="border-t border-line p-1">
          <MenuButton icon={<FolderOpen size={15} />} label="ほかのライブラリを開く…" onClick={then(openLibraryDialog)} />
          <MenuButton icon={<Plus size={15} />} label="新しいライブラリを作成…" onClick={then(createLibraryDialog)} />
        </div>
        {/* Everything else about the app and this library (browser extension,
            updates, moving items to another library) is in the settings. */}
        <div className="border-t border-line p-1">
          <MenuButton
            icon={<Settings size={15} />}
            label="設定…"
            hint={SETTINGS_KEY}
            onClick={then(() => useStore.getState().openSettings("general"))}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The sidebar's footer: the open library's name, opens the library panel
 * above it. Switched less often than the kinds, so it sits at the bottom.
 */
export function LibrarySwitcher() {
  const library = useStore((s) => s.library);
  const [bottom, setBottom] = useState<number | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setBottom(null), []);
  const toggle = () => {
    const r = ref.current?.getBoundingClientRect();
    setBottom(bottom === null && r ? window.innerHeight - r.top + 4 : null);
  };
  return (
    <div className="shrink-0 border-t border-line p-1.5">
      <button
        ref={ref}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-white/5 ${
          bottom !== null ? "bg-white/5" : ""
        }`}
        title={`ライブラリ：${library?.root ?? ""}`}
        onClick={toggle}
      >
        <Library size={15} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{library?.name}</span>
        <ChevronUp size={14} className={`shrink-0 text-dim transition-transform ${bottom !== null ? "rotate-180" : ""}`} />
      </button>
      {bottom !== null && <Panel close={close} bottom={bottom} />}
    </div>
  );
}

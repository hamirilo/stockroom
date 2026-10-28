import { FolderOpen, Library, Plus } from "lucide-react";
import { createLibraryDialog, openLibraryAt, openLibraryDialog } from "../lib/actions";
import { LibraryList, useLibraries } from "./LibrarySwitcher";

export function Welcome() {
  const { list, reload } = useLibraries();
  const btn =
    "flex w-64 items-center justify-center gap-2 rounded-md px-4 py-2.5 font-medium hover:brightness-110";
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 overflow-y-auto py-8">
      <Library size={56} strokeWidth={1.25} className="text-accent" />
      <div className="text-center">
        <h1 className="text-xl font-semibold">Stockroom</h1>
        <p className="mt-1 text-dim">画像はライブラリフォルダにコピーして管理されます</p>
      </div>
      <div className="flex flex-col gap-2">
        <button onClick={createLibraryDialog} className={`${btn} bg-accent-fill text-white`}>
          <Plus size={16} /> 新しいライブラリを作成
        </button>
        <button onClick={openLibraryDialog} className={`${btn} border border-edge bg-control`}>
          <FolderOpen size={16} /> 既存のライブラリを開く
        </button>
      </div>
      {list && list.length > 0 && (
        <div className="w-80 rounded-xl border border-line bg-panel p-1">
          <LibraryList list={list} reload={reload} onOpen={(l) => openLibraryAt(l.root)} />
        </div>
      )}
    </div>
  );
}

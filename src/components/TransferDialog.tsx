// "別のライブラリへ": copies or moves the selection (or every item of the
// current kind) into another library, with tags, folder, rating, favourite
// and note (src-tauri/src/transfer.rs).
import { ArrowRight, Copy, FolderInput, FolderOpen, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { createLibraryOnly, pickLibraryFolder, transferTo } from "../lib/actions";
import { kindLabel, type LibraryEntry } from "../lib/api";
import { useStore, type TransferRequest } from "../store";
import { LibraryRow, useLibraries } from "./LibrarySwitcher";

const LAST_DEST = "transferDest";

function lastDest(): string | null {
  try {
    return localStorage.getItem(LAST_DEST);
  } catch {
    return null;
  }
}

export function TransferDialog() {
  const req = useStore((s) => s.transfer);
  if (!req) return null;
  return <Dialog req={req} />;
}

const nameOf = (root: string) => root.split(/[\\/]/).filter(Boolean).pop()?.replace(/\.library$/, "") ?? root;

function Dialog({ req }: { req: TransferRequest }) {
  const close = () => useStore.getState().setTransfer(null);
  const { list, reload } = useLibraries();
  // Picked with "ほかのライブラリ…", not on the list yet.
  const [extra, setExtra] = useState<LibraryEntry[]>([]);
  const [dest, setDest] = useState<string | null>(null);
  // Moving everything of a kind is a migration; a selection is more often a copy.
  const [move, setMove] = useState(req.ids === null);

  const targets = [...extra, ...(list ?? []).filter((l) => !l.current && !extra.some((x) => x.root === l.root))];

  useEffect(() => {
    if (dest || !list) return;
    const last = lastDest();
    const pick = targets.find((l) => l.root === last && l.exists) ?? targets.find((l) => l.exists);
    if (pick) setDest(pick.root);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const addExtra = (root: string) => {
    if (root === useStore.getState().library?.root) {
      useStore.getState().toast("いま開いているライブラリです", true);
      return;
    }
    if (!targets.some((l) => l.root === root)) {
      setExtra((x) => [{ root, name: nameOf(root), favorite: false, lastOpened: 0, exists: true, current: false }, ...x]);
    }
    setDest(root);
  };

  const run = () => {
    const target = targets.find((l) => l.root === dest);
    if (!target) return;
    try {
      localStorage.setItem(LAST_DEST, target.root);
    } catch {
      /* not essential */
    }
    close();
    transferTo(target, req.ids ? { ids: req.ids } : { kind: req.kind }, move);
  };

  const what = req.ids === null ? `すべての${kindLabel(req.kind)} ${req.count} 件` : `${req.noun} ${req.count} 件`;
  const option = (on: boolean, icon: React.ReactNode, title: string, sub: string, value: boolean) => (
    <button
      onClick={() => setMove(value)}
      className={`flex flex-1 items-start gap-2 rounded-lg border p-2.5 text-left ${
        on ? "border-accent bg-accent/15" : "border-edge hover:bg-white/5"
      }`}
    >
      <span className={`mt-0.5 ${on ? "text-accent" : "text-dim"}`}>{icon}</span>
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-dim">{sub}</span>
      </span>
    </button>
  );

  return (
    <div data-modal className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/50" onPointerDown={close}>
      <div
        className="flex max-h-[85vh] w-[520px] max-w-[92vw] animate-zoom-in flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-5 pt-4 pb-3">
          <div className="flex items-center gap-2 text-base font-semibold">
            <FolderInput size={18} className="text-accent" />
            別のライブラリへ
          </div>
          <p className="mt-1 text-xs text-dim">
            {what}を、タグ・フォルダ・評価・お気に入り・メモごと移します。移し先に同じファイルがあれば、
            二重にはせずタグとフォルダだけを統合します。
          </p>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          <div className="flex gap-2">
            {option(move, <FolderInput size={16} />, "移動", "このライブラリではゴミ箱へ（元に戻せます）", true)}
            {option(!move, <Copy size={16} />, "コピー", "このライブラリにも残す", false)}
          </div>

          <div>
            <div className="mb-1.5 text-xs font-semibold text-dim">移し先</div>
            <div className="flex flex-col gap-0.5 rounded-lg border border-line p-1">
              {list === null ? (
                <div className="p-2 text-dim">読み込み中…</div>
              ) : targets.length === 0 ? (
                <div className="p-2 text-xs text-dim">ほかのライブラリがまだありません。下のボタンから選ぶか作成してください。</div>
              ) : (
                targets.map((l) => (
                  <LibraryRow key={l.root} lib={l} active={dest === l.root} onClick={() => setDest(l.root)} />
                ))
              )}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={async () => {
                  const p = await pickLibraryFolder();
                  if (p) addExtra(p);
                }}
                className="flex items-center gap-1.5 rounded-md border border-edge bg-control px-2.5 py-1 text-xs hover:bg-white/12"
              >
                <FolderOpen size={13} /> ほかのライブラリを選ぶ…
              </button>
              <button
                onClick={async () => {
                  const lib = await createLibraryOnly();
                  if (lib) {
                    reload();
                    addExtra(lib.root);
                  }
                }}
                className="flex items-center gap-1.5 rounded-md border border-edge bg-control px-2.5 py-1 text-xs hover:bg-white/12"
              >
                <Plus size={13} /> 新しいライブラリを作成…
              </button>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button onClick={close} className="rounded-md px-3 py-1.5 hover:bg-white/5">
            キャンセル
          </button>
          <button
            disabled={!dest}
            onClick={run}
            className="flex items-center gap-1.5 rounded-md bg-accent-fill px-4 py-1.5 font-medium text-white hover:brightness-110 disabled:off disabled:bg-control"
          >
            {move ? "移動する" : "コピーする"}
            {dest && (
              <>
                <ArrowRight size={14} />
                <span className="max-w-40 truncate">{targets.find((l) => l.root === dest)?.name}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

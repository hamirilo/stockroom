// 書き出し…: copies the files of a list into a folder (docs/MENUS.md §4). A
// folder can be written with its subfolders, keeping their structure
// ("旅行/2025/京都/…"). ライブラリ全体を書き出し… copies everything into a new
// "<library name>" folder laid out like the app's folders (docs/EXPORT.md).
// The files are copied as they are; format conversion and resizing (ROADMAP
// phase 3) will be added to this dialog.
import { open } from "@tauri-apps/plugin-dialog";
import { FolderDown, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { listTargets, writeLibrary } from "../lib/actions";
import { api, modeOf, type Folder, type Item, type ItemKind } from "../lib/api";
import { itemsNoun, MODES, modeLabel } from "../lib/modes";
import { notifyIfAway } from "../lib/osNotify";
import { composing } from "../lib/ime";
import { useStore, type ListSource } from "../store";

const LAST_DEST = "exportDest";

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function ExportDialog() {
  const req = useStore((s) => s.exporting);
  if (!req) return null;
  return req.source.kind === "library" ? (
    <LibraryDialog title={req.title} />
  ) : (
    <Dialog source={req.source} title={req.title} />
  );
}

const close = () => useStore.getState().setExporting(null);

function useEscapeToClose() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !composing(e) && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function remember(dest: string) {
  try {
    localStorage.setItem(LAST_DEST, dest);
  } catch {
    /* not essential */
  }
}

/**
 * Per item, its folder relative to `rootId` as "旅行/2025/京都" (the root's
 * own name first); "" for items outside it.
 */
export function relativeDirs(items: Item[], rootId: string, folders: Folder[]): string[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const memo = new Map<string, string>();
  const pathOf = (id: string | null): string => {
    if (!id) return "";
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const names: string[] = [];
    let cur = byId.get(id);
    while (cur && cur.id !== rootId) {
      names.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    // Not under the root folder: no structure for it.
    const path = cur ? [cur.name, ...names].join("/") : "";
    memo.set(id, path);
    return path;
  };
  return items.map((i) => pathOf(i.folderId));
}

function Dialog({ source, title }: { source: ListSource; title: string }) {
  const folders = useStore((s) => s.folders);
  const isFolder = source.kind === "folder";
  const hasSubfolders = isFolder && folders.some((f) => f.parentId === (source as { id: string }).id);
  const [subfolders, setSubfolders] = useState(true);
  const [structure, setStructure] = useState(true);
  const [items, setItems] = useState<Item[] | null>(null);
  const [dest, setDest] = useState<string | null>(() => load(LAST_DEST));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setItems(null);
    listTargets(source, subfolders).then(
      (xs) => live && setItems(xs),
      (e) => useStore.getState().toast(String(e), true),
    );
    return () => {
      live = false;
    };
  }, [source, subfolders]);

  useEscapeToClose();

  const keep = isFolder && hasSubfolders && subfolders && structure;
  const dirs = useMemo(
    () => (keep && items && source.kind === "folder" ? relativeDirs(items, source.id, folders) : null),
    [keep, items, source, folders],
  );

  const run = async () => {
    if (!dest || !items?.length) return;
    remember(dest);
    setBusy(true);
    const since = Date.now();
    try {
      const n = await api.exportItems(
        items.map((i) => i.id),
        dest,
        dirs ?? undefined,
      );
      close();
      useStore.getState().notify({
        title: `${n} 件を書き出しました`,
        detail: dest,
        kind: "success",
        action: { label: "書き出し先を表示", onClick: () => useStore.getState().run(() => api.revealPath(dest)) },
      });
      notifyIfAway(since, `${n} 件を書き出しました`, dest);
    } catch (e) {
      useStore.getState().toast(String(e), true);
    } finally {
      setBusy(false);
    }
  };

  const check = (on: boolean, set: (v: boolean) => void, label: string, hint: string, disabled = false) => (
    <label className={`flex items-start gap-2.5 py-1 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
        checked={on}
        disabled={disabled}
        onChange={(e) => set(e.target.checked)}
      />
      <span>
        {label}
        <span className="mt-0.5 block text-xs text-dim">{hint}</span>
      </span>
    </label>
  );

  const rootName = isFolder ? folders.find((f) => f.id === (source as { id: string }).id)?.name : "";

  return (
    <Frame
      title={title}
      summary={
        items === null
          ? "数えています…"
          : `${itemsNoun(items)} ${items.length} 件${isFolder && hasSubfolders && subfolders ? "（サブフォルダを含む）" : ""}`
      }
      ready={!!dest && !!items?.length && !busy}
      busy={busy}
      run={run}
    >
      {isFolder && hasSubfolders && (
        <div>
          {check(subfolders, setSubfolders, "サブフォルダを含める", "中のフォルダにある項目も書き出します")}
          {check(
            structure,
            setStructure,
            "フォルダ構成を保つ",
            `書き出し先に「${rootName}/…」のフォルダを作ります。オフなら書き出し先にすべて並べます`,
            !subfolders,
          )}
        </div>
      )}
      <DestField dest={dest} setDest={setDest} note="同じ名前のファイルがあるときは「名前 (2)」のように番号を付けます" />
    </Frame>
  );
}

/**
 * ライブラリ全体を書き出し: every item not in the trash, into a new
 * "<library name>" folder in "<mode>/<folders>/…". The copying runs after the
 * dialog closes, with progress and a キャンセル (`writeLibrary`).
 */
function LibraryDialog({ title }: { title: string }) {
  const kinds = useStore((s) => s.counts.kinds);
  const name = useStore((s) => s.library?.name ?? "");
  const [dest, setDest] = useState<string | null>(() => load(LAST_DEST));
  useEscapeToClose();

  const byMode = MODES.map((m) => {
    const n = (Object.entries(kinds) as [ItemKind, number][])
      .filter(([k]) => modeOf(k) === m)
      .reduce((a, [, c]) => a + c, 0);
    return { m, n };
  }).filter((x) => x.n > 0);
  const total = byMode.reduce((a, x) => a + x.n, 0);

  const run = () => {
    if (!dest || !total) return;
    remember(dest);
    close();
    void writeLibrary(dest);
  };

  return (
    <Frame
      title={title}
      summary={`${total.toLocaleString()} 件${byMode.length > 1 ? `（${byMode.map((x) => `${modeLabel(x.m)} ${x.n.toLocaleString()}`).join("・")}）` : ""}`}
      ready={!!dest && total > 0}
      busy={false}
      run={run}
    >
      <DestField
        dest={dest}
        setDest={setDest}
        note={`「${name}」フォルダを作り、フォルダ構成どおりに書き出します（同じ名前があれば「${name} (2)」）。ゴミ箱の項目は含めません`}
      />
    </Frame>
  );
}

function Frame({
  title,
  summary,
  ready,
  busy,
  run,
  children,
}: {
  title: string;
  /** What is written ("画像 12 件"). */
  summary: string;
  ready: boolean;
  busy: boolean;
  run: () => void;
  children: React.ReactNode;
}) {
  return (
    <div data-modal className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/50" onPointerDown={close}>
      <div
        role="dialog"
        className="w-[480px] max-w-[92vw] animate-zoom-in rounded-xl border border-line bg-panel shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-5 pt-4 pb-3">
          <div className="flex items-center gap-2 text-base font-semibold">
            <FolderDown size={18} className="text-accent" />
            {title}
          </div>
          <p className="mt-1 text-xs text-dim tabular-nums">
            対象：{summary}。ファイルはそのままの形式でコピーします
          </p>
        </div>

        <div className="space-y-3 px-5 py-4">{children}</div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button onClick={close} className="h-8 rounded-md border border-edge bg-control px-3 hover:bg-white/12">
            キャンセル
          </button>
          <button
            autoFocus
            disabled={!ready}
            onClick={run}
            className="h-8 rounded-md bg-accent-fill px-4 font-medium text-white enabled:hover:brightness-110 disabled:off disabled:bg-control"
          >
            {busy ? "書き出し中…" : "書き出し"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DestField({ dest, setDest, note }: { dest: string | null; setDest: (d: string) => void; note: string }) {
  const pick = async () => {
    const p = await open({ title: "書き出し先のフォルダを選択", directory: true, defaultPath: dest ?? undefined });
    if (typeof p === "string") setDest(p);
  };
  return (
    <div>
      <div className="mb-1 text-xs text-dim">書き出し先</div>
      <div className="flex items-center gap-2">
        <code
          className={`min-w-0 flex-1 truncate rounded-md border border-edge bg-bg px-2 py-1.5 text-xs ${dest ? "" : "text-dim"}`}
          title={dest ?? undefined}
        >
          {dest ?? "フォルダを選んでください"}
        </code>
        <button
          onClick={pick}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-edge bg-control px-3 text-xs hover:bg-white/12"
        >
          <FolderOpen size={14} />
          選ぶ…
        </button>
      </div>
      <p className="mt-1 text-[11px] text-dim">{note}</p>
    </div>
  );
}

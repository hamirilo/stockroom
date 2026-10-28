// The details panel for fonts installed on this computer (docs/SYSTEM_FONTS.md):
// the same rows as a library font's, read only, with where the file is.
// Rating, tags, folder and note are library things, so they aren't offered;
// the shelf is (to compare it with the library's fonts).
import { FolderOpen, Layers, Monitor } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatBytes, type Item } from "../../lib/api";
import { onShelf, toggleTray } from "../../lib/actions";
import { useStore } from "../../store";
import { fontApi } from "./api";
import { FontDetails } from "./FontDetails";
import { holdFont, loadFont } from "./loader";

/** A few characters in the font, where a library item shows its thumbnail. */
function Glyphs({ item }: { item: Item }) {
  const [family, setFamily] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFamily(null);
    setFailed(false);
    const release = holdFont(item.id);
    loadFont(item.id)
      .then((f) => live && setFamily(f))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      release();
    };
  }, [item.id]);
  return (
    <div
      className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-raised"
      onDoubleClick={() => {
        const s = useStore.getState();
        s.openViewer(s.items.findIndex((i) => i.id === item.id));
      }}
    >
      {failed ? (
        <span className="text-xs text-dim">見本を表示できません</span>
      ) : (
        <span
          className={`text-6xl transition-opacity ${family ? "" : "opacity-0"}`}
          style={{ fontFamily: family ? `"${family}"` : undefined }}
        >
          {item.fontScript === "latin" ? "Aa" : "あ永A"}
        </span>
      )}
    </div>
  );
}

/** What the details panel shows for a selection (`ids`) with installed fonts in it. */
export function SystemFontPanel({ single, ids }: { single: Item | undefined; ids: string[] }) {
  const run = useStore((s) => s.run);
  const shelf = useStore((s) => s.shelf);
  const shelved = useMemo(() => shelf.length > 0 && onShelf(ids), [shelf, ids]);
  return (
    <>
      {single ? (
        <>
          <Glyphs item={single} />
          <div className="mt-3 px-1 text-sm font-semibold break-words">{single.name}</div>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-1 text-xs">
            <dt className="text-dim">種類</dt>
            <dd>この端末のフォント</dd>
            <dt className="text-dim">形式</dt>
            <dd>
              {single.ext.toUpperCase()} · {formatBytes(single.size)}
            </dd>
            <FontDetails item={single} />
            <dt className="text-dim">場所</dt>
            <dd className="min-w-0">
              <button
                className="flex max-w-full items-start gap-1 text-left text-accent hover:underline"
                title="Finder / エクスプローラで表示"
                onClick={() => run(() => fontApi.revealSystem(single.id))}
              >
                <FolderOpen size={12} className="mt-0.5 shrink-0" />
                <span className="break-all">{single.filePath}</span>
              </button>
            </dd>
            {single.importedAt > 0 && (
              <>
                <dt className="text-dim">更新日</dt>
                <dd>{new Date(single.importedAt).toLocaleString("ja-JP")}</dd>
              </>
            )}
          </dl>
        </>
      ) : (
        <div className="rounded-lg bg-raised p-4 text-center">
          <div className="text-2xl font-semibold tabular-nums">{ids.length}</div>
          <div className="text-dim">件を選択中</div>
        </div>
      )}
      <button
        onClick={() => void toggleTray(ids)}
        title="シェルフに置いて、ライブラリのフォントと並べて比べる（B）"
        className={`mt-4 flex h-8 items-center justify-center gap-1.5 rounded-md border border-edge bg-control hover:bg-white/12 ${
          shelved ? "text-emerald-400" : ""
        }`}
      >
        <Layers size={14} />
        {shelved ? "シェルフから外す" : "シェルフに追加"}
      </button>
      <div className="mt-4 flex gap-2 rounded-lg border border-line/70 p-3 text-xs text-dim">
        <Monitor size={14} className="mt-0.5 shrink-0" />
        <p>
          この端末にインストールされているフォントです。読み取り専用で、ライブラリには入りません。
          評価・タグ・フォルダ・メモは、ライブラリのフォントだけに使えます。
        </p>
      </div>
    </>
  );
}

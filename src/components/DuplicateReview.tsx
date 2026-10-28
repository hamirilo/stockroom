// Confirmation for tidying duplicates: shows, per group, which copy stays,
// which go to the trash, and what the kept copy inherits — before anything changes.
import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowRight, Check, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { confirmDuplicates } from "../lib/actions";
import { formatBytes, sizeLabel, type DuplicateEffect, type Item } from "../lib/api";
import { useStore } from "../store";

export function DuplicateReview() {
  const review = useStore((s) => s.review);
  const folders = useStore((s) => s.folders);
  const close = () => useStore.getState().setReview(null);

  const open = review !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!review) return null;
  const removed = review.groups.flatMap((g) => g.remove);
  const effects = review.effects;
  const folderName = (id: string) => folders.find((f) => f.id === id)?.name ?? "";
  const tags = new Set(effects?.flatMap((e) => e.addedTags)).size;

  return (
    <div data-modal className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/50" onPointerDown={close}>
      <div
        className="flex max-h-[80vh] w-[720px] max-w-[92vw] animate-zoom-in flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-5 pt-4 pb-3">
          <div className="text-base font-semibold">重複を整理</div>
          <p className="mt-1 text-xs text-dim">
            {review.groups.length} グループ・{removed.length} 枚をゴミ箱へ移動します（約{" "}
            {formatBytes(removed.reduce((n, i) => n + i.size, 0))} 減）。残す1枚を変えるには、キャンセルして一覧の「これを残す」を押してください。
          </p>
          <p className="mt-2 text-xs">
            {effects === null ? (
              <span className="text-dim">引き継ぐ内容を確認中…</span>
            ) : (
              <>
                <span className="text-dim">残す1枚に引き継ぐもの：</span>{" "}
                {tags > 0 || effects.some((e) => e.rating != null || e.folderId)
                  ? [
                      tags > 0 ? `タグ ${tags} 種` : "",
                      effects.some((e) => e.rating != null) ? "評価（高い方）" : "",
                      effects.some((e) => e.folderId) ? "フォルダ（未分類の場合のみ）" : "",
                    ]
                      .filter(Boolean)
                      .join("、")
                  : "なし"}
              </>
            )}
          </p>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {review.groups.map((g) => (
            <GroupRow
              key={g.keep.id}
              keep={g.keep}
              remove={g.remove}
              effect={effects?.find((e) => e.keep === g.keep.id)}
              folderName={folderName}
            />
          ))}
        </div>

        <div className="flex items-center gap-3 border-t border-line px-5 py-3">
          <span className="flex-1 text-[11px] text-dim">
            完全には削除されず、ゴミ箱から戻せます。引き継いだタグ・評価は戻しても残ります。
          </span>
          <button onClick={close} className="h-8 rounded-md border border-edge bg-control px-3 hover:bg-white/12">
            キャンセル
          </button>
          <button
            disabled={effects === null}
            onClick={() => confirmDuplicates()}
            className="h-8 rounded-md bg-accent-fill px-3 font-medium text-white enabled:hover:brightness-110 disabled:off disabled:bg-control"
          >
            {removed.length} 枚をゴミ箱へ移動
          </button>
        </div>
      </div>
    </div>
  );
}

function GroupRow({
  keep,
  remove,
  effect,
  folderName,
}: {
  keep: Item;
  remove: Item[];
  effect?: DuplicateEffect;
  folderName: (id: string) => string;
}) {
  const carried = effect
    ? [
        effect.addedTags.length ? `タグ ${effect.addedTags.map((t) => `「${t}」`).join("")}` : "",
        effect.rating != null ? `評価 ★${effect.rating}` : "",
        effect.folderId ? `フォルダ「${folderName(effect.folderId)}」` : "",
      ].filter(Boolean)
    : [];
  return (
    <div className="rounded-lg border border-line bg-bg/40 p-3">
      <div className="flex items-start gap-3">
        <Card item={keep} keep />
        <ArrowRight size={16} className="mt-12 shrink-0 text-dim" />
        <div className="flex min-w-0 flex-1 flex-wrap gap-3">
          {remove.map((i) => (
            <Card key={i.id} item={i} />
          ))}
        </div>
      </div>
      {effect && (
        <p className="mt-2 text-[11px] text-dim">
          {carried.length ? `「残す」に引き継ぎ：${carried.join(" / ")}` : "引き継ぐタグ・評価・フォルダはありません"}
        </p>
      )}
    </div>
  );
}

function Card({ item, keep = false }: { item: Item; keep?: boolean }) {
  return (
    <div className="w-28 shrink-0 text-[11px]">
      <div
        className={`relative flex h-24 items-center justify-center overflow-hidden rounded-md bg-raised ring-2 ${
          keep ? "ring-emerald-500" : "ring-transparent"
        }`}
      >
        <img
          src={convertFileSrc(item.thumbPath)}
          alt=""
          draggable={false}
          className={`max-h-full max-w-full object-contain ${keep ? "" : "opacity-60"}`}
        />
        <span
          className={`absolute top-1 left-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-white ${
            keep ? "bg-emerald-600/90" : "bg-danger/85"
          }`}
        >
          {keep ? <Check size={10} strokeWidth={3} /> : <Trash2 size={10} />}
          {keep ? "残す" : "ゴミ箱へ"}
        </span>
      </div>
      <div className="mt-1 truncate" title={item.name}>
        {item.name}
      </div>
      <div className="truncate text-dim tabular-nums">
        {sizeLabel(item)}
      </div>
      <div className="truncate text-dim tabular-nums">
        {item.ext.toUpperCase()} · {formatBytes(item.size)}
      </div>
    </div>
  );
}

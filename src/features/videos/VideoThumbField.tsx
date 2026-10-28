// The details panel's "サムネイル" section body, for one video (docs/VIDEO.md):
// the thumbnail the list shows, where to take another from, and the way back
// to the frame from the OS. The buttons stay, greyed out with why, when one
// can't be used (docs/UI.md).
import { convertFileSrc } from "@tauri-apps/api/core";
import { Clipboard, FileImage, RotateCcw, Star } from "lucide-react";
import { pickVideoThumb, resetVideoThumb, setVideoThumb } from "../../lib/actions";
import type { Item } from "../../lib/api";
import { useStore } from "../../store";

const btn =
  "flex h-7 items-center gap-1.5 rounded-md border border-edge bg-control px-2 text-xs hover:bg-white/12 disabled:pointer-events-none disabled:off disabled:bg-transparent";

export function VideoThumbField({ item }: { item: Item }) {
  const links = useStore((s) => s.librarySettings.links);
  const adopted = useStore((s) => s.rawItems.some((i) => i.parentId === item.id && i.adopted));
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded bg-raised">
          <img src={convertFileSrc(item.thumbPath)} alt="" draggable={false} className="size-full object-contain" />
        </span>
        <span className="text-xs text-dim">{item.ownThumb ? "設定した画像" : "動画のコマ"}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button className={btn} onClick={() => void pickVideoThumb(item.id)}>
          <FileImage size={13} /> 画像ファイル…
        </button>
        <button className={btn} onClick={() => void setVideoThumb(item.id, { from: "clipboard" })}>
          <Clipboard size={13} /> クリップボード
        </button>
        <button
          className={btn}
          disabled={!links || !adopted}
          title={
            !links
              ? "設定で親子関係を有効にしてください"
              : adopted
                ? "採用の印を付けた子の画像をサムネイルにする"
                : "子のどれかを「採用にする」と使えます"
          }
          onClick={() => void setVideoThumb(item.id, { from: "adopted" })}
        >
          <Star size={13} /> 採用した子
        </button>
        <button
          className={btn}
          disabled={!item.ownThumb}
          title={item.ownThumb ? undefined : "いまは動画のコマです"}
          onClick={() => void resetVideoThumb(item.id)}
        >
          <RotateCcw size={13} /> 動画のコマに戻す
        </button>
      </div>
    </div>
  );
}

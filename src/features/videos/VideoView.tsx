import { convertFileSrc } from "@tauri-apps/api/core";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { openSelection } from "../../lib/actions";
import type { Item } from "../../lib/api";

/**
 * The viewer's body for videos (docs/VIDEO.md): the web view plays the stored
 * file itself, so only what it can decode plays (H.264 / AAC in MP4 / MOV and
 * WebM do; others show the thumbnail and "open in the default app").
 * The keys the viewer uses to go to the next item and close are the player's
 * too (Space, arrows): while the player has the focus they go to it.
 */
export function VideoView({ item }: { item: Item }) {
  // Kept with its item, so the previous item's failure never shows for this one.
  const [failed, setFailed] = useState<string>();
  if (failed === item.id) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 p-10">
        <img
          src={convertFileSrc(item.thumbPath)}
          alt={item.name}
          draggable={false}
          className="min-h-0 max-w-full rounded-md object-contain shadow-2xl"
        />
        <p className="text-sm text-white/60">この動画は内蔵のプレーヤーで再生できません</p>
        <button
          onClick={() => openSelection([item.id])}
          className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:brightness-110"
        >
          <ExternalLink size={15} />
          既定のアプリで開く
        </button>
      </div>
    );
  }
  return (
    <video
      key={item.id}
      src={convertFileSrc(item.filePath)}
      poster={convertFileSrc(item.thumbPath)}
      controls
      autoPlay
      playsInline
      preload="metadata"
      onError={() => setFailed(item.id)}
      onKeyDown={(e) => {
        if (e.key === " " || e.key.startsWith("Arrow")) e.nativeEvent.stopPropagation();
      }}
      className="absolute inset-0 h-full w-full bg-black object-contain outline-none"
    />
  );
}

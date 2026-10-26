import { convertFileSrc } from "@tauri-apps/api/core";
import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { openSelection } from "../../lib/actions";
import type { Item } from "../../lib/api";
import { useStore } from "../../store";

/** J / L: how far a press seeks. */
const SEEK_S = 10;

/** , / .: one frame (the file's frame rate isn't known; 30 fps is the usual). */
const FRAME_S = 1 / 30;

/**
 * The viewer's body for videos (docs/VIDEO.md): the web view plays the stored
 * file itself, so only what it can decode plays (H.264 / AAC in MP4 / MOV and
 * WebM do; others show the thumbnail and "open in the default app").
 * The viewer's keys stay the viewer's whatever was clicked (Space closes,
 * arrows go to the next item); the player has its own: K plays / pauses,
 * J / L seek, , / . step a frame while paused.
 */
export function VideoView({ item }: { item: Item }) {
  // Kept with its item, so the previous item's failure never shows for this one.
  const [failed, setFailed] = useState<string>();
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = ref.current;
      if (!v || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if ((e.target as Element).closest?.("input, textarea, select")) return;
      if (useStore.getState().settingsTab) return;
      if (e.code === "KeyK") {
        if (v.paused) void v.play();
        else v.pause();
      } else if (e.code === "KeyJ" || e.code === "KeyL") {
        const t = v.currentTime + (e.code === "KeyL" ? SEEK_S : -SEEK_S);
        v.currentTime = Math.min(Math.max(0, t), v.duration || t);
      } else if ((e.code === "Comma" || e.code === "Period") && v.paused) {
        v.currentTime = Math.max(0, v.currentTime + (e.code === "Period" ? FRAME_S : -FRAME_S));
      } else {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
      ref={ref}
      key={item.id}
      src={convertFileSrc(item.filePath)}
      poster={convertFileSrc(item.thumbPath)}
      controls
      autoPlay
      playsInline
      preload="metadata"
      tabIndex={-1}
      onError={() => setFailed(item.id)}
      // Clicking the controls (the seek bar, play) focuses the player, whose own
      // Space and arrows would then win over the viewer's: give the focus back
      // when the pointer is let go, outside the player too (a seek bar dragged off).
      onPointerDown={(e) => {
        const v = e.currentTarget;
        window.addEventListener("pointerup", () => v.blur(), { once: true });
      }}
      onKeyDown={(e) => {
        if (e.key === " " || e.key.startsWith("Arrow")) e.preventDefault();
      }}
      className="absolute inset-0 h-full w-full bg-black object-contain outline-none"
    />
  );
}

import { FlipHorizontal2, FlipVertical2, Heart, HeartOff, PackageMinus, Pin, PinOff, Star, Undo2 } from "lucide-react";
import { RotateLeft, RotateRight } from "../lib/icons";
import { create } from "zustand";
import type { OrientOp } from "../lib/api";

/**
 * What an operation just did, for the ones that give no other sign: rating
 * with a number key, F / P, rotating, taking off the shelf out of its sight,
 * ⌘Z. The thumbnail may not show the change
 * (ratings are hidden by default) or may be off screen, so a short note
 * appears at the bottom centre and the changed thumbnails flash once.
 * Operations done on the control itself (the heart, the stars) skip it.
 */
export type HudContent =
  | { kind: "rating"; rating: number }
  | { kind: "favorite" | "pin"; on: boolean }
  | { kind: "orient"; op: OrientOp }
  | { kind: "shelfOff" }
  /** ⌘Z took back `label` (docs/NOTIFICATIONS.md). */
  | { kind: "undo"; label: string };

type HudState = {
  /** `n` restarts the animation when the same thing is done again. */
  hud: (HudContent & { count: number; n: number }) | null;
  /** The items just changed. */
  pulse: { ids: Set<string>; n: number } | null;
};

const useHud = create<HudState>(() => ({ hud: null, pulse: null }));
let seq = 0;
/** How long the note stays; `animate-hud` fades it in and out within this. */
const SHOWN_MS = 1400;

export function showHud(content: HudContent, ids: string[]) {
  const n = ++seq;
  useHud.setState({ hud: { ...content, count: ids.length, n }, pulse: { ids: new Set(ids), n } });
  // A timer rather than the animation's end: with reduced motion the
  // animation is cut to nothing and the note should still be read.
  setTimeout(() => seq === n && useHud.setState({ hud: null, pulse: null }), SHOWN_MS);
}

const ORIENT: Record<OrientOp, { icon: typeof Star; text: string }> = {
  rotateCcw: { icon: RotateLeft, text: "左に回転しました" },
  rotateCw: { icon: RotateRight, text: "右に回転しました" },
  flipH: { icon: FlipHorizontal2, text: "左右反転しました" },
  flipV: { icon: FlipVertical2, text: "上下反転しました" },
  reset: { icon: Undo2, text: "元の向きに戻しました" },
};

function Body({ hud }: { hud: HudContent }) {
  switch (hud.kind) {
    case "rating":
      if (!hud.rating)
        return (
          <>
            <Star size={16} className="text-white/60" />
            評価を外しました
          </>
        );
      return (
        <>
          <span className="flex gap-0.5">
            {[1, 2, 3, 4, 5].map((i) => (
              <Star
                key={i}
                size={16}
                strokeWidth={1.5}
                className={i <= hud.rating ? "text-amber-400" : "text-white/30"}
                fill={i <= hud.rating ? "currentColor" : "none"}
              />
            ))}
          </span>
          評価 {hud.rating}
        </>
      );
    case "favorite":
      return hud.on ? (
        <>
          <Heart size={16} className="text-pink-400" fill="currentColor" />
          お気に入りに追加しました
        </>
      ) : (
        <>
          <HeartOff size={16} className="text-white/60" />
          お気に入りから外しました
        </>
      );
    case "pin":
      return hud.on ? (
        <>
          <Pin size={16} className="text-accent" fill="currentColor" />
          ピン留めしました
          <span className="text-white/60">一覧の先頭に表示</span>
        </>
      ) : (
        <>
          <PinOff size={16} className="text-white/60" />
          ピン留めを外しました
        </>
      );
    case "shelfOff":
      return (
        <>
          <PackageMinus size={16} className="text-white/60" />
          シェルフから外しました
        </>
      );
    case "undo":
      return (
        <>
          <Undo2 size={16} className="text-accent" />
          取り消しました
          <span className="text-white/60">{hud.label}</span>
        </>
      );
    case "orient": {
      const { icon: Icon, text } = ORIENT[hud.op];
      return (
        <>
          <Icon size={16} className="text-accent" />
          {text}
        </>
      );
    }
  }
}

export function ActionHud() {
  const hud = useHud((s) => s.hud);
  if (!hud) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-28 z-50 flex justify-center px-4">
      <div
        key={hud.n}
        role="status"
        className="flex animate-hud items-center gap-2 rounded-full border border-white/10 bg-black/80 px-4 py-2 text-sm font-medium whitespace-nowrap text-white shadow-2xl shadow-black/50 backdrop-blur"
        style={{ animationDuration: `${SHOWN_MS}ms` }}
      >
        <Body hud={hud} />
        {hud.count > 1 && <span className="font-normal text-white/60 tabular-nums">{hud.count} 件</span>}
      </div>
    </div>
  );
}

/** A flash over a thumbnail or row when its item was just changed (see `showHud`). */
export function ChangePulse({ id, className = "rounded-lg" }: { id: string; className?: string }) {
  const n = useHud((s) => (s.pulse?.ids.has(id) ? s.pulse.n : 0));
  return n ? <span key={n} className={`pointer-events-none absolute inset-0 animate-change-pulse ${className}`} /> : null;
}

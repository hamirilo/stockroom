// The details panel on the right: two tabs, the selection's information
// (Inspector.tsx) and the shelf (Shelf.tsx). The tab changes only when the
// user picks one, or drops things on the shelf: while things are dragged from
// the list the shelf is shown where the drop goes; added there, it stays the
// tab (addToTray), else the panel goes back as it was (docs/UI.md). A closed
// panel shows the shelf over the list for the drag, so the list under the
// pointer doesn't move.
import { ChevronDown, ChevronRight, Info, Layers } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { dragRegion } from "../lib/titleBar";
import { useStore, type PanelTab } from "../store";
import { Inspector } from "./Inspector";
import { Shelf } from "./Shelf";

/** How long the shelf stays after a drop on it that added nothing (already there, full), so the reason can be read. */
const LINGER_MS = 900;

/** The shelf is shown for a drag: from the list while it lasts, a moment longer after a drop on it. */
export function useShelfPeek(): boolean {
  const dragging = useStore((s) => s.drag?.kind === "items" && s.drag.from !== "shelf");
  const over = useStore((s) => s.dropTarget === "tray");
  const [linger, setLinger] = useState(false);
  const dropped = useRef(false);
  useEffect(() => {
    if (dragging) dropped.current = over;
  }, [dragging, over]);
  useEffect(() => {
    if (dragging || !dropped.current) return;
    dropped.current = false;
    setLinger(true);
    const t = setTimeout(() => setLinger(false), LINGER_MS);
    return () => clearTimeout(t);
  }, [dragging]);
  return dragging || linger;
}

/** `peek`: shown for a drag (useShelfPeek), on the shelf whatever the chosen tab. */
export function DetailsPanel({ peek }: { peek: boolean }) {
  const chosen = useStore((s) => s.panelTab);
  const width = useStore((s) => s.inspectorWidth);
  const layout = useStore((s) => s.shelfLayout);
  const tab: PanelTab = peek ? "shelf" : chosen;
  // 置き方「情報の下に並べる」（docs/SHELF.md「置き方」）。
  if (layout === "split") return <SplitPanel peek={peek} width={width} />;
  return (
    <aside className="flex shrink-0 flex-col border-l border-line bg-panel" style={{ width }}>
      <div {...dragRegion()} className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2" role="tablist">
        <TabButton tab="info" current={tab} icon={<Info size={14} />} label="情報" />
        <TabButton tab="shelf" current={tab} icon={<Layers size={14} className="text-emerald-600 dark:text-emerald-400" />} label="シェルフ" />
      </div>
      {tab === "info" ? <Inspector /> : <Shelf />}
    </aside>
  );
}

function TabButton({
  tab,
  current,
  icon,
  label,
}: {
  tab: PanelTab;
  current: PanelTab;
  icon: React.ReactNode;
  label: string;
}) {
  const on = tab === current;
  const shelf = useStore((s) => s.shelf.length);
  // Added while the shelf is out of view: its count lights up.
  const flash = useStore((s) => (tab === "shelf" && s.flash?.target === "tray" ? s.flash.n : null));
  return (
    <button
      role="tab"
      aria-selected={on}
      onClick={() => useStore.getState().setPanelTab(tab)}
      title={tab === "info" ? "選択したものの情報（⌘/Ctrl+I）" : "シェルフ（⌘/Ctrl+Alt+3）"}
      className={`flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium ${
        on ? "bg-ink/10 text-fg" : "text-dim hover:bg-ink/5 hover:text-fg"
      }`}
    >
      {icon}
      {label}
      {tab === "shelf" && (
        <span
          key={flash ?? undefined}
          className={`min-w-5 rounded-full px-1.5 tabular-nums ${flash !== null && !on ? "animate-pop bg-accent-fill text-white" : "bg-ink/10 text-dim"}`}
        >
          {shelf}
        </span>
      )}
    </button>
  );
}

/**
 * 情報の上、シェルフの下に並べる置き方。境目の帯をドラッグしてシェルフの高さを変え、押すとシェルフを
 * 見出しだけに畳む（開け閉めは利用者の操作のときだけ。一覧からのドラッグ中だけは開いて見せる。docs/UI.md）。
 */
function SplitPanel({ peek, width }: { peek: boolean; width: number }) {
  const height = useStore((s) => s.shelfHeight);
  const folded = useStore((s) => s.shelfFolded);
  const count = useStore((s) => s.shelf.length);
  const open = peek || !folded;
  const drag = useRef<{ y: number; h: number; moved: boolean } | null>(null);
  return (
    <aside className="flex shrink-0 flex-col border-l border-line bg-panel" style={{ width }}>
      <div {...dragRegion()} className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-4 text-xs font-medium">
        <Info size={14} /> 情報
      </div>
      <Inspector />
      <div
        role="separator"
        aria-orientation="horizontal"
        title="ドラッグでシェルフの高さを変える。押すと畳む・開く（⌘/Ctrl+Alt+3）"
        onPointerDown={(e) => {
          drag.current = { y: e.clientY, h: height, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || !open) return;
          if (Math.abs(e.clientY - d.y) > 3) d.moved = true;
          if (d.moved) useStore.getState().setShelfHeight(d.h + (d.y - e.clientY));
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) useStore.getState().setShelfFolded(!folded);
        }}
        className={`flex h-9 shrink-0 cursor-row-resize items-center gap-1.5 border-t border-line px-3 text-xs font-medium select-none hover:bg-ink/5 ${open ? "border-b" : ""}`}
      >
        {open ? <ChevronDown size={13} className="text-dim" /> : <ChevronRight size={13} className="text-dim" />}
        <Layers size={14} className="text-emerald-600 dark:text-emerald-400" />
        シェルフ
        <span className="min-w-5 rounded-full bg-ink/10 px-1.5 text-center text-dim tabular-nums">{count}</span>
      </div>
      {open && (
        <div className="flex shrink-0 flex-col" style={{ height: `min(${height}px, 70%)` }}>
          <Shelf />
        </div>
      )}
    </aside>
  );
}

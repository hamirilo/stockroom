// The details panel on the right: two tabs, the selection's information
// (Inspector.tsx) and the shelf (Shelf.tsx). The tab changes only when the
// user picks one, except while things are dragged from the list: then the
// shelf is shown where the drop goes, and the panel goes back as it was
// (docs/UI.md). A closed panel shows the shelf over the list for that time,
// so the list under the pointer doesn't move.
import { Info, Layers } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { dragRegion } from "../lib/titleBar";
import { FONT_SHELF_MAX, useStore, type PanelTab } from "../store";
import { Inspector } from "./Inspector";
import { Shelf } from "./Shelf";

/** How long the shelf stays after a drop on it, so the new rows can be seen arriving. */
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
  const tab: PanelTab = peek ? "shelf" : chosen;
  return (
    <aside className="flex shrink-0 flex-col border-l border-line bg-panel" style={{ width }}>
      <div {...dragRegion()} className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2" role="tablist">
        <TabButton tab="info" current={tab} icon={<Info size={14} />} label="情報" />
        <TabButton tab="shelf" current={tab} icon={<Layers size={14} className="text-emerald-400" />} label="シェルフ" />
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
  const fonts = useStore((s) => s.mode === "font");
  // Added while the shelf is out of view: its count lights up.
  const flash = useStore((s) => (tab === "shelf" && s.flash?.target === "tray" ? s.flash.n : null));
  return (
    <button
      role="tab"
      aria-selected={on}
      onClick={() => useStore.getState().setPanelTab(tab)}
      title={tab === "info" ? "選択したものの情報" : "シェルフ（⌘/Ctrl+Alt+3 で情報と切り替え）"}
      className={`flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium ${
        on ? "bg-white/10 text-fg" : "text-dim hover:bg-white/5 hover:text-fg"
      }`}
    >
      {icon}
      {label}
      {tab === "shelf" && (
        <span
          key={flash ?? undefined}
          className={`min-w-5 rounded-full px-1.5 tabular-nums ${flash !== null && !on ? "animate-pop bg-accent text-white" : "bg-white/10 text-dim"}`}
        >
          {fonts ? `${shelf}/${FONT_SHELF_MAX}` : shelf}
        </span>
      )}
    </button>
  );
}

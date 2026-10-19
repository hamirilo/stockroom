// A font on the shelf: a character in the font itself and its name.
import { Monitor } from "lucide-react";
import { useEffect, useState } from "react";
import { isSystemId, type Item } from "../../lib/api";
import { holdFont, loadFont } from "./loader";
import { weightName } from "./weights";

/** The font of `id`, loaded while shown (its CSS family once loaded); nothing for a font not here. */
function useLoadedFont(id: string, unavailable?: boolean): string | null {
  const [family, setFamily] = useState<string | null>(null);
  useEffect(() => {
    if (unavailable) return;
    let live = true;
    const release = holdFont(id);
    loadFont(id)
      .then((f) => live && setFamily(f))
      .catch(() => {});
    return () => {
      live = false;
      release();
    };
  }, [id, unavailable]);
  return family;
}

/** "Aa" or "あ" in the font, where a font has no rendered sample (an installed font in the viewer's strip). */
export function FontMark({ item, className }: { item: Item; className?: string }) {
  const family = useLoadedFont(item.id);
  return (
    <span
      className={`transition-opacity ${family ? "" : "opacity-40"} ${className ?? ""}`}
      style={{ fontFamily: family ? `"${family}"` : undefined }}
    >
      {item.fontScript === "latin" ? "Aa" : "あ"}
    </span>
  );
}

/**
 * The font's mark and name, for the shelf's chip (the chip itself is
 * Shelf.tsx's). An installed font has a screen beside its name; one this
 * computer doesn't have only its name, struck through (docs/SYSTEM_FONTS.md).
 */
export function FontShelfLabel({ item }: { item: Item }) {
  const family = useLoadedFont(item.id, item.unavailable);
  if (item.unavailable)
    return (
      <span
        className="min-w-0 flex-1 truncate pl-1 text-dim line-through"
        title={`${item.name}：この端末にインストールされていないフォントです（別の端末でシェルフに置いたもの）`}
      >
        {item.name}
      </span>
    );
  return (
    <>
      <span
        className={`w-6 shrink-0 text-center text-base leading-none transition-opacity ${family ? "" : "opacity-40"}`}
        style={{ fontFamily: family ? `"${family}"` : undefined }}
      >
        {item.fontScript === "latin" ? "Aa" : "あ"}
      </span>
      {isSystemId(item.id) && (
        <span title="この端末のフォント" className="shrink-0 text-dim">
          <Monitor size={11} />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate" title={item.name}>
        {item.fontFamily || item.name}
        {/* Which of the family's styles, unless it is the regular. */}
        {item.fontFamily && (item.fontWeight ?? 400) !== 400 && (
          <span className="ml-1 text-dim">{weightName(item.fontWeight)}</span>
        )}
      </span>
    </>
  );
}

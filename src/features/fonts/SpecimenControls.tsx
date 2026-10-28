// The font mode's specimen text row (toolbar): the text every font shows, the
// pattern menu, and at the right end the size the slider sets — the text in
// the specimen layout, the tiles in the grid. It stays in every layout so the
// controls below it don't move (docs/UI.md, docs/FONT_UI.md).
import { ALargeSmall, Check, ChevronDown, Minus, Plus, Save, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { TILE_SIZE, useStore } from "../../store";
import { composing } from "../../lib/ime";
import { command } from "../../lib/commands";
import { Slider } from "../../components/Slider";
import { OWN_SAMPLE, ownPatternName, PATTERN_GROUPS, patternName, type Pattern } from "./patterns";

/** What the slider sets in each layout. */
function useSize() {
  const grid = useStore((s) => s.layout === "grid");
  const specimenSize = useStore((s) => s.specimenSize);
  const setSpecimenSize = useStore((s) => s.setSpecimenSize);
  const tileSize = useStore((s) => s.tileSize);
  const setTileSize = useStore((s) => s.setTileSize);
  return grid
    ? { value: tileSize, set: setTileSize, min: TILE_SIZE.min, max: TILE_SIZE.max, step: 10, what: "タイル" }
    : { value: specimenSize, set: setSpecimenSize, min: 12, max: 160, step: 2, what: "見本の文字" };
}

export function SpecimenControls() {
  const text = useStore((s) => s.specimenText);
  const setText = useStore((s) => s.setSpecimenText);
  const own = useStore(useShallow((s) => s.librarySettings.patterns));
  const size = useSize();
  const zoom = (id: "view.zoomIn" | "view.zoomOut") => command(id).run(useStore.getState());
  const step = "flex h-6 w-5 shrink-0 items-center justify-center rounded text-dim hover:bg-white/8 hover:text-fg";
  const name = patternName(text, own);

  return (
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <ALargeSmall size={15} className="shrink-0 text-dim" />
      <div className="flex h-7 min-w-32 flex-1 items-center rounded-md border border-edge bg-bg focus-within:border-accent">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && !composing(e) && (setText(""), e.currentTarget.blur())}
          placeholder="見本の文字を入力（空欄なら各フォントの見本）"
          className="h-full min-w-0 flex-1 bg-transparent px-2 text-[13px] outline-none placeholder:text-dim"
        />
        {/* Hidden while empty, its room kept (docs/UI.md). */}
        <button
          title="見本の文字を消す（Esc）"
          onClick={() => setText("")}
          className={`mr-1 shrink-0 text-dim hover:text-fg ${text ? "" : "invisible"}`}
        >
          <X size={14} />
        </button>
        <PatternMenu name={name} text={text} own={own} />
      </div>
      <div className="flex shrink-0 items-center">
        <button title={`${size.what}を小さく（⌘-）`} onClick={() => zoom("view.zoomOut")} className={step}>
          <Minus size={13} />
        </button>
        {/* Narrow toolbar: the − / + steps alone, so the typed text keeps its room. */}
        <Slider
          min={size.min}
          max={size.max}
          step={size.step}
          value={size.value}
          onChange={(e) => size.set(Number(e.target.value))}
          title={`${size.what}の大きさ（⌘+ / ⌘-）`}
          className="mx-1 w-24 @max-2xl:hidden"
        />
        <button title={`${size.what}を大きく（⌘+）`} onClick={() => zoom("view.zoomIn")} className={step}>
          <Plus size={13} />
        </button>
      </div>
      <span className="w-12 shrink-0 text-dim tabular-nums">{size.value}px</span>
    </div>
  );
}

/**
 * The pattern button (named after the current pattern, fixed width) and its
 * menu: the user's own patterns first, each font's own sample, then the
 * ready-made ones under what they check.
 */
function PatternMenu({ name, text, own }: { name: string; text: string; own: string[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const setText = useStore((s) => s.setSpecimenText);
  const fallback = useStore((s) => s.specimenFallback);
  const setFallback = useStore((s) => s.setSpecimenFallback);
  const save = useStore((s) => s.saveSpecimenPattern);
  const remove = useStore((s) => s.removeSpecimenPattern);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const pick = (t: string) => {
    setText(t);
    setOpen(false);
  };
  const canSave = !!text.trim() && !own.includes(text) && name === "自由入力";
  const heading = "px-2 pt-2 pb-1 text-[11px] font-semibold text-dim";
  const row = (p: Pattern, key: string, onRemove?: () => void) => (
    <div
      key={key}
      className={`group flex w-full items-center gap-2 rounded px-2 py-1 hover:bg-white/8 ${p.text === text ? "text-fg" : "text-fg/85"}`}
    >
      <button onClick={() => pick(p.text)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Check size={12} className={`shrink-0 text-accent ${p.text === text ? "" : "invisible"}`} />
        <span className="w-28 shrink-0 truncate">{p.label}</span>
        <span className="min-w-0 flex-1 truncate text-dim">{p.text || "フォントごとに、そのフォントにある字で"}</span>
        {p.check && <span className="shrink-0 text-[11px] text-dim/70">{p.check}</span>}
      </button>
      {onRemove && (
        <button
          title="このパターンを消す"
          onClick={onRemove}
          className="shrink-0 rounded p-0.5 text-dim opacity-0 group-hover:opacity-100 hover:bg-white/10 hover:text-fg"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );

  return (
    <div ref={ref} className="relative h-full shrink-0">
      <button
        title={`見本のパターン：${name}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        // Fixed width: the name changes, the controls beside it don't move.
        // Narrower with the toolbar, where the name alone stands for it.
        className={`flex h-full w-48 items-center @max-3xl:w-32 gap-1.5 border-l border-line px-2 text-left hover:text-fg ${
          open ? "text-fg" : "text-dim"
        }`}
      >
        <span className="shrink-0 @max-3xl:hidden">パターン</span>
        <span className="min-w-0 flex-1 truncate text-fg">{name}</span>
        <ChevronDown size={12} className="shrink-0" />
      </button>
      {open && (
        <div
          data-modal
          className="absolute top-full right-0 z-40 mt-1 max-h-[70vh] w-[34rem] max-w-[calc(100vw-2rem)] animate-slide-down overflow-y-auto rounded-lg border border-line bg-raised p-1 text-xs shadow-xl"
        >
          <div className="flex items-center justify-between pr-1">
            <div className={heading}>自分のパターン</div>
            <button
              disabled={!canSave}
              onClick={() => save(text)}
              title={canSave ? "入力欄の文字をこのライブラリのパターンとして保存" : "入力欄に新しい文字を入れると保存できます"}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-accent enabled:hover:bg-accent/15 disabled:off"
            >
              <Save size={12} /> 今の文字を保存
            </button>
          </div>
          {own.length ? (
            own.map((t) => row({ label: ownPatternName(t), text: t }, `own:${t}`, () => remove(t)))
          ) : (
            <p className="px-2 pb-1 text-dim/70">よく使う文字を入力して「今の文字を保存」</p>
          )}
          <div className="mx-1.5 my-1 border-t border-line" />
          {row(OWN_SAMPLE, "own-sample")}
          {PATTERN_GROUPS.map((g) => (
            <div key={g.heading}>
              <div className={heading}>{g.heading}</div>
              {g.patterns.map((p) => row(p, p.label))}
            </div>
          ))}
          <div className="mx-1.5 my-1 border-t border-line" />
          <label className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 hover:bg-white/8">
            <input
              type="checkbox"
              checked={fallback}
              onChange={(e) => setFallback(e.target.checked)}
              className="accent-accent"
            />
            足りないフォントは各フォントの見本で
            <span className="text-dim">半分以上の字が無いとき</span>
          </label>
        </div>
      )}
    </div>
  );
}

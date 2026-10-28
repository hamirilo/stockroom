// The comparison of the font shelf, shown in place of the list: one row per
// font, its name and the style to compare on the left, the same texts drawn
// in each on the right. Fonts are always rows (no other arrangement), the
// first line the letters and figures. docs/FONT_UI.md (比較ビュー).
import { ArrowLeft, Heart, Minus, Monitor, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { removeFromShelf, setRating } from "../../lib/actions";
import { api, EMPTY_FILTER, fontCategoryLabel, fontCategoryOf, isSystemId, type Item } from "../../lib/api";
import { composing } from "../../lib/ime";
import { RatingStars } from "../../components/RatingStars";
import { Slider } from "../../components/Slider";
import { FONT_SHELF_MAX, useStore } from "../../store";
import { fontChars, holdFont, loadFont } from "./loader";
import { patternText } from "./patterns";
import { systemFamily } from "./system";
import { Sample } from "./Sample";
import { weightName } from "./weights";

/** First line of a Japanese font (one line, the rest cut off). */
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 !?&@#$%*()[]{}<>/+-=";
/** A Latin font's two lines: the letters, then figures and punctuation. */
const LATIN_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz";
const LATIN_FIGURES = "0123456789 !?&@#$%*()[]{}<>/+-=.,:;'\"";

/** What a Japanese font's second and third lines can be made of (the pattern menu's texts). */
const ASPECTS = ["かな", "漢字", "見出し", "本文", "約物", "混植"] as const;
type Aspect = (typeof ASPECTS)[number];
const ASPECT_PATTERN: Record<Aspect, string> = {
  かな: "かな",
  漢字: "漢字",
  見出し: "見出し",
  本文: "本文",
  約物: "約物（全角）",
  混植: "和欧混植",
};
const FIRST_ASPECTS: Aspect[] = ["かな", "漢字", "約物", "混植"];

const SIZE = { min: 14, max: 72, initial: 24 };

// Remembered between sessions like the list's display choices (localStorage, best effort).
const load = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const persist = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
};
const loadAspects = (): Aspect[] => {
  try {
    const v = JSON.parse(load("compareAspects") ?? "null");
    return Array.isArray(v) ? ASPECTS.filter((a) => v.includes(a)) : FIRST_ASPECTS;
  } catch {
    return FIRST_ASPECTS;
  }
};

/** Japanese, Chinese and Korean fonts get the kana / kanji lines; Latin ones their letters only. */
const isLatin = (item: Item) => item.fontScript === "latin";

const isItalic = (i: Item) => /italic|oblique|イタリック/i.test(i.name);
const styleName = (i: Item) => `${weightName(i.fontWeight)}${isItalic(i) ? " Italic" : ""}`;
const byWeight = (a: Item, b: Item) =>
  (a.fontWeight ?? 400) - (b.fontWeight ?? 400) || Number(isItalic(a)) - Number(isItalic(b));

export function CompareView() {
  const shelf = useStore((s) => s.shelf);
  const rev = useStore((s) => s.rev);
  const setComparing = useStore((s) => s.setComparing);
  const [size, setSize] = useState(() => {
    const v = Number(load("compareSize"));
    return v >= SIZE.min && v <= SIZE.max ? v : SIZE.initial;
  });
  const [light, setLight] = useState(load("compareLight") === "true");
  const [aspects, setAspects] = useState<Aspect[]>(loadAspects);
  const [own, setOwn] = useState(load("compareText") ?? "");
  const [editing, setEditing] = useState(false);
  /** Shelf font id -> the style of its family being compared (this session only). */
  const [chosen, setChosen] = useState<Record<string, string>>({});
  /** Every font of the library by family, to offer each row its family's styles. */
  const [families, setFamilies] = useState<Map<string, Item[]>>(new Map());
  /** The same for the installed fonts on the shelf: their family among the installed ones. */
  const [systemFamilies, setSystemFamilies] = useState<Map<string, Item[]>>(new Map());
  const systemNames = useMemo(
    () => [
      ...new Set(shelf.flatMap((i) => (isSystemId(i.id) && !i.unavailable && i.fontFamily ? [i.fontFamily] : []))),
    ],
    [shelf],
  );
  useEffect(() => {
    let live = true;
    Promise.all(systemNames.map(async (f) => [f, (await systemFamily(f)).sort(byWeight)] as const))
      .then((list) => live && setSystemFamilies(new Map(list)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [systemNames]);

  useEffect(() => {
    let live = true;
    api
      .queryItems({
        view: { kind: "all" },
        search: "",
        tagIds: [],
        tagMatchAll: false,
        includeSubfolders: false,
        minRating: 0,
        filter: { ...EMPTY_FILTER, kinds: ["font"] },
        similarLevel: "standard",
        sort: "name",
        desc: false,
      })
      .then((fonts) => {
        if (!live) return;
        const m = new Map<string, Item[]>();
        for (const f of fonts) {
          if (!f.fontFamily) continue;
          if (!m.has(f.fontFamily)) m.set(f.fontFamily, []);
          m.get(f.fontFamily)!.push(f);
        }
        for (const list of m.values()) list.sort(byWeight);
        setFamilies(m);
      })
      .catch((e) => useStore.getState().toast(String(e), true));
    return () => {
      live = false;
    };
  }, [rev]);

  // Esc goes back to the list (unless a menu or dialog is over it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || composing(e)) return;
      if ((e.target as Element).closest?.("input, textarea, select")) return;
      if (document.querySelector("[data-modal]")) return;
      setComparing(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setComparing]);

  const changeSize = (px: number) => {
    const v = Math.min(SIZE.max, Math.max(SIZE.min, Math.round(px)));
    setSize(v);
    persist("compareSize", String(v));
  };
  const toggleAspect = (a: Aspect) => {
    const next = aspects.includes(a) ? aspects.filter((x) => x !== a) : ASPECTS.filter((x) => x === a || aspects.includes(x));
    setAspects(next);
    persist("compareAspects", JSON.stringify(next));
  };
  const changeOwn = (t: string) => {
    setOwn(t);
    persist("compareText", t);
  };

  const fonts = shelf.filter((i) => i.kind === "font").slice(0, FONT_SHELF_MAX);
  const left = FONT_SHELF_MAX - fonts.length;
  const step = "flex h-6 w-5 shrink-0 items-center justify-center rounded text-dim hover:bg-white/8 hover:text-fg";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-line px-4 py-2 text-xs">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setComparing(false)}
            title="一覧へ戻る（Esc）"
            className="-ml-1 flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-white/5"
          >
            <ArrowLeft size={14} /> 一覧へ戻る
          </button>
          <span className="text-[13px] font-semibold">
            比較 <span className="font-normal text-dim tabular-nums">{fonts.length} / {FONT_SHELF_MAX}</span>
          </span>
          <span className="text-dim">{left > 0 ? `あと ${left} 件置けます` : "シェルフはいっぱいです"}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-dim">背景</span>
            <div role="group" aria-label="背景" className="flex h-6 rounded-md track">
              {[
                { on: !light, label: "暗", value: false },
                { on: light, label: "明", value: true },
              ].map((b) => (
                <button
                  key={b.label}
                  aria-pressed={b.on}
                  onClick={() => {
                    setLight(b.value);
                    persist("compareLight", String(b.value));
                  }}
                  className={`rounded px-2 ${b.on ? "thumb" : "text-fg/85 hover:bg-hover hover:text-fg"}`}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex shrink-0 items-center">
            <span className="mr-1 text-dim">文字</span>
            <button title="文字を小さく" onClick={() => changeSize(size - 2)} className={step}>
              <Minus size={13} />
            </button>
            <Slider
              min={SIZE.min}
              max={SIZE.max}
              step={1}
              value={size}
              onChange={(e) => changeSize(Number(e.target.value))}
              title="見本の文字の大きさ"
              className="mx-1 w-24"
            />
            <button title="文字を大きく" onClick={() => changeSize(size + 2)} className={step}>
              <Plus size={13} />
            </button>
            <span className="w-11 text-right text-dim tabular-nums">{size}px</span>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-dim">
            1 行目 <span className="text-fg">英数</span>（A〜Z・数字・記号）
          </span>
          <span className="h-4 w-px bg-line" />
          <span className="text-dim">2〜3 行目の和文</span>
          <div className="flex flex-wrap items-center gap-1">
            {ASPECTS.map((a) => {
              const on = aspects.includes(a);
              return (
                <button
                  key={a}
                  aria-pressed={on}
                  title={patternText(ASPECT_PATTERN[a])}
                  onClick={() => toggleAspect(a)}
                  className={`h-6 rounded-full border px-2.5 ${
                    on ? "border-transparent bg-tonal text-on-tonal" : "ghost text-fg/85"
                  }`}
                >
                  {a}
                </button>
              );
            })}
          </div>
          {editing || own ? (
            <label className="flex h-6 min-w-40 flex-1 items-center rounded-md border border-edge bg-bg focus-within:border-accent">
              <input
                autoFocus={editing && !own}
                value={own}
                onChange={(e) => changeOwn(e.target.value)}
                onBlur={() => setEditing(false)}
                onKeyDown={(e) => e.key === "Escape" && !composing(e) && (changeOwn(""), e.currentTarget.blur())}
                placeholder="自分の文字（2 行目の先頭に出ます）"
                className="h-full min-w-0 flex-1 bg-transparent px-2 outline-none placeholder:text-dim"
              />
              <button title="自分の文字を消す" onClick={() => changeOwn("")} className="mr-1 text-dim hover:text-fg">
                <X size={13} />
              </button>
            </label>
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="h-6 rounded-md border border-dashed border-line px-2 text-dim hover:bg-white/5 hover:text-fg"
            >
              自分の文字を足す
            </button>
          )}
        </div>
      </div>
      <div className={`min-h-0 flex-1 overflow-y-auto ${light ? "bg-white text-neutral-900" : ""}`}>
        {fonts.length === 0 ? (
          <p className={`mx-auto mt-24 max-w-md text-center text-sm leading-relaxed ${light ? "text-neutral-500" : "text-dim"}`}>
            比べるフォントがありません。一覧でフォントを選んで B キー、またはシェルフへドラッグしてください（最大 {FONT_SHELF_MAX} 件）
          </p>
        ) : (
          fonts.map((f) => {
            const members = (f.fontFamily && (isSystemId(f.id) ? systemFamilies : families).get(f.fontFamily)) || [f];
            const shown = members.find((m) => m.id === chosen[f.id]) ?? members.find((m) => m.id === f.id) ?? f;
            return (
              <CompareRow
                key={f.id}
                item={f}
                shown={shown}
                members={members}
                onStyle={(id) => setChosen({ ...chosen, [f.id]: id })}
                size={size}
                light={light}
                aspects={aspects}
                own={own}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * One font: on the left its name, typeface style, the style compared, rating
 * and favourite (a green line at the left edge), × to take it off the shelf;
 * on the right the lines drawn in the style chosen.
 */
function CompareRow({
  item,
  shown,
  members,
  onStyle,
  size,
  light,
  aspects,
  own,
}: {
  item: Item;
  shown: Item;
  members: Item[];
  onStyle: (id: string) => void;
  size: number;
  light: boolean;
  aspects: Aspect[];
  own: string;
}) {
  const [family, setFamily] = useState<string | null>(null);
  const [has, setHas] = useState<Set<number> | null>(null);
  const [failed, setFailed] = useState(false);
  const system = isSystemId(item.id);
  useEffect(() => {
    let live = true;
    setFamily(null);
    setHas(null);
    setFailed(false);
    if (shown.unavailable) {
      setFailed(true);
      return;
    }
    const release = holdFont(shown.id);
    loadFont(shown.id)
      .then((f) => live && setFamily(f))
      .catch(() => live && setFailed(true));
    fontChars(shown.id)
      .then((c) => live && setHas(c))
      .catch(() => {});
    return () => {
      live = false;
      release();
    };
  }, [shown.id, shown.unavailable]);

  const latin = isLatin(item);
  const lines = useMemo(() => {
    if (latin) {
      // Typed text of letters and figures only is worth a line of its own in between.
      const ownLine = own.trim() && /^[\x20-\x7e]+$/.test(own) ? [{ text: own, title: "自分の文字" }] : [];
      return {
        first: { text: LATIN_LETTERS, title: "英字" },
        rest: [...ownLine, { text: LATIN_FIGURES, title: "数字・記号" }],
        flow: false,
      };
    }
    const parts = [
      ...(own.trim() ? [{ text: own, title: "自分の文字" }] : []),
      ...aspects.map((a) => ({ text: patternText(ASPECT_PATTERN[a]), title: a })),
    ];
    return { first: { text: ALNUM, title: "英数" }, rest: parts, flow: true };
  }, [latin, own, aspects]);

  const style = { fontFamily: family ? `"${family}"` : undefined, fontSize: size, lineHeight: 1.3 };
  const fade = `transition-opacity duration-200 ${family ? "opacity-100" : "opacity-0"}`;
  const dim = light ? "text-neutral-500" : "text-dim";
  return (
    <div
      className={`relative flex border-b ${light ? "border-neutral-200" : "border-line"} ${
        shown.favorite ? "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-emerald-500" : ""
      }`}
    >
      <div
        className={`flex w-56 shrink-0 flex-col gap-1 border-r px-4 py-3 text-xs ${
          light ? "border-neutral-200 bg-neutral-50" : "border-line bg-panel/40"
        }`}
      >
        <div className="flex items-start gap-1">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={item.name}>
            {item.fontFamily || item.name}
          </span>
          <button
            title="比較とシェルフから外す"
            onClick={() => removeFromShelf([item.id])}
            className={`shrink-0 rounded p-0.5 ${dim} hover:bg-black/10 hover:text-current`}
          >
            <X size={13} />
          </button>
        </div>
        {/* A font this computer doesn't have: its name only. */}
        {!item.unavailable && (
          <>
            <span className={dim}>{fontCategoryLabel(fontCategoryOf(item))}</span>
            <label className="relative w-fit">
              <select
                value={shown.id}
                disabled={members.length < 2}
                onChange={(e) => onStyle(e.target.value)}
                title={members.length < 2 ? "このファミリーのスタイルは 1 つです" : "比べる太さ"}
                className={`h-6 rounded-md border px-1.5 ${
                  light ? "border-neutral-300 bg-white disabled:opacity-60" : "border-edge bg-bg disabled:off"
                }`}
              >
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {styleName(m)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {system ? (
          // Installed fonts have no rating or favourite (docs/SYSTEM_FONTS.md).
          <span className={`flex items-center gap-1 ${dim}`}>
            <Monitor size={12} /> この端末のフォント
          </span>
        ) : (
          <>
            <div className="flex items-center gap-1">
              <RatingStars value={shown.rating} onChange={(n) => setRating([shown.id], n)} size={13} />
            </div>
            <button
              onClick={() => useStore.getState().run(() => api.setFavorite([shown.id], !shown.favorite))}
              className={`flex w-fit items-center gap-1 rounded px-1 py-0.5 hover:bg-black/10 ${
                shown.favorite ? "text-pink-400" : dim
              }`}
            >
              <Heart size={12} fill={shown.favorite ? "currentColor" : "none"} />
              {shown.favorite ? "お気に入り" : "お気に入りに追加"}
            </button>
          </>
        )}
      </div>
      <div className="min-w-0 flex-1 px-5 py-3">
        {failed ? (
          <span className={dim}>
            {shown.unavailable
              ? "この端末にインストールされていないフォントです（別の端末でシェルフに置いたもの）"
              : "見本を表示できません"}
          </span>
        ) : (
          <>
            <div title={lines.first.title} className="truncate whitespace-pre">
              <Sample text={lines.first.text} has={has} style={style} className={fade} />
            </div>
            {lines.flow ? (
              // The aspects run on without breaks; two lines at most.
              <div className={`line-clamp-2 ${fade}`} style={style}>
                {lines.rest.map((p, i) => (
                  <span key={i} title={p.title}>
                    {i > 0 && "　"}
                    <Sample text={p.text} has={has} style={{}} />
                  </span>
                ))}
              </div>
            ) : (
              lines.rest.map((p, i) => (
                <div key={i} title={p.title} className="truncate whitespace-pre">
                  <Sample text={p.text} has={has} style={style} className={fade} />
                </div>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}

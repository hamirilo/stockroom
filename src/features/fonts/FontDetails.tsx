// The details panel's rows for a font, and the typeface style picker.
import { useEffect, useState } from "react";
import {
  FONT_CATEGORIES,
  fontCategoryLabel,
  fontFeatureLabel,
  fontScriptLabel,
  isSystemId,
  type Item,
} from "../../lib/api";
import { useStore } from "../../store";
import { fontApi, type FontFaceInfo } from "./api";
import { FontLinkRow } from "./FontLink";

const AXIS_LABEL: Record<string, string> = {
  wght: "太さ",
  wdth: "幅",
  ital: "イタリック",
  slnt: "傾き",
  opsz: "光学サイズ",
};

/**
 * Typeface style of the selected fonts: the guess, or one picked by hand
 * (the guess stays and comes back with "自動").
 */
export function FontCategorySelect({ fonts }: { fonts: Item[] }) {
  const run = useStore((s) => s.run);
  const users = new Set(fonts.map((f) => f.fontCategoryUser ?? ""));
  const value = users.size === 1 ? [...users][0] : "mixed";
  const auto = new Set(fonts.map((f) => f.fontCategory ?? "none"));
  const autoLabel = auto.size === 1 ? fontCategoryLabel([...auto][0]) : "フォントごと";
  return (
    <select
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        if (v !== "mixed") run(() => fontApi.setCategory(fonts.map((f) => f.id), v || null));
      }}
      className="w-full rounded-md border border-edge bg-bg px-1.5 py-0.5 text-xs outline-none focus:border-accent"
      title="自動の判定が違うときは、ここで選び直せます"
    >
      {value === "mixed" && <option value="mixed">（いろいろ）</option>}
      <option value="">自動（{autoLabel}）</option>
      {FONT_CATEGORIES.filter((c) => c.key !== "none").map((c) => (
        <option key={c.key} value={c.key}>
          {c.label}
        </option>
      ))}
    </select>
  );
}

/** Rows of the details list for a font: names, styles, variable axes, maker. */
export function FontDetails({ item }: { item: Item }) {
  const id = item.id;
  const [faces, setFaces] = useState<FontFaceInfo[] | null>(null);
  useEffect(() => {
    let live = true;
    setFaces(null);
    fontApi
      .faces(id)
      .then((f) => live && setFaces(f))
      .catch(() => live && setFaces([]));
    return () => {
      live = false;
    };
  }, [id]);
  if (!faces?.length) return null;

  const f = faces[0];
  const row = (label: string, value: React.ReactNode, title?: string) => (
    <>
      <dt className="text-dim">{label}</dt>
      <dd className="min-w-0 break-words" title={title}>
        {value}
      </dd>
    </>
  );
  const num = (n: number) => String(Math.round(n * 100) / 100);
  return (
    <>
      {row("ファミリー", f.family || "—")}
      {item.fontScript && row("言語", fontScriptLabel(item.fontScript))}
      {/* Installed fonts can't be changed: the guess only. */}
      {row(
        "書体",
        isSystemId(id) ? fontCategoryLabel(item.fontCategory ?? "none") : <FontCategorySelect fonts={[item]} />,
      )}
      {item.fontFeatures.length > 0 && row("特徴", item.fontFeatures.map(fontFeatureLabel).join("・"))}
      {faces.length > 1
        ? row(
            `フォント（${faces.length}）`,
            <ul className="flex flex-col gap-0.5">
              {faces.map((x, i) => (
                <li key={i}>
                  {x.style || x.fullName}
                  <span className="text-dim tabular-nums"> · {Math.round(x.weight)}</span>
                </li>
              ))}
            </ul>,
          )
        : row(
            "スタイル",
            <>
              {f.style || "—"}
              <span className="text-dim tabular-nums"> · 太さ {Math.round(f.weight)}</span>
            </>,
          )}
      {f.axes.length > 0 &&
        row(
          "可変",
          <ul className="flex flex-col gap-0.5">
            {f.axes.map((a) => (
              <li key={a.tag} className="tabular-nums">
                {AXIS_LABEL[a.tag] ?? (a.name || a.tag)} {num(a.min)}〜{num(a.max)}
              </li>
            ))}
            {f.instances.length > 0 && (
              <li className="text-dim" title={f.instances.join("、")}>
                名前付きのスタイル {f.instances.length} 個
              </li>
            )}
          </ul>,
        )}
      {row("文字", `${f.charCount.toLocaleString()} 字 · ${f.glyphs.toLocaleString()} グリフ`)}
      <FontLinkRow item={item} />
      {f.designer && row("製作", f.designer)}
      {f.version && row("版", <span className="block truncate">{f.version.replace(/^Version\s*/i, "")}</span>, f.version)}
    </>
  );
}

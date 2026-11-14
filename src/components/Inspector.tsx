import { colorHex } from "../lib/colors";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Folder as FolderIcon,
  Heart,
  Layers,
  Link as LinkIcon,
  Pin,
  Plus,
  Tag as TagIcon,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  setRating,
  toggleFavorite,
  togglePinned,
  toggleTray,
} from "../lib/actions";
import { listNoun } from "../store";
import {
  api,
  formatBytes,
  bitRateLabel,
  durationLabel,
  frameRateLabel,
  kindLabel,
  sizeLabel,
  urlLabel,
  type Folder,
  type Item,
  type SelectionInfo,
  type Tag,
  type VideoCodecs,
} from "../lib/api";
import { VideoThumbField } from "../features/videos/VideoThumbField";
import { useStore } from "../store";
import { composing } from "../lib/ime";
import { useMenu, type MenuItem } from "./ContextMenu";
import { showItemMenu } from "./Grid";
import { LinksField } from "./LinksField";
import { RatingStars } from "./RatingStars";

function folderPath(folders: Folder[], id: string): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts: string[] = [];
  for (let f = byId.get(id); f; f = f.parentId ? byId.get(f.parentId) : undefined) {
    parts.unshift(f.name);
  }
  return parts.join(" / ");
}

/**
 * タグを足す入力欄（候補つき）。詳細パネルと、選択バーの「タグ…」で使う。
 * `up`：候補を上に出す（画面の下にあるとき）。`onDone`：何も開いていないときの Esc で呼ぶ。
 */
export function TagInput({
  onAdd,
  exclude,
  up,
  autoFocus,
  onDone,
}: {
  onAdd: (names: string[]) => void;
  exclude: Set<number>;
  up?: boolean;
  autoFocus?: boolean;
  onDone?: () => void;
}) {
  const tags = useStore((s) => s.tags);
  const recentTags = useStore((s) => s.recentTags);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  // -1 = nothing highlighted (Enter with empty text then does nothing).
  const [hi, setHi] = useState(-1);
  const q = text.trim().toLowerCase();
  const suggestions = useMemo(() => {
    const usable = tags.filter((t) => !exclude.has(t.id));
    if (q) {
      // Prefix matches first, then other substring matches.
      const hits = usable.filter((t) => t.name.toLowerCase().includes(q));
      const starts = (t: Tag) => (t.name.toLowerCase().startsWith(q) ? 0 : 1);
      return hits.sort((a, b) => starts(a) - starts(b) || b.count - a.count).slice(0, 8);
    }
    // Empty input: recently assigned tags, then the most used ones.
    const byId = new Map(usable.map((t) => [t.id, t]));
    const recent = recentTags.flatMap((id) => byId.get(id) ?? []);
    const popular = usable
      .filter((t) => !recentTags.includes(t.id))
      .sort((a, b) => b.count - a.count);
    return [...recent, ...popular].slice(0, 10);
  }, [q, tags, exclude, recentTags]);
  const recentCount = q ? 0 : suggestions.filter((t) => recentTags.includes(t.id)).length;

  const commit = (name: string) => {
    // Comma-separated input adds several tags at once.
    const names = name.split(/[,、]/).map((s) => s.trim()).filter(Boolean);
    if (names.length) onAdd(names);
    setText("");
    setHi(-1);
  };

  return (
    <div className="relative">
      <input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setHi(e.target.value.trim() ? 0 : -1);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (composing(e)) return; // IME conversion in progress
          if (e.key === "Enter") {
            e.preventDefault();
            const pick = open && !text.includes(",") ? suggestions[hi] : undefined;
            commit(pick ? pick.name : text);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setHi((h) => Math.min(h + 1, suggestions.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, q ? 0 : -1));
          } else if (e.key === "Escape") {
            if (open && suggestions.length) {
              setOpen(false);
            } else if (onDone) {
              onDone();
            } else {
              setText("");
              e.currentTarget.blur();
            }
          }
        }}
        autoFocus={autoFocus}
        placeholder="タグを追加（Enter）"
        className="h-8 w-full rounded-md border border-edge bg-bg px-2 outline-none focus:border-accent"
      />
      {open && suggestions.length > 0 && (
        <div
          className={`absolute z-10 max-h-72 w-full overflow-y-auto rounded-lg border border-line bg-raised p-1 shadow-xl ${up ? "bottom-full mb-1" : "mt-1"}`}
        >
          {suggestions.map((t, i) => (
            <div key={t.id}>
              {!q && (i === 0 || i === recentCount) && (
                <div className="px-2 pt-1 pb-0.5 text-[11px] text-dim">
                  {i < recentCount ? "最近使ったタグ" : "よく使うタグ"}
                </div>
              )}
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(t.name);
                }}
                onMouseEnter={() => setHi(i)}
                className={`flex w-full justify-between rounded px-2 py-1 text-left ${i === hi ? "bg-accent-fill text-white" : ""}`}
              >
                <span className="truncate">{t.name}</span>
                <span className="text-xs opacity-70">{t.count}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A video's codecs, frame rate and bit rate, read from the file when the panel shows it. */
function VideoCodecRows({ item }: { item: Item }) {
  const id = item.id;
  const [codecs, setCodecs] = useState<VideoCodecs | null>(null);
  useEffect(() => {
    let current = true;
    setCodecs(null);
    api.videoCodecs(id).then(
      (c) => current && setCodecs(c),
      () => current && setCodecs({ video: null, audio: null, frameRate: null }),
    );
    return () => {
      current = false;
    };
  }, [id]);
  return (
    <>
      <dt className="text-dim">映像</dt>
      <dd>{codecs ? (codecs.video ?? "不明") : "…"}</dd>
      <dt className="text-dim">音声</dt>
      <dd>{codecs ? (codecs.audio ?? "なし") : "…"}</dd>
      <dt className="text-dim">フレームレート</dt>
      <dd className="tabular-nums">{codecs ? (codecs.frameRate ? frameRateLabel(codecs.frameRate) : "不明") : "…"}</dd>
      <dt className="text-dim" title="ファイル全体（映像と音声）の平均">ビットレート</dt>
      <dd className="tabular-nums">{item.durationMs ? bitRateLabel(item.size, item.durationMs) : "不明"}</dd>
    </>
  );
}

/**
 * 小さな見出し（タグ・フォルダ・メモ・紐づけ・ファイル情報）。折りたたまず、いつも中身を出す
 * （docs/UI.md「詳細パネル（情報タブ）の並び」）。
 */
function Heading({ icon, title, count }: { icon?: React.ReactNode; title: string; count?: number }) {
  return (
    <div className="mt-5 mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-semibold tracking-wide text-dim">
      {icon}
      {title}
      {count !== undefined && <span className="font-normal tabular-nums">{count}</span>}
    </div>
  );
}

/**
 * タグ・フォルダのチップ。複数選択で一部にだけ付いているもの（`count < total`）は破線にして
 * 「3/5」と＋（残りにも付ける）を出す。右クリックでそのチップの操作。
 */
function Chip({
  children,
  color,
  count,
  total,
  onRemove,
  onFill,
  onMenu,
  square,
}: {
  children: React.ReactNode;
  color?: string | null;
  count: number;
  total: number;
  onRemove: () => void;
  onFill: () => void;
  onMenu: (e: React.MouseEvent) => void;
  /** フォルダ（角を小さく）。 */
  square?: boolean;
}) {
  const hex = colorHex(color);
  const part = count < total;
  return (
    <span
      onContextMenu={onMenu}
      className={`flex max-w-full items-center gap-1 py-0.5 pr-1 pl-2.5 text-xs ${square ? "rounded-md" : "rounded-full"} ${
        part ? "shadow-[inset_0_0_0_1px_var(--color-edge)]" : "bg-raised"
      }`}
    >
      {hex && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: hex }} />}
      <span className="truncate">{children}</span>
      {part ? (
        <>
          <span className="text-[11px] text-dim tabular-nums">
            {count}/{total}
          </span>
          <button
            title={`残りの ${total - count} 件にも付ける`}
            aria-label={`残りの ${total - count} 件にも付ける`}
            onClick={onFill}
            className="rounded-full p-0.5 text-accent hover:bg-ink/10"
          >
            <Plus size={12} />
          </button>
        </>
      ) : (
        <button
          title="外す"
          aria-label="外す"
          onClick={onRemove}
          className="rounded-full p-0.5 text-dim hover:bg-ink/10 hover:text-fg"
        >
          <X size={12} />
        </button>
      )}
    </span>
  );
}

/** Text field that saves on blur, and resets when the selected item changes. */
/**
 * A field saved on blur. `multiline`: a note (newlines allowed). `wrap`: one
 * line of text shown wrapped over as many lines as it needs (a long file
 * name stays readable), Enter saves.
 */
function SavedText({
  id,
  value,
  onSave,
  multiline,
  wrap,
  className,
  placeholder,
}: {
  id?: string;
  value: string;
  onSave: (v: string) => void;
  multiline?: boolean;
  wrap?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [v, setV] = useState(value);
  const latest = useRef({ v, value, onSave });
  latest.current = { v, value, onSave };
  useEffect(() => setV(value), [value]);
  // Save pending edits if the component goes away (e.g. selection changed).
  useEffect(
    () => () => {
      const l = latest.current;
      if (l.v !== l.value) l.onSave(l.v);
    },
    [],
  );
  const props = {
    id,
    value: v,
    placeholder,
    className,
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => setV(e.target.value),
    onBlur: () => v !== value && onSave(v),
  };
  // Grow to fit the text (also when the panel is made narrower or wider).
  useLayoutEffect(() => {
    const el = area.current;
    if (!wrap || !el) return;
    const fit = () => {
      el.style.height = "auto";
      // scrollHeight leaves out the border; the height (border-box) includes it.
      el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [wrap, v]);
  if (wrap)
    return (
      <textarea
        {...props}
        ref={area}
        rows={1}
        spellCheck={false}
        // A name has no line breaks (pasted ones become spaces).
        onChange={(e) => setV(e.target.value.replace(/\s*\n\s*/g, " "))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !composing(e)) {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        className={`${className ?? ""} shrink-0 resize-none overflow-hidden [overflow-wrap:anywhere]`}
      />
    );
  return multiline ? (
    <textarea {...props} rows={4} />
  ) : (
    <input
      {...props}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !composing(e)) e.currentTarget.blur();
      }}
    />
  );
}

/** Favourite / pin toggle for the selection; `state` null = mixed. */
export function FlagButton({
  state,
  icon,
  label,
  hint,
  onClick,
  activeClass,
  compact,
}: {
  state: boolean | null;
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
  activeClass: string;
  /** Icon only (the label is the tooltip); a mixed selection has a dashed border. */
  compact?: boolean;
}) {
  const mixed = state === null;
  return (
    <button
      onClick={onClick}
      title={mixed ? `${hint}（混在）` : hint}
      aria-label={mixed ? `${label}（混在）` : label}
      aria-pressed={mixed ? "mixed" : state}
      className={`flex h-8 items-center justify-center gap-1.5 rounded-md border text-xs ${
        compact ? "w-9 shrink-0" : "flex-1"
      } ${
        state
          ? activeClass
          : mixed
            ? "border-dashed border-edge text-dim hover:bg-hover"
            : "border-frame hover:bg-hover"
      }`}
    >
      {icon}
      {!compact && label}
      {!compact && mixed && <span className="text-[10px] text-dim">（混在）</span>}
    </button>
  );
}

/**
 * Favourite, pin and tray buttons for `ids` (state read from the loaded items).
 * `shelf={false}`：シェルフを出さない。詳細パネル（情報タブ）はシェルフを「操作」として扱い、
 * 選択バー・右クリック・B キー・ドラッグに任せる（docs/MENUS.md §7）。
 */
export function FlagButtons({
  ids,
  items,
  compact,
  shelf: withShelf = true,
}: {
  ids: string[];
  items: Item[];
  compact?: boolean;
  shelf?: boolean;
}) {
  const sel = items.filter((i) => ids.includes(i.id));
  const state = (flag: (i: Item) => boolean): boolean | null => {
    const n = sel.filter(flag).length;
    return n === 0 ? false : n === sel.length ? true : null;
  };
  const fav = state((i) => i.favorite);
  const pin = state((i) => i.pinnedAt !== null);
  const tray = state((i) => i.inTray);
  const shelf = (
    <FlagButton
      compact={compact}
      state={tray}
      icon={<Layers size={14} />}
      label={tray ? "シェルフにあります" : "シェルフに追加"}
      hint={tray ? "シェルフから外す（キー B）" : "シェルフ（詳細パネルのタブ）に置いて、比べる・まとめて出力・書き出し（キー B）"}
      activeClass="border-emerald-500/60 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      onClick={() => toggleTray(ids)}
    />
  );
  return (
    <div className={compact ? "flex gap-1" : "flex flex-col gap-2"}>
      <div className={compact ? "contents" : "flex gap-2"}>
        <FlagButton
          compact={compact}
          state={fav}
          icon={<Heart size={14} fill={fav ? "currentColor" : "none"} />}
          label={fav ? "お気に入り" : "お気に入りに追加"}
          hint="お気に入り（キー F）"
          activeClass="border-pink-500/60 bg-pink-500/15 text-pink-600 dark:text-pink-400"
          onClick={() => toggleFavorite(ids, { quiet: true })}
        />
        <FlagButton
          compact={compact}
          state={pin}
          icon={<Pin size={14} fill={pin ? "currentColor" : "none"} />}
          label={pin ? "ピン留め中" : "ピン留め"}
          hint="一覧の先頭に固定（キー P）"
          activeClass="border-accent/60 bg-accent/15 text-accent"
          onClick={() => togglePinned(ids, { quiet: true })}
        />
      </div>
      {withShelf && (compact ? shelf : <div className="flex">{shelf}</div>)}
    </div>
  );
}

export function Inspector() {
  const selected = useStore((s) => s.selected);
  const items = useStore((s) => s.items);
  const folders = useStore((s) => s.folders);
  const rev = useStore((s) => s.rev);
  const run = useStore((s) => s.run);
  const isTrash = useStore((s) => s.view.kind === "trash");
  const noun = useStore(listNoun);
  const [info, setInfo] = useState<SelectionInfo>({ tags: [], folders: [] });

  const ids = useMemo(() => [...selected], [selected]);
  const single = ids.length === 1 ? items.find((i) => i.id === ids[0]) : undefined;
  const renameSeq = useStore((s) => s.renameItemSeq);
  // Common rating of the selection, or null when mixed.
  const rating = useMemo(() => {
    const rs = new Set(items.filter((i) => selected.has(i.id)).map((i) => i.rating));
    return rs.size === 1 ? [...rs][0] : null;
  }, [items, selected]);

  // F2 / ⌘R: focus the name field (after the panel has opened).
  useEffect(() => {
    if (!renameSeq) return;
    const t = setTimeout(() => {
      const el = document.getElementById("inspector-name") as HTMLInputElement | null;
      el?.focus();
      el?.select();
    }, 220);
    return () => clearTimeout(t);
  }, [renameSeq]);

  useEffect(() => {
    let live = true;
    if (!ids.length) return setInfo({ tags: [], folders: [] });
    api.selectionInfo(ids).then((i) => live && setInfo(i));
    return () => {
      live = false;
    };
  }, [ids, rev]);

  const tagIds = useMemo(() => new Set(info.tags.map((t) => t.id)), [info.tags]);

  if (!ids.length) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-dim">{noun}を選択してください</div>
    );
  }

  const n = ids.length;
  const st = useStore.getState;
  const picked = items.filter((i) => selected.has(i.id));
  const facts = single
    ? [
        sizeLabel(single),
        single.kind !== "bookmark" && `${single.ext.toUpperCase()} · ${formatBytes(single.size)}`,
        single.kind === "video" && single.durationMs != null && durationLabel(single.durationMs),
      ].filter(Boolean)
    : [];
  // 複数選択の要点：種類ごとの件数と合計の容量、追加日の幅。
  const byKind = [...new Set(picked.map((i) => i.kind))].map((k) => `${kindLabel(k)} ${picked.filter((i) => i.kind === k).length}`);
  const totalSize = formatBytes(picked.reduce((sum, i) => sum + i.size, 0));
  const dates = picked.map((i) => i.importedAt);
  const day = (t: number) => new Date(t).toLocaleDateString("ja-JP");
  const dateRange = dates.length
    ? day(Math.min(...dates)) === day(Math.max(...dates))
      ? day(Math.min(...dates))
      : `${day(Math.min(...dates))} 〜 ${day(Math.max(...dates))}`
    : "";

  const tagMenu = (e: React.MouseEvent, t: Tag) =>
    useMenu.getState().show(e, [
      { header: n > 1 ? `「${t.name}」 ${t.count} / ${n} 件` : `タグ「${t.name}」` },
      { label: "このタグを開く", onClick: () => st().setView({ kind: "tag", id: t.id }) },
      ...(t.count < n
        ? [{ label: `残りの ${n - t.count} 件にも付ける`, onClick: () => run(() => api.addTags(ids, [t.name])) }]
        : []),
      { separator: true },
      {
        label: n > 1 ? `${t.count} 件から外す` : "このタグを外す",
        danger: true,
        onClick: () => run(() => api.removeTag(ids, t.id)),
      },
    ] satisfies MenuItem[]);
  const folderMenu = (e: React.MouseEvent, f: { id: string; count: number }) => {
    const inside = picked.filter((i) => i.folderId === f.id).map((i) => i.id);
    useMenu.getState().show(e, [
      { header: n > 1 ? `${folderPath(folders, f.id)}　${f.count} / ${n} 件` : folderPath(folders, f.id) },
      { label: "フォルダを開く", onClick: () => st().setView({ kind: "folder", id: f.id }) },
      ...(f.count < n
        ? [
            { label: `入っている ${f.count} 件だけを選ぶ`, onClick: () => st().setSelection(inside) },
            { label: `残りの ${n - f.count} 件も入れる`, onClick: () => run(() => api.moveToFolder(ids, f.id)) },
          ]
        : []),
      { separator: true },
      {
        label: n > 1 ? `${f.count} 件をこのフォルダから外す` : "このフォルダから外す",
        danger: true,
        onClick: () => run(() => api.removeFromFolder(ids, f.id)),
      },
    ] satisfies MenuItem[]);
  };
  // プレビューの右クリックは一覧と同じメニュー。
  const previewMenu = (e: React.MouseEvent) => {
    const index = items.findIndex((i) => i.id === ids[0]);
    if (index >= 0) showItemMenu(e, items[index], index);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      {single ? (
        <>
          <div
            className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-raised"
            onContextMenu={previewMenu}
          >
            <img
              src={convertFileSrc(single.thumbPath)}
              className="max-h-full max-w-full object-contain"
              draggable={false}
              alt=""
              onDoubleClick={() =>
                useStore.getState().openViewer(items.findIndex((i) => i.id === single.id))
              }
            />
          </div>
          <SavedText
            key={single.id + ":name"}
            id="inspector-name"
            wrap
            value={single.name}
            onSave={(v) => run(() => api.renameItem(single.id, v))}
            className="mt-3 w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold outline-none hover:border-line focus:border-accent"
          />
          <div className="px-1 text-xs text-dim tabular-nums">{facts.join(" · ")}</div>
          {single.sourceUrl && (
            <div className="mt-1 flex min-w-0 gap-2 px-1 text-xs">
              <span className="shrink-0 text-dim">{single.kind === "bookmark" ? "URL" : "元のページ"}</span>
              <button
                className="min-w-0 truncate text-left text-accent hover:underline"
                title={single.sourceUrl}
                onClick={() => openUrl(single.sourceUrl!).catch((e) => useStore.getState().toast(String(e), true))}
              >
                {urlLabel(single.sourceUrl)}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {/* 1 件のときと同じ正方形にして、下の評価と印の行の位置をそろえる。 */}
          <div
            className="relative grid aspect-square grid-cols-2 grid-rows-2 gap-0.5 overflow-hidden rounded-lg bg-raised"
            onContextMenu={previewMenu}
          >
            {picked.slice(0, 4).map((i) => (
              <img
                key={i.id}
                src={convertFileSrc(i.thumbPath)}
                className="h-full w-full object-cover"
                draggable={false}
                alt=""
              />
            ))}
            {n > 4 && (
              <span className="absolute right-1.5 bottom-1.5 rounded-full bg-black/60 px-2 text-[11px] font-bold text-white tabular-nums">
                +{n - 4}
              </span>
            )}
          </div>
          <div className="mt-3 px-1 py-0.5 text-sm font-semibold tabular-nums">{n} 件を選択中</div>
          {/* 1 行に収める（評価と印の行を 1 件のときと同じ高さに置くため）。全文はツールチップ。 */}
          <div className="truncate px-1 text-xs text-dim tabular-nums" title={[...byKind, `計 ${totalSize}`].join(" · ")}>
            {[...byKind, `計 ${totalSize}`].join(" · ")}
          </div>
        </>
      )}

      {/* 評価と印は 1 行、アイコンだけ（名前はツールチップ）。 */}
      {!isTrash && (
        <div className="mt-3 flex items-center justify-between gap-2 px-1">
          <RatingStars value={rating} onChange={(n) => setRating(ids, n, { quiet: true })} />
          <FlagButtons ids={ids} items={items} compact shelf={false} />
        </div>
      )}

      <Heading icon={<TagIcon size={12} />} title="タグ" count={info.tags.length} />
      <div className="px-1">
        <div className="mb-2 flex flex-wrap gap-1.5 empty:hidden">
          {info.tags.map((t) => (
            <Chip
              key={t.id}
              color={t.color}
              count={t.count}
              total={n}
              onRemove={() => run(() => api.removeTag(ids, t.id))}
              onFill={() => run(() => api.addTags(ids, [t.name]))}
              onMenu={(e) => tagMenu(e, t)}
            >
              {t.name}
            </Chip>
          ))}
        </div>
        <TagInput
          exclude={tagIds}
          onAdd={(names) => {
            useStore.getState().rememberTags(names);
            run(() => api.addTags(ids, names));
          }}
        />
      </div>

      <Heading icon={<FolderIcon size={12} />} title="フォルダ" count={info.folders.length} />
      <div className="flex flex-col items-start gap-1.5 px-1">
        {info.folders.length === 0 && <span className="text-xs text-dim">未分類</span>}
        {info.folders.map((f) => (
          <Chip
            key={f.id}
            square
            color={folders.find((x) => x.id === f.id)?.color}
            count={f.count}
            total={n}
            onRemove={() => run(() => api.removeFromFolder(ids, f.id))}
            onFill={() => run(() => api.moveToFolder(ids, f.id))}
            onMenu={(e) => folderMenu(e, f)}
          >
            {folderPath(folders, f.id)}
          </Chip>
        ))}
      </div>

      {single && (
        <>
          <Heading title="メモ" />
          <div className="px-1">
            <SavedText
              key={single.id + ":note"}
              multiline
              value={single.note}
              placeholder="メモを入力"
              onSave={(v) => run(() => api.setNote(single.id, v))}
              className="w-full resize-y rounded-md border border-edge bg-bg p-2 outline-none focus:border-accent"
            />
          </div>
        </>
      )}

      {/* ゴミ箱の中では出さない。 */}
      {!isTrash && (
        <>
          <Heading icon={<LinkIcon size={12} />} title="紐づけ" />
          <div className="px-1">
            <LinksField ids={ids} single={single} />
          </div>
        </>
      )}

      {/* 動画 1 件、ゴミ箱の外：動画のサムネイル（docs/VIDEO.md）。 */}
      {!isTrash && single?.kind === "video" && (
        <>
          <Heading title="サムネイル" />
          <div className="px-1">
            <VideoThumbField item={single} />
          </div>
        </>
      )}

      <Heading title="ファイル情報" />
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-1 text-xs">
        {single ? (
          <>
            <dt className="text-dim">{single.kind === "image" || single.kind === "video" ? "サイズ" : "種類"}</dt>
            <dd className="tabular-nums">{sizeLabel(single)}</dd>
            {single.kind !== "bookmark" && (
              <>
                <dt className="text-dim">形式</dt>
                <dd>
                  {single.ext.toUpperCase()} · {formatBytes(single.size)}
                </dd>
              </>
            )}
            {single.kind === "video" && single.durationMs != null && (
              <>
                <dt className="text-dim">再生時間</dt>
                <dd className="tabular-nums">{durationLabel(single.durationMs)}</dd>
              </>
            )}
            {single.kind === "video" && <VideoCodecRows item={single} />}
            <dt className="text-dim">追加日</dt>
            <dd>{new Date(single.importedAt).toLocaleString("ja-JP")}</dd>
          </>
        ) : (
          <>
            <dt className="text-dim">種類</dt>
            <dd>{byKind.join(" · ")}</dd>
            <dt className="text-dim">合計</dt>
            <dd className="tabular-nums">{totalSize}</dd>
            <dt className="text-dim">追加日</dt>
            <dd className="tabular-nums">{dateRange}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

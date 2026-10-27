import { colorHex } from "../lib/colors";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Folder as FolderIcon,
  Heart,
  Layers,
  Pin,
  Plus,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  deleteSelection,
  setRating,
  toggleFavorite,
  togglePinned,
  toggleTray,
} from "../lib/actions";
import { listNoun } from "../store";
import {
  api,
  formatBytes,
  isSystemId,
  bitRateLabel,
  durationLabel,
  frameRateLabel,
  sizeLabel,
  urlLabel,
  type Folder,
  type Item,
  type SelectionInfo,
  type Tag,
  type VideoCodecs,
} from "../lib/api";
import { FontCategorySelect, FontDetails } from "../features/fonts/FontDetails";
import { SystemFontPanel } from "../features/fonts/SystemFontPanel";
import { useStore } from "../store";
import { composing } from "../lib/ime";
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

function TagInput({ onAdd, exclude }: { onAdd: (names: string[]) => void; exclude: Set<number> }) {
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
            } else {
              setText("");
              e.currentTarget.blur();
            }
          }
        }}
        placeholder="タグを追加（Enter）"
        className="h-8 w-full rounded-md border border-line bg-bg px-2 outline-none focus:border-accent"
      />
      {open && suggestions.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-line bg-raised p-1 shadow-xl">
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
                className={`flex w-full justify-between rounded px-2 py-1 text-left ${i === hi ? "bg-accent text-white" : ""}`}
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

const btn = "h-8 rounded-md border border-line hover:bg-white/5";

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <div className="mb-1.5 text-xs font-semibold text-dim">{label}</div>
      {children}
    </div>
  );
}

function Chip({
  children,
  onRemove,
  color,
}: {
  children: React.ReactNode;
  onRemove: () => void;
  color?: string | null;
}) {
  const hex = colorHex(color);
  return (
    <span className="flex max-w-full items-center gap-1 rounded-full bg-raised py-0.5 pr-1 pl-2.5 text-xs">
      {hex && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: hex }} />}
      <span className="truncate">{children}</span>
      <button onClick={onRemove} className="rounded-full p-0.5 text-dim hover:bg-white/10 hover:text-fg">
        <X size={12} />
      </button>
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
}: {
  state: boolean | null;
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
  activeClass: string;
}) {
  return (
    <button
      onClick={onClick}
      title={hint}
      className={`flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border text-xs ${
        state ? activeClass : state === null ? "border-line text-dim hover:bg-white/5" : "border-line hover:bg-white/5"
      }`}
    >
      {icon}
      {label}
      {state === null && <span className="text-[10px] text-dim">（混在）</span>}
    </button>
  );
}

/** Favourite, pin and tray buttons for `ids` (state read from the loaded items). */
export function FlagButtons({ ids, items }: { ids: string[]; items: Item[] }) {
  const sel = items.filter((i) => ids.includes(i.id));
  const state = (flag: (i: Item) => boolean): boolean | null => {
    const n = sel.filter(flag).length;
    return n === 0 ? false : n === sel.length ? true : null;
  };
  const fav = state((i) => i.favorite);
  const pin = state((i) => i.pinnedAt !== null);
  const tray = state((i) => i.inTray);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <FlagButton
          state={fav}
          icon={<Heart size={14} fill={fav ? "currentColor" : "none"} />}
          label={fav ? "お気に入り" : "お気に入りに追加"}
          hint="お気に入り（キー F）"
          activeClass="border-pink-500/60 bg-pink-500/15 text-pink-400"
          onClick={() => toggleFavorite(ids, { quiet: true })}
        />
        <FlagButton
          state={pin}
          icon={<Pin size={14} fill={pin ? "currentColor" : "none"} />}
          label={pin ? "ピン留め中" : "ピン留め"}
          hint="一覧の先頭に固定（キー P）"
          activeClass="border-accent/60 bg-accent/15 text-accent"
          onClick={() => togglePinned(ids, { quiet: true })}
        />
      </div>
      <div className="flex">
        <FlagButton
          state={tray}
          icon={<Layers size={14} />}
          label={tray ? "シェルフにあります" : "シェルフに追加"}
          hint={tray ? "シェルフから外す（キー B）" : "シェルフ（詳細パネルのタブ）に置いて、比べる・まとめて出力・書き出し（キー B）"}
          activeClass="border-emerald-500/60 bg-emerald-500/15 text-emerald-400"
          onClick={() => toggleTray(ids)}
        />
      </div>
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
  const stock = useStore((s) => s.mode === "stock");
  const noun = useStore(listNoun);
  const [info, setInfo] = useState<SelectionInfo>({ tags: [], folders: [] });
  const [adding, setAdding] = useState(false);

  const ids = useMemo(() => [...selected], [selected]);
  // Installed fonts aren't library items: nothing to ask the library about them.
  const system = ids.some(isSystemId);
  const single = ids.length === 1 ? items.find((i) => i.id === ids[0]) : undefined;
  // With tag grouping an item can be listed more than once.
  const selectedItems = useMemo(
    () => [...new Map(items.filter((i) => selected.has(i.id)).map((i) => [i.id, i])).values()],
    [items, selected],
  );
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
    setAdding(false);
    if (!ids.length || system) return setInfo({ tags: [], folders: [] });
    api.selectionInfo(ids).then((i) => live && setInfo(i));
    return () => {
      live = false;
    };
  }, [ids, rev, system]);

  const tagIds = useMemo(() => new Set(info.tags.map((t) => t.id)), [info.tags]);

  if (!ids.length) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-dim">{noun}を選択してください</div>
    );
  }

  const n = ids.length;
  if (system) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        <SystemFontPanel single={single} ids={ids} />
      </div>
    );
  }
  const countSuffix = (c: number) => (n > 1 && c < n ? ` (${c}/${n})` : "");
  const unusedFolders = folders.filter((f) => !info.folders.some((x) => x.id === f.id && x.count === n));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      {single ? (
        <>
          <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-raised">
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
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-1 text-xs">
            <dt className="text-dim">{single.kind === "image" || single.kind === "video" ? "サイズ" : "種類"}</dt>
            <dd className="tabular-nums">
              {sizeLabel(single)}
            </dd>
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
            {single.kind === "font" && <FontDetails item={single} />}
            <dt className="text-dim">追加日</dt>
            <dd>{new Date(single.importedAt).toLocaleString("ja-JP")}</dd>
            {single.sourceUrl && (
              <>
                <dt className="text-dim">{single.kind === "bookmark" ? "URL" : "元のページ"}</dt>
                <dd className="min-w-0">
                  <button
                    className="block max-w-full truncate text-left text-accent hover:underline"
                    title={single.sourceUrl}
                    onClick={() => openUrl(single.sourceUrl!).catch((e) => useStore.getState().toast(String(e), true))}
                  >
                    {urlLabel(single.sourceUrl)}
                  </button>
                </dd>
              </>
            )}
          </dl>
        </>
      ) : (
        <div className="rounded-lg bg-raised p-4 text-center">
          <div className="text-2xl font-semibold tabular-nums">{n}</div>
          <div className="text-dim">件を選択中</div>
        </div>
      )}

      {!single && selectedItems.length > 0 && selectedItems.every((i) => i.kind === "font") && (
        <Field label="書体">
          <FontCategorySelect fonts={selectedItems} />
        </Field>
      )}

      {!isTrash && (
        <Field label="評価">
          <RatingStars value={rating} onChange={(n) => setRating(ids, n, { quiet: true })} />
          <div className="mt-2.5">
            <FlagButtons ids={ids} items={items} />
          </div>
        </Field>
      )}

      <Field label="タグ">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {info.tags.map((t) => (
            <Chip key={t.id} color={t.color} onRemove={() => run(() => api.removeTag(ids, t.id))}>
              {t.name}
              {countSuffix(t.count)}
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
      </Field>

      <Field label="フォルダ">
        <div className="flex flex-col gap-1.5">
          {info.folders.length === 0 && <span className="text-dim">未分類</span>}
          {info.folders.map((f) => (
            <Chip
              key={f.id}
              color={folders.find((x) => x.id === f.id)?.color}
              onRemove={() => run(() => api.removeFromFolder(ids, f.id))}
            >
              <FolderIcon size={12} className="mr-1 inline text-dim" />
              {folderPath(folders, f.id)}
              {countSuffix(f.count)}
            </Chip>
          ))}
        </div>
        {adding ? (
          <select
            autoFocus
            defaultValue=""
            onBlur={() => setAdding(false)}
            onChange={(e) => {
              setAdding(false);
              if (e.target.value) run(() => api.moveToFolder(ids, e.target.value));
            }}
            className="mt-2 h-8 w-full rounded-md border border-line bg-bg px-2 outline-none"
          >
            <option value="">移動先のフォルダを選択…</option>
            {unusedFolders.map((f) => (
              <option key={f.id} value={f.id}>
                {folderPath(folders, f.id)}
              </option>
            ))}
          </select>
        ) : (
          folders.length > 0 && (
            <button
              onClick={() => setAdding(true)}
              className="mt-2 flex items-center gap-1 text-xs text-dim hover:text-fg"
            >
              <Plus size={13} /> フォルダへ移動
            </button>
          )
        )}
      </Field>

      {/* Stock only (fonts have families); not in the trash. */}
      {!isTrash && stock && <LinksField ids={ids} single={single} />}

      {single && (
        <Field label="メモ">
          <SavedText
            key={single.id + ":note"}
            multiline
            value={single.note}
            placeholder="メモを入力"
            onSave={(v) => run(() => api.setNote(single.id, v))}
            className="w-full resize-y rounded-md border border-line bg-bg p-2 outline-none focus:border-accent"
          />
        </Field>
      )}

      {/* Elsewhere these are in the row on top and its "…" menu. */}
      {isTrash && (
        <div className="mt-auto flex flex-col gap-2 pt-6">
          <button onClick={() => run(() => api.restoreItems(ids))} className={btn}>
            復元
          </button>
          <button
            onClick={() => deleteSelection(ids)}
            className="h-8 rounded-md border border-danger/50 text-danger hover:bg-danger/10"
          >
            完全に削除
          </button>
        </div>
      )}
    </div>
  );
}

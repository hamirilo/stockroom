import { openUrl } from "@tauri-apps/plugin-opener";
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { textTypeLabel, type Item } from "../../lib/api";
import { comboText } from "../../lib/shortcuts";
import { useStore } from "../../store";
import { takeEditNext } from "./actions";
import { textsApi, type TextContent } from "./api";
import { parseDelimited } from "./csv";
import { isOpenableLink, markdownHtml } from "./markdown";
import "./text.css";

/** How long typing must pause before the edit is saved. */
const SAVE_AFTER_MS = 800;
/** Rows of a CSV / TSV the table shows. */
const MAX_ROWS = 2000;
/** From this width, Markdown is edited next to its preview. */
const SPLIT_MIN = 900;

type Tab = "preview" | "edit";
/** The tab picked last, for the next text opened. */
let lastTab: Tab = "preview";

type Status = "saved" | "pending" | "saving" | "error";
const STATUS: Record<Status, string> = { saved: "保存済み", pending: "未保存", saving: "保存中…", error: "保存できませんでした" };

const st = () => useStore.getState();

/**
 * The viewer's body for texts (docs/TEXT.md): a preview (Markdown formatted,
 * CSV / TSV as a table, plain text as is) and an editor that saves by itself.
 * Mounted once per item (`key`), so leaving it saves what is left.
 */
export function TextView({ item }: { item: Item }) {
  const [content, setContent] = useState<TextContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [tab, setTabState] = useState<Tab>(() => (takeEditNext(item.id) ? "edit" : lastTab));
  const [status, setStatus] = useState<Status>("saved");
  const [wide, setWide] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  // What is typed, what the file holds, and the saves in flight (one at a time, in order).
  const latest = useRef("");
  const saved = useRef("");
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const changed = useRef(false);
  const warned = useRef(false);
  const id = item.id;
  const ext = item.ext.toLowerCase();
  const markdown = ext === "md" || ext === "markdown";
  const editable = content?.editable ?? false;
  const editing = tab === "edit" && editable;

  const setTab = (t: Tab) => {
    lastTab = t;
    setTabState(t);
  };

  useEffect(() => {
    let live = true;
    textsApi.read(id).then(
      (c) => {
        if (!live) return;
        latest.current = saved.current = c.text;
        setContent(c);
        setDraft(c.text);
      },
      (e) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [id]);

  /** Saves what is typed, after the saves before it. */
  const save = () => {
    clearTimeout(timer.current);
    const text = latest.current;
    if (text === saved.current) return chain.current;
    setStatus("saving");
    chain.current = chain.current.then(() =>
      textsApi.save(id, text).then(
        (r) => {
          saved.current = text;
          changed.current = true;
          setStatus(latest.current === text ? "saved" : "pending");
          if (r.encodingChanged && !warned.current) {
            warned.current = true;
            st().notify({
              title: `${r.encoding} で保存しました`,
              detail: "元の文字コード（Shift_JIS）で表せない文字があったため",
            });
          }
        },
        (e) => {
          setStatus("error");
          st().toast(`「${item.name}」を保存できませんでした：${e}`, true);
        },
      ),
    );
    return chain.current;
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  // Leaving (another item, closing the viewer): save what is left, then show
  // the new thumbnail and size in the list. Not before: an edit can make the
  // text leave the list (a search), which would move the viewer away from it.
  useEffect(
    () => () => {
      void saveRef.current().then(() => {
        if (changed.current) void st().refresh();
      });
    },
    [],
  );

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= SPLIT_MIN));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (editing) areaRef.current?.focus();
  }, [editing]);

  const onChange = (text: string) => {
    latest.current = text;
    setDraft(text);
    setStatus(text === saved.current ? "saved" : "pending");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveRef.current(), SAVE_AFTER_MS);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.code === "KeyS") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      // Out of the editor first; the next Esc closes the viewer.
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === "Tab" && !mod && !e.shiftKey) {
      e.preventDefault();
      // execCommand keeps the field's own undo (⌘Z) working.
      document.execCommand("insertText", false, ext === "tsv" ? "\t" : "  ");
    }
  };

  // The preview follows typing without holding it up.
  const shown = useDeferredValue(draft);
  const preview = content ? <Preview text={shown} ext={ext} /> : null;

  const seg = (on: boolean) =>
    `rounded px-2.5 py-0.5 ${on ? "bg-ink/15 text-fg" : "text-ink/60 hover:text-fg"} disabled:cursor-default disabled:text-ink/25`;
  const reason = content?.truncated
    ? "大きすぎるため、先頭だけを表示しています（編集できません）"
    : content && !content.editable
      ? "文字コードを判別できないため、編集できません"
      : null;

  return (
    <div ref={boxRef} className="absolute inset-0 flex flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-ink/10 px-4 py-1.5 text-xs text-ink/50">
        <div className="flex items-center gap-0.5 rounded-md bg-ink/5 p-0.5">
          <button className={seg(tab === "preview" || !editable)} onClick={() => setTab("preview")}>
            プレビュー
          </button>
          <button
            className={seg(editing)}
            disabled={!editable}
            title={reason ?? `編集（${comboText("Mod+S")} ですぐ保存）`}
            onClick={() => setTab("edit")}
          >
            編集
          </button>
        </div>
        <span className="truncate">
          {textTypeLabel(ext)}
          {content && ` · ${content.encoding}`}
          {reason && ` · ${reason}`}
        </span>
        <span className="flex-1" />
        {/* Room kept, so the bar doesn't move as the status changes. */}
        <span className={`min-w-28 text-right ${status === "error" ? "text-danger" : ""}`}>
          {editable && (status !== "saved" || changed.current) ? STATUS[status] : ""}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        {error ? (
          <p className="mt-24 text-center text-sm text-ink/60">読み込めませんでした：{error}</p>
        ) : !content ? null : editing ? (
          <div className={`grid h-full ${markdown && wide ? "grid-cols-2" : "grid-cols-1"}`}>
            <textarea
              ref={areaRef}
              value={draft}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onKeyDown}
              onBlur={() => void save()}
              spellCheck={false}
              placeholder={markdown ? "# 見出し\n\n本文を書く…" : "本文を書く…"}
              className="text-editor h-full w-full resize-none bg-field px-8 py-6 text-[14px] leading-relaxed text-ink/90 outline-none placeholder:text-ink/25"
            />
            {markdown && wide && <div className="h-full overflow-auto border-l border-ink/10">{preview}</div>}
          </div>
        ) : (
          <div className="h-full overflow-auto">{preview}</div>
        )}
      </div>
    </div>
  );
}

function Preview({ text, ext }: { text: string; ext: string }) {
  if (ext === "csv" || ext === "tsv") return <Table text={text} sep={ext === "tsv" ? "\t" : ","} />;
  if (ext === "md" || ext === "markdown") return <Markdown text={text} />;
  return <pre className="text-page text-plain">{text || <Empty />}</pre>;
}

const Empty = () => <span className="text-neutral-400">（空のテキスト）</span>;

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => markdownHtml(text), [text]);
  if (!text.trim())
    return (
      <div className="text-page">
        <Empty />
      </div>
    );
  return (
    <article
      className="text-page md-body"
      // Cleaned in markdownHtml: only listed elements and attributes are left.
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as Element).closest("a");
        if (!a) return;
        // Never navigate the app's window; web links open in the browser.
        e.preventDefault();
        const href = a.getAttribute("href") ?? "";
        if (isOpenableLink(href)) openUrl(href).catch((err) => st().toast(String(err), true));
      }}
    />
  );
}

function Table({ text, sep }: { text: string; sep: "," | "\t" }) {
  const { rows, more } = useMemo(() => parseDelimited(text, sep, MAX_ROWS + 1), [text, sep]);
  if (!rows.length || (rows.length === 1 && rows[0].every((c) => !c)))
    return (
      <div className="text-page">
        <Empty />
      </div>
    );
  const [head, ...body] = rows;
  const cols = Math.max(...rows.map((r) => r.length));
  const cells = (r: string[]) => Array.from({ length: cols }, (_, i) => r[i] ?? "");
  return (
    <div className="p-6">
      <table className="csv-table">
        <thead>
          <tr>
            <th className="csv-num" />
            {cells(head).map((c, i) => (
              <th key={i}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, n) => (
            <tr key={n}>
              <td className="csv-num">{n + 1}</td>
              {cells(r).map((c, i) => (
                <td key={i}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {more && (
        <p className="mt-3 text-xs text-ink/50">先頭の {MAX_ROWS.toLocaleString()} 行まで表示しています</p>
      )}
    </div>
  );
}

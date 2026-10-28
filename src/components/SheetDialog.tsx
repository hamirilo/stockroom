// "まとめて出力": lays the chosen images out on one picture (PNG / JPEG) or
// one HTML page, numbered, with a live preview. See lib/sheet.ts.
import { convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Copy, Download, LayoutGrid } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, formatBytes, type Item } from "../lib/api";
import {
  badgeBox,
  buildHtml,
  infoOf,
  layoutSheet,
  MAX_COLUMNS,
  renderSheet,
  SHEET_COLORS,
  SHEET_DEFAULTS,
  SHEET_FONT,
  SHEET_HTML_IMAGES,
  SHEET_WIDTHS,
  tooLarge,
  type SheetLabel,
  type SheetLayout,
  type SheetOptions,
} from "../lib/sheet";
import { useStore } from "../store";
import { composing } from "../lib/ime";

const KEY = "sheetOptions";

// Everything but the title (which belongs to one sheet) is remembered across launches.
function loadOptions(): SheetOptions {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { ...SHEET_DEFAULTS, ...(v && typeof v === "object" ? v : {}), title: "" };
  } catch {
    return SHEET_DEFAULTS;
  }
}
function saveOptions(o: SheetOptions) {
  try {
    const { title: _, ...rest } = o;
    localStorage.setItem(KEY, JSON.stringify(rest));
  } catch {
    /* ignore */
  }
}

/** File name for the save dialog: the title, else "画像一覧_20261008". */
function defaultName(o: SheetOptions): string {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const base = o.title.trim().replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || `画像一覧_${date}`;
  return `${base}.${o.format === "jpeg" ? "jpg" : o.format}`;
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-md border border-edge bg-control p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded px-2 py-1 whitespace-nowrap ${
            value === o.value ? "bg-chosen text-fg" : "text-fg/85 hover:bg-white/12"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs text-dim">{label}</div>
      {children}
    </div>
  );
}

const selectClass =
  "h-8 w-full rounded-md border border-edge bg-bg px-2 outline-none focus:border-accent";

/** The sheet drawn with the thumbnails, scaled to fit the preview pane. */
function Preview({ layout: l, opt }: { layout: SheetLayout; opt: SheetOptions }) {
  const ref = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom(el.clientWidth));
    ro.observe(el);
    setRoom(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const scale = room ? Math.min(1, (room - 40) / l.width) : 0;
  const colors = SHEET_COLORS[opt.theme];
  const line = (size: number, weight: number, color: string): React.CSSProperties => ({
    position: "absolute",
    fontSize: size,
    fontWeight: weight,
    lineHeight: 1.2,
    color,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  });
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-auto bg-bg p-5">
      {scale > 0 && (
        <div
          className="mx-auto overflow-hidden rounded shadow-xl shadow-black/40"
          style={{ width: l.width * scale, height: l.height * scale }}
        >
          <div
            style={{
              width: l.width,
              height: l.height,
              transform: `scale(${scale})`,
              transformOrigin: "0 0",
              position: "relative",
              background: colors.bg,
              fontFamily: SHEET_FONT,
            }}
          >
            {l.title && (
              <div
                style={{
                  ...line(l.title.size, 700, colors.fg),
                  left: l.pad,
                  top: l.title.y - l.title.size,
                  width: l.width - l.pad * 2,
                }}
              >
                {l.title.text}
              </div>
            )}
            {l.cells.map((c) => {
              const b = c.label ? badgeBox(l, c.label) : null;
              return (
                <div key={`${c.item.id}-${c.label}`}>
                  <div
                    className="overflow-hidden"
                    style={{
                      position: "absolute",
                      left: c.x,
                      top: c.y,
                      width: c.w,
                      height: c.h,
                      background: colors.cell,
                      borderRadius: l.radius,
                    }}
                  >
                    <img
                      src={convertFileSrc(c.item.thumbPath)}
                      alt=""
                      draggable={false}
                      style={{
                        position: "absolute",
                        left: c.img.x - c.x,
                        top: c.img.y - c.y,
                        width: c.img.w,
                        height: c.img.h,
                      }}
                    />
                    {b && (
                      <div
                        style={{
                          position: "absolute",
                          left: b.inset,
                          top: b.inset,
                          width: b.w,
                          height: b.h,
                          borderRadius: b.h / 2,
                          background: "rgba(0, 0, 0, 0.72)",
                          color: "#fff",
                          fontSize: b.font,
                          fontWeight: 700,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {c.label}
                      </div>
                    )}
                  </div>
                  {opt.showName && (
                    <div style={{ ...line(l.nameSize, 600, colors.fg), left: c.x, top: c.nameY - l.nameSize, width: c.w }}>
                      {c.item.name}
                    </div>
                  )}
                  {opt.showInfo && (
                    <div style={{ ...line(l.infoSize, 400, colors.dim), left: c.x, top: c.infoY - l.infoSize, width: c.w }}>
                      {infoOf(c.item)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function SheetDialog() {
  const sheet = useStore((s) => s.sheet);
  const rawItems = useStore((s) => s.rawItems);
  const [opt, setOpt] = useState(loadOptions);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const titleRef = useRef<HTMLInputElement>(null);

  const open = sheet !== null;
  useEffect(() => {
    if (!sheet) return;
    setItems(sheet);
    setTimeout(() => titleRef.current?.focus(), 50);
  }, [sheet]);
  // Keep names and orientation current if they change while the dialog is open.
  useEffect(() => {
    if (!open) return;
    const byId = new Map(rawItems.map((i) => [i.id, i]));
    setItems((cur) => cur.map((i) => byId.get(i.id) ?? i));
  }, [open, rawItems]);

  const close = () => !busy && useStore.getState().setSheet(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !composing(e)) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const set = (patch: Partial<SheetOptions>) =>
    setOpt((cur) => {
      const next = { ...cur, ...patch };
      saveOptions(next);
      return next;
    });

  const isHtml = opt.format === "html";
  const layout = useMemo(() => layoutSheet(items, opt, isHtml ? 1600 : opt.width), [items, opt, isHtml]);
  const big = !isHtml && tooLarge(layout);
  const auto = useMemo(() => layoutSheet(items, { ...opt, columns: 0 }).columns, [items, opt]);

  if (!sheet) return null;
  const toast = useStore.getState().toast;
  const progress = (total: number) => {
    setBusy({ done: 0, total });
    return (done: number) => setBusy({ done, total });
  };

  const make = async (): Promise<Uint8Array> => {
    if (isHtml) return new TextEncoder().encode(await buildHtml(items, opt, progress(items.length)));
    const blob = await renderSheet(items, opt, progress(items.length));
    return new Uint8Array(await blob.arrayBuffer());
  };

  const onSave = async () => {
    const ext = opt.format === "jpeg" ? "jpg" : opt.format;
    const path = await save({
      title: "まとめて出力",
      defaultPath: defaultName(opt),
      filters: [{ name: isHtml ? "HTML" : ext.toUpperCase(), extensions: [ext] }],
    });
    if (!path) return;
    try {
      const data = await make();
      await api.saveFile(path, data);
      useStore.getState().setSheet(null);
      toast(`${items.length} 枚を1つにまとめて保存しました（${formatBytes(data.length)}）`, false, {
        label: "表示",
        onClick: () => api.revealPath(path).catch((e) => toast(String(e), true)),
      });
    } catch (e) {
      toast(String(e), true);
    } finally {
      setBusy(null);
    }
  };

  const onCopy = async () => {
    try {
      const data = await make();
      await api.copyImage(data);
      toast(`画像をクリップボードにコピーしました（${layout.width} × ${layout.height} px・${formatBytes(data.length)}）`);
    } catch (e) {
      toast(String(e), true);
    } finally {
      setBusy(null);
    }
  };

  const labels: { value: SheetLabel; label: string }[] = [
    { value: "number", label: "1, 2, 3" },
    { value: "letter", label: "A, B, C" },
    { value: "none", label: "なし" },
  ];

  return (
    <div data-modal className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/50" onPointerDown={close}>
      <div
        className="flex h-[86vh] w-[1120px] max-w-[94vw] animate-zoom-in flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <LayoutGrid size={16} className="text-accent" />
          <div className="text-base font-semibold">まとめて出力</div>
          <div className="text-xs text-dim">
            {items.length} 枚を1枚の{isHtml ? " HTML" : "画像"}にまとめます
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          <Preview layout={layout} opt={opt} />
          <div className="flex w-64 shrink-0 flex-col gap-4 overflow-y-auto border-l border-line p-4">
            <Field label="形式">
              <Segmented
                value={opt.format}
                options={[
                  { value: "png", label: "PNG" },
                  { value: "jpeg", label: "JPEG" },
                  { value: "html", label: "HTML" },
                ]}
                onChange={(format) => set({ format })}
              />
              <p className="text-[11px] leading-relaxed text-dim">
                {opt.format === "png"
                  ? "文字がくっきり。チャットへの貼り付けにも"
                  : opt.format === "jpeg"
                    ? "写真が多いときに軽くなります"
                    : "画像を入れた1つのファイル。ブラウザで開き、クリックで拡大できます"}
              </p>
            </Field>
            <Field label="タイトル（任意）">
              <input
                ref={titleRef}
                value={opt.title}
                placeholder="例：どれがいいですか？"
                onChange={(e) => set({ title: e.target.value })}
                onKeyDown={(e) => e.key === "Escape" && !composing(e) && e.currentTarget.blur()}
                className="h-8 rounded-md border border-edge bg-bg px-2 outline-none focus:border-accent"
              />
            </Field>
            <Field label="番号">
              <Segmented value={opt.label} options={labels} onChange={(label) => set({ label })} />
            </Field>
            <Field label="画像の下に表示">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={opt.showName} onChange={(e) => set({ showName: e.target.checked })} />
                名前
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={opt.showInfo} onChange={(e) => set({ showInfo: e.target.checked })} />
                サイズ・形式・容量
              </label>
            </Field>
            <Field label="列の数">
              <select value={opt.columns} onChange={(e) => set({ columns: Number(e.target.value) })} className={selectClass}>
                <option value={0}>自動（{auto} 列）</option>
                {Array.from({ length: Math.min(MAX_COLUMNS, Math.max(1, items.length)) }, (_, k) => (
                  <option key={k + 1} value={k + 1}>
                    {k + 1} 列
                  </option>
                ))}
              </select>
            </Field>
            {isHtml ? (
              <Field label="画像の大きさ">
                <select value={opt.htmlImage} onChange={(e) => set({ htmlImage: Number(e.target.value) })} className={selectClass}>
                  {SHEET_HTML_IMAGES.map((s) => (
                    <option key={s.px} value={s.px}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label="画像の幅">
                <select value={opt.width} onChange={(e) => set({ width: Number(e.target.value) })} className={selectClass}>
                  {SHEET_WIDTHS.map((w) => (
                    <option key={w} value={w}>
                      {w} px
                    </option>
                  ))}
                </select>
                <p className={`text-[11px] ${big ? "text-danger" : "text-dim"}`}>
                  {layout.width} × {layout.height} px
                  {big && "：大きすぎます。列を増やすか幅を小さくしてください"}
                </p>
              </Field>
            )}
            <Field label="背景">
              <Segmented
                value={opt.theme}
                options={[
                  { value: "light", label: "白" },
                  { value: "dark", label: "黒" },
                ]}
                onChange={(theme) => set({ theme })}
              />
            </Field>
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-line px-5 py-3">
          <span className="text-xs text-dim">
            {busy
              ? `画像を準備中… ${busy.done} / ${busy.total}`
              : "並びは一覧の順です（シェルフからはシェルフの並び。ドラッグで並べ替えできます）"}
          </span>
          <div className="ml-auto flex gap-2">
            <button onClick={close} disabled={!!busy} className="rounded-md px-3 py-1.5 hover:bg-white/5 disabled:off">
              キャンセル
            </button>
            {!isHtml && (
              <button
                onClick={onCopy}
                disabled={!!busy || big || !items.length}
                className="flex items-center gap-1.5 rounded-md border border-edge bg-control px-3 py-1.5 enabled:hover:bg-white/12 disabled:off disabled:bg-transparent"
              >
                <Copy size={14} />
                画像をコピー
              </button>
            )}
            <button
              onClick={onSave}
              disabled={!!busy || big || !items.length}
              className="flex items-center gap-1.5 rounded-md bg-accent-fill px-3 py-1.5 font-medium text-white enabled:hover:brightness-110 disabled:off disabled:bg-control"
            >
              <Download size={14} />
              保存…
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

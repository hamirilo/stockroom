// The settings screen (⌘,), see docs/SETTINGS.md: the app's pages (一般,
// サイドバー, ブラウザ拡張, Claude; settings.json and this PC), then the open
// library's (概要, サイドバー; stored in its library.db). Changes are saved as
// they are made. The frame and rows are SettingsFrame's, the same in every
// tool (desktop-platform UI §9).
import {
  Bot,
  FileText,
  NotebookText,
  Video,
  FolderInput,
  FolderOpen,
  Image as ImageIcon,
  Info,
  Library,
  PanelLeft,
  Puzzle,
  Settings,
  Shapes,
  Share2,
  Type,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { transferAllOfKind } from "../lib/actions";
import { api, formatBytes, KINDS, kindLabel, type ItemKind } from "../lib/api";
import { sidebarEntriesOf, type SidebarHidden } from "../lib/librarySettings";
import { MODES, modeLabel, modesFor, type Mode } from "../lib/modes";
import { isMac } from "../lib/shortcuts";
import { sidebarHidden, usedModes, useStore, type SettingsTab } from "../store";
import { WebImportSettings } from "./WebImportDialog";
import { ClaudeSettings } from "./ClaudeSettings";
import { ShareSettings } from "./ShareDialog";
import { RadioRows, Row, RowButton, Section, SettingsFrame, type SettingsGroup } from "./SettingsFrame";
import { UpdateSection } from "./UpdateSection";

export const SETTINGS_KEY = isMac ? "⌘," : "Ctrl+,";

const KIND_ICON: Record<Mode | ItemKind, React.ReactNode> = {
  stock: <Shapes size={14} />,
  image: <ImageIcon size={14} />,
  font: <Type size={14} />,
  file: <FileText size={14} />,
  text: <NotebookText size={14} />,
  video: <Video size={14} />,
};

type Page = { id: SettingsTab; label: string; icon: React.ReactNode };

/** Saved for the app (settings.json and this PC). */
const APP_PAGES: Page[] = [
  { id: "general", label: "一般", icon: <Settings size={15} /> },
  { id: "sidebar", label: "サイドバー", icon: <PanelLeft size={15} /> },
  { id: "extension", label: "ブラウザ拡張", icon: <Puzzle size={15} /> },
  { id: "claude", label: "Claude", icon: <Bot size={15} /> },
];

/** Saved in the open library (library.db). */
const LIBRARY_PAGES: Page[] = [
  { id: "library", label: "概要", icon: <Info size={15} /> },
  { id: "librarySidebar", label: "サイドバー", icon: <PanelLeft size={15} /> },
  { id: "libraryShare", label: "フォルダの共有", icon: <Share2 size={15} /> },
];

/** ⌘, opens the screen on the page shown last (or closes it). Esc is the frame's. */
function useSettingsKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        s.openSettings(s.settingsTab ? null : "last");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

export function SettingsDialog() {
  useSettingsKeys();
  const tab = useStore((s) => s.settingsTab);
  return tab ? <Dialog tab={tab} /> : null;
}

function Dialog({ tab }: { tab: SettingsTab }) {
  const openSettings = useStore((s) => s.openSettings);
  const library = useStore((s) => s.library);
  const close = useCallback(() => openSettings(null), [openSettings]);

  const groups: SettingsGroup<SettingsTab>[] = [
    { title: "アプリ全体", pages: APP_PAGES },
    // Only with a library open: its settings are stored in it.
    ...(library ? [{ title: `ライブラリ「${library.name}」`, sub: "このライブラリに保存", pages: LIBRARY_PAGES }] : []),
  ];

  return (
    <SettingsFrame groups={groups} page={tab} onPage={openSettings} onClose={close}>
      {tab === "general" && <GeneralPage />}
      {tab === "sidebar" && <AppSidebarPage />}
      {tab === "extension" && <WebImportSettings />}
      {tab === "claude" && <ClaudeSettings />}
      {tab === "library" && <LibraryPage />}
      {tab === "librarySidebar" && <LibrarySidebarPage />}
      {tab === "libraryShare" && <ShareSettings />}
    </SettingsFrame>
  );
}

/** One of a list of things to pick, in a section. */
function Check({
  checked,
  disabled,
  onChange,
  children,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  children: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <label className={`flex items-start gap-2.5 px-3 py-2 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">{children}</span>
        {hint && <span className="mt-0.5 block text-xs text-dim">{hint}</span>}
      </span>
    </label>
  );
}

// ------------------------------------------------------------- 一般

function GeneralPage() {
  const app = useStore((s) => s.appSettings);
  const save = useStore((s) => s.saveAppSettings);
  return (
    <div>
      <Section title="起動したとき">
        <RadioRows
          name="startup"
          value={app?.startup}
          disabled={!app}
          onChange={(startup) => save({ startup })}
          options={[
            {
              value: "last",
              label: "前回のライブラリを開く",
              hint: "見つからないとき（外付けドライブが未接続など）は、ライブラリの一覧を出します",
            },
            { value: "choose", label: "ライブラリを選ぶ", hint: "最近使ったライブラリとお気に入りの一覧から選びます" },
          ]}
        />
      </Section>
      <UpdateSection autoUpdate={app?.autoUpdate} onAutoUpdate={(autoUpdate) => save({ autoUpdate })} />
    </div>
  );
}

// ----------------------------------------------------- このライブラリ

function LibraryPage() {
  const library = useStore((s) => s.library);
  const kinds = useStore((s) => s.counts.kinds);
  const used = useStore(useShallow(usedModes));
  const setUsedModes = useStore((s) => s.setUsedModes);
  const [size, setSize] = useState<number | null>(null);
  useEffect(() => {
    if (library) api.librarySize().then(setSize, () => setSize(null));
  }, [library]);

  if (!library) return <p className="mt-8 text-center text-dim">ライブラリを開いていません</p>;
  const total = Object.values(kinds).reduce((a, n) => a + (n ?? 0), 0);
  const dropped = KINDS.filter((k) => !used.includes(k.kind) && (kinds[k.kind] ?? 0) > 0);

  return (
    <div>
      <Section title="ライブラリ">
        <Row
          icon={<Library size={18} className="text-accent" />}
          label={<span className="font-medium">{library.name}</span>}
          hint={
            <>
              <span className="block truncate" title={library.root}>
                {library.root}
              </span>
              <span className="tabular-nums">
                {total} 件{size !== null && ` · ${formatBytes(size)}`}
              </span>
            </>
          }
        >
          <RowButton onClick={() => useStore.getState().run(() => api.revealPath(library.root))}>
            <FolderOpen size={13} />
            {isMac ? "Finder で表示" : "エクスプローラで表示"}
          </RowButton>
        </Row>
        {/* A kind at a time (one library per kind is what moving all is for). */}
        {KINDS.filter((k) => (kinds[k.kind] ?? 0) > 0).map(({ kind }) => (
          <Row
            key={kind}
            icon={<span className="text-dim">{KIND_ICON[kind]}</span>}
            label={
              <>
                {kindLabel(kind)}
                <span className="ml-1.5 text-xs text-dim tabular-nums">{kinds[kind]} 件</span>
              </>
            }
          >
            <RowButton
              onClick={() => {
                useStore.getState().openSettings(null);
                transferAllOfKind(kind);
              }}
            >
              <FolderInput size={13} />
              すべて別のライブラリへ移す…
            </RowButton>
          </Row>
        ))}
      </Section>

      <Section
        title="使う種類"
        sub="使う種類が一覧と種類の絞り込みに出ます。フォントをほかの種類と使うときは、フォントを見比べる「フォント」のモードも出ます。この設定はライブラリに保存されます"
      >
        {KINDS.map(({ kind, label }) => {
          const on = used.includes(kind);
          const n = kinds[kind] ?? 0;
          return (
            <Check
              key={kind}
              checked={on}
              // At least one kind stays.
              disabled={on && used.length === 1}
              onChange={(v) => setUsedModes(v ? [...used, kind] : used.filter((m) => m !== kind))}
            >
              {KIND_ICON[kind]}
              {label}
              {n > 0 && <span className="text-xs text-dim tabular-nums">（{n} 件）</span>}
            </Check>
          );
        })}
      </Section>
      {dropped.length > 0 && (
        <p className="mt-2 rounded-md bg-raised px-2.5 py-1.5 text-xs text-dim">
          {dropped.map((k) => `${k.label} ${kinds[k.kind]} 件`).join("、")}
          は一覧に出なくなります。アイテムは消えません（チェックを戻すとまた出ます）
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------ サイドバー

/** One column of checks per mode; `onChange` gets the mode's new hidden entries. */
function SidebarChecks({
  modes,
  hidden,
  onChange,
}: {
  modes: Mode[];
  hidden: SidebarHidden;
  /** Without it the checks are shown, not changed (the app's, from a library). */
  onChange?: (mode: Mode, ids: string[]) => void;
}) {
  return (
    <div className="grid gap-4 py-1" style={{ gridTemplateColumns: `repeat(${modes.length}, minmax(0, 1fr))` }}>
      {modes.map((m) => {
        const off = hidden[m] ?? [];
        return (
          <div key={m}>
            {modes.length > 1 && (
              <div className="mt-1.5 mb-0.5 flex items-center gap-1.5 px-3 text-xs font-semibold text-dim">
                {KIND_ICON[m]}
                {modeLabel(m)}
              </div>
            )}
            {sidebarEntriesOf(m).map((e) => (
              <Check
                key={e.id}
                checked={!off.includes(e.id)}
                disabled={!onChange}
                onChange={(show) => onChange?.(m, show ? off.filter((x) => x !== e.id) : [...off, e.id])}
              >
                {e.label}
              </Check>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const SIDEBAR_SUB =
  "チェックを外した項目はサイドバーに出しません。表示を隠すだけで、シェルフへ追加（B キー）などの操作はそのまま使えます。「すべて」と「ゴミ箱」はいつも出ます";

function AppSidebarPage() {
  const hidden = useStore((s) => sidebarHidden(s, "app"));
  const loaded = useStore((s) => s.appSettings !== null);
  const setSidebarHidden = useStore((s) => s.setSidebarHidden);
  return (
    <div>
      <Section title="サイドバーの項目" sub={`すべてのライブラリの既定です。${SIDEBAR_SUB}`}>
        {loaded && <SidebarChecks modes={MODES} hidden={hidden} onChange={(m, ids) => setSidebarHidden(m, ids, "app")} />}
      </Section>
      <p className="mt-3 text-xs text-dim">
        ライブラリごとに変えるときは、そのライブラリを開いて、設定のライブラリの「サイドバー」で「このライブラリだけの設定」を選びます。
      </p>
    </div>
  );
}

function LibrarySidebarPage() {
  const library = useStore((s) => s.library);
  const own = useStore((s) => s.librarySettings.sidebarOwn);
  const hidden = useStore((s) => sidebarHidden(s));
  const modes = useStore(useShallow((s) => modesFor(usedModes(s))));
  const setSidebarOwn = useStore((s) => s.setSidebarOwn);
  const setSidebarHidden = useStore((s) => s.setSidebarHidden);
  const openSettings = useStore((s) => s.openSettings);
  if (!library) return <p className="mt-8 text-center text-dim">ライブラリを開いていません</p>;

  return (
    <div>
      <Section title="サイドバーの項目" sub={SIDEBAR_SUB}>
        <RadioRows
          name="sidebarOwn"
          value={own ? "own" : "app"}
          onChange={(v) => setSidebarOwn(v === "own")}
          options={[
            { value: "app", label: "アプリ全体の設定を使う", hint: "どのライブラリでも同じ項目を出します。この PC の設定です" },
            { value: "own", label: "このライブラリだけの設定", hint: "ライブラリに保存され、ほかの PC で開いても同じ項目を出します" },
          ]}
        />
      </Section>
      <div className={`mt-3 rounded-lg border border-line py-1 ${own ? "bg-bg/40" : ""}`}>
        <SidebarChecks modes={modes} hidden={hidden} onChange={own ? setSidebarHidden : undefined} />
        {!own && (
          <button
            onClick={() => openSettings("sidebar")}
            className="mx-3 mt-1 mb-1.5 text-xs text-accent underline-offset-2 hover:underline"
          >
            アプリ全体の設定を開く
          </button>
        )}
      </div>
    </div>
  );
}

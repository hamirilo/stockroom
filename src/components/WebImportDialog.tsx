// "ブラウザ拡張と連携" (the settings screen's ブラウザ拡張 page): turns the local server
// for the Chrome extension on or off (src-tauri/src/webimport.rs) and walks
// through loading the extension. Also the dialog an extension's connection
// request opens.
import { ask } from "@tauri-apps/plugin-dialog";
import { Check, ChevronRight, Copy, FolderOpen, Link2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type WebImportStatus } from "../lib/api";
import { useStore } from "../store";
import { SwitchRow } from "./SettingsFrame";

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    useStore.getState().toast("コピーしました");
  } catch (e) {
    useStore.getState().toast(String(e), true);
  }
}

export function WebImportSettings() {
  const [status, setStatus] = useState<WebImportStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const isMac = navigator.userAgent.includes("Mac");

  useEffect(() => {
    api.webImportStatus().then(setStatus, (e) => useStore.getState().toast(String(e), true));
  }, []);

  const act = async (fn: () => Promise<WebImportStatus | unknown>) => {
    setBusy(true);
    try {
      const s = await fn();
      setStatus(s && typeof s === "object" && "enabled" in s ? (s as WebImportStatus) : await api.webImportStatus());
    } catch (e) {
      useStore.getState().toast(String(e), true);
    } finally {
      setBusy(false);
    }
  };

  const resetToken = async () => {
    const ok = await ask(
      "これまでに接続した拡張機能は、すべてつながらなくなります（上のフォルダから入れたものは、自動でつなぎ直されます）。" +
        "また使うときは、拡張機能のアイコン →「アプリと接続」を押してください。",
      {
        title: "すべての拡張機能との接続を解除しますか？",
        kind: "warning",
        okLabel: "解除する",
        cancelLabel: "キャンセル",
      },
    );
    if (ok) await act(api.resetWebImportToken);
  };

  const on = status?.enabled ?? false;
  const ready = !!status?.extensionDir;

  return (
    <div>
      {/* The frame's header (SettingsFrame) names the page. */}
      <div className="mb-4">
        <p className="text-xs text-dim">
          Chrome（Microsoft Edge でも可）の拡張機能から、Web
          ページの画像やスクリーンショットをこのライブラリに保存できます。 保存した画像には元のページの URL
          が記録されます。
        </p>
      </div>

      <div>
        <div className="rounded-lg border border-line bg-bg/40">
          <SwitchRow
            label={<span className="font-medium">ブラウザ拡張からの保存を受け付ける</span>}
            checked={on}
            disabled={!status || busy}
            onChange={(v) => act(() => api.setWebImport(v))}
            hint={
              !status ? (
                "確認中…"
              ) : status.error ? (
                <span className="text-danger">{status.error}</span>
              ) : status.running ? (
                `受付中（127.0.0.1:${status.port}）。このパソコンの中の、接続を許可した拡張機能とアプリ（Feedability など）からだけ受け付けます。`
              ) : (
                "オフ。アプリの起動中だけ受け付けます。"
              )
            }
          />
        </div>

        {on && ready && (
          // Set up already: the steps fold away behind the state.
          <div className="mt-5 rounded-lg border border-line bg-bg/40 p-3 text-[13px]">
            <div className="flex items-center gap-2">
              <Check size={14} className="shrink-0 text-emerald-500" />
              <span className="flex-1 font-medium">拡張機能のフォルダは用意済み</span>
              <button
                disabled={busy}
                onClick={() => act(api.installExtension)}
                className="flex h-7 items-center gap-1.5 rounded-md border border-line px-2.5 text-xs enabled:hover:bg-white/5 disabled:opacity-40"
              >
                <FolderOpen size={13} />
                もう一度用意する
              </button>
            </div>
            <PathRow path={status!.extensionDir!} />
            <p className="mt-1.5 text-xs text-dim">
              アプリを更新したときは「もう一度用意する」を押し、Chrome の拡張機能の画面で再読み込み（↻）を押してください。
            </p>
            <button
              onClick={() => setShowSteps(!showSteps)}
              aria-expanded={showSteps}
              className="mt-2 flex items-center gap-1 text-xs text-dim hover:text-fg"
            >
              <ChevronRight size={13} className={`transition-transform ${showSteps ? "rotate-90" : ""}`} />
              Chrome への入れ方と接続の手順
            </button>
          </div>
        )}

        {on && (!ready || showSteps) && (
          <ol className="mt-5 space-y-4 text-[13px]">
            <Step n={1} title="拡張機能を Chrome に入れる">
              {!ready && (
                <button
                  disabled={busy}
                  onClick={() => act(api.installExtension)}
                  className="mb-2 flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 font-medium text-white enabled:hover:brightness-110 disabled:opacity-40"
                >
                  <FolderOpen size={14} />
                  拡張機能のフォルダを用意して表示
                </button>
              )}
              <ol className="list-decimal space-y-0.5 pl-4 text-xs text-dim">
                <li>
                  Chrome で <Code text="chrome://extensions" /> を開く（Edge は <Code text="edge://extensions" />）
                </li>
                <li>右上の「デベロッパー モード」をオンにする</li>
                <li>
                  「パッケージ化されていない拡張機能を読み込む」で、{ready ? "上の" : "用意した"}フォルダを選ぶ
                  {isMac ? "（⌘⇧G でパスを貼り付けると早い）" : "（アドレス欄にパスを貼り付けると早い）"}
                </li>
              </ol>
            </Step>
            <Step n={2} title="アプリと接続する">
              <p className="text-xs text-dim">用意したフォルダから入れた拡張機能は、そのまま接続されます。</p>
              <p className="mt-1 text-xs text-dim">
                別の場所から入れた拡張機能や、つながらないときは、ツールバーの拡張機能のアイコン →
                <span className="text-fg">「アプリと接続」</span>
                を押してください。このアプリに確認が出るので、番号が同じなら「許可する」を押します。
              </p>
            </Step>
          </ol>
        )}

        {on && (
          <div className="mt-5 text-[13px]">
            <div className="mb-1.5 font-medium">使い方</div>
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-dim">
              <li>ツールバーの拡張機能のアイコンで、保存先のフォルダと付けるタグを選ぶ</li>
              <li>
                画像を右クリック →「Stockroom に保存」。{isMac ? "Option" : "Alt"}{" "}
                を押しながら右クリックすると、すぐに保存
              </li>
              <li>アイコンの「このページの画像を一覧して保存…」で、大きさ・形式で絞り込んでまとめて保存</li>
              <li>アイコンの「スクリーンショットを保存」で、いまブラウザに見えている範囲を画像にして保存</li>
            </ul>
          </div>
        )}
      </div>

      {on && (
        <div className="mt-5 border-t border-line pt-3">
          <button
            disabled={busy}
            onClick={resetToken}
            className="text-xs text-dim underline-offset-2 hover:text-fg hover:underline"
          >
            すべての拡張機能との接続を解除…
          </button>
        </div>
      )}
    </div>
  );
}

/** A browser extension or another app asks to connect (POST /pair): allow or refuse (docs/FROM_APPS.md). */
export function PairDialog() {
  const req = useStore((s) => s.pairRequest);
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") answer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req]);
  if (!req) return null;

  function answer(allow: boolean) {
    useStore.getState().setPairRequest(null);
    api.answerWebPair(req!.id, allow).catch((e) => useStore.getState().toast(String(e), true));
    if (allow) useStore.getState().toast(req!.app ? `「${req!.app}」と接続しました` : "拡張機能と接続しました");
  }

  return (
    <div data-modal className="fixed inset-0 z-[60] flex animate-fade-in items-center justify-center bg-black/50">
      <div className="w-[400px] max-w-[92vw] animate-zoom-in rounded-xl border border-line bg-panel p-5 text-center shadow-2xl">
        <Link2 size={28} className="mx-auto text-accent" />
        {req.app ? (
          <>
            {/* The name is what the app calls itself: the code is what tells it is the same request. */}
            <div className="mt-2 text-base font-semibold">アプリ「{req.app}」が接続を求めています</div>
            <p className="mt-1 text-xs text-dim">
              そのアプリの画面に出ている番号と同じなら「許可する」を押してください。許可すると、そのアプリからこのライブラリに保存できるようになります。
            </p>
            <div className="my-4 font-mono text-4xl font-semibold tracking-[0.3em] tabular-nums">{req.code}</div>
            <p className="-mt-2 mb-4 text-[11px] text-dim">名前は相手のアプリが名乗ったものです。番号が同じかどうかで確かめてください</p>
          </>
        ) : (
          <>
            <div className="mt-2 text-base font-semibold">ブラウザの拡張機能が接続を求めています</div>
            <p className="mt-1 text-xs text-dim">
              拡張機能の画面に出ている番号と同じなら「許可する」を押してください。許可すると、その拡張機能からこのライブラリに画像を保存できるようになります。
            </p>
            <div className="my-4 font-mono text-4xl font-semibold tracking-[0.3em] tabular-nums">{req.code}</div>
            {/* Which one asks: chrome://extensions shows the same id under the extension. */}
            <p className="-mt-2 mb-4 text-[11px] text-dim">
              拡張機能の ID：<span className="font-mono select-all">{req.extension}</span>
              <br />
              心当たりがなければ「許可しない」を押してください（ID は chrome://extensions で確かめられます）
            </p>
          </>
        )}
        <div className="flex justify-center gap-2">
          <button onClick={() => answer(false)} className="h-9 rounded-md border border-line px-4 hover:bg-white/5">
            許可しない
          </button>
          <button
            autoFocus
            onClick={() => answer(true)}
            className="h-9 rounded-md bg-accent px-4 font-medium text-white hover:brightness-110"
          >
            許可する
          </button>
        </div>
        <p className="mt-3 text-[11px] text-dim">心当たりがない場合は「許可しない」を押してください。</p>
      </div>
    </div>
  );
}

function Code({ text }: { text: string }) {
  return (
    <button
      onClick={() => copy(text)}
      title="クリックでコピー"
      className="rounded bg-bg px-1 font-mono text-fg hover:text-accent"
    >
      {text}
    </button>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-raised text-[11px] font-semibold tabular-nums">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 font-medium">{title}</div>
        {children}
      </div>
    </li>
  );
}

function PathRow({ path }: { path: string }) {
  return (
    <div className="mt-2">
      <div className="flex items-center gap-1 rounded-md border border-line bg-bg pl-2">
        <code className="min-w-0 flex-1 truncate py-1 text-xs" title={path}>
          {path}
        </code>
        <button
          onClick={() => copy(path)}
          className="flex h-7 items-center gap-1 px-2 text-xs text-dim hover:text-fg"
          title="コピー"
        >
          <Copy size={13} /> コピー
        </button>
      </div>
    </div>
  );
}

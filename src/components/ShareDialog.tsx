// Sharing a folder read-only on the local network (src-tauri/src/share.rs):
// the dialog a folder's "共有…" opens (the URL, its QR code, downloads), and
// the settings screen's page listing the open library's shared folders.
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronRight, ExternalLink, Share2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type ShareInfo, type ShareStatus } from "../lib/api";
import { useStore } from "../store";
import { CopyLabel, useCopy } from "./Copy";

/** The open library's shares, and changing them (the sidebar's marks follow). */
function useShares() {
  const [status, setStatus] = useState<ShareStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.shareStatus().then(setStatus, (e) => useStore.getState().toast(String(e), true));
  }, []);

  const act = async (fn: () => Promise<ShareStatus>) => {
    setBusy(true);
    try {
      setStatus(await fn());
    } catch (e) {
      useStore.getState().toast(String(e), true);
    } finally {
      setBusy(false);
    }
    await useStore.getState().refresh();
  };
  return { status, busy, act };
}

/** The server's state, under a share's switch. */
function serverNote(status: ShareStatus | null, shared: boolean) {
  if (!status) return <span className="text-dim">確認中…</span>;
  if (status.error) return <span className="text-danger">{status.error}</span>;
  if (!shared) return <span className="text-dim">オフ。共有すると、このアプリを開いている間だけ見られます。</span>;
  return <span className="text-dim">共有中（ポート {status.port}）。アプリを閉じると見られなくなり、開くとまた見られます。</span>;
}

export function ShareDialog() {
  const folderId = useStore((s) => s.sharing);
  if (!folderId) return null;
  return <Dialog folderId={folderId} />;
}

function Dialog({ folderId }: { folderId: string }) {
  const close = () => useStore.getState().setSharing(null);
  const name = useStore((s) => s.folders.find((f) => f.id === folderId)?.name ?? "");
  const { status, busy, act } = useShares();
  const share = status?.shares.find((s) => s.folderId === folderId) ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div data-modal className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/50" onPointerDown={close}>
      <div
        role="dialog"
        aria-label={`「${name}」を共有`}
        className="flex max-h-[88vh] w-[540px] max-w-[92vw] animate-zoom-in flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-5 pt-4 pb-3">
          <div className="flex items-center gap-2 text-base font-semibold">
            <Share2 size={18} className="text-accent" />
            <span className="min-w-0 truncate">「{name}」を共有</span>
          </div>
          <p className="mt-1 text-xs text-dim">
            同じ Wi-Fi・社内 LAN にいる人や自分のスマホから、ブラウザでこのフォルダを見られるようにします（見るだけで、変更はできません）。
          </p>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 text-[13px]">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--color-accent)]"
              checked={!!share}
              disabled={!status || busy}
              onChange={(e) => act(() => api.setFolderShare(folderId, e.target.checked))}
            />
            <span className="min-w-0 flex-1">
              <span className="font-medium">このフォルダを共有する</span>
              <span className="mt-0.5 block text-xs">{serverNote(status, !!share)}</span>
            </span>
          </label>

          {share && (
            <>
              <ShareLink share={share} qr />
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-[var(--color-accent)]"
                  checked={share.download}
                  disabled={busy}
                  onChange={(e) => act(() => api.setShareDownload(folderId, e.target.checked))}
                />
                <span>
                  <span className="font-medium">元のファイルのダウンロードを許可する</span>
                  <span className="mt-0.5 block text-xs text-dim">オフにすると、一覧と画像を見るだけになります。</span>
                </span>
              </label>
              <Notes />
            </>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-line px-5 py-3">
          <button
            onClick={() => {
              close();
              useStore.getState().openSettings("libraryShare");
            }}
            className="text-xs text-dim underline-offset-2 hover:text-fg hover:underline"
          >
            共有中のフォルダの一覧
          </button>
          <button onClick={close} className="ml-auto rounded-md bg-accent-fill px-4 py-1.5 font-medium text-white hover:brightness-110">
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

/** A share's URL (at the chosen address of this PC), with copy, open and, optionally, its QR code. */
function ShareLink({ share, qr }: { share: ShareInfo; qr?: boolean }) {
  const [pick, setPick] = useState(0);
  const [copied, copy] = useCopy();
  const url = share.urls[Math.min(pick, share.urls.length - 1)] ?? null;
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    if (!qr || !url) return;
    let live = true;
    api.shareQr(url).then((s) => live && setSvg(s), () => live && setSvg(null));
    return () => {
      live = false;
    };
  }, [qr, url]);

  if (!url) {
    return (
      <p className="rounded-md border border-line px-3 py-2 text-xs text-dim">
        このパソコンがネットワークにつながっていないため、URL がありません。Wi-Fi・LAN につなぐと表示されます。
      </p>
    );
  }
  const host = (u: string) => new URL(u).hostname;
  return (
    <div className="flex items-start gap-4">
      {qr && (
        <div
          className="size-32 shrink-0 overflow-hidden rounded-md bg-white p-1 [&>svg]:size-full"
          title="スマホのカメラで読み取ると開けます"
          // Made by the app (qrcode crate), not from the library.
          dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
        />
      )}
      <div className="min-w-0 flex-1">
        {qr && <div className="mb-1 text-xs text-dim">スマホはカメラで QR コードを読み取ります。ほかの人には URL を送ります。</div>}
        <div className="flex items-center rounded-md border border-edge bg-bg">
          <span className="min-w-0 flex-1 truncate px-2 py-1.5 font-mono text-xs select-all" title={url}>
            {url}
          </span>
          <button
            onClick={() => copy(url)}
            title="URL をコピー"
            className="flex h-7 shrink-0 items-center gap-1 border-l border-line px-2 text-xs text-dim hover:text-fg"
          >
            <CopyLabel copied={copied} />
          </button>
          <button
            onClick={() => openUrl(url).catch((e) => useStore.getState().toast(String(e), true))}
            title="このパソコンのブラウザで開いて確かめる"
            className="flex h-7 shrink-0 items-center border-l border-line px-2 text-dim hover:text-fg"
          >
            <ExternalLink size={13} />
          </button>
        </div>
        {share.urls.length > 1 && (
          <label className="mt-1.5 flex items-center gap-2 text-xs text-dim">
            アドレス
            <select
              value={pick}
              onChange={(e) => setPick(Number(e.target.value))}
              className="min-w-0 rounded border border-edge bg-bg px-1 py-0.5 text-fg"
            >
              {share.urls.map((u, i) => (
                <option key={u} value={i}>
                  {host(u)}
                  {i === 0 ? "（おすすめ）" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}

function Notes() {
  const [help, setHelp] = useState(false);
  return (
    <div className="space-y-2 rounded-md border border-line px-3 py-2.5 text-xs text-dim">
      <p>
        <span className="font-medium text-fg">見られるもの：</span>
        このフォルダとサブフォルダの中身（名前・サムネイル・画像）。上のフォルダやほかのフォルダは見られません。メモ・タグ・評価は見せません。
      </p>
      <p>
        <span className="font-medium text-fg">気をつけること：</span>
        URL を知っている人は、同じネットワークから誰でも見られます。通信は暗号化されません（HTTP）。
        見せたくなくなったら、共有をオフにすると今の URL はすぐ使えなくなります。
      </p>
      <button onClick={() => setHelp(!help)} className="flex items-center gap-1 font-medium text-fg hover:text-accent">
        <ChevronRight size={13} className={`transition-transform ${help ? "rotate-90" : ""}`} />
        つながらないとき
      </button>
      {help && (
        <ul className="list-disc space-y-1 pl-5">
          <li>見る側が同じ Wi-Fi・LAN につながっているか確かめてください（スマホはモバイル通信ではなく Wi-Fi で）。</li>
          <li>
            Windows：初めて共有したときの「Windows セキュリティの重要な警告」で「プライベート
            ネットワーク」を許可します。ネットワークの種類が「パブリック」だとつながらないので、設定 →「ネットワークとインターネット」で「プライベート」にします。
          </li>
          <li>macOS：「受信接続を許可しますか？」と出たら「許可」を選びます。</li>
          <li>ゲスト用の Wi-Fi など、つないでいる機器どうしの通信を止めているネットワークでは見られません。</li>
          <li>パソコンのアドレスが変わると URL も変わります。上の「アドレス」でほかのアドレスも試せます。</li>
        </ul>
      )}
    </div>
  );
}

/** The settings screen's "共有" page (the open library's shared folders). */
export function ShareSettings() {
  const { status, busy, act } = useShares();
  const shares = status?.shares ?? [];

  const stopAll = async () => {
    const ok = await ask("共有中のフォルダの URL は、すべてすぐに使えなくなります。", {
      title: "すべての共有を停止しますか？",
      kind: "warning",
      okLabel: "停止する",
      cancelLabel: "キャンセル",
    });
    if (ok) await act(api.stopAllShares);
  };

  return (
    <div>
      {/* The frame's header (SettingsFrame) names the page. */}
      <div className="mb-4">
        <p className="text-xs text-dim">
          同じ Wi-Fi・社内 LAN にいる人や自分のスマホに、フォルダを見るだけで共有できます。共有するには、サイドバーのフォルダを右クリック →「共有…」を選びます。
          共有は、このライブラリを開いている間だけ見られます。
        </p>
      </div>

      {status?.error && <p className="mb-3 text-xs text-danger">{status.error}</p>}

      {!status ? (
        <p className="text-xs text-dim">確認中…</p>
      ) : shares.length === 0 ? (
        <p className="rounded-md border border-line px-3 py-2 text-xs text-dim">共有中のフォルダはありません。</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {shares.map((s) => (
            <li key={s.folderId} className="space-y-2 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium" title={s.path}>
                  {s.path}
                </span>
                <button
                  disabled={busy}
                  onClick={() => act(() => api.setFolderShare(s.folderId, false))}
                  className="shrink-0 rounded px-2 py-0.5 text-xs text-dim hover:bg-white/5 hover:text-danger"
                >
                  停止
                </button>
              </div>
              <ShareLink share={s} />
              <label className="flex cursor-pointer items-center gap-2 text-xs text-dim">
                <input
                  type="checkbox"
                  className="size-3.5 accent-[var(--color-accent)]"
                  checked={s.download}
                  disabled={busy}
                  onChange={(e) => act(() => api.setShareDownload(s.folderId, e.target.checked))}
                />
                元のファイルのダウンロードを許可する
              </label>
            </li>
          ))}
        </ul>
      )}

      {shares.length > 1 && (
        <div className="mt-4">
          <button
            disabled={busy}
            onClick={stopAll}
            className="text-xs text-dim underline-offset-2 hover:text-danger hover:underline"
          >
            すべての共有を停止…
          </button>
        </div>
      )}
    </div>
  );
}

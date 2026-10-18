// "Claude と連携" (the settings screen's Claude page): turns the MCP server on or off (src-tauri/src/mcp/), shows
// what to paste into Claude Code / Claude Desktop, and lists the changes made
// from Claude so they can be undone (src-tauri/src/changes.rs).
import { ask } from "@tauri-apps/plugin-dialog";
import { Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { undoChanges } from "../lib/actions";
import { api, type Change, type McpStatus } from "../lib/api";
import { useStore } from "../store";
import { CopyCode, CopyLabel, useCopy } from "./Copy";
import { SwitchRow } from "./SettingsFrame";

export function ClaudeSettings() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Re-read the list after every refresh (a change from Claude, an undo).
  const rev = useStore((s) => s.rev);

  useEffect(() => {
    api.mcpStatus().then(setStatus, (e) => useStore.getState().toast(String(e), true));
  }, []);

  useEffect(() => {
    api.listChanges().then(setChanges, () => setChanges([]));
  }, [rev]);

  const act = async (fn: () => Promise<McpStatus>) => {
    setBusy(true);
    try {
      setStatus(await fn());
    } catch (e) {
      useStore.getState().toast(String(e), true);
    } finally {
      setBusy(false);
    }
  };

  const resetToken = async () => {
    const ok = await ask(
      "Claude Code に登録したコマンドは使えなくなるので、下のコマンドで登録し直してください（Claude Desktop はそのまま使えます）。",
      { title: "トークンを作り直しますか？", kind: "warning", okLabel: "作り直す", cancelLabel: "キャンセル" },
    );
    if (ok) await act(api.resetMcpToken);
  };

  const on = status?.enabled ?? false;

  return (
    <div>
      {/* The frame's header (SettingsFrame) names the page. */}
      <div className="mb-4">
        <p className="text-xs text-dim">
          Claude（Claude Code / Claude
          Desktop）から、いま開いているライブラリのタグ付け・フォルダ分け・表示名の変更・メモを頼めます。
          削除はできず、Claude がした変更はあとから元に戻せます。
        </p>
      </div>

      <div>
        <div className="rounded-lg border border-line bg-bg/40">
          <SwitchRow
            label={<span className="font-medium">Claude からの整理を許可する</span>}
            checked={on}
            disabled={!status || busy}
            onChange={(v) => act(() => api.setMcp(v))}
            hint={
              !status ? (
                "確認中…"
              ) : status.error ? (
                <span className="text-danger">{status.error}</span>
              ) : status.running ? (
                `待ち受け中（127.0.0.1:${status.port}）。このパソコンの中の、トークンを知っている Claude からだけ受け付けます。`
              ) : (
                "オフ。アプリの起動中だけ受け付けます。"
              )
            }
          />
        </div>

        {on && status && (
          <div className="mt-5 space-y-4 text-[13px]">
            {status.claudeCodeCommand && (
              <Section title="Claude Code から使う">
                <p className="text-xs text-dim">
                  ターミナルで次のコマンドを 1 回実行します（どのフォルダで開いた Claude Code
                  からも使えるようになります）。
                </p>
                <CopyBlock text={status.claudeCodeCommand} />
              </Section>
            )}
            {status.desktopConfig && (
              <Section title="Claude Desktop から使う">
                <p className="text-xs text-dim">
                  Claude Desktop の設定 →「開発者」→「設定を編集」で開く <Code text="claude_desktop_config.json" />{" "}
                  に、次の
                  <Code text="mcpServers" /> を書き足して、Claude Desktop
                  を再起動します（ほかのサーバーが既にあれば、その中に
                  <Code text="stockroom" /> の項目だけを足します）。
                </p>
                <CopyBlock text={status.desktopConfig} />
                <p className="mt-1.5 text-xs text-dim">
                  このアプリを別の場所に移したときは、command のパスを書き直してください。
                </p>
              </Section>
            )}
            <Section title="頼み方の例">
              <ul className="list-disc space-y-0.5 pl-4 text-xs text-dim">
                <li>タグなしの画像を、ファイル名から判断してタグ付けして。先に案を見せて</li>
                <li>「IMG_」で始まる名前を「2023-05-12_京都_01」の形にそろえて</li>
                <li>「未整理」フォルダの中身を、名前から「写真/旅行/地名」に分けて</li>
                <li>「素材」フォルダの 20 枚を見て、写真・イラスト・アイコンのタグを付けて</li>
              </ul>
            </Section>
          </div>
        )}

        {changes && changes.length > 0 && (
          <div className="mt-5">
            <div className="mb-1.5 font-medium">Claude がした変更</div>
            <ul className="divide-y divide-line rounded-md border border-line">
              {changes.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-3 py-1.5">
                  <span className="w-24 shrink-0 text-xs text-dim tabular-nums">{when(c.at)}</span>
                  <span
                    className={`min-w-0 flex-1 truncate text-xs ${c.undone ? "text-dim line-through" : ""}`}
                    title={c.summary}
                  >
                    {c.summary}
                  </span>
                  {c.undone ? (
                    <span className="text-xs text-dim">戻し済み</span>
                  ) : (
                    <button
                      onClick={() => undoChanges([c.id], useStore.getState().library?.root)}
                      className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-xs text-dim hover:bg-white/5 hover:text-fg"
                    >
                      <Undo2 size={12} /> 元に戻す
                    </button>
                  )}
                </li>
              ))}
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
            トークンを作り直す…
          </button>
        </div>
      )}
    </div>
  );
}

/** "10/09 14:05" */
function when(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 font-medium">{title}</div>
      {children}
    </div>
  );
}

const Code = CopyCode;

function CopyBlock({ text }: { text: string }) {
  const [copied, copy] = useCopy();
  return (
    <div className="relative mt-2 rounded-md border border-line bg-bg">
      <pre className="max-h-40 overflow-auto py-2 pr-20 pl-2 font-mono text-xs break-all whitespace-pre-wrap">
        {text}
      </pre>
      <button
        onClick={() => copy(text)}
        className="absolute top-1 right-1 flex h-7 items-center gap-1 rounded px-2 text-xs text-dim hover:bg-white/5 hover:text-fg"
        title="コピー"
      >
        <CopyLabel copied={copied} />
      </button>
    </div>
  );
}

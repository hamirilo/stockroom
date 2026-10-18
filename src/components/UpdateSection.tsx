// The settings' "アップデート" section (desktop-platform UI §9). The same file is
// in every tool: which app and version this is, whether a newer one is out,
// checking and installing in place, the automatic check, and what changed
// (the GitHub release page, not notes in the app).
import { CircleCheck, CircleAlert, Download, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import appIcon from "../../src-tauri/icons/128x128@2x.png";
import { APP_NAME, appVersion, checkForUpdate, installUpdate, openReleaseNotes, useUpdate } from "../lib/update";
import { Row, RowButton, Section, SwitchRow } from "./SettingsFrame";

export function UpdateSection({
  autoUpdate,
  onAutoUpdate,
}: {
  /** Undefined while the settings load. */
  autoUpdate: boolean | undefined;
  onAutoUpdate: (on: boolean) => void;
}) {
  const update = useUpdate();
  const version = appVersion();
  const status =
    update.state === "checking" ? (
      <span className="flex items-center gap-1">
        <Loader2 size={12} className="animate-spin" />
        確認しています…
      </span>
    ) : update.state === "latest" ? (
      <span className="flex items-center gap-1 text-success">
        <CircleCheck size={12} />
        最新版です
      </span>
    ) : update.state === "available" ? (
      <span className="flex items-center gap-1 text-accent">
        <Download size={12} />
        v{update.version} が使えます
      </span>
    ) : update.state === "error" ? (
      <span className="flex items-center gap-1 text-danger" title={update.error}>
        <CircleAlert size={12} />
        確認できませんでした。ネットワークを確かめて、もう一度お試しください
      </span>
    ) : null;

  return (
    <Section id="update" title="アップデート">
      <Row
        icon={<img src={appIcon} alt="" className="size-10" draggable={false} />}
        label={
          <span className="font-medium">
            {APP_NAME} <span className="font-normal text-dim tabular-nums">{version || "（開発版）"}</span>
          </span>
        }
        hint={status}
      >
        {update.state === "available" ? (
          <>
            <RowButton onClick={() => openReleaseNotes(update.version)}>
              更新内容
              <ExternalLink size={12} />
            </RowButton>
            <RowButton primary onClick={() => void installUpdate()}>
              更新して再起動
            </RowButton>
          </>
        ) : (
          <RowButton onClick={() => void checkForUpdate(true)} disabled={update.state === "checking"}>
            <RefreshCw size={12} />
            アップデートを確認
          </RowButton>
        )}
      </Row>
      <SwitchRow
        label="アップデートを自動で確認する"
        hint="起動して少したってから確認し、新しいバージョンがあるときだけ知らせます"
        checked={autoUpdate ?? true}
        disabled={autoUpdate === undefined}
        onChange={onAutoUpdate}
      />
      <Row label="このバージョンの更新内容" hint="GitHub のリリースのページを開きます">
        <RowButton onClick={() => openReleaseNotes()} disabled={!version}>
          GitHub で見る
          <ExternalLink size={12} />
        </RowButton>
      </Row>
    </Section>
  );
}

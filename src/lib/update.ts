// In-app updates via tauri-plugin-updater (desktop-platform Distribution §4).
//
// The installers are not Apple / Windows code-signed, so a freshly downloaded
// .dmg / .exe triggers Gatekeeper / SmartScreen every time. Files written by the
// app itself carry no quarantine attribute, so an update applied from inside the
// app launches without that warning. Only the first install still shows it.
//
// What changed is on the GitHub release page, not in the app: the dialog and
// the settings' アップデート section link there ("更新内容を見る").
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { api } from "./api";
import { warn } from "./log";
import { isMac } from "./shortcuts";
import { useStore } from "../store";

/** The name every update dialog and message starts from, so it's clear which app is asking. */
export const APP_NAME = "Stockroom";

const st = () => useStore.getState();

let version = "";
/** Current app version; empty until `loadAppVersion` resolves (and in the browser mock). */
export const appVersion = () => (version ? `v${version}` : "");

/** Where the last check got to, for the settings' アップデート section. */
export type UpdateState =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "latest" }
  | { state: "available"; version: string }
  | { state: "error"; error: string };

export const useUpdate = create<UpdateState>(() => ({ state: "idle" }));
const setUpdate = (s: UpdateState) => useUpdate.setState(s, true);

/** The update found by the last check, until it is installed. */
let pending: Update | null = null;

const LAST_VERSION = "lastVersion";

/**
 * Reads the version, and on the first launch after an update says so once,
 * with a link to what changed: the restart the update made is otherwise
 * unexplained.
 */
export async function loadAppVersion() {
  if (!isTauri()) return;
  try {
    version = await getVersion();
  } catch {
    return;
  }
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_VERSION);
    localStorage.setItem(LAST_VERSION, version);
  } catch {
    return;
  }
  // No record = the first launch ever (or storage was cleared): nothing to say.
  if (last && last !== version) {
    st().notify({
      title: `${APP_NAME} を v${version} に更新しました`,
      kind: "success",
      action: { label: "更新内容を見る", onClick: () => openReleaseNotes(version) },
    });
  }
}

/** This version's (or `v`'s) release page on GitHub, in the browser. */
export function openReleaseNotes(v = version) {
  if (!v) return;
  api.openReleasePage(v).catch((e) => st().toast(`更新内容を開けませんでした: ${e}`, true));
}

let busy = false;

/** Same as `plugins.updater.endpoints` in src-tauri/tauri.conf.json. */
const FEED = "https://github.com/hamirilo/stockroom/releases/latest/download/latest.json";

/**
 * The proxy the OS would use for the feed (PAC included). The updater's HTTP
 * client can't evaluate PAC scripts, so behind a company proxy it would try to
 * connect directly and fail. Undefined = direct.
 */
async function systemProxy(): Promise<string | undefined> {
  try {
    return (await api.systemProxy(FEED)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The settings' 一般 page is open: its アップデート section shows the result, so no toast or dialog. */
const inSettings = () => st().settingsTab === "general";

/**
 * Check GitHub Releases for a newer version. `manual` reports "up to date" and
 * errors; the automatic startup check stays silent unless an update exists.
 */
export async function checkForUpdate(manual: boolean) {
  if (busy) return;
  if (!isTauri()) {
    if (manual) st().toast("ブラウザ版ではアップデートを確認できません", true);
    return;
  }
  busy = true;
  if (manual) setUpdate({ state: "checking" });
  // One toast for the whole check: the result rewrites "確認しています…" in place.
  // It lasts past the check's timeout so it doesn't vanish before the result.
  const progress =
    manual && !inSettings() ? st().notify({ title: "アップデートを確認しています…", duration: 30_000 }) : undefined;
  try {
    // The proxy also applies to the download (the Update keeps it).
    const update = await check({ timeout: 15_000, proxy: await systemProxy() });
    if (!update) {
      pending = null;
      setUpdate({ state: "latest" });
      if (manual && !inSettings()) {
        st().notify({ title: "最新版です", detail: `${APP_NAME} ${appVersion()}`, kind: "success", replace: progress });
      } else if (progress !== undefined) st().dismissToast(progress);
      return;
    }
    pending = update;
    setUpdate({ state: "available", version: update.version });
    if (progress !== undefined) st().dismissToast(progress);
    if (!inSettings()) await offer(update);
  } catch (e) {
    if (manual) {
      setUpdate({ state: "error", error: String(e) });
      if (!inSettings()) {
        st().notify({ title: "アップデートを確認できませんでした", detail: String(e), kind: "error", replace: progress });
      } else if (progress !== undefined) st().dismissToast(progress);
    } else warn("update check failed", e);
  } finally {
    busy = false;
  }
}

const INSTALL = "更新して再起動";
const LATER = "あとで";
const NOTES = "更新内容を見る";

/**
 * Asks whether to install. The title names the app (on macOS it is the
 * alert's bold line, on Windows the window's title), so it never reads as
 * an anonymous pop-up; what changed is one click away on GitHub.
 */
async function offer(update: Update) {
  const choice = await message(
    `v${update.version} が使えます（今のバージョンは v${update.currentVersion}）。\n` +
      `更新すると ${APP_NAME} が再起動します。`,
    {
      title: `${APP_NAME} の新しいバージョンがあります`,
      kind: "info",
      // Each OS's order: macOS puts the default on the right with "later"
      // next to it, Windows puts the default first and "later" last.
      buttons: isMac ? { yes: INSTALL, no: LATER, cancel: NOTES } : { yes: INSTALL, no: NOTES, cancel: LATER },
    },
  );
  if (choice === INSTALL) await install(update);
  else if (choice === NOTES) openReleaseNotes(update.version);
  // あとで, Esc: the settings (and the next check) offer it again.
}

/** Installs the update the last check found (the settings' button). */
export async function installUpdate() {
  if (pending && !busy) await install(pending);
}

async function install(update: Update) {
  busy = true;
  let done = 0;
  let total: number | null = null;
  st().setUpdating({ done, total });
  // Chunks arrive hundreds of times a second; re-rendering on each restarts
  // the bar's width transition every time, so it lagged and even ran backwards.
  let shown = 0;
  const show = (force = false) => {
    const now = performance.now();
    if (!force && now - shown < 120) return;
    shown = now;
    st().setUpdating({ done, total });
  };
  try {
    await update.downloadAndInstall((ev) => {
      if (ev.event === "Started") {
        total = ev.data.contentLength || null;
        show(true);
      } else if (ev.event === "Progress") {
        done += ev.data.chunkLength;
        show();
      } else if (ev.event === "Finished") {
        done = total ?? done;
        st().setUpdating({ done, total, installing: true });
      }
    });
  } catch (e) {
    busy = false;
    st().setUpdating(null);
    await message(`アップデートに失敗しました。もう一度試すか、GitHub から新しい版を入れてください。\n\n${String(e)}`, {
      title: `${APP_NAME} のアップデート`,
      kind: "error",
    });
    return;
  }
  st().setUpdating(null);
  // Windows: the installer has already asked the app to exit by now; relaunch is
  // a no-op there. macOS: the .app was swapped in place, restart to pick it up.
  await relaunch();
}

/**
 * Check a few seconds after launch in release builds, unless turned off in
 * the settings ("アップデートを自動で確認する"). Returns a cleanup.
 */
export function scheduleUpdateCheck(): () => void {
  if (import.meta.env.DEV || !isTauri()) return () => {};
  const t = setTimeout(() => {
    api.getAppSettings().then(
      (s) => void (s.autoUpdate && checkForUpdate(false)),
      () => checkForUpdate(false),
    );
  }, 4000);
  return () => clearTimeout(t);
}

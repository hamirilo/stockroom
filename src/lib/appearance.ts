/**
 * Appearance (ライト／ダーク), docs/UI.md「色」: "system" follows the OS,
 * "light" / "dark" are the user's choice (settings screen, 一般). The page's
 * colours key off `<html data-theme="light|dark">` (index.css), which is always
 * the resolved theme. The window's theme is set as well, so native parts
 * (scroll bars, form controls, the title bar) match.
 */
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSyncExternalStore } from "react";

export type Appearance = "system" | "light" | "dark";

const CACHE_KEY = "appearance";
const LIGHT_QUERY = "(prefers-color-scheme: light)";

export const parseAppearance = (v: unknown): Appearance => (v === "light" || v === "dark" ? v : "system");

/** The choice last applied, kept so the first paint isn't the wrong theme. */
function cached(): Appearance {
  try {
    return parseAppearance(localStorage.getItem(CACHE_KEY));
  } catch {
    return "system";
  }
}

let current: Appearance = "system";
let stop: (() => void) | null = null;

function resolve(a: Appearance): "light" | "dark" {
  if (a !== "system") return a;
  return window.matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
}

function paint() {
  document.documentElement.dataset.theme = resolve(current);
}

/** Apply a choice: the page now, the window's theme, and (for "system") follow the OS. */
export function applyAppearance(a: Appearance) {
  current = a;
  try {
    localStorage.setItem(CACHE_KEY, a);
  } catch {
    // the cache is only for the first paint
  }
  stop?.();
  stop = null;
  if (isTauri()) {
    getCurrentWindow()
      .setTheme(a === "system" ? null : a)
      .catch(() => {});
  }
  if (a === "system") {
    const mq = window.matchMedia(LIGHT_QUERY);
    mq.addEventListener("change", paint);
    stop = () => mq.removeEventListener("change", paint);
  }
  paint();
}

/** At launch, before the first render: the cached choice (the saved one arrives with the settings). */
export function setUpAppearance() {
  applyAppearance(cached());
}

/** The theme on screen now ("system" resolved), for the quick switch. */
export const shownTheme = (): "light" | "dark" => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

/** The other of light / dark: what the quick switch (toolbar button, 表示 menu) chooses. */
export const otherTheme = (): "light" | "dark" => (shownTheme() === "light" ? "dark" : "light");

/** Re-renders when `<html data-theme>` changes (a choice, or the OS under "system"). */
export function useShownTheme(): "light" | "dark" {
  return useSyncExternalStore(
    (notify) => {
      const mo = new MutationObserver(notify);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      return () => mo.disconnect();
    },
    shownTheme,
    () => "dark",
  );
}

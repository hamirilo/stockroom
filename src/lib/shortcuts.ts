/**
 * The keyboard shortcuts and mouse gestures, for the shortcut list (?).
 * Rows of operations come from the command table (commands.ts), which the
 * menus and the list's key handler use too; the rest (moving around, the
 * viewer, the mouse) are described here.
 *
 * A combo is written like "Mod+Shift+R": Mod is ⌘ on macOS and Ctrl elsewhere.
 * "Click", "Drag", "Wheel" and "Pinch" are mouse gestures, "0-5" and "Arrows"
 * key ranges, "=" the ⌘+ key.
 */
import { type ItemKind } from "./api";
import { MODES, modeLabel } from "./modes";
import { command } from "./commands";
import type { Layout } from "../store";

export type ShortcutRow = {
  label: string;
  /** Alternatives, any of which does it. */
  keys: string[];
  /** Kinds it works for (all when absent). */
  kinds?: ItemKind[];
  /** A different label in some layouts. */
  labelIn?: Partial<Record<Layout, string>>;
};

export type ShortcutSection = { id: string; title: string; rows: ShortcutRow[] };

/** A row for a command; `extra` adds keys only the list or the viewer handles. */
function cmd(id: string, over: Partial<ShortcutRow> = {}): ShortcutRow {
  const c = command(id);
  return { label: c.title, keys: c.keys ?? [], kinds: c.kinds, ...over };
}

/** Two commands on one row ("左に回転 / 右に回転"). */
function pair(a: string, b: string, label: string): ShortcutRow {
  const x = command(a);
  const y = command(b);
  return { label, keys: [...(x.keys ?? []), ...(y.keys ?? [])], kinds: x.kinds };
}

let sections: ShortcutSection[] | null = null;

/** Built on first use: the command table must be loaded first (it imports the shortcut list's store). */
export function shortcutSections(): ShortcutSection[] {
  sections ??= [
    {
      id: "general",
      title: "全体",
      rows: [
        { label: MODES.map(modeLabel).join(" / "), keys: MODES.map((_, i) => `Mod+${i + 1}`) },
        cmd("view.sidebar", { label: "サイドバーの表示・非表示" }),
        cmd("view.inspector", { label: "情報を表示（表示中なら詳細パネルを閉じる）" }),
        cmd("view.shelf", { label: "シェルフを表示（表示中なら詳細パネルを閉じる）" }),
        cmd("edit.search"),
        cmd("edit.filter", { label: "絞り込みの行へ" }),
        cmd("go.folder", { label: "フォルダを開く（名前で探す）" }),
        {
          ...pair("view.zoomIn", "view.zoomOut", "サムネイルを大きく / 小さく"),
          labelIn: { specimen: "見本の文字を大きく / 小さく" },
        },
        cmd("app.settings", { label: "設定" }),
        cmd("help.shortcuts", { label: "ショートカット一覧" }),
      ],
    },
    {
      id: "list",
      title: "一覧の移動と選択",
      rows: [
        { label: "移動", keys: ["Arrows", "A", "D"] },
        { label: "範囲を選択", keys: ["Shift+Arrows", "Shift+Click"] },
        { label: "選択に追加・外す", keys: ["Mod+Click"] },
        { label: "囲んで選択（背景からドラッグ）", keys: ["Drag", "Shift+Drag"] },
        cmd("edit.selectAll"),
        cmd("edit.deselect"),
        cmd("item.show", { label: "表示（ビューアで開く）" }),
      ],
    },
    {
      id: "item",
      title: "選択した項目",
      rows: [
        cmd("item.favorite"),
        cmd("item.pin"),
        cmd("item.tray", { label: "シェルフに追加・外す" }),
        { label: "評価", keys: ["0-5"] },
        { label: "評価して次へ", keys: ["Shift+0-5"] },
        pair("item.rotateCcw", "item.rotateCw", "左に回転 / 右に回転"),
        cmd("item.rename"),
        cmd("item.copy"),
        pair("item.copyTags", "item.pasteTags", "タグをコピー / 貼り付け"),
        cmd("list.export", { label: "書き出し（選択がなければ一覧）" }),
        cmd("item.trash"),
      ],
    },
    {
      id: "organize",
      title: "整理",
      rows: [
        cmd("item.moveTo"),
        cmd("item.moveToLast"),
        { label: "フォルダへ入れる", keys: ["Drag"] },
        { label: "別の項目へドラッグして紐づける（親子の紐づけが有効なとき）", keys: ["Drag"] },
        cmd("item.link"),
        cmd("item.unlink"),
        cmd("item.adopt"),
        cmd("folder.new"),
        cmd("smart.new"),
        pair("folder.up", "folder.down", "フォルダを上へ / 下へ"),
        pair("folder.top", "folder.bottom", "フォルダを先頭へ / 末尾へ"),
      ],
    },
    {
      id: "viewer",
      title: "ビューア",
      rows: [
        { label: "前 / 次", keys: ["Arrows", "A", "D"] },
        { label: "最初 / 最後", keys: ["Home", "End"] },
        { label: "閉じる", keys: ["Esc", "Space", "Enter"] },
        { label: "再生 / 一時停止", keys: ["K"], kinds: ["video"] },
        { label: "10 秒戻す / 進める", keys: ["J", "L"], kinds: ["video"] },
        { label: "1 コマ戻す / 進める（一時停止中）", keys: [",", "."], kinds: ["video"] },
        { label: "全体表示 ⇔ 実寸", keys: ["Z"], kinds: ["image"] },
        { label: "拡大 / 縮小", keys: ["Mod+=", "Mod+-", "Alt+Wheel", "Pinch"], kinds: ["image"] },
        { label: "実寸 / 全体を表示", keys: ["Mod+0", "Mod+9"], kinds: ["image"] },
        { label: "詳細", keys: ["I"] },
        { label: "前後のサムネイル", keys: ["T"] },
        { label: "画像のみ表示（操作や情報を隠す）", keys: ["H"] },
        { label: "お気に入り・ピン留め・シェルフ・評価", keys: ["F", "P", "B", "0-5"] },
        pair("item.rotateCcw", "item.rotateCw", "左に回転 / 右に回転"),
      ],
    },
    {
      id: "dialog",
      title: "ダイアログ・入力",
      rows: [
        { label: "閉じる・入力をやめる", keys: ["Esc"] },
        { label: "候補を選ぶ / 決定（フォルダ選び・タグ）", keys: ["↑", "↓", "Enter"] },
      ],
    },
  ];
  return sections;
}

// ------------------------------------------------------------ display

export const isMac = navigator.userAgent.includes("Mac");

const MOUSE: Record<string, string> = { Click: "クリック", Drag: "ドラッグ", Wheel: "ホイール", Pinch: "ピンチ" };

const MAC: Record<string, string> = {
  Mod: "⌘",
  Alt: "⌥",
  Shift: "⇧",
  Backspace: "⌫",
  // "↩" is drawn as an emoji.
  Enter: "Return",
};
const OTHER: Record<string, string> = { Mod: "Ctrl", Alt: "Alt", Shift: "Shift" };

/** A key or gesture as shown: `cap` is drawn as a key, otherwise as text. */
export type KeyPart = { text: string; cap: boolean };

export function keyParts(combo: string): KeyPart[] {
  return combo.split("+").map((p) => {
    if (MOUSE[p]) return { text: MOUSE[p], cap: false };
    if (p === "0-5") return { text: "0〜5", cap: true };
    if (p === "Arrows") return { text: "← → ↑ ↓", cap: true };
    if (p === "=") return { text: "+", cap: true };
    return { text: (isMac ? MAC : OTHER)[p] ?? p, cap: true };
  });
}

/** "⌘⇧R" / "Ctrl+Shift+R": how a combo reads (menus, searching). */
export const comboText = (combo: string) =>
  keyParts(combo)
    .map((p) => p.text)
    .join(isMac ? "" : "+");

const norm = (s: string) => s.toLowerCase().replace(/[\s+＋]/g, "");

/** Rows matching the query by name, or by key ("⌘R", "ctrl+r", "F"). */
export function matchRow(row: ShortcutRow, label: string, query: string): boolean {
  const q = norm(query);
  if (!q) return true;
  if (norm(label).includes(q)) return true;
  return row.keys.some((k) => {
    const shown = norm(comboText(k));
    const last = norm(keyParts(k).at(-1)?.text ?? "");
    return shown === q || last === q || norm(k) === q;
  });
}

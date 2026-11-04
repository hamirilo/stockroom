// A library open on another PC (library.lock, see src-tauri/src/library.rs):
// opening it is refused with "LOCKED:<holder JSON>"; this asks whether to
// open it anyway. Two PCs using one library at once (through Dropbox,
// OneDrive, iCloud Drive…) can lose changes or leave conflicting copies.
import { ask } from "@tauri-apps/plugin-dialog";
import type { LibraryInfo } from "./api";

/** Who has the library open (library.rs `Holder`). */
interface Holder {
  name: string;
  /** Last refreshed (ms). */
  at: number;
}

/** library.rs LOCK_STALE_MS: not refreshed for this long = left behind. */
const STALE_MS = 6 * 60 * 1000;

function holderOf(e: unknown): Holder | null {
  const m = /^LOCKED:(.*)$/s.exec(String(e));
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as Holder;
  } catch {
    return null;
  }
}

const when = (ms: number) =>
  new Date(ms).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The library's name from its folder ("/x/Photos.library" → "Photos"). */
const nameOf = (root: string) => root.split(/[\\/]/).filter(Boolean).pop()?.replace(/\.library$/, "") ?? root;

/**
 * Runs `open` (an open / create command taking `force`); when the library
 * is open elsewhere, asks and, if the user agrees, opens it anyway. Resolves
 * to null when they don't. Other errors are thrown as they are.
 */
export async function openGuarded<T extends LibraryInfo | null>(
  root: string | null,
  open: (force: boolean) => Promise<T>,
): Promise<T | null> {
  try {
    return await open(false);
  } catch (e) {
    const h = holderOf(e);
    if (!h) throw e;
    const lib = root ? `「${nameOf(root)}」` : "前回のライブラリ";
    const stale = Date.now() - h.at > STALE_MS;
    const ok = await ask(
      stale
        ? `${lib}は「${h.name}」で開かれたまま、正しく閉じられていない可能性があります（最後の確認：${when(h.at)}）。\n\n` +
            `「${h.name}」でまだ開いていなければ、そのまま開いて大丈夫です。`
        : `${lib}は「${h.name}」で開かれています（${when(h.at)} に確認）。\n\n` +
            "2 台で同時に開くと、片方の変更が失われたり、クラウドの同期で競合したりすることがあります。" +
            `「${h.name}」でアプリを終了し、同期が終わってから開いてください。`,
      {
        title: stale ? "ほかのパソコンで開いたままです" : "ほかのパソコンで開かれています",
        kind: "warning",
        okLabel: stale ? "開く" : "このまま開く",
        cancelLabel: "開かない",
      },
    );
    return ok ? open(true) : null;
  }
}

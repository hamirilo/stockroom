// Making bookmarks: a URL pasted into the list. docs/BOOKMARKS.md
import { currentFolderId, notifyUnusedKinds, usedModes, useStore } from "../../store";
import { bookmarksApi } from "./api";

const st = () => useStore.getState();

/** The address if `text` is one http(s) URL and nothing else (what a browser's address bar copies). */
export function pastedUrl(text: string): string | null {
  const t = text.trim();
  return /^https?:\/\/[^\s]+$/i.test(t) ? t : null;
}

/**
 * Shows item `id` in the viewer's list: where it is if it's there, else in
 * "すべて" of the stock with the conditions cleared. False when it can't be
 * shown (the library isn't used for bookmarks).
 */
async function reveal(id: string): Promise<boolean> {
  const find = () => st().items.findIndex((i) => i.id === id);
  if (find() < 0) {
    if (st().mode !== "stock") st().setMode("stock");
    if (st().filter.kinds.length && !st().filter.kinds.includes("bookmark")) st().setKinds([]);
    st().setView({ kind: "all" });
    await st().refresh();
  }
  const at = find();
  if (at < 0) return false;
  st().select(id, "only", at);
  return true;
}

/**
 * A URL pasted into the list: kept as a bookmark in the open folder. The app
 * fetches nothing, so it is named after its host; saving the page from the
 * browser extension brings its title, description and picture.
 */
export async function pasteBookmark(url: string) {
  const s = st();
  if (!s.library) return;
  // The font mode has no bookmarks; pasting there is most likely a slip.
  if (s.mode !== "stock") return;
  try {
    const { id, duplicate } = await bookmarksApi.create(url, currentFolderId());
    await st().refresh();
    if (!usedModes(st()).includes("bookmark")) return notifyUnusedKinds({ bookmark: 1 });
    st().notify({
      title: duplicate ? "すでにブックマークにあります" : "ブックマークに追加しました",
      kind: "success",
      action: { label: "選ぶ", onClick: () => void reveal(id) },
    });
  } catch (e) {
    st().toast(`ブックマークに追加できませんでした：${e}`, true);
  }
}

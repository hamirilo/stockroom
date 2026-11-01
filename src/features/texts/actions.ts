// Making texts: "新規テキスト" (⌘N) and pasting words into the list. docs/TEXT.md
import { buildHas } from "../../lib/limits";
import { currentFolderId, notifyUnusedKinds, usedModes, useStore } from "../../store";
import { textsApi } from "./api";

const st = () => useStore.getState();

/** The text the viewer should open in the editor (just made with ⌘N). */
let editNext: string | null = null;

/** Whether the viewer should start editing `id` (asked once). */
export function takeEditNext(id: string): boolean {
  if (editNext !== id) return false;
  editNext = null;
  return true;
}

/**
 * Shows item `id` in the viewer: in the list as it is if it's there, else in
 * "すべて" of the stock with the conditions cleared. False when it can't be
 * shown (the library isn't used for texts).
 */
async function reveal(id: string): Promise<boolean> {
  const find = () => st().items.findIndex((i) => i.id === id);
  if (find() < 0) {
    if (st().mode !== "stock") st().setMode("stock");
    if (st().filter.kinds.length && !st().filter.kinds.includes("text")) st().setKinds([]);
    st().setView({ kind: "all" });
    await st().refresh();
  }
  const at = find();
  if (at < 0) return false;
  st().select(id, "only", at);
  st().openViewer(at);
  return true;
}

/** A new empty Markdown text in the open folder, opened in the editor. */
export async function createText() {
  const s = st();
  if (!s.library) return;
  try {
    const id = await textsApi.create("無題.md", "", currentFolderId());
    await st().refresh();
    editNext = id;
    if (!(await reveal(id))) {
      editNext = null;
      notifyUnusedKinds({ text: 1 });
    }
  } catch (e) {
    st().toast(`テキストを作れませんでした：${e}`, true);
  }
}

/**
 * What words pasted into the list are saved as: TSV when every line has the
 * same tabs (cells copied from Excel), Markdown when it starts with a heading,
 * else plain text. Named after the first line.
 */
export function pastedName(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  const tabs = lines.map((l) => l.split("\t").length - 1);
  const ext = lines.length > 1 && tabs[0] > 0 && tabs.every((n) => n === tabs[0]) ? "tsv" : /^#{1,6} /.test(text) ? "md" : "txt";
  const first = (lines.find((l) => l.trim()) ?? "")
    .replace(/^#{1,6} /, "")
    .replace(/\t/g, " ")
    .replace(/[/\\:*?"<>|]/g, "_")
    .trim()
    .slice(0, 40);
  return `${first || "貼り付けたテキスト"}.${ext}`;
}

/** Words pasted into the list (no files on the clipboard): a new text with them. */
export async function pasteText(text: string) {
  const s = st();
  // A build without texts (src/lib/limits.ts).
  if (!s.library || !text.trim() || !buildHas("text")) return;
  // The font mode has no texts; pasting there is most likely a slip.
  if (s.mode !== "stock") return;
  try {
    const name = pastedName(text);
    const id = await textsApi.create(name, text, currentFolderId());
    await st().refresh();
    if (!usedModes(st()).includes("text")) return notifyUnusedKinds({ text: 1 });
    st().notify({
      title: `「${name}」を作りました`,
      kind: "success",
      action: { label: "開く", onClick: () => void reveal(id) },
    });
  } catch (e) {
    st().toast(`テキストを作れませんでした：${e}`, true);
  }
}

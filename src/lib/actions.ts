// User-level actions shared by several components (dialogs + API + refresh).
import { listen } from "@tauri-apps/api/event";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { api, EMPTY_FILTER, isSystemId, kindLabel, kindOfExt, libraryIds, type DuplicateEffect, type Item, type ItemKind, type LibraryInfo, type Mode, type OrientOp, type View } from "./api";
import { itemsNoun, kindsNoun, MODES, modeLabel } from "./modes";
import { fontApi } from "../features/fonts/api";
import {
  activeConditions,
  currentFolderId,
  FONT_SHELF_MAX,
  isHidden,
  queryKinds,
  shownKinds,
  useStore,
  type ListSource,
  type ToastAction,
} from "../store";
import { rowIds } from "./grouping";
import { openGuarded } from "./libraryLock";
import { showHud } from "../components/ActionHud";
import { warn } from "./log";
import { notifyIfAway } from "./osNotify";

const st = () => useStore.getState();

/**
 * A toast button to the view something was just added to, when its sidebar
 * entry is hidden: hiding is only for display, so it must stay reachable.
 */
function hiddenViewAction(entry: string, label: string, view: View): ToastAction | undefined {
  return isHidden(st(), entry) ? { label, onClick: () => st().setView(view) } : undefined;
}

export async function createLibraryDialog() {
  const path = await save({ title: "新しいライブラリの保存先", defaultPath: "MyPictures.library" });
  if (!path) return;
  try {
    // An existing library at the path opens instead; it may be open elsewhere.
    const lib = await openGuarded(path, (force) => api.createLibrary(path, true, force));
    if (lib) st().setLibrary(lib);
  } catch (e) {
    st().toast(String(e), true);
  }
}

export async function openLibraryDialog() {
  const path = await open({ title: "ライブラリフォルダを選択", directory: true });
  if (typeof path !== "string") return;
  try {
    const lib = await openGuarded(path, (force) => api.openLibrary(path, force));
    if (lib) st().setLibrary(lib);
  } catch (e) {
    st().toast(String(e), true);
  }
}

/** Switches to a library from the list of known ones. */
export async function openLibraryAt(root: string) {
  if (st().library?.root === root) return;
  try {
    const lib = await openGuarded(root, (force) => api.openLibrary(root, force));
    if (lib) st().setLibrary(lib);
  } catch (e) {
    st().notify({ title: "ライブラリを開けませんでした", detail: String(e), kind: "error" });
  }
}

/** Picks a folder for a new library without opening it (a destination to copy into). */
export async function createLibraryOnly(): Promise<LibraryInfo | null> {
  const path = await save({ title: "新しいライブラリの保存先", defaultPath: "MyFonts.library" });
  if (!path) return null;
  try {
    return await api.createLibrary(path, false);
  } catch (e) {
    st().toast(String(e), true);
    return null;
  }
}

/** Picks an existing library folder without opening it. */
export async function pickLibraryFolder(): Promise<string | null> {
  const path = await open({ title: "ライブラリフォルダを選択", directory: true });
  return typeof path === "string" ? path : null;
}

/**
 * Copies (or moves) items into another library, keeping their tags, folder,
 * rating, favourite and note. Moving puts them in this library's trash.
 */
export async function transferTo(
  dest: LibraryInfo,
  scope: { ids: string[] } | { kind: ItemKind },
  move: boolean,
) {
  const verb = move ? "移動" : "コピー";
  const label = `「${dest.name}」へ${verb}中…`;
  const since = Date.now();
  st().setImporting({ label, done: 0, total: 0 });
  const unlisten = await listen<{ done: number; total: number }>("transfer-progress", (e) =>
    st().setImporting({ label, ...e.payload }),
  );
  try {
    const r = await api.transferItems(dest.root, "ids" in scope ? { ids: libraryIds(scope.ids) } : scope, move);
    const n = r.copied + r.duplicates;
    const parts = [];
    if (r.duplicates) parts.push(`${r.duplicates} 件はすでにあったため、タグとフォルダだけ統合`);
    const unused = Object.keys(r.unusedKinds ?? {}) as ItemKind[];
    if (unused.length)
      parts.push(`「${dest.name}」は${unused.map(kindLabel).join("・")}を使わない設定です（開いて設定から使う種類に追加できます）`);
    if (r.failed.length) parts.push(`${r.failed.length} 件は失敗：${r.failed.slice(0, 2).join("、")}`);
    if (move && n)
      parts.push(
        r.trashed === null
          ? "途中で別のライブラリを開いたため、元のライブラリには残したままです"
          : "元のライブラリではゴミ箱に入っています",
      );
    // Left in this library: it was a copy after all.
    const done = move && r.trashed === null ? "コピー" : verb;
    const title = n ? `${n} 件を「${dest.name}」へ${done}しました` : `「${dest.name}」へ${verb}できませんでした`;
    const detail = parts.join(" / ") || undefined;
    st().notify({
      title,
      detail,
      kind: n ? "success" : "error",
      action: n ? { label: `「${dest.name}」を開く`, onClick: () => openLibraryAt(dest.root) } : undefined,
      duration: 10000,
    });
    notifyIfAway(since, title, detail);
    if (r.failed.length) warn("transfer failures", r.failed);
  } catch (e) {
    st().notify({ title: `${verb}できませんでした`, detail: String(e), kind: "error" });
  } finally {
    unlisten();
    st().setImporting(null);
    await st().refresh();
  }
}

/**
 * The kind "<種類>をすべて別のライブラリへ" works on: the one the list is
 * narrowed to (the font mode, or the kind filter), if one.
 */
export function transferableKind(s = st()): ItemKind | null {
  const kinds = shownKinds(s);
  return kinds.length === 1 ? kinds[0] : null;
}

/** Opens the "別のライブラリへ" dialog for every item of a kind (the shown one by default). */
export function transferAllOfKind(kind = transferableKind()) {
  if (!kind) return;
  const count = st().counts.kinds[kind] ?? 0;
  if (!count) {
    st().toast(`このライブラリに${kindLabel(kind)}はありません`);
    return;
  }
  st().setTransfer({ ids: null, kind, count });
}

let busy = false;

async function guarded(fn: () => Promise<void>) {
  if (busy) {
    st().toast("インポート中です。完了までお待ちください。");
    return;
  }
  busy = true;
  try {
    await fn();
  } catch (e) {
    st().toast(String(e), true);
  } finally {
    busy = false;
    st().setImporting(null);
    await st().refresh();
  }
}

/** `folderId` overrides the folder currently open in the grid. */
export function importPaths(paths: string[], folderId?: string) {
  if (!paths.length || !st().library) return;
  const folder = folderId ?? currentFolderId();
  const since = Date.now();
  return guarded(async () => st().importDone(await api.importPaths(paths, folder), since));
}

/** Picks files of the kinds shown (any supported file can still be dropped). */
export async function importFilesDialog() {
  const kinds = shownKinds(st());
  const exts = (await api.supportedExts()).filter((e) => kinds.includes(kindOfExt(e)));
  const picked = await open({
    title: `${kindsNoun(kinds)}を追加`,
    multiple: true,
    filters: [
      {
        name: kinds.length === 1 ? kindLabel(kinds[0]) : "対応しているファイル",
        extensions: [...exts, ...exts.map((e) => e.toUpperCase())],
      },
    ],
  });
  if (picked) await importPaths(Array.isArray(picked) ? picked : [picked]);
}

export async function importFolderDialog() {
  const picked = await open({ title: "フォルダから追加", directory: true, multiple: true });
  if (picked) await importPaths(Array.isArray(picked) ? picked : [picked]);
}

export function importClipboardFiles(files: File[]) {
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (!images.length || !st().library) return;
  const folder = currentFolderId();
  return guarded(async () => {
    const total = { imported: 0, duplicates: 0, failed: [] as string[] };
    for (const f of images) {
      const ext = f.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
      // Clipboard images are usually all called "image.png"; give them a dated name.
      const name =
        f.name && f.name !== "image.png"
          ? f.name
          : `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
      const s = await api.importBytes(name, new Uint8Array(await f.arrayBuffer()), folder);
      total.imported += s.imported;
      total.duplicates += s.duplicates;
      total.failed.push(...s.failed);
    }
    st().importDone(total);
  });
}

/** Moves to trash, or deletes permanently when already in the trash. */
export async function deleteSelection(ids: string[]) {
  ids = libraryIds(ids);
  if (!ids.length) return;
  const before = st().items;
  if (st().view.kind === "trash") {
    const ok = await ask(`${ids.length} 件の画像を完全に削除します。元に戻せません。`, {
      title: "完全に削除",
      kind: "warning",
      okLabel: "削除",
      cancelLabel: "キャンセル",
    });
    if (!ok) return;
    await st().run(() => api.deleteItems(ids));
  } else {
    if (!(await st().run(() => api.trashItems(ids)))) return;
    st().toast(`${ids.length} 件をゴミ箱へ移動しました`, false, {
      label: "元に戻す",
      onClick: () => st().run(() => api.restoreItems(ids)),
    });
  }
  selectSuccessor(before, ids);
}

/**
 * After items left the list, selects the one that came after them (else the
 * one before), so ⌫ can go on and the viewer keeps a selection to act on.
 */
function selectSuccessor(before: Item[], gone: string[]) {
  const s = st();
  if (s.selected.size) return; // something of the selection is still there
  const removed = new Set(gone);
  const present = new Set(s.items.map((i) => i.id));
  let last = -1;
  before.forEach((row, n) => {
    if (removed.has(row.id) || rowIds([row]).some((id) => removed.has(id))) last = n;
  });
  if (last < 0) return;
  const next =
    before.slice(last + 1).find((i) => present.has(i.id)) ??
    before.slice(0, last).reverse().find((i) => present.has(i.id));
  if (!next) return;
  const at = s.items.findIndex((i) => i.id === next.id);
  s.select(next.id, "only", at);
  if (s.viewer !== null) s.openViewer(at);
}

/** Splits the similar view's list into its groups (best copy first in each). */
export function similarGroups(items: Item[]): Item[][] {
  const out: Item[][] = [];
  for (const i of items) {
    if (i.group === undefined) continue;
    if (out.length && out[out.length - 1][0].group === i.group) out[out.length - 1].push(i);
    else out.push([i]);
  }
  return out;
}

/** The copy to keep: the one the user picked, else the best (first). */
export function keeperOf(group: Item[], picked: Set<string>): Item {
  return group.find((i) => picked.has(i.id)) ?? group[0];
}

/** Per group: the id to keep first, then the ids to trash. */
export function keepPlan(groups: Item[][], picked: Set<string>): string[][] {
  return groups.map((g) => {
    const keep = keeperOf(g, picked);
    return [keep.id, ...g.filter((i) => i !== keep).map((i) => i.id)];
  });
}

/**
 * Opens the tidy-up review for `groups` (each: the copy to keep, then the
 * copies to trash). Nothing changes until the user confirms there.
 */
export async function reviewDuplicates(groups: string[][]) {
  const byId = new Map(st().items.map((i) => [i.id, i]));
  const review = groups
    .filter((g) => g.length > 1 && g.every((id) => byId.has(id)))
    .map(([keep, ...remove]) => ({ keep: byId.get(keep)!, remove: remove.map((id) => byId.get(id)!) }));
  if (!review.length) return;
  st().setReview({ groups: review, effects: null });
  try {
    const effects = await api.previewDuplicates(review.map(planOf));
    if (st().review) st().setReview({ groups: review, effects });
  } catch (e) {
    st().setReview(null);
    st().toast(String(e), true);
  }
}

const planOf = (g: { keep: Item; remove: Item[] }) => ({ keep: g.keep.id, remove: g.remove.map((i) => i.id) });

/** Runs the tidy-up that the review dialog showed. */
export async function confirmDuplicates() {
  const review = st().review;
  if (!review) return;
  st().setReview(null);
  const plan = review.groups.map(planOf);
  const removed = plan.flatMap((p) => p.remove);
  try {
    const effects = await api.resolveDuplicates(plan);
    const tags = new Set(effects.flatMap((e) => e.addedTags)).size;
    const carried = [
      tags ? `タグ ${tags} 種` : "",
      effects.some((e) => e.rating != null) ? "評価" : "",
      effects.some((e) => e.folderId) ? "フォルダ" : "",
    ].filter(Boolean);
    st().toast(
      `${plan.length} グループの重複 ${removed.length} 枚をゴミ箱へ移動しました` +
        (carried.length ? `（${carried.join("・")}を残す1枚へ引き継ぎ）` : ""),
      false,
      {
        label: "元に戻す",
        onClick: () => st().run(() => undoDuplicates(removed, effects)),
      },
    );
  } catch (e) {
    st().toast(String(e), true);
  }
  useStore.setState({ keepPick: new Set() });
  await st().refresh();
}

/**
 * Undoes a tidy-up: the trashed copies come back, and the kept ones lose
 * what they were given (tags, the higher rating, the folder).
 */
async function undoDuplicates(removed: string[], effects: DuplicateEffect[]) {
  await api.restoreItems(removed);
  const tagId = new Map(st().tags.map((t) => [t.name, t.id]));
  for (const e of effects) {
    for (const name of e.addedTags) {
      const id = tagId.get(name);
      if (id !== undefined) await api.removeTag([e.keep], id);
    }
    if (e.rating != null) await api.setRating([e.keep], e.ratingBefore);
    if (e.folderId) await api.removeFromFolder([e.keep], e.folderId);
  }
}

/** Marks a group as "not duplicates" so it stops being proposed. */
export async function dismissDuplicates(ids: string[]) {
  try {
    await api.dismissDuplicates(ids);
    const gone = new Set(ids);
    useStore.setState({ keepPick: new Set([...st().keepPick].filter((x) => !gone.has(x))) });
    st().toast(`${ids.length} 枚のグループを重複ではないとしました`, false, {
      label: "元に戻す",
      onClick: () => st().run(() => api.undismissDuplicates(ids)),
    });
  } catch (e) {
    st().toast(String(e), true);
  }
  await st().refresh();
}

/** Brings back every group dismissed as "not duplicates". */
export async function clearDismissedDuplicates() {
  try {
    await api.clearDismissedDuplicates();
    st().toast("無視した候補をすべて解除しました");
  } catch (e) {
    st().toast(String(e), true);
  }
  await st().refresh();
}

export async function emptyTrash() {
  const n = st().counts.trash;
  if (!n) return;
  const ok = await ask(`ゴミ箱の ${n} 件を完全に削除します。元に戻せません。`, {
    title: "ゴミ箱を空にする",
    kind: "warning",
    okLabel: "空にする",
    cancelLabel: "キャンセル",
  });
  if (ok) await st().run(() => api.emptyTrash());
}

export async function confirmDeleteFolder(id: string, name: string) {
  const ok = await ask(
    `フォルダ「${name}」とそのサブフォルダを削除します。\n中の画像は削除されません。`,
    { title: "フォルダを削除", kind: "warning", okLabel: "削除", cancelLabel: "キャンセル" },
  );
  if (ok) await st().run(() => api.deleteFolder(id));
}

export async function confirmDeleteTag(id: number, name: string) {
  const ok = await ask(`タグ「${name}」を削除します。画像からも外れます。`, {
    title: "タグを削除",
    kind: "warning",
    okLabel: "削除",
    cancelLabel: "キャンセル",
  });
  if (ok) await st().run(() => api.deleteTag(id));
}

// ------------------------------------------------------------ organizing

const folderName = (id: string) => st().folders.find((f) => f.id === id)?.name ?? "";

/** Moves items into a folder (an item is in one folder at most). */
export async function moveToFolder(ids: string[], folderId: string) {
  ids = libraryIds(ids);
  if (!ids.length) return;
  if (!(await st().run(() => api.moveToFolder(ids, folderId)))) return;
  st().rememberFolders([folderId]);
  st().flashTarget(`folder:${folderId}`);
  const name = folderName(folderId);
  st().toast(
    `${ids.length} 件を「${name}」へ移動しました`,
    false,
    hiddenViewAction("section:folders", `「${name}」を開く`, { kind: "folder", id: folderId }),
  );
}

/** Shift+D: repeat the last "move to folder". */
export function moveToLastFolder(ids: string[]) {
  const last = st().recentFolders[0];
  if (!last) {
    st().setPicker("move");
    return;
  }
  return moveToFolder(ids, last);
}

/** Creates a folder of the mode and starts renaming it in the sidebar. */
export async function createFolder(parentId: string | null, itemIds: string[] = []) {
  try {
    const id = await api.createFolder("新しいフォルダ", parentId, st().mode);
    itemIds = libraryIds(itemIds);
    if (itemIds.length) await api.moveToFolder(itemIds, id);
    await st().refresh();
    if (!st().sidebarOpen) st().toggleSidebar();
    st().setRenamingFolder(id);
    return id;
  } catch (e) {
    st().toast(String(e), true);
  }
}

/** ⌘⇧N: new folder next to the open one (or at the top level). */
export function createFolderHere() {
  const cur = currentFolderId();
  const parent = cur ? (st().folders.find((f) => f.id === cur)?.parentId ?? null) : null;
  return createFolder(parent);
}

/**
 * `quiet`: done on the control itself (the heart, the stars, the viewer's
 * buttons), where the change shows; otherwise the HUD says what happened.
 */
type Feedback = { quiet?: boolean };

export async function setRating(ids: string[], rating: number, { quiet }: Feedback = {}) {
  ids = libraryIds(ids);
  if (!ids.length) return;
  await st().run(async () => {
    await api.setRating(ids, rating);
    if (!quiet) showHud({ kind: "rating", rating }, ids);
  });
}

/** True when every one of `ids` has the flag (so a toggle turns it off). */
function allHave(ids: string[], flag: (i: Item) => boolean): boolean {
  const byId = new Map(st().rawItems.map((i) => [i.id, i]));
  return ids.length > 0 && ids.every((id) => flag(byId.get(id)!));
}

/** F: adds to favourites, or removes when every selected image already is one. */
export async function toggleFavorite(ids: string[], { quiet }: Feedback = {}) {
  ids = libraryIds(ids);
  if (!ids.length) return;
  const on = !allHave(ids, (i) => i.favorite);
  const ok = await st().run(async () => {
    await api.setFavorite(ids, on);
    if (!quiet) showHud({ kind: "favorite", on }, ids);
  });
  if (!ok) return;
  const open = on ? hiddenViewAction("favorites", "お気に入りを開く", { kind: "favorites" }) : undefined;
  if (open) st().toast(`${ids.length} 件をお気に入りに追加しました`, false, open);
}

/** P: pins to the top of every list, or unpins when all are pinned. */
export async function togglePinned(ids: string[], { quiet }: Feedback = {}) {
  ids = libraryIds(ids);
  if (!ids.length) return;
  const on = !allHave(ids, (i) => i.pinnedAt !== null);
  const ok = await st().run(async () => {
    await api.setPinned(ids, on);
    if (!quiet) showHud({ kind: "pin", on }, ids);
  });
  if (!ok) return;
  // Like favourites: a toast only to reach the list when the sidebar hides it.
  const open = on ? hiddenViewAction("pinned", "ピン留めを開く", { kind: "pinned" }) : undefined;
  if (open) st().toast(`${ids.length} 件をピン留めしました（一覧の先頭に表示）`, false, open);
}

/** Rotates / flips the images without changing the files. */
export async function orient(ids: string[], op: OrientOp, { quiet }: Feedback = {}) {
  ids = libraryIds(ids);
  if (!ids.length) return;
  await st().run(async () => {
    await api.orientItems(ids, op);
    if (!quiet) showHud({ kind: "orient", op }, ids);
  });
}

/** Manual order: move `ids` in front of `before` (null = end) in the open folder. */
export async function reorder(ids: string[], before: string | null) {
  const folder = currentFolderId();
  if (!folder) return;
  await st().run(() => api.reorderInFolder(folder, ids, before));
}

// --------------------------------------------------------------- shelf
// The shelf under the list (the `tray` table): things gathered for a while,
// one per mode. In the font mode it holds what is compared, at most
// FONT_SHELF_MAX (docs/FONT_UI.md).

/**
 * What putting `ids` on the shelf puts there: in the font mode a whole
 * family (its row selected) goes as its row's font, the one the comparison
 * starts from; a style opened under its family (▸) goes on its own.
 */
export function shelfIds(ids: string[]): string[] {
  const s = st();
  if (s.mode !== "font") return ids;
  const want = new Set(ids);
  const whole = new Map<string, string>();
  for (const row of s.items) {
    if (row.familyIds && row.familyIds.every((id) => want.has(id))) row.familyIds.forEach((id) => whole.set(id, row.id));
  }
  return [...new Set(ids.map((id) => whole.get(id) ?? id))];
}

/** Whether `ids` (as `shelfIds` takes them) are all on the shelf. */
export function onShelf(ids: string[]): boolean {
  const shelf = new Set(st().shelf.map((i) => i.id));
  const want = shelfIds(ids);
  return want.length > 0 && want.every((id) => shelf.has(id));
}

/**
 * What dropping (or B on) `ids` would do to the shelf: how many are not on it
 * yet, and whether that goes past the font shelf's limit. The shelf shows it
 * while they are dragged over it.
 */
export function shelfAdding(ids: string[]): { fresh: number; full: boolean } {
  const there = new Set(st().shelf.map((i) => i.id));
  const fresh = shelfIds(ids).filter((id) => !there.has(id)).length;
  return { fresh, full: st().mode === "font" && there.size + fresh > FONT_SHELF_MAX };
}

/** The toast's "シェルフを開く" while the shelf is folded. */
const openShelfAction = (): ToastAction | undefined =>
  st().shelfOpen ? undefined : { label: "シェルフを開く", onClick: () => st().toggleShelf() };

/**
 * Puts `ids` on the shelf: library items, and on the font shelf the fonts
 * installed on this computer too (docs/SYSTEM_FONTS.md). Returns how many were added.
 */
function trayAdd(ids: string[]): Promise<number> {
  const system = ids.filter(isSystemId);
  const items = libraryIds(ids);
  return Promise.all([
    items.length ? api.addToTray(items) : 0,
    system.length ? fontApi.addSystemToTray(system) : 0,
  ]).then(([a, b]) => a + b);
}

/** Puts items (and installed fonts) on the shelf, after the ones already there. */
export async function addToTray(ids: string[]) {
  if (!ids.length) return;
  const want = shelfIds(ids);
  const { fresh, full } = shelfAdding(ids);
  if (full) {
    st().notify({
      title: `シェルフは ${FONT_SHELF_MAX} 件までです。外してから追加してください`,
      detail: `今 ${st().shelf.length} 件・追加しようとしたのは ${fresh} 件`,
      kind: "error",
    });
    return;
  }
  let added = 0;
  const ok = await st().run(async () => {
    added = await trayAdd(want);
  });
  if (!ok) return;
  st().flashTarget("tray");
  // The open shelf shows it (the new chips, the count, the flash), so no toast
  // then; folded, only the count would change (docs/NOTIFICATIONS.md).
  if (!added) st().toast("すでにシェルフにあります");
  else if (!st().shelfOpen) st().toast(`${added} 件をシェルフに追加しました`, false, openShelfAction());
}

/** B: puts items on the shelf, or takes them off when all are already there. */
export async function toggleTray(ids: string[]) {
  if (!ids.length) return;
  if (!onShelf(ids)) return addToTray(ids);
  return removeFromShelf(shelfIds(ids));
}

/** Takes items off the shelf (they stay in the library), with an undo. */
export async function removeFromShelf(ids: string[]) {
  if (!ids.length) return;
  if (!(await st().run(() => api.removeFromTray(ids)))) return;
  st().toast(`${ids.length} 件をシェルフから外しました`, false, {
    label: "元に戻す",
    onClick: () => st().run(() => trayAdd(ids)),
  });
}

/** Moves shelf items `ids` in front of `before` (null = to the end). */
export function reorderShelf(ids: string[], before: string | null) {
  return st().run(() => api.reorderTray(ids, before));
}

/** Takes everything off the shelf (the items themselves stay). */
export async function clearTray() {
  // Only the mode's shelf: the other mode keeps its own.
  const ids = st().shelf.map((i) => i.id);
  if (!ids.length) return;
  if (!(await st().run(() => api.removeFromTray(ids)))) return;
  st().toast(`シェルフを空にしました（${ids.length} 件）`, false, {
    label: "元に戻す",
    onClick: () => st().run(() => trayAdd(ids)),
  });
}

/** Items of the kinds shown in `view`, in the list's sort (the tray: its own order). */
function queryView(view: View, opts: { tagIds?: number[]; includeSubfolders?: boolean } = {}): Promise<Item[]> {
  const s = st();
  const manual = view.kind === "folder" && s.sort === "manual";
  return api.queryItems({
    view,
    search: "",
    tagIds: opts.tagIds ?? [],
    tagMatchAll: false,
    includeSubfolders: opts.includeSubfolders ?? false,
    minRating: 0,
    filter: { ...EMPTY_FILTER, kinds: queryKinds({ ...s, view }) },
    similarLevel: "standard",
    sort: manual ? "manual" : s.sort === "manual" ? "importedAt" : s.sort,
    desc: manual ? false : s.desc,
  });
}

/**
 * The items a "contents of this list" action works on (書き出し, まとめて出力,
 * シェルフにすべて追加, 別のライブラリへ). A folder includes its subfolders
 * unless `subfolders` is false (the export dialog's choice, not the view's
 * "サブフォルダの内容を表示").
 */
export async function listTargets(source: ListSource, subfolders = true): Promise<Item[]> {
  switch (source.kind) {
    case "ids": {
      const want = new Set(source.ids);
      return displayOrder().filter((i) => want.has(i.id));
    }
    case "shown":
      return displayOrder();
    case "tray":
      // What the shelf shows, in its order (installed fonts stay where they are).
      return st().shelf.filter((i) => !isSystemId(i.id));
    case "folder":
      return queryView({ kind: "folder", id: source.id }, { includeSubfolders: subfolders });
    case "smart":
      return queryView({ kind: "smart", id: source.id });
    case "tag":
      return queryView({ kind: "tag", id: source.id });
  }
}

/** What the selection-or-list commands (⌘E, まとめて出力…) work on: the selection, else the list on screen. */
export function selectionOrShown(): ListSource {
  const s = st();
  if (s.selected.size) return { kind: "ids", ids: [...s.selected] };
  // A folder's whole tree, so the export dialog can offer to keep its structure.
  if (s.view.kind === "folder") return { kind: "folder", id: s.view.id };
  return { kind: "shown" };
}

/** Name of a list source for titles ("「旅行」", "選択した 3 件"). */
export function sourceName(source: ListSource): string {
  const s = st();
  switch (source.kind) {
    case "ids":
      return `選択した ${source.ids.length} 件`;
    case "shown":
      return "表示中の一覧";
    case "tray":
      return "シェルフ";
    case "folder":
      return `「${s.folders.find((f) => f.id === source.id)?.name ?? ""}」`;
    case "smart":
      return `「${s.smartFolders.find((f) => f.id === source.id)?.name ?? ""}」`;
    case "tag":
      return `タグ「${s.tags.find((t) => t.id === source.id)?.name ?? ""}」`;
  }
}

/** Runs `fn` on the items of `source`, telling when there are none. */
async function withTargets(source: ListSource, fn: (items: Item[]) => unknown) {
  try {
    const items = await listTargets(source);
    if (!items.length) {
      st().toast(`${sourceName(source)}に${kindsNoun(shownKinds(st()))}はありません`);
      return;
    }
    await fn(items);
  } catch (e) {
    st().toast(String(e), true);
  }
}

/** 書き出し… for a list (the dialog asks where, and for folders how). */
export function exportList(source: ListSource) {
  st().setExporting({ source, title: `${sourceName(source)}を書き出し` });
}

/** ライブラリ全体を書き出し… (docs/EXPORT.md). */
export function exportLibrary() {
  st().setExporting({ source: { kind: "library" }, title: "ライブラリ全体を書き出し" });
}

/**
 * Copies every item not in the trash into a new "<library name>" folder in
 * `dest`, laid out like the app's folders, with progress and a キャンセル.
 */
export async function writeLibrary(dest: string) {
  const label = "ライブラリを書き出し中…";
  const since = Date.now();
  const cancel = () => void api.cancelExport();
  st().setImporting({ label, done: 0, total: 0, cancel });
  const unlisten = await listen<{ done: number; total: number }>("export-progress", (e) =>
    st().setImporting({ label, ...e.payload, cancel }),
  );
  try {
    const labels = Object.fromEntries(MODES.map((m) => [m, modeLabel(m)])) as Record<Mode, string>;
    const r = await api.exportLibrary(dest, labels);
    const title = r.cancelled ? `書き出しを中止しました（${r.copied} / ${r.total} 件）` : `${r.copied} 件を書き出しました`;
    const parts = [r.folder];
    if (r.failed.length) parts.push(`${r.failed.length} 件は失敗：${r.failed.slice(0, 2).join("、")}`);
    const detail = parts.join(" / ");
    st().notify({
      title,
      detail,
      kind: r.cancelled || r.failed.length ? "info" : "success",
      action: { label: "書き出し先を表示", onClick: () => st().run(() => api.revealPath(r.folder)) },
      duration: 10000,
    });
    notifyIfAway(since, title, detail);
    if (r.failed.length) warn("export failures", r.failed);
  } catch (e) {
    st().notify({ title: "書き出せませんでした", detail: String(e), kind: "error" });
  } finally {
    unlisten();
    st().setImporting(null);
  }
}

/** まとめて出力… for a list. */
export function sheetList(source: ListSource) {
  return withTargets(source, (items) => st().setSheet(items));
}

/** シェルフにすべて追加. */
export function trayList(source: ListSource) {
  return withTargets(source, (items) => addToTray(items.map((i) => i.id)));
}

/** 別のライブラリへ… for a list. */
export function transferList(source: ListSource) {
  return withTargets(source, (items) =>
    st().setTransfer({ ids: items.map((i) => i.id), noun: itemsNoun(items), count: items.length }),
  );
}

/**
 * Items as the list shows them (one listed in several groups counts once, where
 * it first appears). Library items only: the installed fonts aren't taken out
 * or put on the shelf (docs/SYSTEM_FONTS.md).
 */
function displayOrder(): Item[] {
  const seen = new Set<string>();
  return st().items.filter((i) => !isSystemId(i.id) && !seen.has(i.id) && seen.add(i.id));
}

/** まとめて出力… of the shelf, in its order. */
export function sheetFromTray() {
  return sheetList({ kind: "tray" });
}

/** 書き出し… of the shelf. */
export function exportTray() {
  exportList({ kind: "tray" });
}

// ------------------------------------------------------- contact sheet

/** Opens "まとめて出力" for the listed items `ids`, in the order the list shows them. */
export function openSheet(ids: string[]) {
  const want = new Set(libraryIds(ids));
  const items = displayOrder().filter((i) => want.has(i.id));
  if (items.length) st().setSheet(items);
}

// ---------------------------------------------------------- taking out

export async function copySelection(ids: string[]) {
  ids = libraryIds(ids);
  if (!ids.length) return;
  try {
    const n = await api.copyItems(ids);
    st().toast(`${n} 件をクリップボードにコピーしました`);
  } catch (e) {
    st().toast(String(e), true);
  }
}

export function exportSelection(ids: string[]) {
  ids = libraryIds(ids);
  if (ids.length) exportList({ kind: "ids", ids });
}

export async function openSelection(ids: string[]) {
  ids = libraryIds(ids);
  if (!ids.length) return;
  if (ids.length > 10) {
    const ok = await ask(`${ids.length} 件を既定のアプリで開きます。よろしいですか？`, {
      title: "既定のアプリで開く",
      okLabel: "開く",
      cancelLabel: "キャンセル",
    });
    if (!ok) return;
  }
  await st().run(() => api.openItems(ids));
}

// -------------------------------------------------------- smart folders

/**
 * Saves the current conditions as a new smart folder and opens it. With no
 * conditions set yet, the new folder opens straight into editing them.
 */
export async function createSmartFolder() {
  const s = st();
  const empty = activeConditions(s) === 0;
  try {
    const rule = s.currentRule();
    const id = await api.createSmartFolder("新しいスマートフォルダ", rule, s.mode);
    // The conditions now live in the folder; start it with a clean slate.
    useStore.setState({ search: "", tagFilter: [], minRating: 0, filter: EMPTY_FILTER });
    s.setView({ kind: "smart", id });
    if (!st().sidebarOpen) st().toggleSidebar();
    st().setRenamingFolder(id);
    if (empty) st().startEditSmart({ id, name: "新しいスマートフォルダ", rule, count: 0, color: null, mode: s.mode });
  } catch (e) {
    s.toast(String(e), true);
  }
}

/** Writes the edited conditions back to the smart folder being edited. */
export async function saveEditedSmartFolder() {
  const s = st();
  const editing = s.editingSmart;
  if (!editing) return;
  try {
    await api.updateSmartFolder(editing.id, { rule: s.currentRule() });
    leaveSmartEdit(editing.id);
    st().toast(`スマートフォルダ「${editing.name}」の条件を保存しました`);
  } catch (e) {
    s.toast(String(e), true);
  }
}

export function cancelSmartEdit() {
  const editing = st().editingSmart;
  if (editing) leaveSmartEdit(editing.id);
}

function leaveSmartEdit(id: string) {
  useStore.setState({ editingSmart: null, search: "", tagFilter: [], minRating: 0, filter: EMPTY_FILTER });
  st().setView({ kind: "smart", id });
}

export async function renameSmartFolder(id: string, name: string) {
  await st().run(() => api.updateSmartFolder(id, { name }));
}

export async function confirmDeleteSmartFolder(id: string, name: string) {
  const ok = await ask(`スマートフォルダ「${name}」を削除します。\n画像は削除されません。`, {
    title: "スマートフォルダを削除",
    kind: "warning",
    okLabel: "削除",
    cancelLabel: "キャンセル",
  });
  if (ok) await st().run(() => api.deleteSmartFolder(id));
}

// --------------------------------------------------------- folder order

/** ⌘[ / ⌘] (one step) and ⌘⇧[ / ⌘⇧] (to the top / bottom). */
export async function shiftFolder(id: string, by: -1 | 1, toEnd = false) {
  if (await st().run(() => api.shiftFolder(id, toEnd ? by * 1_000_000 : by))) st().flashTarget(`folder:${id}`);
}

export async function sortFoldersByName(parentId: string | null) {
  await st().run(() => api.sortFoldersByName(parentId, st().mode));
}

// ------------------------------------------------------- tag clipboard

/** ⌘⇧C: copies the tags of the selection (all of them, for several images). */
export async function copyTags(ids: string[]) {
  ids = libraryIds(ids);
  if (!ids.length) return;
  try {
    const info = await api.selectionInfo(ids);
    const names = info.tags.map((t) => t.name);
    st().setTagClipboard(names);
    st().toast(names.length ? `タグ ${names.length} 件をコピーしました：${names.join("、")}` : "タグはありません");
  } catch (e) {
    st().toast(String(e), true);
  }
}

/** ⌘⇧V: adds the copied tags to the selection. */
export async function pasteTags(ids: string[]) {
  ids = libraryIds(ids);
  const names = st().tagClipboard;
  if (!ids.length) return;
  if (!names.length) {
    st().toast("コピーしたタグがありません（⌘⇧C でコピー）");
    return;
  }
  if (!(await st().run(() => api.addTags(ids, names)))) return;
  st().rememberTags(names);
  st().toast(`${ids.length} 件にタグ ${names.length} 件を貼り付けました`);
}

/**
 * Undoes changes made from Claude (newest first) and says how it went.
 * Change ids are numbered per library: `root` is the library they belong to,
 * and nothing is undone once another one is open.
 */
export async function undoChanges(ids: number[], root: string | undefined) {
  if (st().library?.root !== root) {
    st().toast("別のライブラリを開いているため元に戻せません。元のライブラリで、設定の「連携」から戻せます", true);
    return;
  }
  let skipped = 0;
  let done = 0;
  await st().run(async () => {
    for (const id of [...ids].sort((a, b) => b - a)) {
      skipped += (await api.undoChange(id)).skipped;
      done++;
    }
  });
  if (!done) return;
  st().notify({
    title: done > 1 ? `Claude の変更 ${done} 件を元に戻しました` : "Claude の変更を元に戻しました",
    detail: skipped ? `${skipped} 件はその後に変更されていたため、そのままにしました` : undefined,
    kind: "success",
  });
}

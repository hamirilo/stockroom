// Talking to the Stockroom app (src-tauri/src/webimport.rs) and the bits
// shared by the background worker, the popup and the image list.

const DEFAULT_PORT = 41620;

export class AppError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const NOT_RUNNING =
  "Stockroom に接続できません。アプリを起動して、ライブラリのメニュー →「ブラウザ拡張と連携」で受け付けをオンにしてください";
export const NOT_CONNECTED =
  "この拡張機能はアプリと接続されていません。拡張機能のアイコン →「アプリと接続」を押してください";

/**
 * Where and how to connect. Keys to try, in order: the one the app gave when
 * the user allowed this extension ("アプリと接続"), then the one in
 * `config.json`, which the app writes into the copy it sets up.
 */
export async function getConfig() {
  let file = {};
  try {
    const res = await fetch(chrome.runtime.getURL("config.json"), { cache: "no-store" });
    if (res.ok) file = await res.json();
  } catch {
    /* not the copy the app set up */
  }
  const stored = await chrome.storage.local.get(["token"]);
  const tokens = [...new Set([stored.token, file.token].filter(Boolean).map(String))];
  return { port: Number(file.port) || DEFAULT_PORT, tokens };
}

async function request(port, path, init) {
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, { cache: "no-store", ...init });
  } catch {
    throw new AppError(NOT_RUNNING, 0);
  }
}

/** Calls the app. Throws AppError with a message to show (status 401 = not connected). */
export async function call(path, { method = "GET", params, body } = {}) {
  const { port, tokens } = await getConfig();
  if (!tokens.length) throw new AppError(NOT_CONNECTED, 401);
  const qs = params ? `?${params}` : "";
  let res;
  for (const token of tokens) {
    // A refused key is checked before the body is read, so sending again is safe.
    res = await request(port, path + qs, { method, body, headers: { Authorization: `Bearer ${token}` } });
    if (res.status !== 401) break;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(json.error || `エラー（${res.status}）`, res.status);
  return json;
}

/**
 * Asks the app to let this extension in: the user sees `code` in the app and
 * presses 許可する. Resolves once they answer (up to about two minutes).
 */
export async function pair(code) {
  const { port } = await getConfig();
  const res = await request(port, `/pair?code=${code}`, { method: "POST" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.token) throw new AppError(json.error || `エラー（${res.status}）`, res.status);
  await chrome.storage.local.set({ token: json.token });
}

/** Opens the page that connects the extension to the app. */
export function openConnectPage() {
  return chrome.tabs.create({ url: chrome.runtime.getURL("connect.html") });
}

// ----------------------------------------------------------- destination

/** Folder and tags new images go to, as chosen in the popup / image list. */
export async function getDestination() {
  const d = await chrome.storage.local.get(["folderId", "tags"]);
  return { folderId: d.folderId || null, tags: Array.isArray(d.tags) ? d.tags : [] };
}

export function setDestination(patch) {
  return chrome.storage.local.set(patch);
}

/** Folders as rows in tree order, with their depth and full path. */
export function folderRows(folders) {
  const kids = new Map();
  for (const f of folders) {
    if (!kids.has(f.parentId)) kids.set(f.parentId, []);
    kids.get(f.parentId).push(f);
  }
  const out = [];
  const walk = (parent, depth, prefix) => {
    for (const f of kids.get(parent) ?? []) {
      const path = prefix ? `${prefix} / ${f.name}` : f.name;
      out.push({ ...f, depth, path });
      walk(f.id, depth + 1, path);
    }
  };
  walk(null, 0, "");
  return out;
}

/**
 * Wires a folder <select> and a tag editor to the stored destination.
 * `tagBox` is an element holding the chips and an <input list=…>.
 */
export async function bindDestination({ folderSelect, tagBox, tagInput, tagList }) {
  const dest = await getDestination();
  let tags = [...dest.tags];

  const [folders, known] = await Promise.all([call("/folders"), call("/tags").catch(() => [])]);
  folderSelect.replaceChildren(new Option("未分類（フォルダに入れない）", ""));
  for (const f of folderRows(folders)) {
    folderSelect.append(new Option(`${"　".repeat(f.depth)}${f.name}`, f.id));
  }
  // A folder deleted in the app falls back to "unfiled".
  folderSelect.value = folders.some((f) => f.id === dest.folderId) ? dest.folderId : "";
  if (folderSelect.value !== (dest.folderId ?? "")) setDestination({ folderId: null });
  folderSelect.onchange = () => setDestination({ folderId: folderSelect.value || null });

  tagList.replaceChildren(...known.map((t) => new Option(t)));
  const render = () => {
    tagBox.querySelectorAll(".chip").forEach((c) => c.remove());
    for (const t of tags) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = t;
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.title = "外す";
      x.onclick = () => {
        tags = tags.filter((n) => n !== t);
        save();
      };
      chip.append(x);
      tagBox.insertBefore(chip, tagInput);
    }
  };
  const save = () => {
    setDestination({ tags });
    render();
  };
  const add = () => {
    const names = tagInput.value.split(/[,、]/).map((s) => s.trim()).filter(Boolean);
    tagInput.value = "";
    const fresh = names.filter((n) => !tags.some((t) => t.toLowerCase() === n.toLowerCase()));
    if (fresh.length) {
      tags = [...tags, ...fresh];
      save();
    }
  };
  tagInput.onkeydown = (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    } else if (e.key === "Backspace" && !tagInput.value && tags.length) {
      tags = tags.slice(0, -1);
      save();
    }
  };
  // Picking a suggestion from the list.
  tagInput.oninput = () => {
    if (known.includes(tagInput.value)) add();
  };
  tagInput.onblur = add;
  tagBox.onclick = (e) => e.target === tagBox && tagInput.focus();
  render();
  return folders;
}

// --------------------------------------------------------------- saving

const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "font/ttf": "ttf",
  "font/otf": "otf",
  "font/woff": "woff",
  "font/woff2": "woff2",
};

const clean = (s) =>
  s
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

/** A file name for an image: the last part of its URL, else `fallback`, with an extension from the type. */
export function fileName(url, type, fallback = "image") {
  let base = "";
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") {
      base = decodeURIComponent(u.pathname.split("/").pop() || "");
    }
  } catch {
    /* malformed URL or escape: use the fallback */
  }
  base = clean(base) || clean(fallback) || "image";
  const ext = MIME_EXT[(type || "").split(";")[0].trim().toLowerCase()];
  if (ext && !/\.[a-z0-9]{2,5}$/i.test(base)) base += `.${ext}`;
  return base;
}

/** The format an image URL most likely has (for the image list's filter). */
export function guessExt(url) {
  const data = /^data:image\/([a-z0-9.+-]+)/i.exec(url);
  if (data) return data[1].toLowerCase().replace("svg+xml", "svg").replace("jpeg", "jpg");
  try {
    const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
    const e = m?.[1].toLowerCase();
    return e === "jpeg" ? "jpg" : e === "tif" ? "tiff" : e ?? "";
  } catch {
    return "";
  }
}

/**
 * Downloads an image. The extension's own request comes first (it carries the
 * browser's cookies for the site); if the site refuses it, the page itself
 * fetches it (works for same-site images and the page's blob: URLs).
 */
export async function fetchImage(url, tabId, frameId = 0) {
  if (!url.startsWith("blob:")) {
    try {
      const res = await fetch(url, { credentials: "include" });
      if (res.ok) return await res.blob();
    } catch {
      /* try from the page */
    }
  }
  if (tabId == null) throw new AppError("画像をダウンロードできませんでした", 0);
  let result;
  try {
    [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      args: [url],
      func: async (u) => {
        try {
          const res = await fetch(u);
          if (!res.ok) return null;
          const blob = await res.blob();
          return await new Promise((resolve) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => resolve(null);
            r.readAsDataURL(blob);
          });
        } catch {
          return null;
        }
      },
    });
  } catch {
    /* the page can't be scripted (e.g. the Web Store) */
  }
  if (!result) throw new AppError("画像をダウンロードできませんでした（サイトが取得を拒否しています）", 0);
  return await (await fetch(result)).blob();
}

/** Sends a downloaded file to the app with the stored destination. */
export async function sendToApp(blob, name, pageUrl) {
  const dest = await getDestination();
  const params = new URLSearchParams({ name });
  if (dest.folderId) params.set("folder", dest.folderId);
  for (const t of dest.tags) params.append("tag", t);
  if (pageUrl && /^https?:/.test(pageUrl)) params.set("page", pageUrl);
  try {
    return await call("/import", { method: "POST", params, body: blob });
  } catch (e) {
    // The chosen folder was deleted in the app: forget it so the next save works.
    if (e.status === 400 && dest.folderId) await setDestination({ folderId: null });
    throw e;
  }
}

/** Downloads `url` and saves it. Returns the app's answer ({ imported, duplicates }). */
export async function saveImage(url, { tabId, frameId, pageUrl, title } = {}) {
  const blob = await fetchImage(url, tabId, frameId);
  return sendToApp(blob, fileName(url, blob.type, title), pageUrl);
}

/** What the page says about itself. Runs in the page (chrome.scripting), so it can't use anything outside. */
function readPage() {
  const meta = (sel) => document.querySelector(sel)?.getAttribute("content")?.replace(/\s+/g, " ").trim() || "";
  const abs = (u) => {
    try {
      return new URL(u, document.baseURI).href;
    } catch {
      return "";
    }
  };
  // The biggest icon the page names; /favicon.ico when it names none.
  const icons = [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')].map((l) => ({
    href: abs(l.getAttribute("href") || ""),
    size: Math.max(0, ...(l.getAttribute("sizes") || "").split(/\s+/).map((s) => parseInt(s, 10) || 0)),
  }));
  icons.sort((a, b) => b.size - a.size);
  return {
    title: document.title.replace(/\s+/g, " ").trim() || meta('meta[property="og:title"]'),
    description: meta('meta[property="og:description"]') || meta('meta[name="description"]'),
    image: abs(meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]')),
    favicons: [...icons.map((i) => i.href).filter(Boolean), abs("/favicon.ico")],
  };
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Downloads a picture the page named and redraws it at most `maxSide` px
 * (PNG, or JPEG for photographs) as a data: URL. Null when it can't be had or
 * read (an SVG, say); the bookmark is kept without it.
 */
async function pictureData(url, maxSide, type) {
  if (!/^https?:/.test(url)) return null;
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > 12 * 1024 * 1024) return null;
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    const ctx = canvas.getContext("2d");
    if (type === "image/jpeg") {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const out = await canvas.convertToBlob({ type, quality: 0.85 });
    return `data:${type};base64,${toBase64(await out.arrayBuffer())}`;
  } catch {
    return null;
  }
}

/**
 * Keeps the page of `tab` as a bookmark: its title and description, its
 * favicon and its eyecatch (og:image), read here in the browser (with its
 * cookies and proxy settings) and sent to the app, which fetches nothing.
 * Returns the app's answer ({ imported, duplicates }).
 */
export async function saveBookmark(tab) {
  if (!/^https?:/.test(tab.url ?? "")) throw new AppError("この種類のページはブックマークできません", 0);
  let page = { title: tab.title ?? "", description: "", image: "", favicons: [] };
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPage });
    if (result) page = result;
  } catch {
    /* the page can't be scripted: the tab's own title and address still do */
  }
  const image = page.image ? await pictureData(page.image, 1024, "image/jpeg") : null;
  let favicon = null;
  for (const href of page.favicons.slice(0, 3)) {
    favicon = await pictureData(href, 64, "image/png");
    if (favicon) break;
  }
  const dest = await getDestination();
  const body = JSON.stringify({
    url: tab.url,
    title: page.title || tab.title || "",
    description: page.description,
    favicon,
    image,
    folder: dest.folderId || null,
    tags: dest.tags,
  });
  try {
    return await call("/bookmark", { method: "POST", body });
  } catch (e) {
    // The chosen folder was deleted in the app: forget it so the next save works.
    if (e.status === 400 && dest.folderId) await setDestination({ folderId: null });
    throw e;
  }
}

/** "保存しました" / "すでにあります" for a bookmark result. */
export function bookmarkMessage(res) {
  return res.imported ? "ブックマークに保存しました" : "すでにブックマークにあります";
}

/** "保存しました" / "すでにあります" for an import result. */
export function savedMessage(res) {
  return res.imported ? "Stockroom に保存しました" : "すでに Stockroom にあります";
}

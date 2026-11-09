// Service worker: right-click menu, Alt+right-click saves (from content.js)
// and the screenshot / image list actions shared with the popup.
import { bookmarkMessage, fileName, saveBookmark, saveImage, savedMessage, sendToApp } from "./shared.js";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "save-image", title: "Stockroom に保存", contexts: ["image"] });
    chrome.contextMenus.create({
      id: "list-images",
      title: "このページの画像を一覧して保存…",
      contexts: ["page", "image", "link", "selection"],
    });
    chrome.contextMenus.create({ id: "bookmark", title: "このページをブックマークに保存", contexts: ["page"] });
    chrome.contextMenus.create({
      id: "capture",
      title: "スクリーンショット（見えている範囲）を Stockroom に保存",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "capture-full",
      title: "スクリーンショット（ページ全体）を Stockroom に保存",
      contexts: ["page"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === "save-image" && info.srcUrl) {
    saveWithFeedback(tab, () =>
      saveImage(info.srcUrl, { tabId: tab.id, frameId: info.frameId, pageUrl: tab.url, title: tab.title }),
    );
  } else if (info.menuItemId === "list-images") {
    openImageList(tab);
  } else if (info.menuItemId === "capture") {
    saveWithFeedback(tab, () => capture(tab));
  } else if (info.menuItemId === "capture-full") {
    saveWithFeedback(tab, () => captureFull(tab));
  } else if (info.menuItemId === "bookmark") {
    saveWithFeedback(tab, () => saveBookmark(tab), bookmarkMessage);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tab = sender.tab;
  if (msg?.type === "save-image" && tab && msg.url) {
    // Alt+right-click on an image (content.js).
    saveWithFeedback(tab, () =>
      saveImage(msg.url, { tabId: tab.id, frameId: sender.frameId, pageUrl: tab.url, title: tab.title }),
    );
  } else if (msg?.type === "capture" && msg.tab) {
    // From the popup, which closes as soon as the screenshot is taken.
    saveWithFeedback(msg.tab, () => capture(msg.tab));
  } else if (msg?.type === "capture-full" && msg.tab) {
    saveWithFeedback(msg.tab, () => captureFull(msg.tab));
  } else if (msg?.type === "bookmark" && msg.tab) {
    saveWithFeedback(msg.tab, () => saveBookmark(msg.tab), bookmarkMessage);
  } else if (msg?.type === "list-images" && msg.tab) {
    openImageList(msg.tab);
  }
  reply();
});

/** The visible part of the tab as PNG, named after the page. */
async function capture(tab) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const blob = await (await fetch(dataUrl)).blob();
  return sendToApp(blob, fileName("", "image/png", tab.title || "スクリーンショット"), tab.url);
}

// Browsers cannot draw a bitmap taller than this.
const MAX_FULL_HEIGHT = 16000;

/** The whole page, including the part below the fold, as one PNG (via the DevTools protocol). */
async function captureFull(tab) {
  const target = { tabId: tab.id };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (e) {
    throw new Error(`ページ全体を撮影できませんでした（開発者ツールが開かれている可能性があります）：${e.message}`);
  }
  const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
  // The tallest thing on the page: the document, or an inner scroll area when the page itself is
  // only as tall as the window (sites with a fixed header and a scrolling main area).
  const measure = async () => {
    const { result } = await send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        let h = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
        for (const el of document.querySelectorAll("body *")) {
          if (el.scrollHeight <= el.clientHeight + 1) continue;
          const o = getComputedStyle(el).overflowY;
          if (o === "auto" || o === "scroll" || o === "overlay") {
            h = Math.max(h, el.getBoundingClientRect().top + window.scrollY + el.scrollHeight);
          }
        }
        return { height: Math.ceil(h), width: window.innerWidth };
      })()`,
    });
    return result.value;
  };
  try {
    const { height: first, width } = await measure();
    // Make the window as tall as the page, so "100vh" areas grow and fixed bars appear only once.
    let height = Math.min(first, MAX_FULL_HEIGHT);
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 0, mobile: false });
    // The taller window can change the layout (and the height); measure once more.
    const again = Math.min((await measure()).height, MAX_FULL_HEIGHT);
    if (again !== height) {
      height = again;
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 0, mobile: false });
    }
    await new Promise((r) => setTimeout(r, 300)); // let lazy images and layout settle
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
    return await sendToApp(blob, fileName("", "image/png", tab.title || "スクリーンショット"), tab.url);
  } finally {
    await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await chrome.debugger.detach(target).catch(() => {});
  }
}

function openImageList(tab) {
  chrome.tabs.create({ url: `collect.html?tab=${tab.id}`, index: tab.index + 1, openerTabId: tab.id });
}

/** Runs a save, telling the user how it went in the page and on the toolbar icon. */
async function saveWithFeedback(tab, save, message = savedMessage) {
  const slow = setTimeout(() => toast(tab.id, "Stockroom に保存中…", "busy"), 600);
  try {
    const res = await save();
    clearTimeout(slow);
    toast(tab.id, message(res), "ok");
    badge(tab.id, "✓", "#2e9d5b");
  } catch (e) {
    clearTimeout(slow);
    toast(tab.id, e.message || String(e), "error");
    badge(tab.id, "!", "#d64545", e.message);
  }
}

function badge(tabId, text, color, title) {
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  chrome.action.setBadgeText({ tabId, text });
  if (title) chrome.action.setTitle({ tabId, title: `Stockroom に保存\n${title}` });
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: "" });
    chrome.action.setTitle({ tabId, title: "Stockroom に保存" });
  }, 4000);
}

/** A small notice in the corner of the page (not possible on browser pages; the badge still shows). */
function toast(tabId, message, kind) {
  chrome.scripting
    .executeScript({
      target: { tabId },
      args: [message, kind],
      func: (message, kind) => {
        const id = "__stockroom_toast__";
        document.getElementById(id)?.remove();
        clearTimeout(window[id]);
        const el = document.createElement("div");
        el.id = id;
        el.textContent = message;
        el.setAttribute("role", "status");
        Object.assign(el.style, {
          position: "fixed",
          zIndex: "2147483647",
          right: "16px",
          bottom: "16px",
          maxWidth: "380px",
          padding: "10px 14px",
          borderRadius: "8px",
          font: "13px/1.5 system-ui, -apple-system, 'Hiragino Sans', 'Yu Gothic UI', sans-serif",
          color: "#fff",
          background: kind === "error" ? "rgba(190, 45, 45, 0.96)" : "rgba(28, 29, 32, 0.94)",
          boxShadow: "0 6px 20px rgba(0, 0, 0, 0.3)",
          pointerEvents: "none",
          transition: "opacity 0.25s",
        });
        document.documentElement.append(el);
        if (kind !== "busy") {
          window[id] = setTimeout(() => {
            el.style.opacity = "0";
            setTimeout(() => el.remove(), 250);
          }, kind === "error" ? 6000 : 2200);
        }
      },
    })
    .catch(() => {});
}

import { bindDestination, call, openConnectPage } from "./shared.js";

const $ = (id) => document.getElementById(id);

if (navigator.userAgent.includes("Mac")) $("alt-key").textContent = "Option";

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const scriptable = /^(https?|file):/.test(tab?.url ?? "");
$("list").disabled = !scriptable;
$("capture").disabled = !tab || /^(chrome|edge|about|chrome-extension):/.test(tab.url ?? "");

$("list").onclick = () => {
  chrome.runtime.sendMessage({ type: "list-images", tab });
  window.close();
};
$("bookmark").disabled = !/^https?:/.test(tab?.url ?? "");
$("bookmark").onclick = () => {
  chrome.runtime.sendMessage({ type: "bookmark", tab });
  window.close();
};
$("capture").onclick = () => {
  // The background worker saves it and reports in the page; the popup can close.
  chrome.runtime.sendMessage({ type: "capture", tab });
  window.close();
};

async function connect() {
  const status = $("status");
  status.className = "status";
  status.textContent = "接続を確認しています…";
  try {
    const info = await call("/info");
    if (!info.library) throw new Error("アプリでライブラリが開かれていません");
    status.className = "status ok";
    status.textContent = `接続中：${info.library}`;
    await bindDestination({
      folderSelect: $("folder"),
      tagBox: $("tags"),
      tagInput: $("tag-input"),
      tagList: $("tag-list"),
    });
    $("dest").hidden = false;
  } catch (e) {
    status.className = "status error";
    // Not connected yet: the button below says what to do.
    status.textContent = e.status === 401 ? "アプリとまだ接続されていません" : e.message;
    $("dest").hidden = true;
    $("connect").hidden = e.status !== 401;
  }
}

$("connect").onclick = () => {
  openConnectPage();
  window.close();
};

connect();

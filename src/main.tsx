import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { setUpAppearance } from "./lib/appearance";
import { logUncaughtErrors } from "./lib/log";
import { setUpTitleBar } from "./lib/titleBar";

async function main() {
  logUncaughtErrors();
  setUpAppearance();
  setUpTitleBar();
  // Opened in a plain browser during development: use the in-memory mock backend.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    (await import("./dev/mockBackend")).installMockBackend();
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

main();

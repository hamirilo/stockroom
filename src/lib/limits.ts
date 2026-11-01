// A build with fewer features (docs/LIMITS.md), set when it is built by
// environment variables. The Rust side reads the same ones
// (src-tauri/src/limits.rs); vite.config.ts lets the STOCKROOM_ ones through.
// Unset, the build has everything.
import { KINDS, type ItemKind } from "./api";

const env = import.meta.env;
/** Set and not empty or "0". */
const on = (v: string | undefined) => !!v && v !== "0";

const listed = (env.STOCKROOM_KINDS ?? "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

/** Kinds this build handles (`STOCKROOM_KINDS`); null = every kind. */
export const LIMITED_KINDS: readonly ItemKind[] | null = listed.length
  ? KINDS.map((k) => k.kind).filter((k) => listed.includes(k))
  : null;

/** Whether this build handles `kind`. */
export const buildHas = (kind: ItemKind) => !LIMITED_KINDS || LIMITED_KINDS.includes(kind);

/** No browser extension and no Claude connection (`STOCKROOM_NO_CONNECT`). */
export const NO_CONNECT = on(env.STOCKROOM_NO_CONNECT);

/** No in-app updates (`STOCKROOM_NO_UPDATE`). */
export const NO_UPDATE = on(env.STOCKROOM_NO_UPDATE);

/** The app's name in the settings' version row (`STOCKROOM_NAME`). */
export const BUILD_NAME = env.STOCKROOM_NAME?.trim() || "Stockroom";

/**
 * Commands this build leaves out of the command table (src/lib/commands.ts),
 * so out of the menus, keys and the shortcut list too.
 */
export const OFF_COMMANDS: ReadonlySet<string> = new Set([
  ...(NO_UPDATE ? ["app.checkUpdate", "help.releaseNotes"] : []),
  ...(NO_CONNECT ? ["help.webImport", "help.claude"] : []),
  ...(buildHas("text") ? [] : ["text.new"]),
]);

/** Settings pages this build leaves out (src/components/SettingsDialog.tsx). */
export const OFF_SETTINGS: ReadonlySet<string> = new Set([
  ...(NO_CONNECT ? ["extension", "claude"] : []),
  // With one kind there is nothing to pick.
  ...(LIMITED_KINDS?.length === 1 ? ["libraryKinds"] : []),
]);

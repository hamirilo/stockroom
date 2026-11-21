// Right-click menu rows made from the command table (commands.ts), so a
// menu shows the same name and key as the menu bar and the shortcut list.
import { createElement } from "react";
import type { IconButton, MenuItem } from "../components/ContextMenu";
import { appliesTo, command, isEnabled, labelOf } from "./commands";
import { comboText } from "./shortcuts";
import { useStore } from "../store";

const st = () => useStore.getState();

/** A menu row for a command: its label now, its first key, greyed out when it can't run. */
export function commandItem(
  id: string,
  over: Partial<{ label: string; onClick: () => void; danger: boolean; check: boolean }> = {},
): MenuItem {
  const c = command(id);
  const s = st();
  const key = c.keys?.[0];
  return {
    label: over.label ?? labelOf(c, s),
    hint: key ? comboText(key) : undefined,
    disabled: !over.onClick && !isEnabled(c, s),
    danger: over.danger,
    // A ✓ before the label when its state is on (the rating it has now).
    checked: over.check ? !!c.checked?.(s) : undefined,
    onClick: over.onClick ?? (() => c.run(st())),
  };
}

/** Commands that apply to the list and selection (the rest are left out, not greyed). */
export const applicable = (ids: string[]) => ids.filter((id) => appliesTo(command(id), st()));

/** An icon button for a command, named under the icon; `active` when its state is on (a favourite already). */
export function commandIcon(id: string): IconButton {
  const c = command(id);
  const s = st();
  const key = c.keys?.[0];
  return {
    icon: c.icon ? createElement(c.icon, { size: 15, fill: c.checked?.(s) && c.id !== "item.tray" ? "currentColor" : "none" }) : null,
    label: c.short ?? c.title,
    title: `${labelOf(c, s)}${key ? `（${comboText(key)}）` : ""}`,
    active: c.checked?.(s),
    onClick: () => c.run(st()),
  };
}

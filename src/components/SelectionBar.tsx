import { Download, FolderInput, MoreHorizontal, Trash2, X } from "lucide-react";
import { RotateLeft, RotateRight } from "../lib/icons";
import { deleteSelection, exportSelection, orient } from "../lib/actions";
import { appliesTo, command, isEnabled } from "../lib/commands";
import { comboText } from "../lib/shortcuts";
import { isSystemId } from "../lib/api";
import { useStore } from "../store";
import { showItemMenu } from "./Grid";

/**
 * Operations on a selection of two or more, a bar floating at the bottom of the list (docs/MENUS.md §7).
 * Left to right: what is selected, the everyday operations (favorite, tray, rotate,
 * move, export), "…" for the full right-click menu, and — apart behind a divider, in
 * red with its name — the trash, so it isn't hit by mistake while reaching for the rest.
 */
export function SelectionBar() {
  const count = useStore((s) => s.selected.size);
  const total = useStore((s) => s.rawItems.length);
  const isTrash = useStore((s) => s.view.kind === "trash");
  const state = useStore();
  // One item is just "what I'm looking at" — its operations are in the details panel and
  // the right-click menu. The bar is for acting on several at once.
  if (count < 2 || isTrash) return null;
  const ids = [...state.selected];
  const rotatable = appliesTo(command("item.rotateCw"), state);
  // Installed fonts are only looked at (docs/SYSTEM_FONTS.md).
  const system = ids.some(isSystemId);
  const readOnly = system ? "（この端末のフォントは読み取り専用です）" : "";

  const cmd = (id: string) => {
    const c = command(id);
    const Icon = c.icon;
    const key = c.keys?.[0];
    const on = c.checked?.(state);
    return (
      <Btn
        key={id}
        title={`${c.label ? c.label(state) : c.title}${key ? `（${comboText(key)}）` : ""}`}
        onClick={() => c.run(useStore.getState())}
        disabled={!isEnabled(c, state)}
        active={on}
      >
        {Icon && <Icon size={15} fill={on && id !== "item.tray" ? "currentColor" : "none"} />}
      </Btn>
    );
  };
  const more = (e: React.MouseEvent) => {
    const index = state.items.findIndex((i) => i.id === ids[0] || i.familyIds?.includes(ids[0]));
    if (index < 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    showItemMenu({ clientX: r.left, clientY: r.top - 4 }, state.items[index], index);
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-full animate-fade-in items-center gap-0.5 rounded-xl border border-line bg-raised px-2 py-1.5 text-[13px] shadow-xl shadow-black/40">
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-accent/20 py-0.5 pr-0.5 pl-2.5 text-xs text-accent tabular-nums">
          {count} 件を選択中
          <span className="text-accent/60">/ {total}</span>
          <button
            title="選択を解除（Esc）"
            onClick={() => state.setSelection([])}
            className="rounded-full p-0.5 hover:bg-accent/25"
          >
            <X size={12} />
          </button>
        </span>
        <Sep />
        {cmd("item.favorite")}
        {cmd("item.tray")}
        {rotatable && (
          <>
            <Btn title={`左に回転（${comboText("Mod+Shift+L")}）`} onClick={() => orient(ids, "rotateCcw")}>
              <RotateLeft size={15} />
            </Btn>
            <Btn title={`右に回転（${comboText("Mod+Shift+R")}）`} onClick={() => orient(ids, "rotateCw")}>
              <RotateRight size={15} />
            </Btn>
          </>
        )}
        <Sep />
        <Btn
          title={`フォルダへ移動…（${comboText("Mod+Shift+J")}）${readOnly}`}
          onClick={() => state.setPicker("move")}
          label="移動"
          disabled={system}
        >
          <FolderInput size={15} />
        </Btn>
        <Btn
          title={`書き出し…（${comboText("Mod+E")}）${readOnly}`}
          onClick={() => exportSelection(ids)}
          label="書き出し"
          disabled={system}
        >
          <Download size={15} />
        </Btn>
        <Btn title="そのほかの操作（右クリックと同じ）" onClick={more}>
          <MoreHorizontal size={15} />
        </Btn>
        <div className="mx-2 h-5 w-px shrink-0 bg-danger/40" />
        <Btn
          title={`ゴミ箱へ移動（${comboText("Mod+Backspace")}）${readOnly}`}
          onClick={() => deleteSelection(ids)}
          label="ゴミ箱へ"
          danger
          disabled={system}
        >
          <Trash2 size={15} />
        </Btn>
      </div>
    </div>
  );
}

const Sep = () => <div className="mx-1.5 h-5 w-px shrink-0 bg-line" />;

function Btn({
  title,
  onClick,
  label,
  active,
  danger,
  disabled,
  children,
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  label?: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 whitespace-nowrap disabled:opacity-40 ${
        danger ? "text-danger enabled:hover:bg-danger/15" : active ? "text-accent enabled:hover:bg-white/10" : "text-fg/80 enabled:hover:bg-white/10"
      }`}
    >
      {children}
      {label && <span className="@max-lg:hidden max-sm:hidden">{label}</span>}
    </button>
  );
}

// The details panel's "紐づけ" section body (docs/LINKS.md; the heading is the
// Inspector's collapsible section): the item's parent or
// children, and the link / unlink buttons. With links off it stays, greyed,
// and says where to turn them on (docs/UI.md: don't move the controls around).
import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowUpFromLine, Link2, Link2Off, Star } from "lucide-react";
import { useMemo } from "react";
import { linkedIn, makeParent, toggleAdopted, unlinkItems } from "../lib/actions";
import type { Item } from "../lib/api";
import { useStore } from "../store";

const btn =
  "flex h-7 items-center gap-1.5 rounded-md border border-frame px-2 text-xs hover:bg-hover disabled:pointer-events-none disabled:off";

function Thumb({ item }: { item: Item }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded bg-raised">
      <img src={convertFileSrc(item.thumbPath)} alt="" draggable={false} className="size-full object-contain" />
    </span>
  );
}

/** Selects a child, opening its parent's row first so the child is in the list. */
function showItem(item: Item, parentId: string | null) {
  const s = useStore.getState();
  if (parentId && !s.openParents.has(parentId)) s.toggleParent(parentId);
  s.setSelection([item.id]);
}

export function LinksField({ ids, single }: { ids: string[]; single: Item | undefined }) {
  const on = useStore((s) => s.librarySettings.links);
  const rawItems = useStore((s) => s.rawItems);
  const parent = useMemo(
    () => (single?.parentId ? rawItems.find((i) => i.id === single.parentId) : undefined),
    [rawItems, single],
  );
  const children = useMemo(
    () => (single ? rawItems.filter((i) => i.parentId === single.id) : []),
    [rawItems, single],
  );
  const unlinkable = on ? linkedIn(ids).length : 0;

  return (
    <div>
      {!on && (
        <p className="mb-2 text-xs text-dim">
          親子関係は無効です。
          <button className="text-accent hover:underline" onClick={() => useStore.getState().openSettings("libraryLinks")}>
            設定（親子の紐づけ）
          </button>
          で有効にできます。
        </p>
      )}
      {single?.parentId && (
        <div className="mb-2">
          <div className="mb-1 text-[11px] text-dim">親</div>
          {parent ? (
            <button
              className="flex w-full items-center gap-2 rounded-md bg-raised p-1 text-left hover:bg-white/10"
              onClick={() => useStore.getState().setSelection([parent.id])}
            >
              <Thumb item={parent} />
              <span className="min-w-0 flex-1 truncate text-xs">{parent.name}</span>
            </button>
          ) : (
            <span className="text-xs text-dim">この一覧にありません（ゴミ箱の中など）</span>
          )}
        </div>
      )}
      {children.length > 0 && single && (
        <div className="mb-2">
          <div className="mb-1 text-[11px] text-dim">紐づけた項目（{children.length} 件）</div>
          <div className="flex flex-col gap-1">
            {children.map((c) => (
              <button
                key={c.id}
                className="flex items-center gap-2 rounded-md bg-raised p-1 text-left hover:bg-white/10"
                onClick={() => showItem(c, single.id)}
              >
                <Thumb item={c} />
                <span className="min-w-0 flex-1 truncate text-xs">{c.name}</span>
                {c.adopted && <Star size={12} fill="currentColor" className="shrink-0 text-amber-400" aria-label="採用" />}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <button
          className={btn}
          disabled={!on}
          title={on ? undefined : "設定で親子関係を有効にしてください"}
          onClick={() => useStore.getState().setPicker("parent")}
        >
          <Link2 size={13} /> 親に紐づける…
        </button>
        <button
          className={btn}
          disabled={!on || unlinkable === 0}
          title={on ? undefined : "設定で親子関係を有効にしてください"}
          onClick={() => void unlinkItems(ids)}
        >
          <Link2Off size={13} /> 紐づけを外す
        </button>
        {/* A child and its parent change places (the other children go under it too). */}
        <button
          className={btn}
          disabled={!on || !single?.parentId}
          title={
            !on
              ? "設定で親子関係を有効にしてください"
              : single?.parentId
                ? "これを親にして、いまの親とほかの子をこの下に付け替える"
                : "紐づけた項目（子）を 1 件選んでください"
          }
          onClick={() => single && void makeParent(single.id)}
        >
          <ArrowUpFromLine size={13} /> 親にする
        </button>
        {/* One of the children is picked: the idea that is going ahead (a thumbnail, say). */}
        <button
          className={btn}
          disabled={!on || !single?.parentId}
          title={
            !on ? "設定で親子関係を有効にしてください" : single?.parentId ? "紐づけた項目のうち、これに決めたものの印" : "紐づけた項目（子）を 1 件選んでください"
          }
          onClick={() => single && void toggleAdopted(single.id)}
        >
          <Star size={13} fill={single?.adopted ? "currentColor" : "none"} /> {single?.adopted ? "採用を外す" : "採用にする"}
        </button>
      </div>
    </div>
  );
}

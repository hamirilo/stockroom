import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "lucide-react";
import { urlLabel, type Item } from "../../lib/api";
import { useStore } from "../../store";

/**
 * The viewer's body for bookmarks (docs/BOOKMARKS.md): the page's picture, its
 * title and address, and what it said about itself (the item's memo). The app
 * never loads the page; "ブラウザで開く" hands the address to the browser.
 */
export function BookmarkView({ item }: { item: Item }) {
  const url = item.sourceUrl;
  const open = () => url && openUrl(url).catch((e) => useStore.getState().toast(String(e), true));
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 p-10">
      <img
        src={convertFileSrc(item.thumbPath)}
        alt={item.name}
        draggable={false}
        className="min-h-0 max-w-full rounded-md object-contain shadow-2xl"
      />
      <div className="flex max-w-xl flex-col items-center gap-1 text-center">
        <div className="text-base font-semibold text-white/90">{item.name}</div>
        {url && (
          <button className="max-w-full truncate text-sm text-white/55 hover:text-white/80 hover:underline" title={url} onClick={open}>
            {urlLabel(url)}
          </button>
        )}
        {item.note && <p className="mt-1 line-clamp-3 text-sm text-white/60">{item.note}</p>}
      </div>
      {url && (
        <button
          className="flex items-center gap-1.5 rounded-md bg-white/10 px-4 py-1.5 text-sm text-white hover:bg-white/20"
          onClick={open}
        >
          <ExternalLink size={14} />
          ブラウザで開く
        </button>
      )}
    </div>
  );
}

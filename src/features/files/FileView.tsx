import { convertFileSrc } from "@tauri-apps/api/core";
import { ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { openSelection } from "../../lib/actions";
import type { Item } from "../../lib/api";
import { filesApi, previewSrc, type FilePreview } from "./api";

/**
 * The viewer's body for files. PDF opens in the web view's own PDF viewer;
 * other documents show their full preview (src-tauri/src/files/preview.rs:
 * Quick Look on macOS, a PDF made by Office on Windows) once it is ready,
 * else their thumbnail. Editing is left to the default app. A PDF, too,
 * comes from `file_preview`, which checks that it really is one.
 */
export function FileView({ item }: { item: Item }) {
  const pdf = item.ext.toLowerCase() === "pdf";
  // Kept with its item, so the previous item's PDF never shows for this one.
  const [got, setGot] = useState<{ id: string; preview: FilePreview | null }>();
  // undefined = being made.
  const preview = got?.id === item.id ? got.preview : undefined;

  useEffect(() => {
    let live = true;
    const id = item.id;
    filesApi.preview(id).then(
      (p) => live && setGot({ id, preview: p }),
      () => live && setGot({ id, preview: null }),
    );
    return () => {
      live = false;
    };
  }, [item.id]);

  // The check is instant: no thumbnail flashing up before the PDF.
  if (pdf && preview === undefined) return null;
  if (preview?.kind === "pdf") {
    return (
      <iframe
        key={item.id}
        src={previewSrc(preview)}
        title={item.name}
        className="absolute inset-0 h-full w-full border-0 bg-white"
      />
    );
  }
  if (preview?.kind === "html") {
    return (
      // Quick Look's page (its own script switches spreadsheet tabs); no
      // access to the app.
      <iframe
        key={item.id}
        src={previewSrc(preview)}
        title={item.name}
        sandbox="allow-scripts"
        className="absolute inset-0 h-full w-full border-0 bg-white"
      />
    );
  }
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 p-10">
      <img
        key={item.id}
        src={convertFileSrc(item.thumbPath)}
        alt={item.name}
        draggable={false}
        className="min-h-0 max-w-full animate-zoom-in rounded-md object-contain shadow-2xl"
      />
      <div className="flex shrink-0 items-center gap-4">
        {preview === undefined && !pdf && (
          <span className="flex items-center gap-2 text-sm text-white/60">
            <Loader2 size={15} className="animate-spin" />
            プレビューを作成中…
          </span>
        )}
        <button
          onClick={() => openSelection([item.id])}
          className="flex items-center gap-2 rounded-md bg-accent-fill px-4 py-2 text-sm font-medium text-white hover:brightness-110"
        >
          <ExternalLink size={15} />
          既定のアプリで開く
        </button>
      </div>
    </div>
  );
}

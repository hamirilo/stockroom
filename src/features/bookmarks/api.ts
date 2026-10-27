// Bookmark-only commands (src-tauri/src/bookmarks/commands.rs). docs/BOOKMARKS.md
import { invoke } from "@tauri-apps/api/core";

export interface BookmarkAdded {
  id: string;
  /** The address was already kept: it isn't added again. */
  duplicate: boolean;
}

export const bookmarksApi = {
  /** Keeps `url` (http / https) as a bookmark titled with its host; nothing is fetched. */
  create: (url: string, folderId: string | null) => invoke<BookmarkAdded>("create_bookmark", { url, folderId }),
};

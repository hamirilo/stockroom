//! Bookmark commands (the frontend's lib/api.ts `createBookmark`). docs/BOOKMARKS.md

use super::{Added, Input};
use crate::commands::{AppState, CmdResult};
use tauri::{AppHandle, Manager};

/// Keeps `url` as a bookmark, in `folder_id` if given. Nothing is fetched: it is
/// titled with its host until the browser extension saves the page itself.
#[tauri::command]
pub async fn create_bookmark(app: AppHandle, url: String, folder_id: Option<String>) -> CmdResult<Added> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        super::add(&state.lib, &Input { url, ..Input::default() }, folder_id.as_deref(), &[])
    })
    .await
    .map_err(|e| e.to_string())?
}

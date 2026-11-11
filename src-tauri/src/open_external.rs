//! Opening items in other apps (docs/OPEN_EXTERNAL.md). Two ways in, by
//! purpose:
//!
//! - to look at (the default app, or one the user picks): the stored file
//!   itself, made read-only first (`library::protect`), so the app can't
//!   save over it
//! - to edit: a copy written to the edit folder (書類/Stockroom unless set
//!   otherwise) under the item's name, opened in the default app. The copy is
//!   the user's from then on; the library doesn't track or remove it
//!
//! Bookmarks open their page in the browser (the frontend does that) and are
//! skipped here except by `open_items`, which gets the ones with no page.

use crate::commands::{err, get_app_settings, item_paths, AppState, CmdResult};
use crate::db::Kind;
use crate::library;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

/// The edit folder's name inside the user's documents.
const EDIT_FOLDER: &str = "Stockroom";

/// Read-only before it goes out. Not being able to (a file system without
/// the flag) doesn't stop the user from opening it.
fn protect(path: &Path) {
    if let Err(e) = library::protect(path) {
        log::warn!("read-only {}: {e}", path.display());
    }
}

/// Opens items in the OS default app, read-only.
#[tauri::command]
pub fn open_items(state: State<AppState>, ids: Vec<String>) -> CmdResult<()> {
    for (_, path) in item_paths(&state, &ids)? {
        protect(&path);
        tauri_plugin_opener::open_path(path, None::<&str>).map_err(err)?;
    }
    Ok(())
}

/// Opens items, read-only, in an app the user picks: on macOS `app` is the
/// one picked in the frontend (`/Applications/….app`); on Windows the
/// system's "プログラムから開く" asks for each file, and `app` is unused.
/// Returns how many were opened (fewer when the user cancelled a dialog).
#[tauri::command]
pub async fn open_items_with(app: AppHandle, ids: Vec<String>, with: Option<String>) -> CmdResult<usize> {
    let paths: Vec<PathBuf> = item_paths(&app.state::<AppState>(), &ids)?
        .into_iter()
        .filter(|(it, _)| it.kind != Kind::Bookmark)
        .map(|(_, p)| p)
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        let mut opened = 0;
        for path in &paths {
            protect(path);
            #[cfg(windows)]
            {
                let _ = &with;
                if !win::open_with_dialog(path).map_err(err)? {
                    break;
                }
            }
            #[cfg(not(windows))]
            {
                let with = with.as_deref().ok_or("アプリが選ばれていません")?;
                tauri_plugin_opener::open_path(path, Some(with)).map_err(err)?;
            }
            opened += 1;
        }
        Ok(opened)
    })
    .await
    .map_err(err)?
}

/// Where copies for editing go: the folder set in 設定 › 一般, else
/// 書類/Stockroom. Not made here.
pub fn edit_folder(app: &AppHandle) -> CmdResult<PathBuf> {
    match get_app_settings(app.clone()).edit_folder {
        Some(dir) => Ok(dir),
        None => default_folder(app),
    }
}

fn default_folder(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().document_dir().map_err(err)?.join(EDIT_FOLDER))
}

/// The edit folder when none is set (書類/Stockroom), for the settings screen.
#[tauri::command]
pub fn default_edit_folder(app: AppHandle) -> CmdResult<String> {
    Ok(default_folder(&app)?.display().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditCopies {
    /// The edit folder they went into.
    pub folder: String,
    pub count: usize,
}

/// Writes copies of items into the edit folder (made if missing) and opens
/// each in its default app.
#[tauri::command]
pub async fn open_for_edit(app: AppHandle, ids: Vec<String>) -> CmdResult<EditCopies> {
    let items = item_paths(&app.state::<AppState>(), &ids)?;
    let dir = edit_folder(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let copies = write_copies(&dir, items.iter().map(|(it, p)| (it.kind, it.name.as_str(), it.ext.as_str(), p.as_path())))?;
        for copy in &copies {
            tauri_plugin_opener::open_path(copy, None::<&str>).map_err(err)?;
        }
        Ok(EditCopies { folder: dir.display().to_string(), count: copies.len() })
    })
    .await
    .map_err(err)?
}

/// The copies `open_for_edit` opens, named as the items are (`name (2).pdf`
/// when taken). Bookmarks have nothing to edit.
/// Items as (kind, name, ext, stored file).
fn write_copies<'a>(dir: &Path, items: impl Iterator<Item = (Kind, &'a str, &'a str, &'a Path)>) -> CmdResult<Vec<PathBuf>> {
    fs::create_dir_all(dir).map_err(err)?;
    items
        .filter(|(kind, ..)| *kind != Kind::Bookmark)
        .map(|(_, name, ext, src)| crate::export::copy_out(src, dir, name, ext).map_err(err))
        .collect()
}

/// The system's "プログラムから開く" on Windows.
#[cfg(windows)]
mod win {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_CANCELLED;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{SHOpenWithDialog, OAIF_EXEC, OAIF_HIDE_REGISTRATION, OPENASINFO};

    /// Lets the user pick an app and opens `path` in it. Without "always use
    /// this app": the default app stays as it is. False when cancelled.
    pub fn open_with_dialog(path: &Path) -> windows::core::Result<bool> {
        // A blocking-pool thread starts without COM; already set up is fine too.
        let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let info = OPENASINFO {
            pcszFile: PCWSTR(wide.as_ptr()),
            pcszClass: PCWSTR::null(),
            oaifInFlags: OAIF_EXEC | OAIF_HIDE_REGISTRATION,
        };
        match unsafe { SHOpenWithDialog(None, &info) } {
            Ok(()) => Ok(true),
            Err(e) if e.code() == ERROR_CANCELLED.to_hresult() => Ok(false),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_for_editing_are_writable_and_named_as_the_items() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("A.library");
        let pa = library::store_file(&root, "i1", "x.pdf", b"%PDF-a").unwrap();
        let pb = library::store_file(&root, "i2", "y.pdf", b"%PDF-b").unwrap();
        let pm = library::store_file(&root, "i3", "z.url", b"[InternetShortcut]").unwrap();
        // Opened read-only before: the copy isn't.
        library::protect(&pa).unwrap();

        let dir = tmp.path().join("書類").join(EDIT_FOLDER);
        let items = [
            (Kind::File, "見積書", "pdf", pa.as_path()),
            // Renamed with its extension: the same name.
            (Kind::File, "見積書.pdf", "pdf", pb.as_path()),
            (Kind::Bookmark, "記事", "url", pm.as_path()),
        ];
        let copies = write_copies(&dir, items.into_iter()).unwrap();

        let names: Vec<_> = copies.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["見積書.pdf", "見積書 (2).pdf"], "no bookmark; a taken name gets a number");
        assert_eq!(fs::read(&copies[0]).unwrap(), b"%PDF-a");
        assert!(!fs::metadata(&copies[0]).unwrap().permissions().readonly());
        assert!(fs::metadata(&pa).unwrap().permissions().readonly(), "the stored file stays read-only");

        // Again: next to the earlier copies, never over them.
        let again = write_copies(&dir, [(Kind::File, "見積書", "pdf", pa.as_path())].into_iter()).unwrap();
        assert_eq!(again[0].file_name().unwrap(), "見積書 (3).pdf");
    }
}

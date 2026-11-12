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

/// An app that can open the items, for the list under "アプリで開く".
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppChoice {
    /// What `open_items_with` takes (`/Applications/Preview.app`).
    pub path: String,
    /// As Finder shows it ("プレビュー").
    pub name: String,
    /// The default app for all of them.
    pub default: bool,
}

/// The apps that can open every one of the items, as Finder's "このアプリケーションで
/// 開く" lists them: the default app first, the rest by name. Empty where the
/// OS can't say (Windows, whose own "プログラムから開く" lists them instead).
#[tauri::command]
pub async fn apps_for_items(app: AppHandle, ids: Vec<String>) -> CmdResult<Vec<AppChoice>> {
    let items = item_paths(&app.state::<AppState>(), &ids)?;
    tauri::async_runtime::spawn_blocking(move || {
        // The apps go by file type: one file of each extension is enough.
        let mut seen = std::collections::HashSet::new();
        let files: Vec<PathBuf> = items
            .into_iter()
            .filter(|(it, _)| it.kind != Kind::Bookmark && seen.insert(it.ext.to_lowercase()))
            .map(|(_, p)| p)
            .collect();
        #[cfg(target_os = "macos")]
        let found: Vec<_> = files.iter().map(|f| mac::apps_for(f)).collect();
        #[cfg(not(target_os = "macos"))]
        let found: Vec<(Vec<PathBuf>, Option<PathBuf>)> = files.iter().map(|_| (vec![], None)).collect();
        Ok(choices(&found, app_name))
    })
    .await
    .map_err(err)?
}

/// The app's name as Finder shows it.
fn app_name(path: &Path) -> String {
    #[cfg(target_os = "macos")]
    return mac::display_name(path);
    #[cfg(not(target_os = "macos"))]
    path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// `apps_for_items` from each file type's (apps, default app): the apps all
/// of them have, the default one only when it is the same for all.
fn choices(found: &[(Vec<PathBuf>, Option<PathBuf>)], name: impl Fn(&Path) -> String) -> Vec<AppChoice> {
    let Some(((first, _), rest)) = found.split_first() else { return vec![] };
    let mut apps: Vec<&PathBuf> = Vec::new();
    for a in first {
        if !apps.contains(&a) && rest.iter().all(|(others, _)| others.contains(a)) {
            apps.push(a);
        }
    }
    let default = found[0].1.as_ref().filter(|d| found.iter().all(|(_, x)| x.as_ref() == Some(*d)));
    let mut out: Vec<AppChoice> = apps
        .into_iter()
        .map(|a| AppChoice { path: a.display().to_string(), name: name(a), default: Some(a) == default })
        .collect();
    out.sort_by(|a, b| b.default.cmp(&a.default).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
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

/// Asking macOS which apps open a file (Launch Services, through NSWorkspace).
#[cfg(target_os = "macos")]
mod mac {
    use objc2::runtime::NSObjectProtocol;
    use objc2::sel;
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    use std::path::{Path, PathBuf};

    fn path_of(url: &NSURL) -> Option<PathBuf> {
        url.path().map(|p| PathBuf::from(p.to_string()))
    }

    /// The apps that can open `file` (as Finder lists them) and its default app.
    pub fn apps_for(file: &Path) -> (Vec<PathBuf>, Option<PathBuf>) {
        let ws = NSWorkspace::sharedWorkspace();
        let url = NSURL::fileURLWithPath(&NSString::from_str(&file.to_string_lossy()));
        let default = ws.URLForApplicationToOpenURL(&url).and_then(|u| path_of(&u));
        // macOS 12 and later; before that, only the default app is known.
        if !ws.respondsToSelector(sel!(URLsForApplicationsToOpenURL:)) {
            return (default.iter().cloned().collect(), default);
        }
        let apps = ws.URLsForApplicationsToOpenURL(&url).iter().filter_map(|u| path_of(&u)).collect();
        (apps, default)
    }

    /// "プレビュー" for `/System/Applications/Preview.app`, in the user's language.
    pub fn display_name(app: &Path) -> String {
        let name = NSFileManager::defaultManager().displayNameAtPath(&NSString::from_str(&app.to_string_lossy())).to_string();
        name.strip_suffix(".app").map(str::to_owned).unwrap_or(name)
    }
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
    fn apps_that_open_every_type() {
        let p = |s: &str| PathBuf::from(format!("/Applications/{s}.app"));
        let name = |a: &Path| a.file_stem().unwrap().to_string_lossy().into_owned();
        let pdf = (vec![p("Preview"), p("Acrobat"), p("PDF One"), p("Safari")], Some(p("PDF One")));
        let ai = (vec![p("Acrobat"), p("Illustrator"), p("Preview")], Some(p("Illustrator")));
        let names = |c: &[AppChoice]| c.iter().map(|a| (a.name.clone(), a.default)).collect::<Vec<_>>();

        // One type: its default first, the rest by name.
        let one = choices(std::slice::from_ref(&pdf), name);
        assert_eq!(
            names(&one),
            [("PDF One".into(), true), ("Acrobat".into(), false), ("Preview".into(), false), ("Safari".into(), false)]
        );
        assert_eq!(one[0].path, "/Applications/PDF One.app");
        // Two types: only the apps both have; their defaults differ, so none is marked.
        assert_eq!(names(&choices(&[pdf, ai], name)), [("Acrobat".into(), false), ("Preview".into(), false)]);
        assert!(choices(&[], name).is_empty());
    }

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

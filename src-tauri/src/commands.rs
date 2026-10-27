//! Commands invoked from the frontend. All return `Result<_, String>` so
//! errors surface as rejected promises in JS. Font-only commands are in
//! fonts/commands.rs.

use crate::changes;
use crate::db::{self, Counts, Folder, Item, ItemQuery, SelectionInfo, Tag};
use crate::import::{self, ImportSummary, Source};
use crate::library::{Holder, Library};
use crate::mcp;
use crate::share;
use crate::webimport;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub type CmdResult<T> = Result<T, String>;

#[derive(Default)]
pub struct AppState {
    pub lib: Mutex<Option<Library>>,
    /// Saving from the browser extension (webimport.rs).
    pub web: Mutex<WebServer>,
    /// Organizing from Claude (mcp/).
    pub mcp: Mutex<McpServer>,
    /// Folders shared on the local network (share.rs).
    pub share: Mutex<ShareServer>,
    /// Extensions waiting for the user to allow them to connect: id -> answer.
    pairing: Mutex<std::collections::HashMap<String, std::sync::mpsc::Sender<bool>>>,
}

#[derive(Default)]
pub struct WebServer {
    server: Option<webimport::Server>,
    /// Why the server couldn't start.
    error: Option<String>,
}

#[derive(Default)]
pub struct McpServer {
    server: Option<mcp::Server>,
    /// Why the server couldn't start.
    error: Option<String>,
}

#[derive(Default)]
pub struct ShareServer {
    server: Option<share::Server>,
    /// Why the server couldn't start.
    error: Option<String>,
}

pub(crate) fn err(e: impl ToString) -> String {
    e.to_string()
}

pub(crate) fn with_lib<T>(state: &AppState, f: impl FnOnce(&mut Library) -> CmdResult<T>) -> CmdResult<T> {
    let mut guard = state.lib.lock().unwrap();
    let lib = guard.as_mut().ok_or("ライブラリが開かれていません")?;
    f(lib)
}

// ------------------------------------------------------------- settings

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    /// This PC's id in library.lock (made once; see `this_app`).
    machine_id: String,
    last_library: Option<PathBuf>,
    /// Libraries opened or created before (the library switcher's list).
    libraries: Vec<KnownLibrary>,
    web_import: ServerSettings,
    mcp: ServerSettings,
    #[serde(flatten)]
    app: AppSettings,
}

/// The settings screen's "一般" tab (docs/SETTINGS.md).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    /// What opens at launch: the last library, or the list to choose from.
    startup: Startup,
    /// Look for a new version a few seconds after launch.
    auto_update: bool,
    /// Sidebar entries hidden per mode, for the libraries that follow the
    /// app's sidebar (library.db `sidebar` is not "own"). Read by the frontend.
    sidebar_hidden: std::collections::BTreeMap<String, Vec<String>>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self { startup: Startup::Last, auto_update: true, sidebar_hidden: Default::default() }
    }
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Startup {
    Last,
    Choose,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct KnownLibrary {
    path: PathBuf,
    favorite: bool,
    /// ms; 0 = never opened (e.g. only copied into).
    last_opened: i64,
}

/// Recent libraries kept besides the favourites.
const RECENT_LIBRARIES: usize = 20;

impl Settings {
    /// Adds the library to the list, or updates it; `opened` bumps it to the top.
    fn remember(&mut self, path: &std::path::Path, opened: bool) {
        let now = db::now_ms();
        match self.libraries.iter_mut().find(|l| l.path == path) {
            Some(l) if opened => l.last_opened = now,
            Some(_) => {}
            None => self.libraries.push(KnownLibrary {
                path: path.to_path_buf(),
                favorite: false,
                last_opened: if opened { now } else { 0 },
            }),
        }
        self.libraries.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
        let mut recent = 0;
        self.libraries.retain(|l| {
            recent += usize::from(!l.favorite);
            l.favorite || recent <= RECENT_LIBRARIES
        });
    }
}

/// One of the local servers (the browser extension's, Claude's).
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ServerSettings {
    enabled: bool,
    /// Shared secret the client sends with every request.
    token: String,
}

fn settings_path(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().app_config_dir().map_err(err)?.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    let Ok(path) = settings_path(app) else { return Settings::default() };
    let Ok(bytes) = fs::read(&path) else { return Settings::default() };
    serde_json::from_slice(&bytes).unwrap_or_else(|e| {
        // Unreadable (cut short by a crash before saves were atomic, or edited
        // by hand): kept aside rather than overwritten by the next save, so
        // the library list and connection keys can still be recovered.
        log::warn!("{}: 読み込めないため退避します: {e}", path.display());
        let _ = fs::rename(&path, path.with_extension(format!("json.bad-{}", db::now_ms())));
        Settings::default()
    })
}

/// Written to a temporary file and renamed over the old one, so a crash
/// mid-write never leaves half a file.
fn save_settings(app: &AppHandle, s: &Settings) -> CmdResult<()> {
    let path = settings_path(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(s).map_err(err)?).map_err(err)?;
    fs::rename(&tmp, &path).map_err(err)
}

/// Read, change and save the settings as one step. Commands run on several
/// threads, and two loading the same file then saving would lose one's change.
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

fn update_settings<R>(app: &AppHandle, f: impl FnOnce(&mut Settings) -> R) -> CmdResult<R> {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut settings = load_settings(app);
    let r = f(&mut settings);
    save_settings(app, &settings)?;
    Ok(r)
}

// -------------------------------------------------------------- library

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    root: String,
    name: String,
}

// ---------------------------------------------------------- library lock

/// This app as the holder of a library's lock (library.rs `Holder`).
pub(crate) fn this_app(app: &AppHandle) -> Holder {
    let mut machine = load_settings(app).machine_id;
    if machine.is_empty() {
        machine = update_settings(app, |s| {
            if s.machine_id.is_empty() {
                s.machine_id = uuid::Uuid::new_v4().simple().to_string();
            }
            s.machine_id.clone()
        })
        .unwrap_or_default();
    }
    Holder { machine, name: computer_name(), pid: std::process::id(), at: db::now_ms() }
}

/// The PC's name as the user knows it ("鈴木の MacBook Pro").
fn computer_name() -> String {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        #[cfg(target_os = "macos")]
        if let Ok(out) = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output() {
            let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if out.status.success() && !name.is_empty() {
                return name;
            }
        }
        std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "別のパソコン".into())
    })
    .clone()
}

/// The error opening a library open elsewhere: "LOCKED:" and the holder as
/// JSON, for the frontend to ask whether to open it anyway (lib/libraryLock.ts).
fn locked(h: &Holder) -> String {
    format!("LOCKED:{}", serde_json::to_string(h).unwrap_or_default())
}

/// Refuses (unless `force`) a library another app has open.
fn check_lock(app: &AppHandle, root: &std::path::Path, force: bool) -> CmdResult<()> {
    match crate::library::other_holder(root, &this_app(app)) {
        Some(h) if !force => Err(locked(&h)),
        _ => Ok(()),
    }
}

/// Keeps the open library's lock fresh, so another PC can tell it is in use.
pub fn start_lock_refresh(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(crate::library::LOCK_REFRESH_MS));
        if let Some(lib) = app.state::<AppState>().lib.lock().unwrap().as_mut() {
            lib.refresh_lock();
        }
    });
}

/// Closes the open library (on quitting): writes the database back into
/// library.db and removes the lock.
pub fn close_library(app: &AppHandle) {
    drop(app.state::<AppState>().lib.lock().unwrap().take());
}

fn activate(app: &AppHandle, state: &AppState, mut lib: Library) -> CmdResult<LibraryInfo> {
    lib.take_lock(this_app(app))?;
    app.asset_protocol_scope()
        .allow_directory(&lib.root, true)
        .map_err(err)?;
    let info = LibraryInfo {
        root: lib.root.display().to_string(),
        name: library_name(&lib.root),
    };
    update_settings(app, |s| {
        s.last_library = Some(lib.root.clone());
        s.remember(&lib.root, true);
    })?;
    *state.lib.lock().unwrap() = Some(lib);
    // The folders this library shares (none: the port is closed).
    apply_share(app);
    Ok(info)
}

pub(crate) fn library_name(root: &std::path::Path) -> String {
    root.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Re-opens the library used last time, if it still exists (and the user
/// didn't choose to pick one at launch).
#[tauri::command]
pub fn open_last_library(
    app: AppHandle,
    state: State<AppState>,
    force: Option<bool>,
) -> CmdResult<Option<LibraryInfo>> {
    let settings = load_settings(&app);
    if settings.app.startup == Startup::Choose {
        return Ok(None);
    }
    // Gone (deleted, a drive not connected): the welcome screen instead.
    let Some(p) = settings.last_library.filter(|p| p.join(crate::library::DB_FILE).is_file()) else {
        return Ok(None);
    };
    check_lock(&app, &p, force.unwrap_or(false))?;
    match Library::open(&p) {
        Ok(lib) => activate(&app, &state, lib).map(Some),
        Err(_) => Ok(None),
    }
}

/// `open: false` only creates it (a destination for "別のライブラリへ") and
/// adds it to the list of libraries.
#[tauri::command]
pub fn create_library(
    app: AppHandle,
    state: State<AppState>,
    path: PathBuf,
    open: Option<bool>,
    force: Option<bool>,
) -> CmdResult<LibraryInfo> {
    let path = if path.extension().is_some_and(|e| e == "library") {
        path
    } else {
        // Appended, not `with_extension`: that replaces a dot in the name
        // ("2025.01 Photos" became "2025.library", opening another library).
        let mut p = path.into_os_string();
        p.push(".library");
        PathBuf::from(p)
    };
    // An existing library at the path is opened: it may be open elsewhere.
    if open.unwrap_or(true) {
        check_lock(&app, &path, force.unwrap_or(false))?;
    }
    let lib = Library::create(&path)?;
    if open.unwrap_or(true) {
        return activate(&app, &state, lib);
    }
    update_settings(&app, |s| s.remember(&lib.root, false))?;
    Ok(LibraryInfo { root: lib.root.display().to_string(), name: library_name(&lib.root) })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    root: String,
    name: String,
    favorite: bool,
    last_opened: i64,
    /// False when the folder is gone (deleted, or on a disconnected drive).
    exists: bool,
    current: bool,
}

/// Known libraries: favourites first, then the most recently opened.
#[tauri::command]
pub fn list_libraries(app: AppHandle, state: State<AppState>) -> CmdResult<Vec<LibraryEntry>> {
    let current = state.lib.lock().unwrap().as_ref().map(|l| l.root.clone());
    let mut settings = load_settings(&app);
    // Libraries from before the list existed.
    if let Some(last) = settings.last_library.clone() {
        if !settings.libraries.iter().any(|l| l.path == last) {
            settings.remember(&last, true);
        }
    }
    let mut out: Vec<_> = settings
        .libraries
        .iter()
        .map(|l| LibraryEntry {
            root: l.path.display().to_string(),
            name: library_name(&l.path),
            favorite: l.favorite,
            last_opened: l.last_opened,
            exists: l.path.join(crate::library::DB_FILE).is_file(),
            current: current.as_ref() == Some(&l.path),
        })
        .collect();
    out.sort_by(|a, b| b.favorite.cmp(&a.favorite).then(b.last_opened.cmp(&a.last_opened)));
    Ok(out)
}

#[tauri::command]
pub fn set_library_favorite(app: AppHandle, path: PathBuf, favorite: bool) -> CmdResult<()> {
    update_settings(&app, |s| {
        s.remember(&path, false);
        if let Some(l) = s.libraries.iter_mut().find(|l| l.path == path) {
            l.favorite = favorite;
        }
    })
}

/// Takes a library off the list (the folder is left alone).
#[tauri::command]
pub fn forget_library(app: AppHandle, path: PathBuf) -> CmdResult<()> {
    update_settings(&app, |s| s.libraries.retain(|l| l.path != path))
}

/// Copies items (with their tags, folder, rating, favourite, ...) into another
/// library; `move_items` then puts them in this library's trash. Without
/// `ids`, every item of `kind` not in the trash.
#[tauri::command]
pub async fn transfer_items(
    app: AppHandle,
    dest: PathBuf,
    ids: Option<Vec<String>>,
    kind: Option<db::Kind>,
    move_items: bool,
) -> CmdResult<crate::transfer::TransferSummary> {
    tauri::async_runtime::spawn_blocking(move || {
        // Writing into a library another PC has open (and is refreshing)
        // would race its changes through the sync.
        if let Some(h) = crate::library::other_holder(&dest, &this_app(&app)) {
            if !h.stale(db::now_ms()) {
                return Err(format!("「{}」は「{}」で開かれています。そちらで閉じてから、もう一度試してください", library_name(&dest), h.name));
            }
        }
        let state = app.state::<AppState>();
        let (src_root, src) = with_lib(&state, |lib| {
            let ids = match ids {
                Some(ids) => ids,
                None => db::live_ids(&lib.conn, kind).map_err(err)?,
            };
            Ok((lib.root.clone(), crate::transfer::Source::read(lib, &ids)?))
        })?;
        let mut summary = crate::transfer::copy_into(&src, &dest, |done, total| {
            let _ = app.emit("transfer-progress", Progress { done, total });
        })?;
        if move_items {
            summary.trashed = crate::transfer::trash_in_source(&state.lib, &src_root, &summary.done_ids)?;
        }
        let _ = update_settings(&app, |s| s.remember(&dest, false));
        Ok(summary)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn open_library(
    app: AppHandle,
    state: State<AppState>,
    path: PathBuf,
    force: Option<bool>,
) -> CmdResult<LibraryInfo> {
    check_lock(&app, &path, force.unwrap_or(false))?;
    activate(&app, &state, Library::open(&path)?)
}

#[tauri::command]
pub fn get_app_settings(app: AppHandle) -> AppSettings {
    load_settings(&app).app
}

#[tauri::command]
pub fn set_app_settings(app: AppHandle, settings: AppSettings) -> CmdResult<AppSettings> {
    update_settings(&app, |all| {
        all.app = settings;
        all.app.clone()
    })
}

/// The open library's own settings (`settings` table in library.db), as JSON by key.
#[tauri::command]
pub fn get_library_settings(state: State<AppState>) -> CmdResult<std::collections::BTreeMap<String, serde_json::Value>> {
    with_lib(&state, |lib| db::library_settings(&lib.conn).map_err(err))
}

/// `value: null` removes the setting.
#[tauri::command]
pub fn set_library_setting(state: State<AppState>, key: String, value: serde_json::Value) -> CmdResult<()> {
    with_lib(&state, |lib| db::set_library_setting(&lib.conn, &key, Some(&value)).map_err(err))
}

/// Bytes of the files in the open library (the settings screen).
#[tauri::command]
pub fn library_size(state: State<AppState>) -> CmdResult<i64> {
    with_lib(&state, |lib| db::total_size(&lib.conn).map_err(err))
}

// ---------------------------------------------------------------- items

/// Item plus absolute paths for display (built in Rust so separators are
/// correct on Windows).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemView {
    #[serde(flatten)]
    item: Item,
    file_path: String,
    thumb_path: String,
    /// What the viewer shows (a JPEG copy for HEIC / TIFF).
    display_path: String,
}

/// Off the main thread, and the similar view's grouping (slow on a large
/// library) after letting go of the library, so neither freezes the window.
#[tauri::command]
pub async fn query_items(app: AppHandle, query: ItemQuery) -> CmdResult<Vec<ItemView>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let (root, rows) = with_lib(&state, |lib| Ok((lib.root.clone(), db::query_rows(&lib.conn, &query).map_err(err)?)))?;
        Ok(rows
            .finish()
            .into_iter()
            .map(|item| ItemView {
                file_path: crate::library::file_path(&root, &item).display().to_string(),
                thumb_path: crate::library::thumb_path(&root, &item).display().to_string(),
                display_path: crate::library::display_path(&root, &item).display().to_string(),
                item,
            })
            .collect())
    })
    .await
    .map_err(err)?
}

/// How many of a query's items have each value of each filter condition
/// (the filter row's menus, docs/NAVIGATION.md).
#[tauri::command]
pub async fn facet_counts(app: AppHandle, query: ItemQuery) -> CmdResult<db::Facets> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        with_lib(&state, |lib| db::facet_counts(&lib.conn, &query).map_err(err))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn get_counts(state: State<AppState>, mode: Option<db::Mode>) -> CmdResult<Counts> {
    with_lib(&state, |lib| db::counts(&lib.conn, mode).map_err(err))
}

#[tauri::command]
pub fn selection_info(state: State<AppState>, ids: Vec<String>) -> CmdResult<SelectionInfo> {
    with_lib(&state, |lib| db::selection_info(&lib.conn, &ids).map_err(err))
}

#[tauri::command]
pub fn set_note(state: State<AppState>, id: String, note: String) -> CmdResult<()> {
    with_lib(&state, |lib| db::set_note(&lib.conn, &id, &note).map_err(err))
}

#[tauri::command]
pub fn rename_item(state: State<AppState>, id: String, name: String) -> CmdResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(());
    }
    with_lib(&state, |lib| db::rename_item(&lib.conn, &id, name).map_err(err))
}

#[tauri::command]
pub fn trash_items(state: State<AppState>, ids: Vec<String>) -> CmdResult<()> {
    with_lib(&state, |lib| db::trash_items(&lib.conn, &ids).map_err(err))
}

/// Marks the images as "not duplicates" so they aren't proposed together again.
#[tauri::command]
pub fn dismiss_duplicates(state: State<AppState>, ids: Vec<String>) -> CmdResult<()> {
    with_lib(&state, |lib| db::dismiss_duplicates(&mut lib.conn, &ids).map_err(err))
}

#[tauri::command]
pub fn undismiss_duplicates(state: State<AppState>, ids: Vec<String>) -> CmdResult<()> {
    with_lib(&state, |lib| db::undismiss_duplicates(&lib.conn, &ids).map_err(err))
}

#[tauri::command]
pub fn clear_dismissed_duplicates(state: State<AppState>) -> CmdResult<()> {
    with_lib(&state, |lib| db::clear_dismissed_duplicates(&lib.conn).map_err(err))
}

/// How many dismissed groups are in effect.
#[tauri::command]
pub fn count_dismissed_duplicates(state: State<AppState>) -> CmdResult<usize> {
    with_lib(&state, |lib| db::dismissed_duplicate_groups(&lib.conn).map_err(err))
}

/// What tidying these groups would carry over to the copies kept.
#[tauri::command]
pub fn preview_duplicates(
    state: State<AppState>,
    groups: Vec<db::DuplicateGroup>,
) -> CmdResult<Vec<db::DuplicateEffect>> {
    with_lib(&state, |lib| db::plan_duplicates(&lib.conn, &groups).map_err(err))
}

#[tauri::command]
pub fn resolve_duplicates(
    state: State<AppState>,
    groups: Vec<db::DuplicateGroup>,
) -> CmdResult<Vec<db::DuplicateEffect>> {
    with_lib(&state, |lib| db::resolve_duplicates(&mut lib.conn, &groups).map_err(err))
}

#[tauri::command]
pub fn restore_items(state: State<AppState>, ids: Vec<String>) -> CmdResult<()> {
    with_lib(&state, |lib| db::restore_items(&lib.conn, &ids).map_err(err))
}

/// Rows go under the library's lock, files after it, off the main thread:
/// emptying a large trash removes thousands of folders.
#[tauri::command]
pub async fn delete_items(app: AppHandle, ids: Vec<String>) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, removed) = with_lib(&app.state::<AppState>(), |lib| Ok((lib.root.clone(), lib.delete_rows(&ids)?)))?;
        crate::library::remove_files(&root, &removed);
        Ok(())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn empty_trash(app: AppHandle) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, removed) = with_lib(&app.state::<AppState>(), |lib| {
            let ids = db::trashed_ids(&lib.conn).map_err(err)?;
            Ok((lib.root.clone(), lib.delete_rows(&ids)?))
        })?;
        crate::library::remove_files(&root, &removed);
        Ok(())
    })
    .await
    .map_err(err)?
}

pub(crate) fn item_paths(state: &AppState, ids: &[String]) -> CmdResult<Vec<(Item, PathBuf)>> {
    with_lib(state, |lib| {
        let mut items = db::get_items(&lib.conn, ids).map_err(err)?;
        // Keep the caller's order (e.g. grid order).
        items.sort_by_key(|it| ids.iter().position(|x| *x == it.id));
        Ok(items
            .into_iter()
            .map(|it| {
                let p = lib.file_path(&it);
                (it, p)
            })
            .collect())
    })
}

#[tauri::command]
pub fn reveal_item(state: State<AppState>, id: String) -> CmdResult<()> {
    let (_, path) = item_paths(&state, &[id])?.pop().ok_or("画像が見つかりません")?;
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(err)
}

/// Opens items in the OS default app.
#[tauri::command]
pub fn open_items(state: State<AppState>, ids: Vec<String>) -> CmdResult<()> {
    for (_, path) in item_paths(&state, &ids)? {
        tauri_plugin_opener::open_path(path, None::<&str>).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_rating(state: State<AppState>, ids: Vec<String>, rating: u8) -> CmdResult<()> {
    with_lib(&state, |lib| db::set_rating(&lib.conn, &ids, rating).map_err(err))
}

#[tauri::command]
pub fn set_favorite(state: State<AppState>, ids: Vec<String>, on: bool) -> CmdResult<()> {
    with_lib(&state, |lib| db::set_favorite(&lib.conn, &ids, on).map_err(err))
}

/// Pins the items to the top of every list, or unpins them.
#[tauri::command]
pub fn set_pinned(state: State<AppState>, ids: Vec<String>, on: bool) -> CmdResult<()> {
    with_lib(&state, |lib| db::set_pinned(&lib.conn, &ids, on).map_err(err))
}

/// Rotates / flips without touching the files (see orient.rs). Runs off the
/// main thread because thumbnails are re-rendered, and renders without
/// holding the library, which every other command needs. Returns how many changed.
#[tauri::command]
pub async fn orient_items(app: AppHandle, ids: Vec<String>, op: crate::orient::OrientOp) -> CmdResult<usize> {
    /// One at a time: each works from the orientation it read, and two quick
    /// turns of the same images must add up.
    static ORIENTING: Mutex<()> = Mutex::new(());
    tauri::async_runtime::spawn_blocking(move || {
        let _one = ORIENTING.lock().unwrap_or_else(|e| e.into_inner());
        let state = app.state::<AppState>();
        let job = with_lib(&state, |lib| import::OrientJob::plan(lib, &ids, op))?;
        let rendered = job.render();
        with_lib(&state, |lib| {
            if lib.root != job.root() {
                return Err("回転中に別のライブラリが開かれました".into());
            }
            job.commit(lib, rendered)
        })
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn copy_items(state: State<AppState>, ids: Vec<String>) -> CmdResult<usize> {
    use clipboard_rs::{common::RustImage, Clipboard, ClipboardContent, ClipboardContext, RustImageData};
    let paths: Vec<String> = item_paths(&state, &ids)?
        .into_iter()
        .map(|(_, p)| p.display().to_string())
        .collect();
    if paths.is_empty() {
        return Ok(0);
    }
    let ctx = ClipboardContext::new().map_err(err)?;
    let mut contents = vec![ClipboardContent::Files(paths.clone())];
    if paths.len() == 1 {
        if let Ok(img) = RustImageData::from_path(&paths[0]) {
            contents.push(ClipboardContent::Image(img));
        }
    }
    ctx.set(contents).map_err(err)?;
    Ok(paths.len())
}

// ------------------------------------------------------------ work tray

/// Puts items on the work tray (after the ones there); returns how many were new.
#[tauri::command]
pub fn add_to_tray(state: State<AppState>, ids: Vec<String>) -> CmdResult<usize> {
    with_lib(&state, |lib| db::add_to_tray(&lib.conn, &ids).map_err(err))
}

#[tauri::command]
pub fn remove_from_tray(state: State<AppState>, ids: Vec<String>) -> CmdResult<()> {
    with_lib(&state, |lib| db::remove_from_tray(&lib.conn, &ids).map_err(err))
}

/// Empties the tray; returns what was on it, in order (for undo).
#[tauri::command]
pub fn clear_tray(state: State<AppState>) -> CmdResult<Vec<String>> {
    with_lib(&state, |lib| db::clear_tray(&lib.conn).map_err(err))
}

#[tauri::command]
pub fn reorder_tray(state: State<AppState>, ids: Vec<String>, before: Option<String>) -> CmdResult<()> {
    with_lib(&state, |lib| db::reorder_tray(&mut lib.conn, &ids, before.as_deref()).map_err(err))
}

// -------------------------------------------------------- contact sheet

/// One item for the contact sheet: oriented, fitted inside `max_side` px,
/// as PNG or JPEG (sheet.rs). A font or file gives its thumbnail.
#[tauri::command]
pub async fn sheet_image(app: AppHandle, id: String, max_side: u32) -> CmdResult<tauri::ipc::Response> {
    tauri::async_runtime::spawn_blocking(move || {
        // Only look the paths up under the lock; decoding can take a while.
        let (item, src) = with_lib(&app.state::<AppState>(), |lib| {
            let item = db::get_items(&lib.conn, std::slice::from_ref(&id))
                .map_err(err)?
                .pop()
                .ok_or("画像が見つかりません")?;
            let src = crate::sheet::source_path(lib, &item);
            Ok((item, src))
        })?;
        let bytes = fs::read(&src).map_err(err)?;
        Ok(tauri::ipc::Response::new(crate::sheet::render(&item, &bytes, max_side)?))
    })
    .await
    .map_err(err)?
}

/// Writes a file the frontend made (a contact sheet) to the path chosen in
/// the save dialog, sent percent-encoded in `x-path`.
#[tauri::command]
pub fn save_file(request: tauri::ipc::Request<'_>) -> CmdResult<()> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("バイナリデータが必要です".into());
    };
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .map(PathBuf::from)
        .ok_or("保存先がありません")?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "html") {
        return Err("PNG・JPEG・HTML 以外では保存できません".into());
    }
    fs::write(&path, data).map_err(err)
}

/// Puts an image (PNG / JPEG data) on the clipboard, to paste into chat or mail.
#[tauri::command]
pub fn copy_image(request: tauri::ipc::Request<'_>) -> CmdResult<()> {
    use clipboard_rs::{common::RustImage, Clipboard, ClipboardContext, RustImageData};
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("バイナリデータが必要です".into());
    };
    let img = RustImageData::from_bytes(data).map_err(err)?;
    ClipboardContext::new().map_err(err)?.set_image(img).map_err(err)
}

/// Brings the window up: minimized, hidden or behind other apps.
pub fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Shows the log file (tauri-plugin-log, see lib.rs) in Finder / Explorer.
#[tauri::command]
pub fn reveal_log(app: AppHandle) -> CmdResult<()> {
    let dir = app.path().app_log_dir().map_err(err)?;
    let file = dir.join(format!("{}.log", crate::LOG_FILE));
    if file.is_file() {
        tauri_plugin_opener::reveal_item_in_dir(file).map_err(err)
    } else {
        std::fs::create_dir_all(&dir).map_err(err)?;
        tauri_plugin_opener::open_path(dir, None::<&str>).map_err(err)
    }
}

/// Shows a file the app wrote (e.g. a saved contact sheet) in Finder / Explorer.
#[tauri::command]
pub fn reveal_path(path: PathBuf) -> CmdResult<()> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(err)
}

// --------------------------------------------------------------- import

#[derive(Clone, Serialize)]
struct Progress {
    done: usize,
    total: usize,
}

fn emit_progress(app: &AppHandle) -> impl Fn(usize, usize) + Sync + '_ {
    move |done, total| {
        let _ = app.emit("import-progress", Progress { done, total });
    }
}

#[tauri::command]
pub async fn import_paths(
    app: AppHandle,
    paths: Vec<PathBuf>,
    folder_id: Option<String>,
) -> CmdResult<ImportSummary> {
    tauri::async_runtime::spawn_blocking(move || {
        let files = import::collect_files(&paths);
        let state = app.state::<AppState>();
        import::run(
            &state.lib,
            files,
            folder_id,
            emit_progress(&app),
        )
    })
    .await
    .map_err(err)?
}

/// Prepares the similar-images view: hashes items that predate the feature.
/// Returns how many were hashed.
#[tauri::command]
pub async fn index_similar(app: AppHandle) -> CmdResult<usize> {
    tauri::async_runtime::spawn_blocking(move || {
        import::compute_missing_phashes(&app.state::<AppState>().lib)
    })
    .await
    .map_err(err)?
}

/// Imports raw image bytes (clipboard paste). The file name and target
/// folder are passed as headers so the body can stay binary.
#[tauri::command]
pub async fn import_bytes(app: AppHandle, request: tauri::ipc::Request<'_>) -> CmdResult<ImportSummary> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("バイナリデータが必要です".into());
    };
    let header = |k: &str| {
        request
            .headers()
            .get(k)
            .and_then(|v| v.to_str().ok())
            .map(percent_decode)
    };
    let name = header("x-name").unwrap_or_else(|| "pasted.png".into());
    let folder_id = header("x-folder").filter(|s| !s.is_empty());
    let data = data.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        import::run(&state.lib, vec![Source::Bytes { name, data }], folder_id, emit_progress(&app))
    })
    .await
    .map_err(err)?
}

/// Headers are ASCII-only, so the frontend sends `encodeURIComponent` values.
pub(crate) fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        // On bytes: slicing the str would panic inside a multi-byte character ("%aあ").
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ----------------------------------------------------- browser extension

struct TauriHost(AppHandle);

impl webimport::Host for TauriHost {
    fn library(&self) -> &Mutex<Option<Library>> {
        &self.0.state::<AppState>().inner().lib
    }

    fn imported(&self, summary: &ImportSummary) {
        let _ = self.0.emit("web-import", summary);
    }

    /// Brings the window up with the question ("web-pair") and waits for
    /// `answer_web_pair`; gives up after two minutes ("web-pair-end" closes it).
    fn approve_pairing(&self, code: &str, peer: &webimport::Peer) -> bool {
        #[derive(Clone, Serialize)]
        struct Ask<'a> {
            id: &'a str,
            code: &'a str,
            /// The extension's id, or None for an app.
            extension: Option<&'a str>,
            /// The name an app gave itself (docs/FROM_APPS.md).
            app: Option<&'a str>,
        }
        let (extension, app) = match peer {
            webimport::Peer::Extension(id) => (Some(id.as_str()), None),
            webimport::Peer::App(name) => (None, Some(name.as_str())),
        };
        let state = self.0.state::<AppState>();
        let id = uuid::Uuid::new_v4().simple().to_string();
        let (tx, rx) = std::sync::mpsc::channel();
        state.pairing.lock().unwrap().insert(id.clone(), tx);
        show_main_window(&self.0);
        let _ = self.0.emit("web-pair", Ask { id: &id, code, extension, app });
        let approved = rx.recv_timeout(std::time::Duration::from_secs(120)).unwrap_or(false);
        state.pairing.lock().unwrap().remove(&id);
        let _ = self.0.emit("web-pair-end", &id);
        approved
    }
}

/// The user's answer to a "connect this extension?" question.
#[tauri::command]
pub fn answer_web_pair(state: State<AppState>, id: String, allow: bool) {
    if let Some(tx) = state.pairing.lock().unwrap().remove(&id) {
        let _ = tx.send(allow);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebImportStatus {
    enabled: bool,
    running: bool,
    port: u16,
    /// Why the server isn't running although it's turned on.
    error: Option<String>,
    /// Where the extension was put by `install_extension`, if it was.
    extension_dir: Option<String>,
}

fn extension_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("chrome-extension"))
}

fn new_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// Tells an installed copy of the extension where and how to connect.
fn write_extension_config(dir: &std::path::Path, token: &str) -> CmdResult<()> {
    let config = serde_json::json!({ "port": webimport::PORT, "token": token });
    fs::write(dir.join("config.json"), serde_json::to_vec_pretty(&config).map_err(err)?).map_err(err)
}

/// Starts or stops the server to match the settings (restarting it picks up a new token).
fn apply_web_import(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut web = state.web.lock().unwrap();
    *web = WebServer::default(); // stops a running server first, freeing the port
    let s = load_settings(app).web_import;
    if s.enabled && !s.token.is_empty() {
        match webimport::Server::start(webimport::PORT, s.token, std::sync::Arc::new(TauriHost(app.clone()))) {
            Ok(server) => web.server = Some(server),
            Err(e) => {
                log::warn!("browser extension server: {e}");
                web.error = Some(e);
            }
        }
    }
}

/// At startup: runs the server if the user turned it on earlier.
pub fn start_web_import(app: &AppHandle) {
    if load_settings(app).web_import.enabled {
        apply_web_import(app);
    }
}

fn web_status(app: &AppHandle) -> CmdResult<WebImportStatus> {
    let enabled = load_settings(app).web_import.enabled;
    let state = app.state::<AppState>();
    let web = state.web.lock().unwrap();
    let dir = extension_dir(app)?;
    Ok(WebImportStatus {
        enabled,
        running: web.server.is_some(),
        port: webimport::PORT,
        error: web.error.clone(),
        extension_dir: dir.join("manifest.json").is_file().then(|| dir.display().to_string()),
    })
}

#[tauri::command]
pub fn web_import_status(app: AppHandle) -> CmdResult<WebImportStatus> {
    web_status(&app)
}

#[tauri::command]
pub async fn set_web_import(app: AppHandle, enabled: bool) -> CmdResult<WebImportStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        update_settings(&app, |s| {
            s.web_import.enabled = enabled;
            if s.web_import.token.is_empty() {
                s.web_import.token = new_token();
            }
        })?;
        apply_web_import(&app);
        web_status(&app)
    })
    .await
    .map_err(err)?
}

/// Makes a new connection key: extensions set up before stop working until
/// they get the new one (the installed copy is updated here).
#[tauri::command]
pub async fn reset_web_import_token(app: AppHandle) -> CmdResult<WebImportStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = update_settings(&app, |s| {
            s.web_import.token = new_token();
            s.web_import.token.clone()
        })?;
        let dir = extension_dir(&app)?;
        if dir.join("manifest.json").is_file() {
            write_extension_config(&dir, &token)?;
        }
        apply_web_import(&app);
        web_status(&app)
    })
    .await
    .map_err(err)?
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Puts the extension (bundled with the app) in a folder Chrome can load
/// unpacked, with its connection settings, and shows it in Finder / Explorer.
/// Doing it again updates the files in place, so Chrome keeps the extension.
#[tauri::command]
pub async fn install_extension(app: AppHandle) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = app.path().resource_dir().map_err(err)?.join("extension");
        if !src.join("manifest.json").is_file() {
            return Err(format!("拡張機能のファイルが見つかりません: {}", src.display()));
        }
        let mut token = load_settings(&app).web_import.token;
        if token.is_empty() {
            token = update_settings(&app, |s| {
                if s.web_import.token.is_empty() {
                    s.web_import.token = new_token();
                }
                s.web_import.token.clone()
            })?;
            apply_web_import(&app);
        }
        let dir = extension_dir(&app)?;
        let _ = fs::remove_dir_all(&dir);
        copy_dir(&src, &dir).map_err(err)?;
        write_extension_config(&dir, &token)?;
        let _ = tauri_plugin_opener::reveal_item_in_dir(&dir);
        Ok(dir.display().to_string())
    })
    .await
    .map_err(err)?
}

// --------------------------------------------------------------- Claude

struct McpHost(AppHandle);

impl mcp::Host for McpHost {
    fn library(&self) -> &Mutex<Option<Library>> {
        &self.0.state::<AppState>().inner().lib
    }

    fn changed(&self, change: &changes::Change) {
        let _ = self.0.emit("library-changed", change);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    enabled: bool,
    running: bool,
    port: u16,
    /// Why the server isn't running although it's turned on.
    error: Option<String>,
    /// What to paste to connect: a command for Claude Code, the config for Claude Desktop.
    claude_code_command: Option<String>,
    desktop_config: Option<String>,
}

/// Starts or stops the server to match the settings (restarting it picks up a new token).
fn apply_mcp(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut srv = state.mcp.lock().unwrap();
    *srv = McpServer::default(); // stops a running server first, freeing the port
    let s = load_settings(app).mcp;
    if s.enabled && !s.token.is_empty() {
        match mcp::Server::start(mcp::PORT, s.token, std::sync::Arc::new(McpHost(app.clone()))) {
            Ok(server) => srv.server = Some(server),
            Err(e) => {
                log::warn!("MCP server: {e}");
                srv.error = Some(e);
            }
        }
    }
}

/// At startup: runs the server if the user turned it on earlier.
pub fn start_mcp(app: &AppHandle) {
    if load_settings(app).mcp.enabled {
        apply_mcp(app);
    }
}

fn mcp_state(app: &AppHandle) -> McpStatus {
    let s = load_settings(app).mcp;
    let state = app.state::<AppState>();
    let srv = state.mcp.lock().unwrap();
    let ready = s.enabled && !s.token.is_empty();
    let url = format!("http://127.0.0.1:{}/mcp", mcp::PORT);
    let exe = std::env::current_exe().ok().map(|p| p.display().to_string());
    McpStatus {
        enabled: s.enabled,
        running: srv.server.is_some(),
        port: mcp::PORT,
        error: srv.error.clone(),
        claude_code_command: ready.then(|| {
            format!(
                "claude mcp add --scope user --transport http stockroom {url} --header \"Authorization: Bearer {}\"",
                s.token
            )
        }),
        desktop_config: exe.filter(|_| ready).map(|exe| {
            let config = serde_json::json!({
                "mcpServers": { "stockroom": { "command": exe, "args": ["--mcp"] } }
            });
            serde_json::to_string_pretty(&config).unwrap_or_default()
        }),
    }
}

#[tauri::command]
pub fn mcp_status(app: AppHandle) -> McpStatus {
    mcp_state(&app)
}

#[tauri::command]
pub async fn set_mcp(app: AppHandle, enabled: bool) -> CmdResult<McpStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        update_settings(&app, |s| {
            s.mcp.enabled = enabled;
            if s.mcp.token.is_empty() {
                s.mcp.token = new_token();
            }
        })?;
        apply_mcp(&app);
        Ok(mcp_state(&app))
    })
    .await
    .map_err(err)?
}

/// Makes a new token: Claude Code / Desktop set up before stop working until
/// they are set up again (Claude Desktop reads it from the settings by itself).
#[tauri::command]
pub async fn reset_mcp_token(app: AppHandle) -> CmdResult<McpStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        update_settings(&app, |s| s.mcp.token = new_token())?;
        apply_mcp(&app);
        Ok(mcp_state(&app))
    })
    .await
    .map_err(err)?
}

// -------------------------------------------------------- folder sharing

struct ShareHost(AppHandle);

impl share::Host for ShareHost {
    fn library(&self) -> &Mutex<Option<Library>> {
        &self.0.state::<AppState>().inner().lib
    }
}

/// Runs the server while the open library shares a folder, and only then:
/// it is the one server other devices can reach.
fn apply_share(app: &AppHandle) {
    let state = app.state::<AppState>();
    let sharing = state.lib.lock().unwrap().as_ref().is_some_and(|lib| share::list(&lib.conn).is_ok_and(|s| !s.is_empty()));
    let mut srv = state.share.lock().unwrap();
    if !sharing {
        *srv = ShareServer::default(); // closes the port
        return;
    }
    if srv.server.is_some() {
        return;
    }
    match share::Server::start(std::net::Ipv4Addr::UNSPECIFIED, share::PORT, std::sync::Arc::new(ShareHost(app.clone()))) {
        Ok(server) => *srv = ShareServer { server: Some(server), error: None },
        Err(e) => {
            log::warn!("folder sharing: {e}");
            srv.error = Some(e);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareStatus {
    running: bool,
    port: u16,
    /// Why the server isn't running although a folder is shared.
    error: Option<String>,
    shares: Vec<ShareInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    #[serde(flatten)]
    share: share::Share,
    /// The folder's place in the sidebar ("旅行 / 京都").
    path: String,
    /// The URL at each address of this PC, the likeliest first (`share::lan_hosts`).
    urls: Vec<String>,
}

fn share_state(app: &AppHandle) -> CmdResult<ShareStatus> {
    let state = app.state::<AppState>();
    let (shares, folders) = with_lib(&state, |lib| {
        Ok((share::list(&lib.conn).map_err(err)?, db::list_folders(&lib.conn, None).map_err(err)?))
    })?;
    let hosts = if shares.is_empty() { vec![] } else { share::lan_hosts() };
    let path = |id: &str| {
        let mut names = vec![];
        let mut cur = folders.iter().find(|f| f.id == id);
        while let Some(f) = cur {
            names.push(f.name.as_str());
            cur = f.parent_id.as_deref().and_then(|p| folders.iter().find(|f| f.id == p));
        }
        names.reverse();
        names.join(" / ")
    };
    let srv = state.share.lock().unwrap();
    Ok(ShareStatus {
        running: srv.server.is_some(),
        port: share::PORT,
        error: srv.error.clone(),
        shares: shares
            .into_iter()
            .map(|s| ShareInfo {
                path: path(&s.folder_id),
                urls: hosts.iter().map(|h| share::url(h, share::PORT, &s.token)).collect(),
                share: s,
            })
            .collect(),
    })
}

#[tauri::command]
pub async fn share_status(app: AppHandle) -> CmdResult<ShareStatus> {
    // Looking up the PC's addresses can take a moment (macOS asks for its name).
    tauri::async_runtime::spawn_blocking(move || share_state(&app)).await.map_err(err)?
}

/// Shares a folder (keeping its URL if it already is) or stops sharing it.
#[tauri::command]
pub async fn set_folder_share(app: AppHandle, folder_id: String, on: bool) -> CmdResult<ShareStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        with_lib(&app.state::<AppState>(), |lib| {
            if on {
                share::start(&lib.conn, &folder_id).map(drop).map_err(err)
            } else {
                share::stop(&lib.conn, &folder_id).map_err(err)
            }
        })?;
        apply_share(&app);
        share_state(&app)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn set_share_download(app: AppHandle, folder_id: String, on: bool) -> CmdResult<ShareStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        with_lib(&app.state::<AppState>(), |lib| share::set_download(&lib.conn, &folder_id, on).map_err(err))?;
        share_state(&app)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn stop_all_shares(app: AppHandle) -> CmdResult<ShareStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        with_lib(&app.state::<AppState>(), |lib| share::stop_all(&lib.conn).map_err(err))?;
        apply_share(&app);
        share_state(&app)
    })
    .await
    .map_err(err)?
}

/// A URL as a QR code (SVG), for a phone's camera.
#[tauri::command]
pub fn share_qr(text: String) -> CmdResult<String> {
    share::qr_svg(&text)
}

/// Changes made from Claude (changes.rs), newest first.
#[tauri::command]
pub fn list_changes(state: State<AppState>) -> CmdResult<Vec<changes::Change>> {
    with_lib(&state, |lib| changes::list(&lib.conn, 30).map_err(err))
}

#[tauri::command]
pub fn undo_change(state: State<AppState>, id: i64) -> CmdResult<changes::Undone> {
    with_lib(&state, |lib| changes::undo(&mut lib.conn, id))
}

/// The proxy the OS uses for `url` (PAC included), for the updater: its
/// HTTP client can't run PAC scripts. None = connect directly.
#[tauri::command]
pub async fn system_proxy(url: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || crate::proxy::for_url(&url)).await.ok().flatten()
}

/// Opens the GitHub release page of `version` in the browser. The update
/// dialog and the settings' about page link there for what changed, instead
/// of showing the release notes in the app.
#[tauri::command]
pub fn open_release_page(version: String) -> CmdResult<()> {
    tauri_plugin_opener::open_url(release_page(&version)?, None::<&str>).map_err(err)
}

/// Same repository as `plugins.updater.endpoints` in tauri.conf.json. Only a
/// version goes into the URL, so the page can't be sent anywhere else.
fn release_page(version: &str) -> CmdResult<String> {
    let version = version.strip_prefix('v').unwrap_or(version);
    let ok = !version.is_empty() && version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    if !ok {
        return Err(format!("not a version: {version}"));
    }
    Ok(format!("https://github.com/hamirilo/stockroom/releases/tag/v{version}"))
}

#[tauri::command]
pub fn supported_exts() -> Vec<&'static str> {
    import::SUPPORTED_EXTS.to_vec()
}

// -------------------------------------------------------------- folders

#[tauri::command]
pub fn list_folders(state: State<AppState>, mode: Option<db::Mode>) -> CmdResult<Vec<Folder>> {
    with_lib(&state, |lib| db::list_folders(&lib.conn, mode).map_err(err))
}

/// A folder of `mode` (a subfolder is of its parent's).
#[tauri::command]
pub fn create_folder(state: State<AppState>, name: String, parent_id: Option<String>, mode: db::Mode) -> CmdResult<String> {
    with_lib(&state, |lib| {
        db::create_folder(&lib.conn, name.trim(), parent_id.as_deref(), mode).map_err(err)
    })
}

#[tauri::command]
pub fn rename_folder(state: State<AppState>, id: String, name: String) -> CmdResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(());
    }
    with_lib(&state, |lib| db::rename_folder(&lib.conn, &id, name).map_err(err))
}

#[tauri::command]
pub fn delete_folder(app: AppHandle, state: State<AppState>, id: String) -> CmdResult<()> {
    with_lib(&state, |lib| db::delete_folder(&lib.conn, &id).map_err(err))?;
    // Its share (and its subfolders') went with it.
    apply_share(&app);
    Ok(())
}

#[tauri::command]
pub fn move_folder(state: State<AppState>, id: String, parent_id: Option<String>) -> CmdResult<bool> {
    with_lib(&state, |lib| db::move_folder(&mut lib.conn, &id, parent_id.as_deref()).map_err(err))
}

#[tauri::command]
pub fn move_to_folder(state: State<AppState>, ids: Vec<String>, folder_id: String) -> CmdResult<()> {
    with_lib(&state, |lib| db::move_to_folder(&lib.conn, &ids, &folder_id).map_err(err))
}

/// Drops a folder under `parent_id`, in front of sibling `before` (None = last).
#[tauri::command]
pub fn place_folder(
    state: State<AppState>,
    id: String,
    parent_id: Option<String>,
    before: Option<String>,
) -> CmdResult<bool> {
    with_lib(&state, |lib| {
        db::place_folder(&mut lib.conn, &id, parent_id.as_deref(), before.as_deref()).map_err(err)
    })
}

/// -1 / +1 = up / down one, i32::MIN / i32::MAX = to the top / bottom.
#[tauri::command]
pub fn shift_folder(state: State<AppState>, id: String, by: i32) -> CmdResult<()> {
    with_lib(&state, |lib| db::shift_folder(&mut lib.conn, &id, by).map_err(err))
}

#[tauri::command]
pub fn sort_folders_by_name(state: State<AppState>, parent_id: Option<String>, mode: db::Mode) -> CmdResult<()> {
    with_lib(&state, |lib| db::sort_folders_by_name(&mut lib.conn, parent_id.as_deref(), mode).map_err(err))
}

// -------------------------------------------------------- smart folders

#[tauri::command]
pub fn list_smart_folders(state: State<AppState>, mode: Option<db::Mode>) -> CmdResult<Vec<db::SmartFolder>> {
    with_lib(&state, |lib| db::list_smart_folders(&lib.conn, mode).map_err(err))
}

#[tauri::command]
pub fn create_smart_folder(state: State<AppState>, name: String, rule: db::Rule, mode: db::Mode) -> CmdResult<String> {
    with_lib(&state, |lib| db::create_smart_folder(&lib.conn, name.trim(), &rule, mode).map_err(err))
}

#[tauri::command]
pub fn update_smart_folder(
    state: State<AppState>,
    id: String,
    name: Option<String>,
    rule: Option<db::Rule>,
) -> CmdResult<()> {
    let name = name.map(|n| n.trim().to_owned()).filter(|n| !n.is_empty());
    with_lib(&state, |lib| {
        db::update_smart_folder(&lib.conn, &id, name.as_deref(), rule.as_ref()).map_err(err)
    })
}

#[tauri::command]
pub fn delete_smart_folder(state: State<AppState>, id: String) -> CmdResult<()> {
    with_lib(&state, |lib| db::delete_smart_folder(&lib.conn, &id).map_err(err))
}

#[tauri::command]
pub fn list_exts(state: State<AppState>, mode: Option<db::Mode>) -> CmdResult<Vec<(String, i64)>> {
    with_lib(&state, |lib| db::list_exts(&lib.conn, mode).map_err(err))
}

#[tauri::command]
pub fn reorder_in_folder(
    state: State<AppState>,
    folder_id: String,
    ids: Vec<String>,
    before: Option<String>,
) -> CmdResult<()> {
    with_lib(&state, |lib| {
        db::reorder_in_folder(&mut lib.conn, &folder_id, &ids, before.as_deref()).map_err(err)
    })
}

#[tauri::command]
pub fn remove_from_folder(state: State<AppState>, ids: Vec<String>, folder_id: String) -> CmdResult<()> {
    with_lib(&state, |lib| db::remove_from_folder(&lib.conn, &ids, &folder_id).map_err(err))
}

// ----------------------------------------------------------------- tags

#[tauri::command]
pub fn list_tags(state: State<AppState>, mode: Option<db::Mode>) -> CmdResult<Vec<Tag>> {
    with_lib(&state, |lib| db::list_tags(&lib.conn, mode).map_err(err))
}

#[tauri::command]
pub fn add_tags(state: State<AppState>, ids: Vec<String>, names: Vec<String>) -> CmdResult<()> {
    with_lib(&state, |lib| db::add_tags(&mut lib.conn, &ids, &names).map_err(err))
}

#[tauri::command]
pub fn remove_tag(state: State<AppState>, ids: Vec<String>, tag_id: i64) -> CmdResult<()> {
    with_lib(&state, |lib| db::remove_tag(&lib.conn, &ids, tag_id).map_err(err))
}

#[tauri::command]
pub fn rename_tag(state: State<AppState>, id: i64, name: String) -> CmdResult<()> {
    with_lib(&state, |lib| db::rename_tag(&mut lib.conn, id, &name).map_err(err))
}

#[tauri::command]
pub fn set_folder_color(state: State<AppState>, id: String, color: Option<String>) -> CmdResult<()> {
    with_lib(&state, |lib| {
        db::set_color(&lib.conn, db::ColorTarget::Folder, &id, color.as_deref()).map_err(err)
    })
}

#[tauri::command]
pub fn set_smart_folder_color(state: State<AppState>, id: String, color: Option<String>) -> CmdResult<()> {
    with_lib(&state, |lib| {
        db::set_color(&lib.conn, db::ColorTarget::SmartFolder, &id, color.as_deref()).map_err(err)
    })
}

#[tauri::command]
pub fn set_tag_color(state: State<AppState>, id: i64, color: Option<String>) -> CmdResult<()> {
    with_lib(&state, |lib| {
        db::set_color(&lib.conn, db::ColorTarget::Tag, &id, color.as_deref()).map_err(err)
    })
}

#[tauri::command]
pub fn delete_tag(state: State<AppState>, id: i64) -> CmdResult<()> {
    with_lib(&state, |lib| db::delete_tag(&lib.conn, id).map_err(err))
}

#[cfg(test)]
mod tests {
    #[test]
    fn percent_decode_utf8() {
        assert_eq!(super::percent_decode("%E7%94%BB%E5%83%8F.png"), "画像.png");
        assert_eq!(super::percent_decode("a%2"), "a%2");
        assert_eq!(super::percent_decode("%aあ"), "%aあ");
    }

    #[test]
    fn release_page_takes_only_a_version() {
        let page = "https://github.com/hamirilo/stockroom/releases/tag/v0.28.0";
        assert_eq!(super::release_page("0.28.0").unwrap(), page);
        assert_eq!(super::release_page("v0.28.0").unwrap(), page);
        assert!(super::release_page("1.0.0-beta.1").is_ok());
        assert!(super::release_page("").is_err());
        assert!(super::release_page("0.28.0/../../evil").is_err());
        assert!(super::release_page("0.28.0?x=1").is_err());
    }
}

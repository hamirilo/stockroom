//! A library is a self-contained folder:
//!   <name>.library/library.db
//!   <name>.library/images/<item id>/<file name>
//!   <name>.library/thumbs/<item id>.jpg|png
//!   <name>.library/thumbs/<item id>_o<flip><turns>.jpg|png  (rotated, see orient.rs)
//!   <name>.library/previews/<item id>.jpg  (display copy, HEIC / TIFF)
//!   <name>.library/previews/<item id>.pdf|.qlpreview/  (documents, see files/preview.rs)
//!   <name>.library/library.lock   while the app has it open (see `Holder`)
//!
//! A library folder may be synced by Dropbox / OneDrive / iCloud Drive. Two
//! things keep that safe: the database is written back into library.db when
//! the library is closed (nothing left in library.db-wal for the sync to
//! pick up half of), and library.lock tells another PC that it is open.

use crate::db::{self, Item};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const DB_FILE: &str = "library.db";
pub const LOCK_FILE: &str = "library.lock";
/// Where the items' files are kept, one folder per item. Named before there
/// were other kinds than images; kept so existing libraries open as they are.
const FILES_DIR: &str = "images";

/// How often an open library's lock is refreshed (ms).
pub const LOCK_REFRESH_MS: u64 = 2 * 60 * 1000;
/// A lock not refreshed for this long was left behind: that app quit without
/// closing the library (crashed, the PC was turned off or went to sleep).
pub const LOCK_STALE_MS: i64 = 6 * 60 * 1000;

/// Who has a library open: written to library.lock while it is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Holder {
    /// Stable id of the PC (settings.json), so two PCs with the same name differ.
    pub machine: String,
    /// The PC's name, to show ("MacBook Pro").
    pub name: String,
    pub pid: u32,
    /// Last refreshed (ms).
    pub at: i64,
}

impl Holder {
    fn same_app(&self, other: &Holder) -> bool {
        self.machine == other.machine && self.pid == other.pid
    }

    /// Not refreshed for a while (see `LOCK_STALE_MS`).
    pub fn stale(&self, now: i64) -> bool {
        now - self.at > LOCK_STALE_MS
    }
}

/// Who holds the library at `root` now, if anyone (the lock file as written).
pub fn read_lock(root: &Path) -> Option<Holder> {
    serde_json::from_slice(&fs::read(root.join(LOCK_FILE)).ok()?).ok()
}

/// Someone else who has the library open, for `me` about to open it: an app
/// on another PC (refreshed lately or not, the user decides), or another copy
/// of the app on this PC that is still refreshing its lock. A lock left behind
/// on this PC is not in the way.
pub fn other_holder(root: &Path, me: &Holder) -> Option<Holder> {
    let h = read_lock(root)?;
    if h.same_app(me) || (h.machine == me.machine && h.stale(db::now_ms())) {
        return None;
    }
    Some(h)
}

pub struct Library {
    pub root: PathBuf,
    pub conn: Connection,
    /// The lock this app wrote (`take_lock`), removed again when closed.
    lock: Option<Holder>,
}

impl Drop for Library {
    fn drop(&mut self) {
        // Everything into library.db, and an empty library.db-wal: a synced
        // copy is then complete on its own.
        let _ = self.conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
        if let Some(me) = &self.lock {
            // Only our own: another PC may have opened it anyway since.
            if read_lock(&self.root).is_some_and(|h| h.same_app(me)) {
                let _ = fs::remove_file(self.root.join(LOCK_FILE));
            }
        }
    }
}

impl Library {
    pub fn create(root: &Path) -> Result<Self, String> {
        if root.join(DB_FILE).exists() {
            return Self::open(root);
        }
        if root.exists() && fs::read_dir(root).map_err(|e| e.to_string())?.next().is_some() {
            return Err("空でないフォルダにはライブラリを作成できません".into());
        }
        Self::load(root)
    }

    pub fn open(root: &Path) -> Result<Self, String> {
        if !root.join(DB_FILE).is_file() {
            return Err(format!("ライブラリではありません: {}", root.display()));
        }
        Self::load(root)
    }

    fn load(root: &Path) -> Result<Self, String> {
        fs::create_dir_all(root.join(FILES_DIR)).map_err(|e| e.to_string())?;
        fs::create_dir_all(root.join("thumbs")).map_err(|e| e.to_string())?;
        fs::create_dir_all(root.join("previews")).map_err(|e| e.to_string())?;
        let conn = db::open(&root.join(DB_FILE)).map_err(|e| e.to_string())?;
        Ok(Self { root: root.to_path_buf(), conn, lock: None })
    }

    /// Marks the library as open by `me` (library.lock), until it is dropped.
    pub fn take_lock(&mut self, me: Holder) -> Result<(), String> {
        write_lock(&self.root, &me)?;
        self.lock = Some(me);
        Ok(())
    }

    /// Refreshes the lock's time (see `LOCK_REFRESH_MS`). Leaves it alone when
    /// another app has taken the library over meanwhile.
    pub fn refresh_lock(&mut self) {
        let Some(me) = &mut self.lock else { return };
        if read_lock(&self.root).is_some_and(|h| !h.same_app(me)) {
            return;
        }
        me.at = db::now_ms();
        let _ = write_lock(&self.root, me);
    }

    pub fn file_path(&self, item: &Item) -> PathBuf {
        file_path(&self.root, item)
    }

    pub fn thumb_path(&self, item: &Item) -> PathBuf {
        thumb_path(&self.root, item)
    }

    /// What the viewer shows: the JPEG display copy if there is one.
    pub fn display_path(&self, item: &Item) -> PathBuf {
        display_path(&self.root, item)
    }

    /// Permanently deletes items (rows and files).
    pub fn delete_items(&self, ids: &[String]) -> Result<(), String> {
        let removed = self.delete_rows(ids)?;
        remove_files(&self.root, &removed);
        Ok(())
    }

    /// The database half of `delete_items`; the files go with `remove_files`,
    /// which needn't hold the library (there may be thousands).
    pub fn delete_rows(&self, ids: &[String]) -> Result<Vec<Item>, String> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        db::delete_items(&self.conn, ids).map_err(|e| e.to_string())
    }
}

/// An item's paths in the library at `root` (also without the library held).
pub fn file_path(root: &Path, item: &Item) -> PathBuf {
    stored_file(root, &item.id, &item.file_name)
}

/// The folder that holds only the item `id`'s file (`images/<id>`).
pub fn item_dir(root: &Path, id: &str) -> PathBuf {
    root.join(FILES_DIR).join(id)
}

/// `file_path` from the two columns it needs, for queries that read only those.
pub fn stored_file(root: &Path, id: &str, file_name: &str) -> PathBuf {
    item_dir(root, id).join(file_name)
}

/// Writes a new item's file into its own folder; returns where it went.
/// Undone with `remove_item_dir`.
pub fn store_file(root: &Path, id: &str, file_name: &str, data: &[u8]) -> Result<PathBuf, String> {
    let dir = item_dir(root, id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(file_name);
    fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(path)
}

/// `store_file` for a file on the disk, copied without reading it into memory.
pub fn copy_file(root: &Path, id: &str, file_name: &str, from: &Path) -> Result<PathBuf, String> {
    let dir = item_dir(root, id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(file_name);
    fs::copy(from, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Removes the item `id`'s file (its whole folder). Missing is fine.
pub fn remove_item_dir(root: &Path, id: &str) {
    let _ = fs::remove_dir_all(item_dir(root, id));
}

pub fn thumb_path(root: &Path, item: &Item) -> PathBuf {
    root.join("thumbs").join(&item.thumb)
}

pub fn display_path(root: &Path, item: &Item) -> PathBuf {
    match &item.preview {
        Some(p) => root.join("previews").join(p),
        None => file_path(root, item),
    }
}

/// Removes the files of deleted items (`Library::delete_rows`).
pub fn remove_files(root: &Path, removed: &[Item]) {
    for item in removed {
        remove_item_dir(root, &item.id);
        let _ = fs::remove_file(thumb_path(root, item));
        // The unrotated thumbnail is kept next to a rotated one, a video's frame next to its own.
        for t in crate::videos::thumb::other_thumbs(item) {
            let _ = fs::remove_file(root.join("thumbs").join(t));
        }
        if let Some(p) = &item.preview {
            let _ = fs::remove_file(root.join("previews").join(p));
        }
        crate::files::preview::remove(&root.join("previews"), &item.id);
    }
}

/// Written next to it and renamed into place, so a sync never sees half a file.
fn write_lock(root: &Path, h: &Holder) -> Result<(), String> {
    let tmp = root.join(format!("{LOCK_FILE}.tmp"));
    fs::write(&tmp, serde_json::to_vec(h).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, root.join(LOCK_FILE)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn holder(machine: &str, pid: u32, at: i64) -> Holder {
        Holder { machine: machine.into(), name: format!("PC {machine}"), pid, at }
    }

    #[test]
    fn lock_while_open() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("A.library");
        let now = db::now_ms();
        let me = holder("mac", 1, now);

        let mut lib = Library::create(&root).unwrap();
        assert_eq!(other_holder(&root, &me), None);
        lib.take_lock(me.clone()).unwrap();
        // Our own lock is not in the way; another PC's is, refreshed or not.
        assert_eq!(other_holder(&root, &me), None);
        let pc = holder("win", 7, now);
        assert_eq!(other_holder(&root, &pc).map(|h| h.name), Some("PC mac".into()));
        // Another copy of the app on the same PC: in the way while it refreshes.
        assert!(other_holder(&root, &holder("mac", 2, now)).is_some());

        lib.refresh_lock();
        assert!(read_lock(&root).unwrap().at >= now);
        drop(lib);
        assert_eq!(read_lock(&root), None, "closing removes the lock");
        assert!(!root.join("library.db-wal").exists() || fs::metadata(root.join("library.db-wal")).unwrap().len() == 0);
    }

    #[test]
    fn left_behind_and_taken_over() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("A.library");
        drop(Library::create(&root).unwrap());
        let old = db::now_ms() - LOCK_STALE_MS - 1000;

        // This PC's own lock from a crash: opens without asking.
        write_lock(&root, &holder("mac", 99, old)).unwrap();
        assert_eq!(other_holder(&root, &holder("mac", 1, db::now_ms())), None);
        // Another PC's, even an old one, is told about (it may be asleep).
        write_lock(&root, &holder("win", 7, old)).unwrap();
        let h = other_holder(&root, &holder("mac", 1, db::now_ms())).unwrap();
        assert!(h.stale(db::now_ms()));

        // Opened anyway: the lock is ours; the other app's refresh leaves it alone,
        // and closing that one doesn't remove ours.
        let mut theirs = Library::open(&root).unwrap();
        theirs.take_lock(holder("win", 7, old)).unwrap();
        let mut mine = Library::open(&root).unwrap();
        mine.take_lock(holder("mac", 1, db::now_ms())).unwrap();
        theirs.refresh_lock();
        drop(theirs);
        assert_eq!(read_lock(&root).unwrap().machine, "mac");
        drop(mine);
        assert_eq!(read_lock(&root), None);
    }

    #[test]
    fn create_open_and_reject() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("A.library");
        Library::create(&root).unwrap();
        assert!(root.join(FILES_DIR).is_dir() && root.join(DB_FILE).is_file());
        Library::open(&root).unwrap();
        Library::create(&root).unwrap(); // existing library just opens

        let other = tmp.path().join("other");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("x.txt"), "x").unwrap();
        assert!(Library::create(&other).is_err());
        assert!(Library::open(&other).is_err());
    }

    #[test]
    fn item_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let path = store_file(root, "abc", "cat.png", b"x").unwrap();
        // The layout existing libraries have.
        assert_eq!(path, root.join("images").join("abc").join("cat.png"));
        assert_eq!(stored_file(root, "abc", "cat.png"), path);
        assert_eq!(fs::read(&path).unwrap(), b"x");
        remove_item_dir(root, "abc");
        assert!(!item_dir(root, "abc").exists());
        remove_item_dir(root, "abc"); // already gone: fine
    }
}

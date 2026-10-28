//! Copying / moving items into another library, with what the user added to
//! them: name, note, rating, favourite, pin, rotation, source URL, font
//! metadata, tags (matched by name) and the folder they are in (the folder
//! path is recreated by name). Files are copied, never hard-linked, so the
//! libraries stay independent.
//!
//! The source library is read through its database file (ATTACH), so the
//! app's open connection isn't held while files are copied.

use crate::db::{self, Item};
use crate::library::{self, Library, DB_FILE};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSummary {
    /// Items added to the destination.
    pub copied: usize,
    /// Items the destination already had (same file); their tags and folder
    /// were merged in.
    pub duplicates: usize,
    /// "<name>: <reason>" for items that couldn't be copied.
    pub failed: Vec<String>,
    /// Items that arrived (copied or already there) of kinds the destination
    /// isn't used for (its `modes` setting), by kind.
    pub unused_kinds: BTreeMap<db::Kind, usize>,
    /// Source items that are now in the destination (copied or already there).
    /// The ones to take out of the source when moving.
    #[serde(skip)]
    pub done_ids: Vec<String>,
    /// Moving: how many of them went to the source's trash. None when the
    /// source was no longer the open library at the end (switched or closed
    /// during the copy), so they stay where they were.
    pub trashed: Option<usize>,
}

/// What the source library contributes besides the item rows.
pub struct Source {
    pub root: PathBuf,
    pub items: Vec<Item>,
    /// id -> (parent, name, colour)
    pub folders: HashMap<String, (Option<String>, String, Option<String>)>,
    /// id -> (name, colour)
    pub tags: HashMap<i64, (String, Option<String>)>,
}

impl Source {
    pub fn read(lib: &Library, ids: &[String]) -> Result<Self, String> {
        let e = |e: rusqlite::Error| e.to_string();
        // A parent travels with its children (docs/LINKS.md).
        let items = db::get_items(&lib.conn, &db::with_children(&lib.conn, ids).map_err(e)?).map_err(e)?;
        let mut stmt = lib.conn.prepare("SELECT id, parent_id, name, color FROM folders").map_err(e)?;
        let folders = stmt
            .query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?, r.get(3)?))))
            .map_err(e)?
            .collect::<Result<_, _>>()
            .map_err(e)?;
        let mut stmt = lib.conn.prepare("SELECT id, name, color FROM tags").map_err(e)?;
        let tags = stmt
            .query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))
            .map_err(e)?
            .collect::<Result<_, _>>()
            .map_err(e)?;
        Ok(Self { root: lib.root.clone(), items, folders, tags })
    }

    /// Folder names from the top down to `id`.
    fn folder_path(&self, id: &str) -> Vec<(&str, Option<&str>)> {
        let mut out = vec![];
        let mut cur = Some(id);
        // Bounded in case of a cycle in a damaged database.
        while let (Some(id), true) = (cur, out.len() < 64) {
            let Some((parent, name, color)) = self.folders.get(id) else { break };
            out.push((name.as_str(), color.as_deref()));
            cur = parent.as_deref();
        }
        out.reverse();
        out
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn columns(conn: &Connection, schema: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA {schema}.table_info(items)"))?;
    let names = stmt.query_map([], |r| r.get::<_, String>(1))?;
    names.collect()
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
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

/// Copies the item's files; returns what was written so it can be undone.
fn copy_files(src: &Path, dst: &Path, item: &Item) -> Result<Vec<PathBuf>, String> {
    let mut written = vec![];
    if !library::file_path(src, item).is_file() {
        return Err("元のファイルが見つかりません".into());
    }
    let dir = library::item_dir(dst, &item.id);
    copy_dir(&library::item_dir(src, &item.id), &dir).map_err(|e| e.to_string())?;
    written.push(dir);
    // Thumbnails and the display copy can be made again; a missing one is fine.
    let mut extra = vec![Path::new("thumbs").join(&item.thumb)];
    extra.extend(crate::videos::thumb::other_thumbs(item).into_iter().map(|t| Path::new("thumbs").join(t)));
    if let Some(p) = &item.preview {
        extra.push(Path::new("previews").join(p));
    }
    for rel in extra {
        if src.join(&rel).is_file() && !dst.join(&rel).exists() && fs::copy(src.join(&rel), dst.join(&rel)).is_ok() {
            written.push(dst.join(rel));
        }
    }
    Ok(written)
}

fn remove_written(paths: &[PathBuf]) {
    for p in paths {
        let _ = if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
    }
}

/// Copies `src.items` into the library at `dest`. Reports progress as
/// (done, total). The source isn't changed; moving is copying and then
/// trashing `done_ids` in the source.
pub fn copy_into(src: &Source, dest: &Path, progress: impl Fn(usize, usize)) -> Result<TransferSummary, String> {
    if same_dir(&src.root, dest) {
        return Err("同じライブラリには移せません".into());
    }
    let mut lib = Library::open(dest)?;
    let e = |e: rusqlite::Error| e.to_string();
    lib.conn
        .execute("ATTACH DATABASE ?1 AS src", [src.root.join(DB_FILE).to_string_lossy()])
        .map_err(e)?;
    let result = copy_attached(src, &mut lib, &progress);
    let _ = lib.conn.execute("DETACH DATABASE src", []);
    result
}

fn copy_attached(
    src: &Source,
    lib: &mut Library,
    progress: &impl Fn(usize, usize),
) -> Result<TransferSummary, String> {
    let e = |e: rusqlite::Error| e.to_string();
    // Both databases were migrated by this build, but an older build may have
    // left a column out on one side: copy what both have.
    let theirs = columns(&lib.conn, "src").map_err(e)?;
    let cols = columns(&lib.conn, "main")
        .map_err(e)?
        .into_iter()
        // Links are made again below, in the destination's own terms (docs/LINKS.md).
        .filter(|c| theirs.contains(c) && c != "parent_id" && c != "adopted")
        .collect::<Vec<_>>()
        .join(", ");
    let insert = format!("INSERT INTO main.items ({cols}) SELECT {cols} FROM src.items WHERE id = ?1");

    let mut summary = TransferSummary::default();
    // Source folder id -> destination folder id.
    let mut folder_map: HashMap<String, String> = HashMap::new();
    // Source item id -> its id in the destination (the same, unless the file was already there).
    let mut target_of: HashMap<String, String> = HashMap::new();
    let total = src.items.len();
    for (n, item) in src.items.iter().enumerate() {
        progress(n, total);
        // Same file already there (or the same item, from an earlier copy).
        let existing: Option<String> = lib
            .conn
            .query_row(
                "SELECT id FROM main.items
                 WHERE id = ?1 OR hash = (SELECT hash FROM src.items WHERE id = ?1)
                 ORDER BY id = ?1 DESC LIMIT 1",
                [&item.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(e)?;
        let written = match &existing {
            Some(_) => vec![],
            None => match copy_files(&src.root, &lib.root, item) {
                Ok(w) => w,
                Err(msg) => {
                    summary.failed.push(format!("{}: {msg}", item.name));
                    continue;
                }
            },
        };
        let target = existing.clone().unwrap_or_else(|| item.id.clone());
        let res = (|| -> rusqlite::Result<()> {
            let tx = lib.conn.transaction()?;
            match &existing {
                None => {
                    tx.execute(&insert, [&item.id])?;
                    // Trashed in the source still arrives as a live item; it
                    // was picked on purpose.
                    tx.execute("UPDATE main.items SET deleted_at = NULL WHERE id = ?1", [&item.id])?;
                }
                Some(id) => {
                    // Keep what the user set on either copy.
                    tx.execute(
                        "UPDATE main.items SET deleted_at = NULL,
                           rating = MAX(rating, ?2), favorite = MAX(favorite, ?3),
                           pinned_at = COALESCE(pinned_at, ?4),
                           note = CASE WHEN note = '' THEN ?5 ELSE note END
                         WHERE id = ?1",
                        params![id, item.rating, item.favorite, item.pinned_at, item.note],
                    )?;
                }
            }
            // The destination's tags and folders of the item's mode (docs/MODES.md).
            let mode = db::Mode::of(item.kind);
            for tag in &item.tag_ids {
                let Some((name, color)) = src.tags.get(tag) else { continue };
                let tag_id = db::ensure_tag(&tx, name, mode)?;
                tx.execute("UPDATE main.tags SET color = ?2 WHERE id = ?1 AND color IS NULL", params![tag_id, color])?;
                tx.execute(
                    "INSERT OR IGNORE INTO main.item_tags (item_id, tag_id) VALUES (?1, ?2)",
                    params![target, tag_id],
                )?;
            }
            if let Some(fid) = &item.folder_id {
                let dest_folder = match folder_map.get(fid) {
                    Some(d) => Some(d.clone()),
                    None => {
                        let mut parent: Option<String> = None;
                        for (name, color) in src.folder_path(fid) {
                            let id = db::find_or_create_folder(&tx, parent.as_deref(), name, mode)?;
                            tx.execute(
                                "UPDATE main.folders SET color = ?2 WHERE id = ?1 AND color IS NULL",
                                params![id, color],
                            )?;
                            parent = Some(id);
                        }
                        parent
                    }
                };
                if let Some(d) = dest_folder {
                    db::file_unfiled(&tx, std::slice::from_ref(&target), &d)?;
                    folder_map.insert(fid.clone(), d);
                }
            }
            tx.commit()
        })();
        match res {
            Ok(()) => {
                if existing.is_some() {
                    summary.duplicates += 1;
                } else {
                    summary.copied += 1;
                }
                summary.done_ids.push(item.id.clone());
                target_of.insert(item.id.clone(), target);
            }
            Err(err) => {
                remove_written(&written);
                summary.failed.push(format!("{}: {err}", item.name));
            }
        }
    }
    // Parents and children that arrived together are linked again, where the destination uses links.
    if db::links_enabled(&lib.conn).map_err(e)? {
        for item in &src.items {
            let (Some(parent), Some(child)) =
                (item.parent_id.as_ref().and_then(|p| target_of.get(p)), target_of.get(&item.id))
            else {
                continue;
            };
            db::link_items(&lib.conn, parent, std::slice::from_ref(child)).map_err(e)?;
            if item.adopted {
                db::set_adopted(&lib.conn, child, true).map_err(e)?;
            }
        }
    }
    progress(total, total);
    if let Some(used) = db::used_kinds(&lib.conn).map_err(e)? {
        for item in src.items.iter().filter(|i| summary.done_ids.contains(&i.id)) {
            if !used.contains(&item.kind) {
                *summary.unused_kinds.entry(item.kind).or_default() += 1;
            }
        }
    }
    Ok(summary)
}

/// Moving: puts the copied items in the source's trash, if the source
/// (`root`) is still the open library. The library isn't held during the
/// copy and can be switched meanwhile (the progress is only a toast); item
/// ids are kept by the copy, so trashing in the destination would trash the
/// copies. None when it wasn't trashed.
pub fn trash_in_source(open: &Mutex<Option<Library>>, root: &Path, ids: &[String]) -> Result<Option<usize>, String> {
    let guard = open.lock().unwrap();
    match guard.as_ref() {
        Some(lib) if lib.root == root => {
            if !ids.is_empty() {
                db::trash_items(&lib.conn, ids).map_err(|e| e.to_string())?;
            }
            Ok(Some(ids.len()))
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{ItemQuery, NewItem};

    fn add(lib: &Library, id: &str, hash: &str) {
        library::store_file(&lib.root, id, "a.png", hash.as_bytes()).unwrap();
        fs::write(lib.root.join("thumbs").join(format!("{id}.jpg")), "t").unwrap();
        let mut conn = db::open(&lib.root.join(DB_FILE)).unwrap();
        let tx = conn.transaction().unwrap();
        let it = NewItem {
            id: id.into(),
            kind: db::Kind::Image,
            name: format!("name-{id}"),
            file_name: "a.png".into(),
            ext: "png".into(),
            width: 10,
            height: 10,
            size: 1,
            hash: hash.into(),
            thumb: format!("{id}.jpg"),
            phash: None,
            preview: None,
            font: None,
            body: None,
            duration_ms: None,
        };
        db::insert_item(&tx, &it, 1).unwrap();
        tx.commit().unwrap();
    }

    fn all(lib: &Library) -> Vec<Item> {
        db::query_items(&lib.conn, &ItemQuery::default()).unwrap()
    }

    #[test]
    fn moving_trashes_only_in_the_source() {
        let tmp = tempfile::tempdir().unwrap();
        let a_root = tmp.path().join("A.library");
        let a = Library::create(&a_root).unwrap();
        add(&a, "i1", "h1");
        let b = Library::create(&tmp.path().join("B.library")).unwrap();
        add(&b, "i1", "h1"); // the copy keeps the id
        let ids = vec!["i1".to_string()];

        // Another library was opened during the copy: nothing is trashed there.
        let open = Mutex::new(Some(b));
        assert_eq!(trash_in_source(&open, &a_root, &ids).unwrap(), None);
        assert_eq!(all(open.lock().unwrap().as_ref().unwrap()).len(), 1);
        *open.lock().unwrap() = None;
        assert_eq!(trash_in_source(&open, &a_root, &ids).unwrap(), None);

        *open.lock().unwrap() = Some(a);
        assert_eq!(trash_in_source(&open, &a_root, &ids).unwrap(), Some(1));
        assert!(all(open.lock().unwrap().as_ref().unwrap()).is_empty());
    }

    #[test]
    fn reports_kinds_the_destination_is_not_used_for() {
        let tmp = tempfile::tempdir().unwrap();
        let a = Library::create(&tmp.path().join("A.library")).unwrap();
        let b_root = tmp.path().join("B.library");
        let b = Library::create(&b_root).unwrap();
        db::set_library_setting(&b.conn, "modes", Some(&serde_json::json!(["font"]))).unwrap();
        drop(b);
        add(&a, "i1", "h1");
        add(&a, "i2", "h2");
        let src = Source::read(&a, &["i1".into(), "i2".into()]).unwrap();
        let sum = copy_into(&src, &b_root, |_, _| {}).unwrap();
        assert_eq!(sum.unused_kinds, BTreeMap::from([(db::Kind::Image, 2)]));
    }

    #[test]
    fn copies_rows_files_tags_and_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let mut a = Library::create(&tmp.path().join("A.library")).unwrap();
        let b_root = tmp.path().join("B.library");
        let mut b = Library::create(&b_root).unwrap();
        add(&a, "i1", "h1");
        add(&a, "i2", "h2");
        add(&b, "x2", "h2"); // already in B under another id

        let parent = db::create_folder(&a.conn, "Work", None, db::Mode::Stock).unwrap();
        let child = db::create_folder(&a.conn, "Logos", Some(&parent), db::Mode::Stock).unwrap();
        db::set_color(&a.conn, db::ColorTarget::Folder, &child, Some("red")).unwrap();
        db::move_to_folder(&a.conn, &["i1".into(), "i2".into()], &child).unwrap();
        db::add_tags(&mut a.conn, &["i1".into(), "i2".into()], &["brand".into()]).unwrap();
        db::set_favorite(&a.conn, &["i1".into(), "i2".into()], true).unwrap();
        db::set_note(&a.conn, "i1", "memo").unwrap();
        drop(b);

        let src = Source::read(&a, &["i1".into(), "i2".into()]).unwrap();
        let sum = copy_into(&src, &b_root, |_, _| {}).unwrap();
        assert_eq!((sum.copied, sum.duplicates, sum.failed.len()), (1, 1, 0));
        assert_eq!(sum.done_ids, vec!["i1".to_string(), "i2".to_string()]);
        // B is used for every kind (no `modes` setting).
        assert!(sum.unused_kinds.is_empty());

        b = Library::open(&b_root).unwrap();
        assert!(b_root.join("images/i1/a.png").is_file());
        assert!(b_root.join("thumbs/i1.jpg").is_file());
        let items = all(&b);
        assert_eq!(items.len(), 2);
        let i1 = items.iter().find(|i| i.id == "i1").unwrap();
        assert_eq!((i1.name.as_str(), i1.note.as_str(), i1.favorite), ("name-i1", "memo", true));
        let x2 = items.iter().find(|i| i.id == "x2").unwrap();
        assert!(x2.favorite, "merged into the existing copy");
        assert_eq!(i1.folder_id, x2.folder_id);
        let folders = db::list_folders(&b.conn, None).unwrap();
        let logos = folders.iter().find(|f| f.name == "Logos").unwrap();
        assert_eq!(Some(&logos.id), i1.folder_id.as_ref());
        assert_eq!(logos.color.as_deref(), Some("red"));
        assert!(folders.iter().any(|f| f.name == "Work" && Some(&f.id) == logos.parent_id.as_ref()));
        let tags = db::list_tags(&b.conn, None).unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].count, 2);

        // The source is untouched; copying again adds nothing.
        assert_eq!(all(&a).len(), 2);
        drop(b);
        let again = copy_into(&src, &b_root, |_, _| {}).unwrap();
        assert_eq!((again.copied, again.duplicates), (0, 2));
    }

    #[test]
    fn a_parent_arrives_with_its_children_and_links_follow_the_destination() {
        let tmp = tempfile::tempdir().unwrap();
        let a = Library::create(&tmp.path().join("A.library")).unwrap();
        let b_on_root = tmp.path().join("B.library");
        let b_off_root = tmp.path().join("C.library");
        let b_on = Library::create(&b_on_root).unwrap();
        db::set_links_enabled(&b_on.conn, true).unwrap();
        drop(b_on);
        Library::create(&b_off_root).unwrap();
        db::set_links_enabled(&a.conn, true).unwrap();
        for (id, h) in [("v", "h1"), ("t1", "h2"), ("t2", "h3"), ("solo", "h4")] {
            add(&a, id, h);
        }
        db::link_items(&a.conn, "v", &["t1".into(), "t2".into()]).unwrap();
        db::set_adopted(&a.conn, "t2", true).unwrap();

        // Only the parent is picked: its children come too.
        let src = Source::read(&a, &["v".into(), "solo".into()]).unwrap();
        assert_eq!(src.items.len(), 4);
        let sum = copy_into(&src, &b_on_root, |_, _| {}).unwrap();
        assert_eq!((sum.copied, sum.failed.len()), (4, 0));
        let b = Library::open(&b_on_root).unwrap();
        let items = all(&b);
        let get = |id: &str| items.iter().find(|i| i.id == id).unwrap();
        assert_eq!(get("t1").parent_id.as_deref(), Some("v"));
        assert_eq!(get("t2").parent_id.as_deref(), Some("v"));
        assert!(get("t2").adopted && !get("t1").adopted);
        assert_eq!(get("solo").parent_id, None);

        // A destination without links gets plain items.
        let sum = copy_into(&src, &b_off_root, |_, _| {}).unwrap();
        assert_eq!((sum.copied, sum.failed.len()), (4, 0));
        let c = Library::open(&b_off_root).unwrap();
        assert!(all(&c).iter().all(|i| i.parent_id.is_none() && !i.adopted));

        // A child alone arrives on its own, not pointing at a parent that isn't there.
        let one = Source::read(&a, &["t1".into()]).unwrap();
        let tmp_root = tmp.path().join("D.library");
        let d = Library::create(&tmp_root).unwrap();
        db::set_links_enabled(&d.conn, true).unwrap();
        drop(d);
        let sum = copy_into(&one, &tmp_root, |_, _| {}).unwrap();
        assert_eq!((sum.copied, sum.failed.len()), (1, 0));
        assert_eq!(all(&Library::open(&tmp_root).unwrap())[0].parent_id, None);
    }

    #[test]
    fn rejects_same_library_and_reports_missing_files() {
        let tmp = tempfile::tempdir().unwrap();
        let a = Library::create(&tmp.path().join("A.library")).unwrap();
        let b_root = tmp.path().join("B.library");
        Library::create(&b_root).unwrap();
        add(&a, "i1", "h1");
        let src = Source::read(&a, &["i1".into()]).unwrap();
        assert!(copy_into(&src, &a.root, |_, _| {}).is_err());

        library::remove_item_dir(&a.root, "i1");
        let sum = copy_into(&src, &b_root, |_, _| {}).unwrap();
        assert_eq!((sum.copied, sum.failed.len()), (0, 1));
        assert!(all(&Library::open(&b_root).unwrap()).is_empty());
    }
}

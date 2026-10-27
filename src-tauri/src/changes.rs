//! Changes made from outside the UI (Claude through MCP, see mcp/), recorded
//! with what is needed to undo them. The UI's own actions undo themselves
//! from the toast (src/lib/actions.ts); these can be undone later too, from
//! the toast or the list in the "Claude と連携" dialog.
//!
//! Each edit function applies one kind of change and notes in `Undo` only
//! what actually changed (a tag the item already had is not noted, so undoing
//! never takes away something that was there before). Undoing reverts an
//! entry only while it still has the value the change gave it: whatever was
//! edited again since is left alone and counted as skipped.

use crate::db::{self, DbResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Changes kept per library (older ones can no longer be undone).
const KEEP: i64 = 100;

#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Undo {
    /// (item, tag) pairs the change added / removed.
    tags_added: Vec<(String, i64)>,
    tags_removed: Vec<(String, i64)>,
    /// Tags the change created (deleted on undo if nothing uses them any more).
    tags_created: Vec<i64>,
    folder_moves: Vec<FolderMove>,
    /// Folders the change created, parents first (deleted on undo if empty).
    folders_created: Vec<String>,
    /// (item, before, after)
    names: Vec<(String, String, String)>,
    notes: Vec<(String, String, String)>,
    /// Links made or removed (docs/LINKS.md).
    links: Vec<LinkChange>,
    /// (item, before, after): the adopted mark of a child.
    adopted: Vec<(String, bool, bool)>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct LinkChange {
    /// How the child stood before (its parent, folder and adopted mark).
    before: db::Placement,
    /// Its parent after the change; None = freed.
    after_parent: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct FolderMove {
    item: String,
    /// The folder and manual-order position before; None = unfiled.
    before: Option<(String, Option<f64>)>,
    after: Option<String>,
}

impl Undo {
    pub fn is_empty(&self) -> bool {
        *self == Undo::default()
    }

    /// Folders created so far.
    pub fn folders_created(&self) -> usize {
        self.folders_created.len()
    }
}

// ---------------------------------------------------------------- edits

/// Adds the tag `name` to `items`, each the tag of its own mode (creating it
/// if needed, docs/MODES.md); returns how many items gained it.
pub fn add_tag(conn: &Connection, undo: &mut Undo, items: &[String], name: &str) -> DbResult<usize> {
    let mut n = 0;
    for (mode, items) in db::by_mode(conn, items)? {
        let tag = match db::tag_id(conn, name, mode)? {
            Some(t) => t,
            None => {
                let t = db::ensure_tag(conn, name, mode)?;
                undo.tags_created.push(t);
                t
            }
        };
        let mut stmt = conn.prepare_cached("INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?1, ?2)")?;
        for id in &items {
            if stmt.execute(params![id, tag])? == 1 {
                undo.tags_added.push((id.clone(), tag));
                n += 1;
            }
        }
    }
    Ok(n)
}

/// Takes the tag `name` (of each item's mode) off `items`; the tag itself
/// stays. Returns how many had it.
pub fn remove_tag(conn: &Connection, undo: &mut Undo, items: &[String], name: &str) -> DbResult<usize> {
    let mut n = 0;
    for (mode, items) in db::by_mode(conn, items)? {
        let Some(tag) = db::tag_id(conn, name, mode)? else { continue };
        let mut stmt = conn.prepare_cached("DELETE FROM item_tags WHERE item_id = ?1 AND tag_id = ?2")?;
        for id in &items {
            if stmt.execute(params![id, tag])? == 1 {
                undo.tags_removed.push((id.clone(), tag));
                n += 1;
            }
        }
    }
    Ok(n)
}

fn folder_of(conn: &Connection, item: &str) -> DbResult<Option<(String, Option<f64>)>> {
    conn.query_row("SELECT folder_id, position FROM item_folders WHERE item_id = ?1", [item], |r| {
        Ok((r.get(0)?, r.get(1)?))
    })
    .optional()
}

/// Puts `items` into `folder` (None = unfiled); returns how many moved.
pub fn move_to_folder(conn: &Connection, undo: &mut Undo, items: &[String], folder: Option<&str>) -> DbResult<usize> {
    let mut n = 0;
    // A child only moves with its parent, and a parent takes its children (docs/LINKS.md).
    for id in &db::with_linked(conn, items)? {
        let before = folder_of(conn, id)?;
        if before.as_ref().map(|(f, _)| f.as_str()) == folder {
            continue;
        }
        match folder {
            Some(f) => db::place_in_folder(conn, std::slice::from_ref(id), f)?,
            None => {
                conn.execute("DELETE FROM item_folders WHERE item_id = ?1", [id])?;
            }
        }
        undo.folder_moves.push(FolderMove { item: id.clone(), before, after: folder.map(str::to_owned) });
        n += 1;
    }
    Ok(n)
}

/// Links `children` to `parent` (they go to its folder); returns how many were linked.
pub fn link(conn: &Connection, undo: &mut Undo, parent: &str, children: &[String]) -> DbResult<usize> {
    let moved = db::link_items(conn, parent, children)?;
    let n = moved.len();
    undo.links.extend(moved.into_iter().map(|before| LinkChange { before, after_parent: Some(parent.to_owned()) }));
    Ok(n)
}

/// Frees `ids` from their parents; returns how many had one.
pub fn unlink(conn: &Connection, undo: &mut Undo, ids: &[String]) -> DbResult<usize> {
    let was = db::unlink_items(conn, ids)?;
    let n = was.len();
    undo.links.extend(was.into_iter().map(|before| LinkChange { before, after_parent: None }));
    Ok(n)
}

/// Picks (or unpicks) the adopted child; returns how many items' marks changed
/// (picking one takes the mark off its siblings).
pub fn adopt(conn: &Connection, undo: &mut Undo, id: &str, on: bool) -> DbResult<usize> {
    let family = |conn: &Connection| -> DbResult<Vec<(String, bool)>> {
        let mut stmt = conn.prepare(
            "SELECT id, adopted != 0 FROM items
             WHERE parent_id IS NOT NULL AND parent_id = (SELECT parent_id FROM items WHERE id = ?1)",
        )?;
        let rows = stmt.query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    };
    let before = family(conn)?;
    db::set_adopted(conn, id, on)?;
    let mut n = 0;
    for ((item, was), (_, now)) in before.into_iter().zip(family(conn)?) {
        if was != now {
            undo.adopted.push((item, was, now));
            n += 1;
        }
    }
    Ok(n)
}

/// The folder of `mode` at `path` (names separated by "/"), creating what is
/// missing. None for an empty path.
pub fn ensure_folder_path(conn: &Connection, undo: &mut Undo, path: &str, mode: db::Mode) -> DbResult<Option<String>> {
    let mut parent: Option<String> = None;
    for name in path.split('/').map(str::trim).filter(|n| !n.is_empty()) {
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM folders WHERE name = ?1 AND parent_id IS ?2 AND mode = ?3",
                params![name, parent, mode.as_str()],
                |r| r.get(0),
            )
            .optional()?;
        parent = Some(match existing {
            Some(id) => id,
            None => {
                let id = db::create_folder(conn, name, parent.as_deref(), mode)?;
                undo.folders_created.push(id.clone());
                id
            }
        });
    }
    Ok(parent)
}

/// Sets an item's display name; false if it already had it.
pub fn rename(conn: &Connection, undo: &mut Undo, item: &str, name: &str) -> DbResult<bool> {
    let before: String = conn.query_row("SELECT name FROM items WHERE id = ?1", [item], |r| r.get(0))?;
    if before == name {
        return Ok(false);
    }
    db::rename_item(conn, item, name)?;
    undo.names.push((item.to_owned(), before, name.to_owned()));
    Ok(true)
}

/// Sets an item's note; false if it already had it.
pub fn set_note(conn: &Connection, undo: &mut Undo, item: &str, note: &str) -> DbResult<bool> {
    let before: String = conn.query_row("SELECT note FROM items WHERE id = ?1", [item], |r| r.get(0))?;
    if before == note {
        return Ok(false);
    }
    db::set_note(conn, item, note)?;
    undo.notes.push((item.to_owned(), before, note.to_owned()));
    Ok(true)
}

// ------------------------------------------------------- record / undo

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub id: i64,
    pub at: i64,
    pub source: String,
    pub summary: String,
    pub undone: bool,
}

/// Records a change; returns its number. Only the latest `KEEP` are kept.
pub fn record(conn: &Connection, source: &str, summary: &str, undo: &Undo) -> DbResult<i64> {
    conn.execute(
        "INSERT INTO changes (at, source, summary, undo) VALUES (?1, ?2, ?3, ?4)",
        params![db::now_ms(), source, summary, serde_json::to_string(undo).unwrap_or_default()],
    )?;
    let id = conn.last_insert_rowid();
    conn.execute("DELETE FROM changes WHERE id <= ?1", [id - KEEP])?;
    Ok(id)
}

/// The latest changes, newest first.
pub fn list(conn: &Connection, limit: usize) -> DbResult<Vec<Change>> {
    let mut stmt =
        conn.prepare("SELECT id, at, source, summary, undone_at IS NOT NULL FROM changes ORDER BY id DESC LIMIT ?1")?;
    let rows = stmt.query_map([limit as i64], |r| {
        Ok(Change { id: r.get(0)?, at: r.get(1)?, source: r.get(2)?, summary: r.get(3)?, undone: r.get(4)? })
    })?;
    rows.collect()
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Undone {
    pub summary: String,
    /// Entries left alone because they were changed again since.
    pub skipped: usize,
}

/// Reverts a recorded change (see the module comment).
pub fn undo(conn: &mut Connection, id: i64) -> Result<Undone, String> {
    let e = |e: rusqlite::Error| e.to_string();
    let tx = conn.transaction().map_err(e)?;
    let row: Option<(String, String, Option<i64>)> = tx
        .query_row("SELECT summary, undo, undone_at FROM changes WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()
        .map_err(e)?;
    let Some((summary, json, undone_at)) = row else {
        return Err("この変更の記録はもうありません".into());
    };
    if undone_at.is_some() {
        return Err("この変更はすでに元に戻しています".into());
    }
    let u: Undo = serde_json::from_str(&json).map_err(|x| x.to_string())?;
    let skipped = revert(&tx, &u).map_err(e)?;
    tx.execute("UPDATE changes SET undone_at = ?2 WHERE id = ?1", params![id, db::now_ms()]).map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(Undone { summary, skipped })
}

fn revert(conn: &Connection, u: &Undo) -> DbResult<usize> {
    let mut skipped = 0;
    for l in u.links.iter().rev() {
        let now: Option<Option<String>> = conn
            .query_row("SELECT parent_id FROM items WHERE id = ?1", [&l.before.id], |r| r.get(0))
            .optional()?;
        // Left alone when it was linked again (or deleted) since.
        if now.as_ref() != Some(&l.after_parent) {
            skipped += 1;
            continue;
        }
        db::restore_links(conn, std::slice::from_ref(&l.before))?;
    }
    {
        let mut stmt = conn.prepare("UPDATE items SET adopted = ?2 WHERE id = ?1 AND adopted = ?3")?;
        for (item, before, after) in u.adopted.iter().rev() {
            if stmt.execute(params![item, before, after])? == 0 {
                skipped += 1;
            }
        }
    }
    for (texts, col) in [(&u.names, "name"), (&u.notes, "note")] {
        let mut stmt = conn.prepare(&format!("UPDATE items SET {col} = ?2 WHERE id = ?1 AND {col} = ?3"))?;
        for (item, before, after) in texts {
            if stmt.execute(params![item, before, after])? == 0 {
                skipped += 1;
            }
        }
    }
    for m in u.folder_moves.iter().rev() {
        if folder_of(conn, &m.item)?.map(|(f, _)| f) != m.after {
            skipped += 1;
            continue;
        }
        conn.execute("DELETE FROM item_folders WHERE item_id = ?1", [&m.item])?;
        if let Some((folder, position)) = &m.before {
            // The folder may have been deleted since: the item stays unfiled.
            let n = conn.execute(
                "INSERT OR IGNORE INTO item_folders (item_id, folder_id, position)
                 SELECT ?1, id, ?3 FROM folders WHERE id = ?2",
                params![m.item, folder, position],
            )?;
            skipped += usize::from(n == 0);
        }
    }
    {
        let mut stmt = conn.prepare(
            "INSERT OR IGNORE INTO item_tags (item_id, tag_id)
             SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM items WHERE id = ?1)
               AND EXISTS (SELECT 1 FROM tags WHERE id = ?2)",
        )?;
        for (item, tag) in &u.tags_removed {
            if stmt.execute(params![item, tag])? == 0 {
                skipped += 1;
            }
        }
    }
    {
        let mut stmt = conn.prepare("DELETE FROM item_tags WHERE item_id = ?1 AND tag_id = ?2")?;
        for (item, tag) in &u.tags_added {
            if stmt.execute(params![item, tag])? == 0 {
                skipped += 1;
            }
        }
    }
    for tag in &u.tags_created {
        conn.execute("DELETE FROM tags WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM item_tags WHERE tag_id = ?1)", [tag])?;
    }
    for folder in u.folders_created.iter().rev() {
        conn.execute(
            "DELETE FROM folders WHERE id = ?1
               AND NOT EXISTS (SELECT 1 FROM item_folders WHERE folder_id = ?1)
               AND NOT EXISTS (SELECT 1 FROM folders WHERE parent_id = ?1)",
            [folder],
        )?;
    }
    Ok(skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = db::open(std::path::Path::new(":memory:")).unwrap();
        for (id, name) in [("a", "a.jpg"), ("b", "b.jpg"), ("c", "c.jpg")] {
            conn.execute(
                "INSERT INTO items (id, name, file_name, ext, width, height, size, hash, thumb, imported_at)
                 VALUES (?1, ?2, ?2, 'jpg', 1, 1, 1, ?1, '', 0)",
                params![id, name],
            )
            .unwrap();
        }
        conn
    }

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn tags_of(conn: &Connection, item: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT t.name FROM item_tags x JOIN tags t ON t.id = x.tag_id WHERE x.item_id = ?1 ORDER BY t.name")
            .unwrap();
        stmt.query_map([item], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
    }

    fn folder_name(conn: &Connection, item: &str) -> Option<String> {
        conn.query_row(
            "SELECT f.name FROM item_folders x JOIN folders f ON f.id = x.folder_id WHERE x.item_id = ?1",
            [item],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
    }

    #[test]
    fn undoes_only_what_changed() {
        let mut conn = setup();
        db::add_tags(&mut conn, &ids(&["a"]), &["京都".into()]).unwrap();
        let mut u = Undo::default();
        assert_eq!(add_tag(&conn, &mut u, &ids(&["a", "b"]), "京都").unwrap(), 1, "a had it already");
        assert_eq!(add_tag(&conn, &mut u, &ids(&["b"]), "夏").unwrap(), 1);
        assert_eq!(remove_tag(&conn, &mut u, &ids(&["c"]), "京都").unwrap(), 0);
        let id = record(&conn, "mcp", "テスト", &u).unwrap();

        let done = undo(&mut conn, id).unwrap();
        assert_eq!(done, Undone { summary: "テスト".into(), skipped: 0 });
        assert_eq!(tags_of(&conn, "a"), ["京都"], "the tag a had before stays");
        assert!(tags_of(&conn, "b").is_empty());
        assert!(db::tag_id(&conn, "夏", db::Mode::Stock).unwrap().is_none(), "the tag it created is gone");
        assert!(db::tag_id(&conn, "京都", db::Mode::Stock).unwrap().is_some());
        assert!(undo(&mut conn, id).is_err(), "only once");
        assert!(list(&conn, 10).unwrap()[0].undone);
    }

    #[test]
    fn folders_go_back_and_created_ones_are_removed_when_empty() {
        let mut conn = setup();
        let old = db::create_folder(&conn, "old", None, db::Mode::Stock).unwrap();
        db::move_to_folder(&conn, &ids(&["a"]), &old).unwrap();
        let pos: Option<f64> = folder_of(&conn, "a").unwrap().unwrap().1;

        let mut u = Undo::default();
        let target = ensure_folder_path(&conn, &mut u, "写真/ 旅行 /京都", db::Mode::Stock).unwrap().unwrap();
        assert_eq!(u.folders_created.len(), 3);
        assert!(ensure_folder_path(&conn, &mut u, "写真/旅行", db::Mode::Stock).unwrap().is_some());
        assert_eq!(u.folders_created.len(), 3, "existing folders are reused");
        assert_eq!(move_to_folder(&conn, &mut u, &ids(&["a", "b"]), Some(&target)).unwrap(), 2);
        assert_eq!(move_to_folder(&conn, &mut u, &ids(&["a"]), Some(&target)).unwrap(), 0);
        let id = record(&conn, "mcp", "移動", &u).unwrap();

        undo(&mut conn, id).unwrap();
        assert_eq!(folder_name(&conn, "a").as_deref(), Some("old"));
        assert_eq!(folder_of(&conn, "a").unwrap().unwrap().1, pos, "back in its place");
        assert_eq!(folder_name(&conn, "b"), None);
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM folders", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 1, "only the old folder is left");
    }

    #[test]
    fn leaves_what_was_edited_again() {
        let mut conn = setup();
        let mut u = Undo::default();
        assert!(rename(&conn, &mut u, "a", "kyoto_01.jpg").unwrap());
        assert!(!rename(&conn, &mut u, "b", "b.jpg").unwrap());
        assert!(rename(&conn, &mut u, "c", "kyoto_02.jpg").unwrap());
        assert!(set_note(&conn, &mut u, "a", "メモ").unwrap());
        let mut keep = Undo::default();
        let f = ensure_folder_path(&conn, &mut keep, "F", db::Mode::Stock).unwrap();
        move_to_folder(&conn, &mut u, &ids(&["b"]), f.as_deref()).unwrap();
        let id = record(&conn, "mcp", "名前", &u).unwrap();

        // Edited by hand afterwards: c's name, b's folder.
        db::rename_item(&conn, "c", "手で変えた.jpg").unwrap();
        move_to_folder(&conn, &mut Undo::default(), &ids(&["b"]), None).unwrap();

        assert_eq!(undo(&mut conn, id).unwrap().skipped, 2);
        let name = |id: &str| -> String { conn.query_row("SELECT name FROM items WHERE id = ?1", [id], |r| r.get(0)).unwrap() };
        assert_eq!((name("a"), name("c")), ("a.jpg".into(), "手で変えた.jpg".into()));
        let note: String = conn.query_row("SELECT note FROM items WHERE id = 'a'", [], |r| r.get(0)).unwrap();
        assert_eq!(note, "");
    }

    #[test]
    fn keeps_the_latest_changes() {
        let conn = setup();
        for i in 0..(KEEP + 5) {
            record(&conn, "mcp", &format!("{i}"), &Undo::default()).unwrap();
        }
        let all = list(&conn, 1000).unwrap();
        assert_eq!(all.len() as i64, KEEP);
        assert_eq!(all[0].summary, format!("{}", KEEP + 4));
    }
}

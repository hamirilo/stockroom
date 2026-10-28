//! SQLite schema and queries. Everything here takes a plain `Connection`
//! so it can be unit-tested without Tauri.

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, ToSql, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::{search, similar};

pub type DbResult<T> = rusqlite::Result<T>;

const SCHEMA_VERSION: i32 = 26;

const SETTINGS_TABLE: &str = "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)";

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn open(path: &std::path::Path) -> DbResult<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;",
    )?;
    back_up_before_modes(&conn, path)?;
    migrate(&conn)?;
    Ok(conn)
}

/// A copy of library.db as it was before folders, tags and smart folders
/// were split between the modes (step 21, docs/MODES.md), next to it as
/// `library.before-modes.db`: the split rewrites what the user built up, so
/// it can be undone by hand. Only for an existing library, once.
fn back_up_before_modes(conn: &Connection, path: &std::path::Path) -> DbResult<()> {
    let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version == 0 || version >= 21 {
        return Ok(());
    }
    let backup = path.with_file_name("library.before-modes.db");
    if backup.exists() {
        return Ok(());
    }
    // A consistent copy of the whole database (the WAL included), outside any transaction.
    conn.execute("VACUUM INTO ?1", [backup.to_string_lossy()])?;
    Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> DbResult<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |r| r.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Adds a column unless it already exists. Returns whether it was added, so
/// one-time seeding can be skipped when a step runs again.
fn add_column(conn: &Connection, table: &str, column: &str, decl: &str) -> DbResult<bool> {
    if has_column(conn, table, column)? {
        return Ok(false);
    }
    conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))?;
    Ok(true)
}

/// Brings the schema up to `SCHEMA_VERSION`.
///
/// Every step is safe to run again: an older build of the app that opens a
/// newer library leaves the extra columns in place but may lower
/// `user_version`, so the steps check what exists instead of trusting the
/// number. Each step runs in its own transaction and records its version, and
/// the version is never lowered here.
pub fn migrate(conn: &Connection) -> DbResult<()> {
    let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let step = |target: i32, f: &dyn Fn(&Connection) -> DbResult<()>| -> DbResult<()> {
        if version >= target {
            return Ok(());
        }
        let tx = conn.unchecked_transaction()?; // rolled back on error (drop)
        f(&tx)?;
        tx.pragma_update(None, "user_version", target)?;
        tx.commit()
    };

    step(1, &|c| {
        c.execute_batch(
            "CREATE TABLE IF NOT EXISTS items (
               id          TEXT PRIMARY KEY,
               name        TEXT NOT NULL,
               file_name   TEXT NOT NULL,
               ext         TEXT NOT NULL,
               width       INTEGER NOT NULL,
               height      INTEGER NOT NULL,
               size        INTEGER NOT NULL,
               hash        TEXT NOT NULL,
               thumb       TEXT NOT NULL,
               note        TEXT NOT NULL DEFAULT '',
               imported_at INTEGER NOT NULL,
               deleted_at  INTEGER
             );
             CREATE INDEX IF NOT EXISTS idx_items_hash ON items(hash);
             CREATE INDEX IF NOT EXISTS idx_items_deleted ON items(deleted_at, imported_at);

             CREATE TABLE IF NOT EXISTS folders (
               id        TEXT PRIMARY KEY,
               parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
               name      TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

             CREATE TABLE IF NOT EXISTS item_folders (
               item_id   TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
               folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
               PRIMARY KEY (item_id, folder_id)
             );
             CREATE INDEX IF NOT EXISTS idx_item_folders_folder ON item_folders(folder_id);

             CREATE TABLE IF NOT EXISTS tags (
               id   INTEGER PRIMARY KEY,
               name TEXT NOT NULL UNIQUE COLLATE NOCASE
             );

             CREATE TABLE IF NOT EXISTS item_tags (
               item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
               tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
               PRIMARY KEY (item_id, tag_id)
             );
             CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag_id);",
        )
    })?;

    // Star ratings, and a per-folder position for manual ordering.
    step(2, &|c| {
        add_column(c, "items", "rating", "INTEGER NOT NULL DEFAULT 0")?;
        if add_column(c, "item_folders", "position", "REAL")? {
            c.execute_batch("UPDATE item_folders SET position = rowid")?;
        }
        Ok(())
    })?;

    // Perceptual hash for near-duplicate detection; NULL = not computed yet.
    // pcolor = average colour 0xRRGGBB (see similar.rs).
    step(3, &|c| {
        add_column(c, "items", "phash", "INTEGER")?;
        add_column(c, "items", "pcolor", "INTEGER")?;
        Ok(())
    })?;

    // - items.preview: JPEG display copy for formats the web view can't show.
    // - folders.sort_order: user-defined order among siblings (seeded A→Z).
    // - smart_folders: saved conditions (`rule` is a JSON-encoded `Rule`).
    step(4, &|c| {
        add_column(c, "items", "preview", "TEXT")?;
        if add_column(c, "folders", "sort_order", "REAL")? {
            c.execute_batch(
                "UPDATE folders SET sort_order = (
                   SELECT COUNT(*) FROM folders o
                   WHERE o.parent_id IS folders.parent_id
                     AND (o.name < folders.name COLLATE NOCASE
                          OR (o.name = folders.name COLLATE NOCASE AND o.id < folders.id)))",
            )?;
        }
        c.execute_batch(
            "CREATE TABLE IF NOT EXISTS smart_folders (
               id         TEXT PRIMARY KEY,
               name       TEXT NOT NULL,
               rule       TEXT NOT NULL,
               sort_order REAL NOT NULL
             )",
        )
    })?;
    // An item lives in at most one folder (tags are for cross-cutting groups).
    // Items that were in several keep the folder they were added to first.
    step(5, &|c| {
        c.execute_batch(
            "DELETE FROM item_folders
             WHERE rowid NOT IN (SELECT MIN(rowid) FROM item_folders GROUP BY item_id);
             CREATE UNIQUE INDEX IF NOT EXISTS idx_item_folders_item ON item_folders(item_id);",
        )
    })?;
    // Optional colour (a palette name, see `COLORS`) for folders, smart folders and tags.
    step(6, &|c| {
        add_column(c, "folders", "color", "TEXT")?;
        add_column(c, "smart_folders", "color", "TEXT")?;
        add_column(c, "tags", "color", "TEXT")?;
        Ok(())
    })?;
    // Groups of look-alikes the user marked "not duplicates", stored as pairs
    // (a < b) so a new look-alike can still be proposed with the old members.
    // `batch` identifies one dismiss action (one group).
    step(7, &|c| {
        c.execute_batch(
            "CREATE TABLE IF NOT EXISTS dismissed_pairs (
               a TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
               b TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
               batch TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               PRIMARY KEY (a, b)
             );
             CREATE INDEX IF NOT EXISTS dismissed_pairs_b ON dismissed_pairs(b);",
        )
    })?;
    // Favourites (a flag) and pinning (pinned items come first in every list;
    // the time is kept so the latest pin is at the top).
    step(8, &|c| {
        add_column(c, "items", "favorite", "INTEGER NOT NULL DEFAULT 0")?;
        add_column(c, "items", "pinned_at", "INTEGER")?;
        Ok(())
    })?;
    // Non-destructive rotate / flip (see orient.rs). width / height are the
    // displayed size, so they are swapped while the item is turned sideways.
    step(9, &|c| {
        add_column(c, "items", "rotation", "INTEGER NOT NULL DEFAULT 0")?;
        add_column(c, "items", "flipped", "INTEGER NOT NULL DEFAULT 0")?;
        Ok(())
    })?;
    // What the file is: 'image' or 'font' (fonts have no pixel size and no
    // perceptual hash).
    step(10, &|c| {
        add_column(c, "items", "kind", "TEXT NOT NULL DEFAULT 'image'")?;
        Ok(())
    })?;
    // The web page an item was saved from with the browser extension (webimport.rs).
    step(11, &|c| {
        add_column(c, "items", "source_url", "TEXT")?;
        Ok(())
    })?;
    // A font's family and weight (fonts.rs), to group the styles of a family.
    // NULL for images, and for fonts until `missing_font_names` fills them in.
    step(12, &|c| {
        add_column(c, "items", "font_family", "TEXT")?;
        add_column(c, "items", "font_weight", "INTEGER")?;
        Ok(())
    })?;
    // A font's writing system and typeface style (fonts.rs), for the sidebar's
    // filters. `font_category_user` is the user's correction, used over the
    // guess. NULL script = not read yet (also re-reads the family, which now
    // drops style words), see `missing_font_meta`.
    step(13, &|c| {
        add_column(c, "items", "font_script", "TEXT")?;
        add_column(c, "items", "font_category", "TEXT")?;
        add_column(c, "items", "font_category_user", "TEXT")?;
        Ok(())
    })?;
    // The shelf (シェルフ, once the work tray): items gathered for a while to be handled
    // together (contact sheet, export). `position` is the order they are in.
    step(14, &|c| {
        c.execute_batch(
            "CREATE TABLE IF NOT EXISTS tray (
               item_id  TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
               position REAL NOT NULL
             )",
        )
    })?;
    // Settings of this library (docs/SETTINGS.md): the kinds it is used
    // for, the mode it was left in, sidebar entries hidden. Values are JSON.
    step(15, &|c| c.execute_batch(SETTINGS_TABLE))?;
    // Changes made from outside the UI (Claude through MCP, see changes.rs),
    // with what is needed to undo them. Both were step 15 on their own
    // branches, so a library opened by a build of either has 15 already:
    // the settings table is made here too when missing.
    step(16, &|c| {
        c.execute_batch(SETTINGS_TABLE)?;
        c.execute_batch(
            "CREATE TABLE IF NOT EXISTS changes (
               id        INTEGER PRIMARY KEY,
               at        INTEGER NOT NULL,
               source    TEXT NOT NULL,
               summary   TEXT NOT NULL,
               undo      TEXT NOT NULL,
               undone_at INTEGER
             )",
        )
    })?;
    // Tag ids are never reused (AUTOINCREMENT): undo records (changes.rs) and
    // smart-folder rules keep bare tag ids, and a new tag taking a deleted
    // one's id would be stripped by an old undo or match an old rule. SQLite
    // can't add AUTOINCREMENT to a table, so tags and item_tags are made
    // again. The old ones are renamed away first: dropping `tags` while
    // item_tags points at it would cascade-delete every tagging.
    step(17, &|c| {
        let sql: String = c.query_row("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tags'", [], |r| r.get(0))?;
        if sql.to_ascii_uppercase().contains("AUTOINCREMENT") {
            return Ok(());
        }
        c.execute_batch(
            "ALTER TABLE item_tags RENAME TO item_tags_old;
             ALTER TABLE tags RENAME TO tags_old;
             DROP INDEX IF EXISTS idx_item_tags_tag;
             CREATE TABLE tags (
               id    INTEGER PRIMARY KEY AUTOINCREMENT,
               name  TEXT NOT NULL UNIQUE COLLATE NOCASE,
               color TEXT
             );
             CREATE TABLE item_tags (
               item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
               tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
               PRIMARY KEY (item_id, tag_id)
             );
             INSERT INTO tags (id, name, color) SELECT id, name, color FROM tags_old;
             INSERT INTO item_tags (item_id, tag_id) SELECT item_id, tag_id FROM item_tags_old;
             DROP TABLE item_tags_old;
             DROP TABLE tags_old;
             CREATE INDEX idx_item_tags_tag ON item_tags(tag_id);",
        )
    })?;
    // A font's weight range (the `wght` axis of a variable font) and features
    // (fonts.rs `FEATURES`, comma-separated), for the sidebar's 太さ and 特徴.
    // NULL features = not read yet, see `missing_font_meta`, which also
    // re-guesses the style: 等幅 became a feature, and 筆・手書き was split.
    step(18, &|c| {
        add_column(c, "items", "font_weight_min", "INTEGER")?;
        add_column(c, "items", "font_weight_max", "INTEGER")?;
        add_column(c, "items", "font_features", "TEXT")?;
        c.execute("UPDATE items SET font_category = NULL WHERE font_category = 'mono'", [])?;
        c.execute("UPDATE items SET font_category_user = NULL WHERE font_category_user = 'mono'", [])?;
        Ok(())
    })?;
    // Folders shared read-only on the local network (share.rs): the secret in
    // the folder's URL, and whether its files may be downloaded.
    step(19, &|c| {
        c.execute_batch(
            "CREATE TABLE IF NOT EXISTS shares (
               folder_id  TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
               token      TEXT NOT NULL UNIQUE,
               download   INTEGER NOT NULL DEFAULT 1,
               created_at INTEGER NOT NULL
             )",
        )
    })?;
    // Fonts of different widths are families of their own (fonts.rs `with_width`):
    // read them again (NULL features = not read yet, see `missing_font_meta`).
    step(20, &|c| {
        c.execute("UPDATE items SET font_features = NULL WHERE kind = 'font'", [])?;
        Ok(())
    })?;
    // Folders, tags and smart folders belong to a mode (docs/MODES.md): the
    // stock (images, files) or the fonts. Tags of the two modes may share a
    // name, so the table is made again with UNIQUE (name, mode), the way step
    // 17 does it (keeping ids and the AUTOINCREMENT sequence). Then what holds
    // both kinds is split, see `split_modes`.
    step(21, &|c| {
        add_column(c, "folders", "mode", "TEXT NOT NULL DEFAULT 'stock'")?;
        add_column(c, "smart_folders", "mode", "TEXT NOT NULL DEFAULT 'stock'")?;
        if !has_column(c, "tags", "mode")? {
            let seq: Option<i64> = c
                .query_row("SELECT seq FROM sqlite_sequence WHERE name = 'tags'", [], |r| r.get(0))
                .optional()?;
            c.execute_batch(
                "ALTER TABLE item_tags RENAME TO item_tags_old;
                 ALTER TABLE tags RENAME TO tags_old;
                 DROP INDEX IF EXISTS idx_item_tags_tag;
                 CREATE TABLE tags (
                   id    INTEGER PRIMARY KEY AUTOINCREMENT,
                   name  TEXT NOT NULL COLLATE NOCASE,
                   color TEXT,
                   mode  TEXT NOT NULL DEFAULT 'stock',
                   UNIQUE (name, mode)
                 );
                 CREATE TABLE item_tags (
                   item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                   tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                   PRIMARY KEY (item_id, tag_id)
                 );
                 INSERT INTO tags (id, name, color) SELECT id, name, color FROM tags_old;
                 INSERT INTO item_tags (item_id, tag_id) SELECT item_id, tag_id FROM item_tags_old;
                 DROP TABLE item_tags_old;
                 DROP TABLE tags_old;
                 CREATE INDEX idx_item_tags_tag ON item_tags(tag_id);",
            )?;
            // Ids of tags deleted before stay unused (see step 17).
            if let Some(seq) = seq {
                c.execute("UPDATE sqlite_sequence SET seq = MAX(seq, ?1) WHERE name = 'tags'", [seq])?;
                c.execute(
                    "INSERT INTO sqlite_sequence (name, seq) SELECT 'tags', ?1
                     WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'tags')",
                    [seq],
                )?;
            }
        }
        split_modes(c)
    })?;
    // Texts (texts/mod.rs): what the search box looks in besides the name.
    step(22, &|c| {
        add_column(c, "items", "body", "TEXT")?;
        Ok(())
    })?;
    // Fonts installed on this computer (docs/SYSTEM_FONTS.md): a font's
    // PostScript name tells the same font in the library and installed (read
    // again for fonts imported before: NULL features = not read yet, see
    // `missing_font_meta`), and installed fonts go on the font shelf too, in
    // the same order as the library's (`position` shared with `tray`). They
    // aren't items: `id` is fonts/system.rs's, `name` is for when this computer
    // doesn't have the font.
    step(23, &|c| {
        if add_column(c, "items", "font_ps_name", "TEXT")? {
            c.execute("UPDATE items SET font_features = NULL WHERE kind = 'font'", [])?;
        }
        c.execute_batch(
            "CREATE TABLE IF NOT EXISTS tray_system (
               id       TEXT PRIMARY KEY,
               name     TEXT NOT NULL,
               position REAL NOT NULL
             )",
        )
    })?;
    // Videos (videos/mod.rs): the length in milliseconds (NULL = not known).
    step(24, &|c| {
        add_column(c, "items", "duration_ms", "INTEGER")?;
        Ok(())
    })?;
    // Parent–child links (docs/LINKS.md): a child names its parent (one level,
    // one parent). Deleting the parent for good frees the children.
    step(25, &|c| {
        add_column(c, "items", "parent_id", "TEXT REFERENCES items(id) ON DELETE SET NULL")?;
        c.execute_batch("CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id)")
    })?;
    // The child among a parent's children that was picked (docs/LINKS.md: 採用).
    step(26, &|c| {
        add_column(c, "items", "adopted", "INTEGER NOT NULL DEFAULT 0")?;
        Ok(())
    })?;
    // New steps go above; the last one must be SCHEMA_VERSION.
    debug_assert!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i32>(0))? >= SCHEMA_VERSION,
        "add a migrate() step for SCHEMA_VERSION"
    );
    Ok(())
}

// ---------------------------------------------------------------- items

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    #[default]
    Image,
    Font,
    /// PDF and office documents (files/mod.rs).
    File,
    /// Markdown, plain text, CSV / TSV (texts/mod.rs).
    Text,
    /// MP4 / MOV / WebM (videos/mod.rs).
    Video,
    /// A URL, kept as an internet shortcut (bookmarks/mod.rs).
    Bookmark,
}

impl Kind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Kind::Image => "image",
            Kind::Font => "font",
            Kind::File => "file",
            Kind::Text => "text",
            Kind::Video => "video",
            Kind::Bookmark => "bookmark",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "font" => Kind::Font,
            "file" => Kind::File,
            "text" => Kind::Text,
            "video" => Kind::Video,
            "bookmark" => Kind::Bookmark,
            _ => Kind::Image,
        }
    }
}

/// What the app shows (docs/MODES.md): the stock (images and files) or the
/// fonts. Folders, tags and smart folders belong to one, and hold only items
/// of its kinds.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    #[default]
    Stock,
    Font,
}

impl Mode {
    pub fn of(kind: Kind) -> Self {
        if kind == Kind::Font {
            Mode::Font
        } else {
            Mode::Stock
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Mode::Stock => "stock",
            Mode::Font => "font",
        }
    }

    fn parse(s: &str) -> Self {
        if s == "font" {
            Mode::Font
        } else {
            Mode::Stock
        }
    }

    pub const ALL: [Mode; 2] = [Mode::Stock, Mode::Font];
}

/// SQL fragment keeping items of `mode` (any when None), with the mode as the
/// argument `?n`. `t` is the alias of the items table.
fn mode_where(mode: Option<Mode>, n: usize, t: &str) -> (String, Box<dyn ToSql>) {
    (
        format!("(?{n} IS NULL OR ({t}.kind = 'font') = (?{n} = 'font'))"),
        Box::new(mode.map(Mode::as_str)),
    )
}

/// The modes of the items `ids`, each with its items (in the given order).
pub(crate) fn by_mode(conn: &Connection, ids: &[String]) -> DbResult<Vec<(Mode, Vec<String>)>> {
    let mut stmt = conn.prepare_cached("SELECT kind FROM items WHERE id = ?1")?;
    let mut out: Vec<(Mode, Vec<String>)> = Vec::new();
    for id in ids {
        let Some(kind) = stmt.query_row([id], |r| r.get::<_, String>(0)).optional()? else { continue };
        let mode = Mode::of(Kind::parse(&kind));
        match out.iter_mut().find(|(m, _)| *m == mode) {
            Some((_, v)) => v.push(id.clone()),
            None => out.push((mode, vec![id.clone()])),
        }
    }
    Ok(out)
}

/// The mode of an item, if it exists.
pub fn item_mode(conn: &Connection, id: &str) -> DbResult<Option<Mode>> {
    Ok(conn
        .query_row("SELECT kind FROM items WHERE id = ?1", [id], |r| r.get::<_, String>(0))
        .optional()?
        .map(|k| Mode::of(Kind::parse(&k))))
}

/// The mode of a folder, if it exists.
pub fn folder_mode(conn: &Connection, id: &str) -> DbResult<Option<Mode>> {
    Ok(conn
        .query_row("SELECT mode FROM folders WHERE id = ?1", [id], |r| r.get::<_, String>(0))
        .optional()?
        .map(|m| Mode::parse(&m)))
}

/// Splits what holds items of both modes (step 21, docs/MODES.md), losing
/// nothing:
/// - A folder whose items (its subfolders' included) are all fonts becomes a
///   font folder; else it stays in the stock. One with both gets a font twin
///   (same name, colour and order, under its parent's font twin) that takes
///   its fonts. An empty folder follows its parent (the stock at the top).
/// - A tag on fonts only becomes a font tag; one on both gets a font twin
///   with the same name and colour that takes the fonts.
/// - A smart folder for fonts only (its kinds) becomes a font one; one that
///   can match both (no kinds, or fonts and others) gets a font twin, with
///   its tags moved to their font twins. One with no kinds gets the twin
///   only when it matches fonts now.
///
/// Safe to run again: twins already made are found by name.
fn split_modes(c: &Connection) -> DbResult<()> {
    let new_id = || uuid::Uuid::new_v4().simple().to_string();

    // ---- folders
    type Row = (String, Option<String>, String, Option<String>, Option<f64>);
    let folders: Vec<Row> = {
        let mut stmt = c.prepare("SELECT id, parent_id, name, color, sort_order FROM folders")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
        rows.collect::<DbResult<_>>()?
    };
    // Folder -> (has fonts, has others), its own items first.
    let mut kinds: HashMap<String, (bool, bool)> = {
        let mut stmt = c.prepare(
            "SELECT x.folder_id, MAX(i.kind = 'font'), MAX(i.kind <> 'font')
             FROM item_folders x JOIN items i ON i.id = x.item_id GROUP BY x.folder_id",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?;
        rows.collect::<DbResult<_>>()?
    };
    let known: HashSet<&str> = folders.iter().map(|f| f.0.as_str()).collect();
    let mut children: HashMap<Option<String>, Vec<&Row>> = HashMap::new();
    for f in &folders {
        // A parent that is gone (a damaged database) counts as the top.
        let parent = f.1.clone().filter(|p| known.contains(p.as_str()));
        children.entry(parent).or_default().push(f);
    }
    // Subfolders' items count for their parents.
    fn subtree(id: &str, children: &HashMap<Option<String>, Vec<&Row>>, kinds: &mut HashMap<String, (bool, bool)>, depth: usize) -> (bool, bool) {
        let mut acc = kinds.get(id).copied().unwrap_or_default();
        if depth < 64 {
            for ch in children.get(&Some(id.to_owned())).map(Vec::as_slice).unwrap_or_default() {
                let (f, o) = subtree(&ch.0, children, kinds, depth + 1);
                acc = (acc.0 || f, acc.1 || o);
            }
        }
        kinds.insert(id.to_owned(), acc);
        acc
    }
    for f in children.get(&None).cloned().unwrap_or_default() {
        subtree(&f.0, &children, &mut kinds, 0);
    }
    // Top down: each folder under its parent's version of its own mode.
    let mut stack: Vec<(&Row, HashMap<Mode, Option<String>>)> = children
        .get(&None)
        .map(|v| v.iter().map(|f| (*f, HashMap::from([(Mode::Stock, None), (Mode::Font, None)]))).collect())
        .unwrap_or_default();
    while let Some((f, parents)) = stack.pop() {
        let (id, _, name, color, order) = f;
        let (font, other) = kinds.get(id).copied().unwrap_or_default();
        let mut modes = vec![];
        if other || (!font && parents.contains_key(&Mode::Stock)) {
            modes.push(Mode::Stock);
        }
        if font || modes.is_empty() {
            modes.push(Mode::Font);
        }
        let mut versions: HashMap<Mode, Option<String>> = HashMap::new();
        let main = modes[0];
        c.execute(
            "UPDATE folders SET mode = ?2, parent_id = ?3 WHERE id = ?1",
            params![id, main.as_str(), parents.get(&main).cloned().flatten()],
        )?;
        versions.insert(main, Some(id.clone()));
        if let Some(&twin_mode) = modes.get(1) {
            let parent = &parents.get(&twin_mode).cloned().flatten();
            let twin: String = match c
                .query_row(
                    "SELECT id FROM folders WHERE name = ?1 AND parent_id IS ?2 AND mode = ?3 AND id <> ?4",
                    params![name, parent, twin_mode.as_str(), id],
                    |r| r.get(0),
                )
                .optional()?
            {
                Some(t) => t,
                None => {
                    let t = new_id();
                    c.execute(
                        "INSERT INTO folders (id, parent_id, name, color, sort_order, mode) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![t, parent, name, color, order, twin_mode.as_str()],
                    )?;
                    t
                }
            };
            c.execute(
                "UPDATE item_folders SET folder_id = ?2
                 WHERE folder_id = ?1 AND item_id IN (SELECT id FROM items WHERE kind = 'font')",
                params![id, twin],
            )?;
            versions.insert(twin_mode, Some(twin));
        }
        for ch in children.get(&Some(id.clone())).map(Vec::as_slice).unwrap_or_default() {
            stack.push((*ch, versions.clone()));
        }
    }

    // ---- tags
    let tags: Vec<(i64, String, Option<String>, bool, bool)> = {
        let mut stmt = c.prepare(
            "SELECT t.id, t.name, t.color,
               EXISTS (SELECT 1 FROM item_tags x JOIN items i ON i.id = x.item_id WHERE x.tag_id = t.id AND i.kind = 'font'),
               EXISTS (SELECT 1 FROM item_tags x JOIN items i ON i.id = x.item_id WHERE x.tag_id = t.id AND i.kind <> 'font')
             FROM tags t WHERE t.mode = 'stock'",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
        rows.collect::<DbResult<_>>()?
    };
    // Stock tag -> its font version.
    let mut font_tag: HashMap<i64, i64> = HashMap::new();
    for (id, name, color, font, other) in tags {
        if !font {
            continue;
        }
        let existing: Option<i64> = c
            .query_row("SELECT id FROM tags WHERE name = ?1 AND mode = 'font'", [&name], |r| r.get(0))
            .optional()?;
        if !other && existing.is_none() {
            c.execute("UPDATE tags SET mode = 'font' WHERE id = ?1", [id])?;
            font_tag.insert(id, id);
            continue;
        }
        let twin = match existing {
            Some(t) => t,
            None => {
                c.execute("INSERT INTO tags (name, color, mode) VALUES (?1, ?2, 'font')", params![name, color])?;
                c.last_insert_rowid()
            }
        };
        c.execute(
            "INSERT OR IGNORE INTO item_tags (item_id, tag_id)
             SELECT x.item_id, ?2 FROM item_tags x JOIN items i ON i.id = x.item_id
             WHERE x.tag_id = ?1 AND i.kind = 'font'",
            params![id, twin],
        )?;
        c.execute(
            "DELETE FROM item_tags WHERE tag_id = ?1 AND item_id IN (SELECT id FROM items WHERE kind = 'font')",
            [id],
        )?;
        if other {
            font_tag.insert(id, twin);
        } else {
            // Its fonts went to a font tag of the same name from an earlier run.
            c.execute("DELETE FROM tags WHERE id = ?1", [id])?;
            merge_rule_tag(c, id, twin)?;
            font_tag.insert(id, twin);
        }
    }

    // ---- smart folders
    let smart: Vec<(String, String, String, Option<String>, f64)> = {
        let mut stmt = c.prepare("SELECT id, name, rule, color, sort_order FROM smart_folders WHERE mode = 'stock'")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
        rows.collect::<DbResult<_>>()?
    };
    for (id, name, json, color, order) in smart {
        let Ok(rule) = serde_json::from_str::<Rule>(&json) else { continue };
        let kinds = &rule.filter.kinds;
        let font = kinds.is_empty() || kinds.contains(&Kind::Font);
        let other = kinds.is_empty() || kinds.iter().any(|k| *k != Kind::Font);
        if !font {
            continue;
        }
        // The font version: its tags' font twins, and the fonts of its kinds.
        let mut font_rule = rule.clone();
        font_rule.tag_ids = rule.tag_ids.iter().map(|t| font_tag.get(t).copied().unwrap_or(*t)).collect();
        if !kinds.is_empty() {
            font_rule.filter.kinds = vec![Kind::Font];
        }
        // The JSON is edited in place where it stays, so fields this build doesn't know are kept.
        let edit = |rule: &Rule| -> String {
            let mut v: serde_json::Value = serde_json::from_str(&json).unwrap_or_default();
            if let Some(o) = v.as_object_mut() {
                o.insert("tagIds".into(), serde_json::json!(rule.tag_ids));
                if let Some(f) = o.get_mut("filter").and_then(|f| f.as_object_mut()) {
                    f.insert("kinds".into(), serde_json::json!(rule.filter.kinds));
                }
            }
            v.to_string()
        };
        if !other {
            c.execute(
                "UPDATE smart_folders SET mode = 'font', rule = ?2 WHERE id = ?1",
                params![id, edit(&font_rule)],
            )?;
            continue;
        }
        if kinds.is_empty() && count_rule(c, &font_rule, Some(Mode::Font))? == 0 {
            continue;
        }
        let exists = c
            .query_row("SELECT 1 FROM smart_folders WHERE name = ?1 AND mode = 'font'", [&name], |_| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            c.execute(
                "INSERT INTO smart_folders (id, name, rule, color, sort_order, mode) VALUES (?1, ?2, ?3, ?4, ?5, 'font')",
                params![new_id(), name, edit(&font_rule), color, order],
            )?;
        }
        if !kinds.is_empty() {
            let mut stock_rule = rule.clone();
            stock_rule.filter.kinds.retain(|k| *k != Kind::Font);
            c.execute("UPDATE smart_folders SET rule = ?2 WHERE id = ?1", params![id, edit(&stock_rule)])?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub kind: Kind,
    pub name: String,
    pub file_name: String,
    pub ext: String,
    /// Displayed size (after rotation), see `rotation`.
    pub width: u32,
    pub height: u32,
    pub size: i64,
    pub thumb: String,
    pub note: String,
    pub rating: u8,
    pub imported_at: i64,
    pub deleted_at: Option<i64>,
    /// File name in `previews/` of a JPEG display copy, if the original
    /// format can't be shown by the web view.
    pub preview: Option<String>,
    pub favorite: bool,
    /// When the item was pinned to the top of lists; None = not pinned.
    pub pinned_at: Option<i64>,
    /// Clockwise quarter turns (0..=3), applied after `flipped` (see orient.rs).
    pub rotation: u8,
    /// Mirrored horizontally (before rotating).
    pub flipped: bool,
    /// The folder the item is in (an item is in one at most).
    pub folder_id: Option<String>,
    pub tag_ids: Vec<i64>,
    /// The web page the item was saved from (browser extension).
    pub source_url: Option<String>,
    /// Fonts: the family (shared by its styles) and weight (100-900) of the
    /// first font in the file.
    pub font_family: Option<String>,
    pub font_weight: Option<u32>,
    /// Fonts: writing system ("ja", "latin", ...), see `fonts::SCRIPTS`.
    pub font_script: Option<String>,
    /// Fonts: typeface style guessed from the font (None = can't tell) and the
    /// user's correction, which wins. See `fonts::CATEGORIES`.
    pub font_category: Option<String>,
    pub font_category_user: Option<String>,
    /// Fonts: features ("mono", "coding", ...), see `fonts::FEATURES`. Empty until read.
    pub font_features: Vec<String>,
    /// Fonts: PostScript name of the first font (None until read, or when it has none).
    pub font_ps_name: Option<String>,
    /// Videos: the length in milliseconds (None = not known).
    pub duration_ms: Option<i64>,
    /// On the shelf (シェルフ; the `tray` table).
    pub in_tray: bool,
    /// The item this one is linked to as a child (docs/LINKS.md); None = not a child.
    pub parent_id: Option<String>,
    /// The child picked among its parent's children (採用); at most one per parent.
    pub adopted: bool,
    /// A parent that a list holds only because a child of it matches (`ItemQuery::with_parents`).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub via_child: bool,
    /// Similar view only: which group of look-alikes the item belongs to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<u32>,
    /// Similar view only: how many of the 64 hash bits differ from the best
    /// copy of the group (0 for the best copy itself).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distance: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct NewItem {
    pub id: String,
    pub kind: Kind,
    pub name: String,
    pub file_name: String,
    pub ext: String,
    pub width: u32,
    pub height: u32,
    pub size: i64,
    pub hash: String,
    pub thumb: String,
    /// Perceptual hash and average colour (see similar.rs).
    pub phash: Option<(u64, u32)>,
    pub preview: Option<String>,
    /// Fonts: family, weight, script and style (see `Item::font_family`).
    pub font: Option<crate::fonts::FontMeta>,
    /// Texts: what the search box looks in (texts/mod.rs `body`).
    pub body: Option<String>,
    /// Videos: the length in milliseconds.
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum View {
    #[default]
    All,
    Unfiled,
    Untagged,
    Trash,
    Folder { id: String },
    /// Groups of images that look alike (likely duplicates).
    Similar,
    Favorites,
    Pinned,
    /// The shelf (シェルフ; the `tray` table). The app only queries it for the shelf under the list.
    Tray,
    /// Items matching a smart folder's saved rule.
    Smart { id: String },
    /// Items carrying a tag: the sidebar's tags are places like folders (docs/NAVIGATION.md).
    Tag { id: i64 },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Shape {
    Landscape,
    Portrait,
    Square,
}

/// Attribute filters (the filter bar). Empty / None = no restriction.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Filter {
    /// Any of these kinds (the toolbar's kind filter in "すべて", or the font mode).
    pub kinds: Vec<Kind>,
    /// Fonts of any of these writing systems / typeface styles (the sidebar,
    /// under "フォント"). "none" = style unknown. Either one limits the list to fonts.
    pub font_scripts: Vec<String>,
    pub font_categories: Vec<String>,
    /// Fonts of any of these weight ranges (`FONT_WEIGHTS`) / with any of
    /// these features (`fonts::FEATURES`). Either one limits the list to fonts.
    pub font_weights: Vec<String>,
    pub font_features: Vec<String>,
    /// File types, e.g. "jpg" (also matches .jpeg), "png".
    pub exts: Vec<String>,
    /// Any of these shapes. Square = sides within 5% of each other.
    pub shapes: Vec<Shape>,
    pub min_width: Option<u32>,
    pub max_width: Option<u32>,
    pub min_height: Option<u32>,
    pub max_height: Option<u32>,
    /// Import time range in ms; `after` inclusive, `before` exclusive.
    pub imported_after: Option<i64>,
    pub imported_before: Option<i64>,
    /// File size range in bytes (inclusive).
    pub min_size: Option<i64>,
    pub max_size: Option<i64>,
    /// Only parents (docs/LINKS.md): items with children, live ones with live
    /// children and, in the trash, trashed ones with trashed children. The live
    /// children of live parents stay too, to be folded under them (▸).
    pub parents_only: bool,
}

/// A parent: an item with a child in the same place (both live, or both in the trash).
const HAS_CHILDREN: &str = "EXISTS (SELECT 1 FROM items c WHERE c.parent_id = items.id
     AND (c.deleted_at IS NULL) = (items.deleted_at IS NULL))";

/// A live child of a live parent: listed under it.
const CHILD_OF_LIVE: &str = "(items.deleted_at IS NULL AND EXISTS (SELECT 1 FROM items p
     WHERE p.id = items.parent_id AND p.deleted_at IS NULL))";

/// A set of conditions. Ad-hoc queries are built from the toolbar state;
/// smart folders store one as JSON.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Rule {
    pub search: String,
    pub tag_ids: Vec<i64>,
    pub tag_match_all: bool,
    pub min_rating: u8,
    pub filter: Filter,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortKey {
    #[default]
    ImportedAt,
    Name,
    Size,
    /// Pixel count (width × height).
    Dimensions,
    Rating,
    /// User-defined order inside a folder; other views fall back to import order.
    Manual,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemQuery {
    pub view: View,
    #[serde(default)]
    pub search: String,
    #[serde(default)]
    pub tag_ids: Vec<i64>,
    /// `tag_ids` must all be present (AND); otherwise any one of them (OR).
    #[serde(default)]
    pub tag_match_all: bool,
    /// Folder view also shows items of all subfolders.
    #[serde(default)]
    pub include_subfolders: bool,
    #[serde(default)]
    pub min_rating: u8,
    #[serde(default)]
    pub filter: Filter,
    /// Similar view only: how alike images must be.
    #[serde(default)]
    pub similar_level: similar::Level,
    /// With links on, a child that matches brings its parent into the list (`via_child`)
    /// even when the parent doesn't match itself. Only the list on screen asks for it.
    #[serde(default)]
    pub with_parents: bool,
    pub sort: SortKey,
    pub desc: bool,
}

impl ItemQuery {
    fn rule(&self) -> Rule {
        Rule {
            search: self.search.clone(),
            tag_ids: self.tag_ids.clone(),
            tag_match_all: self.tag_match_all,
            min_rating: self.min_rating,
            filter: self.filter.clone(),
        }
    }
}

const ITEM_COLS: &str = "items.id, items.name, items.file_name, items.ext, items.width, items.height, \
     items.size, items.thumb, items.note, items.rating, items.imported_at, items.deleted_at, items.preview, \
     items.favorite, items.pinned_at, \
     (SELECT folder_id FROM item_folders WHERE item_id = items.id LIMIT 1), \
     (SELECT group_concat(tag_id) FROM item_tags WHERE item_id = items.id), \
     items.rotation, items.flipped, items.kind, items.source_url, items.font_family, items.font_weight, \
     items.font_script, items.font_category, items.font_category_user, \
     EXISTS (SELECT 1 FROM tray WHERE tray.item_id = items.id), items.font_features, items.font_ps_name, \
     items.duration_ms, items.parent_id, items.adopted";

fn row_to_item(r: &rusqlite::Row) -> DbResult<Item> {
    let tag_ids: Option<String> = r.get(16)?;
    Ok(Item {
        id: r.get(0)?,
        kind: Kind::parse(&r.get::<_, String>(19)?),
        name: r.get(1)?,
        file_name: r.get(2)?,
        ext: r.get(3)?,
        width: r.get(4)?,
        height: r.get(5)?,
        size: r.get(6)?,
        thumb: r.get(7)?,
        note: r.get(8)?,
        rating: r.get(9)?,
        imported_at: r.get(10)?,
        deleted_at: r.get(11)?,
        preview: r.get(12)?,
        favorite: r.get::<_, i64>(13)? != 0,
        pinned_at: r.get(14)?,
        rotation: r.get(17)?,
        flipped: r.get::<_, i64>(18)? != 0,
        folder_id: r.get(15)?,
        tag_ids: tag_ids
            .map(|s| s.split(',').filter_map(|t| t.parse().ok()).collect())
            .unwrap_or_default(),
        source_url: r.get(20)?,
        font_family: r.get(21)?,
        font_weight: r.get(22)?,
        font_script: r.get(23)?,
        font_category: r.get(24)?,
        font_category_user: r.get(25)?,
        in_tray: r.get(26)?,
        font_features: r
            .get::<_, Option<String>>(27)?
            .map(|s| s.split(',').filter(|f| !f.is_empty()).map(str::to_string).collect())
            .unwrap_or_default(),
        font_ps_name: r.get::<_, Option<String>>(28)?.filter(|s| !s.is_empty()),
        duration_ms: r.get(29)?,
        parent_id: r.get(30)?,
        adopted: r.get::<_, i64>(31)? != 0,
        via_child: false,
        group: None,
        distance: None,
    })
}

fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('%');
    for c in s.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}

/// `IN` over a list of item ids of any length, bound as one JSON array
/// parameter (`ids_param`): SQLite takes at most 32766 parameters, and "select
/// all" on a large library or emptying a large trash goes past that.
const IN_IDS: &str = "IN (SELECT value FROM json_each(?))";

fn ids_param(ids: &[String]) -> String {
    serde_json::to_string(ids).unwrap_or_default()
}

/// Spellings that count as the same file type.
fn ext_aliases(ext: &str) -> Vec<String> {
    let e = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    match e.as_str() {
        "jpg" | "jpeg" => vec!["jpg".into(), "jpeg".into()],
        "tif" | "tiff" => vec!["tif".into(), "tiff".into()],
        "heic" | "heif" => vec!["heic".into(), "heif".into()],
        _ => vec![e],
    }
}

/// Canonical name of a file type for display / filters ("jpeg" -> "jpg").
pub fn canonical_ext(ext: &str) -> String {
    ext_aliases(ext).swap_remove(0)
}

/// A font's typeface style as filtered and counted: the user's, else the guess, else "none".
const FONT_CATEGORY: &str = "COALESCE(items.font_category_user, items.font_category, 'none')";
/// The weights a font covers; fonts read before the range was stored have their one weight.
const FONT_WEIGHT_MIN: &str = "COALESCE(items.font_weight_min, items.font_weight)";
const FONT_WEIGHT_MAX: &str = "COALESCE(items.font_weight_max, items.font_weight)";

/// Weight ranges of the sidebar's 太さ: 細い, 標準, 太い, 極太 (CSS weights, inclusive).
pub const FONT_WEIGHTS: &[(&str, u32, u32)] = &[("light", 1, 399), ("regular", 400, 549), ("bold", 550, 749), ("black", 750, 9999)];

/// SQL: the font's weight range overlaps the named one (false for unknown names).
fn font_weight_where(key: &str) -> String {
    match FONT_WEIGHTS.iter().find(|(k, _, _)| *k == key) {
        Some((_, lo, hi)) => format!("({FONT_WEIGHT_MIN} <= {hi} AND {FONT_WEIGHT_MAX} >= {lo})"),
        None => "0".into(),
    }
}

/// SQL: the font has the feature (an argument `?`, matched as a whole word).
const FONT_FEATURE_WHERE: &str = "instr(',' || IFNULL(items.font_features, '') || ',', ',' || ? || ',') > 0";

/// Adds the WHERE clauses for `rule`.
/// Each shape as SQL on `items` (images only; square = sides within 5%).
const SHAPE_SQL: [(&str, &str); 3] = [
    ("landscape", "items.width > items.height * 1.05"),
    ("portrait", "items.height > items.width * 1.05"),
    ("square", "(items.width <= items.height * 1.05 AND items.height <= items.width * 1.05)"),
];

fn push_rule(rule: &Rule, wheres: &mut Vec<String>, args: &mut Vec<Box<dyn ToSql>>) {
    if let Some(expr) = search::parse(&rule.search) {
        let sql = search::to_sql(&expr, &mut |word| {
            let pat = escape_like(word);
            for _ in 0..4 {
                args.push(Box::new(pat.clone()));
            }
            args.push(Box::new(pat));
            "(items.name LIKE ? ESCAPE '\\' OR items.note LIKE ? ESCAPE '\\' OR IFNULL(items.font_family, '') LIKE ? ESCAPE '\\'
               OR IFNULL(items.body, '') LIKE ? ESCAPE '\\' OR EXISTS (
               SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id
               WHERE it.item_id = items.id AND t.name LIKE ? ESCAPE '\\'))"
                .into()
        });
        wheres.push(sql);
    }

    if rule.min_rating > 0 {
        wheres.push("items.rating >= ?".into());
        args.push(Box::new(rule.min_rating));
    }

    if !rule.tag_ids.is_empty() {
        let marks = placeholders(rule.tag_ids.len());
        // AND: the item carries every selected tag; OR: at least one of them.
        let need = if rule.tag_match_all { rule.tag_ids.len() } else { 1 };
        wheres.push(format!(
            "(SELECT COUNT(*) FROM item_tags t WHERE t.item_id = items.id AND t.tag_id IN ({marks})) >= {need}"
        ));
        for tag_id in &rule.tag_ids {
            args.push(Box::new(*tag_id));
        }
    }

    let f = &rule.filter;
    if !f.kinds.is_empty() {
        wheres.push(format!("items.kind IN ({})", placeholders(f.kinds.len())));
        args.extend(f.kinds.iter().map(|k| Box::new(k.as_str()) as Box<dyn ToSql>));
    }
    if !f.font_scripts.is_empty() {
        wheres.push(format!("(items.kind = 'font' AND items.font_script IN ({}))", placeholders(f.font_scripts.len())));
        args.extend(f.font_scripts.iter().map(|v| Box::new(v.clone()) as Box<dyn ToSql>));
    }
    if !f.font_categories.is_empty() {
        wheres.push(format!(
            "(items.kind = 'font' AND {FONT_CATEGORY} IN ({}))",
            placeholders(f.font_categories.len())
        ));
        args.extend(f.font_categories.iter().map(|v| Box::new(v.clone()) as Box<dyn ToSql>));
    }
    if !f.font_weights.is_empty() {
        let ranges: Vec<String> = f.font_weights.iter().map(|k| font_weight_where(k)).collect();
        wheres.push(format!("(items.kind = 'font' AND ({}))", ranges.join(" OR ")));
    }
    if !f.font_features.is_empty() {
        let has: Vec<&str> = f.font_features.iter().map(|_| FONT_FEATURE_WHERE).collect();
        wheres.push(format!("(items.kind = 'font' AND ({}))", has.join(" OR ")));
        args.extend(f.font_features.iter().map(|v| Box::new(v.clone()) as Box<dyn ToSql>));
    }
    if !f.exts.is_empty() {
        let exts: Vec<String> = f.exts.iter().flat_map(|e| ext_aliases(e)).collect();
        wheres.push(format!("lower(items.ext) IN ({})", placeholders(exts.len())));
        args.extend(exts.into_iter().map(|e| Box::new(e) as Box<dyn ToSql>));
    }
    // Shape and pixel size only apply to images (fonts are 0 × 0).
    let sized = !f.shapes.is_empty()
        || f.min_width.is_some()
        || f.max_width.is_some()
        || f.min_height.is_some()
        || f.max_height.is_some();
    if sized {
        wheres.push("items.kind = 'image'".into());
    }
    if !f.shapes.is_empty() {
        let parts: Vec<&str> = f
            .shapes
            .iter()
            .map(|s| match s {
                Shape::Landscape => SHAPE_SQL[0].1,
                Shape::Portrait => SHAPE_SQL[1].1,
                Shape::Square => SHAPE_SQL[2].1,
            })
            .collect();
        wheres.push(format!("({})", parts.join(" OR ")));
    }
    let mut range = |col: &str, op: &str, v: Option<i64>| {
        if let Some(v) = v {
            wheres.push(format!("{col} {op} ?"));
            args.push(Box::new(v));
        }
    };
    range("items.width", ">=", f.min_width.map(i64::from));
    range("items.width", "<=", f.max_width.map(i64::from));
    range("items.height", ">=", f.min_height.map(i64::from));
    range("items.height", "<=", f.max_height.map(i64::from));
    range("items.imported_at", ">=", f.imported_after);
    range("items.imported_at", "<", f.imported_before);
    range("items.size", ">=", f.min_size);
    range("items.size", "<=", f.max_size);
    if f.parents_only {
        wheres.push(format!("({HAS_CHILDREN} OR {CHILD_OF_LIVE})"));
    }
}

const SUBFOLDERS_CTE: &str = "WITH RECURSIVE sub(id) AS (
       SELECT ? UNION ALL SELECT c.id FROM folders c JOIN sub ON c.parent_id = sub.id)
     SELECT id FROM sub";

/// The WHERE terms (joined with AND) and their arguments of a query: its
/// view, ad-hoc conditions and smart folder rule.
fn query_where(conn: &Connection, q: &ItemQuery) -> DbResult<(Vec<String>, Vec<Box<dyn ToSql>>)> {
    let mut wheres: Vec<String> = Vec::new();
    let mut args: Vec<Box<dyn ToSql>> = Vec::new();
    if q.view == View::Trash {
        wheres.push("items.deleted_at IS NOT NULL".into());
    } else {
        wheres.push("items.deleted_at IS NULL".into());
    }
    match &q.view {
        View::Unfiled => wheres
            .push("NOT EXISTS (SELECT 1 FROM item_folders f WHERE f.item_id = items.id)".into()),
        View::Untagged => {
            wheres.push("NOT EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = items.id)".into())
        }
        View::Folder { id } if q.include_subfolders => {
            wheres.push(format!(
                "EXISTS (SELECT 1 FROM item_folders f WHERE f.item_id = items.id
                   AND f.folder_id IN ({SUBFOLDERS_CTE}))"
            ));
            args.push(Box::new(id.clone()));
        }
        View::Folder { id } => {
            wheres.push(
                "EXISTS (SELECT 1 FROM item_folders f WHERE f.item_id = items.id AND f.folder_id = ?)"
                    .into(),
            );
            args.push(Box::new(id.clone()));
        }
        View::Favorites => wheres.push("items.favorite = 1".into()),
        View::Pinned => wheres.push("items.pinned_at IS NOT NULL".into()),
        View::Tray => wheres.push("EXISTS (SELECT 1 FROM tray t WHERE t.item_id = items.id)".into()),
        View::Tag { id } => {
            wheres.push("EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = items.id AND t.tag_id = ?)".into());
            args.push(Box::new(*id));
        }
        View::All | View::Trash | View::Similar | View::Smart { .. } => {}
    }

    push_rule(&q.rule(), &mut wheres, &mut args);
    if let View::Smart { id } = &q.view {
        match load_rule(conn, id)? {
            Some(rule) => push_rule(&rule, &mut wheres, &mut args),
            None => wheres.push("0".into()), // folder was deleted
        }
    }
    Ok((wheres, args))
}

/// Rows of a query; `finish` does the rest (see `QueryRows`).
pub fn query_rows(conn: &Connection, q: &ItemQuery) -> DbResult<QueryRows> {
    let mut args: Vec<Box<dyn ToSql>> = Vec::new();

    // Manual order joins the folder's (or the tray's) positions; a folder's
    // bind value comes first, as the join comes before WHERE.
    let manual_folder = match (&q.view, q.sort) {
        (View::Folder { id }, SortKey::Manual) => Some(id.clone()),
        _ => None,
    };
    let manual_tray = q.view == View::Tray && matches!(q.sort, SortKey::Manual);
    let join = if let Some(f) = &manual_folder {
        args.push(Box::new(f.clone()));
        "LEFT JOIN item_folders pos ON pos.item_id = items.id AND pos.folder_id = ?"
    } else if manual_tray {
        "LEFT JOIN tray pos ON pos.item_id = items.id"
    } else {
        ""
    };
    let (wheres, where_args) = query_where(conn, q)?;
    args.extend(where_args);

    let dir = if q.desc { "DESC" } else { "ASC" };
    let order = match q.sort {
        SortKey::ImportedAt => format!("items.imported_at {dir}"),
        SortKey::Name => format!("items.name COLLATE NOCASE {dir}"),
        SortKey::Size => format!("items.size {dir}"),
        SortKey::Dimensions => format!("items.width * items.height {dir}"),
        SortKey::Rating => format!("items.rating {dir}, items.imported_at DESC"),
        // Manual is always top-to-bottom; items without a position go last.
        SortKey::Manual if manual_folder.is_some() || manual_tray => {
            "pos.position IS NULL, pos.position ASC, items.imported_at ASC".into()
        }
        SortKey::Manual => format!("items.imported_at {dir}"),
    };
    // Pinned items come first (latest pin on top), whatever the sort —
    // except in the tray's own order, which is the order things are handled in.
    let pins = if manual_tray { "" } else { "items.pinned_at IS NULL, items.pinned_at DESC, " };
    let sql = format!(
        "SELECT {ITEM_COLS} FROM items {join} WHERE {}
         ORDER BY {pins}{order}, items.rowid {dir}",
        wheres.join(" AND ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter().map(|b| b.as_ref())), row_to_item)?;
    let mut items = rows.collect::<DbResult<Vec<_>>>()?;
    let lists_parents = !matches!(q.view, View::Trash | View::Tray | View::Similar);
    if q.with_parents && lists_parents && links_enabled(conn)? {
        add_parents(conn, &mut items)?;
    }
    let similar = match q.view {
        View::Similar => Some(SimilarInput::read(conn, q.similar_level)?),
        _ => None,
    };
    Ok(QueryRows { items, similar })
}

/// The items of a query, as `query_items` returns them.
pub fn query_items(conn: &Connection, q: &ItemQuery) -> DbResult<Vec<Item>> {
    Ok(query_rows(conn, q)?.finish())
}

/// How many of a query's items have each value of each condition of the
/// filter row (docs/NAVIGATION.md). The app asks with the condition whose
/// menu is open left out, so its counts are with the other conditions on.
#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Facets {
    /// Items rated exactly n (0 = unrated); "★n 以上" adds them up.
    pub ratings: BTreeMap<u8, i64>,
    pub tags: BTreeMap<i64, i64>,
    pub kinds: BTreeMap<Kind, i64>,
    /// File types (canonical, as `list_exts`), most first.
    pub exts: Vec<(String, i64)>,
    /// Images by shape ("landscape", "portrait", "square").
    pub shapes: BTreeMap<String, i64>,
    /// Fonts (details read) by writing system, typeface style, weight range and feature.
    pub font_scripts: BTreeMap<String, i64>,
    pub font_categories: BTreeMap<String, i64>,
    pub font_weights: BTreeMap<String, i64>,
    pub font_features: BTreeMap<String, i64>,
    /// Items with children (`Filter::parents_only`).
    pub parents: i64,
}

pub fn facet_counts(conn: &Connection, q: &ItemQuery) -> DbResult<Facets> {
    let (wheres, args) = query_where(conn, q)?;
    let matched = format!("SELECT items.id FROM items WHERE {}", wheres.join(" AND "));
    let args: Vec<&dyn ToSql> = args.iter().map(|b| b.as_ref()).collect();
    // Rows of (key, count) over the matched items, `col` and `cond` on `items`.
    let group = |col: &str, cond: &str| -> DbResult<Vec<(rusqlite::types::Value, i64)>> {
        let sql = format!("SELECT {col}, COUNT(*) FROM items WHERE items.id IN ({matched}) AND {cond} GROUP BY 1");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(args.as_slice(), |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    };
    let text = |v: rusqlite::types::Value| match v {
        rusqlite::types::Value::Text(t) => t,
        _ => String::new(),
    };
    let int = |v: rusqlite::types::Value| match v {
        rusqlite::types::Value::Integer(i) => i,
        _ => 0,
    };
    let mut f = Facets {
        ratings: group("items.rating", "1")?.into_iter().map(|(k, n)| (int(k) as u8, n)).collect(),
        kinds: group("items.kind", "1")?.into_iter().map(|(k, n)| (Kind::parse(&text(k)), n)).collect(),
        font_scripts: group("items.font_script", "items.kind = 'font' AND items.font_script IS NOT NULL")?
            .into_iter()
            .map(|(k, n)| (text(k), n))
            .collect(),
        font_categories: group(FONT_CATEGORY, "items.kind = 'font' AND items.font_script IS NOT NULL")?
            .into_iter()
            .map(|(k, n)| (text(k), n))
            .collect(),
        ..Default::default()
    };
    for (ext, n) in group("lower(items.ext)", "1")? {
        let ext = canonical_ext(&text(ext));
        match f.exts.iter_mut().find(|(e, _)| *e == ext) {
            Some((_, c)) => *c += n,
            None => f.exts.push((ext, n)),
        }
    }
    f.exts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    {
        let sql = format!(
            "SELECT x.tag_id, COUNT(*) FROM item_tags x WHERE x.item_id IN ({matched}) GROUP BY x.tag_id"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(args.as_slice(), |r| Ok((r.get(0)?, r.get(1)?)))?;
        f.tags = rows.collect::<DbResult<_>>()?;
    }
    // One SUM per value where an item can have several (or a range spans several).
    let sums = |terms: &[(String, String)], cond: &str| -> DbResult<BTreeMap<String, i64>> {
        let cols: Vec<String> = terms.iter().map(|(_, t)| format!("SUM({t})")).collect();
        let sql = format!("SELECT {} FROM items WHERE items.id IN ({matched}) AND {cond}", cols.join(", "));
        let mut stmt = conn.prepare(&sql)?;
        let out: BTreeMap<String, i64> = stmt.query_row(args.as_slice(), |r| {
            terms
                .iter()
                .enumerate()
                .map(|(i, (k, _))| Ok((k.clone(), r.get::<_, Option<i64>>(i)?.unwrap_or(0))))
                .collect()
        })?;
        Ok(out.into_iter().filter(|(_, n)| *n > 0).collect())
    };
    let shapes: Vec<(String, String)> = SHAPE_SQL.iter().map(|(k, t)| (k.to_string(), t.to_string())).collect();
    f.shapes = sums(&shapes, "items.kind = 'image'")?;
    let fonts = "items.kind = 'font' AND items.font_script IS NOT NULL";
    let weights: Vec<(String, String)> = FONT_WEIGHTS.iter().map(|(k, _, _)| (k.to_string(), font_weight_where(k))).collect();
    f.font_weights = sums(&weights, fonts)?;
    let features: Vec<(String, String)> = crate::fonts::FEATURES
        .iter()
        .map(|k| (k.to_string(), format!("instr(',' || IFNULL(items.font_features, '') || ',', ',{k},') > 0")))
        .collect();
    f.font_features = sums(&features, fonts)?;
    f.parents = conn.query_row(
        &format!("SELECT COUNT(*) FROM items WHERE items.id IN ({matched}) AND {HAS_CHILDREN}"),
        args.as_slice(),
        |r| r.get(0),
    )?;
    Ok(f)
}

/// A query's rows, with the similar view's grouping still to do: it compares
/// many pairs on a large library and needs no database, so the app runs it
/// after letting go of the library (commands.rs `query_items`).
pub struct QueryRows {
    items: Vec<Item>,
    similar: Option<SimilarInput>,
}

impl QueryRows {
    pub fn finish(self) -> Vec<Item> {
        match self.similar {
            Some(s) => similar_groups(self.items, s),
            None => self.items,
        }
    }
}

/// What the look-alike grouping reads from the database.
struct SimilarInput {
    level: similar::Level,
    /// id -> (perceptual hash, mean colour).
    hashes: HashMap<String, (i64, u32)>,
    /// Pairs the user said aren't duplicates.
    dismissed: Vec<(String, String)>,
}

impl SimilarInput {
    fn read(conn: &Connection, level: similar::Level) -> DbResult<Self> {
        let mut stmt =
            conn.prepare("SELECT id, phash, pcolor FROM items WHERE deleted_at IS NULL AND phash IS NOT NULL")?;
        let hashes = stmt
            .query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get::<_, Option<u32>>(2)?.unwrap_or(0)))))?
            .collect::<DbResult<_>>()?;
        let mut stmt = conn.prepare("SELECT a, b FROM dismissed_pairs")?;
        let dismissed = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<DbResult<_>>()?;
        Ok(Self { level, hashes, dismissed })
    }
}

/// Keeps only items that have look-alikes among `items`, grouped together.
/// Groups follow the query's sort order; inside a group the best copy
/// (most pixels, then largest file, then oldest) comes first.
fn similar_groups(items: Vec<Item>, input: SimilarInput) -> Vec<Item> {
    let SimilarInput { level, hashes, dismissed } = input;
    let mut items: Vec<Option<Item>> = items
        .into_iter()
        .filter(|i| hashes.contains_key(&i.id))
        .map(Some)
        .collect();
    let entries: Vec<similar::Entry> = items
        .iter()
        .flatten()
        .map(|i| {
            let (hash, color) = hashes[&i.id];
            similar::Entry { hash: hash as u64, color, width: i.width, height: i.height }
        })
        .collect();
    // Pairs the user dismissed, as entry indices (smaller first). Pairs with an
    // item that isn't among the entries are skipped.
    let index: HashMap<&str, usize> =
        items.iter().flatten().enumerate().map(|(k, i)| (i.id.as_str(), k)).collect();
    let mut excluded: HashSet<(usize, usize)> = HashSet::new();
    for (a, b) in &dismissed {
        if let (Some(&i), Some(&j)) = (index.get(a.as_str()), index.get(b.as_str())) {
            excluded.insert((i.min(j), i.max(j)));
        }
    }
    let mut out = Vec::new();
    for (n, group) in similar::groups_except(&entries, level, &excluded).into_iter().enumerate() {
        let mut members: Vec<Item> = group.into_iter().filter_map(|k| items[k].take()).collect();
        members.sort_by_key(|i| {
            (std::cmp::Reverse(i.width as u64 * i.height as u64), std::cmp::Reverse(i.size), i.imported_at)
        });
        let best = hashes[&members[0].id].0 as u64;
        for mut m in members {
            m.group = Some(n as u32);
            m.distance = Some(similar::distance(best, hashes[&m.id].0 as u64));
            out.push(m);
        }
    }
    out
}

/// Live items whose perceptual hash hasn't been computed: (id, unrotated
/// thumbnail file), so the hash doesn't depend on the orientation.
pub fn missing_phashes(conn: &Connection) -> DbResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT id, thumb FROM items WHERE phash IS NULL AND deleted_at IS NULL AND kind = 'image'")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, crate::orient::base_thumb(&r.get::<_, String>(1)?))))?;
    rows.collect()
}

/// Fonts whose details haven't been read yet (imported by a version that
/// didn't store them all), trash included: (id, file name, extension).
pub fn missing_font_meta(conn: &Connection) -> DbResult<Vec<(String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, file_name, lower(ext) FROM items WHERE kind = 'font' AND (font_script IS NULL OR font_features IS NULL)",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    rows.collect()
}

pub fn set_font_meta(conn: &mut Connection, metas: &[(String, crate::fonts::FontMeta)]) -> DbResult<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "UPDATE items SET font_family = ?2, font_weight = ?3, font_script = ?4, font_category = ?5,
               font_weight_min = ?6, font_weight_max = ?7, font_features = ?8, font_ps_name = ?9 WHERE id = ?1",
        )?;
        for (id, m) in metas {
            stmt.execute(params![
                id,
                m.family,
                m.weight,
                m.script,
                m.category,
                m.weight_min,
                m.weight_max,
                m.features_text(),
                m.ps_name
            ])?;
        }
    }
    tx.commit()
}

/// PostScript names of the library's fonts (not in the trash): which of the
/// fonts installed on this computer are in the library (docs/SYSTEM_FONTS.md).
pub fn font_ps_names(conn: &Connection) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT font_ps_name FROM items
         WHERE kind = 'font' AND deleted_at IS NULL AND font_ps_name IS NOT NULL AND font_ps_name != ''",
    )?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    rows.collect()
}

/// The user's typeface style for fonts (None = back to the guess). Not fonts are skipped.
pub fn set_font_category(conn: &Connection, ids: &[String], category: Option<&str>) -> DbResult<usize> {
    let mut stmt = conn.prepare("UPDATE items SET font_category_user = ?2 WHERE id = ?1 AND kind = 'font'")?;
    let mut n = 0;
    for id in ids {
        n += stmt.execute(params![id, category])?;
    }
    Ok(n)
}

pub fn set_phashes(conn: &mut Connection, hashes: &[(String, (u64, u32))]) -> DbResult<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("UPDATE items SET phash = ?2, pcolor = ?3 WHERE id = ?1")?;
        for (id, (h, c)) in hashes {
            stmt.execute(params![id, *h as i64, c])?;
        }
    }
    tx.commit()
}

pub fn get_items(conn: &Connection, ids: &[String]) -> DbResult<Vec<Item>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let mut stmt = conn.prepare(&format!("SELECT {ITEM_COLS} FROM items WHERE id {IN_IDS}"))?;
    let rows = stmt.query_map([ids_param(ids)], row_to_item)?;
    rows.collect()
}

/// hash -> item id, including trashed items.
pub fn hash_index(conn: &Connection) -> DbResult<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT hash, id FROM items")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// The item (trashed or not) with this hash, if any.
pub fn item_by_hash(conn: &Connection, hash: &str) -> DbResult<Option<String>> {
    conn.query_row("SELECT id FROM items WHERE hash = ?1 LIMIT 1", [hash], |r| r.get(0)).optional()
}

pub fn insert_item(tx: &Transaction, it: &NewItem, imported_at: i64) -> DbResult<()> {
    tx.execute(
        "INSERT INTO items (id, name, file_name, ext, width, height, size, hash, thumb, imported_at, phash, pcolor, preview, kind,
           font_family, font_weight, font_script, font_category, font_weight_min, font_weight_max, font_features, body,
           font_ps_name, duration_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
        params![
            it.id,
            it.name,
            it.file_name,
            it.ext,
            it.width,
            it.height,
            it.size,
            it.hash,
            it.thumb,
            imported_at,
            it.phash.map(|(h, _)| h as i64),
            it.phash.map(|(_, c)| c),
            it.preview,
            it.kind.as_str(),
            it.font.as_ref().map(|f| &f.family),
            it.font.as_ref().map(|f| f.weight),
            it.font.as_ref().map(|f| f.script),
            it.font.as_ref().and_then(|f| f.category),
            it.font.as_ref().map(|f| f.weight_min),
            it.font.as_ref().map(|f| f.weight_max),
            it.font.as_ref().map(|f| f.features_text()),
            it.body,
            it.font.as_ref().map(|f| &f.ps_name),
            it.duration_ms
        ],
    )?;
    Ok(())
}

/// A text after it was edited (texts/commands.rs `save_text`).
pub fn set_text(conn: &Connection, id: &str, hash: &str, size: i64, thumb: &str, body: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE items SET hash = ?2, size = ?3, thumb = ?4, body = ?5 WHERE id = ?1 AND kind = 'text'",
        params![id, hash, size, thumb, body],
    )?;
    Ok(())
}

pub fn set_note(conn: &Connection, id: &str, note: &str) -> DbResult<()> {
    conn.execute("UPDATE items SET note = ?2 WHERE id = ?1", params![id, note])?;
    Ok(())
}

pub fn set_rating(conn: &Connection, ids: &[String], rating: u8) -> DbResult<()> {
    let mut stmt = conn.prepare("UPDATE items SET rating = ?2 WHERE id = ?1")?;
    for id in ids {
        stmt.execute(params![id, rating.min(5)])?;
    }
    Ok(())
}

pub fn set_favorite(conn: &Connection, ids: &[String], on: bool) -> DbResult<()> {
    let mut stmt = conn.prepare("UPDATE items SET favorite = ?2 WHERE id = ?1")?;
    for id in ids {
        stmt.execute(params![id, on as i64])?;
    }
    Ok(())
}

/// Pins (to the top of every list) or unpins. Items already pinned keep
/// their place when pinned again.
pub fn set_pinned(conn: &Connection, ids: &[String], on: bool) -> DbResult<()> {
    let mut stmt = if on {
        conn.prepare("UPDATE items SET pinned_at = COALESCE(pinned_at, ?2) WHERE id = ?1")?
    } else {
        conn.prepare("UPDATE items SET pinned_at = NULL WHERE id = ?1 AND ?2")?
    };
    let now = now_ms();
    for id in ids {
        stmt.execute(params![id, now])?;
    }
    Ok(())
}

// ---------------------------------------------------------------- work tray

/// The shelf's order across the items (`tray`) and the fonts installed on
/// this computer (`tray_system`, docs/SYSTEM_FONTS.md): their ids by position.
const TRAY_ORDER: &str = "SELECT item_id FROM (SELECT item_id, position, 0 AS k, rowid AS r FROM tray
       UNION ALL SELECT id, position, 1, rowid FROM tray_system) ORDER BY position, k, r";

/// The last position on the shelf (0 when it is empty).
fn tray_last(conn: &Connection) -> DbResult<f64> {
    conn.query_row(
        "SELECT MAX(COALESCE((SELECT MAX(position) FROM tray), 0), COALESCE((SELECT MAX(position) FROM tray_system), 0))",
        [],
        |r| r.get(0),
    )
}

/// Every id on the shelf in its order: items and installed fonts together.
pub fn tray_order(conn: &Connection) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare(TRAY_ORDER)?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    rows.collect()
}

/// Installed fonts on the shelf (id, name), in its order.
pub fn system_tray(conn: &Connection) -> DbResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT id, name FROM tray_system ORDER BY position, rowid")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// Puts installed fonts (id, name) on the shelf after what is there. Fonts
/// already on it keep their place.
pub fn add_system_to_tray(conn: &Connection, fonts: &[(String, String)]) -> DbResult<usize> {
    let last = tray_last(conn)?;
    let mut stmt = conn.prepare("INSERT OR IGNORE INTO tray_system (id, name, position) VALUES (?1, ?2, ?3)")?;
    let mut added = 0;
    for (id, name) in fonts {
        added += stmt.execute(params![id, name, last + (added + 1) as f64])?;
    }
    Ok(added)
}

/// Puts items on the work tray, after the ones already there (in the given
/// order). Items already on it keep their place.
pub fn add_to_tray(conn: &Connection, ids: &[String]) -> DbResult<usize> {
    let last = tray_last(conn)?;
    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO tray (item_id, position) SELECT id, ?2 FROM items WHERE id = ?1",
    )?;
    let mut added = 0;
    for id in ids {
        added += stmt.execute(params![id, last + (added + 1) as f64])?;
    }
    Ok(added)
}

/// Takes items and installed fonts off the shelf.
pub fn remove_from_tray(conn: &Connection, ids: &[String]) -> DbResult<()> {
    let mut items = conn.prepare("DELETE FROM tray WHERE item_id = ?1")?;
    let mut system = conn.prepare("DELETE FROM tray_system WHERE id = ?1")?;
    for id in ids {
        items.execute([id])?;
        system.execute([id])?;
    }
    Ok(())
}

/// Empties the tray (installed fonts too); returns what was on it, in order (to put it back).
pub fn clear_tray(conn: &Connection) -> DbResult<Vec<String>> {
    let ids = tray_order(conn)?;
    conn.execute_batch("DELETE FROM tray; DELETE FROM tray_system;")?;
    Ok(ids)
}

/// Moves `ids` in front of `before` (None = to the end) in the tray's order
/// (items and installed fonts together).
pub fn reorder_tray(conn: &mut Connection, ids: &[String], before: Option<&str>) -> DbResult<()> {
    let tx = conn.transaction()?;
    let mut order = tray_order(&tx)?;
    let moving: Vec<String> = ids.iter().filter(|id| order.contains(id)).cloned().collect();
    order.retain(|id| !moving.contains(id));
    let at = before
        .and_then(|b| order.iter().position(|id| id == b))
        .unwrap_or(order.len());
    order.splice(at..at, moving);
    {
        let mut items = tx.prepare("UPDATE tray SET position = ?2 WHERE item_id = ?1")?;
        let mut system = tx.prepare("UPDATE tray_system SET position = ?2 WHERE id = ?1")?;
        for (i, id) in order.iter().enumerate() {
            items.execute(params![id, (i + 1) as f64])?;
            system.execute(params![id, (i + 1) as f64])?;
        }
    }
    tx.commit()
}

/// Stores a new orientation with the matching displayed size and thumbnail.
pub fn set_orientation(
    conn: &Connection,
    id: &str,
    o: crate::orient::Orientation,
    width: u32,
    height: u32,
    thumb: &str,
) -> DbResult<()> {
    conn.execute(
        "UPDATE items SET rotation = ?2, flipped = ?3, width = ?4, height = ?5, thumb = ?6 WHERE id = ?1",
        params![id, o.rotation, o.flipped as i64, width, height, thumb],
    )?;
    Ok(())
}

/// Replaces an item's thumbnail (files: once a better one could be made).
pub fn set_thumb(conn: &Connection, id: &str, thumb: &str) -> DbResult<()> {
    conn.execute("UPDATE items SET thumb = ?2 WHERE id = ?1", params![id, thumb])?;
    Ok(())
}

/// Files of these types not in the trash: (id, ext, file name, thumbnail), newest first.
/// Live files of these types that the user brought in themselves: not ones
/// saved from the web (`source_url`), which the background thumbnail pass
/// shouldn't hand to Office unasked (files/thumbs.rs).
pub fn files_of_types(conn: &Connection, exts: &[&str]) -> DbResult<Vec<(String, String, String, String)>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT id, ext, file_name, thumb FROM items
         WHERE kind = 'file' AND deleted_at IS NULL AND source_url IS NULL AND ext IN ({})
         ORDER BY imported_at DESC",
        placeholders(exts.len())
    ))?;
    let rows = stmt.query_map(rusqlite::params_from_iter(exts), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
    rows.collect()
}

/// Records the page the items came from. Items that already have one keep it
/// (saving a known image again from another page doesn't change its origin).
pub fn set_source_url(conn: &Connection, ids: &[String], url: &str) -> DbResult<()> {
    let mut stmt = conn.prepare("UPDATE items SET source_url = ?2 WHERE id = ?1 AND source_url IS NULL")?;
    for id in ids {
        stmt.execute(params![id, url])?;
    }
    Ok(())
}

pub fn rename_item(conn: &Connection, id: &str, name: &str) -> DbResult<()> {
    conn.execute("UPDATE items SET name = ?2 WHERE id = ?1", params![id, name])?;
    Ok(())
}

/// Moves items to the trash. The children of a parent go with it, unless the library
/// keeps them (`linksTrash` = "keep": they are freed instead, docs/LINKS.md).
pub fn trash_items(conn: &Connection, ids: &[String]) -> DbResult<()> {
    if links_trash_keeps_children(conn)? {
        conn.execute(
            &format!(
                "UPDATE items SET parent_id = NULL, adopted = 0
                 WHERE parent_id {IN_IDS} AND id NOT {IN_IDS}"
            ),
            [ids_param(ids), ids_param(ids)],
        )?;
    }
    conn.execute(
        &format!(
            "UPDATE items SET deleted_at = ?1 WHERE deleted_at IS NULL
               AND (id {IN_IDS} OR parent_id {IN_IDS})"
        ),
        params![now_ms(), ids_param(ids), ids_param(ids)],
    )?;
    Ok(())
}

/// Marks every pair among `ids` as "not duplicates" so they stop being proposed
/// together. One call counts as one dismissed group.
pub fn dismiss_duplicates(conn: &mut Connection, ids: &[String]) -> DbResult<()> {
    if ids.len() < 2 {
        return Ok(());
    }
    let batch = uuid::Uuid::new_v4().simple().to_string();
    let now = now_ms();
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO dismissed_pairs (a, b, batch, created_at) VALUES (?1, ?2, ?3, ?4)",
        )?;
        for (i, x) in ids.iter().enumerate() {
            for y in &ids[i + 1..] {
                let (a, b) = if x < y { (x, y) } else { (y, x) };
                stmt.execute(params![a, b, batch, now])?;
            }
        }
    }
    tx.commit()
}

/// Takes the pairs among `ids` back out of the dismissed list.
pub fn undismiss_duplicates(conn: &Connection, ids: &[String]) -> DbResult<()> {
    let mut stmt = conn.prepare("DELETE FROM dismissed_pairs WHERE a = ?1 AND b = ?2")?;
    for (i, x) in ids.iter().enumerate() {
        for y in &ids[i + 1..] {
            let (a, b) = if x < y { (x, y) } else { (y, x) };
            stmt.execute(params![a, b])?;
        }
    }
    Ok(())
}

pub fn clear_dismissed_duplicates(conn: &Connection) -> DbResult<()> {
    conn.execute("DELETE FROM dismissed_pairs", [])?;
    Ok(())
}

/// How many dismiss actions (groups) are still in effect.
pub fn dismissed_duplicate_groups(conn: &Connection) -> DbResult<usize> {
    conn.query_row("SELECT COUNT(DISTINCT batch) FROM dismissed_pairs", [], |r| r.get::<_, i64>(0))
        .map(|n| n as usize)
}

#[derive(Debug, Deserialize)]
pub struct DuplicateGroup {
    pub keep: String,
    pub remove: Vec<String>,
}

/// What tidying one duplicate group does to the copy that is kept.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateEffect {
    pub keep: String,
    pub remove: Vec<String>,
    /// Names of tags the kept copy gains.
    pub added_tags: Vec<String>,
    /// The kept copy's new rating, if it goes up.
    pub rating: Option<u8>,
    /// Its rating before, to undo with.
    pub rating_before: u8,
    /// Folder the kept copy moves into (only when it has none of its own).
    pub folder_id: Option<String>,
}

/// Works out what `resolve_duplicates` would carry over, without changing anything.
pub fn plan_duplicates(conn: &Connection, groups: &[DuplicateGroup]) -> DbResult<Vec<DuplicateEffect>> {
    let mut out = Vec::new();
    for g in groups.iter().filter(|g| !g.remove.is_empty()) {
        let marks = placeholders(g.remove.len());
        let mut args: Vec<&dyn ToSql> = g.remove.iter().map(|s| s as &dyn ToSql).collect();
        args.push(&g.keep);
        let mut stmt = conn.prepare(&format!(
            "SELECT DISTINCT t.name FROM item_tags x JOIN tags t ON t.id = x.tag_id
             WHERE x.item_id IN ({marks})
               AND x.tag_id NOT IN (SELECT tag_id FROM item_tags WHERE item_id = ?)
             ORDER BY t.name COLLATE NOCASE"
        ))?;
        let added_tags = stmt.query_map(params_from_iter(&args), |r| r.get(0))?.collect::<DbResult<_>>()?;

        let best: Option<u8> = conn.query_row(
            &format!("SELECT MAX(rating) FROM items WHERE id IN ({marks})"),
            params_from_iter(g.remove.iter()),
            |r| r.get(0),
        )?;
        let own: u8 = conn.query_row("SELECT rating FROM items WHERE id = ?", [&g.keep], |r| r.get(0))?;
        let rating = best.filter(|&b| b > own);

        let has_folder = conn
            .query_row("SELECT 1 FROM item_folders WHERE item_id = ?", [&g.keep], |_| Ok(()))
            .optional()?
            .is_some();
        let folder_id = if has_folder {
            None
        } else {
            conn.query_row(
                &format!("SELECT folder_id FROM item_folders WHERE item_id IN ({marks}) ORDER BY rowid LIMIT 1"),
                params_from_iter(g.remove.iter()),
                |r| r.get(0),
            )
            .optional()?
        };
        out.push(DuplicateEffect {
            keep: g.keep.clone(),
            remove: g.remove.clone(),
            added_tags,
            rating,
            rating_before: own,
            folder_id,
        });
    }
    Ok(out)
}

/// Trashes duplicates after copying their tags and best rating onto the copy
/// that is kept (and its folder, if it had none), so no organizing work is
/// lost. Returns what was carried over.
pub fn resolve_duplicates(conn: &mut Connection, groups: &[DuplicateGroup]) -> DbResult<Vec<DuplicateEffect>> {
    let tx = conn.transaction()?;
    let effects = plan_duplicates(&tx, groups)?;
    for e in &effects {
        let marks = placeholders(e.remove.len());
        let mut args: Vec<&dyn ToSql> = vec![&e.keep];
        args.extend(e.remove.iter().map(|s| s as &dyn ToSql));
        tx.execute(
            &format!(
                "INSERT OR IGNORE INTO item_tags (item_id, tag_id)
                 SELECT ?, tag_id FROM item_tags WHERE item_id IN ({marks})"
            ),
            params_from_iter(&args),
        )?;
        if let Some(r) = e.rating {
            tx.execute("UPDATE items SET rating = ?2 WHERE id = ?1", params![e.keep, r])?;
        }
        if let Some(f) = &e.folder_id {
            file_unfiled(&tx, std::slice::from_ref(&e.keep), f)?;
        }
        hand_over_children(&tx, &e.keep, &e.remove)?;
        trash_items(&tx, &e.remove)?;
    }
    tx.commit()?;
    Ok(effects)
}

/// Takes items out of the trash; a parent brings its children back (docs/LINKS.md).
pub fn restore_items(conn: &Connection, ids: &[String]) -> DbResult<()> {
    conn.execute(
        &format!("UPDATE items SET deleted_at = NULL WHERE id {IN_IDS} OR parent_id {IN_IDS}"),
        [ids_param(ids), ids_param(ids)],
    )?;
    Ok(())
}

/// Deletes rows and returns them so the caller can remove the files.
pub fn delete_items(conn: &Connection, ids: &[String]) -> DbResult<Vec<Item>> {
    let items = get_items(conn, ids)?;
    conn.execute(&format!("DELETE FROM items WHERE id {IN_IDS}"), [ids_param(ids)])?;
    Ok(items)
}

/// Ids of every item not in the trash (of `kind`, when given).
pub fn live_ids(conn: &Connection, kind: Option<Kind>) -> DbResult<Vec<String>> {
    let (of_kind, arg) = kind_where(kind, 1, "items");
    let mut stmt = conn.prepare(&format!(
        "SELECT id FROM items WHERE deleted_at IS NULL AND {of_kind} ORDER BY imported_at"
    ))?;
    let rows = stmt.query_map([arg.as_ref()], |r| r.get(0))?;
    rows.collect()
}

pub fn trashed_ids(conn: &Connection) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT id FROM items WHERE deleted_at IS NOT NULL")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    rows.collect()
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub all: i64,
    pub unfiled: i64,
    pub untagged: i64,
    pub trash: i64,
    pub favorites: i64,
    pub pinned: i64,
    /// Items on the shelf (not in the trash).
    pub tray: i64,
    /// Items not in the trash, by kind (kinds with none are left out).
    pub kinds: BTreeMap<Kind, i64>,
    /// Fonts not in the trash by writing system, and by typeface style ("none" = unknown).
    pub font_scripts: BTreeMap<String, i64>,
    pub font_categories: BTreeMap<String, i64>,
    /// Fonts not in the trash by weight range (`FONT_WEIGHTS`; a variable
    /// font counts under every range it spans) and by feature.
    pub font_weights: BTreeMap<String, i64>,
    pub font_features: BTreeMap<String, i64>,
}

/// SQL fragment keeping rows of `kind` (any kind when None), with the kind
/// as the argument `?n`. `t` is the alias of the items table.
fn kind_where(kind: Option<Kind>, n: usize, t: &str) -> (String, Box<dyn ToSql>) {
    (format!("(?{n} IS NULL OR {t}.kind = ?{n})"), Box::new(kind.map(Kind::as_str)))
}

/// Totals for the sidebar. With `mode`, everything but `kinds` counts only
/// items of that mode (`kinds` is for switching between them).
pub fn counts(conn: &Connection, mode: Option<Mode>) -> DbResult<Counts> {
    let mut stmt = conn.prepare_cached("SELECT kind, COUNT(*) FROM items WHERE deleted_at IS NULL GROUP BY kind")?;
    let kinds = stmt
        .query_map([], |r| Ok((Kind::parse(&r.get::<_, String>(0)?), r.get::<_, i64>(1)?)))?
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    let by = |col: &str| -> DbResult<BTreeMap<String, i64>> {
        let sql = format!(
            "SELECT {col}, COUNT(*) FROM items WHERE deleted_at IS NULL AND kind = 'font' AND font_script IS NOT NULL GROUP BY 1"
        );
        let mut stmt = conn.prepare_cached(&sql)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        rows.collect()
    };
    let font_scripts = by("items.font_script")?;
    let font_categories = by(FONT_CATEGORY)?;
    // One SUM per range / feature, of fonts whose details were read.
    let sums = |terms: &[(&str, String)]| -> DbResult<BTreeMap<String, i64>> {
        let cols: Vec<String> = terms.iter().map(|(_, t)| format!("SUM({t})")).collect();
        let sql = format!(
            "SELECT {} FROM items WHERE deleted_at IS NULL AND kind = 'font' AND font_script IS NOT NULL",
            cols.join(", ")
        );
        let mut stmt = conn.prepare_cached(&sql)?;
        stmt.query_row([], |r| {
            terms
                .iter()
                .enumerate()
                .map(|(i, (k, _))| Ok((k.to_string(), r.get::<_, Option<i64>>(i)?.unwrap_or(0))))
                .collect()
        })
    };
    let weight_terms: Vec<(&str, String)> = FONT_WEIGHTS.iter().map(|(k, _, _)| (*k, font_weight_where(k))).collect();
    let feature_terms: Vec<(&str, String)> = crate::fonts::FEATURES
        .iter()
        .map(|k| (*k, format!("instr(',' || IFNULL(items.font_features, '') || ',', ',{k},') > 0")))
        .collect();
    let font_weights = sums(&weight_terms)?.into_iter().filter(|(_, n)| *n > 0).collect();
    let font_features = sums(&feature_terms)?.into_iter().filter(|(_, n)| *n > 0).collect();
    let (of_kind, arg) = mode_where(mode, 1, "items");
    conn.query_row(
        &format!(
            "SELECT
           SUM(deleted_at IS NULL),
           SUM(deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM item_folders f WHERE f.item_id = items.id)),
           SUM(deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = items.id)),
           SUM(deleted_at IS NOT NULL),
           SUM(deleted_at IS NULL AND favorite = 1),
           SUM(deleted_at IS NULL AND pinned_at IS NOT NULL),
           SUM(deleted_at IS NULL AND EXISTS (SELECT 1 FROM tray WHERE tray.item_id = items.id))
         FROM items WHERE {of_kind}"
        ),
        [arg.as_ref()],
        |r| {
            Ok(Counts {
                all: r.get::<_, Option<i64>>(0)?.unwrap_or(0),
                unfiled: r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                untagged: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                trash: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                favorites: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                pinned: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                tray: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                kinds,
                font_scripts,
                font_categories,
                font_weights,
                font_features,
            })
        },
    )
}

// ------------------------------------------------------------- settings

/// Every setting of the library as JSON; values that don't parse are left out
/// (written by something else, read by an older or newer build).
pub fn library_settings(conn: &Connection) -> DbResult<BTreeMap<String, serde_json::Value>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (key, value) = row?;
        if let Ok(v) = serde_json::from_str(&value) {
            out.insert(key, v);
        }
    }
    Ok(out)
}

/// Stores a setting; `None` (or JSON null) removes it.
pub fn set_library_setting(conn: &Connection, key: &str, value: Option<&serde_json::Value>) -> DbResult<()> {
    match value.filter(|v| !v.is_null()) {
        Some(v) => conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, v.to_string()],
        )?,
        None => conn.execute("DELETE FROM settings WHERE key = ?1", [key])?,
    };
    Ok(())
}

/// The kinds the library is used for (the `modes` setting); None = all of
/// them. Kinds this build doesn't know are skipped.
pub fn used_kinds(conn: &Connection) -> DbResult<Option<Vec<Kind>>> {
    let value: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = 'modes'", [], |r| r.get(0))
        .optional()?;
    let names: Vec<String> = value.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default();
    let kinds: Vec<Kind> = [Kind::Image, Kind::Font, Kind::File, Kind::Text, Kind::Video, Kind::Bookmark]
        .into_iter()
        .filter(|k| names.iter().any(|n| n == k.as_str()))
        .collect();
    Ok((!kinds.is_empty()).then_some(kinds))
}

/// Total size of the files in the library (trash included).
pub fn total_size(conn: &Connection) -> DbResult<i64> {
    conn.query_row("SELECT COALESCE(SUM(size), 0) FROM items", [], |r| r.get(0))
}

// -------------------------------------------------------------- folders

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub count: i64,
    pub color: Option<String>,
    /// Shared on the local network (share.rs).
    pub shared: bool,
    pub mode: Mode,
}

/// The folders of `mode` (every folder when None); `count` is their live items.
pub fn list_folders(conn: &Connection, mode: Option<Mode>) -> DbResult<Vec<Folder>> {
    let mut stmt = conn.prepare(
        "SELECT f.id, f.parent_id, f.name,
           (SELECT COUNT(*) FROM item_folders x JOIN items i ON i.id = x.item_id
            WHERE x.folder_id = f.id AND i.deleted_at IS NULL AND (i.kind = 'font') = (f.mode = 'font')),
           f.color,
           EXISTS (SELECT 1 FROM shares s WHERE s.folder_id = f.id),
           f.mode
         FROM folders f WHERE ?1 IS NULL OR f.mode = ?1
         ORDER BY f.sort_order IS NULL, f.sort_order, f.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([mode.map(Mode::as_str)], |r| {
        Ok(Folder {
            id: r.get(0)?,
            parent_id: r.get(1)?,
            name: r.get(2)?,
            count: r.get(3)?,
            color: r.get(4)?,
            shared: r.get(5)?,
            mode: Mode::parse(&r.get::<_, String>(6)?),
        })
    })?;
    rows.collect()
}

/// Creates a folder of `mode` at the end of its siblings. A subfolder is of
/// its parent's mode, whatever `mode` says.
pub fn create_folder(conn: &Connection, name: &str, parent_id: Option<&str>, mode: Mode) -> DbResult<String> {
    let mode = match parent_id {
        Some(p) => folder_mode(conn, p)?.unwrap_or(mode),
        None => mode,
    };
    let id = uuid::Uuid::new_v4().simple().to_string();
    conn.execute(
        "INSERT INTO folders (id, parent_id, name, sort_order, mode) VALUES (?1, ?2, ?3,
           (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM folders WHERE parent_id IS ?2 AND mode = ?4), ?4)",
        params![id, parent_id, name, mode.as_str()],
    )?;
    Ok(id)
}

pub fn rename_folder(conn: &Connection, id: &str, name: &str) -> DbResult<()> {
    conn.execute("UPDATE folders SET name = ?2 WHERE id = ?1", params![id, name])?;
    Ok(())
}

/// Deletes the folder and its subfolders. Items themselves are kept.
pub fn delete_folder(conn: &Connection, id: &str) -> DbResult<()> {
    conn.execute("DELETE FROM folders WHERE id = ?1", params![id])?;
    Ok(())
}

/// Re-parents a folder (to the end of its new siblings). Returns false (and
/// does nothing) if that would create a cycle.
pub fn move_folder(conn: &mut Connection, id: &str, new_parent: Option<&str>) -> DbResult<bool> {
    place_folder(conn, id, new_parent, None)
}

fn would_cycle(conn: &Connection, id: &str, new_parent: Option<&str>) -> DbResult<bool> {
    let mut cur = new_parent.map(str::to_owned);
    while let Some(c) = cur {
        if c == id {
            return Ok(true);
        }
        cur = conn
            .query_row("SELECT parent_id FROM folders WHERE id = ?1", [&c], |r| {
                r.get::<_, Option<String>>(0)
            })
            .optional()?
            .flatten();
    }
    Ok(false)
}

/// The folders of `mode` under `parent` (the top level of each mode is its own).
fn sibling_ids(conn: &Connection, parent: Option<&str>, mode: Mode) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM folders WHERE parent_id IS ?1 AND mode = ?2
         ORDER BY sort_order IS NULL, sort_order, name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map(params![parent, mode.as_str()], |r| r.get(0))?;
    rows.collect()
}

fn renumber(conn: &Connection, ids: &[String]) -> DbResult<()> {
    let mut stmt = conn.prepare("UPDATE folders SET sort_order = ?2 WHERE id = ?1")?;
    for (i, id) in ids.iter().enumerate() {
        stmt.execute(params![id, (i + 1) as f64])?;
    }
    Ok(())
}

/// Puts a folder under `parent`, in front of sibling `before` (None = last).
/// Returns false (and does nothing) if that would create a cycle, or put it
/// under a folder of the other mode.
pub fn place_folder(
    conn: &mut Connection,
    id: &str,
    parent: Option<&str>,
    before: Option<&str>,
) -> DbResult<bool> {
    let Some(mode) = folder_mode(conn, id)? else { return Ok(false) };
    if would_cycle(conn, id, parent)? || parent.is_some_and(|p| folder_mode(conn, p).ok().flatten() != Some(mode)) {
        return Ok(false);
    }
    let tx = conn.transaction()?;
    tx.execute("UPDATE folders SET parent_id = ?2 WHERE id = ?1", params![id, parent])?;
    let mut order = sibling_ids(&tx, parent, mode)?;
    order.retain(|x| x != id);
    let at = before
        .and_then(|b| order.iter().position(|x| x == b))
        .unwrap_or(order.len());
    order.insert(at, id.to_owned());
    renumber(&tx, &order)?;
    tx.commit()?;
    Ok(true)
}

/// Moves a folder up (-1) / down (+1) among its siblings, or to the
/// top (`i32::MIN`) / bottom (`i32::MAX`).
pub fn shift_folder(conn: &mut Connection, id: &str, by: i32) -> DbResult<()> {
    let tx = conn.transaction()?;
    let (parent, mode): (Option<String>, String) =
        tx.query_row("SELECT parent_id, mode FROM folders WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let mut order = sibling_ids(&tx, parent.as_deref(), Mode::parse(&mode))?;
    if let Some(from) = order.iter().position(|x| x == id) {
        let item = order.remove(from);
        let to = (from as i64 + by as i64).clamp(0, order.len() as i64) as usize;
        order.insert(to, item);
        renumber(&tx, &order)?;
    }
    tx.commit()
}

/// Resets the children of `parent` (the top level of `mode` when None) to A→Z order.
pub fn sort_folders_by_name(conn: &mut Connection, parent: Option<&str>, mode: Mode) -> DbResult<()> {
    let tx = conn.transaction()?;
    let ids: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT id FROM folders WHERE parent_id IS ?1 AND (?1 IS NOT NULL OR mode = ?2)
             ORDER BY name COLLATE NOCASE, id",
        )?;
        let rows = stmt.query_map(params![parent, mode.as_str()], |r| r.get(0))?;
        rows.collect::<DbResult<_>>()?
    };
    renumber(&tx, &ids)?;
    tx.commit()
}

// -------------------------------------------------------- smart folders

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartFolder {
    pub id: String,
    pub name: String,
    pub rule: Rule,
    pub count: i64,
    pub color: Option<String>,
    pub mode: Mode,
}

fn load_rule(conn: &Connection, id: &str) -> DbResult<Option<Rule>> {
    let json: Option<String> = conn
        .query_row("SELECT rule FROM smart_folders WHERE id = ?1", [id], |r| r.get(0))
        .optional()?;
    Ok(json.map(|j| clean_rule(conn, serde_json::from_str(&j).unwrap_or_default())))
}

/// Drops references to tags that have since been deleted.
fn clean_rule(conn: &Connection, mut rule: Rule) -> Rule {
    rule.tag_ids.retain(|t| {
        conn.query_row("SELECT 1 FROM tags WHERE id = ?1", [t], |_| Ok(()))
            .optional()
            .ok()
            .flatten()
            .is_some()
    });
    rule
}

fn count_rule(conn: &Connection, rule: &Rule, mode: Option<Mode>) -> DbResult<i64> {
    let mut wheres = vec!["items.deleted_at IS NULL".to_string()];
    let mut args: Vec<Box<dyn ToSql>> = Vec::new();
    if let Some(m) = mode {
        wheres.push("(items.kind = 'font') = (? = 'font')".into());
        args.push(Box::new(m.as_str()));
    }
    push_rule(rule, &mut wheres, &mut args);
    conn.query_row(
        &format!("SELECT COUNT(*) FROM items WHERE {}", wheres.join(" AND ")),
        params_from_iter(args.iter().map(|b| b.as_ref())),
        |r| r.get(0),
    )
}

/// The smart folders of `mode` (every one when None); `count` is their live
/// matches among the items of their mode.
pub fn list_smart_folders(conn: &Connection, mode: Option<Mode>) -> DbResult<Vec<SmartFolder>> {
    let rows: Vec<(String, String, String, Option<String>, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, name, rule, color, mode FROM smart_folders WHERE ?1 IS NULL OR mode = ?1
             ORDER BY sort_order, name",
        )?;
        let rows = stmt.query_map([mode.map(Mode::as_str)], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?;
        rows.collect::<DbResult<_>>()?
    };
    rows.into_iter()
        .map(|(id, name, json, color, mode)| {
            let rule = clean_rule(conn, serde_json::from_str(&json).unwrap_or_default());
            let mode = Mode::parse(&mode);
            let count = count_rule(conn, &rule, Some(mode))?;
            Ok(SmartFolder { id, name, rule, count, color, mode })
        })
        .collect()
}

pub fn create_smart_folder(conn: &Connection, name: &str, rule: &Rule, mode: Mode) -> DbResult<String> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    conn.execute(
        "INSERT INTO smart_folders (id, name, rule, sort_order, mode)
         VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM smart_folders), ?4)",
        params![id, name, serde_json::to_string(rule).unwrap_or_default(), mode.as_str()],
    )?;
    Ok(id)
}

pub fn update_smart_folder(
    conn: &Connection,
    id: &str,
    name: Option<&str>,
    rule: Option<&Rule>,
) -> DbResult<()> {
    if let Some(n) = name {
        conn.execute("UPDATE smart_folders SET name = ?2 WHERE id = ?1", params![id, n])?;
    }
    if let Some(r) = rule {
        conn.execute(
            "UPDATE smart_folders SET rule = ?2 WHERE id = ?1",
            params![id, serde_json::to_string(r).unwrap_or_default()],
        )?;
    }
    Ok(())
}

pub fn delete_smart_folder(conn: &Connection, id: &str) -> DbResult<()> {
    conn.execute("DELETE FROM smart_folders WHERE id = ?1", [id])?;
    Ok(())
}

/// File types in the library with counts (live items of `mode`, when given), for the filter bar.
pub fn list_exts(conn: &Connection, mode: Option<Mode>) -> DbResult<Vec<(String, i64)>> {
    let (of_kind, arg) = mode_where(mode, 1, "items");
    let mut stmt = conn.prepare(&format!(
        "SELECT lower(ext), COUNT(*) FROM items WHERE deleted_at IS NULL AND {of_kind} GROUP BY lower(ext)"
    ))?;
    let rows = stmt.query_map([arg.as_ref()], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    let mut merged: Vec<(String, i64)> = Vec::new();
    for row in rows {
        let (ext, n) = row?;
        let ext = canonical_ext(&ext);
        match merged.iter_mut().find(|(e, _)| *e == ext) {
            Some((_, c)) => *c += n,
            None => merged.push((ext, n)),
        }
    }
    merged.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    Ok(merged)
}

/// The items among `ids` that can go into `folder_id`: those of its mode.
fn of_folder_mode(conn: &Connection, ids: &[String], folder_id: &str) -> DbResult<Vec<String>> {
    let Some(mode) = folder_mode(conn, folder_id)? else { return Ok(vec![]) };
    Ok(by_mode(conn, ids)?.into_iter().filter(|(m, _)| *m == mode).flat_map(|(_, v)| v).collect())
}

/// Puts items into a folder (taking them out of the one they were in); they
/// go to the end of its manual order. Items already there stay where they are,
/// and items of the other mode aren't moved (a folder holds its mode's only).
pub fn move_to_folder(conn: &Connection, item_ids: &[String], folder_id: &str) -> DbResult<()> {
    place_in_folder(conn, &with_linked(conn, item_ids)?, folder_id)
}

/// `move_to_folder` for `item_ids` as they are (see `with_linked`).
pub(crate) fn place_in_folder(conn: &Connection, item_ids: &[String], folder_id: &str) -> DbResult<()> {
    let item_ids = of_folder_mode(conn, item_ids, folder_id)?;
    let mut del = conn.prepare("DELETE FROM item_folders WHERE item_id = ?1 AND folder_id != ?2")?;
    for id in &item_ids {
        del.execute(params![id, folder_id])?;
    }
    file_unfiled(conn, &item_ids, folder_id)
}

/// Like `move_to_folder`, but leaves items that already have a folder alone.
pub fn file_unfiled(conn: &Connection, item_ids: &[String], folder_id: &str) -> DbResult<()> {
    let item_ids = of_folder_mode(conn, item_ids, folder_id)?;
    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO item_folders (item_id, folder_id, position)
         VALUES (?1, ?2, (SELECT COALESCE(MAX(position), 0) + 1 FROM item_folders WHERE folder_id = ?2))",
    )?;
    for id in &item_ids {
        stmt.execute(params![id, folder_id])?;
    }
    Ok(())
}

/// Moves `ids` (in the given order) in front of `before`, or to the end.
pub fn reorder_in_folder(
    conn: &mut Connection,
    folder_id: &str,
    ids: &[String],
    before: Option<&str>,
) -> DbResult<()> {
    let tx = conn.transaction()?;
    let mut order: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT item_id FROM item_folders WHERE folder_id = ?1
             ORDER BY position IS NULL, position, rowid",
        )?;
        let rows = stmt.query_map([folder_id], |r| r.get(0))?;
        rows.collect::<DbResult<_>>()?
    };
    let moving: Vec<String> = ids.iter().filter(|id| order.contains(id)).cloned().collect();
    order.retain(|id| !moving.contains(id));
    let at = before
        .and_then(|b| order.iter().position(|id| id == b))
        .unwrap_or(order.len());
    order.splice(at..at, moving);
    {
        let mut stmt =
            tx.prepare("UPDATE item_folders SET position = ?3 WHERE item_id = ?1 AND folder_id = ?2")?;
        for (i, id) in order.iter().enumerate() {
            stmt.execute(params![id, folder_id, (i + 1) as f64])?;
        }
    }
    tx.commit()
}

/// Returns the child folder called `name` under `parent` (at the top of
/// `mode` when None), creating it if needed.
pub fn find_or_create_folder(conn: &Connection, parent: Option<&str>, name: &str, mode: Mode) -> DbResult<String> {
    let existing = conn
        .query_row(
            "SELECT id FROM folders WHERE name = ?1 AND parent_id IS ?2 AND (?2 IS NOT NULL OR mode = ?3)",
            params![name, parent, mode.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    match existing {
        Some(id) => Ok(id),
        None => create_folder(conn, name, parent, mode),
    }
}

pub fn remove_from_folder(conn: &Connection, item_ids: &[String], folder_id: &str) -> DbResult<()> {
    let mut stmt = conn.prepare("DELETE FROM item_folders WHERE item_id = ?1 AND folder_id = ?2")?;
    for id in &with_linked(conn, item_ids)? {
        stmt.execute(params![id, folder_id])?;
    }
    Ok(())
}

// ---------------------------------------------------------------- links

/// Parent–child links (docs/LINKS.md): a parent (say a video) with children
/// (its thumbnail ideas). The library opts in with the `links` setting; off,
/// there are no links (turning it off clears them, `clear_links`).
pub fn links_enabled(conn: &Connection) -> DbResult<bool> {
    let on: Option<String> =
        conn.query_row("SELECT value FROM settings WHERE key = 'links'", [], |r| r.get(0)).optional()?;
    Ok(on.as_deref() == Some("true"))
}

/// Where a child stood before a change of links, to put it back (the toast's undo).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub id: String,
    pub parent_id: Option<String>,
    pub folder_id: Option<String>,
    pub adopted: bool,
}

fn placement(conn: &Connection, id: &str) -> DbResult<Placement> {
    Ok(Placement {
        id: id.to_string(),
        parent_id: conn.query_row("SELECT parent_id FROM items WHERE id = ?1", [id], |r| r.get(0))?,
        adopted: conn.query_row("SELECT adopted FROM items WHERE id = ?1", [id], |r| r.get::<_, i64>(0))? != 0,
        folder_id: conn
            .query_row("SELECT folder_id FROM item_folders WHERE item_id = ?1", [id], |r| r.get(0))
            .optional()?,
    })
}

/// Sets the folder of `id` (None = unfiled), as `move_to_folder` does.
fn set_folder(conn: &Connection, id: &str, folder: Option<&str>) -> DbResult<()> {
    match folder {
        Some(f) => place_in_folder(conn, std::slice::from_ref(&id.to_string()), f),
        None => {
            conn.execute("DELETE FROM item_folders WHERE item_id = ?1", [id])?;
            Ok(())
        }
    }
}

/// `ids` as a folder change should treat them: a child only moves with its
/// parent (alone it stays where its parent is), and a parent takes its
/// children along.
pub(crate) fn with_linked(conn: &Connection, ids: &[String]) -> DbResult<Vec<String>> {
    let mut parent_of = conn.prepare_cached("SELECT parent_id FROM items WHERE id = ?1")?;
    let mut children_of = conn.prepare_cached("SELECT id FROM items WHERE parent_id = ?1")?;
    let picked: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let parent: Option<String> = parent_of.query_row([id], |r| r.get(0)).optional()?.flatten();
        if parent.is_some_and(|p| !picked.contains(p.as_str())) {
            continue;
        }
        if seen.insert(id.clone()) {
            out.push(id.clone());
        }
        for child in children_of.query_map([id], |r| r.get::<_, String>(0))? {
            let child = child?;
            if seen.insert(child.clone()) {
                out.push(child);
            }
        }
    }
    Ok(out)
}

/// Makes `children` children of `parent`; each goes to the parent's folder.
/// Skipped: the parent itself, anything in the trash, a parent (one level
/// only), fonts, and a `parent` that is a child or in the trash.
/// Returns where the linked children stood, for the undo.
pub fn link_items(conn: &Connection, parent: &str, children: &[String]) -> DbResult<Vec<Placement>> {
    let row = |id: &str| -> DbResult<Option<(Mode, Option<String>, bool)>> {
        conn.query_row("SELECT kind, parent_id, deleted_at IS NOT NULL FROM items WHERE id = ?1", [id], |r| {
            Ok((Mode::of(Kind::parse(&r.get::<_, String>(0)?)), r.get(1)?, r.get(2)?))
        })
        .optional()
    };
    let Some((mode, parent_of_parent, trashed)) = row(parent)? else { return Ok(vec![]) };
    // Fonts have their families instead (docs/FONT_UI.md).
    if parent_of_parent.is_some() || trashed || mode != Mode::Stock {
        return Ok(vec![]);
    }
    let folder: Option<String> = conn
        .query_row("SELECT folder_id FROM item_folders WHERE item_id = ?1", [parent], |r| r.get(0))
        .optional()?;
    let has_children = |id: &str| -> DbResult<bool> {
        conn.query_row("SELECT EXISTS (SELECT 1 FROM items WHERE parent_id = ?1)", [id], |r| r.get(0))
    };
    let mut moved = Vec::new();
    for id in children {
        if id == parent || has_children(id)? {
            continue;
        }
        match row(id)? {
            Some((m, _, false)) if m == mode => {}
            _ => continue,
        }
        moved.push(placement(conn, id)?);
        conn.execute("UPDATE items SET parent_id = ?2, adopted = 0 WHERE id = ?1", params![id, parent])?;
        set_folder(conn, id, folder.as_deref())?;
    }
    Ok(moved)
}

/// Takes `ids` out of their parents; they stay in the folder they are in.
/// Returns what they were, for the undo.
pub fn unlink_items(conn: &Connection, ids: &[String]) -> DbResult<Vec<Placement>> {
    let mut out = Vec::new();
    for id in ids {
        let p = placement(conn, id)?;
        if p.parent_id.is_some() {
            conn.execute("UPDATE items SET parent_id = NULL, adopted = 0 WHERE id = ?1", [id])?;
            out.push(p);
        }
    }
    Ok(out)
}

/// Makes the child `id` its family's parent: its parent and its other
/// children (the trashed ones too) become its children. They are all in one
/// folder already, so nothing moves. The adopted mark of `id` goes (a parent
/// has none); the others keep theirs. Returns where each one stood, for the
/// undo (`restore_links`); empty when `id` isn't a child.
pub fn make_parent(conn: &Connection, id: &str) -> DbResult<Vec<Placement>> {
    let parent: Option<String> =
        conn.query_row("SELECT parent_id FROM items WHERE id = ?1", [id], |r| r.get(0)).optional()?.flatten();
    let Some(parent) = parent else { return Ok(vec![]) };
    let siblings: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM items WHERE parent_id = ?1 AND id != ?2 ORDER BY id")?;
        let rows = stmt.query_map([&parent, id], |r| r.get(0))?;
        rows.collect::<DbResult<_>>()?
    };
    let mut was = vec![placement(conn, id)?, placement(conn, &parent)?];
    for s in &siblings {
        was.push(placement(conn, s)?);
    }
    conn.execute("UPDATE items SET parent_id = NULL, adopted = 0 WHERE id = ?1", [id])?;
    conn.execute("UPDATE items SET parent_id = ?2, adopted = 0 WHERE id = ?1", params![parent, id])?;
    conn.execute("UPDATE items SET parent_id = ?2 WHERE parent_id = ?1", params![parent, id])?;
    Ok(was)
}

/// Puts children back as `link_items` / `unlink_items` found them.
pub fn restore_links(conn: &Connection, placements: &[Placement]) -> DbResult<()> {
    for p in placements {
        conn.execute(
            "UPDATE items SET parent_id = ?2, adopted = ?3 WHERE id = ?1",
            params![p.id, p.parent_id, p.adopted],
        )?;
        set_folder(conn, &p.id, p.folder_id.as_deref())?;
    }
    Ok(())
}

/// How many links there are (children, trash included).
pub fn count_links(conn: &Connection) -> DbResult<i64> {
    conn.query_row("SELECT COUNT(*) FROM items WHERE parent_id IS NOT NULL", [], |r| r.get(0))
}

/// Turns the links on or off. Off removes every link (the children stay where
/// they are, as plain items); returns how many were removed.
pub fn set_links_enabled(conn: &Connection, on: bool) -> DbResult<i64> {
    if on {
        set_library_setting(conn, "links", Some(&serde_json::Value::Bool(true)))?;
        return Ok(0);
    }
    let n = count_links(conn)?;
    conn.execute("UPDATE items SET parent_id = NULL, adopted = 0 WHERE parent_id IS NOT NULL", [])?;
    set_library_setting(conn, "links", None)?;
    Ok(n)
}

/// What the library does with the children of a parent put in the trash: they go
/// along (the default) or are kept, as plain items (`linksTrash` = "keep").
pub fn links_trash_keeps_children(conn: &Connection) -> DbResult<bool> {
    let v: Option<String> =
        conn.query_row("SELECT value FROM settings WHERE key = 'linksTrash'", [], |r| r.get(0)).optional()?;
    Ok(v.as_deref() == Some("\"keep\""))
}

/// Picks `id`, a child, as the one adopted among its parent's children (the others
/// are not), or takes the pick back. No effect on an item that isn't a child.
pub fn set_adopted(conn: &Connection, id: &str, on: bool) -> DbResult<()> {
    let parent: Option<String> =
        conn.query_row("SELECT parent_id FROM items WHERE id = ?1", [id], |r| r.get(0)).optional()?.flatten();
    let Some(parent) = parent else { return Ok(()) };
    if on {
        conn.execute("UPDATE items SET adopted = 0 WHERE parent_id = ?1", [&parent])?;
    }
    conn.execute("UPDATE items SET adopted = ?2 WHERE id = ?1", params![id, on])?;
    Ok(())
}

/// `ids` and the live children of any of them (each id once, `ids` first).
pub fn with_children(conn: &Connection, ids: &[String]) -> DbResult<Vec<String>> {
    let mut out: Vec<String> = ids.to_vec();
    let mut seen: HashSet<String> = ids.iter().cloned().collect();
    let mut stmt = conn.prepare_cached("SELECT id FROM items WHERE parent_id = ?1 AND deleted_at IS NULL")?;
    for id in ids {
        for child in stmt.query_map([id], |r| r.get::<_, String>(0))? {
            let child = child?;
            if seen.insert(child.clone()) {
                out.push(child);
            }
        }
    }
    Ok(out)
}

/// Copies of a duplicate about to be trashed: their children go to the copy kept
/// (`link_items`), or are freed when it can't be their parent (it is a child, a font…).
fn hand_over_children(conn: &Connection, keep: &str, removed: &[String]) -> DbResult<()> {
    // The kept copy isn't a child of one it replaces.
    conn.execute(
        &format!("UPDATE items SET parent_id = NULL, adopted = 0 WHERE id = ?1 AND parent_id {IN_IDS}"),
        params![keep, ids_param(removed)],
    )?;
    for gone in removed {
        let children: Vec<String> = {
            let mut stmt = conn.prepare("SELECT id FROM items WHERE parent_id = ?1")?;
            let rows = stmt.query_map([gone], |r| r.get(0))?;
            rows.collect::<DbResult<_>>()?
        };
        if children.is_empty() {
            continue;
        }
        link_items(conn, keep, &children)?;
        // Whatever it couldn't take is freed.
        conn.execute("UPDATE items SET parent_id = NULL, adopted = 0 WHERE parent_id = ?1", [gone])?;
    }
    Ok(())
}

/// A list's parents that only a child of them put there (with links on): the
/// parent comes just before its first child, marked `via_child`.
fn add_parents(conn: &Connection, items: &mut Vec<Item>) -> DbResult<()> {
    let present: HashSet<&str> = items.iter().map(|i| i.id.as_str()).collect();
    let mut missing: Vec<String> = items
        .iter()
        .filter_map(|i| i.parent_id.clone())
        .filter(|p| !present.contains(p.as_str()))
        .collect();
    missing.sort();
    missing.dedup();
    if missing.is_empty() {
        return Ok(());
    }
    let mut parents: HashMap<String, Item> = get_items(conn, &missing)?
        .into_iter()
        .filter(|p| p.deleted_at.is_none())
        .map(|mut p| {
            p.via_child = true;
            (p.id.clone(), p)
        })
        .collect();
    let old = std::mem::take(items);
    for it in old {
        if let Some(p) = it.parent_id.as_ref().and_then(|id| parents.remove(id)) {
            items.push(p);
        }
        items.push(it);
    }
    Ok(())
}

// ----------------------------------------------------------------- tags

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub count: i64,
    pub color: Option<String>,
    pub mode: Mode,
}

/// The tags of `mode` (every tag when None); `count` is their live items.
pub fn list_tags(conn: &Connection, mode: Option<Mode>) -> DbResult<Vec<Tag>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name,
           (SELECT COUNT(*) FROM item_tags x JOIN items i ON i.id = x.item_id
            WHERE x.tag_id = t.id AND i.deleted_at IS NULL AND (i.kind = 'font') = (t.mode = 'font')),
           t.color, t.mode
         FROM tags t WHERE ?1 IS NULL OR t.mode = ?1 ORDER BY t.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([mode.map(Mode::as_str)], tag_row)?;
    rows.collect()
}

fn tag_row(r: &rusqlite::Row) -> DbResult<Tag> {
    Ok(Tag {
        id: r.get(0)?,
        name: r.get(1)?,
        count: r.get(2)?,
        color: r.get(3)?,
        mode: Mode::parse(&r.get::<_, String>(4)?),
    })
}

/// Colours a folder, smart folder or tag can take (the UI maps them to shades).
pub const COLORS: [&str; 9] = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "gray"];

#[derive(Debug, Clone, Copy)]
pub enum ColorTarget {
    Folder,
    SmartFolder,
    Tag,
}

/// Sets (or with `None`, clears) the colour of a folder, smart folder or tag.
pub fn set_color(conn: &Connection, target: ColorTarget, id: &dyn ToSql, color: Option<&str>) -> DbResult<()> {
    if let Some(c) = color {
        if !COLORS.contains(&c) {
            return Err(rusqlite::Error::InvalidParameterName(format!("unknown colour: {c}")));
        }
    }
    let table = match target {
        ColorTarget::Folder => "folders",
        ColorTarget::SmartFolder => "smart_folders",
        ColorTarget::Tag => "tags",
    };
    conn.execute(&format!("UPDATE {table} SET color = ?1 WHERE id = ?2"), params![color, id])?;
    Ok(())
}

/// The tag `name` of `mode`, if there is one.
pub(crate) fn tag_id(conn: &Connection, name: &str, mode: Mode) -> DbResult<Option<i64>> {
    conn.query_row("SELECT id FROM tags WHERE name = ?1 AND mode = ?2", params![name, mode.as_str()], |r| r.get(0))
        .optional()
}

/// The tag `name` of `mode`, made if there isn't one.
pub(crate) fn ensure_tag(conn: &Connection, name: &str, mode: Mode) -> DbResult<i64> {
    conn.execute("INSERT OR IGNORE INTO tags (name, mode) VALUES (?1, ?2)", params![name, mode.as_str()])?;
    conn.query_row("SELECT id FROM tags WHERE name = ?1 AND mode = ?2", params![name, mode.as_str()], |r| r.get(0))
}

/// Tags items by name, each with the tag of its own mode (made where missing).
pub fn add_tags(conn: &mut Connection, item_ids: &[String], names: &[String]) -> DbResult<()> {
    let tx = conn.transaction()?;
    let groups = by_mode(&tx, item_ids)?;
    for name in names.iter().map(|n| n.trim()).filter(|n| !n.is_empty()) {
        for (mode, ids) in &groups {
            let tag_id = ensure_tag(&tx, name, *mode)?;
            let mut stmt =
                tx.prepare_cached("INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?1, ?2)")?;
            for id in ids {
                stmt.execute(params![id, tag_id])?;
            }
        }
    }
    tx.commit()
}

pub fn remove_tag(conn: &Connection, item_ids: &[String], tag_id: i64) -> DbResult<()> {
    let mut stmt = conn.prepare("DELETE FROM item_tags WHERE item_id = ?1 AND tag_id = ?2")?;
    for id in item_ids {
        stmt.execute(params![id, tag_id])?;
    }
    Ok(())
}

/// Renames a tag. If another tag of its mode already has that name, the two are merged.
pub fn rename_tag(conn: &mut Connection, id: i64, name: &str) -> DbResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    let existing: Option<i64> = tx
        .query_row(
            "SELECT id FROM tags WHERE name = ?1 AND id != ?2 AND mode = (SELECT mode FROM tags WHERE id = ?2)",
            params![name, id],
            |r| r.get(0),
        )
        .optional()?;
    match existing {
        Some(target) => {
            tx.execute(
                "INSERT OR IGNORE INTO item_tags (item_id, tag_id)
                 SELECT item_id, ?2 FROM item_tags WHERE tag_id = ?1",
                params![id, target],
            )?;
            tx.execute("DELETE FROM tags WHERE id = ?1", [id])?;
            merge_rule_tag(&tx, id, target)?;
        }
        None => {
            tx.execute("UPDATE tags SET name = ?2 WHERE id = ?1", params![id, name])?;
        }
    }
    tx.commit()
}

/// Smart-folder rules on tag `from` now use `to` (merged into it). The JSON
/// is edited in place, so fields this build doesn't know are kept.
fn merge_rule_tag(conn: &Connection, from: i64, to: i64) -> DbResult<()> {
    let rows: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT id, rule FROM smart_folders")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<DbResult<_>>()?
    };
    for (id, json) in rows {
        let Ok(mut rule) = serde_json::from_str::<serde_json::Value>(&json) else { continue };
        let Some(tags) = rule.get_mut("tagIds").and_then(|t| t.as_array_mut()) else { continue };
        if !tags.iter().any(|t| t.as_i64() == Some(from)) {
            continue;
        }
        tags.retain(|t| t.as_i64() != Some(from));
        if !tags.iter().any(|t| t.as_i64() == Some(to)) {
            tags.push(to.into());
        }
        conn.execute("UPDATE smart_folders SET rule = ?2 WHERE id = ?1", params![id, rule.to_string()])?;
    }
    Ok(())
}

pub fn delete_tag(conn: &Connection, id: i64) -> DbResult<()> {
    conn.execute("DELETE FROM tags WHERE id = ?1", [id])?;
    Ok(())
}

// ------------------------------------------------------------ selection

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderRef {
    pub id: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionInfo {
    /// Tags present on at least one selected item; `count` = how many of them.
    pub tags: Vec<Tag>,
    pub folders: Vec<FolderRef>,
}

pub fn selection_info(conn: &Connection, ids: &[String]) -> DbResult<SelectionInfo> {
    if ids.is_empty() {
        return Ok(SelectionInfo { tags: vec![], folders: vec![] });
    }
    let ids = ids_param(ids);
    let mut stmt = conn.prepare(&format!(
        "SELECT t.id, t.name, COUNT(*), t.color, t.mode FROM item_tags x JOIN tags t ON t.id = x.tag_id
         WHERE x.item_id {IN_IDS} GROUP BY t.id ORDER BY t.name COLLATE NOCASE"
    ))?;
    let tags = stmt.query_map([&ids], tag_row)?.collect::<DbResult<Vec<_>>>()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT folder_id, COUNT(*) FROM item_folders WHERE item_id {IN_IDS} GROUP BY folder_id"
    ))?;
    let folders = stmt
        .query_map([&ids], |r| {
            Ok(FolderRef {
                id: r.get(0)?,
                count: r.get(1)?,
            })
        })?
        .collect::<DbResult<Vec<_>>>()?;
    Ok(SelectionInfo { tags, folders })
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn add(conn: &mut Connection, id: &str, name: &str, at: i64) {
        let tx = conn.transaction().unwrap();
        insert_item(
            &tx,
            &NewItem {
                id: id.into(),
                kind: Kind::Image,
                name: name.into(),
                file_name: name.into(),
                ext: "png".into(),
                width: 10,
                height: 10,
                size: at,
                hash: format!("h-{id}"),
                thumb: format!("{id}.jpg"),
                phash: None,
                preview: None,
                font: None,
                body: None,
                duration_ms: None,
            },
            at,
        )
        .unwrap();
        tx.commit().unwrap();
    }

    fn q(view: View) -> ItemQuery {
        ItemQuery {
            view,
            search: String::new(),
            tag_ids: vec![],
            tag_match_all: false,
            include_subfolders: false,
            min_rating: 0,
            filter: Filter::default(),
            similar_level: similar::Level::Standard,
            with_parents: false,
            sort: SortKey::ImportedAt,
            desc: false,
        }
    }

    fn ids(items: Vec<Item>) -> Vec<String> {
        items.into_iter().map(|i| i.id).collect()
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    // ------------------------------------------------------------ links

    fn links_on(conn: &Connection) {
        set_links_enabled(conn, true).unwrap();
    }

    fn folder_of_item(conn: &Connection, id: &str) -> Option<String> {
        get_items(conn, &s(&[id])).unwrap().remove(0).folder_id
    }

    #[test]
    fn links_are_off_until_turned_on() {
        let conn = mem();
        assert!(!links_enabled(&conn).unwrap());
        links_on(&conn);
        assert!(links_enabled(&conn).unwrap());
    }

    #[test]
    fn linking_moves_children_to_the_parents_folder() {
        let mut conn = mem();
        links_on(&conn);
        for (id, at) in [("v", 1), ("t1", 2), ("t2", 3)] {
            add(&mut conn, id, id, at);
        }
        let f = create_folder(&conn, "動画", None, Mode::Stock).unwrap();
        let g = create_folder(&conn, "案", None, Mode::Stock).unwrap();
        move_to_folder(&conn, &s(&["v"]), &f).unwrap();
        move_to_folder(&conn, &s(&["t1"]), &g).unwrap();

        let before = link_items(&conn, "v", &s(&["t1", "t2", "v"])).unwrap();
        // The parent itself is skipped; the undo notes where the children were.
        assert_eq!(
            before,
            vec![
                Placement { id: "t1".into(), parent_id: None, folder_id: Some(g.clone()), adopted: false },
                Placement { id: "t2".into(), parent_id: None, folder_id: None, adopted: false },
            ]
        );
        assert_eq!(folder_of_item(&conn, "t1"), Some(f.clone()));
        assert_eq!(folder_of_item(&conn, "t2"), Some(f.clone()));
        assert_eq!(count_links(&conn).unwrap(), 2);

        restore_links(&conn, &before).unwrap();
        assert_eq!(folder_of_item(&conn, "t1"), Some(g));
        assert_eq!(folder_of_item(&conn, "t2"), None);
        assert_eq!(count_links(&conn).unwrap(), 0);
    }

    #[test]
    fn links_stay_one_level_and_in_one_mode() {
        let mut conn = mem();
        links_on(&conn);
        for (id, at) in [("a", 1), ("b", 2), ("c", 3)] {
            add(&mut conn, id, id, at);
        }
        link_items(&conn, "a", &s(&["b"])).unwrap();
        // A child can't be a parent, and a parent can't become a child.
        assert!(link_items(&conn, "b", &s(&["c"])).unwrap().is_empty());
        assert!(link_items(&conn, "c", &s(&["a"])).unwrap().is_empty());
        // Linking to another parent moves the child over.
        let moved = link_items(&conn, "c", &s(&["b"])).unwrap();
        assert_eq!(moved[0].parent_id.as_deref(), Some("a"));
        assert_eq!(get_items(&conn, &s(&["b"])).unwrap()[0].parent_id.as_deref(), Some("c"));

        // A font is another mode.
        let tx = conn.transaction().unwrap();
        let mut font = NewItem {
            id: "f".into(),
            kind: Kind::Font,
            name: "f".into(),
            file_name: "f.ttf".into(),
            ext: "ttf".into(),
            width: 0,
            height: 0,
            size: 1,
            hash: "h-f".into(),
            thumb: "f.png".into(),
            phash: None,
            preview: None,
            font: None,
            body: None,
            duration_ms: None,
        };
        font.id = "f".into();
        insert_item(&tx, &font, 9).unwrap();
        tx.commit().unwrap();
        assert!(link_items(&conn, "c", &s(&["f"])).unwrap().is_empty());
    }

    #[test]
    fn a_child_can_take_its_parents_place() {
        let mut conn = mem();
        links_on(&conn);
        for (id, at) in [("v", 1), ("a", 2), ("b", 3), ("c", 4), ("x", 5)] {
            add(&mut conn, id, id, at);
        }
        let f = create_folder(&conn, "F", None, Mode::Stock).unwrap();
        move_to_folder(&conn, &s(&["v"]), &f).unwrap();
        link_items(&conn, "v", &s(&["a", "b", "c"])).unwrap();
        set_adopted(&conn, "c", true).unwrap();
        trash_items(&conn, &s(&["b"])).unwrap();
        let parent_of = |id: &str| get_items(&conn, &s(&[id])).unwrap().remove(0).parent_id;
        let adopted = |id: &str| get_items(&conn, &s(&[id])).unwrap().remove(0).adopted;

        // Not a child: nothing happens.
        assert!(make_parent(&conn, "x").unwrap().is_empty());
        assert!(make_parent(&conn, "v").unwrap().is_empty());

        let was = make_parent(&conn, "a").unwrap();
        assert_eq!(parent_of("a"), None);
        assert_eq!(parent_of("v"), Some("a".into()));
        // The trashed child goes along too: the old parent can't keep one.
        assert_eq!((parent_of("b"), parent_of("c")), (Some("a".into()), Some("a".into())));
        assert!(adopted("c"), "the other children keep their marks");
        assert_eq!(folder_of_item(&conn, "a"), Some(f.clone()));
        assert_eq!(folder_of_item(&conn, "v"), Some(f.clone()));

        // The new parent's own mark goes.
        let was2 = make_parent(&conn, "c").unwrap();
        assert!(!adopted("c"));
        assert_eq!(parent_of("a"), Some("c".into()));
        restore_links(&conn, &was2).unwrap();
        assert!(adopted("c"));
        restore_links(&conn, &was).unwrap();
        assert_eq!(parent_of("v"), None);
        for id in ["a", "b", "c"] {
            assert_eq!(parent_of(id), Some("v".into()));
        }
    }

    #[test]
    fn parents_only_lists_the_items_with_children() {
        let mut conn = mem();
        links_on(&conn);
        for (id, at) in [("v", 1), ("t", 2), ("w", 3), ("u", 4), ("x", 5)] {
            add(&mut conn, id, id, at);
        }
        link_items(&conn, "v", &s(&["t"])).unwrap();
        link_items(&conn, "w", &s(&["u"])).unwrap();
        // A parent whose only child is in the trash isn't one in the list.
        trash_items(&conn, &s(&["u"])).unwrap();
        let mut parents = q(View::All);
        parents.filter.parents_only = true;
        // The children stay, to go under their parents' rows.
        assert_eq!(ids(query_items(&conn, &parents).unwrap()), s(&["v", "t"]));
        assert_eq!(facet_counts(&conn, &q(View::All)).unwrap().parents, 1);
        // Both in the trash: a parent there.
        trash_items(&conn, &s(&["w"])).unwrap();
        parents.view = View::Trash;
        assert_eq!(ids(query_items(&conn, &parents).unwrap()), s(&["w"]));
    }

    #[test]
    fn a_child_moves_only_with_its_parent() {
        let mut conn = mem();
        links_on(&conn);
        for (id, at) in [("v", 1), ("t", 2), ("x", 3)] {
            add(&mut conn, id, id, at);
        }
        let f = create_folder(&conn, "F", None, Mode::Stock).unwrap();
        let g = create_folder(&conn, "G", None, Mode::Stock).unwrap();
        move_to_folder(&conn, &s(&["v"]), &f).unwrap();
        link_items(&conn, "v", &s(&["t"])).unwrap();

        // The child alone stays; the parent takes it along.
        move_to_folder(&conn, &s(&["t"]), &g).unwrap();
        assert_eq!(folder_of_item(&conn, "t"), Some(f.clone()));
        move_to_folder(&conn, &s(&["v", "x"]), &g).unwrap();
        assert_eq!(folder_of_item(&conn, "t"), Some(g.clone()));
        assert_eq!(folder_of_item(&conn, "v"), Some(g.clone()));
        remove_from_folder(&conn, &s(&["v"]), &g).unwrap();
        assert_eq!(folder_of_item(&conn, "t"), None);

        // Unlinked, the child is an item like any other.
        unlink_items(&conn, &s(&["t"])).unwrap();
        move_to_folder(&conn, &s(&["t"]), &f).unwrap();
        assert_eq!(folder_of_item(&conn, "t"), Some(f));
    }

    #[test]
    fn the_trash_takes_children_along_and_gives_them_back() {
        let mut conn = mem();
        links_on(&conn);
        for (id, at) in [("v", 1), ("t", 2), ("o", 3)] {
            add(&mut conn, id, id, at);
        }
        link_items(&conn, "v", &s(&["t"])).unwrap();
        trash_items(&conn, &s(&["v"])).unwrap();
        assert_eq!(ids(query_items(&conn, &q(View::All)).unwrap()), s(&["o"]));
        assert_eq!(ids(query_items(&conn, &q(View::Trash)).unwrap()), s(&["v", "t"]));
        restore_items(&conn, &s(&["v"])).unwrap();
        assert_eq!(ids(query_items(&conn, &q(View::All)).unwrap()), s(&["v", "t", "o"]));

        // Deleting the parent for good frees the child.
        delete_items(&conn, &s(&["v"])).unwrap();
        assert_eq!(get_items(&conn, &s(&["t"])).unwrap()[0].parent_id, None);
    }

    #[test]
    fn a_matching_child_brings_its_parent_into_the_list() {
        let mut conn = mem();
        links_on(&conn);
        for (id, at) in [("v", 1), ("t1", 2), ("t2", 3), ("o", 4)] {
            add(&mut conn, id, id, at);
        }
        link_items(&conn, "v", &s(&["t1", "t2"])).unwrap();
        set_favorite(&conn, &s(&["t2"]), true).unwrap();
        let mut query = q(View::Favorites);
        // Asked for, the parent comes first and says why it is there.
        query.with_parents = true;
        let list = query_items(&conn, &query).unwrap();
        assert_eq!(ids(list.clone()), s(&["v", "t2"]));
        assert!(list[0].via_child && !list[1].via_child);
        // Not asked for (exports, the shelf), nothing is added.
        query.with_parents = false;
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["t2"]));
        // Off, there are no links.
        query.with_parents = true;
        assert_eq!(set_links_enabled(&conn, false).unwrap(), 2);
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["t2"]));
        assert_eq!(count_links(&conn).unwrap(), 0);
        assert!(!links_enabled(&conn).unwrap());
    }

    #[test]
    fn one_child_is_adopted_and_the_pick_follows_the_links() {
        let mut conn = mem();
        links_on(&conn);
        for (id, at) in [("v", 1), ("a", 2), ("b", 3), ("x", 4)] {
            add(&mut conn, id, id, at);
        }
        link_items(&conn, "v", &s(&["a", "b"])).unwrap();
        let adopted = |conn: &Connection| -> Vec<String> {
            let mut got: Vec<String> = get_items(conn, &s(&["v", "a", "b", "x"]))
                .unwrap()
                .into_iter()
                .filter(|i| i.adopted)
                .map(|i| i.id)
                .collect();
            got.sort();
            got
        };
        set_adopted(&conn, "a", true).unwrap();
        set_adopted(&conn, "b", true).unwrap();
        assert_eq!(adopted(&conn), s(&["b"]), "one per parent");
        // Not a child: nothing to adopt.
        set_adopted(&conn, "x", true).unwrap();
        set_adopted(&conn, "v", true).unwrap();
        assert_eq!(adopted(&conn), s(&["b"]));
        // Freeing the child takes the pick with it, and the undo gives it back.
        let was = unlink_items(&conn, &s(&["b"])).unwrap();
        assert!(adopted(&conn).is_empty());
        restore_links(&conn, &was).unwrap();
        assert_eq!(adopted(&conn), s(&["b"]));
        set_adopted(&conn, "b", false).unwrap();
        assert!(adopted(&conn).is_empty());
    }

    #[test]
    fn the_library_can_keep_the_children_of_a_trashed_parent() {
        let mut conn = mem();
        links_on(&conn);
        for (id, at) in [("v", 1), ("t", 2), ("u", 3)] {
            add(&mut conn, id, id, at);
        }
        link_items(&conn, "v", &s(&["t", "u"])).unwrap();
        set_library_setting(&conn, "linksTrash", Some(&serde_json::json!("keep"))).unwrap();
        // A child picked together with its parent goes along and stays linked.
        trash_items(&conn, &s(&["v", "u"])).unwrap();
        assert_eq!(ids(query_items(&conn, &q(View::All)).unwrap()), s(&["t"]));
        let t = get_items(&conn, &s(&["t", "u"])).unwrap();
        assert_eq!(t.iter().find(|i| i.id == "t").unwrap().parent_id, None);
        assert_eq!(t.iter().find(|i| i.id == "u").unwrap().parent_id.as_deref(), Some("v"));
    }

    #[test]
    fn duplicates_hand_their_children_to_the_copy_kept() {
        let mut conn = mem();
        links_on(&conn);
        for (id, at) in [("keep", 1), ("dup", 2), ("t", 3)] {
            add(&mut conn, id, id, at);
        }
        let f = create_folder(&conn, "F", None, Mode::Stock).unwrap();
        move_to_folder(&conn, &s(&["dup"]), &f).unwrap();
        link_items(&conn, "dup", &s(&["t"])).unwrap();
        resolve_duplicates(&mut conn, &[DuplicateGroup { keep: "keep".into(), remove: s(&["dup"]) }]).unwrap();
        let t = get_items(&conn, &s(&["t"])).unwrap().remove(0);
        assert_eq!(t.parent_id.as_deref(), Some("keep"));
        assert!(t.deleted_at.is_none(), "the child is not trashed with the duplicate");
        // The folder the duplicate gave the kept copy comes with the child.
        assert_eq!(folder_of_item(&conn, "keep"), Some(f.clone()));
        assert_eq!(folder_of_item(&conn, "t"), Some(f));
    }

    #[test]
    fn dismissed_group_leaves_similar_view() {
        let mut conn = mem();
        for (id, at) in [("a", 1), ("b", 2), ("c", 3)] {
            add(&mut conn, id, id, at);
        }
        let hashes = |ids: &[&str]| -> Vec<(String, (u64, u32))> {
            ids.iter().map(|i| (i.to_string(), (0x1234u64, 0u32))).collect()
        };
        set_phashes(&mut conn, &hashes(&["a", "b", "c"])).unwrap();
        let groups = |conn: &Connection| query_items(conn, &q(View::Similar)).unwrap().len();
        assert_eq!(groups(&conn), 3);
        assert_eq!(dismissed_duplicate_groups(&conn).unwrap(), 0);

        dismiss_duplicates(&mut conn, &s(&["c", "a", "b"])).unwrap();
        assert_eq!(groups(&conn), 0);
        assert_eq!(dismissed_duplicate_groups(&conn).unwrap(), 1);
        // Dismissing again changes nothing; a single id is a no-op.
        dismiss_duplicates(&mut conn, &s(&["a", "b"])).unwrap();
        dismiss_duplicates(&mut conn, &s(&["a"])).unwrap();
        assert_eq!(dismissed_duplicate_groups(&conn).unwrap(), 1);

        // A new look-alike is proposed together with the old members.
        add(&mut conn, "d", "d", 4);
        set_phashes(&mut conn, &hashes(&["d"])).unwrap();
        assert_eq!(groups(&conn), 4);

        undismiss_duplicates(&conn, &s(&["a", "b", "c"])).unwrap();
        assert_eq!(dismissed_duplicate_groups(&conn).unwrap(), 0);
        assert_eq!(groups(&conn), 4);

        dismiss_duplicates(&mut conn, &s(&["a", "b", "c", "d"])).unwrap();
        assert_eq!(groups(&conn), 0);
        clear_dismissed_duplicates(&conn).unwrap();
        assert_eq!(dismissed_duplicate_groups(&conn).unwrap(), 0);
        assert_eq!(groups(&conn), 4);
    }

    #[test]
    fn migrate_is_idempotent() {
        let conn = mem();
        migrate(&conn).unwrap();
        let v: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
    }

    #[test]
    fn views_and_counts() {
        let mut conn = mem();
        add(&mut conn, "a", "cat.png", 1);
        add(&mut conn, "b", "dog.png", 2);
        add(&mut conn, "c", "bird.png", 3);
        let f = create_folder(&conn, "Animals", None, Mode::Stock).unwrap();
        move_to_folder(&conn, &s(&["a"]), &f).unwrap();
        add_tags(&mut conn, &s(&["b"]), &s(&["cute"])).unwrap();
        trash_items(&conn, &s(&["c"])).unwrap();

        assert_eq!(ids(query_items(&conn, &q(View::All)).unwrap()), s(&["a", "b"]));
        assert_eq!(ids(query_items(&conn, &q(View::Unfiled)).unwrap()), s(&["b"]));
        assert_eq!(ids(query_items(&conn, &q(View::Untagged)).unwrap()), s(&["a"]));
        assert_eq!(ids(query_items(&conn, &q(View::Trash)).unwrap()), s(&["c"]));
        assert_eq!(
            ids(query_items(&conn, &q(View::Folder { id: f.clone() })).unwrap()),
            s(&["a"])
        );
        assert_eq!(
            counts(&conn, None).unwrap(),
            Counts {
                all: 2,
                unfiled: 1,
                untagged: 1,
                trash: 1,
                favorites: 0,
                pinned: 0,
                tray: 0,
                kinds: BTreeMap::from([(Kind::Image, 2)]),
                font_scripts: BTreeMap::new(),
                font_categories: BTreeMap::new(),
                font_weights: BTreeMap::new(),
                font_features: BTreeMap::new(),
            }
        );

        restore_items(&conn, &s(&["c"])).unwrap();
        assert_eq!(counts(&conn, None).unwrap().trash, 0);
        assert_eq!(counts(&conn, None).unwrap().all, 3);
    }

    #[test]
    fn resolve_duplicates_merges_into_keeper() {
        let mut conn = mem();
        add(&mut conn, "a", "a.png", 1);
        add(&mut conn, "b", "b.png", 2);
        add(&mut conn, "c", "c.png", 3);
        let f = create_folder(&conn, "F", None, Mode::Stock).unwrap();
        move_to_folder(&conn, &s(&["b"]), &f).unwrap();
        add_tags(&mut conn, &s(&["b"]), &s(&["x"])).unwrap();
        add_tags(&mut conn, &s(&["c"]), &s(&["y"])).unwrap();
        set_rating(&conn, &s(&["c"]), 4).unwrap();

        let group = [DuplicateGroup { keep: "a".into(), remove: s(&["b", "c"]) }];
        let planned = plan_duplicates(&conn, &group).unwrap();
        assert_eq!(planned[0].added_tags, ["x", "y"]);
        assert_eq!((planned[0].rating, planned[0].folder_id.as_deref()), (Some(4), Some(f.as_str())));
        assert_eq!(counts(&conn, None).unwrap().all, 3, "planning changes nothing");

        let done = resolve_duplicates(&mut conn, &group).unwrap();
        assert_eq!(done, planned);
        assert_eq!(ids(query_items(&conn, &q(View::All)).unwrap()), s(&["a"]));
        assert_eq!(ids(query_items(&conn, &q(View::Folder { id: f })).unwrap()), s(&["a"]));
        let info = selection_info(&conn, &s(&["a"])).unwrap();
        let mut names: Vec<_> = info.tags.iter().map(|t| t.name.as_str()).collect();
        names.sort();
        assert_eq!(names, ["x", "y"]);
        assert_eq!(get_items(&conn, &s(&["a"])).unwrap()[0].rating, 4);
        assert_eq!(counts(&conn, None).unwrap().trash, 2);
    }

    #[test]
    fn duplicates_keep_their_own_folder_and_rating() {
        let mut conn = mem();
        add(&mut conn, "a", "a.png", 1);
        add(&mut conn, "b", "b.png", 2);
        let (f, g) = (create_folder(&conn, "F", None, Mode::Stock).unwrap(), create_folder(&conn, "G", None, Mode::Stock).unwrap());
        move_to_folder(&conn, &s(&["a"]), &f).unwrap();
        move_to_folder(&conn, &s(&["b"]), &g).unwrap();
        set_rating(&conn, &s(&["a"]), 5).unwrap();
        set_rating(&conn, &s(&["b"]), 2).unwrap();
        let e = &plan_duplicates(&conn, &[DuplicateGroup { keep: "a".into(), remove: s(&["b"]) }]).unwrap()[0];
        assert_eq!((e.rating, e.folder_id.clone(), e.added_tags.len()), (None, None, 0));
    }

    #[test]
    fn colours_folders_smart_folders_and_tags() {
        let mut conn = mem();
        add(&mut conn, "a", "a.png", 1);
        let f = create_folder(&conn, "F", None, Mode::Stock).unwrap();
        let sf = create_smart_folder(&conn, "S", &Rule::default(), Mode::Stock).unwrap();
        add_tags(&mut conn, &s(&["a"]), &s(&["t"])).unwrap();
        let tag = list_tags(&conn, None).unwrap()[0].id;
        set_color(&conn, ColorTarget::Folder, &f, Some("red")).unwrap();
        set_color(&conn, ColorTarget::SmartFolder, &sf, Some("blue")).unwrap();
        set_color(&conn, ColorTarget::Tag, &tag, Some("green")).unwrap();
        assert_eq!(list_folders(&conn, None).unwrap()[0].color.as_deref(), Some("red"));
        assert_eq!(list_smart_folders(&conn, None).unwrap()[0].color.as_deref(), Some("blue"));
        assert_eq!(list_tags(&conn, None).unwrap()[0].color.as_deref(), Some("green"));
        assert_eq!(selection_info(&conn, &s(&["a"])).unwrap().tags[0].color.as_deref(), Some("green"));
        set_color(&conn, ColorTarget::Folder, &f, None).unwrap();
        assert_eq!(list_folders(&conn, None).unwrap()[0].color, None);
        assert!(set_color(&conn, ColorTarget::Folder, &f, Some("chartreuse")).is_err());
    }

    #[test]
    fn an_item_lives_in_one_folder() {
        let mut conn = mem();
        add(&mut conn, "a", "a.png", 1);
        let (f, g) = (create_folder(&conn, "F", None, Mode::Stock).unwrap(), create_folder(&conn, "G", None, Mode::Stock).unwrap());
        move_to_folder(&conn, &s(&["a"]), &f).unwrap();
        move_to_folder(&conn, &s(&["a"]), &f).unwrap(); // same folder again: no-op
        move_to_folder(&conn, &s(&["a"]), &g).unwrap();
        assert_eq!(ids(query_items(&conn, &q(View::Folder { id: f.clone() })).unwrap()), Vec::<String>::new());
        assert_eq!(ids(query_items(&conn, &q(View::Folder { id: g.clone() })).unwrap()), s(&["a"]));
        file_unfiled(&conn, &s(&["a"]), &f).unwrap(); // already filed: stays in G
        assert_eq!(ids(query_items(&conn, &q(View::Folder { id: g })).unwrap()), s(&["a"]));
        remove_from_folder(&conn, &s(&["a"]), &f).unwrap(); // not in F: no-op
        assert_eq!(counts(&conn, None).unwrap().unfiled, 0);
    }

    #[test]
    fn migration_keeps_only_the_first_folder() {
        let mut conn = mem();
        conn.execute_batch("PRAGMA user_version = 4; DROP INDEX IF EXISTS idx_item_folders_item;").unwrap();
        add(&mut conn, "a", "a.png", 1);
        let (f, g) = (create_folder(&conn, "F", None, Mode::Stock).unwrap(), create_folder(&conn, "G", None, Mode::Stock).unwrap());
        for folder in [&f, &g] {
            conn.execute("INSERT INTO item_folders (item_id, folder_id, position) VALUES ('a', ?, 1)", [folder])
                .unwrap();
        }
        migrate(&conn).unwrap();
        assert_eq!(ids(query_items(&conn, &q(View::Folder { id: f })).unwrap()), s(&["a"]));
        assert!(query_items(&conn, &q(View::Folder { id: g })).unwrap().is_empty());
    }

    #[test]
    fn tag_filter_any_or_all() {
        let mut conn = mem();
        add(&mut conn, "a", "a.png", 1);
        add(&mut conn, "b", "b.png", 2);
        add(&mut conn, "c", "c.png", 3);
        add_tags(&mut conn, &s(&["a", "b"]), &s(&["red"])).unwrap();
        add_tags(&mut conn, &s(&["b", "c"]), &s(&["blue"])).unwrap();
        let tags = list_tags(&conn, None).unwrap();
        let id = |n: &str| tags.iter().find(|t| t.name == n).unwrap().id;

        let mut query = q(View::All);
        query.tag_ids = vec![id("red"), id("blue")];
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["a", "b", "c"]));
        query.tag_match_all = true;
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["b"]));
    }

    #[test]
    fn search_tags_and_sort() {
        let mut conn = mem();
        add(&mut conn, "a", "Cat_1.png", 1);
        add(&mut conn, "b", "dog.png", 2);
        add(&mut conn, "c", "cat%2.png", 3);
        add_tags(&mut conn, &s(&["b", "c"]), &s(&["pet", "Animal"])).unwrap();
        set_note(&conn, "b", "fluffy friend").unwrap();

        let mut query = q(View::All);
        query.search = "cat".into();
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["a", "c"]));
        query.search = "%".into(); // LIKE wildcard must be escaped
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["c"]));
        query.search = "fluffy".into(); // note
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["b"]));
        query.search = "anim".into(); // tag name
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["b", "c"]));

        let tags = list_tags(&conn, None).unwrap();
        assert_eq!(tags.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["Animal", "pet"]);
        let pet = tags.iter().find(|t| t.name == "pet").unwrap().id;
        remove_tag(&conn, &s(&["c"]), pet).unwrap();
        let mut query = q(View::All);
        query.tag_ids = vec![pet];
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["b"]));

        let mut query = q(View::All);
        query.sort = SortKey::Name;
        query.desc = true;
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["b", "a", "c"])); // "_" > "%"
    }

    #[test]
    fn tag_rename_merges() {
        let mut conn = mem();
        add(&mut conn, "a", "a.png", 1);
        add(&mut conn, "b", "b.png", 2);
        add_tags(&mut conn, &s(&["a"]), &s(&["red"])).unwrap();
        add_tags(&mut conn, &s(&["a", "b"]), &s(&["Rouge"])).unwrap();
        let red = list_tags(&conn, None).unwrap().into_iter().find(|t| t.name == "red").unwrap();
        rename_tag(&mut conn, red.id, "rouge").unwrap(); // case-insensitive clash
        let tags = list_tags(&conn, None).unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].count, 2);
    }

    #[test]
    fn folder_tree_ops() {
        let mut conn = mem();
        add(&mut conn, "a", "a.png", 1);
        let p = create_folder(&conn, "Parent", None, Mode::Stock).unwrap();
        let c = create_folder(&conn, "Child", Some(&p), Mode::Stock).unwrap();
        move_to_folder(&conn, &s(&["a"]), &c).unwrap();

        assert!(!move_folder(&mut conn, &p, Some(&c)).unwrap(), "cycle must be rejected");
        assert!(!move_folder(&mut conn, &p, Some(&p)).unwrap());
        assert!(move_folder(&mut conn, &c, None).unwrap());
        assert!(move_folder(&mut conn, &c, Some(&p)).unwrap());

        let info = selection_info(&conn, &s(&["a"])).unwrap();
        assert_eq!(info.folders, vec![FolderRef { id: c.clone(), count: 1 }]);

        delete_folder(&conn, &p).unwrap(); // cascades to child
        assert!(list_folders(&conn, None).unwrap().is_empty());
        assert_eq!(counts(&conn, None).unwrap().unfiled, 1);
        assert_eq!(counts(&conn, None).unwrap().all, 1);
    }

    #[test]
    fn delete_cascades_links() {
        let mut conn = mem();
        add(&mut conn, "a", "a.png", 1);
        add_tags(&mut conn, &s(&["a"]), &s(&["x"])).unwrap();
        trash_items(&conn, &s(&["a"])).unwrap();
        assert_eq!(trashed_ids(&conn).unwrap(), s(&["a"]));
        let removed = delete_items(&conn, &s(&["a"])).unwrap();
        assert_eq!(removed.len(), 1);
        let links: i64 = conn.query_row("SELECT COUNT(*) FROM item_tags", [], |r| r.get(0)).unwrap();
        assert_eq!(links, 0);
        assert!(hash_index(&conn).unwrap().is_empty());
    }

    #[test]
    fn migrates_v1_library() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        // A library created by v0.1.0 (schema 1) with one filed item.
        conn.execute_batch(
            "CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, file_name TEXT NOT NULL,
               ext TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL,
               hash TEXT NOT NULL, thumb TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
               imported_at INTEGER NOT NULL, deleted_at INTEGER);
             CREATE TABLE folders (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE, name TEXT NOT NULL);
             CREATE TABLE item_folders (item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
               folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE, PRIMARY KEY (item_id, folder_id));
             CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
             CREATE TABLE item_tags (item_id TEXT NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (item_id, tag_id));
             INSERT INTO items VALUES ('a','a.png','a.png','png',1,1,1,'h','a.jpg','',1,NULL);
             INSERT INTO folders VALUES ('f',NULL,'F');
             INSERT INTO item_folders VALUES ('a','f');
             PRAGMA user_version = 1;",
        )
        .unwrap();
        migrate(&conn).unwrap();
        let mut query = q(View::Folder { id: "f".into() });
        query.sort = SortKey::Manual;
        let items = query_items(&conn, &query).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].rating, 0);
    }

    #[test]
    fn files_saved_from_the_web_are_not_handed_to_office() {
        let conn = mem();
        conn.execute_batch(
            "INSERT INTO items (id, name, file_name, ext, width, height, size, hash, thumb, imported_at, kind, source_url)
             VALUES ('own', 'a.docx', 'a.docx', 'docx', 0, 0, 1, 'h1', 't.jpg', 1, 'file', NULL),
                    ('web', 'b.docx', 'b.docx', 'docx', 0, 0, 1, 'h2', 't.jpg', 2, 'file', 'https://example.com/')",
        )
        .unwrap();
        let ids: Vec<String> = files_of_types(&conn, &["docx"]).unwrap().into_iter().map(|f| f.0).collect();
        assert_eq!(ids, ["own"]);
    }

    #[test]
    fn id_lists_past_the_parameter_limit() {
        let mut conn = mem();
        // More than SQLite's 32766 parameters.
        let ids: Vec<String> = (0..40_000).map(|i| format!("i{i}")).collect();
        let tx = conn.transaction().unwrap();
        {
            let mut stmt = tx
                .prepare("INSERT INTO items (id, name, file_name, ext, width, height, size, hash, thumb, imported_at)
                          VALUES (?1, 'n', 'n.png', 'png', 1, 1, 1, ?1, 't.jpg', 1)")
                .unwrap();
            for id in &ids {
                stmt.execute([id]).unwrap();
            }
        }
        tx.commit().unwrap();
        add_tags(&mut conn, &ids[..2], &s(&["x"])).unwrap();

        assert_eq!(get_items(&conn, &ids).unwrap().len(), ids.len());
        assert_eq!(selection_info(&conn, &ids).unwrap().tags[0].count, 2);
        trash_items(&conn, &ids).unwrap();
        assert_eq!(trashed_ids(&conn).unwrap().len(), ids.len());
        restore_items(&conn, &ids).unwrap();
        assert!(trashed_ids(&conn).unwrap().is_empty());
        assert_eq!(delete_items(&conn, &ids).unwrap().len(), ids.len());
        assert!(query_items(&conn, &q(View::All)).unwrap().is_empty());
    }

    #[test]
    fn tag_ids_are_never_reused() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        // Tags as schema 1 made them (no AUTOINCREMENT), with taggings.
        conn.execute_batch(
            "CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, file_name TEXT NOT NULL,
               ext TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL,
               hash TEXT NOT NULL, thumb TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
               imported_at INTEGER NOT NULL, deleted_at INTEGER);
             CREATE TABLE folders (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE, name TEXT NOT NULL);
             CREATE TABLE item_folders (item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
               folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE, PRIMARY KEY (item_id, folder_id));
             CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
             CREATE TABLE item_tags (
               item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
               tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
               PRIMARY KEY (item_id, tag_id));
             INSERT INTO items VALUES ('a','a.png','a.png','png',1,1,1,'h','a.jpg','',1,NULL);
             INSERT INTO tags VALUES (1,'x'), (2,'y');
             INSERT INTO item_tags VALUES ('a',1), ('a',2);
             PRAGMA user_version = 1;",
        )
        .unwrap();
        migrate(&conn).unwrap();
        // The taggings survived making the tables again.
        let links: Vec<(String, i64)> = conn
            .prepare("SELECT item_id, tag_id FROM item_tags ORDER BY tag_id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<DbResult<_>>()
            .unwrap();
        assert_eq!(links, [("a".to_string(), 1), ("a".to_string(), 2)]);
        // Still cascading, and the highest id isn't handed out again.
        delete_tag(&conn, 2).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM item_tags", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(ensure_tag(&conn, "z", Mode::Stock).unwrap(), 3);
        delete_tag(&conn, 3).unwrap();
        assert_eq!(ensure_tag(&conn, "w", Mode::Stock).unwrap(), 4);
        // Running the step again (an older build lowered the version) keeps everything.
        conn.pragma_update(None, "user_version", 16).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(ensure_tag(&conn, "x", Mode::Stock).unwrap(), 1);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM item_tags", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn ratings_sort_and_filter() {
        let mut conn = mem();
        add(&mut conn, "a", "a.png", 1);
        add(&mut conn, "b", "b.png", 2);
        add(&mut conn, "c", "c.png", 3);
        set_rating(&conn, &s(&["a"]), 3).unwrap();
        set_rating(&conn, &s(&["c"]), 9).unwrap(); // clamped to 5
        let mut query = q(View::All);
        query.sort = SortKey::Rating;
        query.desc = true;
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["c", "a", "b"]));
        assert_eq!(query_items(&conn, &query).unwrap()[0].rating, 5);
        query.min_rating = 3;
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["c", "a"]));
    }

    #[test]
    fn favorites_and_pins() {
        let mut conn = mem();
        add(&mut conn, "a", "a.png", 1);
        add(&mut conn, "b", "b.png", 2);
        add(&mut conn, "c", "c.png", 3);
        set_favorite(&conn, &s(&["b"]), true).unwrap();
        assert_eq!(ids(query_items(&conn, &q(View::Favorites)).unwrap()), s(&["b"]));
        assert!(query_items(&conn, &q(View::Favorites)).unwrap()[0].favorite);
        set_favorite(&conn, &s(&["b"]), false).unwrap();
        assert!(query_items(&conn, &q(View::Favorites)).unwrap().is_empty());

        // Pinned items lead every list, latest pin first; the rest keep the sort.
        set_pinned(&conn, &s(&["c"]), true).unwrap();
        let first = query_items(&conn, &q(View::Pinned)).unwrap()[0].pinned_at;
        set_pinned(&conn, &s(&["c"]), true).unwrap(); // no-op, keeps its time
        assert_eq!(query_items(&conn, &q(View::Pinned)).unwrap()[0].pinned_at, first);
        conn.execute("UPDATE items SET pinned_at = pinned_at - 10 WHERE id = 'c'", []).unwrap();
        set_pinned(&conn, &s(&["a"]), true).unwrap();
        assert_eq!(ids(query_items(&conn, &q(View::All)).unwrap()), s(&["a", "c", "b"]));
        assert_eq!(ids(query_items(&conn, &q(View::Pinned)).unwrap()), s(&["a", "c"]));
        assert_eq!(counts(&conn, None).unwrap().pinned, 2);
        set_pinned(&conn, &s(&["a", "c"]), false).unwrap();
        assert_eq!(ids(query_items(&conn, &q(View::All)).unwrap()), s(&["a", "b", "c"]));
        assert_eq!(counts(&conn, None).unwrap().pinned, 0);
    }

    #[test]
    fn library_settings_round_trip() {
        let conn = mem();
        assert!(library_settings(&conn).unwrap().is_empty());
        assert_eq!(used_kinds(&conn).unwrap(), None);

        let modes = serde_json::json!(["font", "audio", "image"]);
        set_library_setting(&conn, "modes", Some(&modes)).unwrap();
        set_library_setting(&conn, "lastMode", Some(&serde_json::json!("font"))).unwrap();
        // Unknown kinds are skipped, the order is the app's.
        assert_eq!(used_kinds(&conn).unwrap(), Some(vec![Kind::Image, Kind::Font]));
        let all = library_settings(&conn).unwrap();
        assert_eq!(all["modes"], modes);
        assert_eq!(all["lastMode"], "font");

        // Overwrite, then remove with null; broken JSON is ignored.
        set_library_setting(&conn, "lastMode", Some(&serde_json::json!("image"))).unwrap();
        assert_eq!(library_settings(&conn).unwrap()["lastMode"], "image");
        set_library_setting(&conn, "lastMode", Some(&serde_json::Value::Null)).unwrap();
        set_library_setting(&conn, "modes", None).unwrap();
        conn.execute("INSERT INTO settings VALUES ('broken', '{')", []).unwrap();
        assert!(library_settings(&conn).unwrap().is_empty());
        assert_eq!(used_kinds(&conn).unwrap(), None);
        // Only unknown kinds = none chosen = all.
        set_library_setting(&conn, "modes", Some(&serde_json::json!(["audio"]))).unwrap();
        assert_eq!(used_kinds(&conn).unwrap(), None);
    }

    #[test]
    fn work_tray() {
        let mut conn = mem();
        for (id, at) in [("a", 1), ("b", 2), ("c", 3), ("d", 4)] {
            add(&mut conn, id, id, at);
        }
        let manual = |conn: &Connection| {
            let mut query = q(View::Tray);
            query.sort = SortKey::Manual;
            ids(query_items(conn, &query).unwrap())
        };
        // Added in the given order, after what is already there; no duplicates.
        assert_eq!(add_to_tray(&conn, &s(&["c", "a"])).unwrap(), 2);
        assert_eq!(add_to_tray(&conn, &s(&["a", "b", "zz"])).unwrap(), 1);
        assert_eq!(manual(&conn), s(&["c", "a", "b"]));
        assert_eq!(ids(query_items(&conn, &q(View::Tray)).unwrap()), s(&["a", "b", "c"]));
        assert!(query_items(&conn, &q(View::All)).unwrap().iter().any(|i| i.id == "a" && i.in_tray));
        assert!(!query_items(&conn, &q(View::All)).unwrap().iter().any(|i| i.id == "d" && i.in_tray));
        assert_eq!(counts(&conn, None).unwrap().tray, 3);

        // The tray's own order ignores pins (it is the order things are handled in).
        set_pinned(&conn, &s(&["b"]), true).unwrap();
        assert_eq!(manual(&conn), s(&["c", "a", "b"]));
        reorder_tray(&mut conn, &s(&["b"]), Some("c")).unwrap();
        assert_eq!(manual(&conn), s(&["b", "c", "a"]));
        reorder_tray(&mut conn, &s(&["b", "c"]), None).unwrap();
        assert_eq!(manual(&conn), s(&["a", "b", "c"]));

        // Trashed items leave the tray view but come back when restored.
        trash_items(&conn, &s(&["a"])).unwrap();
        assert_eq!(manual(&conn), s(&["b", "c"]));
        assert_eq!(counts(&conn, None).unwrap().tray, 2);
        restore_items(&conn, &s(&["a"])).unwrap();

        remove_from_tray(&conn, &s(&["b"])).unwrap();
        assert_eq!(manual(&conn), s(&["a", "c"]));
        assert_eq!(clear_tray(&conn).unwrap(), s(&["a", "c"]));
        assert!(manual(&conn).is_empty());
        assert_eq!(counts(&conn, None).unwrap().tray, 0);
    }

    #[test]
    fn installed_fonts_share_the_shelf() {
        let mut conn = mem();
        for (id, at) in [("a", 1), ("b", 2)] {
            add(&mut conn, id, id, at);
        }
        let sys = |ids: &[&str]| ids.iter().map(|i| (i.to_string(), format!("{i} name"))).collect::<Vec<_>>();
        // One order across items and installed fonts, each added after what is there.
        add_to_tray(&conn, &s(&["a"])).unwrap();
        assert_eq!(add_system_to_tray(&conn, &sys(&["sys:x", "sys:y"])).unwrap(), 2);
        assert_eq!(add_system_to_tray(&conn, &sys(&["sys:x"])).unwrap(), 0, "no duplicates");
        add_to_tray(&conn, &s(&["b"])).unwrap();
        assert_eq!(tray_order(&conn).unwrap(), s(&["a", "sys:x", "sys:y", "b"]));
        assert_eq!(system_tray(&conn).unwrap(), sys(&["sys:x", "sys:y"]));

        reorder_tray(&mut conn, &s(&["b", "sys:y"]), Some("a")).unwrap();
        assert_eq!(tray_order(&conn).unwrap(), s(&["b", "sys:y", "a", "sys:x"]));
        remove_from_tray(&conn, &s(&["sys:y", "a"])).unwrap();
        assert_eq!(tray_order(&conn).unwrap(), s(&["b", "sys:x"]));
        // The items' own shelf (the font mode merges in the installed ones) and its count.
        assert_eq!(counts(&conn, None).unwrap().tray, 1);
        assert_eq!(clear_tray(&conn).unwrap(), s(&["b", "sys:x"]));
        assert!(tray_order(&conn).unwrap().is_empty() && system_tray(&conn).unwrap().is_empty());
    }

    #[test]
    fn items_carry_folder_and_tags() {
        let mut conn = mem();
        add(&mut conn, "a", "a.png", 1);
        add(&mut conn, "b", "b.png", 2);
        let f = create_folder(&conn, "F", None, Mode::Stock).unwrap();
        move_to_folder(&conn, &s(&["a"]), &f).unwrap();
        add_tags(&mut conn, &s(&["a"]), &s(&["x", "y"])).unwrap();
        let items = query_items(&conn, &q(View::All)).unwrap();
        assert_eq!(items[0].folder_id.as_deref(), Some(f.as_str()));
        assert_eq!(items[0].tag_ids.len(), 2);
        assert_eq!(items[1].folder_id, None);
        assert!(items[1].tag_ids.is_empty());
    }

    #[test]
    fn search_syntax_end_to_end() {
        let mut conn = mem();
        add(&mut conn, "a", "black cat.png", 1);
        add(&mut conn, "b", "black dog.png", 2);
        add(&mut conn, "c", "white cat.png", 3);
        add_tags(&mut conn, &s(&["c"]), &s(&["pet store"])).unwrap();
        let find = |conn: &Connection, text: &str| {
            let mut query = q(View::All);
            query.search = text.into();
            ids(query_items(conn, &query).unwrap())
        };
        assert_eq!(find(&conn, "(cat OR dog) black"), s(&["a", "b"]));
        assert_eq!(find(&conn, "cat -black"), s(&["c"]));
        assert_eq!(find(&conn, "dog || white"), s(&["b", "c"]));
        assert_eq!(find(&conn, r#""pet store""#), s(&["c"]));
        assert_eq!(find(&conn, "-cat -dog"), Vec::<String>::new());
    }

    #[test]
    fn subfolders_and_manual_order() {
        let mut conn = mem();
        for (i, id) in ["a", "b", "c", "d"].iter().enumerate() {
            add(&mut conn, id, &format!("{id}.png"), i as i64);
        }
        let p = create_folder(&conn, "P", None, Mode::Stock).unwrap();
        let c = create_folder(&conn, "C", Some(&p), Mode::Stock).unwrap();
        let g = create_folder(&conn, "G", Some(&c), Mode::Stock).unwrap();
        move_to_folder(&conn, &s(&["a", "b", "c"]), &p).unwrap();
        move_to_folder(&conn, &s(&["d"]), &g).unwrap();

        let mut query = q(View::Folder { id: p.clone() });
        query.sort = SortKey::Manual;
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["a", "b", "c"]));
        query.include_subfolders = true;
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["a", "b", "c", "d"]));

        query.include_subfolders = false;
        reorder_in_folder(&mut conn, &p, &s(&["c"]), Some("a")).unwrap();
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["c", "a", "b"]));
        reorder_in_folder(&mut conn, &p, &s(&["c", "a"]), None).unwrap();
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["b", "c", "a"]));
        // Newly added items go to the end.
        move_to_folder(&conn, &s(&["d"]), &p).unwrap();
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["b", "c", "a", "d"]));
    }

    #[test]
    fn find_or_create_reuses() {
        let conn = mem();
        let a = find_or_create_folder(&conn, None, "Photos", Mode::Stock).unwrap();
        assert_eq!(find_or_create_folder(&conn, None, "Photos", Mode::Stock).unwrap(), a);
        let child = find_or_create_folder(&conn, Some(&a), "Photos", Mode::Stock).unwrap();
        assert_ne!(child, a, "same name under a different parent is a different folder");
        assert_eq!(find_or_create_folder(&conn, Some(&a), "Photos", Mode::Stock).unwrap(), child);
    }

    #[test]
    fn attribute_filters() {
        let mut conn = mem();
        // add() makes 10x10 png items; adjust per item.
        for (id, ext, w, h, size, at) in [
            ("a", "JPEG", 1200, 800, 500_000, 1_000),
            ("b", "png", 600, 900, 50_000, 2_000),
            ("c", "png", 500, 510, 5_000_000, 3_000),
            ("d", "tif", 100, 100, 10, 4_000),
        ] {
            add(&mut conn, id, &format!("{id}.{ext}"), at);
            conn.execute(
                "UPDATE items SET ext = ?2, width = ?3, height = ?4, size = ?5 WHERE id = ?1",
                params![id, ext, w, h, size],
            )
            .unwrap();
        }
        let find = |conn: &Connection, f: Filter| {
            let mut query = q(View::All);
            query.filter = f;
            ids(query_items(conn, &query).unwrap())
        };
        let f = |set: fn(&mut Filter)| {
            let mut f = Filter::default();
            set(&mut f);
            f
        };
        assert_eq!(find(&conn, f(|f| f.exts = vec!["jpg".into()])), s(&["a"]), "jpg matches .JPEG");
        assert_eq!(find(&conn, f(|f| f.exts = vec!["tiff".into(), "png".into()])), s(&["b", "c", "d"]));
        assert_eq!(find(&conn, f(|f| f.shapes = vec![Shape::Landscape])), s(&["a"]));
        assert_eq!(find(&conn, f(|f| f.shapes = vec![Shape::Portrait])), s(&["b"]));
        assert_eq!(find(&conn, f(|f| f.shapes = vec![Shape::Square])), s(&["c", "d"]), "within 5%");
        assert_eq!(find(&conn, f(|f| f.min_width = Some(600))), s(&["a", "b"]));
        assert_eq!(find(&conn, f(|f| { f.min_height = Some(500); f.max_height = Some(850) })), s(&["a", "c"]));
        assert_eq!(find(&conn, f(|f| { f.imported_after = Some(2_000); f.imported_before = Some(4_000) })), s(&["b", "c"]));
        assert_eq!(find(&conn, f(|f| f.max_size = Some(50_000))), s(&["b", "d"]));
        assert_eq!(find(&conn, f(|f| f.min_size = Some(1_000_000))), s(&["c"]));
        conn.execute("UPDATE items SET kind = 'font', width = 0, height = 0 WHERE id = 'd'", []).unwrap();
        assert_eq!(find(&conn, f(|f| f.kinds = vec![Kind::Font])), s(&["d"]));
        assert_eq!(find(&conn, f(|f| f.kinds = vec![Kind::Image])), s(&["a", "b", "c"]));
        assert_eq!(find(&conn, f(|f| f.kinds = vec![Kind::Image, Kind::Font])).len(), 4);
        assert_eq!(counts(&conn, None).unwrap().kinds, BTreeMap::from([(Kind::Image, 3), (Kind::Font, 1)]));

        // Fonts by writing system and style; the user's style wins over the guess.
        conn.execute("UPDATE items SET font_script = 'ja', font_category = 'gothic' WHERE id = 'd'", []).unwrap();
        assert_eq!(find(&conn, f(|f| f.font_scripts = vec!["ja".into()])), s(&["d"]));
        assert!(find(&conn, f(|f| f.font_scripts = vec!["latin".into()])).is_empty());
        assert_eq!(find(&conn, f(|f| f.font_categories = vec!["gothic".into()])), s(&["d"]));
        assert_eq!(set_font_category(&conn, &s(&["a", "d"]), Some("mincho")).unwrap(), 1, "images are skipped");
        assert!(find(&conn, f(|f| f.font_categories = vec!["gothic".into()])).is_empty());
        assert_eq!(find(&conn, f(|f| f.font_categories = vec!["mincho".into()])), s(&["d"]));
        let c = counts(&conn, None).unwrap();
        assert_eq!((c.font_scripts, c.font_categories), (
            BTreeMap::from([("ja".to_string(), 1)]),
            BTreeMap::from([("mincho".to_string(), 1)])
        ));
        set_font_category(&conn, &s(&["d"]), None).unwrap();
        conn.execute("UPDATE items SET font_category = NULL WHERE id = 'd'", []).unwrap();
        assert_eq!(find(&conn, f(|f| f.font_categories = vec!["none".into()])), s(&["d"]), "unknown style");

        // Weight ranges: a variable font spanning 300-700 is light, regular and bold at once;
        // a font read before the range was stored has its one weight.
        conn.execute("UPDATE items SET font_weight = 400, font_weight_min = 300, font_weight_max = 700, font_features = 'mono,coding' WHERE id = 'd'", []).unwrap();
        assert_eq!(find(&conn, f(|f| f.font_weights = vec!["light".into()])), s(&["d"]));
        assert_eq!(find(&conn, f(|f| f.font_weights = vec!["bold".into()])), s(&["d"]));
        assert!(find(&conn, f(|f| f.font_weights = vec!["black".into()])).is_empty());
        assert!(find(&conn, f(|f| f.font_weights = vec!["nope".into()])).is_empty());
        assert_eq!(find(&conn, f(|f| f.font_features = vec!["coding".into()])), s(&["d"]));
        assert_eq!(find(&conn, f(|f| f.font_features = vec!["italic".into(), "mono".into()])), s(&["d"]), "any of");
        assert!(find(&conn, f(|f| f.font_features = vec!["italic".into()])).is_empty());
        assert!(find(&conn, f(|f| f.font_features = vec!["mon".into()])).is_empty(), "whole words");
        let c = counts(&conn, None).unwrap();
        assert_eq!(c.font_weights, BTreeMap::from([("light".to_string(), 1), ("regular".to_string(), 1), ("bold".to_string(), 1)]));
        assert_eq!(c.font_features, BTreeMap::from([("mono".to_string(), 1), ("coding".to_string(), 1)]));
        let mut query = q(View::All);
        query.filter = f(|f| f.font_features = vec!["mono".into()]);
        assert_eq!(query_items(&conn, &query).unwrap()[0].font_features, vec!["mono", "coding"]);
        conn.execute("UPDATE items SET font_weight_min = NULL, font_weight_max = NULL WHERE id = 'd'", []).unwrap();
        assert_eq!(counts(&conn, None).unwrap().font_weights, BTreeMap::from([("regular".to_string(), 1)]));
        assert_eq!(
            list_exts(&conn, None).unwrap(),
            vec![("png".to_string(), 2), ("jpg".to_string(), 1), ("tif".to_string(), 1)]
        );
    }

    #[test]
    fn counts_of_one_mode() {
        let mut conn = mem();
        add(&mut conn, "a", "cat.png", 1);
        add(&mut conn, "b", "dog.png", 2);
        add(&mut conn, "f", "font.ttf", 3);
        conn.execute("UPDATE items SET kind = 'font', ext = 'ttf', width = 0, height = 0 WHERE id = 'f'", []).unwrap();
        let folder = create_folder(&conn, "Images", None, Mode::Stock).unwrap();
        // A folder holds its mode's items only: the font stays unfiled.
        move_to_folder(&conn, &s(&["a", "f"]), &folder).unwrap();
        // The same name tags each item with its mode's tag.
        add_tags(&mut conn, &s(&["b", "f"]), &s(&["pet"])).unwrap();
        set_favorite(&conn, &s(&["f"]), true).unwrap();
        trash_items(&conn, &s(&["b"])).unwrap();
        let stock_pet = tag_id(&conn, "pet", Mode::Stock).unwrap().unwrap();
        create_smart_folder(&conn, "Pets", &Rule { tag_ids: vec![stock_pet], ..Default::default() }, Mode::Stock).unwrap();

        // Everything.
        let all = counts(&conn, None).unwrap();
        assert_eq!((all.all, all.unfiled, all.untagged, all.trash, all.favorites), (2, 1, 1, 1, 1));
        assert_eq!(all.kinds, BTreeMap::from([(Kind::Image, 1), (Kind::Font, 1)]));
        assert_eq!(list_folders(&conn, None).unwrap().len(), 1);
        assert_eq!(list_tags(&conn, None).unwrap().len(), 2, "pet of each mode");
        assert_eq!(list_exts(&conn, None).unwrap().len(), 2);

        // Fonts: images don't count, but `kinds` still lists both.
        let fonts = counts(&conn, Some(Mode::Font)).unwrap();
        assert_eq!((fonts.all, fonts.unfiled, fonts.untagged, fonts.trash, fonts.favorites), (1, 1, 0, 0, 1));
        assert_eq!(fonts.kinds, all.kinds);
        assert!(list_folders(&conn, Some(Mode::Font)).unwrap().is_empty());
        let tags = list_tags(&conn, Some(Mode::Font)).unwrap();
        assert_eq!((tags.len(), tags[0].count, tags[0].mode), (1, 1, Mode::Font));
        assert!(list_smart_folders(&conn, Some(Mode::Font)).unwrap().is_empty());
        assert_eq!(list_exts(&conn, Some(Mode::Font)).unwrap(), vec![("ttf".to_string(), 1)]);

        // The stock.
        let stock = counts(&conn, Some(Mode::Stock)).unwrap();
        assert_eq!((stock.all, stock.unfiled, stock.untagged, stock.trash, stock.favorites), (1, 0, 1, 1, 0));
        assert_eq!(list_folders(&conn, Some(Mode::Stock)).unwrap()[0].count, 1);
        assert_eq!(list_tags(&conn, Some(Mode::Stock)).unwrap()[0].count, 0, "b is in the trash");
        assert_eq!(list_smart_folders(&conn, Some(Mode::Stock)).unwrap()[0].count, 0);
        assert_eq!(list_exts(&conn, Some(Mode::Stock)).unwrap(), vec![("png".to_string(), 1)]);
    }

    /// Turns a fresh database back into what version 20 left: no modes on
    /// folders, smart folders and tags, and tag names unique on their own.
    fn back_to_v20(conn: &Connection) {
        conn.execute_batch(
            "ALTER TABLE folders DROP COLUMN mode;
             ALTER TABLE smart_folders DROP COLUMN mode;
             DROP TABLE item_tags;
             DROP TABLE tags;
             CREATE TABLE tags (
               id    INTEGER PRIMARY KEY AUTOINCREMENT,
               name  TEXT NOT NULL UNIQUE COLLATE NOCASE,
               color TEXT
             );
             CREATE TABLE item_tags (
               item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
               tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
               PRIMARY KEY (item_id, tag_id)
             );
             CREATE INDEX idx_item_tags_tag ON item_tags(tag_id);
             PRAGMA user_version = 20;",
        )
        .unwrap();
    }

    fn add_font(conn: &mut Connection, id: &str, at: i64) {
        add(conn, id, &format!("{id}.ttf"), at);
        conn.execute("UPDATE items SET kind = 'font', ext = 'ttf', width = 0, height = 0 WHERE id = ?1", [id]).unwrap();
    }

    #[test]
    fn postscript_names_tell_the_library_fonts() {
        let mut conn = mem();
        for (id, at) in [("f1", 1), ("f2", 2), ("f3", 3)] {
            add_font(&mut conn, id, at);
        }
        let meta = |ps: &str| crate::fonts::FontMeta {
            family: "F".into(),
            weight: 400,
            weight_min: 400,
            weight_max: 400,
            script: "latin",
            category: None,
            features: vec![],
            ps_name: ps.into(),
        };
        let metas = [("f1".into(), meta("F-Regular")), ("f2".into(), meta("F-Bold")), ("f3".into(), meta(""))];
        set_font_meta(&mut conn, &metas).unwrap();
        let item = get_items(&conn, &s(&["f1", "f3"])).unwrap();
        assert_eq!(item.iter().find(|i| i.id == "f1").unwrap().font_ps_name.as_deref(), Some("F-Regular"));
        assert_eq!(item.iter().find(|i| i.id == "f3").unwrap().font_ps_name, None, "none is no name");
        // Not the trash's, and no empty names.
        trash_items(&conn, &s(&["f2"])).unwrap();
        assert_eq!(font_ps_names(&conn).unwrap(), s(&["F-Regular"]));
    }

    #[test]
    fn step_23_reads_fonts_again_for_their_postscript_names() {
        let mut conn = mem();
        add_font(&mut conn, "f", 1);
        conn.execute("UPDATE items SET font_features = '', font_script = 'latin'", []).unwrap();
        assert!(missing_font_meta(&conn).unwrap().is_empty());
        conn.execute_batch("ALTER TABLE items DROP COLUMN font_ps_name; DROP TABLE tray_system; PRAGMA user_version = 22;")
            .unwrap();
        migrate(&conn).unwrap();
        assert_eq!(missing_font_meta(&conn).unwrap().len(), 1);
        assert!(system_tray(&conn).unwrap().is_empty());
    }

    #[test]
    fn splits_folders_tags_and_smart_folders_between_the_modes() {
        let mut conn = mem();
        back_to_v20(&conn);
        add(&mut conn, "i1", "a.png", 1);
        add(&mut conn, "i2", "b.png", 2);
        add_font(&mut conn, "f1", 3);
        add_font(&mut conn, "f2", 4);
        // P (red) / C1 [i1, f1], P / C2 [f2], P / E (empty); R [i2]; Z (empty).
        conn.execute_batch(
            "INSERT INTO folders (id, parent_id, name, sort_order, color) VALUES
               ('P', NULL, 'P', 1, 'red'), ('C1', 'P', 'C1', 1, NULL), ('C2', 'P', 'C2', 2, NULL),
               ('E', 'P', 'E', 3, NULL), ('R', NULL, 'R', 2, NULL), ('Z', NULL, 'Z', 3, NULL);
             INSERT INTO item_folders (item_id, folder_id, position) VALUES
               ('i1', 'C1', 1), ('f1', 'C1', 2), ('f2', 'C2', 1), ('i2', 'R', 1);
             INSERT INTO tags (id, name, color) VALUES (1, 'mix', 'blue'), (2, 'fontonly', NULL), (3, 'img', NULL), (10, 'gone', NULL);
             DELETE FROM tags WHERE id = 10;
             INSERT INTO item_tags (item_id, tag_id) VALUES ('i1', 1), ('f1', 1), ('f2', 2), ('i2', 3);",
        )
        .unwrap();
        let rule = |r: Rule| serde_json::to_string(&r).unwrap();
        let with_kinds = |kinds: Vec<Kind>, tags: Vec<i64>| Rule {
            tag_ids: tags,
            filter: Filter { kinds, ..Default::default() },
            ..Default::default()
        };
        conn.execute(
            "INSERT INTO smart_folders (id, name, rule, sort_order) VALUES
               ('S_all', 'all', ?1, 1), ('S_font', 'font', ?2, 2), ('S_img', 'img', ?3, 3), ('S_none', 'none', ?4, 4)",
            params![
                rule(with_kinds(vec![], vec![1])),
                rule(with_kinds(vec![Kind::Font, Kind::Image], vec![1])),
                rule(with_kinds(vec![Kind::Image], vec![])),
                rule(Rule { min_rating: 5, ..Default::default() }),
            ],
        )
        .unwrap();

        migrate(&conn).unwrap();
        let v: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);

        // Folders: P and C1 hold both, so each has a font twin; C2 (fonts only)
        // moves under P's twin; E (empty) stays with P; R and Z stay.
        let stock = list_folders(&conn, Some(Mode::Stock)).unwrap();
        let fonts = list_folders(&conn, Some(Mode::Font)).unwrap();
        let by = |list: &[Folder], name: &str| list.iter().find(|f| f.name == name).cloned().unwrap();
        let names = |list: &[Folder]| {
            let mut n: Vec<String> = list.iter().map(|f| f.name.clone()).collect();
            n.sort();
            n
        };
        assert_eq!(names(&stock), ["C1", "E", "P", "R", "Z"]);
        assert_eq!(names(&fonts), ["C1", "C2", "P"]);
        let font_p = by(&fonts, "P");
        assert_eq!((font_p.parent_id.as_deref(), font_p.color.as_deref()), (None, Some("red")));
        assert_eq!(by(&fonts, "C1").parent_id, Some(font_p.id.clone()));
        assert_eq!(by(&fonts, "C2").id, "C2", "kept its id, under the font P");
        assert_eq!(by(&fonts, "C2").parent_id, Some(font_p.id.clone()));
        assert_eq!(by(&stock, "C1").id, "C1");
        assert_eq!(by(&stock, "E").parent_id.as_deref(), Some("P"));
        assert_eq!((by(&stock, "C1").count, by(&fonts, "C1").count), (1, 1));
        let folder_of = |id: &str| -> String {
            conn.query_row("SELECT folder_id FROM item_folders WHERE item_id = ?1", [id], |r| r.get(0)).unwrap()
        };
        assert_eq!(folder_of("i1"), "C1");
        assert_eq!(folder_of("f1"), by(&fonts, "C1").id);

        // Tags: mix gets a font twin with the same name and colour.
        let stock_tags = list_tags(&conn, Some(Mode::Stock)).unwrap();
        let font_tags = list_tags(&conn, Some(Mode::Font)).unwrap();
        let tag = |list: &[Tag], name: &str| list.iter().find(|t| t.name == name).cloned();
        assert_eq!(tag(&stock_tags, "mix").map(|t| (t.id, t.count)), Some((1, 1)));
        let font_mix = tag(&font_tags, "mix").unwrap();
        assert_eq!((font_mix.count, font_mix.color.as_deref()), (1, Some("blue")));
        assert!(font_mix.id > 10, "ids of deleted tags aren't used again: {}", font_mix.id);
        assert_eq!(tag(&font_tags, "fontonly").map(|t| t.id), Some(2));
        assert!(tag(&stock_tags, "fontonly").is_none());
        assert_eq!(tag(&stock_tags, "img").map(|t| t.id), Some(3));

        // Smart folders.
        let smart_stock = list_smart_folders(&conn, Some(Mode::Stock)).unwrap();
        let smart_fonts = list_smart_folders(&conn, Some(Mode::Font)).unwrap();
        let smart = |list: &[SmartFolder], name: &str| list.iter().find(|f| f.name == name).cloned();
        let mut stock_names: Vec<&str> = smart_stock.iter().map(|f| f.name.as_str()).collect();
        stock_names.sort();
        assert_eq!(stock_names, ["all", "font", "img", "none"]);
        let mut font_names: Vec<&str> = smart_fonts.iter().map(|f| f.name.as_str()).collect();
        font_names.sort();
        assert_eq!(font_names, ["all", "font"], "none matches no font, img is of images");
        let font_all = smart(&smart_fonts, "all").unwrap();
        assert_eq!((font_all.rule.tag_ids.clone(), font_all.count), (vec![font_mix.id], 1));
        assert_eq!(smart(&smart_fonts, "font").unwrap().rule.filter.kinds, [Kind::Font]);
        assert_eq!(smart(&smart_stock, "font").unwrap().rule.filter.kinds, [Kind::Image]);
        assert_eq!(smart(&smart_stock, "all").unwrap().count, 1);

        // A second run (an older build lowered the version) changes nothing.
        conn.execute_batch("PRAGMA user_version = 20").unwrap();
        migrate(&conn).unwrap();
        assert_eq!(list_folders(&conn, None).unwrap().len(), 8);
        assert_eq!(list_tags(&conn, None).unwrap().len(), 4);
        assert_eq!(list_smart_folders(&conn, None).unwrap().len(), 6);
    }

    #[test]
    fn backs_up_a_library_before_splitting_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.db");
        {
            let conn = open(&path).unwrap();
            back_to_v20(&conn);
        }
        let backup = dir.path().join("library.before-modes.db");
        assert!(!backup.exists(), "a new library has nothing to back up");
        open(&path).unwrap();
        let old = Connection::open(&backup).unwrap();
        let v: i32 = old.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 20, "the copy is as it was");
        assert!(!has_column(&old, "folders", "mode").unwrap());
    }

    #[test]
    fn folders_and_tags_keep_to_their_mode() {
        let mut conn = mem();
        add(&mut conn, "i", "a.png", 1);
        add_font(&mut conn, "f", 2);
        let stock = create_folder(&conn, "Work", None, Mode::Stock).unwrap();
        let font = create_folder(&conn, "Work", None, Mode::Font).unwrap();
        // A subfolder is of its parent's mode.
        let sub = create_folder(&conn, "Sub", Some(&font), Mode::Stock).unwrap();
        assert_eq!(folder_mode(&conn, &sub).unwrap(), Some(Mode::Font));
        // Each mode's top level is ordered on its own.
        let other = create_folder(&conn, "Other", None, Mode::Font).unwrap();
        shift_folder(&mut conn, &other, -1).unwrap();
        let order: Vec<String> = list_folders(&conn, Some(Mode::Font)).unwrap().into_iter().filter(|f| f.parent_id.is_none()).map(|f| f.id).collect();
        assert_eq!(order, [other.clone(), font.clone()]);
        // Nothing goes into a folder of the other mode.
        assert!(!place_folder(&mut conn, &stock, Some(&font), None).unwrap());
        move_to_folder(&conn, &s(&["i", "f"]), &font).unwrap();
        assert_eq!(get_items(&conn, &s(&["i"])).unwrap()[0].folder_id, None);
        assert_eq!(get_items(&conn, &s(&["f"])).unwrap()[0].folder_id, Some(font.clone()));
        assert_eq!(find_or_create_folder(&conn, None, "Work", Mode::Stock).unwrap(), stock);
        assert_eq!(find_or_create_folder(&conn, None, "Work", Mode::Font).unwrap(), font);
        // Tags of the same name, one per mode; renaming merges within the mode only.
        add_tags(&mut conn, &s(&["i", "f"]), &s(&["x"])).unwrap();
        add_tags(&mut conn, &s(&["i"]), &s(&["y"])).unwrap();
        let fx = tag_id(&conn, "x", Mode::Font).unwrap().unwrap();
        let sx = tag_id(&conn, "x", Mode::Stock).unwrap().unwrap();
        assert_ne!(fx, sx);
        rename_tag(&mut conn, fx, "y").unwrap();
        assert!(tag_id(&conn, "y", Mode::Font).unwrap().is_some(), "renamed, not merged into the stock's y");
        assert_eq!(list_tags(&conn, Some(Mode::Stock)).unwrap().len(), 2);
    }

    #[test]
    fn tags_are_places_and_facets_count_with_the_other_conditions() {
        let mut conn = mem();
        add(&mut conn, "a", "a.png", 1);
        add(&mut conn, "b", "b.jpg", 2);
        add(&mut conn, "c", "c.png", 3);
        conn.execute("UPDATE items SET width = 20 WHERE id = 'a'", []).unwrap(); // landscape
        conn.execute("UPDATE items SET ext = 'jpg' WHERE id = 'b'", []).unwrap();
        set_rating(&conn, &s(&["a"]), 5).unwrap();
        set_rating(&conn, &s(&["b"]), 3).unwrap();
        add_tags(&mut conn, &s(&["a", "b"]), &s(&["x"])).unwrap();
        add_tags(&mut conn, &s(&["b", "c"]), &s(&["y"])).unwrap();
        let x = tag_id(&conn, "x", Mode::Stock).unwrap().unwrap();
        let y = tag_id(&conn, "y", Mode::Stock).unwrap().unwrap();

        // A tag as a place.
        let mut tag = q(View::Tag { id: x });
        assert_eq!(ids(query_items(&conn, &tag).unwrap()), ["a", "b"]);
        let f = facet_counts(&conn, &tag).unwrap();
        assert_eq!(f.ratings, BTreeMap::from([(5, 1), (3, 1)]));
        assert_eq!(f.tags, BTreeMap::from([(x, 2), (y, 1)]));
        assert_eq!(f.exts, [("jpg".to_string(), 1), ("png".to_string(), 1)]);
        assert_eq!(f.shapes, BTreeMap::from([("landscape".to_string(), 1), ("square".to_string(), 1)]));
        assert_eq!(f.kinds, BTreeMap::from([(Kind::Image, 2)]));

        // Another condition narrows the counts.
        tag.filter.exts = vec!["png".into()];
        let f = facet_counts(&conn, &tag).unwrap();
        assert_eq!((f.ratings, f.tags), (BTreeMap::from([(5, 1)]), BTreeMap::from([(x, 1)])));
    }

    #[test]
    fn smart_folders() {
        let mut conn = mem();
        add(&mut conn, "a", "cat.png", 1);
        add(&mut conn, "b", "dog.png", 2);
        add(&mut conn, "c", "cat2.png", 3);
        set_rating(&conn, &s(&["a", "b"]), 4).unwrap();
        add_tags(&mut conn, &s(&["a", "c"]), &s(&["pet"])).unwrap();
        let pet = list_tags(&conn, None).unwrap()[0].id;

        let rule = Rule { min_rating: 3, ..Default::default() };
        let id = create_smart_folder(&conn, "Good", &rule, Mode::Stock).unwrap();
        let list = list_smart_folders(&conn, None).unwrap();
        assert_eq!((list[0].name.as_str(), list[0].count), ("Good", 2));
        assert_eq!(list[0].rule, rule);

        // The smart rule is combined with the ad-hoc search.
        let mut query = q(View::Smart { id: id.clone() });
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["a", "b"]));
        query.search = "cat".into();
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["a"]));

        let rule = Rule { tag_ids: vec![pet], search: "cat".into(), ..Default::default() };
        update_smart_folder(&conn, &id, Some("Cats"), Some(&rule)).unwrap();
        assert_eq!(list_smart_folders(&conn, None).unwrap()[0].count, 2);
        // Trashed items don't count.
        trash_items(&conn, &s(&["c"])).unwrap();
        assert_eq!(list_smart_folders(&conn, None).unwrap()[0].count, 1);
        // Merged into another tag: the rule follows it.
        add_tags(&mut conn, &s(&["b"]), &s(&["animal"])).unwrap();
        rename_tag(&mut conn, pet, "animal").unwrap();
        let animal = list_tags(&conn, None).unwrap()[0].id;
        assert_ne!(animal, pet);
        let sf = &list_smart_folders(&conn, None).unwrap()[0];
        assert_eq!((sf.rule.tag_ids.as_slice(), sf.count), (&[animal][..], 1));
        let pet = animal;
        // A deleted tag drops out of the rule instead of matching nothing.
        delete_tag(&conn, pet).unwrap();
        let sf = &list_smart_folders(&conn, None).unwrap()[0];
        assert!(sf.rule.tag_ids.is_empty());
        assert_eq!(sf.count, 1); // just "cat" now (c is trashed)

        delete_smart_folder(&conn, &id).unwrap();
        assert!(list_smart_folders(&conn, None).unwrap().is_empty());
        let query = q(View::Smart { id });
        assert!(query_items(&conn, &query).unwrap().is_empty(), "deleted smart folder shows nothing");
    }

    #[test]
    fn folder_order() {
        let mut conn = mem();
        let names = |conn: &Connection, parent: Option<&str>| -> Vec<String> {
            list_folders(conn, None)
                .unwrap()
                .into_iter()
                .filter(|f| f.parent_id.as_deref() == parent)
                .map(|f| f.name)
                .collect()
        };
        let b = create_folder(&conn, "B", None, Mode::Stock).unwrap();
        let a = create_folder(&conn, "A", None, Mode::Stock).unwrap();
        let c = create_folder(&conn, "C", None, Mode::Stock).unwrap();
        assert_eq!(names(&conn, None), ["B", "A", "C"], "new folders go last");

        shift_folder(&mut conn, &c, -1).unwrap();
        assert_eq!(names(&conn, None), ["B", "C", "A"]);
        shift_folder(&mut conn, &a, i32::MIN).unwrap();
        assert_eq!(names(&conn, None), ["A", "B", "C"]);
        shift_folder(&mut conn, &a, i32::MAX).unwrap();
        assert_eq!(names(&conn, None), ["B", "C", "A"]);

        assert!(place_folder(&mut conn, &a, None, Some(&b)).unwrap());
        assert_eq!(names(&conn, None), ["A", "B", "C"]);
        // Into another folder, in front of an existing child.
        let x = create_folder(&conn, "X", Some(&b), Mode::Stock).unwrap();
        assert!(place_folder(&mut conn, &c, Some(&b), Some(&x)).unwrap());
        assert_eq!(names(&conn, Some(&b)), ["C", "X"]);
        assert!(!place_folder(&mut conn, &b, Some(&x), None).unwrap(), "no cycles");

        place_folder(&mut conn, &x, Some(&b), Some(&c)).unwrap();
        assert_eq!(names(&conn, Some(&b)), ["X", "C"]);
        sort_folders_by_name(&mut conn, Some(&b), Mode::Stock).unwrap();
        assert_eq!(names(&conn, Some(&b)), ["C", "X"]);
    }

    #[test]
    fn v4_seeds_folder_order_alphabetically() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, file_name TEXT NOT NULL,
               ext TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL,
               hash TEXT NOT NULL, thumb TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
               imported_at INTEGER NOT NULL, deleted_at INTEGER,
               rating INTEGER NOT NULL DEFAULT 0, phash INTEGER, pcolor INTEGER);
             CREATE TABLE folders (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL);
             CREATE TABLE item_folders (item_id TEXT NOT NULL, folder_id TEXT NOT NULL,
               position REAL, PRIMARY KEY (item_id, folder_id));
             CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
             CREATE TABLE item_tags (item_id TEXT NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (item_id, tag_id));
             INSERT INTO folders VALUES ('1', NULL, 'zebra'), ('2', NULL, 'Apple'), ('3', '1', 'b'), ('4', '1', 'a');
             PRAGMA user_version = 3;",
        )
        .unwrap();
        migrate(&conn).unwrap();
        let folders = list_folders(&conn, None).unwrap();
        let under = |p: Option<&str>| -> Vec<&str> {
            folders.iter().filter(|f| f.parent_id.as_deref() == p).map(|f| f.name.as_str()).collect()
        };
        assert_eq!(under(None), ["Apple", "zebra"]); // A→Z within each parent
        assert_eq!(under(Some("1")), ["a", "b"]);
    }

    /// An older build that opens a newer library lowers `user_version` but
    /// keeps the new columns. Opening it with this build again must work and
    /// must not reset anything the user arranged in the meantime.
    #[test]
    fn reopening_after_older_build_lowered_the_version() {
        let mut conn = mem();
        add(&mut conn, "a", "a.png", 1);
        add(&mut conn, "b", "b.png", 2);
        let f = create_folder(&conn, "Zeta", None, Mode::Stock).unwrap();
        let g = create_folder(&conn, "Alpha", None, Mode::Stock).unwrap();
        move_to_folder(&conn, &s(&["a", "b"]), &f).unwrap();
        reorder_in_folder(&mut conn, &f, &s(&["b"]), Some("a")).unwrap(); // b before a
        create_smart_folder(&conn, "Saved", &Rule { min_rating: 2, ..Default::default() }, Mode::Stock).unwrap();
        set_rating(&conn, &s(&["a"]), 5).unwrap();

        for older in [0, 1, 2, 3] {
            conn.pragma_update(None, "user_version", older).unwrap();
            migrate(&conn).unwrap_or_else(|e| panic!("from user_version {older}: {e}"));
            let v: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
            assert_eq!(v, SCHEMA_VERSION);
        }

        // Folder order (Zeta before Alpha, not re-seeded A→Z), manual item
        // order, smart folders and ratings all survive.
        let names: Vec<String> = list_folders(&conn, None).unwrap().into_iter().map(|x| x.name).collect();
        assert_eq!(names, ["Zeta", "Alpha"]);
        let _ = g;
        let mut query = q(View::Folder { id: f });
        query.sort = SortKey::Manual;
        assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["b", "a"]));
        assert_eq!(list_smart_folders(&conn, None).unwrap().len(), 1);
        assert_eq!(get_items(&conn, &s(&["a"])).unwrap()[0].rating, 5);
    }

    #[test]
    fn never_lowers_a_newer_version() {
        let conn = mem();
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 5).unwrap();
        migrate(&conn).unwrap();
        let v: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION + 5);
    }

    #[test]
    fn failed_step_leaves_no_open_transaction() {
        // A broken library (items missing) makes step 2 fail; the connection
        // must not be left inside the half-done transaction.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE item_folders (item_id TEXT, folder_id TEXT);
             CREATE TABLE items_x (id TEXT);
             PRAGMA user_version = 1;",
        )
        .unwrap();
        assert!(migrate(&conn).is_err());
        assert!(conn.is_autocommit(), "transaction was rolled back");
        let v: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 1, "version not bumped past the failed step");
        assert!(!has_column(&conn, "item_folders", "position").unwrap(), "partial step undone");
    }

    /// The reported case: a library made by v0.3.0 (schema 3), then opened by
    /// an older build that wrote user_version back to 2.
    #[test]
    fn v3_library_with_version_written_back_to_2() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, file_name TEXT NOT NULL,
               ext TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL,
               hash TEXT NOT NULL, thumb TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
               imported_at INTEGER NOT NULL, deleted_at INTEGER,
               rating INTEGER NOT NULL DEFAULT 0, phash INTEGER, pcolor INTEGER);
             CREATE TABLE folders (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL);
             CREATE TABLE item_folders (item_id TEXT NOT NULL, folder_id TEXT NOT NULL,
               position REAL, PRIMARY KEY (item_id, folder_id));
             CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
             CREATE TABLE item_tags (item_id TEXT NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (item_id, tag_id));
             INSERT INTO items (id, name, file_name, ext, width, height, size, hash, thumb, imported_at, phash, pcolor)
               VALUES ('a', 'a.png', 'a.png', 'png', 1, 1, 1, 'h', 'a.jpg', 1, 42, 7);
             INSERT INTO folders VALUES ('f', NULL, 'F');
             INSERT INTO item_folders VALUES ('a', 'f', 9);
             PRAGMA user_version = 2;",
        )
        .unwrap();
        migrate(&conn).unwrap();
        let v: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        assert!(has_column(&conn, "items", "preview").unwrap());
        assert!(list_smart_folders(&conn, None).unwrap().is_empty());
        let (phash, pos): (i64, f64) = conn
            .query_row(
                "SELECT phash, position FROM items JOIN item_folders ON item_id = id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((phash, pos), (42, 9.0), "existing hashes / positions untouched");
    }
}

//! The MCP tools: reading the open library, and changing tags, folders,
//! display names and notes. Every change goes through changes.rs, so it is
//! recorded and can be undone in the app.
//!
//! Lists are written as tab-separated lines (no repeated keys) and items are
//! named by the first 8 characters of their id, to keep what Claude reads
//! short. Folders and tags are named by name ("写真/旅行" for a subfolder).

use super::{Host, ToolOutput};
use crate::changes::{self, Change, Undo};
use crate::db::{self, Item, ItemQuery, Kind, Mode, SortKey, View};
use crate::library::Library;
use base64::Engine;
use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt::Write;

/// Items one write may change.
const MAX_ITEMS: usize = 500;
/// Items `find_items` lists at once.
const MAX_LIST: usize = 1000;
const DEFAULT_LIST: usize = 200;
/// Images `view_images` hands out at once, and their size.
const MAX_VIEW: usize = 10;
const DEFAULT_SIDE: u32 = 512;
const MAX_SIDE: u32 = 768;
/// Characters of an id shown, and the fewest accepted back.
const SHORT_ID: usize = 8;

const NO_LIBRARY: &str = "Stockroom でライブラリが開かれていません。アプリでライブラリを開いてから、もう一度試してください";

// ------------------------------------------------------------ the list

fn where_schema() -> Value {
    json!({
        "type": "object",
        "description": "絞り込みの条件。すべて省略するとライブラリ全体（ゴミ箱を除く）。複数指定するとすべてを満たすもの",
        "properties": {
            "kind": { "type": "string", "enum": ["image", "font", "file", "text", "video", "bookmark"], "description": "種類" },
            "folder": { "type": "string", "description": "フォルダのパス（例: 写真/旅行）" },
            "include_subfolders": { "type": "boolean", "description": "folder のサブフォルダの中身も含める" },
            "tags": { "type": "array", "items": { "type": "string" }, "description": "このタグのどれかが付いているもの" },
            "tag_match_all": { "type": "boolean", "description": "tags をすべて付けているものだけにする" },
            "untagged": { "type": "boolean", "description": "タグが 1 つも無いものだけ" },
            "unfiled": { "type": "boolean", "description": "どのフォルダにも入っていないものだけ" },
            "name_contains": { "type": "string", "description": "表示名にこの文字を含むもの（大文字・小文字は区別しない）" },
            "search": { "type": "string", "description": "アプリの検索欄と同じ（表示名・メモ・タグ名・フォント名・テキストの本文が対象。空白区切りで AND、OR、-除外、\"語句\"）" },
            "ext": { "type": "array", "items": { "type": "string" }, "description": "拡張子（例: [\"png\", \"jpg\"]）" }
        },
        "additionalProperties": false
    })
}

fn ids_schema() -> Value {
    json!({ "type": "array", "items": { "type": "string" }, "description": "対象の id（find_items の 8 文字の id か、より長い id）" })
}

fn dry_run_schema() -> Value {
    json!({ "type": "boolean", "description": "true なら変更せず、どうなるかだけを返す" })
}

fn read_only() -> Value {
    json!({ "readOnlyHint": true, "openWorldHint": false })
}

fn writes() -> Value {
    json!({ "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false })
}

/// The tools, for `tools/list`.
pub fn list() -> Value {
    json!([
        {
            "name": "library_info",
            "title": "ライブラリの概要",
            "description": "開いているライブラリの名前と、種類ごとの件数、タグなし・未分類の件数、フォルダとタグの数を返す",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": read_only(),
        },
        {
            "name": "list_folders",
            "title": "フォルダの一覧",
            "description": "フォルダを「パス<TAB>件数」の行で、サイドバーの並びのまま返す。フォルダは画像・ファイル・テキスト用とフォント用に分かれていて、フォント用は「（フォント用）」の見出しの後に続く",
            "inputSchema": {
                "type": "object",
                "properties": { "kind": { "type": "string", "enum": ["image", "font", "file", "text", "video", "bookmark"], "description": "この種類用のフォルダだけを返す（image・file・text・video・bookmark は同じ）" } }
            },
            "annotations": read_only(),
        },
        {
            "name": "list_tags",
            "title": "タグの一覧",
            "description": "タグを「名前<TAB>件数」の行で返す。タグは画像・ファイル・テキスト用とフォント用に分かれていて（同じ名前もある）、フォント用は「（フォント用）」の見出しの後に続く",
            "inputSchema": {
                "type": "object",
                "properties": { "kind": { "type": "string", "enum": ["image", "font", "file", "text", "video", "bookmark"], "description": "この種類用のタグだけを返す（image・file・text・video・bookmark は同じ）" } }
            },
            "annotations": read_only(),
        },
        {
            "name": "find_items",
            "title": "アイテムを探す",
            "description": "条件に合うアイテムを表示名の順に、1 件 1 行（id、種類、表示名、フォルダ、タグ、取り込み元の URL、メモの先頭）で返す。表示名には拡張子が含まれる",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "where": where_schema(),
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_LIST, "description": format!("返す件数（既定 {DEFAULT_LIST}）") },
                    "offset": { "type": "integer", "minimum": 0, "description": "先頭から飛ばす件数" }
                }
            },
            "annotations": read_only(),
        },
        {
            "name": "view_images",
            "title": "画像を見る",
            "description": format!("アイテムの縮小画像を返す（1 回 {MAX_VIEW} 件まで）。フォントは見本、PDF などはサムネイル。1 枚ごとに使用量がかかるので、必要な分だけにすること"),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ids": ids_schema(),
                    "max_side": { "type": "integer", "minimum": 128, "maximum": MAX_SIDE, "description": format!("長辺の画素数（既定 {DEFAULT_SIDE}）") }
                },
                "required": ["ids"]
            },
            "annotations": read_only(),
        },
        {
            "name": "add_tags",
            "title": "タグを付ける",
            "description": "タグを付ける（無いタグは作る）。フォントにはフォント用、ほかには画像・ファイル・テキスト用の同じ名前のタグが付く。全部に同じタグなら ids か where と tags、1 件ずつ違うなら items",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ids": ids_schema(),
                    "where": where_schema(),
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": { "id": { "type": "string" }, "tags": { "type": "array", "items": { "type": "string" } } },
                            "required": ["id", "tags"]
                        }
                    },
                    "dry_run": dry_run_schema()
                }
            },
            "annotations": writes(),
        },
        {
            "name": "remove_tags",
            "title": "タグを外す",
            "description": "タグを外す（タグ自体は消さない）。ids か where と tags、または items",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ids": ids_schema(),
                    "where": where_schema(),
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": { "id": { "type": "string" }, "tags": { "type": "array", "items": { "type": "string" } } },
                            "required": ["id", "tags"]
                        }
                    },
                    "dry_run": dry_run_schema()
                }
            },
            "annotations": writes(),
        },
        {
            "name": "create_folder",
            "title": "フォルダを作る",
            "description": "フォルダを作る。途中のフォルダもまとめて作り、既にあれば何もしない。フォント用のフォルダは kind: font（既定は画像・ファイル・テキスト用）",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "例: 写真/旅行/京都" },
                    "kind": { "type": "string", "enum": ["image", "font", "file", "text", "video", "bookmark"], "description": "この種類用のフォルダを作る（image・file・text・video・bookmark は同じ）" },
                    "dry_run": dry_run_schema()
                },
                "required": ["path"]
            },
            "annotations": writes(),
        },
        {
            "name": "move_to_folder",
            "title": "フォルダへ移す",
            "description": "フォルダへ移す（アイテムが入るフォルダは 1 つまで。無いフォルダは作る）。フォントはフォント用、ほかは画像・ファイル・テキスト用の同じパスのフォルダへ入る。全部を同じフォルダへなら ids か where と folder、1 件ずつ違うなら items",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ids": ids_schema(),
                    "where": where_schema(),
                    "folder": { "type": "string", "description": "フォルダのパス（例: 写真/旅行）" },
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": { "id": { "type": "string" }, "folder": { "type": "string" } },
                            "required": ["id", "folder"]
                        }
                    },
                    "dry_run": dry_run_schema()
                }
            },
            "annotations": writes(),
        },
        {
            "name": "remove_from_folder",
            "title": "未分類に戻す",
            "description": "フォルダから出して未分類に戻す。ids か where",
            "inputSchema": {
                "type": "object",
                "properties": { "ids": ids_schema(), "where": where_schema(), "dry_run": dry_run_schema() }
            },
            "annotations": writes(),
        },
        {
            "name": "rename_items",
            "title": "表示名を変える",
            "description": "表示名を変える（ライブラリ内の実ファイルはそのまま。書き出すときのファイル名になる）。拡張子は変えられず、付けなければ元の拡張子を足す。ファイル名に使えない文字（/ \\ : など）は不可",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": { "id": { "type": "string" }, "name": { "type": "string" } },
                            "required": ["id", "name"]
                        }
                    },
                    "dry_run": dry_run_schema()
                },
                "required": ["items"]
            },
            "annotations": writes(),
        },
        {
            "name": "set_note",
            "title": "メモを書く",
            "description": "メモを書き換える（空にすると消える）。メモは検索の対象になる",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": { "id": { "type": "string" }, "note": { "type": "string" } },
                            "required": ["id", "note"]
                        }
                    },
                    "dry_run": dry_run_schema()
                },
                "required": ["items"]
            },
            "annotations": writes(),
        },
    ])
}

/// Runs a tool.
pub fn call(host: &dyn Host, name: &str, args: &Value) -> ToolOutput {
    let result = match name {
        "library_info" => read(host, library_info),
        "list_folders" => parse(args).and_then(|a: KindArg| read(host, |l| list_folders(&l.conn, a.kind.map(Mode::of)))),
        "list_tags" => parse(args).and_then(|a: KindArg| read(host, |l| list_tags(&l.conn, a.kind.map(Mode::of)))),
        "find_items" => parse(args).and_then(|a: FindArgs| read(host, |l| find_items(&l.conn, &a))),
        "view_images" => return parse(args).map_or_else(ToolOutput::error, |a| view_images(host, a)),
        "add_tags" => parse(args).and_then(|a: TagArgs| write(host, a.dry_run, |c, u| tags(c, u, a, true))),
        "remove_tags" => parse(args).and_then(|a: TagArgs| write(host, a.dry_run, |c, u| tags(c, u, a, false))),
        "create_folder" => parse(args).and_then(|a: FolderArgs| {
            write(host, a.dry_run, |c, u| create_folder(c, u, &a.path, a.kind.map(Mode::of).unwrap_or_default()))
        }),
        "move_to_folder" => parse(args).and_then(|a: MoveArgs| write(host, a.dry_run, |c, u| move_items(c, u, a))),
        "remove_from_folder" => {
            parse(args).and_then(|a: UnfileArgs| write(host, a.dry_run, |c, u| unfile(c, u, &a.target)))
        }
        "rename_items" => parse(args).and_then(|a: RenameArgs| write(host, a.dry_run, |c, u| rename_items(c, u, &a.items))),
        "set_note" => parse(args).and_then(|a: NoteArgs| write(host, a.dry_run, |c, u| set_notes(c, u, &a.items))),
        _ => Err(format!("{name} というツールはありません")),
    };
    result.map_or_else(ToolOutput::error, ToolOutput::text)
}

fn parse<T: DeserializeOwned>(args: &Value) -> Result<T, String> {
    serde_json::from_value(args.clone()).map_err(|e| format!("引数が正しくありません: {e}"))
}

fn e(err: rusqlite::Error) -> String {
    err.to_string()
}

fn read(host: &dyn Host, f: impl FnOnce(&Library) -> Result<String, String>) -> Result<String, String> {
    let guard = host.library().lock().unwrap();
    f(guard.as_ref().ok_or(NO_LIBRARY)?)
}

/// What a write did: the line recorded for undo, and details for Claude.
struct Outcome {
    summary: String,
    details: Vec<String>,
}

/// Runs a change in a transaction: kept and recorded, or rolled back for a
/// dry run (so the result is exactly what would happen).
fn write(
    host: &dyn Host,
    dry_run: bool,
    f: impl FnOnce(&Connection, &mut Undo) -> Result<Outcome, String>,
) -> Result<String, String> {
    let mut guard = host.library().lock().unwrap();
    let lib = guard.as_mut().ok_or(NO_LIBRARY)?;
    let tx = lib.conn.transaction().map_err(e)?;
    let mut undo = Undo::default();
    let out = f(&tx, &mut undo)?;
    let details: String = out.details.iter().map(|d| format!("\n{d}")).collect();
    // Returning without commit rolls the transaction back.
    if undo.is_empty() {
        return Ok(format!("変更はありません。{details}"));
    }
    if dry_run {
        return Ok(format!("【試し実行・まだ変えていません】{}{details}", out.summary));
    }
    let id = changes::record(&tx, "mcp", &out.summary, &undo).map_err(e)?;
    tx.commit().map_err(e)?;
    drop(guard);
    host.changed(&Change { id, at: db::now_ms(), source: "mcp".into(), summary: out.summary.clone(), undone: false });
    Ok(format!("{}（変更番号 {id}。アプリから元に戻せます）{details}", out.summary))
}

// ------------------------------------------------------------- helpers

/// Folder id -> path ("写真/旅行"), of the folders of `mode` (every folder when None).
fn folder_paths(conn: &Connection, mode: Option<Mode>) -> Result<HashMap<String, String>, String> {
    let folders = db::list_folders(conn, mode).map_err(e)?;
    let by_id: HashMap<&str, &db::Folder> = folders.iter().map(|f| (f.id.as_str(), f)).collect();
    let mut out = HashMap::new();
    for f in &folders {
        let mut parts = vec![f.name.as_str()];
        let mut cur = f.parent_id.as_deref();
        while let Some(p) = cur.and_then(|id| by_id.get(id)) {
            parts.push(&p.name);
            cur = p.parent_id.as_deref();
        }
        parts.reverse();
        out.insert(f.id.clone(), parts.join("/"));
    }
    Ok(out)
}

fn normalize_path(path: &str) -> String {
    path.split('/').map(str::trim).filter(|p| !p.is_empty()).collect::<Vec<_>>().join("/")
}

/// The folder of `mode` at `path`.
fn find_folder(conn: &Connection, path: &str, mode: Mode) -> Result<Option<String>, String> {
    let want = normalize_path(path);
    Ok(folder_paths(conn, Some(mode))?.into_iter().find(|(_, p)| *p == want).map(|(id, _)| id))
}

fn short(id: &str) -> &str {
    &id[..id.len().min(SHORT_ID)]
}

/// Full ids for the ids Claude gave (whole, or their first 8+ characters).
fn resolve(conn: &Connection, given: &[String]) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare_cached("SELECT id FROM items WHERE deleted_at IS NULL AND id LIKE ?1 || '%' LIMIT 2")
        .map_err(e)?;
    let mut out: Vec<String> = Vec::with_capacity(given.len());
    let (mut unknown, mut ambiguous) = (Vec::new(), Vec::new());
    for g in given {
        let g = g.trim().to_ascii_lowercase();
        if g.len() < SHORT_ID || !g.bytes().all(|b| b.is_ascii_hexdigit()) {
            unknown.push(g);
            continue;
        }
        let found: Vec<String> = stmt.query_map([&g], |r| r.get(0)).map_err(e)?.collect::<Result<_, _>>().map_err(e)?;
        match found.as_slice() {
            [id] => {
                if !out.contains(id) {
                    out.push(id.clone());
                }
            }
            [] => unknown.push(g),
            _ => ambiguous.push(g),
        }
    }
    let mut problems = Vec::new();
    if !unknown.is_empty() {
        problems.push(format!("見つからない id: {}", sample(&unknown)));
    }
    if !ambiguous.is_empty() {
        problems.push(format!("複数に当てはまる id（もっと長く指定してください）: {}", sample(&ambiguous)));
    }
    if problems.is_empty() {
        Ok(out)
    } else {
        Err(format!("{}。何も変えていません", problems.join("。")))
    }
}

fn sample(v: &[String]) -> String {
    let mut s = v.iter().take(10).cloned().collect::<Vec<_>>().join(", ");
    if v.len() > 10 {
        let _ = write!(s, " ほか {} 件", v.len() - 10);
    }
    s
}

fn too_many(n: usize) -> Result<(), String> {
    if n > MAX_ITEMS {
        Err(format!(
            "対象が {n} 件あります。1 回で変えられるのは {MAX_ITEMS} 件までです。条件を絞るか、ids で分けて呼んでください。何も変えていません"
        ))
    } else {
        Ok(())
    }
}

/// One line of a table: tabs and line breaks inside values become spaces.
fn cell(s: &str, max: usize) -> String {
    let flat: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let flat = flat.trim();
    if flat.chars().count() > max {
        format!("{}…", flat.chars().take(max).collect::<String>())
    } else {
        flat.to_string()
    }
}

// -------------------------------------------------------------- reading

#[derive(Deserialize, Default)]
#[serde(default)]
struct KindArg {
    kind: Option<Kind>,
}

fn kind_label(kind: Kind) -> &'static str {
    match kind {
        Kind::Image => "画像",
        Kind::Font => "フォント",
        Kind::File => "ファイル",
        Kind::Text => "テキスト",
        Kind::Video => "動画",
        Kind::Bookmark => "ブックマーク",
    }
}

fn library_info(lib: &Library) -> Result<String, String> {
    let c = db::counts(&lib.conn, None).map_err(e)?;
    // Per mode, the fonts' own only when there are any.
    let per_mode = |n: [usize; 2]| if n[1] == 0 { format!("{} 個", n[0]) } else { format!("{} 個（フォント用 {} 個）", n[0] + n[1], n[1]) };
    let count = |f: &dyn Fn(Mode) -> Result<usize, String>| -> Result<[usize; 2], String> { Ok([f(Mode::Stock)?, f(Mode::Font)?]) };
    let folders = per_mode(count(&|m| Ok(db::list_folders(&lib.conn, Some(m)).map_err(e)?.len()))?);
    let tags = per_mode(count(&|m| Ok(db::list_tags(&lib.conn, Some(m)).map_err(e)?.len()))?);
    let kinds: Vec<String> = c.kinds.iter().map(|(k, n)| format!("{} {n}", kind_label(*k))).collect();
    let name = lib.root.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(format!(
        "ライブラリ: {name}\nすべて: {} 件（{}）\nタグなし: {} 件\n未分類（フォルダに入っていない）: {} 件\nフォルダ: {folders}\nタグ: {tags}\nゴミ箱: {} 件（ツールの対象外）",
        c.all,
        if kinds.is_empty() { "なし".into() } else { kinds.join("、") },
        c.untagged,
        c.unfiled,
        c.trash,
    ))
}

/// The modes to list: `mode`, else both.
fn modes(mode: Option<Mode>) -> Vec<Mode> {
    mode.map_or(Mode::ALL.to_vec(), |m| vec![m])
}

/// The fonts' section follows the others' under its own heading, when both are listed.
fn section(out: &mut String, mode: Mode, header: &str) {
    if mode == Mode::Font && !out.is_empty() {
        out.push_str("（フォント用）\n");
    }
    out.push_str(header);
}

fn list_folders(conn: &Connection, mode: Option<Mode>) -> Result<String, String> {
    // Depth first, in each level's sidebar order (`list_folders` is already in it).
    fn walk(parent: Option<&str>, folders: &[db::Folder], paths: &HashMap<String, String>, out: &mut String) {
        for f in folders.iter().filter(|f| f.parent_id.as_deref() == parent) {
            let _ = writeln!(out, "{}\t{}", paths[&f.id], f.count);
            walk(Some(&f.id), folders, paths, out);
        }
    }
    let mut out = String::new();
    for m in modes(mode) {
        let folders = db::list_folders(conn, Some(m)).map_err(e)?;
        if folders.is_empty() {
            continue;
        }
        section(&mut out, m, "パス\t件数\n");
        walk(None, &folders, &folder_paths(conn, Some(m))?, &mut out);
    }
    Ok(if out.is_empty() { "フォルダはありません".into() } else { out })
}

fn list_tags(conn: &Connection, mode: Option<Mode>) -> Result<String, String> {
    let mut out = String::new();
    for m in modes(mode) {
        let tags = db::list_tags(conn, Some(m)).map_err(e)?;
        if tags.is_empty() {
            continue;
        }
        section(&mut out, m, "タグ\t件数\n");
        for t in tags {
            let _ = writeln!(out, "{}\t{}", cell(&t.name, 200), t.count);
        }
    }
    Ok(if out.is_empty() { "タグはありません".into() } else { out })
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct Where {
    kind: Option<Kind>,
    folder: Option<String>,
    include_subfolders: bool,
    tags: Vec<String>,
    tag_match_all: bool,
    untagged: bool,
    unfiled: bool,
    name_contains: String,
    search: String,
    ext: Vec<String>,
}

/// Live items matching `w`, by display name. Folders and tags are each mode's
/// own (docs/MODES.md), so a path or tag name is looked up in each mode and
/// the matches of both are put together.
fn select(conn: &Connection, w: &Where) -> Result<Vec<Item>, String> {
    let all_tags = db::list_tags(conn, None).map_err(e)?;
    let same = |a: &str, b: &str| a.to_lowercase() == b.trim().to_lowercase();
    for name in &w.tags {
        if !all_tags.iter().any(|t| same(&t.name, name)) {
            return Err(format!("タグ「{name}」はありません（list_tags で確かめてください）"));
        }
    }
    let mut items = Vec::new();
    let mut folder_found = false;
    for mode in modes(w.kind.map(Mode::of)) {
        let view = match &w.folder {
            Some(path) => match find_folder(conn, path, mode)? {
                Some(id) => View::Folder { id },
                None => continue,
            },
            None if w.untagged => View::Untagged,
            None if w.unfiled => View::Unfiled,
            None => View::All,
        };
        folder_found = true;
        let tag_ids: Vec<i64> = w
            .tags
            .iter()
            .filter_map(|name| all_tags.iter().find(|t| t.mode == mode && same(&t.name, name)).map(|t| t.id))
            .collect();
        // No tag of these names in this mode: nothing of it can match.
        if !w.tags.is_empty() && (tag_ids.is_empty() || (w.tag_match_all && tag_ids.len() < w.tags.len())) {
            continue;
        }
        let mut q = ItemQuery {
            view,
            search: w.search.clone(),
            tag_ids,
            tag_match_all: w.tag_match_all,
            include_subfolders: w.include_subfolders,
            sort: SortKey::Name,
            ..Default::default()
        };
        q.filter.kinds = match (w.kind, mode) {
            (Some(k), _) => vec![k],
            (None, Mode::Font) => vec![Kind::Font],
            (None, Mode::Stock) => vec![Kind::Image, Kind::File, Kind::Text, Kind::Video, Kind::Bookmark],
        };
        q.filter.exts = w.ext.clone();
        items.extend(db::query_items(conn, &q).map_err(e)?);
    }
    if let (Some(path), false) = (&w.folder, folder_found) {
        return Err(format!("フォルダ「{path}」はありません（list_folders で確かめてください）"));
    }
    let needle = w.name_contains.to_lowercase();
    items.retain(|i| {
        (!w.untagged || i.tag_ids.is_empty())
            && (!w.unfiled || i.folder_id.is_none())
            && (needle.is_empty() || i.name.to_lowercase().contains(&needle))
    });
    // Pinned items come first in the app's lists; here only the name counts.
    items.sort_by_cached_key(|i| i.name.to_lowercase());
    Ok(items)
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct FindArgs {
    #[serde(rename = "where")]
    filter: Where,
    limit: Option<usize>,
    offset: usize,
}

fn find_items(conn: &Connection, a: &FindArgs) -> Result<String, String> {
    let items = select(conn, &a.filter)?;
    let limit = a.limit.unwrap_or(DEFAULT_LIST).clamp(1, MAX_LIST);
    let page: Vec<&Item> = items.iter().skip(a.offset).take(limit).collect();
    if items.is_empty() {
        return Ok("該当 0 件".into());
    }
    if page.is_empty() {
        return Ok(format!("該当 {} 件（offset {} からはありません）", items.len(), a.offset));
    }
    let mut out = String::new();
    let _ = writeln!(out, "該当 {} 件（{}〜{} 件目）", items.len(), a.offset + 1, a.offset + page.len());
    let paths = folder_paths(conn, None)?;
    let tag_names: HashMap<i64, String> = db::list_tags(conn, None).map_err(e)?.into_iter().map(|t| (t.id, t.name)).collect();
    out.push_str("id\t種類\t表示名\tフォルダ\tタグ\t取り込み元\tメモ\n");
    for i in &page {
        let tags: Vec<&str> = i.tag_ids.iter().filter_map(|t| tag_names.get(t).map(String::as_str)).collect();
        let _ = writeln!(
            out,
            "{}\t{}\t{}\t{}\t{}\t{}\t{}",
            short(&i.id),
            kind_label(i.kind),
            cell(&i.name, 200),
            i.folder_id.as_ref().and_then(|f| paths.get(f)).map(String::as_str).unwrap_or(""),
            cell(&tags.join(", "), 300),
            cell(i.source_url.as_deref().unwrap_or(""), 100),
            cell(&i.note, 40),
        );
    }
    let next = a.offset + page.len();
    if next < items.len() {
        let _ = write!(out, "続きは offset: {next}");
    }
    Ok(out)
}

#[derive(Deserialize)]
struct ViewArgs {
    ids: Vec<String>,
    max_side: Option<u32>,
}

fn view_images(host: &dyn Host, a: ViewArgs) -> ToolOutput {
    if a.ids.len() > MAX_VIEW {
        return ToolOutput::error(format!("1 回に見られるのは {MAX_VIEW} 件までです（{} 件指定されました）", a.ids.len()));
    }
    let side = a.max_side.unwrap_or(DEFAULT_SIDE).clamp(128, MAX_SIDE);
    // Only look the paths up under the lock; decoding can take a while.
    let found = {
        let guard = host.library().lock().unwrap();
        let Some(lib) = guard.as_ref() else { return ToolOutput::error(NO_LIBRARY) };
        let ids = match resolve(&lib.conn, &a.ids) {
            Ok(ids) => ids,
            Err(msg) => return ToolOutput::error(msg),
        };
        match db::get_items(&lib.conn, &ids) {
            Ok(items) => items.into_iter().map(|i| (crate::sheet::source_path(lib, &i), i)).collect::<Vec<_>>(),
            Err(err) => return ToolOutput::error(err.to_string()),
        }
    };
    let mut content = Vec::new();
    for (path, item) in found {
        content.push(json!({ "type": "text", "text": format!("{}\t{}", short(&item.id), item.name) }));
        let picture = std::fs::read(&path).map_err(|e| e.to_string()).and_then(|b| crate::sheet::render(&item, &b, side));
        match picture {
            Ok(bytes) => {
                let mime = if bytes.starts_with(b"\x89PNG") { "image/png" } else { "image/jpeg" };
                let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                content.push(json!({ "type": "image", "data": data, "mimeType": mime }));
            }
            Err(err) => content.push(json!({ "type": "text", "text": format!("（画像を読み込めませんでした: {err}）") })),
        }
    }
    ToolOutput { content, is_error: false }
}

// -------------------------------------------------------------- writing

/// The items a write is about: `ids` or `where`, not both.
#[derive(Deserialize, Default)]
#[serde(default)]
struct Target {
    ids: Vec<String>,
    #[serde(rename = "where")]
    filter: Option<Where>,
}

impl Target {
    fn given(&self) -> bool {
        !self.ids.is_empty() || self.filter.is_some()
    }

    fn resolve(&self, conn: &Connection) -> Result<Vec<String>, String> {
        match (&self.filter, self.ids.is_empty()) {
            (Some(_), false) => Err("ids と where は同時に指定できません".into()),
            (Some(w), true) => Ok(select(conn, w)?.into_iter().map(|i| i.id).collect()),
            (None, false) => resolve(conn, &self.ids),
            (None, true) => Err("対象（ids か where）を指定してください".into()),
        }
    }
}

fn check_tag(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        Err("空のタグ名は使えません".into())
    } else if n.chars().count() > 100 {
        Err(format!("タグ名が長すぎます（100 文字まで）: {n}"))
    } else {
        Ok(n.to_string())
    }
}

#[derive(Deserialize)]
struct PerItemTags {
    id: String,
    tags: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct TagArgs {
    #[serde(flatten)]
    target: Target,
    tags: Vec<String>,
    items: Vec<PerItemTags>,
    dry_run: bool,
}

/// Tag name -> the items to add it to (or take it off), in the order given.
fn tag_plan(conn: &Connection, a: &TagArgs) -> Result<Vec<(String, Vec<String>)>, String> {
    let mut plan: Vec<(String, Vec<String>)> = Vec::new();
    let mut add = |tag: String, ids: &[String]| match plan.iter_mut().find(|(t, _)| t.to_lowercase() == tag.to_lowercase()) {
        Some((_, v)) => v.extend(ids.iter().cloned()),
        None => plan.push((tag, ids.to_vec())),
    };
    match (a.items.is_empty(), a.target.given()) {
        (false, true) => return Err("items と ids / where は同時に指定できません".into()),
        (false, false) => {
            too_many(a.items.len())?;
            for it in &a.items {
                let id = resolve(conn, std::slice::from_ref(&it.id))?;
                for t in &it.tags {
                    add(check_tag(t)?, &id);
                }
            }
        }
        (true, _) => {
            if a.tags.is_empty() {
                return Err("tags を指定してください".into());
            }
            let ids = a.target.resolve(conn)?;
            too_many(ids.len())?;
            for t in &a.tags {
                add(check_tag(t)?, &ids);
            }
        }
    }
    Ok(plan)
}

fn tags(conn: &Connection, undo: &mut Undo, a: TagArgs, adding: bool) -> Result<Outcome, String> {
    let plan = tag_plan(conn, &a)?;
    let mut parts = Vec::new();
    let mut details = Vec::new();
    for (tag, ids) in &plan {
        let n = if adding {
            changes::add_tag(conn, undo, ids, tag).map_err(e)?
        } else {
            changes::remove_tag(conn, undo, ids, tag).map_err(e)?
        };
        if n > 0 {
            parts.push(format!("「{tag}」{n} 件"));
        }
        let same = ids.len() - n;
        if ids.is_empty() {
            details.push(format!("「{tag}」: 対象がありません"));
        } else if same > 0 {
            details.push(if adding {
                format!("「{tag}」: {same} 件は既に付いていました")
            } else {
                format!("「{tag}」: {same} 件には付いていませんでした")
            });
        }
    }
    let verb = if adding { "タグを付けました" } else { "タグを外しました" };
    Ok(Outcome { summary: format!("{verb}（{}）", parts.join("、")), details })
}

#[derive(Deserialize)]
struct FolderArgs {
    path: String,
    /// Whose folder: the fonts' (font) or the images' and files' (default).
    #[serde(default)]
    kind: Option<Kind>,
    #[serde(default)]
    dry_run: bool,
}

fn create_folder(conn: &Connection, undo: &mut Undo, path: &str, mode: Mode) -> Result<Outcome, String> {
    let path = normalize_path(path);
    if path.is_empty() {
        return Err("フォルダのパスが空です".into());
    }
    changes::ensure_folder_path(conn, undo, &path, mode).map_err(e)?;
    Ok(Outcome { summary: format!("フォルダ「{path}」を作りました"), details: vec![] })
}

#[derive(Deserialize)]
struct PerItemFolder {
    id: String,
    folder: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct MoveArgs {
    #[serde(flatten)]
    target: Target,
    folder: Option<String>,
    items: Vec<PerItemFolder>,
    dry_run: bool,
}

fn move_items(conn: &Connection, undo: &mut Undo, a: MoveArgs) -> Result<Outcome, String> {
    // Folder path -> items, in the order given.
    let mut plan: Vec<(String, Vec<String>)> = Vec::new();
    match (a.items.is_empty(), a.target.given()) {
        (false, true) => return Err("items と ids / where は同時に指定できません".into()),
        (false, false) => {
            too_many(a.items.len())?;
            for it in &a.items {
                let path = normalize_path(&it.folder);
                if path.is_empty() {
                    return Err(format!("{} の folder が空です（未分類に戻すなら remove_from_folder）", it.id));
                }
                let id = resolve(conn, std::slice::from_ref(&it.id))?;
                match plan.iter_mut().find(|(p, _)| *p == path) {
                    Some((_, v)) => v.extend(id),
                    None => plan.push((path, id)),
                }
            }
        }
        (true, _) => {
            let path = normalize_path(a.folder.as_deref().unwrap_or(""));
            if path.is_empty() {
                return Err("folder を指定してください（未分類に戻すなら remove_from_folder）".into());
            }
            let ids = a.target.resolve(conn)?;
            too_many(ids.len())?;
            plan.push((path, ids));
        }
    }
    let mut parts = Vec::new();
    let mut details = Vec::new();
    for (path, ids) in &plan {
        // Each item to the folder at `path` of its own mode.
        let mut n = 0;
        for (mode, ids) in db::by_mode(conn, ids).map_err(e)? {
            let created = undo.folders_created();
            let folder = changes::ensure_folder_path(conn, undo, path, mode).map_err(e)?;
            if undo.folders_created() > created {
                let whose = if mode == Mode::Font { "フォント用の" } else { "" };
                details.push(format!("{whose}フォルダ「{path}」を新しく作りました"));
            }
            n += changes::move_to_folder(conn, undo, &ids, folder.as_deref()).map_err(e)?;
        }
        if n > 0 {
            parts.push(format!("「{path}」{n} 件"));
        }
        if ids.len() > n {
            details.push(format!("「{path}」: {} 件は既に入っていました", ids.len() - n));
        }
    }
    Ok(Outcome { summary: format!("フォルダへ移しました（{}）", parts.join("、")), details })
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct UnfileArgs {
    #[serde(flatten)]
    target: Target,
    dry_run: bool,
}

fn unfile(conn: &Connection, undo: &mut Undo, target: &Target) -> Result<Outcome, String> {
    let ids = target.resolve(conn)?;
    too_many(ids.len())?;
    let n = changes::move_to_folder(conn, undo, &ids, None).map_err(e)?;
    let mut details = Vec::new();
    if ids.len() > n {
        details.push(format!("{} 件は既に未分類でした", ids.len() - n));
    }
    Ok(Outcome { summary: format!("{n} 件を未分類に戻しました"), details })
}

#[derive(Deserialize)]
struct PerItemName {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct RenameArgs {
    items: Vec<PerItemName>,
    #[serde(default)]
    dry_run: bool,
}

/// Spellings of the same extension ("jpg" / "jpeg").
fn same_ext(a: &str, b: &str) -> bool {
    db::canonical_ext(a) == db::canonical_ext(b)
}

/// The display name to store for `wanted` on an item with extension `ext`.
fn display_name(wanted: &str, ext: &str) -> Result<String, String> {
    let name = wanted.trim();
    if name.is_empty() {
        return Err("空の名前は使えません".into());
    }
    if let Some(c) = name.chars().find(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')) {
        return Err(format!("「{name}」: ファイル名に使えない文字（{c:?}）が含まれています"));
    }
    if name.len() > 255 {
        return Err(format!("「{name}」: 長すぎます"));
    }
    let given_ext = name.rsplit_once('.').filter(|(stem, _)| !stem.is_empty());
    match given_ext {
        Some((_, x)) if same_ext(x, ext) => Ok(name.to_string()),
        Some((_, x)) if crate::import::SUPPORTED_EXTS.iter().any(|s| s.eq_ignore_ascii_case(x)) => {
            Err(format!("「{name}」: 拡張子は変えられません（.{ext} のままにしてください）"))
        }
        _ if ext.is_empty() => Ok(name.to_string()),
        _ => Ok(format!("{name}.{ext}")),
    }
}

fn rename_items(conn: &Connection, undo: &mut Undo, items: &[PerItemName]) -> Result<Outcome, String> {
    too_many(items.len())?;
    let mut details = Vec::new();
    let mut n = 0;
    for it in items {
        let id = resolve(conn, std::slice::from_ref(&it.id))?.remove(0);
        let item = db::get_items(conn, std::slice::from_ref(&id)).map_err(e)?.remove(0);
        let name = display_name(&it.name, &item.ext)?;
        if changes::rename(conn, undo, &id, &name).map_err(e)? {
            n += 1;
            if details.len() < 20 {
                details.push(format!("{}: {} → {name}", short(&id), item.name));
            }
        }
    }
    if n > details.len() {
        details.push(format!("ほか {} 件", n - details.len()));
    }
    Ok(Outcome { summary: format!("{n} 件の表示名を変えました"), details })
}

#[derive(Deserialize)]
struct PerItemNote {
    id: String,
    note: String,
}

#[derive(Deserialize)]
struct NoteArgs {
    items: Vec<PerItemNote>,
    #[serde(default)]
    dry_run: bool,
}

fn set_notes(conn: &Connection, undo: &mut Undo, items: &[PerItemNote]) -> Result<Outcome, String> {
    too_many(items.len())?;
    let mut n = 0;
    for it in items {
        if it.note.chars().count() > 5000 {
            return Err(format!("{}: メモが長すぎます（5000 文字まで）", it.id));
        }
        let id = resolve(conn, std::slice::from_ref(&it.id))?.remove(0);
        if changes::set_note(conn, undo, &id, it.note.trim()).map_err(e)? {
            n += 1;
        }
    }
    Ok(Outcome { summary: format!("{n} 件のメモを書き換えました"), details: vec![] })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct TestHost {
        lib: Mutex<Option<Library>>,
        changes: Mutex<Vec<Change>>,
    }

    impl Host for TestHost {
        fn library(&self) -> &Mutex<Option<Library>> {
            &self.lib
        }
        fn changed(&self, change: &Change) {
            self.changes.lock().unwrap().push(change.clone());
        }
    }

    fn setup(names: &[&str]) -> (tempfile::TempDir, TestHost, Vec<String>) {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::create(&dir.path().join("T.library")).unwrap();
        let mut ids = Vec::new();
        for (n, name) in names.iter().enumerate() {
            let id = format!("{:08x}{}", n + 1, "0".repeat(24));
            let ext = name.rsplit_once('.').map(|(_, x)| x).unwrap_or("");
            lib.conn
                .execute(
                    "INSERT INTO items (id, name, file_name, ext, width, height, size, hash, thumb, imported_at)
                     VALUES (?1, ?2, ?2, ?3, 1, 1, 1, ?1, '', 0)",
                    rusqlite::params![id, name, ext],
                )
                .unwrap();
            ids.push(id);
        }
        (dir, TestHost { lib: Mutex::new(Some(lib)), changes: Mutex::new(vec![]) }, ids)
    }

    fn run(host: &TestHost, name: &str, args: Value) -> (bool, String) {
        let out = call(host, name, &args);
        let text = out.content.iter().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n");
        (out.is_error, text)
    }

    fn conn(host: &TestHost) -> std::sync::MutexGuard<'_, Option<Library>> {
        host.lib.lock().unwrap()
    }

    #[test]
    fn finds_by_name_and_tags_by_rule() {
        let (_d, host, ids) = setup(&["IMG_kyoto_01.jpg", "kyoto-trip.png", "tokyo.jpg"]);
        let (err, text) = run(&host, "find_items", json!({ "where": { "name_contains": "KYOTO" } }));
        assert!(!err, "{text}");
        assert!(text.starts_with("該当 2 件"), "{text}");
        assert!(text.contains("00000001\t画像\tIMG_kyoto_01.jpg"), "{text}");

        // Dry run: nothing changes, nothing is recorded.
        let args = json!({ "where": { "name_contains": "kyoto" }, "tags": ["京都"], "dry_run": true });
        let (err, text) = run(&host, "add_tags", args);
        assert!(!err && text.contains("試し実行") && text.contains("「京都」2 件"), "{text}");
        assert!(db::list_tags(&conn(&host).as_ref().unwrap().conn, None).unwrap().is_empty());
        assert!(host.changes.lock().unwrap().is_empty());

        let (err, text) = run(&host, "add_tags", json!({ "where": { "name_contains": "kyoto" }, "tags": ["京都"] }));
        assert!(!err && text.contains("変更番号"), "{text}");
        assert_eq!(host.changes.lock().unwrap().len(), 1);
        let (_, text) = run(&host, "find_items", json!({ "where": { "untagged": true } }));
        assert!(text.starts_with("該当 1 件") && text.contains("tokyo.jpg"), "{text}");
        let (_, text) = run(&host, "find_items", json!({ "where": { "tags": ["京都"] } }));
        assert!(text.starts_with("該当 2 件"), "{text}");

        // Again: nothing to do.
        let (_, text) = run(&host, "add_tags", json!({ "ids": [&ids[0][..8]], "tags": ["京都"] }));
        assert!(text.starts_with("変更はありません"), "{text}");
        assert_eq!(host.changes.lock().unwrap().len(), 1);
    }

    #[test]
    fn per_item_folders_and_undo() {
        let (_d, host, ids) = setup(&["a.jpg", "b.jpg", "c.jpg"]);
        let args = json!({ "items": [
            { "id": &ids[0][..8], "folder": "写真/京都" },
            { "id": &ids[1], "folder": " 写真 / 東京 " },
            { "id": &ids[2][..10], "folder": "写真/京都" },
        ]});
        let (err, text) = run(&host, "move_to_folder", args);
        assert!(!err, "{text}");
        assert!(text.contains("「写真/京都」2 件") && text.contains("「写真/東京」1 件"), "{text}");
        let (_, list) = run(&host, "list_folders", json!({}));
        assert_eq!(list, "パス\t件数\n写真\t0\n写真/京都\t2\n写真/東京\t1\n");

        let id = host.changes.lock().unwrap()[0].id;
        let mut g = conn(&host);
        let lib = g.as_mut().unwrap();
        changes::undo(&mut lib.conn, id).unwrap();
        assert!(db::list_folders(&lib.conn, None).unwrap().is_empty(), "the folders it made are gone");
    }

    #[test]
    fn folders_and_tags_are_of_each_items_mode() {
        let (_d, host, ids) = setup(&["kyoto.jpg", "Mincho.ttf"]);
        conn(&host).as_ref().unwrap().conn.execute("UPDATE items SET kind = 'font' WHERE ext = 'ttf'", []).unwrap();
        let (err, text) = run(&host, "move_to_folder", json!({ "ids": [&ids[0][..8], &ids[1][..8]], "folder": "仕事" }));
        assert!(!err && text.contains("「仕事」2 件") && text.contains("フォント用のフォルダ「仕事」"), "{text}");
        let (_, list) = run(&host, "list_folders", json!({}));
        assert_eq!(list, "パス\t件数\n仕事\t1\n（フォント用）\nパス\t件数\n仕事\t1\n");
        let (_, list) = run(&host, "list_folders", json!({ "kind": "font" }));
        assert_eq!(list, "パス\t件数\n仕事\t1\n");
        run(&host, "add_tags", json!({ "ids": [&ids[0][..8], &ids[1][..8]], "tags": ["見本"] }));
        let (_, list) = run(&host, "list_tags", json!({}));
        assert_eq!(list, "タグ\t件数\n見本\t1\n（フォント用）\nタグ\t件数\n見本\t1\n");
        // A path and a tag name reach the items of both modes.
        let (_, text) = run(&host, "find_items", json!({ "where": { "folder": "仕事", "tags": ["見本"], "tag_match_all": true } }));
        assert!(text.starts_with("該当 2 件"), "{text}");
        let (_, text) = run(&host, "find_items", json!({ "where": { "folder": "仕事", "kind": "font" } }));
        assert!(text.starts_with("該当 1 件") && text.contains("Mincho.ttf"), "{text}");
        let (err, text) = run(&host, "create_folder", json!({ "path": "和文/明朝", "kind": "font" }));
        assert!(!err, "{text}");
        let (_, list) = run(&host, "list_folders", json!({ "kind": "image" }));
        assert!(!list.contains("和文"), "{list}");
    }

    #[test]
    fn renames_keep_the_extension() {
        assert_eq!(display_name("kyoto_01", "jpg").unwrap(), "kyoto_01.jpg");
        assert_eq!(display_name("kyoto_01.JPEG", "jpg").unwrap(), "kyoto_01.JPEG");
        assert_eq!(display_name("2023.05.12", "jpg").unwrap(), "2023.05.12.jpg");
        assert_eq!(display_name(".hidden", "png").unwrap(), ".hidden.png");
        assert!(display_name("kyoto.png", "jpg").is_err());
        assert!(display_name("a/b", "jpg").is_err());
        assert!(display_name("  ", "jpg").is_err());

        let (_d, host, ids) = setup(&["IMG_0001.jpg", "IMG_0002.jpg"]);
        let args = json!({ "items": [{ "id": &ids[0][..8], "name": "京都_01" }, { "id": &ids[1][..8], "name": "x.png" }] });
        let (err, text) = run(&host, "rename_items", args);
        assert!(err && text.contains("拡張子"), "{text}");
        let g = conn(&host);
        let it = db::get_items(&g.as_ref().unwrap().conn, &ids[..1]).unwrap().remove(0);
        assert_eq!(it.name, "IMG_0001.jpg", "one bad name: nothing changes");
        drop(g);
        let args = json!({ "items": [{ "id": &ids[0][..8], "name": "京都_01" }] });
        let (err, text) = run(&host, "rename_items", args);
        assert!(!err && text.contains("IMG_0001.jpg → 京都_01.jpg"), "{text}");
    }

    #[test]
    fn refuses_bad_targets() {
        let (_d, host, ids) = setup(&["a.jpg"]);
        let (err, text) = run(&host, "add_tags", json!({ "ids": ["ffffffff"], "tags": ["x"] }));
        assert!(err && text.contains("見つからない id"), "{text}");
        let (err, _) = run(&host, "add_tags", json!({ "ids": ["0000"], "tags": ["x"] }));
        assert!(err, "too short");
        let (err, _) = run(&host, "add_tags", json!({ "ids": [&ids[0]], "where": {}, "tags": ["x"] }));
        assert!(err, "both ids and where");
        let (err, text) = run(&host, "find_items", json!({ "where": { "folder": "ない" } }));
        assert!(err && text.contains("フォルダ「ない」"), "{text}");
        let (err, text) = run(&host, "find_items", json!({ "where": { "colour": "red" } }));
        assert!(err && text.contains("colour"), "{text}");
        let many: Vec<String> = (0..MAX_ITEMS + 1).map(|_| ids[0].clone()).collect();
        let (err, _) = run(&host, "set_note", json!({ "items": many.iter().map(|i| json!({ "id": i, "note": "x" })).collect::<Vec<_>>() }));
        assert!(err, "over the limit");
        let (err, _) = run(&host, "view_images", json!({ "ids": vec![&ids[0]; MAX_VIEW + 1] }));
        assert!(err);
    }

    #[test]
    fn tool_list_is_well_formed() {
        let tools = list();
        for t in tools.as_array().unwrap() {
            assert!(t["name"].is_string() && t["description"].is_string(), "{t}");
            assert_eq!(t["inputSchema"]["type"], "object", "{t}");
        }
    }
}

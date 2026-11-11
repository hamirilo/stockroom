//! Text-only commands (the frontend's features/texts/api.ts): reading a text
//! for the viewer, saving an edit, making a new one. docs/TEXT.md

use super::{decode, encode, Encoding, EDIT_MAX};
use crate::commands::{err, item_paths, with_lib, AppState, CmdResult};
use crate::db;
use crate::import::write_thumb;
use crate::library;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::Path;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextContent {
    text: String,
    encoding: &'static str,
    /// Larger than `EDIT_MAX`: `text` is its start.
    truncated: bool,
    /// False when truncated, or bytes had to be replaced to show it.
    editable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedText {
    encoding: &'static str,
    /// The text didn't fit the file's encoding (Shift_JIS) and was saved as UTF-8.
    encoding_changed: bool,
}

fn text_item(state: &AppState, id: String) -> CmdResult<(db::Item, std::path::PathBuf)> {
    let (item, path) = item_paths(state, &[id])?.pop().ok_or("テキストが見つかりません")?;
    if item.kind != db::Kind::Text {
        return Err("テキストではありません".into());
    }
    Ok((item, path))
}

#[tauri::command]
pub async fn read_text(app: AppHandle, id: String) -> CmdResult<TextContent> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let (_, path) = text_item(&state, id)?;
        let mut data = Vec::new();
        fs::File::open(&path).and_then(|f| f.take(EDIT_MAX + 1).read_to_end(&mut data)).map_err(err)?;
        let truncated = data.len() as u64 > EDIT_MAX;
        data.truncate(EDIT_MAX as usize);
        let d = decode(&data);
        Ok(TextContent { text: d.text, encoding: d.encoding.label(), truncated, editable: !truncated && !d.lossy })
    })
    .await
    .map_err(err)?
}

/// Writes `data` over `path` by way of a file next to it, so a crash midway
/// leaves the old file whole.
fn replace_file(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.saving"));
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// Saves an edit: the file in the encoding and line endings it had, then its
/// size, hash, thumbnail and search text.
#[tauri::command]
pub async fn save_text(app: AppHandle, id: String, text: String) -> CmdResult<SavedText> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let (item, path) = text_item(&state, id)?;
        let root = with_lib(&state, |lib| Ok(lib.root.clone()))?;
        let old = fs::read(&path).map_err(err)?;
        if old.len() as u64 > EDIT_MAX {
            return Err("大きすぎるため保存できません".into());
        }
        let was = decode(&old);
        if was.lossy {
            return Err("文字コードを判別できないため保存できません".into());
        }
        let (data, used) = encode(&text, was.encoding, was.crlf);
        let saved = SavedText { encoding: used.label(), encoding_changed: used != was.encoding };
        if data == old {
            return Ok(saved);
        }
        // Read-only once opened in another app (docs/OPEN_EXTERNAL.md); Windows
        // won't rename over it then. The saved file is a new one, writable.
        let _ = library::unprotect(&path);
        replace_file(&path, &data).map_err(err)?;
        let hash = hex::encode(Sha256::digest(&data));
        // A new name, so the list doesn't show the old one from its cache.
        let thumb_img = super::thumbnail(&text, &item.ext);
        let thumbs = root.join("thumbs");
        let thumb = write_thumb(&thumb_img, &thumbs, &format!("{}_t{}", item.id, db::now_ms())).map_err(err)?;
        with_lib(&state, |lib| {
            if lib.root != root {
                let _ = fs::remove_file(thumbs.join(&thumb));
                return Err("保存中にライブラリが切り替わりました".into());
            }
            db::set_text(&lib.conn, &item.id, &hash, data.len() as i64, &thumb, &super::body(&text)).map_err(err)?;
            if item.thumb != thumb {
                let _ = fs::remove_file(thumbs.join(&item.thumb));
            }
            Ok(())
        })?;
        Ok(saved)
    })
    .await
    .map_err(err)?
}

/// Makes a new text named `name` (with its extension) holding `text`, in
/// `folder_id` if given. Not checked for duplicates: two empty notes are two
/// notes. Returns its id.
#[tauri::command]
pub async fn create_text(app: AppHandle, name: String, text: String, folder_id: Option<String>) -> CmdResult<String> {
    crate::limits::require_kind(crate::db::Kind::Text)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let ext = Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .filter(|e| super::is_text(e))
            .ok_or("テキストの形式ではありません")?;
        // A new CSV opens in Excel without garbling with a BOM; the rest are plain UTF-8.
        let encoding = if ext == "csv" || ext == "tsv" { Encoding::Utf8Bom } else { Encoding::Utf8 };
        let (data, _) = encode(&text, encoding, false);
        let hash = hex::encode(Sha256::digest(&data));
        let root = with_lib(&state, |lib| Ok(lib.root.clone()))?;
        let item = super::new_item(&root, name, ext, data, hash)?;
        with_lib(&state, |lib| {
            if lib.root != root {
                library::remove_item_dir(&root, &item.id);
                return Err("作成中にライブラリが切り替わりました".into());
            }
            let tx = lib.conn.transaction().map_err(err)?;
            db::insert_item(&tx, &item, db::now_ms()).map_err(err)?;
            if let Some(f) = folder_id.as_deref() {
                db::move_to_folder(&tx, std::slice::from_ref(&item.id), f).map_err(err)?;
            }
            tx.commit().map_err(err)?;
            Ok(item.id)
        })
    })
    .await
    .map_err(err)?
}

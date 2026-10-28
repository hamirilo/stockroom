//! A video's own thumbnail (docs/VIDEO.md): a picture the user picked (an
//! image file, the clipboard, an image of the library, the adopted child)
//! in place of the frame from the OS.
//!
//! It is written as `thumbs/<id>_c<time>.*`, a new name each time so the list
//! doesn't show the old one from its cache. The frame made at import
//! (`<id>.*`) stays next to it: going back to it (`reset`) needs no OS.
//! Nothing else in the database marks it; `is_custom` reads the name.

use crate::db::{self, Item, Kind};
use crate::import::{write_thumb, THUMB_MAX};
use crate::library::{self, Library};
use image::DynamicImage;
use std::fs;
use std::path::Path;

/// Where the picture comes from.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", tag = "from")]
pub enum Source {
    /// An image file on the disk.
    File { path: String },
    /// The image on the clipboard.
    Clipboard,
    /// An item of the library: its thumbnail (oriented, the list's size already).
    Item { id: String },
    /// The video's adopted child (docs/LINKS.md).
    Adopted,
}

/// The thumbnail is the user's own, not the frame from the OS.
pub fn is_custom(thumb: &str) -> bool {
    let stem = thumb.rsplit_once('.').map_or(thumb, |(s, _)| s);
    stem.rsplit_once("_c").is_some_and(|(_, t)| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()))
}

/// The thumbnail files an item can have besides `item.thumb`: the frame (or
/// unrotated image) it was made from. For removing and copying them along.
pub fn other_thumbs(item: &Item) -> Vec<String> {
    let mut out = vec![crate::orient::base_thumb(&item.thumb)];
    if is_custom(&item.thumb) {
        out.extend(["jpg", "png"].map(|ext| format!("{}.{ext}", item.id)));
    }
    out.retain(|t| *t != item.thumb);
    out
}

fn video(lib: &Library, id: &str) -> Result<Item, String> {
    let item = db::get_items(&lib.conn, &[id.to_owned()]).map_err(|e| e.to_string())?.pop().ok_or("動画が見つかりません")?;
    if item.kind != Kind::Video {
        return Err("サムネイルを変えられるのは動画だけです".into());
    }
    if item.deleted_at.is_some() {
        return Err("ゴミ箱の中の動画は変えられません".into());
    }
    Ok(item)
}

/// The picture `source` gives for the video `id`.
pub fn picture(lib: &Library, id: &str, source: &Source) -> Result<DynamicImage, String> {
    let from_item = |item_id: &str| -> Result<DynamicImage, String> {
        let item = db::get_items(&lib.conn, &[item_id.to_owned()])
            .map_err(|e| e.to_string())?
            .pop()
            .ok_or("画像が見つかりません")?;
        image::open(lib.thumb_path(&item)).map_err(|e| e.to_string())
    };
    match source {
        Source::File { path } => {
            let path = Path::new(path);
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            let data = fs::read(path).map_err(|e| e.to_string())?;
            crate::formats::decode(&data, &ext).map(|d| d.image).map_err(|_| "画像として読めませんでした".into())
        }
        Source::Clipboard => {
            use clipboard_rs::{common::RustImage, Clipboard, ClipboardContext};
            let ctx = ClipboardContext::new().map_err(|e| e.to_string())?;
            let img = ctx.get_image().map_err(|_| "クリップボードに画像がありません")?;
            let png = img.to_png().map_err(|e| e.to_string())?;
            image::load_from_memory(png.get_bytes()).map_err(|e| e.to_string())
        }
        Source::Item { id: item_id } => {
            if item_id == id {
                return Err("自分自身はサムネイルにできません".into());
            }
            from_item(item_id)
        }
        Source::Adopted => {
            let child: Option<String> = lib
                .conn
                .query_row(
                    "SELECT id FROM items WHERE parent_id = ?1 AND adopted = 1 AND deleted_at IS NULL",
                    [id],
                    |r| r.get(0),
                )
                .ok();
            from_item(&child.ok_or("採用した子がありません")?)
        }
    }
}

/// Makes `img` the thumbnail of the video `id`; returns its file name.
pub fn set(lib: &Library, id: &str, img: &DynamicImage) -> Result<String, String> {
    let item = video(lib, id)?;
    let small = if img.width().max(img.height()) > THUMB_MAX { img.thumbnail(THUMB_MAX, THUMB_MAX) } else { img.clone() };
    let dir = lib.root.join("thumbs");
    let thumb = write_thumb(&small, &dir, &format!("{id}_c{}", db::now_ms()))?;
    if let Err(e) = db::set_thumb(&lib.conn, id, &thumb) {
        let _ = fs::remove_file(dir.join(&thumb));
        return Err(e.to_string());
    }
    if is_custom(&item.thumb) && item.thumb != thumb {
        let _ = fs::remove_file(dir.join(&item.thumb));
    }
    Ok(thumb)
}

/// Back to the frame from the OS: the one kept from the import, or a new one.
pub fn reset(lib: &Library, id: &str) -> Result<(), String> {
    let item = video(lib, id)?;
    if !is_custom(&item.thumb) {
        return Ok(());
    }
    let dir = lib.root.join("thumbs");
    let kept = ["jpg", "png"].map(|ext| format!("{id}.{ext}")).into_iter().find(|t| dir.join(t).is_file());
    let thumb = match kept {
        Some(t) => t,
        None => {
            let path = library::file_path(&lib.root, &item);
            write_thumb(&crate::files::thumbnail(&path, &item.ext, THUMB_MAX), &dir, id)?
        }
    };
    db::set_thumb(&lib.conn, id, &thumb).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(dir.join(&item.thumb));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_custom_thumbnails_by_name() {
        assert!(is_custom("abc_c1730000000000.jpg"));
        assert!(is_custom("abc_c1.png"));
        assert!(!is_custom("abc.jpg"));
        assert!(!is_custom("abc_p.jpg"));
        assert!(!is_custom("abc_o01.jpg"));
        assert!(!is_custom("abc_c.jpg"));
        assert!(!is_custom("abc_cx1.jpg"));
    }

    #[test]
    fn sets_a_thumbnail_and_goes_back_to_the_frame() {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::create(&dir.path().join("T.library")).unwrap();
        let thumbs = lib.root.join("thumbs");
        for (id, kind, thumb) in [("v", "video", "v.jpg"), ("i", "image", "i.jpg")] {
            lib.conn
                .execute(
                    "INSERT INTO items (id, kind, name, file_name, ext, width, height, size, hash, thumb, imported_at)
                     VALUES (?1, ?2, ?1, ?1, 'mp4', 1, 1, 1, ?1, ?3, 0)",
                    rusqlite::params![id, kind, thumb],
                )
                .unwrap();
            DynamicImage::new_rgb8(8, 8).save(thumbs.join(thumb)).unwrap();
        }
        let thumb_of = || db::get_items(&lib.conn, &["v".to_owned()]).unwrap().remove(0).thumb;

        assert!(set(&lib, "i", &DynamicImage::new_rgb8(4, 4)).is_err(), "videos only");
        let img = picture(&lib, "v", &Source::Item { id: "i".into() }).unwrap();
        let first = set(&lib, "v", &img).unwrap();
        assert!(is_custom(&first) && thumbs.join(&first).is_file() && thumbs.join("v.jpg").is_file());
        std::thread::sleep(std::time::Duration::from_millis(2));
        let second = set(&lib, "v", &DynamicImage::new_rgb8(1024, 512)).unwrap();
        assert_ne!(first, second);
        assert!(!thumbs.join(&first).exists(), "the one it replaced is gone");
        assert_eq!(image::open(thumbs.join(&second)).unwrap().width(), THUMB_MAX);
        assert_eq!(thumb_of(), second);
        let item = db::get_items(&lib.conn, &["v".to_owned()]).unwrap().remove(0);
        assert!(other_thumbs(&item).contains(&"v.jpg".to_string()));

        reset(&lib, "v").unwrap();
        assert_eq!(thumb_of(), "v.jpg");
        assert!(!thumbs.join(&second).exists());
        // No adopted child: nothing to take.
        assert!(picture(&lib, "v", &Source::Adopted).is_err());
    }
}

//! Bookmarks: a URL kept like any other item (docs/BOOKMARKS.md). The app never
//! fetches the page: the title, description, favicon and eyecatch (`og:image`)
//! come from whoever saves it (the browser extension reads them off the page).
//! Saved by pasting a URL, they have none of those and show the host.
//!
//! The item's file is an internet shortcut (`<title>.url`), so export, sharing
//! and copying between libraries need nothing new. The address is also in
//! `items.source_url`; the search box looks in `items.body` (title, address,
//! description). The description starts as the item's memo.
//!
//! A bookmark has no pixel size (0 × 0) and takes no part in the look-alike search.

use crate::db::{self, NewItem};
use crate::import::{sanitize, write_thumb, THUMB_MAX};
use crate::library::{self, Library};
use base64::Engine as _;
use image::DynamicImage;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::path::Path;
use std::sync::Mutex;

pub mod commands;

pub const EXT: &str = "url";

/// Errors of `add` that callers tell apart.
pub const NO_FOLDER: &str = "保存先のフォルダが見つかりません";
pub const NO_LIBRARY: &str = "ライブラリが開かれていません";

/// Most that is read of what the page says about itself (characters).
const TITLE_MAX: usize = 200;
const DESCRIPTION_MAX: usize = 1000;
/// Largest picture taken in (bytes, after decoding the base64).
const IMAGE_MAX: usize = 8 << 20;

/// What a bookmark is made of. Everything but `url` may be missing.
#[derive(Debug, Default, Clone, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Input {
    pub url: String,
    pub title: String,
    pub description: String,
    /// `data:image/…;base64,…` (the extension sends it as PNG / JPEG).
    pub favicon: Option<String>,
    pub image: Option<String>,
}

/// What `add` did.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    pub id: String,
    /// The address was already kept (new tags and folder only fill in).
    pub duplicate: bool,
}

/// The address as it is compared: `http(s)` only, the host in lower case, no
/// fragment, no tracking parameters (`utm_*`, `fbclid`, `gclid` …) and no
/// trailing slash. None if it isn't an http(s) address.
pub fn normalize_url(url: &str) -> Option<String> {
    let url = url.trim();
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    if rest.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let rest = rest.split('#').next().unwrap_or("");
    let (before_query, query) = rest.split_once('?').unwrap_or((rest, ""));
    let (authority, path) = match before_query.find('/') {
        Some(i) => before_query.split_at(i),
        None => (before_query, ""),
    };
    // Credentials in the address aren't kept.
    let host = authority.rsplit('@').next().unwrap_or("").to_ascii_lowercase();
    let host = match (scheme.as_str(), host.rsplit_once(':')) {
        ("http", Some((h, "80"))) | ("https", Some((h, "443"))) => h.to_string(),
        _ => host,
    };
    if host.is_empty() {
        return None;
    }
    let path = path.trim_end_matches('/');
    let kept: Vec<&str> = query
        .split('&')
        .filter(|p| {
            let key = p.split('=').next().unwrap_or("").to_ascii_lowercase();
            !p.is_empty() && !key.starts_with("utm_") && !matches!(key.as_str(), "fbclid" | "gclid" | "yclid" | "msclkid" | "mc_eid")
        })
        .collect();
    let mut out = format!("{scheme}://{host}{path}");
    if !kept.is_empty() {
        out.push('?');
        out.push_str(&kept.join("&"));
    }
    Some(out)
}

/// What identifies a bookmark among the items (`items.hash`).
pub fn hash_of(normalized: &str) -> String {
    hex::encode(Sha256::digest(format!("bookmark\n{normalized}").as_bytes()))
}

/// "example.com" for the title of a bookmark that has none.
pub fn host_of(normalized: &str) -> String {
    let rest = normalized.split_once("://").map_or(normalized, |(_, r)| r);
    let host = rest.split(['/', '?']).next().unwrap_or(rest);
    host.strip_prefix("www.").unwrap_or(host).to_string()
}

fn clip(s: &str, max: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    s.chars().take(max).collect()
}

/// The bytes of a `data:` URL, if it is a base64 picture.
fn data_url_bytes(s: &str) -> Option<Vec<u8>> {
    let (head, b64) = s.strip_prefix("data:")?.split_once(',')?;
    if !head.starts_with("image/") || !head.ends_with(";base64") || b64.len() > IMAGE_MAX * 4 / 3 + 4 {
        return None;
    }
    base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok().filter(|d| d.len() <= IMAGE_MAX)
}

fn decode_image(s: &Option<String>) -> Option<DynamicImage> {
    let bytes = data_url_bytes(s.as_deref()?)?;
    image::load_from_memory(&bytes).ok()
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Breaks `s` into lines of at most `width` characters (at most `lines`; the
/// last ends with "…" when cut). Wide (CJK) characters count twice.
fn wrap(s: &str, width: usize, lines: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut line = String::new();
    let mut used = 0;
    for c in s.chars() {
        let w = if c.is_ascii() { 1 } else { 2 };
        if used + w > width {
            out.push(std::mem::take(&mut line));
            used = 0;
            if out.len() == lines {
                break;
            }
        }
        line.push(c);
        used += w;
    }
    if out.len() < lines && !line.is_empty() {
        out.push(line);
    } else if out.len() == lines {
        if let Some(last) = out.last_mut() {
            last.pop();
            last.push('…');
        }
    }
    out
}

/// The card shown when the page has no eyecatch: the favicon, the title and the host.
/// Square, so the grid's centre crop leaves all of it.
fn card(title: &str, host: &str, favicon: Option<&DynamicImage>) -> DynamicImage {
    const W: f32 = 384.0;
    const H: f32 = 384.0;
    const SANS: &str = "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', 'Yu Gothic', Meiryo, 'Noto Sans CJK JP', sans-serif";
    let mut svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}"><rect x="0.5" y="0.5" width="{}" height="{}" fill="#f6f7f9" stroke="#e2e2e2"/>"##,
        W - 1.0,
        H - 1.0
    );
    if let Some(icon) = favicon {
        let mut png = std::io::Cursor::new(Vec::new());
        if icon.thumbnail(64, 64).write_to(&mut png, image::ImageFormat::Png).is_ok() {
            let b64 = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
            let _ = write!(svg, r#"<image x="28" y="28" width="40" height="40" href="data:image/png;base64,{b64}"/>"#);
        }
    }
    for (i, line) in wrap(title, 26, 3).iter().enumerate() {
        let _ = write!(
            svg,
            r##"<text x="28" y="{}" font-family="{SANS}" font-size="22" font-weight="600" fill="#1f2328">{}</text>"##,
            150.0 + i as f32 * 32.0,
            xml_escape(line)
        );
    }
    let host: String = host.chars().take(38).collect();
    let _ = write!(
        svg,
        r##"<text x="28" y="{}" font-family="{SANS}" font-size="16" fill="#6b7280">{}</text></svg>"##,
        H - 28.0,
        xml_escape(&host)
    );
    crate::formats::rasterize_svg(svg.as_bytes(), THUMB_MAX as f32)
        .map(|d| d.image)
        // The SVG is ours; a blank card if it fails anyway.
        .unwrap_or_else(|_| DynamicImage::ImageRgb8(image::RgbImage::from_pixel(384, 384, image::Rgb([246, 247, 249]))))
}

/// The internet shortcut stored as the item's file.
fn shortcut(normalized: &str) -> Vec<u8> {
    format!("[InternetShortcut]\r\nURL={normalized}\r\n").into_bytes()
}

/// What the search box looks in: the title, the address and the description.
fn body(title: &str, normalized: &str, description: &str) -> String {
    format!("{title}\n{normalized}\n{description}")
}

/// A new library item for the bookmark (stores its file and thumbnail).
/// Returns the item and the description to start its memo with.
pub fn new_item(root: &Path, input: &Input, normalized: &str) -> Result<(NewItem, String), String> {
    let host = host_of(normalized);
    let title = clip(&input.title, TITLE_MAX);
    let title = if title.is_empty() { host.clone() } else { title };
    let description = clip(&input.description, DESCRIPTION_MAX);
    let id = uuid::Uuid::new_v4().simple().to_string();
    let file_name = format!("{}.{EXT}", sanitize(&title.chars().take(80).collect::<String>()));
    let data = shortcut(normalized);
    library::store_file(root, &id, &file_name, &data)?;
    let eyecatch = decode_image(&input.image).map(|i| if i.width().max(i.height()) > THUMB_MAX { i.thumbnail(THUMB_MAX, THUMB_MAX) } else { i });
    let thumb_image = eyecatch.unwrap_or_else(|| card(&title, &host, decode_image(&input.favicon).as_ref()));
    let thumb = write_thumb(&thumb_image, &root.join("thumbs"), &id).inspect_err(|_| library::remove_item_dir(root, &id))?;
    let item = NewItem {
        id,
        kind: db::Kind::Bookmark,
        body: Some(body(&title, normalized, &description)),
        name: title,
        file_name,
        ext: EXT.into(),
        width: 0,
        height: 0,
        size: data.len() as i64,
        hash: hash_of(normalized),
        thumb,
        phash: None,
        preview: None,
        font: None,
        duration_ms: None,
    };
    Ok((item, description))
}

/// Keeps a bookmark in the open library, in `folder_id` (a folder of the
/// stock) with `tags`. An address that is already kept isn't added again: it
/// comes back from the trash if it was there, and the tags are added to it.
pub fn add(lib: &Mutex<Option<Library>>, input: &Input, folder_id: Option<&str>, tags: &[String]) -> Result<Added, String> {
    let normalized = normalize_url(&input.url).ok_or("http:// か https:// で始まる URL を入れてください")?;
    let hash = hash_of(&normalized);
    let root = {
        let guard = lib.lock().unwrap();
        let l = guard.as_ref().ok_or(NO_LIBRARY)?;
        if let Some(f) = folder_id {
            if db::folder_mode(&l.conn, f).map_err(|e| e.to_string())? != Some(db::Mode::Stock) {
                return Err(NO_FOLDER.into());
            }
        }
        l.root.clone()
    };
    let existing = || -> Result<Option<String>, String> {
        let guard = lib.lock().unwrap();
        let l = guard.as_ref().ok_or(NO_LIBRARY)?;
        db::item_by_hash(&l.conn, &hash).map_err(|e| e.to_string())
    };
    let (id, duplicate, new) = match existing()? {
        Some(id) => (id, true, None),
        None => {
            let (item, description) = new_item(&root, input, &normalized)?;
            (item.id.clone(), false, Some((item, description)))
        }
    };
    let mut guard = lib.lock().unwrap();
    let l = match guard.as_mut() {
        Some(l) if l.root == root => l,
        _ => {
            if new.is_some() {
                library::remove_item_dir(&root, &id);
            }
            return Err("保存中にライブラリが切り替わりました".into());
        }
    };
    let result = (|| -> rusqlite::Result<()> {
        let tx = l.conn.transaction()?;
        match &new {
            Some((item, description)) => {
                db::insert_item(&tx, item, db::now_ms())?;
                db::set_source_url(&tx, std::slice::from_ref(&id), &normalized)?;
                if !description.is_empty() {
                    db::set_note(&tx, &id, description)?;
                }
                if let Some(f) = folder_id {
                    db::move_to_folder(&tx, std::slice::from_ref(&id), f)?;
                }
            }
            None => {
                db::restore_items(&tx, std::slice::from_ref(&id))?;
                if let Some(f) = folder_id {
                    db::file_unfiled(&tx, std::slice::from_ref(&id), f)?;
                }
            }
        }
        tx.commit()
    })();
    if let Err(e) = result {
        if new.is_some() {
            library::remove_item_dir(&root, &id);
        }
        return Err(e.to_string());
    }
    db::add_tags(&mut l.conn, std::slice::from_ref(&id), tags).map_err(|e| e.to_string())?;
    Ok(Added { id, duplicate })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_addresses() {
        let n = |s: &str| normalize_url(s);
        assert_eq!(n("HTTPS://Example.COM/a/?utm_source=x&b=1&fbclid=z#top").as_deref(), Some("https://example.com/a?b=1"));
        assert_eq!(n("https://example.com/").as_deref(), Some("https://example.com"));
        assert_eq!(n("  http://example.com:80/x  ").as_deref(), Some("http://example.com/x"));
        assert_eq!(n("https://user:pw@example.com:8443/p").as_deref(), Some("https://example.com:8443/p"));
        assert_eq!(n("https://example.com/search?q=a&utm_medium=m").as_deref(), Some("https://example.com/search?q=a"));
        for bad in ["javascript:alert(1)", "file:///etc/passwd", "ftp://example.com", "https://", "example.com", "https://a b.example/", ""] {
            assert_eq!(n(bad), None, "{bad}");
        }
    }

    #[test]
    fn titles_and_hosts() {
        assert_eq!(host_of("https://www.example.com/a?b=1"), "example.com");
        assert_eq!(host_of("http://example.com:8080"), "example.com:8080");
        assert_eq!(clip("  a \n b\t c ", 10), "a b c");
        assert_eq!(wrap("abcdef", 4, 1), ["abc…"]);
        assert_eq!(wrap("あいうえお", 4, 3), ["あい", "うえ", "お"]);
    }

    #[test]
    fn only_base64_pictures_are_taken() {
        let png = {
            let mut buf = std::io::Cursor::new(Vec::new());
            DynamicImage::ImageRgb8(image::RgbImage::from_pixel(4, 4, image::Rgb([1, 2, 3]))).write_to(&mut buf, image::ImageFormat::Png).unwrap();
            base64::engine::general_purpose::STANDARD.encode(buf.into_inner())
        };
        assert!(decode_image(&Some(format!("data:image/png;base64,{png}"))).is_some());
        assert!(decode_image(&Some(format!("data:text/html;base64,{png}"))).is_none());
        assert!(decode_image(&Some("https://example.com/a.png".into())).is_none());
        assert!(decode_image(&Some("data:image/png;base64,@@@".into())).is_none());
        assert!(decode_image(&None).is_none());
    }

    fn png_data_url(color: [u8; 3]) -> String {
        let mut buf = std::io::Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(image::RgbImage::from_pixel(64, 32, image::Rgb(color))).write_to(&mut buf, image::ImageFormat::Png).unwrap();
        format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(buf.into_inner()))
    }

    fn open() -> (tempfile::TempDir, Mutex<Option<Library>>) {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::create(&dir.path().join("B.library")).unwrap();
        (dir, Mutex::new(Some(lib)))
    }

    #[test]
    fn keeps_a_page_once_and_finds_it_again() {
        let (_tmp, lib) = open();
        let tags = vec!["参考".to_string()];
        let page = Input {
            url: "https://Example.com/a/?utm_source=x#frag".into(),
            title: "  記事の\nタイトル ".into(),
            description: "説明文です".into(),
            favicon: Some(png_data_url([200, 30, 30])),
            image: None,
        };
        let first = add(&lib, &page, None, &tags).unwrap();
        assert!(!first.duplicate);
        {
            let g = lib.lock().unwrap();
            let l = g.as_ref().unwrap();
            let it = db::get_items(&l.conn, std::slice::from_ref(&first.id)).unwrap().remove(0);
            assert_eq!((it.kind, it.ext.as_str(), it.name.as_str()), (db::Kind::Bookmark, "url", "記事の タイトル"));
            assert_eq!(it.source_url.as_deref(), Some("https://example.com/a"));
            assert_eq!(it.note, "説明文です");
            assert_eq!(it.tag_ids.len(), 1);
            let file = l.file_path(&it);
            assert_eq!(std::fs::read_to_string(file).unwrap(), "[InternetShortcut]\r\nURL=https://example.com/a\r\n");
            assert!(l.root.join("thumbs").join(&it.thumb).exists());
        }
        // The same page from another address spelling: not added again, tags are.
        let again = Input { url: "https://example.com/a?fbclid=1".into(), ..Input::default() };
        let second = add(&lib, &again, None, &["あとで".to_string()]).unwrap();
        assert_eq!((second.id.as_str(), second.duplicate), (first.id.as_str(), true));
        let g = lib.lock().unwrap();
        let it = db::get_items(&g.as_ref().unwrap().conn, &[first.id]).unwrap().remove(0);
        assert_eq!(it.tag_ids.len(), 2);
    }

    #[test]
    fn pasted_address_is_titled_with_its_host_and_trash_is_restored() {
        let (_tmp, lib) = open();
        let page = Input { url: "https://www.example.com/x".into(), ..Input::default() };
        let a = add(&lib, &page, None, &[]).unwrap();
        {
            let mut g = lib.lock().unwrap();
            let conn = &mut g.as_mut().unwrap().conn;
            let it = db::get_items(conn, std::slice::from_ref(&a.id)).unwrap().remove(0);
            assert_eq!((it.name.as_str(), it.note.as_str()), ("example.com", ""));
            db::trash_items(conn, std::slice::from_ref(&a.id)).unwrap();
        }
        let b = add(&lib, &page, None, &[]).unwrap();
        assert_eq!((b.id.as_str(), b.duplicate), (a.id.as_str(), true));
        let g = lib.lock().unwrap();
        let it = db::get_items(&g.as_ref().unwrap().conn, &[a.id]).unwrap().remove(0);
        assert_eq!(it.deleted_at, None);
    }

    #[test]
    fn refuses_other_addresses_and_missing_folders() {
        let (_tmp, lib) = open();
        let bad = Input { url: "javascript:alert(1)".into(), ..Input::default() };
        assert!(add(&lib, &bad, None, &[]).is_err());
        let ok = Input { url: "https://example.com".into(), ..Input::default() };
        assert_eq!(add(&lib, &ok, Some("gone"), &[]).unwrap_err(), NO_FOLDER);
        *lib.lock().unwrap() = None;
        assert_eq!(add(&lib, &ok, None, &[]).unwrap_err(), NO_LIBRARY);
    }

    #[test]
    fn eyecatch_becomes_the_thumbnail() {
        let (_tmp, lib) = open();
        let page = Input { url: "https://example.com/e".into(), image: Some(png_data_url([0, 0, 255])), ..Input::default() };
        let a = add(&lib, &page, None, &[]).unwrap();
        let g = lib.lock().unwrap();
        let l = g.as_ref().unwrap();
        let it = db::get_items(&l.conn, &[a.id]).unwrap().remove(0);
        let img = image::open(l.root.join("thumbs").join(&it.thumb)).unwrap().to_rgb8();
        assert_eq!((img.width(), img.height()), (64, 32));
    }
}

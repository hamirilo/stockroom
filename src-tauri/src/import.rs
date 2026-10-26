//! Importing: copy into the library, hash for de-duplication, make thumbnails.
//! File work runs in parallel without touching the DB; rows are written
//! afterwards in a single transaction.

use crate::db::{self, NewItem};
use crate::files;
use crate::fonts;
use crate::formats;
use crate::library::{self, Library};
use crate::orient::{self, OrientOp, Orientation};
use crate::similar;
use crate::texts;
use crate::videos;
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageFormat};
use rayon::prelude::*;
use rusqlite::Connection;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use walkdir::WalkDir;

pub use formats::SUPPORTED_EXTS;
pub(crate) const THUMB_MAX: u32 = 512;
/// Longest side of display copies (see `formats::needs_preview`).
const PREVIEW_MAX: u32 = 4096;

pub enum Source {
    /// `dirs` is the folder path to file it under, relative to the import
    /// target (e.g. `["Trip", "Day1"]` for `Trip/Day1/x.jpg` from a dropped `Trip`).
    Path { path: PathBuf, dirs: Vec<String> },
    Bytes { name: String, data: Vec<u8> },
}

impl Source {
    pub fn file(path: impl Into<PathBuf>) -> Self {
        Source::Path { path: path.into(), dirs: vec![] }
    }

    fn label(&self) -> String {
        match self {
            Source::Path { path, .. } => path.display().to_string(),
            Source::Bytes { name, .. } => name.clone(),
        }
    }

    fn dirs(&self) -> &[String] {
        match self {
            Source::Path { dirs, .. } => dirs,
            Source::Bytes { .. } => &[],
        }
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub imported: usize,
    pub duplicates: usize,
    pub failed: Vec<String>,
    /// New items by kind (to tell when a kind the library isn't used for arrived).
    pub kinds: std::collections::BTreeMap<db::Kind, usize>,
    /// The library items the sources ended up as (new and already known), in
    /// import order, for follow-up changes such as tagging.
    #[serde(skip)]
    pub ids: Vec<String>,
}

fn ext_of(name: &str) -> Option<String> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    SUPPORTED_EXTS.contains(&ext.as_str()).then_some(ext)
}

/// Expands dropped paths. Directories are walked recursively and keep their
/// structure as folders (the dropped directory itself becomes a folder);
/// hidden and unsupported files are skipped.
pub fn collect_files(paths: &[PathBuf]) -> Vec<Source> {
    let mut out = Vec::new();
    for p in paths {
        if p.is_dir() {
            let base = p.parent().unwrap_or(p);
            for e in WalkDir::new(p)
                .into_iter()
                // Hidden entries, and iWork packages (folders that are one document).
                .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.') && !files::is_package(e.path()))
                .filter_map(Result::ok)
            {
                if e.file_type().is_file() && ext_of(&e.file_name().to_string_lossy()).is_some() {
                    let dirs = e
                        .path()
                        .parent()
                        .and_then(|d| d.strip_prefix(base).ok())
                        .map(|rel| {
                            rel.components()
                                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                                .collect()
                        })
                        .unwrap_or_default();
                    out.push(Source::Path { path: e.into_path(), dirs });
                }
            }
        } else if p.is_file() {
            if let Some(name) = p.file_name() {
                if ext_of(&name.to_string_lossy()).is_some() {
                    out.push(Source::file(p.clone()));
                }
            }
        }
    }
    out
}

enum Outcome {
    New(NewItem),
    Duplicate(String), // existing item id
    Failed(String),
}

/// Keeps file names portable across macOS and Windows.
pub(crate) fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.');
    if trimmed.is_empty() { "image".into() } else { trimmed.into() }
}

fn write_jpeg(img: &DynamicImage, path: &Path, quality: u8) -> Result<(), String> {
    let file = fs::File::create(path).map_err(|e| e.to_string())?;
    JpegEncoder::new_with_quality(std::io::BufWriter::new(file), quality)
        .encode_image(&img.to_rgb8())
        .map_err(|e| e.to_string())
}

/// Writes a JPEG thumbnail, or PNG when the image has real transparency.
/// Returns the thumbnail's file name.
pub(crate) fn write_thumb(thumb: &DynamicImage, dir: &Path, id: &str) -> Result<String, String> {
    let transparent = thumb.color().has_alpha() && thumb.to_rgba8().pixels().any(|p| p[3] < 255);
    if transparent {
        let name = format!("{id}.png");
        thumb
            .save_with_format(dir.join(&name), ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        Ok(name)
    } else {
        let name = format!("{id}.jpg");
        write_jpeg(thumb, &dir.join(&name), 85)?;
        Ok(name)
    }
}

/// Rotates / flips items (see orient.rs): writes the thumbnail for the new
/// orientation from the unrotated one, then stores it. The unrotated
/// thumbnail is kept; the previous rotated one is removed. Returns how many
/// items changed.
pub fn orient(lib: &mut Library, ids: &[String], op: OrientOp) -> Result<usize, String> {
    let job = OrientJob::plan(lib, ids, op)?;
    let rendered = job.render();
    job.commit(lib, rendered)
}

/// Orienting in three steps, so the slow middle one (re-rendering thumbnails)
/// runs without holding the library: `plan` and `commit` need it, `render`
/// doesn't (commands.rs `orient_items`).
pub struct OrientJob {
    root: PathBuf,
    /// Images whose orientation changes: (item, from, to).
    changes: Vec<(db::Item, Orientation, Orientation)>,
}

/// A rendered change: (id, old thumbnail, orientation, new thumbnail, displayed size).
type Rendered = Result<(String, String, Orientation, String, (u32, u32)), String>;

impl OrientJob {
    pub fn plan(lib: &Library, ids: &[String], op: OrientOp) -> Result<Self, String> {
        let items = db::get_items(&lib.conn, ids).map_err(|e| e.to_string())?;
        let changes = items
            .into_iter()
            .filter(|it| it.kind == db::Kind::Image)
            .filter_map(|it| {
                let from = Orientation::new(it.rotation, it.flipped);
                let to = from.then(op);
                (to != from).then_some((it, from, to))
            })
            .collect();
        Ok(Self { root: lib.root.clone(), changes })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn render(&self) -> Vec<Rendered> {
        let thumbs = self.root.join("thumbs");
        self.changes
            .par_iter()
            .map(|(it, from, to)| {
                let base = orient::base_thumb(&it.thumb);
                let name = to.thumb_name(&base);
                if !to.is_identity() {
                    let img = image::open(thumbs.join(&base)).map_err(|e| format!("{}: {e}", it.name))?;
                    let out = to.apply(&img);
                    let path = thumbs.join(&name);
                    if name.ends_with(".png") {
                        out.save_with_format(&path, ImageFormat::Png).map_err(|e| e.to_string())?;
                    } else {
                        write_jpeg(&out, &path, 85)?;
                    }
                }
                // width / height are the displayed size: swap when going between upright and sideways.
                let size = if from.swaps_axes() != to.swaps_axes() { (it.height, it.width) } else { (it.width, it.height) };
                Ok((it.id.clone(), it.thumb.clone(), *to, name, size))
            })
            .collect()
    }

    /// Records the rendered changes; `lib` must be the library planned in.
    pub fn commit(&self, lib: &mut Library, rendered: Vec<Rendered>) -> Result<usize, String> {
        let thumbs = self.root.join("thumbs");
        let mut first_err = None;
        let mut stale = Vec::new();
        let tx = lib.conn.transaction().map_err(|e| e.to_string())?;
        let mut changed = 0;
        for r in rendered {
            match r {
                Ok((id, old, to, name, (w, h))) => {
                    db::set_orientation(&tx, &id, to, w, h, &name).map_err(|e| e.to_string())?;
                    if old != name && old != orient::base_thumb(&old) {
                        stale.push(thumbs.join(&old));
                    }
                    changed += 1;
                }
                Err(e) => {
                    first_err.get_or_insert(e);
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        for p in stale {
            let _ = fs::remove_file(p);
        }
        match first_err {
            Some(e) if changed == 0 => Err(e),
            _ => Ok(changed),
        }
    }
}

/// Takes the source: data from the extension can be up to 300 MB, and a
/// copy of it would double that.
fn process(
    src: Source,
    root: &Path,
    known: &HashMap<String, String>,
    seen: &Mutex<HashSet<String>>,
) -> Result<Outcome, String> {
    // Videos can be gigabytes: they are hashed and copied from the disk.
    let video = match &src {
        Source::Path { path, .. } => path.file_name().and_then(|n| ext_of(&n.to_string_lossy())),
        Source::Bytes { name, .. } => ext_of(name),
    }
    .filter(|e| videos::is_video(e));
    let dedupe = |hash: &str| -> Option<Outcome> {
        if let Some(existing) = known.get(hash) {
            return Some(Outcome::Duplicate(existing.clone()));
        }
        // Same file twice in this batch.
        (!seen.lock().unwrap().insert(hash.to_string())).then(|| Outcome::Duplicate(String::new()))
    };
    if let Some(ext) = video {
        return process_video(src, ext, root, dedupe);
    }
    let (name, data) = match src {
        Source::Path { path, .. } => {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            (name, fs::read(path).map_err(|e| e.to_string())?)
        }
        Source::Bytes { name, data } => (name, data),
    };
    let ext = ext_of(&name).ok_or("unsupported file type")?;
    let hash = hex::encode(Sha256::digest(&data));
    if let Some(done) = dedupe(&hash) {
        return Ok(done);
    }

    if formats::is_font(&ext) {
        return process_font(name, ext, data, hash, root);
    }
    if files::is_file(&ext) {
        return process_file(name, ext, data, hash, root);
    }
    if texts::is_text(&ext) {
        return texts::new_item(root, name, ext, data, hash).map(Outcome::New);
    }
    let decoded = formats::decode(&data, &ext)?;
    let img = decoded.image;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let file_name = sanitize(&name);
    library::store_file(root, &id, &file_name, &data)?;
    // The perceptual hash comes from the thumbnail, like the backfill in
    // `compute_missing_phashes`, so old and new items hash the same way.
    let small = img.thumbnail(THUMB_MAX, THUMB_MAX);
    let phash = (similar::dhash(&small), similar::mean_color(&small));
    let thumb = match write_thumb(&small, &root.join("thumbs"), &id) {
        Ok(t) => t,
        Err(e) => {
            library::remove_item_dir(root, &id);
            return Err(e);
        }
    };
    // HEIC / TIFF: keep a JPEG the web view can always display.
    let preview = if formats::needs_preview(&ext) {
        let name = format!("{id}.jpg");
        let big = if img.width().max(img.height()) > PREVIEW_MAX {
            img.resize(PREVIEW_MAX, PREVIEW_MAX, image::imageops::FilterType::Lanczos3)
        } else {
            img.clone()
        };
        if let Err(e) = write_jpeg(&big, &root.join("previews").join(&name), 90) {
            library::remove_item_dir(root, &id);
            let _ = fs::remove_file(root.join("thumbs").join(&thumb));
            return Err(e);
        }
        Some(name)
    } else {
        None
    };

    Ok(Outcome::New(NewItem {
        id,
        kind: db::Kind::Image,
        name,
        file_name,
        ext,
        width: decoded.width,
        height: decoded.height,
        size: data.len() as i64,
        hash,
        thumb,
        phash: Some(phash),
        preview,
        font: None,
        body: None,
        duration_ms: None,
    }))
}

/// Fonts: stored as is, with a rendered sample as the thumbnail. They have no
/// pixel size (0 × 0) and take no part in the look-alike search.
fn process_font(name: String, ext: String, data: Vec<u8>, hash: String, root: &Path) -> Result<Outcome, String> {
    let sfnt = fonts::to_sfnt(&data, &ext)?;
    let sample = fonts::render_thumb(&sfnt)?;
    let meta = fonts::meta(&sfnt)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let file_name = sanitize(&name);
    library::store_file(root, &id, &file_name, &data)?;
    let thumb = write_thumb(&sample, &root.join("thumbs"), &id).inspect_err(|_| library::remove_item_dir(root, &id))?;
    Ok(Outcome::New(NewItem {
        id,
        kind: db::Kind::Font,
        name,
        file_name,
        ext,
        width: 0,
        height: 0,
        size: data.len() as i64,
        hash,
        thumb,
        phash: None,
        preview: None,
        font: Some(meta),
        body: None,
        duration_ms: None,
    }))
}

/// Files (PDF, office documents): stored as is, with a thumbnail from the OS
/// or the file itself (files/mod.rs). Like fonts, 0 × 0 and no look-alikes.
fn process_file(name: String, ext: String, data: Vec<u8>, hash: String, root: &Path) -> Result<Outcome, String> {
    if ext == "pdf" && !files::looks_like_pdf(&data) {
        return Err("PDF ではありません".into());
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let file_name = sanitize(&name);
    let path = library::store_file(root, &id, &file_name, &data)?;
    // Made from the stored copy: the OS needs a file with the right extension.
    let thumb = files::thumbnail(&path, &ext, THUMB_MAX);
    let thumb = write_thumb(&thumb, &root.join("thumbs"), &id).inspect_err(|_| library::remove_item_dir(root, &id))?;
    Ok(Outcome::New(NewItem {
        id,
        kind: db::Kind::File,
        name,
        file_name,
        ext,
        width: 0,
        height: 0,
        size: data.len() as i64,
        hash,
        thumb,
        phash: None,
        preview: None,
        font: None,
        body: None,
        duration_ms: None,
    }))
}

/// Videos: stored as is, with a frame from the OS as the thumbnail and the
/// length and size from the file's headers (videos/mod.rs).
fn process_video(
    src: Source,
    ext: String,
    root: &Path,
    dedupe: impl Fn(&str) -> Option<Outcome>,
) -> Result<Outcome, String> {
    let (name, stored, hash, size) = match src {
        Source::Path { path, .. } => {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let mut f = fs::File::open(&path).map_err(|e| e.to_string())?;
            let mut hasher = Sha256::new();
            let mut buf = vec![0u8; 1 << 20];
            let mut size = 0u64;
            loop {
                let n = f.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
                size += n as u64;
            }
            let hash = hex::encode(hasher.finalize());
            if let Some(done) = dedupe(&hash) {
                return Ok(done);
            }
            (name, Err(path), hash, size as i64)
        }
        Source::Bytes { name, data } => {
            let hash = hex::encode(Sha256::digest(&data));
            if let Some(done) = dedupe(&hash) {
                return Ok(done);
            }
            let size = data.len() as i64;
            (name, Ok(data), hash, size)
        }
    };
    let id = uuid::Uuid::new_v4().simple().to_string();
    let file_name = sanitize(&name);
    let path = match &stored {
        Ok(data) => library::store_file(root, &id, &file_name, data)?,
        Err(from) => library::copy_file(root, &id, &file_name, from)?,
    };
    // Made from the stored copy: the OS needs a file with the right extension.
    let info = videos::probe(&path, &ext);
    let thumb = files::thumbnail(&path, &ext, THUMB_MAX);
    let thumb = write_thumb(&thumb, &root.join("thumbs"), &id).inspect_err(|_| library::remove_item_dir(root, &id))?;
    Ok(Outcome::New(NewItem {
        id,
        kind: db::Kind::Video,
        name,
        file_name,
        ext,
        width: info.width,
        height: info.height,
        size,
        hash,
        thumb,
        phash: None,
        preview: None,
        font: None,
        body: None,
        duration_ms: info.duration_ms,
    }))
}

/// One import at a time: two running at once could each miss the other's
/// files when checking for duplicates (the browser extension imports while
/// the user may be dropping files).
static RUN_LOCK: Mutex<()> = Mutex::new(());

/// Runs the import. `lib` is locked only briefly at the start and end so the
/// UI stays responsive while files are processed.
pub fn run(
    lib: &Mutex<Option<Library>>,
    sources: Vec<Source>,
    folder_id: Option<String>,
    on_progress: impl Fn(usize, usize) + Sync,
) -> Result<ImportSummary, String> {
    let _running = RUN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (root, known) = {
        let guard = lib.lock().unwrap();
        let l = guard.as_ref().ok_or("ライブラリが開かれていません")?;
        (l.root.clone(), db::hash_index(&l.conn).map_err(|e| e.to_string())?)
    };

    let total = sources.len();
    let done = AtomicUsize::new(0);
    let seen = Mutex::new(HashSet::new());
    on_progress(0, total);
    let outcomes: Vec<(Outcome, Vec<String>)> = sources
        .into_par_iter()
        .map(|src| {
            let (label, dirs) = (src.label(), src.dirs().to_vec());
            let o = process(src, &root, &known, &seen).unwrap_or_else(|e| Outcome::Failed(format!("{label}: {e}")));
            on_progress(done.fetch_add(1, Ordering::Relaxed) + 1, total);
            (o, dirs)
        })
        .collect();

    let mut guard = lib.lock().unwrap();
    let l = guard.as_mut().ok_or("ライブラリが開かれていません")?;
    if l.root != root {
        return Err("インポート中にライブラリが切り替わりました".into());
    }
    commit(&mut l.conn, outcomes, folder_id.as_deref()).map_err(|e| e.to_string())
}

/// Computes perceptual hashes for items imported before they existed, from
/// their thumbnails. Like `run`, the library is locked only at the ends.
/// Returns how many were computed.
pub fn compute_missing_phashes(lib: &Mutex<Option<Library>>) -> Result<usize, String> {
    let (root, missing) = {
        let guard = lib.lock().unwrap();
        let l = guard.as_ref().ok_or("ライブラリが開かれていません")?;
        (l.root.clone(), db::missing_phashes(&l.conn).map_err(|e| e.to_string())?)
    };
    if missing.is_empty() {
        return Ok(0);
    }
    let hashes: Vec<(String, (u64, u32))> = missing
        .par_iter()
        .filter_map(|(id, thumb)| {
            let img = image::open(root.join("thumbs").join(thumb)).ok()?;
            Some((id.clone(), (similar::dhash(&img), similar::mean_color(&img))))
        })
        .collect();
    let mut guard = lib.lock().unwrap();
    let l = guard.as_mut().ok_or("ライブラリが開かれていません")?;
    if l.root != root {
        return Err("解析中にライブラリが切り替わりました".into());
    }
    db::set_phashes(&mut l.conn, &hashes).map_err(|e| e.to_string())?;
    Ok(hashes.len())
}

/// Reads the family, script and style of fonts imported by versions that
/// didn't store them all. Like `compute_missing_phashes`, the library is
/// locked only at the ends. Returns how many were read.
pub fn compute_missing_font_meta(lib: &Mutex<Option<Library>>) -> Result<usize, String> {
    let (root, missing) = {
        let guard = lib.lock().unwrap();
        let l = guard.as_ref().ok_or("ライブラリが開かれていません")?;
        (l.root.clone(), db::missing_font_meta(&l.conn).map_err(|e| e.to_string())?)
    };
    if missing.is_empty() {
        return Ok(0);
    }
    let metas: Vec<(String, fonts::FontMeta)> = missing
        .par_iter()
        .map(|(id, file_name, ext)| {
            let path = library::stored_file(&root, id, file_name);
            // A file that can't be read is filed as "other", so it isn't retried every time.
            let meta = fs::read(&path)
                .map_err(|e| e.to_string())
                .and_then(|d| fonts::to_sfnt(&d, ext))
                .and_then(|s| fonts::meta(&s))
                .unwrap_or(fonts::FontMeta {
                    family: String::new(),
                    weight: 400,
                    weight_min: 400,
                    weight_max: 400,
                    script: "other",
                    category: None,
                    features: Vec::new(),
                    ps_name: String::new(),
                });
            (id.clone(), meta)
        })
        .collect();
    let mut guard = lib.lock().unwrap();
    let l = guard.as_mut().ok_or("ライブラリが開かれていません")?;
    if l.root != root {
        return Err("読み込み中にライブラリが切り替わりました".into());
    }
    db::set_font_meta(&mut l.conn, &metas).map_err(|e| e.to_string())?;
    Ok(metas.len())
}

fn commit(
    conn: &mut Connection,
    outcomes: Vec<(Outcome, Vec<String>)>,
    folder_id: Option<&str>,
) -> rusqlite::Result<ImportSummary> {
    let mut summary = ImportSummary::default();
    // Target folder (None = unfiled) -> item ids, in import order.
    // The flag marks already-known items, which only fill an empty spot.
    let mut placed: Vec<(Option<String>, bool, Vec<String>)> = Vec::new();
    let mut folder_cache: HashMap<(db::Mode, Vec<String>), String> = HashMap::new();
    let tx = conn.transaction()?;
    // A folder holds its mode's items only (docs/MODES.md): the others go to
    // the top of their own mode.
    let target_mode = match folder_id {
        Some(f) => db::folder_mode(&tx, f)?,
        None => None,
    };
    let base = db::now_ms();
    for (i, (o, dirs)) in outcomes.into_iter().enumerate() {
        let known = matches!(o, Outcome::Duplicate(_));
        let (id, mode) = match o {
            Outcome::New(item) => {
                // Offset by index so the import order is preserved when sorting.
                db::insert_item(&tx, &item, base + i as i64)?;
                summary.imported += 1;
                *summary.kinds.entry(item.kind).or_default() += 1;
                (item.id, db::Mode::of(item.kind))
            }
            Outcome::Duplicate(id) => {
                summary.duplicates += 1;
                if id.is_empty() {
                    continue;
                }
                // Re-importing something from the trash brings it back.
                db::restore_items(&tx, std::slice::from_ref(&id))?;
                let mode = db::item_mode(&tx, &id)?.unwrap_or_default();
                (id, mode)
            }
            Outcome::Failed(msg) => {
                summary.failed.push(msg);
                continue;
            }
        };
        // Recreate the source directory structure under the target folder.
        let mut folder = folder_id.filter(|_| target_mode == Some(mode)).map(str::to_owned);
        for depth in 1..=dirs.len() {
            let key = (mode, dirs[..depth].to_vec());
            let next = match folder_cache.get(&key) {
                Some(f) => f.clone(),
                None => {
                    let f = db::find_or_create_folder(&tx, folder.as_deref(), &dirs[depth - 1], mode)?;
                    folder_cache.insert(key, f.clone());
                    f
                }
            };
            folder = Some(next);
        }
        summary.ids.push(id.clone());
        match placed.iter_mut().find(|(f, k, _)| *f == folder && *k == known) {
            Some((_, _, ids)) => ids.push(id),
            None => placed.push((folder, known, vec![id])),
        }
    }
    for (folder, known, ids) in &placed {
        if let Some(f) = folder {
            // Re-importing something already filed elsewhere doesn't move it.
            if *known {
                db::file_unfiled(&tx, ids, f)?;
            } else {
                db::move_to_folder(&tx, ids, f)?;
            }
        }
    }
    tx.commit()?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use image::{Rgb, RgbImage, Rgba, RgbaImage};

    fn setup() -> (tempfile::TempDir, Mutex<Option<Library>>) {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::create(&dir.path().join("Test.library")).unwrap();
        (dir, Mutex::new(Some(lib)))
    }

    fn png_bytes(img: DynamicImage) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png).unwrap();
        buf.into_inner()
    }

    #[test]
    fn imports_dedupes_and_thumbnails() {
        let (tmp, lib) = setup();
        let src_dir = tmp.path().join("src");
        fs::create_dir_all(src_dir.join("sub")).unwrap();
        fs::create_dir_all(src_dir.join(".hidden")).unwrap();
        RgbImage::from_pixel(1200, 600, Rgb([200, 10, 10])).save(src_dir.join("red.jpg")).unwrap();
        RgbaImage::from_pixel(64, 64, Rgba([0, 0, 255, 100])).save(src_dir.join("sub/clear.png")).unwrap();
        fs::copy(src_dir.join("red.jpg"), src_dir.join("red-copy.jpg")).unwrap(); // same dir, so placement is deterministic
        fs::write(src_dir.join("notes.rtf"), "x").unwrap();
        fs::write(src_dir.join("broken.png"), "not an image").unwrap();
        fs::copy(src_dir.join("red.jpg"), src_dir.join(".hidden/x.jpg")).unwrap();

        let files = collect_files(std::slice::from_ref(&src_dir));
        assert_eq!(files.len(), 4); // rtf and hidden dir skipped
        let mut dirs: Vec<Vec<String>> = files.iter().map(|f| f.dirs().to_vec()).collect();
        dirs.sort();
        assert_eq!(dirs[0], ["src"]);
        assert_eq!(dirs[3], ["src", "sub"]);

        let target = {
            let g = lib.lock().unwrap();
            db::create_folder(&g.as_ref().unwrap().conn, "F", None, db::Mode::Stock).unwrap()
        };
        let calls = AtomicUsize::new(0);
        let sum = run(&lib, files, Some(target.clone()), |_, _| {
            calls.fetch_add(1, Ordering::Relaxed);
        })
        .unwrap();
        assert_eq!(sum.imported, 2);
        assert_eq!(sum.duplicates, 1);
        assert_eq!(sum.failed.len(), 1);
        assert_eq!(calls.load(Ordering::Relaxed), 5);

        let g = lib.lock().unwrap();
        let l = g.as_ref().unwrap();
        // The dropped directory is recreated as F/src/sub.
        let folders = db::list_folders(&l.conn, None).unwrap();
        let src = folders.iter().find(|f| f.name == "src").unwrap();
        let sub = folders.iter().find(|f| f.name == "sub").unwrap();
        assert_eq!(src.parent_id.as_deref(), Some(target.as_str()));
        assert_eq!(sub.parent_id.as_deref(), Some(src.id.as_str()));
        assert_eq!((src.count, sub.count), (1, 1));

        let items = db::query_items(
            &l.conn,
            &db::ItemQuery {
                view: db::View::Folder { id: target },
                include_subfolders: true,
                sort: db::SortKey::Name,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(items.len(), 2);
        let clear = &items[0];
        assert_eq!((clear.name.as_str(), clear.width), ("clear.png", 64));
        assert!(clear.thumb.ends_with(".png"), "transparent -> png thumb");
        let red = &items[1];
        assert_eq!((red.width, red.height), (1200, 600));
        assert!(red.thumb.ends_with(".jpg"));
        assert!(l.file_path(red).is_file());
        let t = image::open(l.root.join("thumbs").join(&red.thumb)).unwrap();
        assert_eq!((t.width(), t.height()), (512, 256));
    }

    #[test]
    fn reimporting_a_folder_reuses_its_folders() {
        let (tmp, lib) = setup();
        let dir = tmp.path().join("Trip");
        fs::create_dir_all(&dir).unwrap();
        RgbImage::from_pixel(4, 4, Rgb([1, 2, 3])).save(dir.join("a.png")).unwrap();
        run(&lib, collect_files(std::slice::from_ref(&dir)), None, |_, _| {}).unwrap();
        RgbImage::from_pixel(4, 4, Rgb([9, 9, 9])).save(dir.join("b.png")).unwrap();
        let sum = run(&lib, collect_files(std::slice::from_ref(&dir)), None, |_, _| {}).unwrap();
        assert_eq!((sum.imported, sum.duplicates), (1, 1));
        let g = lib.lock().unwrap();
        let folders = db::list_folders(&g.as_ref().unwrap().conn, None).unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].count, 2);
    }

    #[test]
    fn reimport_restores_from_trash_and_bytes_source() {
        let (_tmp, lib) = setup();
        let data = png_bytes(DynamicImage::ImageRgb8(RgbImage::new(8, 8)));
        let src = || vec![Source::Bytes { name: "paste.png".into(), data: data.clone() }];
        assert_eq!(run(&lib, src(), None, |_, _| {}).unwrap().imported, 1);

        let id = {
            let g = lib.lock().unwrap();
            let conn = &g.as_ref().unwrap().conn;
            let id = db::hash_index(conn).unwrap().into_values().next().unwrap();
            db::trash_items(conn, std::slice::from_ref(&id)).unwrap();
            id
        };
        let sum = run(&lib, src(), None, |_, _| {}).unwrap();
        assert_eq!((sum.imported, sum.duplicates), (0, 1));
        assert_eq!(sum.ids, std::slice::from_ref(&id), "a known image reports the existing item");
        let g = lib.lock().unwrap();
        let conn = &g.as_ref().unwrap().conn;
        assert!(db::trashed_ids(conn).unwrap().is_empty());
        assert_eq!(db::get_items(conn, &[id]).unwrap().len(), 1);
    }

    /// Smooth pattern with `fx` / `fy` waves across the image.
    fn textured(w: u32, h: u32, fx: f32, fy: f32) -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |x, y| {
            let v = ((x as f32 / w as f32 * fx).sin() * (y as f32 / h as f32 * fy).cos() * 120.0 + 128.0) as u8;
            Rgb([v, 255 - v, v / 2])
        }))
    }

    fn jpeg_bytes(img: &DynamicImage) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        img.to_rgb8().write_to(&mut buf, ImageFormat::Jpeg).unwrap();
        buf.into_inner()
    }

    #[test]
    fn finds_resized_copies_and_backfills_hashes() {
        let (_tmp, lib) = setup();
        let big = textured(1600, 1200, 9.0, 6.0);
        let small = big.resize(400, 300, image::imageops::FilterType::Lanczos3);
        let sources = vec![
            Source::Bytes { name: "small.jpg".into(), data: jpeg_bytes(&small) },
            Source::Bytes { name: "other.png".into(), data: png_bytes(textured(1600, 1200, 3.0, 13.0)) },
            Source::Bytes { name: "big.png".into(), data: png_bytes(big) },
        ];
        assert_eq!(run(&lib, sources, None, |_, _| {}).unwrap().imported, 3);

        let similar = |lib: &Mutex<Option<Library>>| {
            let g = lib.lock().unwrap();
            let q = db::ItemQuery { view: db::View::Similar, ..Default::default() };
            db::query_items(&g.as_ref().unwrap().conn, &q)
                .unwrap()
                .into_iter()
                .map(|i| (i.name, i.group))
                .collect::<Vec<_>>()
        };
        // The larger copy comes first.
        let expected = vec![("big.png".to_string(), Some(0)), ("small.jpg".to_string(), Some(0))];
        assert_eq!(similar(&lib), expected);

        // Items from before the hash existed get it from their thumbnails.
        lib.lock().unwrap().as_ref().unwrap().conn.execute("UPDATE items SET phash = NULL", []).unwrap();
        assert!(similar(&lib).is_empty());
        assert_eq!(compute_missing_phashes(&lib).unwrap(), 3);
        assert_eq!(compute_missing_phashes(&lib).unwrap(), 0);
        assert_eq!(similar(&lib), expected);
    }

    #[test]
    fn imports_new_formats_with_display_copies() {
        let (tmp, lib) = setup();
        let dir = tmp.path().join("fmt");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("logo.svg"),
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><circle cx="75" cy="75" r="60" fill="#09f"/></svg>"##,
        )
        .unwrap();
        image::RgbImage::from_fn(80, 60, |x, y| image::Rgb([x as u8 * 3, y as u8 * 4, 90]))
            .save(dir.join("scan.tiff"))
            .unwrap();
        #[cfg(target_os = "macos")]
        let heic = std::process::Command::new("/usr/bin/sips")
            .args(["-s", "format", "heic"])
            .arg(dir.join("scan.tiff"))
            .arg("--out")
            .arg(dir.join("photo.heic"))
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        #[cfg(not(target_os = "macos"))]
        let heic = false;

        let sum = run(&lib, collect_files(std::slice::from_ref(&dir)), None, |_, _| {}).unwrap();
        assert!(sum.failed.is_empty(), "{:?}", sum.failed);
        assert_eq!(sum.imported, if heic { 3 } else { 2 });

        let g = lib.lock().unwrap();
        let l = g.as_ref().unwrap();
        let items = db::query_items(&l.conn, &db::ItemQuery { sort: db::SortKey::Name, ..Default::default() }).unwrap();
        let by = |n: &str| items.iter().find(|i| i.name == n).unwrap();

        let svg = by("logo.svg");
        assert_eq!((svg.width, svg.height), (300, 150), "SVG keeps its document size");
        assert!(svg.preview.is_none(), "web views render SVG directly");
        assert!(l.thumb_path(svg).is_file());

        let tif = by("scan.tiff");
        assert_eq!((tif.width, tif.height), (80, 60));
        let p = l.display_path(tif);
        assert!(p.starts_with(l.root.join("previews")) && p.is_file(), "TIFF gets a JPEG display copy");
        assert_eq!(image::open(&p).unwrap().width(), 80);

        if heic {
            let h = by("photo.heic");
            assert_eq!((h.width, h.height), (80, 60));
            assert!(l.display_path(h).is_file());
        }

        // Deleting removes the display copy too.
        let preview = l.display_path(tif);
        l.delete_items(std::slice::from_ref(&tif.id)).unwrap();
        assert!(!preview.exists());
    }

    #[test]
    fn orient_rewrites_thumbnail_and_size_only() {
        let (_tmp, lib) = setup();
        let data = png_bytes(DynamicImage::ImageRgb8(RgbImage::from_pixel(1200, 600, Rgb([10, 200, 10]))));
        run(&lib, vec![Source::Bytes { name: "wide.png".into(), data: data.clone() }], None, |_, _| {}).unwrap();
        let mut g = lib.lock().unwrap();
        let l = g.as_mut().unwrap();
        let get = |l: &Library| db::query_items(&l.conn, &db::ItemQuery::default()).unwrap().remove(0);
        let it = get(l);
        let ids = vec![it.id.clone()];
        let base = it.thumb.clone();

        assert_eq!(orient(l, &ids, OrientOp::RotateCw).unwrap(), 1);
        let r = get(l);
        assert_eq!((r.width, r.height, r.rotation, r.flipped), (600, 1200, 1, false));
        assert_ne!(r.thumb, base);
        let t = image::open(l.thumb_path(&r)).unwrap();
        assert_eq!((t.width(), t.height()), (256, 512));
        assert_eq!(fs::read(l.file_path(&r)).unwrap(), data, "the original file is untouched");

        // Flipping a sideways image keeps it sideways; the old rotated thumbnail goes away.
        orient(l, &ids, OrientOp::FlipH).unwrap();
        let f = get(l);
        assert_eq!((f.width, f.height, f.rotation, f.flipped), (600, 1200, 3, true));
        assert!(!l.thumb_path(&r).exists());

        // Reset returns to the unrotated thumbnail, which was kept.
        orient(l, &ids, OrientOp::Reset).unwrap();
        let z = get(l);
        assert_eq!((z.width, z.height, z.thumb.as_str()), (1200, 600, base.as_str()));
        assert!(!l.thumb_path(&f).exists());
        assert_eq!(orient(l, &ids, OrientOp::Reset).unwrap(), 0, "no-op");

        // Deleting removes both thumbnails.
        orient(l, &ids, OrientOp::RotateCcw).unwrap();
        let c = get(l);
        l.delete_items(&ids).unwrap();
        assert!(!l.thumb_path(&c).exists() && !l.thumb_path(&z).exists());
    }

    #[test]
    fn a_pdf_must_be_one() {
        let (_tmp, lib) = setup();
        let sources = vec![
            Source::Bytes { name: "real.pdf".into(), data: crate::files::tests::sample_pdf() },
            Source::Bytes { name: "page.pdf".into(), data: b"<html><script>fetch('x')</script></html>".to_vec() },
        ];
        let sum = run(&lib, sources, None, |_, _| {}).unwrap();
        assert_eq!(sum.imported, 1);
        assert_eq!(sum.failed.len(), 1, "{:?}", sum.failed);
    }

    #[test]
    fn drops_into_a_folder_only_what_is_of_its_mode() {
        let Some(ttf) = fonts::tests::system_font(fonts::tests::SINGLE) else { return };
        let (_tmp, lib) = setup();
        let folder = {
            let g = lib.lock().unwrap();
            db::create_folder(&g.as_ref().unwrap().conn, "画像", None, db::Mode::Stock).unwrap()
        };
        let sources = vec![
            Source::Bytes { name: "Sample.ttf".into(), data: ttf },
            Source::Bytes { name: "square.png".into(), data: png_bytes(DynamicImage::ImageRgb8(RgbImage::new(8, 8))) },
        ];
        run(&lib, sources, Some(folder.clone()), |_, _| {}).unwrap();
        let g = lib.lock().unwrap();
        let all = db::query_items(&g.as_ref().unwrap().conn, &db::ItemQuery::default()).unwrap();
        let folder_of = |kind| all.iter().find(|i| i.kind == kind).unwrap().folder_id.clone();
        assert_eq!(folder_of(db::Kind::Image), Some(folder));
        assert_eq!(folder_of(db::Kind::Font), None, "the font stays unfiled, in its own mode");
    }

    #[test]
    fn imports_fonts_without_pixel_size() {
        let Some(ttf) = fonts::tests::system_font(fonts::tests::SINGLE) else { return };
        let (_tmp, lib) = setup();
        let sources = vec![
            Source::Bytes { name: "Sample.ttf".into(), data: ttf.clone() },
            Source::Bytes { name: "Sample.woff".into(), data: fonts::tests::encode_woff(&ttf) },
            Source::Bytes { name: "square.png".into(), data: png_bytes(DynamicImage::ImageRgb8(RgbImage::new(8, 8))) },
        ];
        let sum = run(&lib, sources, None, |_, _| {}).unwrap();
        assert!(sum.failed.is_empty(), "{:?}", sum.failed);
        assert_eq!(sum.imported, 3);
        assert_eq!(sum.kinds, std::collections::BTreeMap::from([(db::Kind::Image, 1), (db::Kind::Font, 2)]));

        let mut g = lib.lock().unwrap();
        let l = g.as_mut().unwrap();
        let all = db::query_items(&l.conn, &db::ItemQuery { sort: db::SortKey::Name, ..Default::default() }).unwrap();
        let ttf_item = all.iter().find(|i| i.name == "Sample.ttf").unwrap();
        assert_eq!((ttf_item.kind, ttf_item.width, ttf_item.height), (db::Kind::Font, 0, 0));
        assert_eq!(fs::read(l.file_path(ttf_item)).unwrap(), ttf, "stored as is");
        let t = image::open(l.thumb_path(ttf_item)).unwrap();
        assert_eq!((t.width(), t.height()), (fonts::THUMB_W, fonts::THUMB_H));

        // 0 × 0 must not count as "square", and fonts are never hashed for look-alikes.
        let square = db::ItemQuery {
            filter: db::Filter { shapes: vec![db::Shape::Square], ..Default::default() },
            ..Default::default()
        };
        let names: Vec<_> = db::query_items(&l.conn, &square).unwrap().into_iter().map(|i| i.name).collect();
        assert_eq!(names, ["square.png"]);
        assert!(db::missing_phashes(&l.conn).unwrap().is_empty());

        // The family is stored, so the TTF and the WOFF of one font group and search together.
        let meta = fonts::meta(&ttf).unwrap();
        let family = meta.family.clone();
        let fonts_of = |conn: &rusqlite::Connection| -> Vec<(Option<String>, Option<u32>, Option<String>)> {
            let q = db::ItemQuery { search: format!("\"{family}\""), sort: db::SortKey::Name, ..Default::default() };
            db::query_items(conn, &q).unwrap().into_iter().map(|i| (i.font_family, i.font_weight, i.font_script)).collect()
        };
        let found = fonts_of(&l.conn);
        assert_eq!(found.len(), 2, "found by family name");
        assert!(found.iter().all(|f| f.0.as_deref() == Some(family.as_str())
            && f.1.is_some_and(|w| w >= 100)
            && f.2.as_deref() == Some(meta.script)));

        // Rotating skips fonts.
        let ids: Vec<String> = all.iter().map(|i| i.id.clone()).collect();
        assert_eq!(orient(l, &ids, OrientOp::RotateCw).unwrap(), 1);

        // Fonts imported before the family was stored get it filled in.
        l.conn.execute("UPDATE items SET font_family = NULL, font_weight = NULL, font_script = NULL", []).unwrap();
        drop(g);
        assert_eq!(compute_missing_font_meta(&lib).unwrap(), 2);
        assert_eq!(compute_missing_font_meta(&lib).unwrap(), 0);
        assert_eq!(fonts_of(&lib.lock().unwrap().as_ref().unwrap().conn), found);
    }

    #[test]
    fn imports_files_with_thumbnails() {
        use crate::files::tests::{jpeg, sample_pdf, sample_zip};
        let (tmp, lib) = setup();
        let dir = tmp.path().join("docs");
        fs::create_dir_all(dir.join("Old.pages")).unwrap();
        fs::write(dir.join("report.pdf"), sample_pdf()).unwrap();
        fs::write(dir.join("Plan.pages"), sample_zip(&[("preview.jpg", &jpeg(300, 400))])).unwrap();
        // Not a real spreadsheet (a damaged .docx would make Quick Look hang until the timeout).
        fs::write(dir.join("memo.xls"), b"nothing here").unwrap();
        // A package document: neither it nor its insides are imported.
        fs::write(dir.join("Old.pages/preview.jpg"), jpeg(30, 40)).unwrap();
        fs::write(dir.join("Old.pages/index.xml"), "x").unwrap();

        let files = collect_files(std::slice::from_ref(&dir));
        assert_eq!(files.len(), 3);
        let sum = run(&lib, files, None, |_, _| {}).unwrap();
        assert!(sum.failed.is_empty(), "{:?}", sum.failed);
        assert_eq!(sum.imported, 3);

        let g = lib.lock().unwrap();
        let l = g.as_ref().unwrap();
        let items = db::query_items(&l.conn, &db::ItemQuery { sort: db::SortKey::Name, ..Default::default() }).unwrap();
        for it in &items {
            assert_eq!((it.kind, it.width, it.height), (db::Kind::File, 0, 0), "{}", it.name);
            assert!(it.preview.is_none());
            assert_eq!(fs::read(l.file_path(it)).unwrap(), fs::read(dir.join(&it.name)).unwrap(), "stored as is");
            let t = image::open(l.thumb_path(it)).unwrap();
            assert!(t.width().max(t.height()) <= THUMB_MAX);
        }
        let by = |n: &str| items.iter().find(|i| i.name == n).unwrap();
        // The preview inside the Pages document (on macOS Quick Look may draw it instead).
        let t = image::open(l.thumb_path(by("Plan.pages"))).unwrap();
        assert!(t.height() > t.width(), "portrait like the preview");
        // Nothing to show for the broken spreadsheet: the type card.
        let t = image::open(l.thumb_path(by("memo.xls"))).unwrap();
        assert_eq!((t.width(), t.height()), (files::CARD_W, files::CARD_H));
        assert!(db::missing_phashes(&l.conn).unwrap().is_empty(), "no look-alikes for files");
        assert_eq!(db::counts(&l.conn, None).unwrap().kinds, std::collections::BTreeMap::from([(db::Kind::File, 3)]));
    }

    #[test]
    fn imports_texts_and_finds_them_by_their_body() {
        let (tmp, lib) = setup();
        let dir = tmp.path().join("notes");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("memo.md"), "# 会議\n- 牛肉の在庫を確認\n").unwrap();
        let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("品名,数量\r\n豚肉,5\r\n");
        fs::write(dir.join("stock.csv"), &sjis).unwrap();
        fs::write(dir.join("fake.txt"), b"\x00\x01binary").unwrap();

        let sum = run(&lib, collect_files(std::slice::from_ref(&dir)), None, |_, _| {}).unwrap();
        assert_eq!((sum.imported, sum.failed.len()), (2, 1), "{:?}", sum.failed);
        assert_eq!(sum.kinds, std::collections::BTreeMap::from([(db::Kind::Text, 2)]));

        let g = lib.lock().unwrap();
        let l = g.as_ref().unwrap();
        let find = |search: &str| {
            let q = db::ItemQuery { search: search.into(), sort: db::SortKey::Name, ..Default::default() };
            db::query_items(&l.conn, &q).unwrap().into_iter().map(|i| i.name).collect::<Vec<_>>()
        };
        assert_eq!(find("在庫"), ["memo.md"], "found by its body");
        assert_eq!(find("豚肉"), ["stock.csv"], "Shift_JIS read for the search");
        let csv = db::query_items(&l.conn, &db::ItemQuery { search: "stock".into(), ..Default::default() }).unwrap();
        let it = &csv[0];
        assert_eq!((it.kind, it.width, it.height), (db::Kind::Text, 0, 0));
        assert_eq!(fs::read(l.file_path(it)).unwrap(), sjis.to_vec(), "stored as is");
        assert!(l.thumb_path(it).is_file());
    }

    #[test]
    fn imports_videos_from_the_disk_with_their_length_and_size() {
        let (tmp, lib) = setup();
        let data = videos::tests::mp4(false);
        let path = tmp.path().join("clip.mp4");
        fs::write(&path, &data).unwrap();
        let copy = tmp.path().join("copy.mp4");
        fs::write(&copy, &data).unwrap();

        let sum = run(&lib, vec![Source::file(&path), Source::file(&copy)], None, |_, _| {}).unwrap();
        assert_eq!((sum.imported, sum.duplicates), (1, 1), "{:?}", sum.failed);
        assert_eq!(sum.kinds, std::collections::BTreeMap::from([(db::Kind::Video, 1)]));

        let g = lib.lock().unwrap();
        let l = g.as_ref().unwrap();
        let it = &db::query_items(&l.conn, &db::ItemQuery::default()).unwrap()[0];
        assert_eq!((it.kind, it.width, it.height, it.duration_ms), (db::Kind::Video, 1920, 1080, Some(15_000)));
        assert_eq!(fs::read(l.file_path(it)).unwrap(), data, "stored as is");
        assert!(l.thumb_path(it).is_file(), "a card at least");
    }

    #[test]
    fn sanitize_names() {
        assert_eq!(sanitize("a/b:c?.png"), "a_b_c_.png");
        assert_eq!(sanitize(" ..."), "image");
    }
}

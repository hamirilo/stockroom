//! Files: PDF and office documents. They are stored as is and opened in the
//! OS's default app; the library only keeps a thumbnail, from the first
//! source that gives one:
//!
//! 1. the OS: Quick Look on macOS (PDF, Office, iWork), Windows.Data.Pdf for
//!    PDF on Windows
//! 2. the preview saved inside the file (iWork, and Office files saved with one)
//! 3. a card with the file type
//!
//! On Windows, Office (when installed) later makes a PDF of each office
//! document, and its first page replaces the thumbnail (thumbs.rs).
//! The viewer shows documents other than PDF from a preview kept in
//! `previews/` (preview.rs).
//!
//! Files have no pixel size (0 × 0) and take no part in the look-alike search.

use image::{DynamicImage, RgbaImage};
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, OnceLock};

pub mod commands;
pub mod preview;
#[cfg(windows)]
mod thumbs;
#[cfg(windows)]
mod win_office;
#[cfg(windows)]
mod win_pdf;

/// File types imported as files.
pub const EXTS: &[&str] = &["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key"];

pub fn is_file(ext: &str) -> bool {
    EXTS.contains(&ext)
}

/// Whether `data` (the start of a file is enough) is a PDF: `%PDF-` within
/// the first 1024 bytes, as PDF readers accept. A PDF is shown in the web
/// view as a document, and the asset protocol picks its type from the
/// content: HTML named `.pdf` would run as a page that can read the library.
pub fn looks_like_pdf(data: &[u8]) -> bool {
    data[..data.len().min(1024)].windows(5).any(|w| w == b"%PDF-")
}

/// `looks_like_pdf` for a stored file.
pub fn is_pdf(path: &Path) -> bool {
    let mut head = Vec::with_capacity(1024);
    std::fs::File::open(path).and_then(|f| f.take(1024).read_to_end(&mut head)).is_ok() && looks_like_pdf(&head)
}

/// iWork documents saved as packages (folders) rather than single files.
/// They can't be imported, and their insides shouldn't be either.
pub fn is_package(path: &Path) -> bool {
    path.is_dir()
        && path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "pages" | "numbers" | "key"))
}

/// The thumbnail of the file at `path` (named with its extension), fitted
/// inside `max` px. Never fails: the type card is the last resort.
pub fn thumbnail(path: &Path, ext: &str, max: u32) -> DynamicImage {
    let fit = |img: DynamicImage| if img.width().max(img.height()) > max { img.thumbnail(max, max) } else { img };
    from_os(path, ext, max)
        .filter(|img| !is_blank(img))
        .or_else(|| embedded_preview(path))
        .map(fit)
        .unwrap_or_else(|| type_card(ext))
}

/// One flat colour: what Quick Look gives for a file it can't read.
fn is_blank(img: &DynamicImage) -> bool {
    let small = img.thumbnail(32, 32).to_luma8();
    let (lo, hi) = small.pixels().fold((255u8, 0u8), |(lo, hi), p| (lo.min(p[0]), hi.max(p[0])));
    hi.saturating_sub(lo) < 4
}

/// Runs Quick Look (`qlmanage <args> <out> <path>`), which writes what it
/// made into `out`. False when it failed or hung.
#[cfg(target_os = "macos")]
fn run_quicklook(args: &[&str], out: &Path, path: &Path) -> bool {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let Ok(mut child) = Command::new("/usr/bin/qlmanage")
        .args(args)
        .arg(out)
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    // A broken document can make it hang (seen with a damaged .docx);
    // a real one takes well under a second.
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if start.elapsed() < Duration::from_secs(20) => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Err(_) => return false,
        }
    }
}

#[cfg(target_os = "macos")]
fn from_os(path: &Path, _ext: &str, max: u32) -> Option<DynamicImage> {
    // qlmanage writes <file name>.png into the output folder; nothing when it can't.
    let out = tempfile::tempdir().ok()?;
    if !run_quicklook(&["-t", "-s", &max.to_string(), "-o"], out.path(), path) {
        return None;
    }
    let png = out.path().join(format!("{}.png", path.file_name()?.to_string_lossy()));
    image::open(png).ok()
}

#[cfg(windows)]
fn from_os(path: &Path, ext: &str, max: u32) -> Option<DynamicImage> {
    if ext != "pdf" {
        return None;
    }
    let png = win_pdf::render_pdf_page(path, max).ok()?;
    image::load_from_memory(&png).ok()
}

#[cfg(not(any(target_os = "macos", windows)))]
fn from_os(_path: &Path, _ext: &str, _max: u32) -> Option<DynamicImage> {
    None
}

/// Previews saved inside zip-based documents: iWork keeps one in every
/// document, Office only when saved with "save thumbnail" (PowerPoint does
/// by default). WMF / EMF previews of older Office versions aren't read.
fn embedded_preview(path: &Path) -> Option<DynamicImage> {
    const ENTRIES: &[&str] = &[
        "preview.jpg",
        "QuickLook/Thumbnail.jpg",
        "QuickLook/Preview.jpg",
        "docProps/thumbnail.jpeg",
        "docProps/thumbnail.jpg",
        "docProps/thumbnail.png",
    ];
    let mut zip = zip::ZipArchive::new(std::fs::File::open(path).ok()?).ok()?;
    for name in ENTRIES {
        let Ok(mut entry) = zip.by_name(name) else { continue };
        // A preview is small; don't inflate anything unreasonable. The size
        // in the zip is only what the entry claims, so the read is capped
        // too (a compression bomb inflates far beyond it).
        const MAX: u64 = 32 << 20;
        if entry.size() > MAX {
            continue;
        }
        let mut data = Vec::with_capacity(entry.size() as usize);
        if entry.by_ref().take(MAX + 1).read_to_end(&mut data).is_ok() && data.len() as u64 <= MAX {
            if let Ok(img) = image::load_from_memory(&data) {
                return Some(img);
            }
        }
    }
    None
}

/// Short name of a file type, as in the app's labels.
pub fn type_name(ext: &str) -> &'static str {
    match ext {
        "pdf" => "PDF",
        "doc" | "docx" => "Word",
        "xls" | "xlsx" => "Excel",
        "ppt" | "pptx" => "PowerPoint",
        "pages" => "Pages",
        "numbers" => "Numbers",
        "key" => "Keynote",
        _ => "ファイル",
    }
}

/// Colour of the type card, after each app's own.
fn type_color(ext: &str) -> &'static str {
    match ext {
        "pdf" => "#d93838",
        "doc" | "docx" => "#2b5fb4",
        "xls" | "xlsx" => "#1e7a46",
        "ppt" | "pptx" => "#c4501f",
        "pages" => "#e8861a",
        "numbers" => "#2f9e4a",
        "key" => "#2f73e0",
        "mp4" | "m4v" | "mov" | "webm" => "#7c3aed",
        _ => "#6b7280",
    }
}

pub const CARD_W: u32 = 384;
pub const CARD_H: u32 = 512;

/// A few common sans-serif faces for the card's label, rather than scanning
/// every installed font.
fn label_fonts() -> Arc<resvg::usvg::fontdb::Database> {
    static DB: OnceLock<Arc<resvg::usvg::fontdb::Database>> = OnceLock::new();
    DB.get_or_init(|| {
        let mut db = resvg::usvg::fontdb::Database::new();
        for p in [
            "/System/Library/Fonts/Helvetica.ttc",
            "/System/Library/Fonts/SFNS.ttf",
            "C:\\Windows\\Fonts\\segoeuib.ttf",
            "C:\\Windows\\Fonts\\arialbd.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        ] {
            let _ = db.load_font_file(p);
        }
        if db.is_empty() {
            db.load_system_fonts();
        }
        Arc::new(db)
    })
    .clone()
}

/// A page with a folded corner and the file type on a coloured band.
/// Without any font the label is simply left out.
pub fn type_card(ext: &str) -> DynamicImage {
    let label = ext.to_ascii_uppercase();
    let size = if label.len() > 4 { 56 } else { 72 };
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{CARD_W}" height="{CARD_H}">
<rect width="100%" height="100%" fill="#f4f4f5"/>
<path d="M72 48 H252 L312 108 V464 H72 Z" fill="#ffffff" stroke="#d4d4d8" stroke-width="3"/>
<path d="M252 48 V108 H312" fill="#e4e4e7" stroke="#d4d4d8" stroke-width="3" stroke-linejoin="round"/>
<rect x="72" y="300" width="240" height="104" fill="{color}"/>
<text x="192" y="352" dy="0.35em" font-size="{size}" font-weight="bold" fill="#ffffff" text-anchor="middle">{label}</text>
</svg>"##,
        color = type_color(ext),
    );
    let fonts = label_fonts();
    let mut opt = resvg::usvg::Options::default();
    if let Some(face) = fonts.faces().next() {
        if let Some((family, _)) = face.families.first() {
            opt.font_family = family.clone();
        }
    }
    opt.fontdb = fonts;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(CARD_W, CARD_H).expect("non-zero size");
    if let Ok(tree) = resvg::usvg::Tree::from_str(&svg, &opt) {
        resvg::render(&tree, resvg::tiny_skia::Transform::default(), &mut pixmap.as_mut());
    }
    let rgba = RgbaImage::from_raw(CARD_W, CARD_H, pixmap.take_demultiplied()).expect("pixmap size");
    DynamicImage::ImageRgba8(rgba)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::io::Write;

    /// A one-page PDF with a filled rectangle (offsets computed, so viewers
    /// don't need to repair it).
    pub fn sample_pdf() -> Vec<u8> {
        let content = "1 0 0 rg 72 72 300 500 re f";
        let objs = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>".to_string(),
            format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
        ];
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, o) in objs.iter().enumerate() {
            offsets.push(out.len());
            out.extend(format!("{} 0 obj\n{o}\nendobj\n", i + 1).bytes());
        }
        let xref = out.len();
        out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1).bytes());
        for o in offsets {
            out.extend(format!("{o:010} 00000 n \n").bytes());
        }
        out.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objs.len() + 1).bytes());
        out
    }

    /// A zip with `entries`, like an iWork / OOXML document.
    pub fn sample_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, data) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    pub fn jpeg(w: u32, h: u32) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(w, h, image::Rgb([20, 120, 220]))
            .write_to(&mut buf, image::ImageFormat::Jpeg)
            .unwrap();
        buf.into_inner()
    }

    #[test]
    fn card_has_the_type_colour_and_label() {
        let card = type_card("pdf").to_rgba8();
        assert_eq!((card.width(), card.height()), (CARD_W, CARD_H));
        assert_eq!(card.get_pixel(80, 310).0, [0xd9, 0x38, 0x38, 255], "coloured band");
        // Some white label pixels inside the band, when a font was found.
        if !label_fonts().is_empty() {
            let white = (72..312).flat_map(|x| (300..404).map(move |y| (x, y))).any(|(x, y)| card.get_pixel(x, y).0[1] > 200);
            assert!(white, "label drawn");
        }
    }

    #[test]
    fn blank_images() {
        assert!(is_blank(&DynamicImage::ImageRgb8(image::RgbImage::from_pixel(512, 512, image::Rgb([255; 3])))));
        assert!(!is_blank(&type_card("pdf")));
    }

    #[test]
    fn preview_inside_iwork_and_office_files() {
        let dir = tempfile::tempdir().unwrap();
        let pages = dir.path().join("a.pages");
        std::fs::write(&pages, sample_zip(&[("Index/Document.iwa", b"x"), ("preview.jpg", &jpeg(300, 400))])).unwrap();
        let img = embedded_preview(&pages).unwrap();
        assert_eq!((img.width(), img.height()), (300, 400));

        let docx = dir.path().join("a.docx");
        std::fs::write(&docx, sample_zip(&[("word/document.xml", b"<w/>")])).unwrap();
        assert!(embedded_preview(&docx).is_none(), "no preview saved");
        std::fs::write(&docx, b"not a zip").unwrap();
        assert!(embedded_preview(&docx).is_none());
    }

    #[test]
    fn thumbnail_always_gives_an_image() {
        let dir = tempfile::tempdir().unwrap();
        // Not a real spreadsheet: no OS thumbnail and no preview, so the card.
        let xls = dir.path().join("broken.xls");
        std::fs::write(&xls, b"nothing here").unwrap();
        let t = thumbnail(&xls, "xls", 512);
        assert_eq!((t.width(), t.height()), (CARD_W, CARD_H), "the card, not a blank page");

        // A large embedded preview is fitted.
        let key = dir.path().join("deck.key");
        std::fs::write(&key, sample_zip(&[("preview.jpg", &jpeg(1600, 900))])).unwrap();
        let t = thumbnail(&key, "key", 512);
        assert_eq!(t.width().max(t.height()), 512);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn pdf_first_page_from_quick_look() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("doc.pdf");
        std::fs::write(&pdf, sample_pdf()).unwrap();
        let Some(img) = from_os(&pdf, "pdf", 512) else {
            eprintln!("skipping: Quick Look made no thumbnail");
            return;
        };
        assert_eq!(img.height(), 512, "A4 portrait fits by its height");
        assert!(img.width() < img.height());
        // The red rectangle is on the page.
        let rgb = img.to_rgb8();
        assert!(rgb.pixels().any(|p| p[0] > 200 && p[1] < 80 && p[2] < 80));
    }
}

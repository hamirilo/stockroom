//! The frame a video gets from the OS: Quick Look on macOS. Elsewhere, or
//! when the OS gives nothing, a card with the file type.

use image::{DynamicImage, RgbaImage};
use std::path::Path;
use std::sync::{Arc, OnceLock};

/// The thumbnail of the video at `path` (named with its extension), fitted
/// inside `max` px. Never fails: the type card is the last resort.
pub fn thumbnail(path: &Path, ext: &str, max: u32) -> DynamicImage {
    let fit = |img: DynamicImage| if img.width().max(img.height()) > max { img.thumbnail(max, max) } else { img };
    from_os(path, max).filter(|img| !is_blank(img)).map(fit).unwrap_or_else(|| type_card(ext))
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
    // A broken file can make it hang (seen with a damaged .docx);
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
fn from_os(path: &Path, max: u32) -> Option<DynamicImage> {
    // qlmanage writes <file name>.png into the output folder; nothing when it can't.
    let out = tempfile::tempdir().ok()?;
    if !run_quicklook(&["-t", "-s", &max.to_string(), "-o"], out.path(), path) {
        return None;
    }
    let png = out.path().join(format!("{}.png", path.file_name()?.to_string_lossy()));
    image::open(png).ok()
}

#[cfg(not(target_os = "macos"))]
fn from_os(_path: &Path, _max: u32) -> Option<DynamicImage> {
    None
}

/// Colour of the type card.
fn type_color(ext: &str) -> &'static str {
    match ext {
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
mod tests {
    use super::*;

    #[test]
    fn card_has_the_type_colour_and_label() {
        let card = type_card("mp4").to_rgba8();
        assert_eq!((card.width(), card.height()), (CARD_W, CARD_H));
        assert_eq!(card.get_pixel(80, 310).0, [0x7c, 0x3a, 0xed, 255], "coloured band");
        // Some white label pixels inside the band, when a font was found.
        if !label_fonts().is_empty() {
            let white = (72..312).flat_map(|x| (300..404).map(move |y| (x, y))).any(|(x, y)| card.get_pixel(x, y).0[1] > 200);
            assert!(white, "label drawn");
        }
    }

    #[test]
    fn blank_images() {
        assert!(is_blank(&DynamicImage::ImageRgb8(image::RgbImage::from_pixel(512, 512, image::Rgb([255; 3])))));
        assert!(!is_blank(&type_card("mp4")));
    }

    #[test]
    fn thumbnail_always_gives_an_image() {
        let dir = tempfile::tempdir().unwrap();
        // Not a real video: no OS thumbnail, so the card.
        let mp4 = dir.path().join("broken.mp4");
        std::fs::write(&mp4, b"nothing here").unwrap();
        let t = thumbnail(&mp4, "mp4", 512);
        assert_eq!((t.width(), t.height()), (CARD_W, CARD_H), "the card, not a blank frame");
    }
}

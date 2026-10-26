//! Decoding every supported format into a `DynamicImage`.
//!
//! - JPEG / PNG / GIF / WebP / BMP / TIFF: the `image` crate (pure Rust).
//! - SVG: rasterised with resvg (pure Rust).
//! - HEIC / HEIF / AVIF: the operating system's decoders — ImageIO via `sips`
//!   on macOS, WIC on Windows (needs Microsoft's free "HEIF Image Extensions"
//!   / "AV1 Video Extension"). Unsupported elsewhere.

use image::{DynamicImage, ImageDecoder, ImageReader, RgbaImage};
use std::io::Cursor;

pub const SUPPORTED_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "svg", "heic", "heif", "avif",
    // Fonts (see fonts.rs).
    "ttf", "otf", "woff", "woff2", "ttc", "otc",
    // Files: PDF and office documents (see files/mod.rs `EXTS`).
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key",
    // Texts (see texts/mod.rs `EXTS`).
    "md", "markdown", "txt", "csv", "tsv",
    // Videos (see videos/mod.rs `EXTS`).
    "mp4", "m4v", "mov", "webm",
];

/// Font files are imported with a rendered sample as their thumbnail.
pub fn is_font(ext: &str) -> bool {
    matches!(ext, "ttf" | "otf" | "woff" | "woff2" | "ttc" | "otc")
}

/// Formats the web view can't show reliably on every platform (WebView2 has
/// no HEIC / TIFF support), so a JPEG copy is kept for full-size display.
pub fn needs_preview(ext: &str) -> bool {
    matches!(ext, "heic" | "heif" | "tif" | "tiff")
}

/// The file type from the content (magic bytes), for data whose name may not
/// say it: images saved from the web often have no or a wrong extension.
pub fn sniff(data: &[u8]) -> Option<&'static str> {
    let head = |n: usize| data.get(..n);
    match head(4)? {
        b"wOFF" => return Some("woff"),
        b"wOF2" => return Some("woff2"),
        b"ttcf" => return Some("ttc"),
        b"OTTO" => return Some("otf"),
        &[0, 1, 0, 0] | b"true" => return Some("ttf"),
        _ => {}
    }
    // ISO media (HEIF / AVIF): `ftyp` box with the major and compatible brands.
    if data.get(4..8) == Some(b"ftyp") && data.len() >= 16 {
        let len = (u32::from_be_bytes(data[..4].try_into().ok()?) as usize).clamp(16, data.len().min(256));
        let brands: Vec<&[u8]> = data[8..len].chunks_exact(4).collect();
        if brands.iter().any(|b| matches!(*b, b"avif" | b"avis")) {
            return Some("avif");
        }
        if brands.iter().any(|b| matches!(*b, b"heic" | b"heix" | b"hevc" | b"hevx" | b"heim" | b"heis" | b"mif1" | b"msf1")) {
            return Some("heic");
        }
        return None;
    }
    if let Ok(f) = image::guess_format(data) {
        use image::ImageFormat::*;
        return match f {
            Jpeg => Some("jpg"),
            Png => Some("png"),
            Gif => Some("gif"),
            WebP => Some("webp"),
            Bmp => Some("bmp"),
            Tiff => Some("tiff"),
            _ => None,
        };
    }
    let text = String::from_utf8_lossy(&data[..data.len().min(4096)]);
    let text = text.trim_start_matches('\u{feff}').trim_start();
    (text.starts_with('<') && text.contains("<svg")).then_some("svg")
}

/// `name` with the extension the content really has (see `sniff`): a wrong
/// supported extension is replaced, anything else gets one appended.
pub fn name_for_content(name: &str, data: &[u8]) -> String {
    let Some(real) = sniff(data) else { return name.to_string() };
    let family = |e: &str| match e {
        "jpeg" => "jpg",
        "tif" => "tiff",
        "heif" => "heic",
        "otc" => "ttc",
        e => e,
    }
    .to_string();
    let path = std::path::Path::new(name);
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    match ext {
        Some(e) if family(&e) == family(real) => name.to_string(),
        Some(e) if SUPPORTED_EXTS.contains(&e.as_str()) => format!("{}.{real}", &name[..name.len() - e.len() - 1]),
        _ => format!("{name}.{real}"),
    }
}

/// Longest side of an SVG rasterisation (thumbnails and hashing only).
const SVG_RASTER_MAX: f32 = 1024.0;

pub struct Decoded {
    pub image: DynamicImage,
    /// Intrinsic size (for SVG the document size, not the raster size).
    pub width: u32,
    pub height: u32,
}

pub fn decode(bytes: &[u8], ext: &str) -> Result<Decoded, String> {
    let image = match ext {
        "svg" => return decode_svg(bytes),
        "heic" | "heif" | "avif" => decode_with_os(bytes, ext)?,
        _ => decode_with_image_crate(bytes).map_err(|e| e.to_string())?,
    };
    Ok(Decoded { width: image.width(), height: image.height(), image })
}

fn decode_with_image_crate(bytes: &[u8]) -> image::ImageResult<DynamicImage> {
    let mut decoder = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()?
        .into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut img = DynamicImage::from_decoder(decoder)?;
    img.apply_orientation(orientation);
    Ok(img)
}

fn decode_svg(bytes: &[u8]) -> Result<Decoded, String> {
    rasterize_svg(bytes, SVG_RASTER_MAX)
}

/// SVGs come from anywhere (the browser extension included), so an
/// `<image href>` may only embed a `data:` URL. usvg's default reads any
/// path it is given: a local picture would end up in the thumbnail, and a
/// UNC path (`\\host\share`) would make Windows authenticate to that host.
///
/// Text is drawn with the system's fonts (usvg starts with none, so every
/// `<text>` was left out), loaded once for all SVGs.
pub fn svg_options() -> resvg::usvg::Options<'static> {
    static FONTS: std::sync::OnceLock<std::sync::Arc<resvg::usvg::fontdb::Database>> = std::sync::OnceLock::new();
    let mut opt = resvg::usvg::Options::default();
    opt.image_href_resolver.resolve_string = Box::new(|_, _| None);
    opt.fontdb = FONTS
        .get_or_init(|| {
            let mut db = resvg::usvg::fontdb::Database::new();
            db.load_system_fonts();
            name_present_generic_families(&mut db);
            std::sync::Arc::new(db)
        })
        .clone();
    opt
}

/// Text without a font that is installed falls back to the generic families
/// (`serif` ends every list, and usvg's default font is Times New Roman), but
/// only if they name a font that is here; otherwise usvg drops the text. When
/// one doesn't (a system without Times New Roman / Arial, and no fontconfig
/// saying what to use), it names a font that has Latin letters.
fn name_present_generic_families(db: &mut resvg::usvg::fontdb::Database) {
    use resvg::usvg::fontdb::{Family, Query};
    let present = |db: &resvg::usvg::fontdb::Database, f: Family| db.query(&Query { families: &[f], ..Default::default() }).is_some();
    use skrifa::MetadataProvider;
    let has_latin = |id| {
        db.with_face_data(id, |data, index| {
            skrifa::FontRef::from_index(data, index).is_ok_and(|f| f.charmap().map('a').is_some())
        })
        .unwrap_or(false)
    };
    let Some(any) = db
        .faces()
        .find(|f| has_latin(f.id))
        .and_then(|f| f.families.first())
        .map(|(name, _)| name.clone())
    else {
        return;
    };
    if !present(db, Family::Serif) {
        db.set_serif_family(any.clone());
    }
    if !present(db, Family::SansSerif) {
        db.set_sans_serif_family(any.clone());
    }
    if !present(db, Family::Monospace) {
        db.set_monospace_family(any);
    }
}

/// Renders an SVG with its longer side at `max_side` px.
pub fn rasterize_svg(bytes: &[u8], max_side: f32) -> Result<Decoded, String> {
    let tree = resvg::usvg::Tree::from_data(bytes, &svg_options()).map_err(|e| format!("SVG: {e}"))?;
    let size = tree.size();
    let (w, h) = (size.width().max(1.0), size.height().max(1.0));
    let scale = max_side / w.max(h);
    let (pw, ph) = ((w * scale).round().max(1.0) as u32, (h * scale).round().max(1.0) as u32);
    let mut pixmap = resvg::tiny_skia::Pixmap::new(pw, ph).ok_or("SVG: invalid size")?;
    resvg::render(&tree, resvg::tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    let rgba = RgbaImage::from_raw(pw, ph, pixmap.take_demultiplied()).ok_or("SVG: raster error")?;
    Ok(Decoded {
        image: DynamicImage::ImageRgba8(rgba),
        width: w.round() as u32,
        height: h.round() as u32,
    })
}

#[cfg(target_os = "macos")]
fn decode_with_os(bytes: &[u8], ext: &str) -> Result<DynamicImage, String> {
    // sips (ImageIO) converts to PNG and applies the EXIF orientation.
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let src = dir.path().join(format!("in.{ext}"));
    let out = dir.path().join("out.png");
    std::fs::write(&src, bytes).map_err(|e| e.to_string())?;
    let status = std::process::Command::new("/usr/bin/sips")
        .args(["-s", "format", "png"])
        .arg(&src)
        .arg("--out")
        .arg(&out)
        .output()
        .map_err(|e| format!("sips: {e}"))?;
    if !status.status.success() || !out.exists() {
        return Err(format!("{} を読み込めませんでした", ext.to_uppercase()));
    }
    image::open(&out).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn decode_with_os(bytes: &[u8], ext: &str) -> Result<DynamicImage, String> {
    wic::decode(bytes).map_err(|e| {
        format!(
            "{} を読み込めませんでした（Microsoft Store の拡張機能が必要な場合があります）: {e}",
            ext.to_uppercase()
        )
    })
}

#[cfg(not(any(target_os = "macos", windows)))]
fn decode_with_os(_bytes: &[u8], ext: &str) -> Result<DynamicImage, String> {
    Err(format!("{} はこの OS では未対応です", ext.to_uppercase()))
}

#[cfg(windows)]
mod wic {
    use image::{DynamicImage, RgbaImage};
    use windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_WICPixelFormat32bppRGBA, IWICImagingFactory,
        WICBitmapDitherTypeNone, WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnDemand,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };

    pub fn decode(bytes: &[u8]) -> windows::core::Result<DynamicImage> {
        unsafe {
            // Rayon worker threads start without COM; an already-initialised
            // thread just returns S_FALSE / RPC_E_CHANGED_MODE, both fine here.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
            let stream = factory.CreateStream()?;
            stream.InitializeFromMemory(bytes)?;
            let decoder =
                factory.CreateDecoderFromStream(&stream, std::ptr::null(), WICDecodeMetadataCacheOnDemand)?;
            let frame = decoder.GetFrame(0)?;
            let converter = factory.CreateFormatConverter()?;
            converter.Initialize(
                &frame,
                &GUID_WICPixelFormat32bppRGBA,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeCustom,
            )?;
            let (mut w, mut h) = (0u32, 0u32);
            converter.GetSize(&mut w, &mut h)?;
            // The size is the file's claim: keep to the image crate's default
            // allocation limit (512 MB) rather than abort on a crafted header.
            if w as u64 * h as u64 * 4 > 512 << 20 {
                return Err(windows::core::Error::new(windows::Win32::Foundation::E_OUTOFMEMORY, "画像が大きすぎます"));
            }
            let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
            converter.CopyPixels(std::ptr::null(), w * 4, &mut buf)?;
            RgbaImage::from_raw(w, h, buf)
                .map(DynamicImage::ImageRgba8)
                .ok_or_else(|| windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn svg_uses_document_size_and_rasterises() {
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
            <rect width="200" height="100" fill="#f00"/></svg>"##;
        let d = decode(svg, "svg").unwrap();
        assert_eq!((d.width, d.height), (200, 100));
        assert_eq!((d.image.width(), d.image.height()), (1024, 512));
        assert_eq!(d.image.to_rgba8().get_pixel(10, 10).0, [255, 0, 0, 255]);
        assert!(decode(b"not svg", "svg").is_err());
    }

    #[test]
    fn svg_images_embed_only_data_urls() {
        use base64::Engine;
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("local.png");
        image::RgbImage::from_pixel(4, 4, image::Rgb([0, 0, 255])).save(&png).unwrap();
        let mut bytes = Cursor::new(Vec::new());
        image::RgbImage::from_pixel(4, 4, image::Rgb([0, 255, 0])).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        let data = base64::engine::general_purpose::STANDARD.encode(bytes.get_ref());
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10">
            <image href="{}" x="0" width="10" height="10"/>
            <image href="data:image/png;base64,{data}" x="10" width="10" height="10"/></svg>"#,
            png.display()
        );
        let img = decode(svg.as_bytes(), "svg").unwrap().image.to_rgba8();
        assert_eq!(img.get_pixel(200, 256).0[3], 0, "the local file isn't read");
        assert_eq!(img.get_pixel(800, 256).0, [0, 255, 0, 255]);
    }

    #[test]
    fn svg_text_is_drawn() {
        // One font that isn't any generic family's default, as on a system
        // without Times New Roman: the text must still be drawn.
        let Some(font) = crate::fonts::tests::system_font(crate::fonts::tests::SINGLE) else { return };
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
            <text x="10" y="70" font-size="60" fill="#000">Hi</text></svg>"##;
        let draws = |db: resvg::usvg::fontdb::Database| {
            let mut opt = svg_options();
            opt.fontdb = std::sync::Arc::new(db);
            let tree = resvg::usvg::Tree::from_data(svg, &opt).unwrap();
            let mut pixmap = resvg::tiny_skia::Pixmap::new(200, 100).unwrap();
            resvg::render(&tree, resvg::tiny_skia::Transform::default(), &mut pixmap.as_mut());
            pixmap.pixels().iter().any(|p| p.alpha() > 0)
        };
        let mut db = resvg::usvg::fontdb::Database::new();
        db.load_font_data(font);
        db.set_serif_family("No Such Font");
        assert!(!draws(db.clone()), "dropped while the generic families name no font here");
        name_present_generic_families(&mut db);
        assert!(draws(db), "the text left marks");
    }

    #[test]
    fn tiff_decodes() {
        let img = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(30, 20, image::Rgb([1, 2, 3])));
        let mut buf = Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageFormat::Tiff).unwrap();
        let d = decode(buf.get_ref(), "tiff").unwrap();
        assert_eq!((d.width, d.height), (30, 20));
    }

    #[test]
    fn names_follow_the_content() {
        let mut png = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(image::RgbImage::new(2, 2)).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let png = png.into_inner();
        assert_eq!(sniff(&png), Some("png"));
        assert_eq!(name_for_content("a.png", &png), "a.png");
        assert_eq!(name_for_content("a.PNG", &png), "a.PNG");
        assert_eq!(name_for_content("a.jpg", &png), "a.png", "wrong extension replaced");
        assert_eq!(name_for_content("photo", &png), "photo.png");
        assert_eq!(name_for_content("image.php", &png), "image.php.png");
        assert_eq!(name_for_content("x.txt", b"plain text"), "x.txt", "unknown content keeps its name");

        assert_eq!(sniff(b"\xff\xd8\xff\xe0rest"), Some("jpg"));
        assert_eq!(name_for_content("a.jpeg", b"\xff\xd8\xff\xe0rest"), "a.jpeg");
        assert_eq!(sniff(b"\xef\xbb\xbf  <?xml version=\"1.0\"?><svg/>"), Some("svg"));
        assert_eq!(sniff(b"<html><body>no</body></html>"), None);
        assert_eq!(sniff(b"wOF2...."), Some("woff2"));
        assert_eq!(sniff(b"\0\0\0\x1cftypavif\0\0\0\0avifmif1miaf"), Some("avif"));
        assert_eq!(sniff(b"\0\0\0\x18ftypheic\0\0\0\0mif1heic"), Some("heic"));
        assert_eq!(sniff(b"\0\0\0\x18ftypisom\0\0\0\0isommp41"), None, "MP4 is not an image");
        assert_eq!(sniff(b""), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn heic_via_sips() {
        // Make a real HEIC with sips itself, then decode it back.
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("a.png");
        let heic = dir.path().join("a.heic");
        image::RgbImage::from_pixel(64, 48, image::Rgb([0, 128, 255])).save(&png).unwrap();
        let ok = std::process::Command::new("/usr/bin/sips")
            .args(["-s", "format", "heic"])
            .arg(&png)
            .arg("--out")
            .arg(&heic)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ok {
            eprintln!("skipping: this macOS can't encode HEIC");
            return;
        }
        let d = decode(&std::fs::read(&heic).unwrap(), "heic").unwrap();
        assert_eq!((d.width, d.height), (64, 48));
    }
}

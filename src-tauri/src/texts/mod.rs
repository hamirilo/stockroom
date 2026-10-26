//! Texts: Markdown, plain text, CSV / TSV (docs/TEXT.md). Unlike the other
//! kinds they can be made and edited in the app, so the stored file is
//! rewritten on save, in the encoding and line endings it had.
//!
//! The thumbnail is the start of the text drawn on a page (an SVG rasterised
//! with the system's fonts, like formats.rs does for SVG files). The text is
//! also kept in `items.body` for the search box.
//!
//! Texts have no pixel size (0 × 0) and take no part in the look-alike search.

use crate::db::{self, NewItem};
use crate::import::{sanitize, write_thumb, THUMB_MAX};
use crate::library;
use image::DynamicImage;
use serde::Serialize;
use std::fmt::Write as _;
use std::path::Path;

pub mod commands;

/// File types imported as texts.
pub const EXTS: &[&str] = &["md", "markdown", "txt", "csv", "tsv"];

pub fn is_text(ext: &str) -> bool {
    EXTS.contains(&ext)
}

/// How much of a text is kept for the search box (bytes, cut at a character).
pub const BODY_MAX: usize = 1 << 20;

/// Larger texts are shown in part and can't be edited (docs/TEXT.md).
pub const EDIT_MAX: u64 = 10 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Encoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    ShiftJis,
}

impl Encoding {
    pub fn label(self) -> &'static str {
        match self {
            Encoding::Utf8 => "UTF-8",
            Encoding::Utf8Bom => "UTF-8（BOM 付き）",
            Encoding::Utf16Le | Encoding::Utf16Be => "UTF-16",
            Encoding::ShiftJis => "Shift_JIS",
        }
    }
}

pub struct Decoded {
    pub text: String,
    pub encoding: Encoding,
    /// Lines end in CRLF (the first line break is taken as the file's).
    pub crlf: bool,
    /// Bytes that are no character of any encoding tried were replaced:
    /// saving would lose them, so such a text is shown but not edited.
    pub lossy: bool,
}

/// Reads a text: BOM (UTF-8 / UTF-16), else UTF-8 if valid, else Shift_JIS
/// if valid, else UTF-8 with the bad bytes replaced.
pub fn decode(data: &[u8]) -> Decoded {
    let (text, encoding, lossy) = if let Some(rest) = data.strip_prefix(b"\xEF\xBB\xBF") {
        let t = String::from_utf8_lossy(rest);
        (t.to_string(), Encoding::Utf8Bom, matches!(t, std::borrow::Cow::Owned(_)))
    } else if data.starts_with(b"\xFF\xFE") || data.starts_with(b"\xFE\xFF") {
        let le = data[0] == 0xFF;
        let enc = if le { encoding_rs::UTF_16LE } else { encoding_rs::UTF_16BE };
        let (t, errors) = enc.decode_without_bom_handling(&data[2..]);
        (t.into_owned(), if le { Encoding::Utf16Le } else { Encoding::Utf16Be }, errors)
    } else if let Ok(t) = std::str::from_utf8(data) {
        (t.to_string(), Encoding::Utf8, false)
    } else if let Some(t) = encoding_rs::SHIFT_JIS.decode_without_bom_handling_and_without_replacement(data) {
        (t.into_owned(), Encoding::ShiftJis, false)
    } else {
        (String::from_utf8_lossy(data).into_owned(), Encoding::Utf8, true)
    };
    let crlf = text.find('\n').is_some_and(|i| i > 0 && text.as_bytes()[i - 1] == b'\r');
    Decoded { text, encoding, crlf, lossy }
}

/// NUL bytes mean a binary file named like a text (UTF-16 has them, behind its BOM).
pub fn is_binary(data: &[u8]) -> bool {
    !(data.starts_with(b"\xFF\xFE") || data.starts_with(b"\xFE\xFF")) && data[..data.len().min(8192)].contains(&0)
}

/// Writes `text` in `encoding` with the line endings asked for. Text that
/// Shift_JIS can't hold (emoji, say) is written as UTF-8 with a BOM, which
/// Excel reads too; the encoding used is returned.
pub fn encode(text: &str, encoding: Encoding, crlf: bool) -> (Vec<u8>, Encoding) {
    let lf = text.replace("\r\n", "\n");
    let text = if crlf { lf.replace('\n', "\r\n") } else { lf };
    let utf16 = |le: bool| {
        let mut out = if le { vec![0xFF, 0xFE] } else { vec![0xFE, 0xFF] };
        for u in text.encode_utf16() {
            out.extend_from_slice(&if le { u.to_le_bytes() } else { u.to_be_bytes() });
        }
        out
    };
    let utf8_bom = || [b"\xEF\xBB\xBF".as_slice(), text.as_bytes()].concat();
    match encoding {
        Encoding::Utf8 => (text.into_bytes(), Encoding::Utf8),
        Encoding::Utf8Bom => (utf8_bom(), Encoding::Utf8Bom),
        Encoding::Utf16Le => (utf16(true), Encoding::Utf16Le),
        Encoding::Utf16Be => (utf16(false), Encoding::Utf16Be),
        Encoding::ShiftJis => {
            let (bytes, _, unmappable) = encoding_rs::SHIFT_JIS.encode(&text);
            if unmappable {
                (utf8_bom(), Encoding::Utf8Bom)
            } else {
                (bytes.into_owned(), Encoding::ShiftJis)
            }
        }
    }
}

/// What the search box looks in: the start of the text.
pub fn body(text: &str) -> String {
    if text.len() <= BODY_MAX {
        return text.to_string();
    }
    let mut end = BODY_MAX;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// A new library item for a text (imported or made in the app): stores the
/// file and its thumbnail. `data` is the file as stored.
pub fn new_item(root: &Path, name: String, ext: String, data: Vec<u8>, hash: String) -> Result<NewItem, String> {
    if is_binary(&data) {
        return Err("テキストではありません".into());
    }
    let decoded = decode(&data);
    let id = uuid::Uuid::new_v4().simple().to_string();
    let file_name = sanitize(&name);
    library::store_file(root, &id, &file_name, &data)?;
    let thumb = write_thumb(&thumbnail(&decoded.text, &ext), &root.join("thumbs"), &id)
        .inspect_err(|_| library::remove_item_dir(root, &id))?;
    Ok(NewItem {
        id,
        kind: db::Kind::Text,
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
        body: Some(body(&decoded.text)),
        duration_ms: None,
    })
}

// ------------------------------------------------------------ thumbnail

/// The page: 3:4 like a document, drawn at the thumbnail size.
const PAGE_W: f32 = 384.0;
const PAGE_H: f32 = 512.0;
const PAD: f32 = 26.0;
const SANS: &str = "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', 'Yu Gothic', Meiryo, 'Noto Sans CJK JP', sans-serif";
const MONO: &str = "Menlo, Consolas, 'Courier New', monospace";

/// Draws the start of the text on a page, with the type in the corner.
pub fn thumbnail(text: &str, ext: &str) -> DynamicImage {
    let svg = page_svg(text, ext);
    crate::formats::rasterize_svg(svg.as_bytes(), THUMB_MAX as f32)
        .map(|d| d.image)
        // Never fails in practice (the SVG is ours); a blank page if it does.
        .unwrap_or_else(|_| DynamicImage::ImageRgb8(image::RgbImage::from_pixel(384, 512, image::Rgb([255, 255, 255]))))
}

fn page_svg(text: &str, ext: &str) -> String {
    let mut svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{PAGE_W}" height="{PAGE_H}" viewBox="0 0 {PAGE_W} {PAGE_H}"><rect x="0.5" y="0.5" width="{}" height="{}" fill="#ffffff" stroke="#e2e2e2"/>"##,
        PAGE_W - 1.0,
        PAGE_H - 1.0
    );
    // Room above the type badge.
    let bottom = PAGE_H - 52.0;
    if text.trim().is_empty() {
        let _ = write!(
            svg,
            r##"<text x="{}" y="{}" font-family="{SANS}" font-size="16" fill="#b0b0b0" text-anchor="middle">（空のテキスト）</text>"##,
            PAGE_W / 2.0,
            PAGE_H / 2.0 - 10.0
        );
    } else {
        match ext {
            "csv" | "tsv" => table_lines(&mut svg, text, if ext == "tsv" { '\t' } else { ',' }, bottom),
            "md" | "markdown" => markdown_lines(&mut svg, text, bottom),
            _ => plain_lines(&mut svg, text, bottom),
        }
    }
    let (label, color) = match ext {
        "md" | "markdown" => ("MD", "#2563eb"),
        "csv" => ("CSV", "#16a34a"),
        "tsv" => ("TSV", "#16a34a"),
        _ => ("TXT", "#6b7280"),
    };
    let w = 18.0 + label.len() as f32 * 10.0;
    let _ = write!(
        svg,
        r##"<rect x="{x}" y="{y}" width="{w}" height="26" rx="5" fill="{color}"/><text x="{tx}" y="{ty}" font-family="{SANS}" font-size="14" font-weight="bold" fill="#ffffff" text-anchor="middle">{label}</text></svg>"##,
        x = PAGE_W - PAD - w,
        y = PAGE_H - 42.0,
        tx = PAGE_W - PAD - w / 2.0,
        ty = PAGE_H - 24.0,
    );
    svg
}

/// Rough width of a character in ems: full width for CJK and the like.
fn char_em(c: char) -> f32 {
    let u = c as u32;
    let wide = (0x1100..=0x115F).contains(&u)
        || (0x2E80..=0xA4CF).contains(&u)
        || (0xAC00..=0xD7A3).contains(&u)
        || (0xF900..=0xFAFF).contains(&u)
        || (0xFE30..=0xFE4F).contains(&u)
        || (0xFF00..=0xFF60).contains(&u)
        || (0xFFE0..=0xFFE6).contains(&u)
        || u >= 0x1F300;
    if wide {
        1.0
    } else if c == '\t' {
        2.0
    } else {
        0.58
    }
}

/// Splits `line` into pieces at most `max_em` wide (at any character: it's a thumbnail).
fn wrap(line: &str, max_em: f32) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut w = 0.0;
    for c in line.chars() {
        let cw = char_em(c);
        if w + cw > max_em && !out.last().unwrap().is_empty() {
            out.push(String::new());
            w = 0.0;
        }
        out.last_mut().unwrap().push(c);
        w += cw;
    }
    out
}

/// `s` cut to `max_em`, with an ellipsis when cut.
fn fit(s: &str, max_em: f32) -> String {
    let mut w = 0.0;
    let mut out = String::new();
    for c in s.chars() {
        w += char_em(c);
        if w > max_em - 0.6 {
            out.push('…');
            return out;
        }
        out.push(c);
    }
    out
}

/// Escapes for XML, dropping the control characters XML can't hold.
fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' => out.push_str("  "),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

struct Line<'a> {
    text: String,
    size: f32,
    bold: bool,
    color: &'a str,
    mono: bool,
}

/// Lays out lines top-down, wrapping each, until the page is full.
fn draw_lines(svg: &mut String, lines: impl IntoIterator<Item = Option<Line<'static>>>, bottom: f32) {
    let mut y = PAD;
    for line in lines {
        let Some(line) = line else {
            // A blank line or a rule: a little space.
            y += 8.0;
            continue;
        };
        let lh = line.size * 1.5;
        let max_em = (PAGE_W - PAD * 2.0) / line.size / if line.mono { 1.03 } else { 1.0 };
        for piece in wrap(&line.text, max_em) {
            if y + lh > bottom {
                return;
            }
            y += lh;
            let _ = write!(
                svg,
                r#"<text x="{PAD}" y="{}" font-family="{}" font-size="{}"{} fill="{}" xml:space="preserve">{}</text>"#,
                y - line.size * 0.4,
                if line.mono { MONO } else { SANS },
                line.size,
                if line.bold { r#" font-weight="bold""# } else { "" },
                line.color,
                esc(&piece)
            );
        }
    }
}

fn plain_lines(svg: &mut String, text: &str, bottom: f32) {
    let lines = text.lines().take(60).map(|l| {
        (!l.trim().is_empty()).then(|| Line { text: l.to_string(), size: 17.0, bold: false, color: "#333333", mono: false })
    });
    draw_lines(svg, lines, bottom);
}

/// Markdown lightly: headings bold and larger, list marks as bullets, code
/// in monospace, the inline marks (`**`, `` ` ``, links) taken out.
fn markdown_lines(svg: &mut String, text: &str, bottom: f32) {
    let mut code = false;
    let mut out = Vec::new();
    for raw in text.lines().take(80) {
        let t = raw.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            code = !code;
            continue;
        }
        if code {
            out.push(Some(Line { text: raw.to_string(), size: 15.0, bold: false, color: "#555555", mono: true }));
            continue;
        }
        if t.is_empty() || t.chars().all(|c| matches!(c, '-' | '*' | '_' | ' ')) && t.len() >= 3 {
            out.push(None);
            continue;
        }
        let hashes = t.chars().take_while(|&c| c == '#').count();
        if (1..=6).contains(&hashes) && t[hashes..].starts_with(' ') {
            let size = match hashes {
                1 => 24.0,
                2 => 20.0,
                _ => 18.0,
            };
            out.push(Some(Line { text: inline(t[hashes..].trim()), size, bold: true, color: "#111111", mono: false }));
            continue;
        }
        let (text, color) = if let Some(q) = t.strip_prefix('>') {
            (inline(q.trim_start()), "#777777")
        } else if let Some(item) = ["- ", "* ", "+ "].iter().find_map(|m| t.strip_prefix(m)) {
            let item = item.strip_prefix("[ ] ").map(|s| format!("☐ {s}")).or_else(|| {
                item.strip_prefix("[x] ").or_else(|| item.strip_prefix("[X] ")).map(|s| format!("☑ {s}"))
            });
            let indent = "  ".repeat((raw.len() - t.len()) / 2);
            (format!("{indent}• {}", inline(&item.unwrap_or_else(|| t[2..].to_string()))), "#333333")
        } else {
            (inline(t), "#333333")
        };
        out.push(Some(Line { text, size: 17.0, bold: false, color, mono: false }));
    }
    draw_lines(svg, out, bottom);
}

/// Takes out inline Markdown: `**`, `__`, `` ` ``, `~~`, and links / images
/// as their text.
fn inline(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if (c == '*' && next == Some('*')) || (c == '_' && next == Some('_')) || (c == '~' && next == Some('~')) {
            i += 2;
        } else if c == '`' {
            i += 1;
        } else if c == '[' || (c == '!' && next == Some('[')) {
            // [text](url) → text
            let start = if c == '!' { i + 2 } else { i + 1 };
            let close = chars[start..].iter().position(|&x| x == ']').map(|p| start + p);
            match close {
                Some(e) if chars.get(e + 1) == Some(&'(') => {
                    out.extend(&chars[start..e]);
                    i = chars[e..].iter().position(|&x| x == ')').map_or(chars.len(), |p| e + p + 1);
                }
                _ => {
                    out.push(c);
                    i += 1;
                }
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// The first rows of a CSV / TSV as a table, the first row as the header.
fn table_lines(svg: &mut String, text: &str, sep: char, bottom: f32) {
    let rows = parse_delimited(text, sep, 24);
    let cols = rows.iter().map(Vec::len).max().unwrap_or(0).clamp(1, 3);
    let width = PAGE_W - PAD * 2.0;
    let col_w = width / cols as f32;
    let (size, row_h) = (15.0, 30.0);
    let mut y = PAD;
    for (r, row) in rows.iter().enumerate() {
        if y + row_h > bottom {
            break;
        }
        if r == 0 {
            let _ = write!(svg, r##"<rect x="{PAD}" y="{y}" width="{width}" height="{row_h}" fill="#f1f3f5"/>"##);
        }
        for (c, cell) in row.iter().take(cols).enumerate() {
            let _ = write!(
                svg,
                r##"<text x="{}" y="{}" font-family="{SANS}" font-size="{size}"{} fill="#333333" xml:space="preserve">{}</text>"##,
                PAD + 7.0 + c as f32 * col_w,
                y + row_h - 10.0,
                if r == 0 { r#" font-weight="bold""# } else { "" },
                esc(&fit(cell.trim(), (col_w - 12.0) / size))
            );
        }
        y += row_h;
        let _ = write!(svg, r##"<line x1="{PAD}" y1="{y}" x2="{}" y2="{y}" stroke="#e2e5e9"/>"##, PAD + width);
    }
    for c in 1..cols {
        let x = PAD + c as f32 * col_w;
        let _ = write!(svg, r##"<line x1="{x}" y1="{PAD}" x2="{x}" y2="{y}" stroke="#eceef1"/>"##);
    }
}

/// CSV / TSV rows (quoted cells may hold the separator, quotes and line
/// breaks), at most `max_rows`.
pub fn parse_delimited(text: &str, sep: char, max_rows: usize) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    cell.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                cell.push(c);
            }
        } else if c == '"' && cell.is_empty() {
            quoted = true;
        } else if c == sep {
            row.push(std::mem::take(&mut cell));
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut cell));
            rows.push(std::mem::take(&mut row));
            if rows.len() >= max_rows {
                return rows;
            }
        } else {
            cell.push(c);
        }
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        rows.push(row);
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_and_encodes_each_encoding() {
        // Shift_JIS from Excel, with CRLF.
        let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("品名,数量\r\n牛肉,3\r\n");
        let d = decode(&sjis);
        assert_eq!((d.encoding, d.crlf, d.lossy), (Encoding::ShiftJis, true, false));
        assert_eq!(d.text, "品名,数量\r\n牛肉,3\r\n");
        // The editor gives LF; it goes back as Shift_JIS with CRLF.
        assert_eq!(encode("品名,数量\n牛肉,3\n", d.encoding, d.crlf), (sjis.to_vec(), Encoding::ShiftJis));

        let d = decode("# 見出し\nほんぶん\n".as_bytes());
        assert_eq!((d.encoding, d.crlf), (Encoding::Utf8, false));

        let bom = [b"\xEF\xBB\xBF".as_slice(), "a,b".as_bytes()].concat();
        let d = decode(&bom);
        assert_eq!((d.encoding, d.text.as_str()), (Encoding::Utf8Bom, "a,b"));
        assert_eq!(encode("a,b", d.encoding, false).0, bom);

        let (le, _) = encode("あa\n", Encoding::Utf16Le, false);
        let d = decode(&le);
        assert_eq!((d.encoding, d.text.as_str()), (Encoding::Utf16Le, "あa\n"));
        assert!(!is_binary(&le), "UTF-16 has NULs behind its BOM");
    }

    #[test]
    fn what_shift_jis_cannot_hold_goes_out_as_utf8() {
        let (bytes, enc) = encode("牛肉🐄", Encoding::ShiftJis, false);
        assert_eq!(enc, Encoding::Utf8Bom);
        assert_eq!(decode(&bytes).text, "牛肉🐄");
    }

    #[test]
    fn unreadable_bytes_are_lossy_and_binaries_are_refused() {
        // Neither UTF-8 nor Shift_JIS (0x80 alone is no Shift_JIS lead byte).
        assert!(decode(b"abc\x80\xFF").lossy);
        assert!(is_binary(b"PK\x03\x04\x00\x00"));
        assert!(!is_binary("ふつうの文".as_bytes()));
    }

    #[test]
    fn body_is_cut_at_a_character() {
        let long = "あ".repeat(BODY_MAX); // 3 bytes each
        let b = body(&long);
        assert!(b.len() <= BODY_MAX && b.chars().all(|c| c == 'あ'));
    }

    #[test]
    fn parses_quoted_cells() {
        let rows = parse_delimited("a,\"b,c\",\"say \"\"hi\"\"\"\r\n\"two\nlines\",x\n", ',', 10);
        assert_eq!(rows, vec![vec!["a", "b,c", "say \"hi\""], vec!["two\nlines", "x"]]);
        assert_eq!(parse_delimited("a\tb", '\t', 10), vec![vec!["a", "b"]]);
    }

    #[test]
    fn inline_marks_are_taken_out() {
        assert_eq!(inline("**太字** と `code` と [リンク](https://x.example) ![絵](a.png)"), "太字 と code と リンク 絵");
    }

    #[test]
    fn thumbnails_render_every_type() {
        for (text, ext) in [
            ("# 見出し\n\n- 項目\n- [x] 済み\n\n```\ncode\n```\n> 引用 <&>", "md"),
            ("品名,数量\n牛肉,3\n\"豚,肉\",5", "csv"),
            ("a\tb\n1\t2", "tsv"),
            ("ふつうのテキスト\u{0007}制御文字", "txt"),
            ("", "txt"),
        ] {
            let img = thumbnail(text, ext);
            assert_eq!((img.width(), img.height()), (384, 512), "{ext}");
        }
    }
}

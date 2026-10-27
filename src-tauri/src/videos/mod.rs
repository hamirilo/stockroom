//! Videos: MP4 / M4V / MOV / WebM (docs/VIDEO.md). They are stored as is and
//! played in the viewer by the web view, so only what it can decode plays;
//! the rest is opened in the OS's default app.
//!
//! The thumbnail is one frame from the OS (Quick Look on macOS, which
//! `files::thumbnail` runs), else a card with the file type. The length and
//! the picture size are read from the file's own headers (`probe`), without
//! decoding anything and without ffmpeg.
//!
//! Videos are never read into memory as a whole: they are hashed and copied
//! from the disk (import.rs `process_video`). They take no part in the
//! look-alike search.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// File types imported as videos.
pub const EXTS: &[&str] = &["mp4", "m4v", "mov", "webm"];

pub fn is_video(ext: &str) -> bool {
    EXTS.contains(&ext)
}

/// What the headers of a video say. 0 = not found.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Info {
    pub width: u32,
    pub height: u32,
    pub duration_ms: Option<i64>,
}

/// Reads the size and length of the video at `path`. Never fails: a file
/// that can't be read gives an empty `Info`.
pub fn probe(path: &Path, ext: &str) -> Info {
    let Ok(mut f) = File::open(path) else { return Info::default() };
    match ext {
        "webm" => {
            let mut head = Vec::new();
            let _ = (&mut f).take(WEBM_HEAD).read_to_end(&mut head);
            webm_info(&head)
        }
        _ => mp4_info(&mut f),
    }
}

/// The codecs of a video's first picture and sound tracks, as people name them
/// ("H.264", "AAC"), and the picture track's frame rate (average, frames per
/// second). None = no such track, or the file's headers say nothing.
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Codecs {
    pub video: Option<String>,
    pub audio: Option<String>,
    pub frame_rate: Option<f64>,
}

/// Reads the codecs of the video at `path` from its headers (nothing is
/// decoded). Never fails: a file that can't be read gives no codecs.
pub fn codecs(path: &Path, ext: &str) -> Codecs {
    let Ok(mut f) = File::open(path) else { return Codecs::default() };
    match ext {
        "webm" => {
            let mut head = Vec::new();
            let _ = (&mut f).take(WEBM_HEAD).read_to_end(&mut head);
            webm_codecs(&head)
        }
        _ => read_moov(&mut f).map_or_else(Codecs::default, |moov| mp4_codecs(&moov)),
    }
}

// ------------------------------------------------------------------ MP4 / MOV

/// The `moov` box is read whole, up to this size (it holds the sample tables
/// of every track, a few MB for a long video).
const MOOV_MAX: u64 = 64 << 20;

/// Walks the top-level boxes by seeking (`mdat` is skipped, not read) to
/// `moov`, then reads the length from `mvhd` and the picture size from the
/// largest `tkhd`.
fn mp4_info(f: &mut File) -> Info {
    read_moov(f).map_or_else(Info::default, |moov| moov_info(&moov))
}

/// The payload of the file's `moov` box, if it has one within `MOOV_MAX`.
fn read_moov(f: &mut File) -> Option<Vec<u8>> {
    let total = f.metadata().map(|m| m.len()).ok()?;
    let mut pos = 0u64;
    while pos + 8 <= total {
        let mut h = [0u8; 16];
        if f.seek(SeekFrom::Start(pos)).is_err() || f.read(&mut h[..8]).unwrap_or(0) < 8 {
            break;
        }
        let mut size = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as u64;
        let mut head = 8;
        if size == 1 {
            if f.read_exact(&mut h[8..16]).is_err() {
                break;
            }
            size = u64::from_be_bytes(h[8..16].try_into().unwrap());
            head = 16;
        } else if size == 0 {
            size = total - pos;
        }
        if size < head {
            break;
        }
        if &h[4..8] == b"moov" {
            let len = size - head;
            if len > MOOV_MAX {
                break;
            }
            let mut buf = vec![0u8; len as usize];
            if f.read_exact(&mut buf).is_err() {
                break;
            }
            return Some(buf);
        }
        pos += size;
    }
    None
}

/// The boxes inside `data` as (type, payload).
fn boxes(data: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 8 <= data.len() {
        let mut size = u32::from_be_bytes(data[i..i + 4].try_into().unwrap()) as usize;
        let kind: [u8; 4] = data[i + 4..i + 8].try_into().unwrap();
        let mut head = 8;
        if size == 1 && i + 16 <= data.len() {
            size = u64::from_be_bytes(data[i + 8..i + 16].try_into().unwrap()) as usize;
            head = 16;
        } else if size == 0 {
            size = data.len() - i;
        }
        if size < head || i + size > data.len() {
            break;
        }
        out.push((kind, &data[i + head..i + size]));
        i += size;
    }
    out
}

fn be32(d: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(d.get(at..at + 4)?.try_into().ok()?))
}

fn be64(d: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(d.get(at..at + 8)?.try_into().ok()?))
}

fn moov_info(moov: &[u8]) -> Info {
    let mut info = Info::default();
    for (kind, body) in boxes(moov) {
        match &kind {
            b"mvhd" => info.duration_ms = mvhd_ms(body),
            b"trak" => {
                if let Some((w, h)) = boxes(body).into_iter().find(|(k, _)| k == b"tkhd").and_then(|(_, b)| tkhd_size(b)) {
                    if u64::from(w) * u64::from(h) > u64::from(info.width) * u64::from(info.height) {
                        (info.width, info.height) = (w, h);
                    }
                }
            }
            _ => {}
        }
    }
    info
}

/// Length in ms from a `mvhd` payload (version 0 or 1).
fn mvhd_ms(b: &[u8]) -> Option<i64> {
    let (scale, dur) = if *b.first()? == 1 {
        (be32(b, 20)?, be64(b, 24)?)
    } else {
        (be32(b, 12)?, u64::from(be32(b, 16)?))
    };
    // All ones = "not known" (a fragmented file).
    (scale > 0 && dur != u64::MAX && dur != u64::from(u32::MAX)).then(|| (dur as u128 * 1000 / scale as u128) as i64)
}

/// Displayed picture size from a `tkhd` payload; (0, 0) for audio tracks. A
/// phone video turned a quarter (matrix a = 0) is stored sideways: swapped.
fn tkhd_size(b: &[u8]) -> Option<(u32, u32)> {
    let at = if *b.first()? == 1 { 88 } else { 76 };
    let (w, h) = (be32(b, at)? >> 16, be32(b, at + 4)? >> 16);
    let matrix = at - 36;
    let sideways = be32(b, matrix)? == 0 && be32(b, matrix + 4)? != 0;
    Some(if sideways { (h, w) } else { (w, h) })
}

/// Codecs from the `moov` payload: per `trak`, the handler (`hdlr`: video /
/// sound) and the format of the first sample entry in `stsd`.
fn mp4_codecs(moov: &[u8]) -> Codecs {
    let mut out = Codecs::default();
    for (kind, trak) in boxes(moov) {
        if &kind != b"trak" {
            continue;
        }
        let Some((_, mdia)) = boxes(trak).into_iter().find(|(k, _)| k == b"mdia") else { continue };
        let mdia = boxes(mdia);
        let handler = mdia.iter().find(|(k, _)| k == b"hdlr").and_then(|(_, b)| b.get(8..12));
        let format = mdia
            .iter()
            .find(|(k, _)| k == b"minf")
            .and_then(|(_, minf)| boxes(minf).into_iter().find(|(k, _)| k == b"stbl"))
            .and_then(|(_, stbl)| boxes(stbl).into_iter().find(|(k, _)| k == b"stsd"))
            // version / flags, entry count, then the first entry: size, format.
            .and_then(|(_, stsd)| stsd.get(12..16));
        let (Some(handler), Some(format)) = (handler, format) else { continue };
        match handler {
            b"vide" if out.video.is_none() => {
                out.video = Some(mp4_codec_name(format));
                out.frame_rate = mp4_frame_rate(&mdia);
            }
            b"soun" if out.audio.is_none() => out.audio = Some(mp4_codec_name(format)),
            _ => {}
        }
    }
    out
}

/// Average frames per second of a video track (the boxes of its `mdia`): the
/// samples counted in `stts` over their total time, in `mdhd` time units.
/// None for a fragmented file (its `stts` is empty).
fn mp4_frame_rate(mdia: &[([u8; 4], &[u8])]) -> Option<f64> {
    let mdhd = mdia.iter().find(|(k, _)| k == b"mdhd")?.1;
    let scale = if *mdhd.first()? == 1 { be32(mdhd, 20)? } else { be32(mdhd, 12)? };
    let stts = boxes(mdia.iter().find(|(k, _)| k == b"minf")?.1)
        .into_iter()
        .find(|(k, _)| k == b"stbl")
        .and_then(|(_, stbl)| boxes(stbl).into_iter().find(|(k, _)| k == b"stts"))?
        .1;
    let entries = be32(stts, 4)? as usize;
    let (mut samples, mut time) = (0u64, 0u64);
    for i in 0..entries {
        let (count, delta) = (u64::from(be32(stts, 8 + i * 8)?), u64::from(be32(stts, 12 + i * 8)?));
        samples += count;
        time += count * delta;
    }
    (scale > 0 && samples > 1 && time > 0).then(|| samples as f64 * f64::from(scale) / time as f64)
}

/// Names a sample-entry format (QuickTime / ISO BMFF four-character code).
fn mp4_codec_name(format: &[u8]) -> String {
    let known = match format {
        b"avc1" | b"avc3" => "H.264",
        b"hvc1" | b"hev1" => "HEVC (H.265)",
        b"dvh1" | b"dvhe" => "Dolby Vision (HEVC)",
        b"av01" => "AV1",
        b"vp09" => "VP9",
        b"vp08" => "VP8",
        b"mp4v" => "MPEG-4 Visual",
        b"apch" | b"apcn" | b"apcs" | b"apco" | b"ap4h" | b"ap4x" => "Apple ProRes",
        b"jpeg" | b"mjpa" => "Motion JPEG",
        b"mp4a" => "AAC",
        b"ac-3" => "Dolby Digital (AC-3)",
        b"ec-3" => "Dolby Digital Plus (E-AC-3)",
        b"alac" => "Apple Lossless (ALAC)",
        b"Opus" | b"opus" => "Opus",
        b"fLaC" => "FLAC",
        b".mp3" | b"mp3 " => "MP3",
        b"lpcm" | b"sowt" | b"twos" | b"in24" | b"in32" | b"fl32" | b"fl64" => "PCM",
        _ => "",
    };
    if known.is_empty() {
        // Unknown: the code itself says more than nothing.
        let raw = String::from_utf8_lossy(format).trim().to_string();
        return if raw.is_empty() { "不明".into() } else { raw };
    }
    known.into()
}

// ---------------------------------------------------------------------- WebM

/// Segment info and tracks come first in a WebM file.
const WEBM_HEAD: u64 = 1 << 20;

/// An EBML element id (marker bits kept) and size (marker removed; None =
/// unknown) at `at`, and the position after the header.
fn ebml_head(d: &[u8], at: usize) -> Option<(u32, Option<u64>, usize)> {
    let first = *d.get(at)?;
    let id_len = first.leading_zeros() as usize + 1;
    if id_len > 4 {
        return None;
    }
    let id = d.get(at..at + id_len)?.iter().fold(0u32, |a, b| a << 8 | u32::from(*b));
    let s0 = *d.get(at + id_len)?;
    let size_len = s0.leading_zeros() as usize + 1;
    if size_len > 8 {
        return None;
    }
    let bytes = d.get(at + id_len..at + id_len + size_len)?;
    let mut size = u64::from(bytes[0]) & (0xFF >> size_len);
    let mut all_ones = size == 0xFF >> size_len;
    for b in &bytes[1..] {
        size = size << 8 | u64::from(*b);
        all_ones &= *b == 0xFF;
    }
    Some((id, (!all_ones).then_some(size), at + id_len + size_len))
}

fn ebml_uint(d: &[u8]) -> u64 {
    d.iter().fold(0, |a, b| a << 8 | u64::from(*b))
}

fn ebml_float(d: &[u8]) -> Option<f64> {
    match d.len() {
        4 => Some(f64::from(f32::from_be_bytes(d.try_into().ok()?))),
        8 => Some(f64::from_be_bytes(d.try_into().ok()?)),
        _ => None,
    }
}

#[derive(Default)]
struct Webm {
    scale: Option<u64>,
    duration: Option<f64>,
    width: u32,
    height: u32,
}

fn webm_walk(d: &[u8], out: &mut Webm) {
    const SEGMENT: u32 = 0x1853_8067;
    const INFO: u32 = 0x1549_A966;
    const TRACKS: u32 = 0x1654_AE6B;
    const ENTRY: u32 = 0xAE;
    const VIDEO: u32 = 0xE0;
    const SCALE: u32 = 0x2A_D7B1;
    const DURATION: u32 = 0x4489;
    const WIDTH: u32 = 0xB0;
    const HEIGHT: u32 = 0xBA;
    let mut at = 0;
    while let Some((id, size, body)) = ebml_head(d, at) {
        // Unknown size (a live segment) or a cut at the end of what was read: to the end.
        let end = size.map_or(d.len(), |s| body.saturating_add(s as usize)).min(d.len());
        let data = &d[body.min(end)..end];
        match id {
            SEGMENT | INFO | TRACKS | ENTRY | VIDEO => webm_walk(data, out),
            SCALE => out.scale = Some(ebml_uint(data)),
            DURATION => out.duration = ebml_float(data),
            WIDTH => out.width = ebml_uint(data) as u32,
            HEIGHT => out.height = ebml_uint(data) as u32,
            _ => {}
        }
        if end <= at {
            break;
        }
        at = end;
    }
}

/// Codecs from a WebM file's head: the `CodecID` (e.g. "V_VP9") of the first
/// video and the first audio track.
fn webm_codecs(head: &[u8]) -> Codecs {
    const SEGMENT: u32 = 0x1853_8067;
    const TRACKS: u32 = 0x1654_AE6B;
    const ENTRY: u32 = 0xAE;
    const TRACK_TYPE: u32 = 0x83;
    const CODEC_ID: u32 = 0x86;
    const DEFAULT_DURATION: u32 = 0x23_E383;
    // The elements inside one `ENTRY`: (track type, codec id, frame duration in ns).
    fn entry(d: &[u8]) -> (u64, String, u64) {
        let (mut kind, mut codec, mut frame_ns) = (0, String::new(), 0);
        let mut at = 0;
        while let Some((id, size, body)) = ebml_head(d, at) {
            let end = size.map_or(d.len(), |s| body.saturating_add(s as usize)).min(d.len());
            let data = &d[body.min(end)..end];
            match id {
                TRACK_TYPE => kind = ebml_uint(data),
                DEFAULT_DURATION => frame_ns = ebml_uint(data),
                CODEC_ID => codec = String::from_utf8_lossy(data).trim_end_matches('\0').to_string(),
                _ => {}
            }
            if end <= at {
                break;
            }
            at = end;
        }
        (kind, codec, frame_ns)
    }
    fn walk(d: &[u8], out: &mut Codecs) {
        let mut at = 0;
        while let Some((id, size, body)) = ebml_head(d, at) {
            let end = size.map_or(d.len(), |s| body.saturating_add(s as usize)).min(d.len());
            let data = &d[body.min(end)..end];
            match id {
                SEGMENT | TRACKS => walk(data, out),
                ENTRY => match entry(data) {
                    (1, c, ns) if out.video.is_none() => {
                        out.video = Some(webm_codec_name(&c));
                        out.frame_rate = (ns > 0).then(|| 1e9 / ns as f64);
                    }
                    (2, c, _) if out.audio.is_none() => out.audio = Some(webm_codec_name(&c)),
                    _ => {}
                },
                _ => {}
            }
            if end <= at {
                break;
            }
            at = end;
        }
    }
    let mut out = Codecs::default();
    walk(head, &mut out);
    out
}

fn webm_codec_name(id: &str) -> String {
    match id {
        "V_VP8" => "VP8",
        "V_VP9" => "VP9",
        "V_AV1" => "AV1",
        "V_MPEG4/ISO/AVC" => "H.264",
        "V_MPEGH/ISO/HEVC" => "HEVC (H.265)",
        "A_OPUS" => "Opus",
        "A_VORBIS" => "Vorbis",
        "A_FLAC" => "FLAC",
        "A_AAC" => "AAC",
        "" => "不明",
        other => other,
    }
    .into()
}

fn webm_info(head: &[u8]) -> Info {
    let mut w = Webm::default();
    webm_walk(head, &mut w);
    // Duration is in units of the timecode scale (1 ms by default; the scale is in ns).
    let scale = w.scale.unwrap_or(1_000_000) as f64;
    Info {
        width: w.width,
        height: w.height,
        duration_ms: w.duration.filter(|d| d.is_finite() && *d > 0.0).map(|d| (d * scale / 1_000_000.0).round() as i64),
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend(kind);
        v.extend(body);
        v
    }

    fn tkhd(w: u32, h: u32, turned: bool) -> Vec<u8> {
        let mut b = vec![0u8; 84];
        let (a, bb) = if turned { (0u32, 0x1_0000u32) } else { (0x1_0000, 0) };
        b[40..44].copy_from_slice(&a.to_be_bytes());
        b[44..48].copy_from_slice(&bb.to_be_bytes());
        b[76..80].copy_from_slice(&(w << 16).to_be_bytes());
        b[80..84].copy_from_slice(&(h << 16).to_be_bytes());
        bx(b"tkhd", &b)
    }

    /// A video with only headers (no frames): 15 s, 1920 × 1080.
    pub fn mp4(turned: bool) -> Vec<u8> {
        let mut mvhd = vec![0u8; 100];
        mvhd[12..16].copy_from_slice(&600u32.to_be_bytes());
        mvhd[16..20].copy_from_slice(&9000u32.to_be_bytes()); // 15 s
        let audio = bx(b"trak", &tkhd(0, 0, false));
        let video = bx(b"trak", &tkhd(1920, 1080, turned));
        let moov = bx(b"moov", &[bx(b"mvhd", &mvhd), audio, video].concat());
        [bx(b"ftyp", b"isom"), bx(b"mdat", &[0; 100]), moov].concat()
    }

    fn probe_bytes(data: &[u8], ext: &str) -> Info {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(format!("v.{ext}"));
        std::fs::write(&p, data).unwrap();
        probe(&p, ext)
    }

    #[test]
    fn mp4_length_and_size_after_mdat() {
        let i = probe_bytes(&mp4(false), "mp4");
        assert_eq!((i.width, i.height, i.duration_ms), (1920, 1080, Some(15_000)));
    }

    #[test]
    fn mp4_turned_swaps_the_size() {
        let i = probe_bytes(&mp4(true), "mov");
        assert_eq!((i.width, i.height), (1080, 1920));
    }

    #[test]
    fn mp4_codecs_of_each_track() {
        let track = |handler: &[u8; 4], format: &[u8; 4]| {
            let mut hdlr = vec![0u8; 8];
            hdlr.extend_from_slice(handler);
            let mut stsd = vec![0u8; 4];
            stsd.extend_from_slice(&1u32.to_be_bytes());
            stsd.extend_from_slice(&16u32.to_be_bytes());
            stsd.extend_from_slice(format);
            let stbl = bx(b"stbl", &bx(b"stsd", &stsd));
            bx(b"trak", &bx(b"mdia", &[bx(b"hdlr", &hdlr), bx(b"minf", &stbl)].concat()))
        };
        let moov = [track(b"vide", b"hvc1"), track(b"soun", b"mp4a")].concat();
        assert_eq!(
            mp4_codecs(&moov),
            Codecs { video: Some("HEVC (H.265)".into()), audio: Some("AAC".into()), frame_rate: None }
        );
        let moov = track(b"vide", b"zzzz");
        assert_eq!(mp4_codecs(&moov), Codecs { video: Some("zzzz".into()), ..Default::default() });
    }

    #[test]
    fn mp4_frame_rate_from_stts() {
        let mut mdhd = vec![0u8; 24];
        mdhd[12..16].copy_from_slice(&30_000u32.to_be_bytes());
        let mut stts = vec![0u8; 4];
        stts.extend_from_slice(&2u32.to_be_bytes());
        for (count, delta) in [(100u32, 1001u32), (50, 1001)] {
            stts.extend_from_slice(&count.to_be_bytes());
            stts.extend_from_slice(&delta.to_be_bytes());
        }
        let minf = bx(b"minf", &bx(b"stbl", &bx(b"stts", &stts)));
        let mdia_body = [bx(b"mdhd", &mdhd), minf].concat();
        let fps = mp4_frame_rate(&boxes(&mdia_body)).unwrap();
        assert!((fps - 29.97).abs() < 0.01, "{fps}");
        // A fragmented file has no samples in `stts`.
        let empty = bx(b"minf", &bx(b"stbl", &bx(b"stts", &[0u8; 8])));
        assert_eq!(mp4_frame_rate(&boxes(&[bx(b"mdhd", &mdhd), empty].concat())), None);
    }

    #[test]
    fn broken_files_give_nothing() {
        assert_eq!(probe_bytes(b"not a video", "mp4"), Info::default());
        assert_eq!(probe_bytes(&[], "webm"), Info::default());
        assert_eq!(probe(Path::new("/no/such/file.mp4"), "mp4"), Info::default());
        assert_eq!(codecs(Path::new("/no/such/file.mp4"), "mp4"), Codecs::default());
    }

    fn el(id: &[u8], body: &[u8]) -> Vec<u8> {
        assert!(body.len() < 127);
        [id, &[0x80 | body.len() as u8][..], body].concat()
    }

    #[test]
    fn webm_length_and_size() {
        let info = el(&[0x15, 0x49, 0xA9, 0x66], &[el(&[0x2A, 0xD7, 0xB1], &1_000_000u32.to_be_bytes()), el(&[0x44, 0x89], &2500f32.to_be_bytes())].concat());
        let video = el(&[0xE0], &[el(&[0xB0], &640u16.to_be_bytes()), el(&[0xBA], &360u16.to_be_bytes())].concat());
        let tracks = el(&[0x16, 0x54, 0xAE, 0x6B], &el(&[0xAE], &video));
        // The segment's size is unknown (all ones), as a live recording writes it.
        let segment = [&[0x18, 0x53, 0x80, 0x67, 0xFF][..], &info, &tracks].concat();
        let i = probe_bytes(&[el(&[0x1A, 0x45, 0xDF, 0xA3], &[]), segment].concat(), "webm");
        assert_eq!((i.width, i.height, i.duration_ms), (640, 360, Some(2500)));
    }

    #[test]
    fn webm_codecs_of_each_track() {
        let entry = |kind: u8, codec: &[u8]| el(&[0xAE], &[el(&[0x83], &[kind]), el(&[0x86], codec), el(&[0x23, 0xE3, 0x83], &40_000_000u32.to_be_bytes())].concat());
        let tracks = el(&[0x16, 0x54, 0xAE, 0x6B], &[entry(1, b"V_VP9"), entry(2, b"A_OPUS")].concat());
        let segment = [&[0x18, 0x53, 0x80, 0x67, 0xFF][..], &tracks].concat();
        let c = webm_codecs(&[el(&[0x1A, 0x45, 0xDF, 0xA3], &[]), segment].concat());
        assert_eq!(c, Codecs { video: Some("VP9".into()), audio: Some("Opus".into()), frame_rate: Some(25.0) });
    }
}

//! Sharing a folder read-only on the local network: a page that phones and
//! colleagues on the same Wi-Fi / LAN open in a browser to look through the
//! folder and its subfolders, and download the files. See docs/FEATURES.md.
//!
//! - Runs while the app is open and the open library has a shared folder.
//!   Unlike the extension's and Claude's servers it listens on every network
//!   the PC is on (0.0.0.0), on a fixed port.
//! - Each shared folder has its own secret in the URL (`/s/<token>/`). The
//!   secret is the only key: anyone who has the URL can look, nobody else
//!   can. Stopping the share makes the URL stop working at once.
//! - Only GET. Everything asked for is checked to be inside the shared folder
//!   (the folder or one of its subfolders, not in the trash); nothing above
//!   it or beside it can be reached, whatever the URL says.
//! - Shown: names, sizes, thumbnails and the images. Not shown: notes, tags,
//!   ratings, the page an item was saved from.
//! - Plain HTTP: the network can see what is looked at. The settings say so.
//!
//!   GET /s/<token>/              the page (share.html)
//!   GET /s/<token>/api/folder?id=  one folder: its path from the shared one,
//!                                subfolders and items (no id = the shared one)
//!   GET /s/<token>/thumb/<item>  the thumbnail
//!   GET /s/<token>/view/<item>   an image to look at (the display copy if any)
//!   GET /s/<token>/file/<item>   the original file, as a download (when allowed)

use crate::db::{self, DbResult, Folder, Item, ItemQuery, Kind, SortKey, View};
use crate::library::{self, Library};
use crate::loopback::Listener;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};

pub const PORT: u16 = 41640;

/// The page, with its script and styles (no other files are needed).
const PAGE: &str = include_str!("share.html");

// --------------------------------------------------------------- shares

/// A shared folder (library.db `shares`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Share {
    pub folder_id: String,
    /// The secret in the URL.
    pub token: String,
    /// The original files may be downloaded.
    pub download: bool,
    pub created_at: i64,
}

const SHARE_COLS: &str = "folder_id, token, download, created_at";

fn row_to_share(r: &rusqlite::Row) -> DbResult<Share> {
    Ok(Share { folder_id: r.get(0)?, token: r.get(1)?, download: r.get(2)?, created_at: r.get(3)? })
}

/// Every shared folder, oldest first.
pub fn list(conn: &Connection) -> DbResult<Vec<Share>> {
    let mut stmt = conn.prepare(&format!("SELECT {SHARE_COLS} FROM shares ORDER BY created_at, folder_id"))?;
    let rows = stmt.query_map([], row_to_share)?;
    rows.collect()
}

fn by_token(conn: &Connection, token: &str) -> DbResult<Option<Share>> {
    conn.query_row(&format!("SELECT {SHARE_COLS} FROM shares WHERE token = ?1"), [token], row_to_share)
        .optional()
}

/// Shares the folder (as it is, if it already is).
pub fn start(conn: &Connection, folder_id: &str) -> DbResult<Share> {
    conn.execute(
        "INSERT OR IGNORE INTO shares (folder_id, token, created_at) VALUES (?1, ?2, ?3)",
        params![folder_id, new_token(), db::now_ms()],
    )?;
    conn.query_row(&format!("SELECT {SHARE_COLS} FROM shares WHERE folder_id = ?1"), [folder_id], row_to_share)
}

pub fn stop(conn: &Connection, folder_id: &str) -> DbResult<()> {
    conn.execute("DELETE FROM shares WHERE folder_id = ?1", [folder_id])?;
    Ok(())
}

pub fn stop_all(conn: &Connection) -> DbResult<()> {
    conn.execute("DELETE FROM shares", [])?;
    Ok(())
}

pub fn set_download(conn: &Connection, folder_id: &str, on: bool) -> DbResult<()> {
    conn.execute("UPDATE shares SET download = ?2 WHERE folder_id = ?1", params![folder_id, on])?;
    Ok(())
}

/// 122 random bits, short enough for a QR code a phone reads at a glance.
fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// The URL of a share at `host` (an address or name of this PC).
pub fn url(host: &str, port: u16, token: &str) -> String {
    format!("http://{host}:{port}/s/{token}/")
}

/// Where other devices can reach this PC, the likeliest first: the address
/// of the network the PC goes out on, other private networks, then any other
/// address (VPN). On macOS, the PC's `.local` name as well, which stays the
/// same when the address changes (other Apple devices find it).
pub fn lan_hosts() -> Vec<String> {
    let usable = |ip: &Ipv4Addr| !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified();
    let mut ips: Vec<Ipv4Addr> = Vec::new();
    // No packet is sent: connecting a UDP socket only picks the route.
    if let Some(std::net::IpAddr::V4(ip)) = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .and_then(|s| s.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).map(|_| s))
        .and_then(|s| s.local_addr())
        .ok()
        .map(|a| a.ip())
    {
        if usable(&ip) {
            ips.push(ip);
        }
    }
    let mut others: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.ip() {
            std::net::IpAddr::V4(ip) if usable(&ip) => Some(ip),
            _ => None,
        })
        .collect();
    others.sort_by_key(|ip| !ip.is_private());
    for ip in others {
        if !ips.contains(&ip) {
            ips.push(ip);
        }
    }
    ips.iter().map(Ipv4Addr::to_string).chain(local_name()).collect()
}

/// The PC's `.local` name (macOS).
fn local_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("scutil").args(["--get", "LocalHostName"]).output() {
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !name.is_empty() {
            return Some(format!("{name}.local"));
        }
    }
    None
}

/// A QR code of `text` as an SVG image (black on white, with a margin).
pub fn qr_svg(text: &str) -> Result<String, String> {
    let code = qrcode::QrCode::with_error_correction_level(text, qrcode::EcLevel::M).map_err(|e| e.to_string())?;
    Ok(code.render::<qrcode::render::svg::Color>().min_dimensions(160, 160).quiet_zone(true).build())
}

// --------------------------------------------------------------- server

/// What the server needs from the app (a trait so tests can run without Tauri).
pub trait Host: Send + Sync + 'static {
    fn library(&self) -> &Mutex<Option<Library>>;
}

pub struct Server {
    listener: Listener,
}

impl Server {
    /// Starts listening on `ip:port` (0 = any free port, for tests).
    pub fn start(ip: Ipv4Addr, port: u16, host: Arc<dyn Host>) -> Result<Self, String> {
        let listener = Listener::start_on(ip, port, move |req, _| serve(req, &*host))?;
        Ok(Self { listener })
    }

    pub fn port(&self) -> u16 {
        self.listener.port()
    }
}

enum Body {
    Text(String),
    File(std::fs::File),
}

struct Reply {
    status: u16,
    content_type: &'static str,
    body: Body,
    headers: Vec<(&'static str, String)>,
}

impl Reply {
    fn new(status: u16, content_type: &'static str, body: Body) -> Self {
        Self { status, content_type, body, headers: vec![] }
    }

    fn json(status: u16, value: Value) -> Self {
        Self::new(status, "application/json; charset=utf-8", Body::Text(value.to_string()))
    }

    fn header(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }
}

/// The page's own code only: no other site's scripts, nothing sent elsewhere.
const PAGE_CSP: &str = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; \
     script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/// Files opened on their own (an SVG can carry a script): nothing runs.
const FILE_CSP: &str = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

fn not_found() -> Reply {
    Reply::new(404, "text/html; charset=utf-8", Body::Text(NOT_FOUND_PAGE.into()))
        .header("Content-Security-Policy", PAGE_CSP)
        .header("Cache-Control", "no-store")
}

const NOT_FOUND_PAGE: &str = r#"<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Stockroom</title>
<style>body{font-family:system-ui,sans-serif;background:#18181b;color:#e4e4e7;display:grid;place-items:center;
min-height:100vh;margin:0;padding:16px;box-sizing:border-box;text-align:center}p{color:#a1a1aa;font-size:14px}</style>
</head><body><div><h1 style="font-size:18px">この共有は見つかりません</h1>
<p>共有が停止されたか、URL が違います。<br>共有したパソコンで Stockroom が開いているかも確かめてください。</p></div></body></html>"#;

fn api_error(status: u16, message: &str) -> Reply {
    Reply::json(status, json!({ "error": message })).header("Cache-Control", "no-store")
}

fn serve(req: tiny_http::Request, host: &dyn Host) {
    let reply = match req.method() {
        // tiny_http leaves the body out for HEAD by itself.
        tiny_http::Method::Get | tiny_http::Method::Head => handle(req.url(), host),
        _ => api_error(405, "このメソッドは使えません"),
    };
    respond(req, reply);
}

fn respond(req: tiny_http::Request, reply: Reply) {
    let mut headers = vec![
        ("Content-Type", reply.content_type.to_string()),
        ("X-Content-Type-Options", "nosniff".into()),
        // The secret is in the URL: never handed to another site.
        ("Referrer-Policy", "no-referrer".into()),
        ("X-Robots-Tag", "noindex, nofollow".into()),
    ];
    headers.extend(reply.headers.into_iter().map(|(k, v)| (k, v)));
    let headers: Vec<tiny_http::Header> =
        headers.into_iter().filter_map(|(k, v)| tiny_http::Header::from_bytes(k, v).ok()).collect();
    let _ = match reply.body {
        Body::Text(s) => {
            let mut r = tiny_http::Response::from_string(s).with_status_code(reply.status);
            for h in headers {
                r.add_header(h);
            }
            req.respond(r)
        }
        Body::File(f) => {
            let mut r = tiny_http::Response::from_file(f).with_status_code(reply.status);
            for h in headers {
                r.add_header(h);
            }
            req.respond(r)
        }
    };
}

fn handle(url: &str, host: &dyn Host) -> Reply {
    let (path, query) = url.split_once('?').unwrap_or((url, ""));
    let Some(rest) = path.strip_prefix("/s/") else { return not_found() };
    let (token, rest) = match rest.split_once('/') {
        Some((t, r)) => (t, Some(r)),
        None => (rest, None),
    };
    if token.is_empty() || !token.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return not_found();
    }
    // Without the slash the page's relative links would miss the token.
    let Some(rest) = rest else {
        return Reply::new(301, "text/plain; charset=utf-8", Body::Text(String::new()))
            .header("Location", format!("/s/{token}/"));
    };
    // Files are opened while the library is held and sent after letting go.
    let guard = host.library().lock().unwrap_or_else(|e| e.into_inner());
    let Some(lib) = guard.as_ref() else { return not_found() };
    let scope = match Scope::of(&lib.conn, token) {
        Ok(Some(s)) => s,
        Ok(None) => return if rest.starts_with("api/") { api_error(404, "この共有は見つかりません") } else { not_found() },
        Err(e) => return api_error(500, &e.to_string()),
    };
    let result = match rest.split_once('/') {
        None if rest.is_empty() => Ok(page()),
        None if rest == "api" => Ok(api_error(404, "見つかりません")),
        Some(("api", "folder")) => folder(lib, &scope, query_param(query, "id").as_deref()),
        Some(("thumb", id)) => thumb(lib, &scope, id),
        Some(("view", id)) => view(lib, &scope, id),
        Some(("file", id)) => file(lib, &scope, id),
        _ => Ok(not_found()),
    };
    result.unwrap_or_else(|e| api_error(500, &e.to_string()))
}

fn page() -> Reply {
    Reply::new(200, "text/html; charset=utf-8", Body::Text(PAGE.into()))
        .header("Content-Security-Policy", PAGE_CSP)
        .header("Cache-Control", "no-store")
}

/// What one share can reach: the shared folder and everything under it.
struct Scope {
    share: Share,
    /// Every folder of the library, in sidebar order.
    folders: Vec<Folder>,
    /// The shared folder and its subfolders, at any depth.
    inside: HashSet<String>,
}

impl Scope {
    fn of(conn: &Connection, token: &str) -> DbResult<Option<Self>> {
        let Some(share) = by_token(conn, token)? else { return Ok(None) };
        let folders = db::list_folders(conn, None)?;
        let mut inside = HashSet::from([share.folder_id.clone()]);
        // Parents may come after their children in sidebar order: repeat until nothing is added.
        loop {
            let before = inside.len();
            for f in &folders {
                if f.parent_id.as_ref().is_some_and(|p| inside.contains(p)) {
                    inside.insert(f.id.clone());
                }
            }
            if inside.len() == before {
                break;
            }
        }
        Ok(Some(Self { share, folders, inside }))
    }

    fn folder(&self, id: &str) -> Option<&Folder> {
        self.folders.iter().find(|f| f.id == id).filter(|f| self.inside.contains(&f.id))
    }

    /// Live items in the folder and all its subfolders.
    fn total(&self, id: &str) -> i64 {
        let own = self.folders.iter().find(|f| f.id == id).map_or(0, |f| f.count);
        own + self.folders.iter().filter(|f| f.parent_id.as_deref() == Some(id)).map(|f| self.total(&f.id)).sum::<i64>()
    }

    /// An item, if it is in the shared folder or under it (not in the trash).
    fn item(&self, conn: &Connection, id: &str) -> DbResult<Option<Item>> {
        let item = db::get_items(conn, &[id.to_string()])?.pop();
        Ok(item.filter(|it| it.deleted_at.is_none() && it.folder_id.as_ref().is_some_and(|f| self.inside.contains(f))))
    }
}

fn folder(lib: &Library, scope: &Scope, id: Option<&str>) -> DbResult<Reply> {
    let id = id.unwrap_or(&scope.share.folder_id);
    let (Some(current), Some(root)) = (scope.folder(id), scope.folder(&scope.share.folder_id)) else {
        return Ok(api_error(404, "このフォルダは見つかりません"));
    };
    // From the shared folder down to this one (never above the shared folder).
    let mut path = vec![current];
    while path.last().unwrap().id != root.id {
        match path.last().unwrap().parent_id.as_deref().and_then(|p| scope.folder(p)) {
            Some(parent) => path.push(parent),
            None => break,
        }
    }
    path.reverse();
    let folders: Vec<Value> = scope
        .folders
        .iter()
        .filter(|f| f.parent_id.as_deref() == Some(&current.id))
        .map(|f| json!({ "id": f.id, "name": f.name, "count": scope.total(&f.id) }))
        .collect();
    let query = ItemQuery { view: View::Folder { id: current.id.clone() }, sort: SortKey::Manual, ..Default::default() };
    let items: Vec<Value> = db::query_items(&lib.conn, &query)?
        .into_iter()
        .map(|it| {
            json!({
                "id": it.id,
                "name": it.name,
                "kind": it.kind,
                "ext": it.ext,
                "width": it.width,
                "height": it.height,
                "size": it.size,
                "rotation": it.rotation,
                "flipped": it.flipped,
                // The thumbnail's file changes when the item is turned: a new URL, not a cached old one.
                "thumb": format!("thumb/{}?v={}", it.id, pct_encode(&it.thumb)),
                "view": (it.kind == Kind::Image).then(|| format!("view/{}", it.id)),
            })
        })
        .collect();
    Ok(Reply::json(
        200,
        json!({
            "title": root.name,
            "download": scope.share.download,
            "path": path.iter().map(|f| json!({ "id": f.id, "name": f.name })).collect::<Vec<_>>(),
            "folders": folders,
            "items": items,
        }),
    )
    .header("Cache-Control", "no-store"))
}

/// Sends a file of the library, if it is there.
fn send(path: &std::path::Path, content_type: &'static str) -> Reply {
    match std::fs::File::open(path) {
        Ok(f) => Reply::new(200, content_type, Body::File(f))
            .header("Content-Security-Policy", FILE_CSP)
            .header("Cache-Control", "private, max-age=86400"),
        Err(_) => api_error(404, "ファイルが見つかりません"),
    }
}

fn thumb(lib: &Library, scope: &Scope, id: &str) -> DbResult<Reply> {
    let Some(item) = scope.item(&lib.conn, id)? else { return Ok(api_error(404, "見つかりません")) };
    let path = library::thumb_path(&lib.root, &item);
    Ok(send(&path, content_type(&extension(&path))))
}

fn view(lib: &Library, scope: &Scope, id: &str) -> DbResult<Reply> {
    let Some(item) = scope.item(&lib.conn, id)?.filter(|it| it.kind == Kind::Image) else {
        return Ok(api_error(404, "見つかりません"));
    };
    let path = library::display_path(&lib.root, &item);
    Ok(send(&path, content_type(&extension(&path))))
}

fn file(lib: &Library, scope: &Scope, id: &str) -> DbResult<Reply> {
    if !scope.share.download {
        return Ok(api_error(403, "この共有ではダウンロードできません"));
    }
    let Some(item) = scope.item(&lib.conn, id)? else { return Ok(api_error(404, "見つかりません")) };
    let name = download_name(&item.name, &item.ext);
    Ok(send(&library::file_path(&lib.root, &item), content_type(&item.ext)).header(
        "Content-Disposition",
        format!("attachment; filename=\"{}\"; filename*=UTF-8''{}", ascii_name(&name), pct_encode(&name)),
    ))
}

fn extension(path: &std::path::Path) -> String {
    path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

fn content_type(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "heic" | "heif" => "image/heic",
        "tif" | "tiff" => "image/tiff",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttc" | "otc" => "font/collection",
        _ => "application/octet-stream",
    }
}

/// The display name with the file's extension (as the app's export names files).
fn download_name(name: &str, ext: &str) -> String {
    let has_ext = std::path::Path::new(name).extension().is_some_and(|e| e.eq_ignore_ascii_case(ext));
    let name: String =
        name.chars().map(|c| if c.is_control() || matches!(c, '/' | '\\') { '_' } else { c }).collect();
    if has_ext || ext.is_empty() {
        name
    } else {
        format!("{name}.{ext}")
    }
}

/// For browsers that only read `filename=`: ASCII, without quotes.
fn ascii_name(name: &str) -> String {
    name.chars().map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' { c } else { '_' }).collect()
}

fn pct_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn query_param(query: &str, key: &str) -> Option<String> {
    crate::webimport::parse_query(query).into_iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::NewItem;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    struct TestHost(Mutex<Option<Library>>);

    impl Host for TestHost {
        fn library(&self) -> &Mutex<Option<Library>> {
            &self.0
        }
    }

    /// An image item filed in `folder` (thumbnail "t-<id>", file "f-<id>").
    fn add(lib: &mut Library, id: &str, folder: &str) {
        library::store_file(&lib.root, id, "a.png", format!("f-{id}").as_bytes()).unwrap();
        std::fs::write(lib.root.join("thumbs").join(format!("{id}.jpg")), format!("t-{id}")).unwrap();
        let tx = lib.conn.transaction().unwrap();
        let it = NewItem {
            id: id.into(),
            kind: Kind::Image,
            name: format!("写真 {id}"),
            file_name: "a.png".into(),
            ext: "png".into(),
            width: 10,
            height: 20,
            size: 5,
            hash: id.into(),
            thumb: format!("{id}.jpg"),
            phash: None,
            preview: None,
            font: None,
            body: None,
            duration_ms: None,
        };
        db::insert_item(&tx, &it, 1).unwrap();
        tx.commit().unwrap();
        db::move_to_folder(&lib.conn, &[id.to_string()], folder).unwrap();
    }

    struct Setup {
        _tmp: tempfile::TempDir,
        host: Arc<TestHost>,
        server: Server,
        token: String,
        /// 親 > 共有 > 下、親 > 隣
        shared: String,
        sub: String,
        parent: String,
    }

    fn setup() -> Setup {
        let tmp = tempfile::tempdir().unwrap();
        let mut lib = Library::create(&tmp.path().join("Share.library")).unwrap();
        let parent = db::create_folder(&lib.conn, "親", None, db::Mode::Stock).unwrap();
        let shared = db::create_folder(&lib.conn, "共有", Some(&parent), db::Mode::Stock).unwrap();
        let sub = db::create_folder(&lib.conn, "下", Some(&shared), db::Mode::Stock).unwrap();
        let beside = db::create_folder(&lib.conn, "隣", Some(&parent), db::Mode::Stock).unwrap();
        add(&mut lib, "in", &shared);
        add(&mut lib, "deep", &sub);
        add(&mut lib, "up", &parent);
        add(&mut lib, "side", &beside);
        add(&mut lib, "gone", &shared);
        db::trash_items(&lib.conn, &["gone".to_string()]).unwrap();
        let token = start(&lib.conn, &shared).unwrap().token;
        let host = Arc::new(TestHost(Mutex::new(Some(lib))));
        let server = Server::start(Ipv4Addr::LOCALHOST, 0, host.clone()).unwrap();
        Setup { _tmp: tmp, host, server, token, shared, sub, parent }
    }

    /// Sends a raw HTTP/1.1 request; returns the status, the headers (lower-case names) and the body.
    fn call(port: u16, method: &str, path: &str) -> (u16, Vec<(String, String)>, Vec<u8>) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "{method} {path} HTTP/1.1\r\nHost: 192.168.1.2:{port}\r\nConnection: close\r\n\r\n").unwrap();
        let mut out = Vec::new();
        s.read_to_end(&mut out).unwrap();
        let split = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&out[..split]).into_owned();
        let mut lines = head.split("\r\n");
        let status = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
        let headers = lines
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
            .collect();
        (status, headers, out[split + 4..].to_vec())
    }

    fn get_json(port: u16, path: &str) -> (u16, Value) {
        let (status, _, body) = call(port, "GET", path);
        (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
    }

    fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
        headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    fn names(v: &Value, key: &str) -> Vec<String> {
        v[key].as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn shows_the_folder_and_its_subfolders_only() {
        let s = setup();
        let port = s.server.port();
        let t = &s.token;

        let (status, root) = get_json(port, &format!("/s/{t}/api/folder"));
        assert_eq!(status, 200);
        assert_eq!(root["title"], "共有");
        assert_eq!(names(&root, "path"), ["共有"]); // not 親
        assert_eq!(names(&root, "folders"), ["下"]);
        assert_eq!(root["folders"][0]["count"], 1);
        // The trashed one is left out; no notes or tags are handed out.
        assert_eq!(names(&root, "items"), ["写真 in"]);
        assert!(root["items"][0].get("note").is_none() && root["items"][0].get("tagIds").is_none());

        let (status, sub) = get_json(port, &format!("/s/{t}/api/folder?id={}", s.sub));
        assert_eq!(status, 200);
        assert_eq!(names(&sub, "path"), ["共有", "下"]);
        assert_eq!(names(&sub, "items"), ["写真 deep"]);

        // Above and beside the shared folder: not there.
        let (status, _) = get_json(port, &format!("/s/{t}/api/folder?id={}", s.parent));
        assert_eq!(status, 404);
        let side = db::list_folders(&s.host.0.lock().unwrap().as_ref().unwrap().conn, None)
            .unwrap()
            .into_iter()
            .find(|f| f.name == "隣")
            .unwrap();
        assert_eq!(get_json(port, &format!("/s/{t}/api/folder?id={}", side.id)).0, 404);
    }

    #[test]
    fn hands_out_files_inside_only() {
        let s = setup();
        let port = s.server.port();
        let t = &s.token;

        let (status, headers, body) = call(port, "GET", &format!("/s/{t}/thumb/in?v=in.jpg"));
        assert_eq!((status, body.as_slice()), (200, b"t-in".as_slice()));
        assert_eq!(header(&headers, "content-type"), Some("image/jpeg"));
        assert!(header(&headers, "content-security-policy").unwrap().contains("sandbox"));
        assert_eq!(call(port, "GET", &format!("/s/{t}/view/deep")).2, b"f-deep");

        for id in ["up", "side", "gone", "nope"] {
            for what in ["thumb", "view", "file"] {
                assert_eq!(call(port, "GET", &format!("/s/{t}/{what}/{id}")).0, 404, "{what}/{id}");
            }
        }
    }

    #[test]
    fn downloads_with_the_display_name_when_allowed() {
        let s = setup();
        let port = s.server.port();
        let t = &s.token;

        let (status, headers, body) = call(port, "GET", &format!("/s/{t}/file/in"));
        assert_eq!((status, body.as_slice()), (200, b"f-in".as_slice()));
        let disposition = header(&headers, "content-disposition").unwrap();
        assert!(disposition.starts_with("attachment;"), "{disposition}");
        assert!(disposition.contains("filename*=UTF-8''%E5%86%99%E7%9C%9F%20in.png"), "{disposition}");

        set_download(&s.host.0.lock().unwrap().as_ref().unwrap().conn, &s.shared, false).unwrap();
        assert_eq!(call(port, "GET", &format!("/s/{t}/file/in")).0, 403);
        let (_, root) = get_json(port, &format!("/s/{t}/api/folder"));
        assert_eq!(root["download"], false);
        // Looking is still allowed.
        assert_eq!(call(port, "GET", &format!("/s/{t}/view/in")).0, 200);
    }

    #[test]
    fn the_url_stops_working_when_the_share_stops() {
        let s = setup();
        let port = s.server.port();
        let t = &s.token;

        let (status, headers, page) = call(port, "GET", &format!("/s/{t}/"));
        assert_eq!(status, 200);
        assert!(String::from_utf8_lossy(&page).contains("<title>Stockroom</title>"));
        assert_eq!(header(&headers, "referrer-policy"), Some("no-referrer"));
        assert_eq!(header(&headers, "cache-control"), Some("no-store"));

        // Without the slash: sent to the page with it.
        let (status, headers, _) = call(port, "GET", &format!("/s/{t}"));
        assert_eq!((status, header(&headers, "location")), (301, Some(format!("/s/{t}/").as_str())));

        assert_eq!(call(port, "GET", "/s/0123456789abcdef0123456789abcdef/").0, 404);
        assert_eq!(call(port, "GET", "/").0, 404);
        assert_eq!(call(port, "GET", "/s/../library.db").0, 404);
        assert_eq!(call(port, "POST", &format!("/s/{t}/api/folder")).0, 405);

        stop(&s.host.0.lock().unwrap().as_ref().unwrap().conn, &s.shared).unwrap();
        assert_eq!(call(port, "GET", &format!("/s/{t}/")).0, 404);
        assert_eq!(get_json(port, &format!("/s/{t}/api/folder")).0, 404);
        assert_eq!(call(port, "GET", &format!("/s/{t}/thumb/in")).0, 404);
    }

    #[test]
    fn a_share_goes_with_its_folder() {
        let s = setup();
        let guard = s.host.0.lock().unwrap();
        let conn = &guard.as_ref().unwrap().conn;
        // Sharing again keeps the URL.
        assert_eq!(start(conn, &s.shared).unwrap().token, s.token);
        assert!(db::list_folders(conn, None).unwrap().iter().any(|f| f.id == s.shared && f.shared));
        db::delete_folder(conn, &s.parent).unwrap();
        assert!(list(conn).unwrap().is_empty());
        // A folder that isn't there can't be shared.
        assert!(start(conn, "nope").is_err());
    }

    #[test]
    fn names_and_codes() {
        assert_eq!(download_name("写真", "png"), "写真.png");
        assert_eq!(download_name("photo.PNG", "png"), "photo.PNG");
        assert_eq!(download_name("a/b\nc", "jpg"), "a_b_c.jpg");
        assert_eq!(ascii_name("写真 \"x\".png"), "__ _x_.png");
        assert_eq!(query_param("a=1&id=x%2Fy", "id").as_deref(), Some("x/y"));
        assert_eq!(url("192.168.1.2", PORT, "abc"), "http://192.168.1.2:41640/s/abc/");
        assert!(qr_svg(&url("192.168.1.2", PORT, &new_token())).unwrap().starts_with("<?xml"));
        assert!(lan_hosts().iter().all(|h| h != "127.0.0.1"));
    }
}

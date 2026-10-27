//! Saving from the browser: a small HTTP server on 127.0.0.1 that the Chrome
//! extension in `extension/` talks to. It runs only while the app is open and
//! the user has turned it on.
//!
//! - Listens on the loopback interface only, on a fixed port the extension knows.
//! - Every request must carry `Authorization: Bearer <token>`; the token is
//!   made by the app. The copy of the extension the app writes out gets it in
//!   its `config.json`; any other copy asks for it with `POST /pair`, which
//!   the user approves in the app (wherever the extension was installed from).
//! - Requests from web pages are refused: an `Origin` other than an extension's,
//!   or a `Host` other than 127.0.0.1 / localhost (DNS rebinding).
//!
//! The extension downloads images itself (with the browser's cookies and
//! proxy settings) and sends the bytes, so the app never fetches URLs.
//!
//!   POST /pair?code=1234   (no token) asks the user to connect this extension;
//!                  answers { token } once approved. The code is shown in
//!                  both places so the user can tell it's the same request.
//!                  Another app on this machine (Feedability) asks the same
//!                  way with no `Origin` and `X-Stockroom-Client: <its name>`
//!                  (docs/FROM_APPS.md); a browser always sends `Origin` with
//!                  a POST, so a page can't pass for one.
//!   GET  /info     app version and the open library's name
//!   GET  /folders  [{ id, name, parentId }] in sidebar order
//!   GET  /tags     tag names
//!   POST /import?name=&folder=&tag=&tag=&page=   body = the file
//!   POST /bookmark   body = JSON { url, title, description, favicon, image, folder, tags }:
//!                  keeps a page as a bookmark (docs/BOOKMARKS.md). `favicon` and
//!                  `image` (the eyecatch) are `data:image/…;base64,…` the extension
//!                  made from the page; all but `url` may be left out

use crate::db;
use crate::formats;
use crate::import::{self, ImportSummary, Source};
use crate::library::Library;
use crate::loopback::{self, Listener};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::Read;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const PORT: u16 = 41620;
const MAX_BODY: u64 = 300 * 1024 * 1024;
/// A bookmark's JSON: the address and text, and two small pictures.
const MAX_BOOKMARK_BODY: u64 = 16 * 1024 * 1024;

/// What the server needs from the app (a trait so tests can run without Tauri).
pub trait Host: Send + Sync + 'static {
    fn library(&self) -> &Mutex<Option<Library>>;
    /// Called after every import that went through, to refresh the UI.
    fn imported(&self, summary: &ImportSummary);
    /// Asks the user whether to connect `peer` showing `code`. Blocks until
    /// they answer (false if they don't in time).
    fn approve_pairing(&self, code: &str, peer: &Peer) -> bool;
}

/// Who asks to connect.
#[derive(Debug, Clone, PartialEq)]
pub enum Peer {
    /// A browser extension, by its id (chrome://extensions shows it).
    Extension(String),
    /// Another app on this machine, by the name it gives itself.
    App(String),
}

impl Peer {
    /// The key a refusal is remembered by.
    fn key(&self) -> String {
        match self {
            Peer::Extension(id) => format!("extension:{id}"),
            Peer::App(name) => format!("app:{name}"),
        }
    }
}

/// An app's name as it is shown: control characters dropped, at most 40
/// characters. It is what the app calls itself, nothing more.
fn app_name(header: &str) -> Option<String> {
    let name: String = header.chars().filter(|c| !c.is_control()).take(40).collect();
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// What the request threads share.
struct Shared {
    token: String,
    /// A pairing question is open in the app (one at a time).
    pairing: AtomicBool,
    /// Who asked (`Peer::key`) -> when it may ask again after being refused: asking
    /// brings the app to the front, so it mustn't be repeated at will.
    refused: Mutex<HashMap<String, Instant>>,
    /// One import body read at a time: each can be 300 MB, and imports run
    /// one after another anyway (import.rs `RUN_LOCK`).
    importing: Mutex<()>,
}

/// How long a refused extension or app waits before it may ask again.
const REFUSED_WAIT: Duration = Duration::from_secs(30);

pub struct Server {
    listener: Listener,
}

impl Server {
    /// Starts listening on `127.0.0.1:port` (0 = any free port, for tests).
    pub fn start(port: u16, token: String, host: Arc<dyn Host>) -> Result<Self, String> {
        let shared = Arc::new(Shared {
            token,
            pairing: AtomicBool::new(false),
            refused: Mutex::new(HashMap::new()),
            importing: Mutex::new(()),
        });
        let listener = Listener::start(port, move |req, port| serve(req, port, &shared, &*host))?;
        Ok(Self { listener })
    }

    pub fn port(&self) -> u16 {
        self.listener.port()
    }
}

fn serve(mut req: tiny_http::Request, port: u16, shared: &Shared, host: &dyn Host) {
    let head = Head {
        method: req.method().as_str().to_ascii_uppercase(),
        url: req.url().to_string(),
        host: loopback::header(&req, "Host"),
        origin: loopback::header(&req, "Origin"),
        client: loopback::header(&req, "X-Stockroom-Client"),
        auth: loopback::header(&req, "Authorization"),
        length: req.body_length().map(|n| n as u64),
    };
    let (status, body) = handle(&head, req.as_reader(), port, shared, host);
    let response = tiny_http::Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(tiny_http::Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap())
        .with_header(tiny_http::Header::from_bytes("Cache-Control", "no-store").unwrap());
    let _ = req.respond(response);
}

struct Head {
    method: String,
    url: String,
    host: Option<String>,
    origin: Option<String>,
    /// `X-Stockroom-Client`: the name another app asks to connect under.
    client: Option<String>,
    auth: Option<String>,
    length: Option<u64>,
}

fn error(status: u16, message: &str) -> (u16, Value) {
    (status, json!({ "error": message }))
}

const NOT_CONNECTED: &str =
    "この拡張機能はアプリと接続されていません。拡張機能のアイコン →「アプリと接続」を押してください";

fn handle(head: &Head, body: &mut dyn Read, port: u16, shared: &Shared, host: &dyn Host) -> (u16, Value) {
    if !loopback::is_own_host(head.host.as_deref(), port) {
        return error(403, "許可されていない接続です");
    }
    if head.origin.as_ref().is_some_and(|o| !o.starts_with("chrome-extension://")) {
        return error(403, "ブラウザ拡張以外からの接続は受け付けません");
    }
    let token = shared.token.as_str();
    let (path, query) = head.url.split_once('?').unwrap_or((&head.url, ""));
    let params = parse_query(query);

    if path == "/pair" {
        if head.method != "POST" {
            return error(405, "このメソッドは使えません");
        }
        // An extension (by its Origin), or an app that names itself and sends
        // no Origin. A page always sends one, and it isn't an extension's
        // (refused above).
        let peer = match (head.origin.as_deref(), head.client.as_deref()) {
            (Some(o), _) => match o.strip_prefix("chrome-extension://") {
                Some(id) => Peer::Extension(id.to_string()),
                None => return error(403, "ブラウザ拡張以外からの接続は受け付けません"),
            },
            (None, Some(c)) => match app_name(c) {
                Some(name) => Peer::App(name),
                None => return error(400, "アプリの名前がありません"),
            },
            (None, None) => return error(403, "ブラウザ拡張以外からの接続は受け付けません"),
        };
        let key = peer.key();
        let code = params.iter().find(|(k, _)| k == "code").map(|(_, v)| v.as_str()).unwrap_or("");
        if code.len() != 4 || !code.bytes().all(|b| b.is_ascii_digit()) {
            return error(400, "確認用の番号がありません");
        }
        if shared.refused.lock().unwrap().get(&key).is_some_and(|until| Instant::now() < *until) {
            return error(429, "アプリで接続が許可されませんでした。しばらく待ってから、もう一度試してください");
        }
        if shared.pairing.swap(true, Ordering::SeqCst) {
            return error(409, "アプリで別の接続を確認中です。そちらに答えてから、もう一度試してください");
        }
        let approved = host.approve_pairing(code, &peer);
        shared.pairing.store(false, Ordering::SeqCst);
        if !approved {
            let mut refused = shared.refused.lock().unwrap();
            refused.retain(|_, until| Instant::now() < *until);
            refused.insert(key, Instant::now() + REFUSED_WAIT);
        }
        return if approved {
            (200, json!({ "token": token }))
        } else {
            error(403, "アプリで接続が許可されませんでした")
        };
    }

    if !loopback::has_token(head.auth.as_deref(), token) {
        return error(401, NOT_CONNECTED);
    }
    let param = |k: &str| params.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str()).filter(|v| !v.is_empty());

    let lib = host.library();
    let with_lib = |f: &dyn Fn(&mut Library) -> Result<Value, String>| -> (u16, Value) {
        let mut guard = lib.lock().unwrap();
        match guard.as_mut() {
            None => error(503, "アプリでライブラリが開かれていません"),
            Some(l) => match f(l) {
                Ok(v) => (200, v),
                Err(e) => error(500, &e),
            },
        }
    };

    match (head.method.as_str(), path) {
        ("GET", "/info") => {
            let name = lib.lock().unwrap().as_ref().map(|l| {
                l.root.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
            });
            (200, json!({ "app": "stockroom", "version": env!("CARGO_PKG_VERSION"), "library": name }))
        }
        ("GET", "/folders") => with_lib(&|l| {
            #[derive(Serialize)]
            #[serde(rename_all = "camelCase")]
            struct F {
                id: String,
                name: String,
                parent_id: Option<String>,
            }
            // What the extension saves is images and files: the stock's folders and tags (docs/MODES.md).
            let folders = db::list_folders(&l.conn, Some(db::Mode::Stock)).map_err(|e| e.to_string())?;
            let out: Vec<F> = folders
                .into_iter()
                .map(|f| F { id: f.id, name: f.name, parent_id: f.parent_id })
                .collect();
            Ok(json!(out))
        }),
        ("GET", "/tags") => with_lib(&|l| {
            let tags = db::list_tags(&l.conn, Some(db::Mode::Stock)).map_err(|e| e.to_string())?;
            Ok(json!(tags.into_iter().map(|t| t.name).collect::<Vec<_>>()))
        }),
        ("POST", "/import") => {
            if head.length.is_some_and(|n| n > MAX_BODY) {
                return error(413, "ファイルが大きすぎます");
            }
            let _one = shared.importing.lock().unwrap_or_else(|e| e.into_inner());
            let mut data = Vec::new();
            if let Err(e) = body.take(MAX_BODY + 1).read_to_end(&mut data) {
                return error(400, &e.to_string());
            }
            if data.len() as u64 > MAX_BODY {
                return error(413, "ファイルが大きすぎます");
            }
            if data.is_empty() {
                return error(400, "データが空です");
            }
            let tags: Vec<String> = params
                .iter()
                .filter(|(k, v)| k == "tag" && !v.trim().is_empty())
                .map(|(_, v)| v.trim().to_string())
                .collect();
            import_one(
                host,
                param("name").unwrap_or("image"),
                data,
                param("folder"),
                &tags,
                param("page").filter(|p| p.starts_with("http://") || p.starts_with("https://")),
            )
        }
        ("POST", "/bookmark") => {
            if head.length.is_some_and(|n| n > MAX_BOOKMARK_BODY) {
                return error(413, "データが大きすぎます");
            }
            let _one = shared.importing.lock().unwrap_or_else(|e| e.into_inner());
            let mut data = Vec::new();
            if let Err(e) = body.take(MAX_BOOKMARK_BODY + 1).read_to_end(&mut data) {
                return error(400, &e.to_string());
            }
            if data.len() as u64 > MAX_BOOKMARK_BODY {
                return error(413, "データが大きすぎます");
            }
            bookmark_one(host, &data)
        }
        (_, "/info" | "/folders" | "/tags" | "/import" | "/bookmark") => error(405, "このメソッドは使えません"),
        _ => error(404, "見つかりません"),
    }
}

fn import_one(
    host: &dyn Host,
    name: &str,
    data: Vec<u8>,
    folder: Option<&str>,
    tags: &[String],
    page: Option<&str>,
) -> (u16, Value) {
    let lib = host.library();
    if let Some(f) = folder {
        let guard = lib.lock().unwrap();
        let Some(l) = guard.as_ref() else { return error(503, "アプリでライブラリが開かれていません") };
        match db::list_folders(&l.conn, None) {
            Ok(all) if all.iter().any(|x| x.id == f) => {}
            Ok(_) => return error(400, "保存先のフォルダが見つかりません。拡張機能で選び直してください"),
            Err(e) => return error(500, &e.to_string()),
        }
    }
    let name = formats::name_for_content(name, &data);
    let summary = match import::run(lib, vec![Source::Bytes { name, data }], folder.map(str::to_owned), |_, _| {}) {
        Ok(s) => s,
        Err(e) => return error(503, &e),
    };
    if summary.ids.is_empty() {
        let reason = summary.failed.first().map(String::as_str).unwrap_or("読み込めませんでした");
        return error(422, reason);
    }
    {
        let mut guard = lib.lock().unwrap();
        if let Some(l) = guard.as_mut() {
            let result = db::add_tags(&mut l.conn, &summary.ids, tags)
                .and_then(|_| page.map_or(Ok(()), |p| db::set_source_url(&l.conn, &summary.ids, p)));
            if let Err(e) = result {
                host.imported(&summary);
                return error(500, &e.to_string());
            }
        }
    }
    host.imported(&summary);
    (200, json!({ "imported": summary.imported, "duplicates": summary.duplicates, "id": summary.ids[0] }))
}

/// What the extension sends to keep a page as a bookmark.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct BookmarkRequest {
    #[serde(flatten)]
    page: crate::bookmarks::Input,
    folder: Option<String>,
    tags: Vec<String>,
}

fn bookmark_one(host: &dyn Host, data: &[u8]) -> (u16, Value) {
    let Ok(req) = serde_json::from_slice::<BookmarkRequest>(data) else {
        return error(400, "データを読めませんでした");
    };
    let tags: Vec<String> = req.tags.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
    let folder = req.folder.filter(|f| !f.is_empty());
    let added = match crate::bookmarks::add(host.library(), &req.page, folder.as_deref(), &tags) {
        Ok(a) => a,
        Err(e) if e == crate::bookmarks::NO_FOLDER => {
            return error(400, "保存先のフォルダが見つかりません。拡張機能で選び直してください")
        }
        Err(e) if e == crate::bookmarks::NO_LIBRARY => return error(503, "アプリでライブラリが開かれていません"),
        Err(e) => return error(422, &e),
    };
    let summary = ImportSummary {
        imported: usize::from(!added.duplicate),
        duplicates: usize::from(added.duplicate),
        failed: vec![],
        kinds: if added.duplicate { Default::default() } else { [(db::Kind::Bookmark, 1)].into() },
        ids: vec![added.id.clone()],
    };
    host.imported(&summary);
    (200, json!({ "imported": summary.imported, "duplicates": summary.duplicates, "id": added.id }))
}

/// `a=1&b=x%20y` -> [("a", "1"), ("b", "x y")]. `+` is a space (URLSearchParams).
pub(crate) fn parse_query(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|s| !s.is_empty())
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            let dec = |s: &str| crate::commands::percent_decode(&s.replace('+', " "));
            (dec(k), dec(v))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, RgbImage};
    use std::io::{Cursor, Write};
    use std::net::TcpStream;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TestHost {
        lib: Mutex<Option<Library>>,
        imports: AtomicUsize,
        /// Codes the user was asked to approve; "0000" is refused.
        asked: Mutex<Vec<String>>,
    }

    impl Host for TestHost {
        fn library(&self) -> &Mutex<Option<Library>> {
            &self.lib
        }
        fn imported(&self, _: &ImportSummary) {
            self.imports.fetch_add(1, Ordering::Relaxed);
        }
        fn approve_pairing(&self, code: &str, _peer: &Peer) -> bool {
            self.asked.lock().unwrap().push(code.to_string());
            std::thread::sleep(std::time::Duration::from_millis(200)); // the user thinking
            code != "0000"
        }
    }

    const TOKEN: &str = "secret-token";

    fn setup() -> (tempfile::TempDir, Arc<TestHost>, Server) {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::create(&dir.path().join("Web.library")).unwrap();
        let host = Arc::new(TestHost { lib: Mutex::new(Some(lib)), imports: AtomicUsize::new(0), asked: Mutex::new(vec![]) });
        let server = Server::start(0, TOKEN.into(), host.clone()).unwrap();
        (dir, host, server)
    }

    /// Sends a raw HTTP/1.1 request; returns the status and the JSON body.
    fn call(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> (u16, Value) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut req = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
        for (k, v) in headers {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str("\r\n");
        s.write_all(req.as_bytes()).unwrap();
        s.write_all(body).unwrap();
        let mut out = Vec::new();
        s.read_to_end(&mut out).unwrap();
        let text = String::from_utf8_lossy(&out);
        let status = text.split(' ').nth(1).unwrap().parse().unwrap();
        let json = text.split_once("\r\n\r\n").map(|(_, b)| serde_json::from_str(b).unwrap_or(Value::Null)).unwrap();
        (status, json)
    }

    fn png() -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(RgbImage::from_pixel(40, 20, image::Rgb([9, 99, 199]))).write_to(&mut buf, image::ImageFormat::Png).unwrap();
        buf.into_inner()
    }

    #[test]
    fn refuses_web_pages_and_wrong_tokens() {
        let (_tmp, _host, server) = setup();
        let p = server.port();
        let host = format!("127.0.0.1:{p}");
        let auth = format!("Bearer {TOKEN}");
        let ok = [("Host", host.as_str()), ("Authorization", auth.as_str())];
        assert_eq!(call(p, "GET", "/info", &ok, b"").0, 200);
        assert_eq!(call(p, "GET", "/info", &[ok[0]], b"").0, 401, "no token");
        assert_eq!(call(p, "GET", "/info", &[ok[0], ("Authorization", "Bearer secret-tokeX")], b"").0, 401);
        // A page on another site (or a rebinding DNS name) can't reach it even with the token.
        assert_eq!(call(p, "GET", "/info", &[ok[0], ok[1], ("Origin", "https://evil.example")], b"").0, 403);
        assert_eq!(call(p, "GET", "/info", &[("Host", "evil.example"), ok[1]], b"").0, 403);
        let ext = [ok[0], ok[1], ("Origin", "chrome-extension://abcdefghijklmnop")];
        let (status, info) = call(p, "GET", "/info", &ext, b"");
        assert_eq!((status, info["library"].as_str()), (200, Some("Web")));
        let localhost = format!("localhost:{p}");
        assert_eq!(call(p, "GET", "/nope", &[("Host", &localhost), ok[1]], b"").0, 404);
        assert_eq!(call(p, "GET", "/import", &ok, b"").0, 405);
    }

    #[test]
    fn imports_with_folder_tags_and_page() {
        let (_tmp, host, server) = setup();
        let p = server.port();
        let h = format!("127.0.0.1:{p}");
        let auth = format!("Bearer {TOKEN}");
        let hd = [("Host", h.as_str()), ("Authorization", auth.as_str())];
        let folder = {
            let g = host.lib.lock().unwrap();
            db::create_folder(&g.as_ref().unwrap().conn, "Web 保存", None, db::Mode::Stock).unwrap()
        };
        let (status, folders) = call(p, "GET", "/folders", &hd, b"");
        assert_eq!((status, folders[0]["name"].as_str()), (200, Some("Web 保存")));

        // No extension in the name: it comes from the content.
        let path = format!(
            "/import?name=%E5%86%99%E7%9C%9F&folder={folder}&tag=%E5%8F%82%E8%80%83&tag=web+design&page=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1"
        );
        let (status, res) = call(p, "POST", &path, &hd, &png());
        assert_eq!(status, 200, "{res}");
        assert_eq!(res["imported"], 1);
        assert_eq!(host.imports.load(Ordering::Relaxed), 1);

        let (_, tags) = call(p, "GET", "/tags", &hd, b"");
        let mut tags: Vec<&str> = tags.as_array().unwrap().iter().filter_map(Value::as_str).collect();
        tags.sort();
        assert_eq!(tags, ["web design", "参考"]);
        {
            let g = host.lib.lock().unwrap();
            let conn = &g.as_ref().unwrap().conn;
            let it = db::get_items(conn, &[res["id"].as_str().unwrap().to_string()]).unwrap().remove(0);
            assert_eq!((it.name.as_str(), it.ext.as_str(), it.width), ("写真.png", "png", 40));
            assert_eq!(it.folder_id.as_deref(), Some(folder.as_str()));
            assert_eq!(it.tag_ids.len(), 2);
            assert_eq!(it.source_url.as_deref(), Some("https://example.com/a?b=1"));
        }

        // Saving it again from another page: a duplicate, the first page stays,
        // new tags are still added.
        let (status, res2) = call(p, "POST", "/import?name=x.png&tag=again&page=https%3A%2F%2Fother.example%2F", &hd, &png());
        assert_eq!((status, res2["duplicates"].as_u64(), res2["id"].clone()), (200, Some(1), res["id"].clone()));
        let g = host.lib.lock().unwrap();
        let conn = &g.as_ref().unwrap().conn;
        let it = db::get_items(conn, &[res["id"].as_str().unwrap().to_string()]).unwrap().remove(0);
        assert_eq!(it.source_url.as_deref(), Some("https://example.com/a?b=1"));
        assert_eq!(it.tag_ids.len(), 3);
    }

    #[test]
    fn keeps_a_page_as_a_bookmark() {
        let (_tmp, host, server) = setup();
        let p = server.port();
        let h = format!("127.0.0.1:{p}");
        let auth = format!("Bearer {TOKEN}");
        let hd = [("Host", h.as_str()), ("Authorization", auth.as_str())];
        let folder = {
            let g = host.lib.lock().unwrap();
            db::create_folder(&g.as_ref().unwrap().conn, "あとで読む", None, db::Mode::Stock).unwrap()
        };
        let body = json!({
            "url": "https://example.com/post?utm_campaign=x",
            "title": "記事",
            "description": "説明",
            "folder": folder,
            "tags": ["web", " "],
        })
        .to_string();
        let (status, res) = call(p, "POST", "/bookmark", &hd, body.as_bytes());
        assert_eq!((status, res["imported"].as_u64(), res["duplicates"].as_u64()), (200, Some(1), Some(0)), "{res}");
        assert_eq!(host.imports.load(Ordering::Relaxed), 1);
        {
            let g = host.lib.lock().unwrap();
            let it = db::get_items(&g.as_ref().unwrap().conn, &[res["id"].as_str().unwrap().to_string()]).unwrap().remove(0);
            assert_eq!((it.kind, it.name.as_str()), (db::Kind::Bookmark, "記事"));
            assert_eq!(it.folder_id.as_deref(), Some(folder.as_str()));
            assert_eq!(it.source_url.as_deref(), Some("https://example.com/post"));
            assert_eq!(it.tag_ids.len(), 1);
        }
        let (status, again) = call(p, "POST", "/bookmark", &hd, br#"{"url":"https://example.com/post"}"#);
        assert_eq!((status, again["duplicates"].as_u64(), again["id"].clone()), (200, Some(1), res["id"].clone()));

        assert_eq!(call(p, "POST", "/bookmark", &hd, b"not json").0, 400);
        assert_eq!(call(p, "POST", "/bookmark", &hd, br#"{"url":"javascript:alert(1)"}"#).0, 422);
        assert_eq!(call(p, "POST", "/bookmark", &hd, br#"{"url":"https://example.com/x","folder":"gone"}"#).0, 400);
        assert_eq!(call(p, "GET", "/bookmark", &hd, b"").0, 405);
        *host.lib.lock().unwrap() = None;
        assert_eq!(call(p, "POST", "/bookmark", &hd, br#"{"url":"https://example.com/y"}"#).0, 503);
    }

    #[test]
    fn reports_bad_input() {
        let (_tmp, host, server) = setup();
        let p = server.port();
        let h = format!("127.0.0.1:{p}");
        let auth = format!("Bearer {TOKEN}");
        let hd = [("Host", h.as_str()), ("Authorization", auth.as_str())];
        assert_eq!(call(p, "POST", "/import?name=a.png", &hd, b"").0, 400, "empty body");
        let (status, res) = call(p, "POST", "/import?name=page.html", &hd, b"<html></html>");
        assert_eq!(status, 422);
        assert!(res["error"].as_str().unwrap().contains("page.html"), "{res}");
        assert_eq!(call(p, "POST", "/import?name=a.png&folder=gone", &hd, &png()).0, 400);
        // A javascript: or file: "page" is not stored.
        let (status, res) = call(p, "POST", "/import?name=a.png&page=javascript%3Aalert(1)", &hd, &png());
        assert_eq!(status, 200);
        {
            let g = host.lib.lock().unwrap();
            let it = db::get_items(&g.as_ref().unwrap().conn, &[res["id"].as_str().unwrap().into()]).unwrap().remove(0);
            assert_eq!(it.source_url, None);
        }
        *host.lib.lock().unwrap() = None;
        assert_eq!(call(p, "GET", "/folders", &hd, b"").0, 503);
        assert_eq!(call(p, "POST", "/import?name=a.png", &hd, &png()).0, 503);
    }

    #[test]
    fn pairing_hands_out_the_token_once_approved() {
        let (_tmp, host, server) = setup();
        let p = server.port();
        let h = format!("127.0.0.1:{p}");
        let ext = [("Host", h.as_str()), ("Origin", "chrome-extension://abcdefghijklmnop")];

        let (status, res) = call(p, "POST", "/pair?code=4821", &ext, b"");
        assert_eq!((status, res["token"].as_str()), (200, Some(TOKEN)));
        assert_eq!(*host.asked.lock().unwrap(), ["4821"]);
        // The token works.
        let auth = format!("Bearer {}", res["token"].as_str().unwrap());
        assert_eq!(call(p, "GET", "/info", &[ext[0], ("Authorization", &auth)], b"").0, 200);

        // Refused in the app; asking again right away doesn't bother the user.
        let (status, res) = call(p, "POST", "/pair?code=0000", &ext, b"");
        assert_eq!((status, res.get("token")), (403, None));
        assert_eq!(call(p, "POST", "/pair?code=4821", &ext, b"").0, 429);
        // Only extensions and apps that name themselves may ask, with a 4-digit
        // code, by POST; nobody is bothered otherwise.
        assert_eq!(call(p, "POST", "/pair?code=1234", &[ext[0]], b"").0, 403, "no Origin, no name");
        assert_eq!(call(p, "POST", "/pair?code=1234", &[ext[0], ("Origin", "https://evil.example")], b"").0, 403);
        assert_eq!(call(p, "POST", "/pair?code=12", &ext, b"").0, 400);
        assert_eq!(call(p, "GET", "/pair?code=1234", &ext, b"").0, 405);
        assert_eq!(host.asked.lock().unwrap().len(), 2);

        // One question at a time.
        let second = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let h = format!("127.0.0.1:{p}");
            call(p, "POST", "/pair?code=2222", &[("Host", &h), ("Origin", "chrome-extension://x")], b"").0
        });
        let other = [ext[0], ("Origin", "chrome-extension://qrstuvwxyzabcdef")];
        assert_eq!(call(p, "POST", "/pair?code=1111", &other, b"").0, 200);
        assert_eq!(second.join().unwrap(), 409);
    }

    #[test]
    fn apps_ask_by_name_and_pages_cannot_pass_for_one() {
        let (_tmp, host, server) = setup();
        let p = server.port();
        let h = format!("127.0.0.1:{p}");
        let app = [("Host", h.as_str()), ("X-Stockroom-Client", "Feedability")];

        let (status, res) = call(p, "POST", "/pair?code=4821", &app, b"");
        assert_eq!((status, res["token"].as_str()), (200, Some(TOKEN)));
        // The same token as the extension's; an app needs no Origin for the rest.
        let auth = format!("Bearer {TOKEN}");
        assert_eq!(call(p, "GET", "/folders", &[app[0], ("Authorization", &auth)], b"").0, 200);

        // A page naming itself an app still sends its Origin.
        let page = [app[0], app[1], ("Origin", "https://evil.example")];
        assert_eq!(call(p, "POST", "/pair?code=1234", &page, b"").0, 403);
        // A name of nothing but control characters is no name.
        assert_eq!(call(p, "POST", "/pair?code=1234", &[app[0], ("X-Stockroom-Client", "\u{7}")], b"").0, 400);
        // A refused app waits, by its name.
        assert_eq!(call(p, "POST", "/pair?code=0000", &app, b"").0, 403);
        assert_eq!(call(p, "POST", "/pair?code=4821", &app, b"").0, 429);
        let other = [app[0], ("X-Stockroom-Client", "Other")];
        assert_eq!(call(p, "POST", "/pair?code=1111", &other, b"").0, 200);
        assert_eq!(*host.asked.lock().unwrap(), ["4821", "0000", "1111"]);
    }

    #[test]
    fn app_names_are_cleaned() {
        assert_eq!(app_name(" Feedability "), Some("Feedability".into()));
        assert_eq!(app_name("a\nb\u{1b}c"), Some("abc".into()));
        assert_eq!(app_name(&"x".repeat(60)).map(|n| n.len()), Some(40));
        assert_eq!(app_name("  "), None);
    }

    #[test]
    fn stops_listening_when_dropped() {
        let (_tmp, host, server) = setup();
        let p = server.port();
        drop(server);
        assert!(TcpStream::connect(("127.0.0.1", p)).is_err());
        // Restarting on the same port (a new key) works straight away, again and again.
        for _ in 0..5 {
            let again = Server::start(p, TOKEN.into(), host.clone()).unwrap();
            assert_eq!(again.port(), p);
            drop(again);
        }
    }

    #[test]
    fn query_decoding() {
        assert_eq!(
            parse_query("a=1&b=x+y%2Bz&c&tag=%E7%94%BB"),
            [("a", "1"), ("b", "x y+z"), ("c", ""), ("tag", "画")]
                .map(|(k, v)| (k.to_string(), v.to_string()))
        );
    }
}

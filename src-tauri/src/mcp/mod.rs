//! Organizing the library from Claude: an MCP server (Streamable HTTP) on
//! 127.0.0.1 that Claude Code connects to, and that Claude Desktop reaches
//! through the app started with `--mcp` (bridge.rs). It runs only while the
//! app is open and the user has turned it on. See docs/MCP.md.
//!
//! - Listens on the loopback interface only, on a fixed port.
//! - Every request must carry `Authorization: Bearer <token>`; the token is
//!   made by the app and shown in the "Claude と連携" dialog.
//! - Requests from web pages are refused: any `Origin` (MCP clients send
//!   none), or a `Host` other than 127.0.0.1 / localhost (DNS rebinding).
//!
//!   POST /mcp   one JSON-RPC message; the answer is plain JSON (no SSE),
//!   or 202 for a notification
//!
//! The tools (tools.rs) read the open library and change tags, folders,
//! names and notes. Every change is recorded (changes.rs) so the user can
//! undo it in the app; nothing is deleted.

pub mod bridge;
mod tools;

use crate::changes::Change;
use crate::library::Library;
use crate::loopback::{self, Listener};
use serde_json::{json, Value};
use std::io::Read;
use std::sync::{Arc, Mutex};

pub const PORT: u16 = 41621;
const MAX_BODY: u64 = 4 * 1024 * 1024;
/// Messages in one batch: each tool keeps to its own limits (10 images to
/// view, ...), which a batch of thousands of calls would get around.
const MAX_BATCH: usize = 20;

/// Protocol revisions this server speaks, newest first. It only uses what
/// they have in common (tools, text and image content).
const PROTOCOL_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/// What Claude is told about the server when it connects.
const INSTRUCTIONS: &str = "Stockroom（画像・ファイル・テキスト・動画・ブックマークを管理するデスクトップアプリ）のライブラリを整理するためのツールです。\
対象はアプリでいま開いているライブラリです。\n\
- まず library_info / list_folders / list_tags で全体を把握し、find_items で対象を探してください。\
find_items は 1 件 1 行で、先頭の 8 文字の id を書き込みのツールにそのまま渡せます。\n\
- 書き込み（タグ・フォルダ・表示名・メモ）は、規則で決まる変更なら where で、1 件ずつ違う変更なら items でまとめて 1 回で渡してください。\
1 回で変えられるのは 500 件までです。\n\
- 多くの件数を変える前や、ユーザーの意図がはっきりしないときは、dry_run: true で結果を確かめ、案をユーザーに見せてから実行してください。\n\
- 変更はアプリに記録され、ユーザーがアプリから元に戻せます。削除やゴミ箱への移動はできません。\n\
- view_images で画像を見られますが、1 回 10 枚までです。多くの枚数を見るとユーザーの使用量を大きく消費するので、必要な分だけにしてください。";

/// What the server needs from the app (a trait so tests can run without Tauri).
pub trait Host: Send + Sync + 'static {
    fn library(&self) -> &Mutex<Option<Library>>;
    /// Called after every recorded change, to refresh the UI and offer undo.
    fn changed(&self, change: &Change);
}

pub struct Server {
    listener: Listener,
}

impl Server {
    /// Starts listening on `127.0.0.1:port` (0 = any free port, for tests).
    pub fn start(port: u16, token: String, host: Arc<dyn Host>) -> Result<Self, String> {
        let listener = Listener::start(port, move |req, port| serve(req, port, &token, &*host))?;
        Ok(Self { listener })
    }

    pub fn port(&self) -> u16 {
        self.listener.port()
    }
}

fn serve(mut req: tiny_http::Request, port: u16, token: &str, host: &dyn Host) {
    let host_header = loopback::header(&req, "Host");
    let origin = loopback::header(&req, "Origin");
    let auth = loopback::header(&req, "Authorization");
    let method = req.method().as_str().to_ascii_uppercase();
    let path = req.url().split('?').next().unwrap_or("").to_string();
    let length = req.body_length().map(|n| n as u64);

    let (status, body) = if !loopback::is_own_host(host_header.as_deref(), port) || origin.is_some() {
        (403, Some(json!({ "error": "許可されていない接続です" })))
    } else if !loopback::has_token(auth.as_deref(), token) {
        (401, Some(json!({ "error": "トークンが違います。Stockroom の「Claude と連携」から設定し直してください" })))
    } else if path != "/mcp" {
        (404, Some(json!({ "error": "見つかりません" })))
    } else if method != "POST" {
        // No server-sent events: there is nothing to push to the client.
        (405, None)
    } else {
        post(req.as_reader(), length, host)
    };
    let mut response = tiny_http::Response::from_string(body.map(|b| b.to_string()).unwrap_or_default())
        .with_status_code(status)
        .with_header(tiny_http::Header::from_bytes("Cache-Control", "no-store").unwrap());
    if status == 405 {
        response.add_header(tiny_http::Header::from_bytes("Allow", "POST").unwrap());
    } else {
        response.add_header(tiny_http::Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap());
    }
    let _ = req.respond(response);
}

fn post(body: &mut dyn Read, length: Option<u64>, host: &dyn Host) -> (u16, Option<Value>) {
    if length.is_some_and(|n| n > MAX_BODY) {
        return (413, Some(rpc_error(Value::Null, -32600, "リクエストが大きすぎます")));
    }
    let mut data = Vec::new();
    if body.take(MAX_BODY + 1).read_to_end(&mut data).is_err() || data.len() as u64 > MAX_BODY {
        return (400, Some(rpc_error(Value::Null, -32600, "リクエストを読めませんでした")));
    }
    let Ok(msg) = serde_json::from_slice::<Value>(&data) else {
        return (400, Some(rpc_error(Value::Null, -32700, "JSON として読めません")));
    };
    let call = |name: &str, args: &Value| tools::call(host, name, args);
    // Batches were dropped from the protocol (2025-06-18) but cost nothing to answer.
    let reply = match &msg {
        Value::Array(all) if all.len() > MAX_BATCH => {
            return (400, Some(rpc_error(Value::Null, -32600, &format!("一度に送れるのは {MAX_BATCH} 件までです"))));
        }
        Value::Array(all) => {
            let replies: Vec<Value> = all.iter().filter_map(|m| respond(m, &call)).collect();
            (!replies.is_empty()).then_some(Value::Array(replies))
        }
        _ => respond(&msg, &call),
    };
    match reply {
        Some(r) => (200, Some(r)),
        None => (202, None), // a notification or a response: nothing to answer
    }
}

/// What a tool hands back: MCP content blocks, and whether it failed.
pub struct ToolOutput {
    pub content: Vec<Value>,
    pub is_error: bool,
}

impl ToolOutput {
    pub fn text(text: impl Into<String>) -> Self {
        Self { content: vec![json!({ "type": "text", "text": text.into() })], is_error: false }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self { is_error: true, ..Self::text(text) }
    }

    fn to_json(&self) -> Value {
        json!({ "content": self.content, "isError": self.is_error })
    }
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Answers one JSON-RPC message; None for notifications and responses.
/// `call` runs a tool (the app's tools, or the bridge's stand-in while the
/// app is closed).
pub fn respond(msg: &Value, call: &dyn Fn(&str, &Value) -> ToolOutput) -> Option<Value> {
    let method = msg.get("method").and_then(Value::as_str)?;
    let id = msg.get("id")?.clone();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = PROTOCOL_VERSIONS.iter().find(|v| **v == asked).unwrap_or(&PROTOCOL_VERSIONS[0]);
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "stockroom", "title": "Stockroom", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools::list() }),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(rpc_error(id, -32602, "ツールの名前がありません"));
            };
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            call(name, &args).to_json()
        }
        _ => return Some(rpc_error(id, -32601, &format!("{method} には対応していません"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::io::Write;
    use std::net::TcpStream;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TestHost {
        lib: Mutex<Option<Library>>,
        changes: AtomicUsize,
    }

    impl Host for TestHost {
        fn library(&self) -> &Mutex<Option<Library>> {
            &self.lib
        }
        fn changed(&self, _: &Change) {
            self.changes.fetch_add(1, Ordering::Relaxed);
        }
    }

    const TOKEN: &str = "mcp-token";

    fn setup() -> (tempfile::TempDir, Arc<TestHost>, Server) {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::create(&dir.path().join("Claude.library")).unwrap();
        let host = Arc::new(TestHost { lib: Mutex::new(Some(lib)), changes: AtomicUsize::new(0) });
        let server = Server::start(0, TOKEN.into(), host.clone()).unwrap();
        (dir, host, server)
    }

    /// Sends a raw HTTP/1.1 request; returns the status and the JSON body (Null if none).
    fn call(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> (u16, Value) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut req = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
        for (k, v) in headers {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str("\r\n");
        s.write_all(req.as_bytes()).unwrap();
        s.write_all(body.as_bytes()).unwrap();
        let mut out = Vec::new();
        s.read_to_end(&mut out).unwrap();
        let text = String::from_utf8_lossy(&out);
        let status = text.split(' ').nth(1).unwrap().parse().unwrap();
        let json = text.split_once("\r\n\r\n").map(|(_, b)| serde_json::from_str(b).unwrap_or(Value::Null)).unwrap();
        (status, json)
    }

    #[test]
    fn refuses_web_pages_and_wrong_tokens() {
        let (_tmp, _host, server) = setup();
        let p = server.port();
        let host = format!("127.0.0.1:{p}");
        let auth = format!("Bearer {TOKEN}");
        let ok = [("Host", host.as_str()), ("Authorization", auth.as_str())];
        let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        assert_eq!(call(p, "POST", "/mcp", &ok, ping).0, 200);
        assert_eq!(call(p, "POST", "/mcp", &[ok[0]], ping).0, 401, "no token");
        assert_eq!(call(p, "POST", "/mcp", &[ok[0], ("Authorization", "Bearer mcp-tokeX")], ping).0, 401);
        assert_eq!(call(p, "POST", "/mcp", &[ok[0], ok[1], ("Origin", "https://evil.example")], ping).0, 403);
        assert_eq!(call(p, "POST", "/mcp", &[("Host", "evil.example"), ok[1]], ping).0, 403);
        assert_eq!(call(p, "GET", "/mcp", &ok, "").0, 405);
        assert_eq!(call(p, "POST", "/other", &ok, ping).0, 404);
        assert_eq!(call(p, "POST", "/mcp", &ok, "{nope").0, 400);
    }

    #[test]
    fn speaks_json_rpc() {
        let (_tmp, host, server) = setup();
        let p = server.port();
        let h = format!("127.0.0.1:{p}");
        let auth = format!("Bearer {TOKEN}");
        let hd = [("Host", h.as_str()), ("Authorization", auth.as_str())];

        let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}"#;
        let (status, res) = call(p, "POST", "/mcp", &hd, init);
        assert_eq!(status, 200);
        assert_eq!(res["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(res["result"]["serverInfo"]["name"], "stockroom");
        // An unknown revision gets the newest one.
        let init2 = init.replace("2025-06-18", "1999-01-01");
        assert_eq!(call(p, "POST", "/mcp", &hd, &init2).1["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);

        let note = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        assert_eq!(call(p, "POST", "/mcp", &hd, note).0, 202);

        let (_, res) = call(p, "POST", "/mcp", &hd, r#"{"jsonrpc":"2.0","id":"a","method":"tools/list"}"#);
        let names: Vec<&str> = res["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"find_items") && names.contains(&"add_tags"), "{names:?}");
        assert_eq!(res["id"], "a");

        let (_, res) = call(p, "POST", "/mcp", &hd, r#"{"jsonrpc":"2.0","id":2,"method":"nope"}"#);
        assert_eq!(res["error"]["code"], -32601);

        // A tool call that changes something reaches the app.
        {
            let g = host.lib.lock().unwrap();
            let conn = &g.as_ref().unwrap().conn;
            conn.execute(
                "INSERT INTO items (id, name, file_name, ext, width, height, size, hash, thumb, imported_at)
                 VALUES ('0123456789abcdef0123456789abcdef', 'kyoto.jpg', 'kyoto.jpg', 'jpg', 1, 1, 1, 'h', '', 0)",
                [],
            )
            .unwrap();
        }
        let add = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add_tags","arguments":{"ids":["01234567"],"tags":["京都"]}}}"#;
        let (status, res) = call(p, "POST", "/mcp", &hd, add);
        assert_eq!((status, &res["result"]["isError"]), (200, &json!(false)), "{res}");
        assert_eq!(host.changes.load(Ordering::Relaxed), 1);
        let g = host.lib.lock().unwrap();
        assert_eq!(db::list_tags(&g.as_ref().unwrap().conn).unwrap()[0].count, 1);
    }

    #[test]
    fn says_so_when_no_library_is_open() {
        let (_tmp, host, server) = setup();
        *host.lib.lock().unwrap() = None;
        let p = server.port();
        let h = format!("127.0.0.1:{p}");
        let auth = format!("Bearer {TOKEN}");
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"library_info","arguments":{}}}"#;
        let (status, res) = call(p, "POST", "/mcp", &[("Host", &h), ("Authorization", &auth)], body);
        assert_eq!((status, &res["result"]["isError"]), (200, &json!(true)));
        assert!(res["result"]["content"][0]["text"].as_str().unwrap().contains("ライブラリ"));
    }
}

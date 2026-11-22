//! Runs the browser-extension server (webimport.rs) against a library without
//! the app, for working on the extension. Writes `config.json` into the
//! extension folder so the extension loaded from there connects; any other
//! copy that asks to connect ("アプリと接続") is let in without asking.
//!   cargo run --example webserver -- <path/to/X.library> [extension dir] [port]
//! It listens on DEV_PORT by default, not the app's: with every pairing let
//! in, it must not stand in for a running app (or answer while the app is
//! closed). The extension finds the port in the config.json written here.
use stockroom_lib::import::ImportSummary;
use stockroom_lib::library::Library;
use stockroom_lib::webimport::{Host, Server, PORT};

/// Next to the app's ports (PORT for the extension, PORT + 1 for Claude).
const DEV_PORT: u16 = PORT + 10;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

struct Print(Mutex<Option<Library>>);

impl Host for Print {
    fn library(&self) -> &Mutex<Option<Library>> {
        &self.0
    }
    fn imported(&self, s: &ImportSummary) {
        println!("imported {} / duplicates {} / failed {:?}", s.imported, s.duplicates, s.failed);
    }
    /// No one to ask here: connects every extension that asks.
    fn approve_pairing(&self, code: &str, extension: &str) -> bool {
        println!("pairing approved (code {code}, extension {extension})");
        true
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(args.next().expect("usage: webserver <library> [extension dir] [port]"));
    let ext = args.next().map(PathBuf::from).unwrap_or_else(|| PathBuf::from("../extension"));
    let port: u16 = args.next().map(|p| p.parse().expect("port")).unwrap_or(DEV_PORT);
    let token = uuid::Uuid::new_v4().simple().to_string();
    let config = format!("{{ \"port\": {port}, \"token\": \"{token}\" }}\n");
    std::fs::write(ext.join("config.json"), config).expect("write config.json");

    let host = Arc::new(Print(Mutex::new(Some(Library::create(&root).unwrap()))));
    let _server = Server::start(port, token, host).unwrap();
    println!("listening on 127.0.0.1:{port} for {}", root.display());
    loop {
        std::thread::park();
    }
}

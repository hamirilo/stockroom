//! Runs the folder-sharing server (share.rs) against a library without the
//! app, for working on the page (src/share.html). Shares the folder named on
//! the command line (the first folder if none) and prints its URLs.
//!   cargo run --example shareserver -- <path/to/X.library> [folder name] [port]
//! (the default port 41650 leaves a running app alone)
use stockroom_lib::db;
use stockroom_lib::library::Library;
use stockroom_lib::share::{self, Host, Server};
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

struct Lib(Mutex<Option<Library>>);

impl Host for Lib {
    fn library(&self) -> &Mutex<Option<Library>> {
        &self.0
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(args.next().expect("usage: shareserver <library> [folder name] [port]"));
    let name = args.next();
    let port: u16 = args.next().map(|p| p.parse().expect("port")).unwrap_or(41650);

    let lib = Library::create(&root).unwrap();
    let folders = db::list_folders(&lib.conn).unwrap();
    let folder = folders
        .iter()
        .find(|f| name.as_ref().is_none_or(|n| &f.name == n))
        .expect("no such folder (make one in the app first)");
    let token = share::start(&lib.conn, &folder.id).unwrap().token;
    let _server = Server::start(Ipv4Addr::UNSPECIFIED, port, Arc::new(Lib(Mutex::new(Some(lib))))).unwrap();
    println!("sharing \"{}\"", folder.name);
    println!("{}", share::url("127.0.0.1", port, &token));
    for host in share::lan_hosts() {
        println!("{}", share::url(&host, port, &token));
    }
    loop {
        std::thread::park();
    }
}

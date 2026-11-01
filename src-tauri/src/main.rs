// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started by Claude Desktop as its MCP server: relay to the running app (mcp/bridge.rs).
    // Not in a build without the Claude connection (limits.rs).
    if !stockroom_lib::limits::NO_CONNECT && std::env::args().any(|a| a == "--mcp") {
        std::process::exit(stockroom_lib::mcp::bridge::run());
    }
    stockroom_lib::run()
}

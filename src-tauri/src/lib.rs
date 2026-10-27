pub mod appdirs;
pub mod bookmarks;
pub mod changes;
pub mod commands;
pub mod db;
pub mod export;
pub mod files;
pub mod fonts;
pub mod formats;
pub mod import;
pub mod library;
pub mod loopback;
pub mod mcp;
pub mod orient;
pub mod proxy;
pub mod search;
pub mod share;
pub mod sheet;
pub mod similar;
pub mod texts;
pub mod transfer;
pub mod videos;
pub mod webimport;

use commands::*;

/// The log file's name in the app's log folder (without ".log").
pub const LOG_FILE: &str = "stockroom";

/// Panics into the log too: release builds abort on panic, so stderr is all
/// that would be left, and nobody sees it.
fn log_panics() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("{info}");
        default(info);
    }));
}

/// The window, from tauri.conf.json (where it isn't created by itself). On
/// macOS, transparent over the "sidebar" material: the page lets it show
/// through the sidebar (index.css, `.vibrant`) and covers it elsewhere.
/// Windows keeps an ordinary window.
fn main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let config = app.config().app.windows.iter().find(|w| w.label == "main").expect("window in tauri.conf.json");
    let builder = tauri::WebviewWindowBuilder::from_config(app, config)?;
    #[cfg(target_os = "macos")]
    let builder = {
        use tauri::window::{Color, Effect, EffectState, EffectsBuilder};
        builder
            .transparent(true)
            .background_color(Color(0, 0, 0, 0))
            .effects(
                EffectsBuilder::new()
                    .effect(Effect::Sidebar)
                    // Always the plain grey a background window gets: the active
                    // material is tinted by the desktop (blue here), which made
                    // the whole sidebar look selected.
                    .state(EffectState::Inactive)
                    .build(),
            )
    };
    builder.build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before the plugins below open the app's folders (logs, window state).
    let moved = appdirs::move_from_old_name();
    // The menu bar is made by the frontend from its command table
    // (src/lib/menuBar.ts); until it loads, macOS shows Tauri's default menu.
    tauri::Builder::default()
        // First, so a second launch quits before setting anything up: it
        // only brings this app's window up. One app holds one library, and
        // the extension / Claude ports can only be served once.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        // log::* from Rust and the frontend's warnings (src/lib/log.ts), into
        // the app's log folder ("ログを表示" in the Help menu) and stdout.
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some(LOG_FILE.into()),
                    }),
                ])
                .max_file_size(1_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(2))
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Size, place and maximized of the window, kept between launches
        // (.window-state.json in the app config folder). Not fullscreen or
        // hidden: the app should always open as a visible, ordinary window.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .manage(AppState::default())
        .setup(move |app| {
            log_panics();
            for m in &moved {
                log::info!("{m}");
            }
            main_window(app.handle())?;
            log::info!(
                "Stockroom {} ({} {})",
                app.package_info().version,
                std::env::consts::OS,
                std::env::consts::ARCH
            );
            start_web_import(app.handle());
            start_lock_refresh(app.handle());
            start_mcp(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_last_library,
            create_library,
            open_library,
            get_app_settings,
            set_app_settings,
            get_library_settings,
            set_library_setting,
            library_size,
            list_libraries,
            set_library_favorite,
            forget_library,
            transfer_items,
            query_items,
            facet_counts,
            get_counts,
            selection_info,
            set_note,
            rename_item,
            trash_items,
            restore_items,
            delete_items,
            empty_trash,
            reveal_item,
            video_codecs,
            open_items,
            set_rating,
            set_favorite,
            set_pinned,
            orient_items,
            system_proxy,
            open_release_page,
            fonts::commands::font_info,
            fonts::commands::font_faces,
            fonts::commands::font_list_preview,
            fonts::commands::index_fonts,
            fonts::commands::set_font_category,
            fonts::commands::font_data,
            fonts::commands::system_fonts,
            fonts::commands::reveal_system_font,
            fonts::commands::add_system_to_tray,
            fonts::commands::system_tray,
            fonts::commands::library_font_ps_names,
            files::commands::file_preview,
            files::commands::prepare_file_thumbs,
            texts::commands::read_text,
            texts::commands::save_text,
            texts::commands::create_text,
            bookmarks::commands::create_bookmark,
            copy_items,
            export::export_items,
            export::export_library,
            export::cancel_export,
            add_to_tray,
            remove_from_tray,
            clear_tray,
            reorder_tray,
            sheet_image,
            save_file,
            copy_image,
            reveal_path,
            reveal_log,
            reorder_in_folder,
            place_folder,
            shift_folder,
            sort_folders_by_name,
            list_smart_folders,
            create_smart_folder,
            update_smart_folder,
            delete_smart_folder,
            list_exts,
            import_paths,
            import_bytes,
            index_similar,
            dismiss_duplicates,
            undismiss_duplicates,
            clear_dismissed_duplicates,
            count_dismissed_duplicates,
            preview_duplicates,
            resolve_duplicates,
            supported_exts,
            web_import_status,
            set_web_import,
            reset_web_import_token,
            install_extension,
            answer_web_pair,
            mcp_status,
            set_mcp,
            reset_mcp_token,
            share_status,
            set_folder_share,
            set_share_download,
            stop_all_shares,
            share_qr,
            list_changes,
            undo_change,
            list_folders,
            create_folder,
            rename_folder,
            delete_folder,
            move_folder,
            move_to_folder,
            link_items,
            unlink_items,
            restore_links,
            count_links,
            set_links_enabled,
            set_adopted,
            remove_from_folder,
            list_tags,
            add_tags,
            remove_tag,
            rename_tag,
            set_folder_color,
            set_smart_folder_color,
            set_tag_color,
            delete_tag,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Close the library before quitting: library.db complete on its
            // own (for cloud sync) and the lock removed.
            if let tauri::RunEvent::Exit = event {
                close_library(app);
            }
        });
}

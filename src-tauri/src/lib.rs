mod backup;
mod commands;
mod config;
pub mod installer;

use commands::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            validate_game_dir,
            detect_weidu,
            read_file_contents,
            get_binary_version,
            verify_weidu,
            scan_mod_directory,
            check_mod_exists,
            check_game_freshness,
            parse_debug_file,
            batch_check_mods_exist,
            download_mod,
            compare_install_logs,
            gui_log,
            read_gui_log,
            clear_gui_log,
            get_gui_log_path,
            save_download_cache,
            load_download_cache,
            count_weidu_log_entries,
            write_temp_log,
            scan_patches,
            apply_patches,
            save_install_report,
            start_native_install,
            start_dry_run,
            install_decision,
            install_pause,
            install_resume,
            install_send_input,
            abort_native_install,
            check_install_checkpoint,
            estimate_backup,
            create_backup,
            list_backups,
            restore_backup,
            delete_backup,
            abort_backup,
        ])
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Force-kill any running WeiDU process immediately on app close.
                // Can't use abort_weidu() here — its background kill thread won't
                // execute before the Tauri runtime shuts down.
                installer::runner::force_kill_weidu();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

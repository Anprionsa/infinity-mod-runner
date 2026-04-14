mod commands;
mod config;

use commands::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            validate_game_dir,
            detect_weidu,
            detect_mod_installer,
            read_file_contents,
            get_binary_version,
            verify_weidu,
            scan_mod_directory,
            check_mod_exists,
            check_game_freshness,
            read_install_status,
            read_error_log,
            start_install,
            send_install_input,
            abort_install,
            parse_debug_file,
            batch_check_mods_exist,
            download_mod,
            compare_install_logs,
            request_pause,
            request_resume,
            check_pause_state,
            gui_log,
            read_gui_log,
            clear_gui_log,
            get_gui_log_path,
            save_download_cache,
            load_download_cache,
            count_weidu_log_entries,
            scan_patches,
            apply_patches,
            save_install_report,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

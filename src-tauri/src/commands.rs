use crate::config::AppConfig;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager};

/// Load persisted config from disk.
///
/// Migration: the app was renamed from "eet-mod-runner" to "infinity-mod-runner"
/// (suite rename on 2026-04-20). On first load after the rename, if the new
/// confy key returns a default config but the old key has real data, copy the
/// old config over and write it to the new key. See INFINITY_RENAME_PLAN.md.
#[tauri::command]
pub fn load_config() -> Result<AppConfig, String> {
    let cfg: AppConfig = confy::load("infinity-mod-runner", "config")
        .map_err(|e| format!("Failed to load config: {e}"))?;
    if cfg == AppConfig::default() {
        if let Ok(legacy) = confy::load::<AppConfig>("eet-mod-runner", "config") {
            if legacy != AppConfig::default() {
                log::info!("Migrating config from eet-mod-runner to infinity-mod-runner");
                let _ = confy::store("infinity-mod-runner", "config", &legacy);
                return Ok(legacy);
            }
        }
    }
    Ok(cfg)
}

/// Save config to disk.
///
/// Emits an `app:config-saved` event on success and `app:config-save-failed`
/// on error so the frontend can surface silent persistence failures in
/// gui.log. Historically we just returned `Err(...)` to the JS caller where
/// it hit a `console.error` and vanished — with the event path, config
/// write failures show up in the session log and we can catch regressions
/// like "confy stopped writing 2 weeks ago" before the user loses another
/// install worth of settings.
#[tauri::command]
pub fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    match confy::store("infinity-mod-runner", "config", &config) {
        Ok(()) => {
            // Include the resolved path so users (and log consumers) can tell
            // at a glance *which* file we think we wrote to.
            let path = confy::get_configuration_file_path("infinity-mod-runner", "config")
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "<path-unknown>".to_string());
            let _ = app.emit("app:config-saved", serde_json::json!({ "path": path }));
            Ok(())
        }
        Err(e) => {
            let msg = format!("Failed to save config: {e}");
            let _ = app.emit("app:config-save-failed", serde_json::json!({
                "error": msg.clone(),
            }));
            Err(msg)
        }
    }
}

/// Check if a directory contains chitin.key (valid IE game dir).
/// Handles case-insensitive matching on Linux where the file may be Chitin.key or CHITIN.KEY.
#[tauri::command]
pub async fn validate_game_dir(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = Path::new(&path);
        if !dir.exists() {
            return Ok(false);
        }
        for name in &["chitin.key", "Chitin.key", "CHITIN.KEY", "chitin.KEY"] {
            if dir.join(name).exists() {
                return Ok(true);
            }
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                if entry.file_name().to_string_lossy().eq_ignore_ascii_case("chitin.key") {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }).await.map_err(|e| e.to_string())?
}

/// Search PATH for weidu/weidu.exe.
///
/// Excludes matches inside the experimental-WeiDU cache directory
/// (`.weidu_cache/`). That cache is our private staging area for the
/// bundled patched binary — users should never see it pointed at from
/// Setup. A user could conceivably put the cache root on PATH or alias
/// `weidu` to it; either way, auto-detect must not surface that path.
/// The same marker is used in `installer/dry_run.rs` to identify the
/// cache from the other direction.
#[tauri::command]
pub fn detect_weidu() -> Result<Option<String>, String> {
    fn is_experimental_cache(path: &str) -> bool {
        Path::new(path)
            .components()
            .any(|c| c.as_os_str().eq_ignore_ascii_case(".weidu_cache"))
    }

    if let Ok(path) = which("weidu") {
        if !is_experimental_cache(&path) {
            return Ok(Some(path));
        }
    }
    if let Ok(path) = which("weidu.exe") {
        if !is_experimental_cache(&path) {
            return Ok(Some(path));
        }
    }
    // Check common locations per platform
    #[cfg(target_os = "windows")]
    let common_paths = vec![
        "C:/WeiDU/weidu.exe".to_string(),
        "C:/Games/WeiDU/weidu.exe".to_string(),
    ];
    #[cfg(not(target_os = "windows"))]
    let common_paths = {
        let mut paths = vec![
            "/usr/local/bin/weidu".to_string(),
            "/usr/bin/weidu".to_string(),
        ];
        if let Ok(home) = std::env::var("HOME") {
            paths.push(format!("{home}/bin/weidu"));
            paths.push(format!("{home}/.local/bin/weidu"));
            // Homebrew on macOS
            paths.push(format!("{home}/homebrew/bin/weidu"));
            paths.push("/opt/homebrew/bin/weidu".to_string());
        }
        paths
    };
    for p in &common_paths {
        if Path::new(p).exists() && !is_experimental_cache(p) {
            return Ok(Some(p.to_string()));
        }
    }
    Ok(None)
}

/// Check if a game directory appears to be a fresh, unmodified install.
#[tauri::command]
pub async fn check_game_freshness(path: String) -> Result<GameFreshness, String> {
    tauri::async_runtime::spawn_blocking(move || {
    let root = Path::new(&path);

    // Check for weidu.log
    let weidu_log = root.join("weidu.log");
    let has_weidu_log = weidu_log.exists();
    let weidu_log_entries = if has_weidu_log {
        std::fs::read_to_string(&weidu_log)
            .unwrap_or_default()
            .lines()
            .filter(|l| l.starts_with('~'))
            .count()
    } else {
        0
    };

    // Count files in override/
    let override_dir = root.join("override");
    let override_count = if override_dir.exists() {
        std::fs::read_dir(&override_dir)
            .map(|rd| rd.count())
            .unwrap_or(0)
    } else {
        0
    };

    // Check dialog.tlk size — BG:EE stores it in lang/<language>/dialog.tlk
    let dialog_tlk_size = {
        // Try common locations
        let candidates = [
            root.join("dialog.tlk"),
            root.join("lang").join("en_US").join("dialog.tlk"),
            root.join("lang").join("en_us").join("dialog.tlk"),
        ];
        let mut size = 0u64;
        for path in &candidates {
            if path.exists() {
                size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                if size > 0 { break; }
            }
        }
        // Fallback: scan lang/ for any dialog.tlk
        if size == 0 {
            if let Ok(entries) = std::fs::read_dir(root.join("lang")) {
                for entry in entries.filter_map(|e| e.ok()) {
                    let tlk = entry.path().join("dialog.tlk");
                    if tlk.exists() {
                        size = std::fs::metadata(&tlk).map(|m| m.len()).unwrap_or(0);
                        if size > 0 { break; }
                    }
                }
            }
        }
        size
    };

    // Known vanilla dialog.tlk sizes (approximate, varies by patch version)
    // BG1EE ~8.5MB, BG2EE ~11.5MB — modded installs grow significantly
    // These are rough thresholds; anything much larger is likely modded
    let dialog_tlk_mb = dialog_tlk_size as f64 / (1024.0 * 1024.0);

    // Check for common mod artifacts (setup-*.exe on Windows, setup-* on Unix)
    let has_setup_scripts = std::fs::read_dir(root)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .any(|e| {
                    let name = e.file_name().to_string_lossy().to_lowercase();
                    if cfg!(target_os = "windows") {
                        name.starts_with("setup-") && name.ends_with(".exe")
                    } else {
                        // On Unix, setup scripts have no extension
                        name.starts_with("setup-") && !name.contains('.')
                    }
                })
        })
        .unwrap_or(false);

    // Determine overall status
    let is_fresh = !has_weidu_log && override_count < 50 && !has_setup_scripts;

    let mut warnings: Vec<String> = Vec::new();
    if has_weidu_log {
        warnings.push(format!(
            "weidu.log found with {weidu_log_entries} mod entries — this game has been modded"
        ));
    }
    if override_count >= 50 {
        warnings.push(format!(
            "override/ contains {override_count} files (fresh installs have very few)"
        ));
    }
    if has_setup_scripts {
        warnings.push("Setup-*.exe files found — mod installers have been run here".to_string());
    }

    Ok(GameFreshness {
        is_fresh,
        has_weidu_log,
        weidu_log_entries,
        override_count,
        dialog_tlk_size,
        dialog_tlk_mb: (dialog_tlk_mb * 10.0).round() / 10.0,
        has_setup_scripts,
        warnings,
    })
    }).await.map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct GameFreshness {
    pub is_fresh: bool,
    pub has_weidu_log: bool,
    pub weidu_log_entries: usize,
    pub override_count: usize,
    pub dialog_tlk_size: u64,
    pub dialog_tlk_mb: f64,
    pub has_setup_scripts: bool,
    pub warnings: Vec<String>,
}

/// Get the version string from a binary by running it with --version.
#[tauri::command]
pub async fn get_binary_version(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(&path);
        cmd.arg("--version");

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let output = cmd.output()
            .map_err(|e| format!("Failed to run {path}: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let combined = format!("{stdout}{stderr}");

        for line in combined.lines() {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                return Ok(Some(trimmed.to_string()));
            }
        }
        Ok(None)
    }).await.map_err(|e| e.to_string())?
}

/// Verify WeiDU can actually execute by running it with --version and checking output.
#[tauri::command]
pub async fn verify_weidu(weidu_path: String) -> Result<WeiduVerification, String> {
    tauri::async_runtime::spawn_blocking(move || {
    let mut cmd = std::process::Command::new(&weidu_path);
    cmd.arg("--version");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    match cmd.output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let combined = format!("{stdout}{stderr}");
            let version = combined.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
            let success = output.status.success() && !version.is_empty();
            Ok(WeiduVerification {
                success,
                version: if version.is_empty() { None } else { Some(version) },
                error: if success { None } else { Some(format!("Exit code: {:?}", output.status.code())) },
            })
        }
        Err(e) => {
            let msg = format!("{e}");
            let hint = if msg.contains("not found") || msg.contains("No such file") {
                "WeiDU binary not found at the specified path."
            } else if msg.contains("Permission denied") || msg.contains("Access is denied") {
                "WeiDU is blocked. Your antivirus may be quarantining it. Add an exception for weidu.exe."
            } else {
                "WeiDU failed to execute."
            };
            Ok(WeiduVerification {
                success: false,
                version: None,
                error: Some(format!("{hint} ({e})")),
            })
        }
    }
    }).await.map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct WeiduVerification {
    pub success: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

/// Scan a directory for mod folders containing .tp2 files.
#[tauri::command]
pub async fn scan_mod_directory(mod_dir: String) -> Result<ModDirScan, String> {
    tauri::async_runtime::spawn_blocking(move || {
    let dir = Path::new(&mod_dir);
    if !dir.exists() {
        return Ok(ModDirScan {
            exists: false,
            mod_count: 0,
            tp2_count: 0,
            sample_mods: Vec::new(),
            error: Some("Directory does not exist.".to_string()),
        });
    }

    let mut mod_count = 0usize;
    let mut tp2_count = 0usize;
    let mut sample_mods: Vec<String> = Vec::new();

    // Search up to 3 levels deep for .tp2 files.
    // Common structures:
    //   Extracted/eefixpack/setup-eefixpack.tp2  (depth 1)
    //   Extracted/SCS/stratagems/stratagems.tp2  (depth 2)
    fn find_tp2_in_dir(dir: &Path, max_depth: usize) -> usize {
        if max_depth == 0 { return 0; }
        let mut count = 0;
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_file() {
                    if path.extension().map_or(false, |ext| ext.eq_ignore_ascii_case("tp2")) {
                        count += 1;
                    }
                } else if path.is_dir() {
                    count += find_tp2_in_dir(&path, max_depth - 1);
                }
            }
        }
        count
    }

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if !path.is_dir() { continue; }

            // Search this mod folder and its subfolders (up to 2 more levels)
            let tp2s = find_tp2_in_dir(&path, 3);

            if tp2s > 0 {
                mod_count += 1;
                tp2_count += tp2s;
                if sample_mods.len() < 10 {
                    sample_mods.push(entry.file_name().to_string_lossy().to_string());
                }
            }
        }
    }

    Ok(ModDirScan {
        exists: true,
        mod_count,
        tp2_count,
        sample_mods,
        error: if mod_count == 0 {
            Some("No mod folders with .tp2 files found. Mods must be extracted (unzipped) into this directory, each in its own subfolder.".to_string())
        } else {
            None
        },
    })
    }).await.map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct ModDirScan {
    pub exists: bool,
    pub mod_count: usize,
    pub tp2_count: usize,
    pub sample_mods: Vec<String>,
    pub error: Option<String>,
}

/// Check if a specific mod's folder exists in the mod directory or game directory.
/// Check if a mod's .tp2 file exists anywhere in the mod directory or game directory.
/// Searches recursively up to 3 levels deep, case-insensitive.
/// This is what matters — WeiDU needs the .tp2 file, not a specific folder name.
#[tauri::command]
pub async fn check_mod_exists(mod_dir: String, game_dir: String, tp2_path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let normalized = tp2_path.replace('\\', "/");
        let tp2_filename = normalized.split('/').last().unwrap_or(&tp2_path).to_lowercase();
        for dir in &[&mod_dir, &game_dir] {
            if find_file_recursive(Path::new(dir), &tp2_filename, 4) {
                return Ok(true);
            }
        }
        Ok(false)
    }).await.map_err(|e| e.to_string())?
}

/// Recursively search for a file by name (case-insensitive) up to max_depth levels.
/// Byte-level substring replacement. Used for the "replace" patch op so we can
/// safely operate on TP2/TPA files that contain non-UTF-8 bytes (Latin-1/CP1252
/// German ellipsis 0x85, Polish diacritics, etc.). Since our find/replace
/// strings in patch_manifest.json are always ASCII, byte-level match is
/// correct: ASCII bytes are invariant across UTF-8 and legacy 8-bit encodings.
fn replace_bytes_all(haystack: &[u8], needle: &[u8], replacement: &[u8]) -> Vec<u8> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return haystack.to_vec();
    }
    let mut out = Vec::with_capacity(haystack.len());
    let mut i = 0;
    while i + needle.len() <= haystack.len() {
        if &haystack[i..i + needle.len()] == needle {
            out.extend_from_slice(replacement);
            i += needle.len();
        } else {
            out.push(haystack[i]);
            i += 1;
        }
    }
    out.extend_from_slice(&haystack[i..]);
    out
}

/// Normalize CRLF to LF at the byte level, preserving non-ASCII bytes. Used by
/// the "replace" op as a fallback when the first match attempt fails due to
/// line-ending mismatch between the patch manifest (LF) and the on-disk file.
fn normalize_crlf_to_lf(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'\r' && bytes[i + 1] == b'\n' {
            out.push(b'\n');
            i += 2;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

fn find_file_recursive(dir: &Path, filename: &str, max_depth: usize) -> bool {
    if max_depth == 0 || !dir.is_dir() { return false; }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_file() {
                if entry.file_name().to_string_lossy().to_lowercase() == filename {
                    return true;
                }
            } else if path.is_dir() {
                if find_file_recursive(&path, filename, max_depth - 1) {
                    return true;
                }
            }
        }
    }
    false
}

/// Batch check which mods exist on disk. Much faster than individual calls.
/// Returns a map of tp2_path → exists (true/false).
#[tauri::command]
pub async fn batch_check_mods_exist(
    mod_dir: String,
    game_dir: String,
    tp2_paths: Vec<String>,
) -> Result<std::collections::HashMap<String, bool>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut found_tp2s = std::collections::HashSet::<String>::new();

        fn index_tp2_files(dir: &Path, found: &mut std::collections::HashSet<String>, depth: usize) {
            if depth == 0 || !dir.is_dir() { return; }
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.filter_map(|e| e.ok()) {
                    let path = entry.path();
                    if path.is_file() {
                        if path.extension().map_or(false, |ext| ext.eq_ignore_ascii_case("tp2")) {
                            found.insert(entry.file_name().to_string_lossy().to_lowercase());
                        }
                    } else if path.is_dir() {
                        index_tp2_files(&path, found, depth - 1);
                    }
                }
            }
        }

        index_tp2_files(Path::new(&mod_dir), &mut found_tp2s, 4);
        index_tp2_files(Path::new(&game_dir), &mut found_tp2s, 4);

        let mut result = std::collections::HashMap::new();
        for tp2_path in &tp2_paths {
            let normalized = tp2_path.replace('\\', "/");
            let tp2_filename = normalized.split('/').last().unwrap_or(tp2_path).to_lowercase();
            // WeiDU logs may reference "klatu.tp2" but the file on disk is "setup-klatu.tp2"
            // (or vice versa). Check both variants.
            let found = found_tp2s.contains(&tp2_filename) || {
                if let Some(stripped) = tp2_filename.strip_prefix("setup-") {
                    found_tp2s.contains(stripped)
                } else {
                    found_tp2s.contains(&format!("setup-{}", tp2_filename))
                }
            };
            result.insert(tp2_path.clone(), found);
        }

        Ok(result)
    }).await.map_err(|e| e.to_string())?
}

// ─── Mod Download ───

/// Download a mod from a URL, extract the ZIP, and copy to the mod directory.
/// Reports progress via Tauri events.
#[tauri::command]
pub async fn download_mod(
    app: AppHandle,
    url: String,
    mod_dir: String,
    mod_name: String,
) -> Result<DownloadResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
    let _ = app.emit("download-progress", serde_json::json!({
        "mod_name": &mod_name, "status": "downloading", "bytes": 0, "total": 0
    }));

    // Download the file
    let response = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?
        .get(&url)
        .header("User-Agent", "EET-Mod-Runner/0.9.0-beta")
        .send()
        .map_err(|e| format!("Download failed: {e}"))?;

    if !response.status().is_success() {
        // Try fallback: if URL was /main.zip, try /master.zip
        if url.contains("/main.zip") {
            let fallback_url = url.replace("/main.zip", "/master.zip");
            let fallback = reqwest::blocking::get(&fallback_url)
                .map_err(|e| format!("Fallback download failed: {e}"))?;
            if fallback.status().is_success() {
                return download_and_extract(app, fallback, &mod_dir, &mod_name);
            }
        }
        return Err(format!("HTTP {}: {}", response.status(), url));
    }

    download_and_extract(app, response, &mod_dir, &mod_name)
    }).await.map_err(|e| e.to_string())?
}

fn download_and_extract(
    app: AppHandle,
    mut response: reqwest::blocking::Response,
    mod_dir: &str,
    mod_name: &str,
) -> Result<DownloadResult, String> {
    use std::io::{Read, Write};

    let total = response.content_length().unwrap_or(0);
    let _ = app.emit("download-progress", serde_json::json!({
        "mod_name": mod_name, "status": "downloading", "bytes": 0, "total": total
    }));

    // Stream to temp file
    let temp_dir = tempfile::tempdir().map_err(|e| format!("Temp dir error: {e}"))?;
    let zip_path = temp_dir.path().join("download.zip");
    let mut file = std::fs::File::create(&zip_path)
        .map_err(|e| format!("File create error: {e}"))?;

    let mut downloaded: u64 = 0;
    let mut buffer = [0u8; 8192];
    loop {
        let n = response.read(&mut buffer).map_err(|e| format!("Read error: {e}"))?;
        if n == 0 { break; }
        file.write_all(&buffer[..n]).map_err(|e| format!("Write error: {e}"))?;
        downloaded += n as u64;

        // Report progress every 64KB
        if downloaded % 65536 < 8192 {
            let _ = app.emit("download-progress", serde_json::json!({
                "mod_name": mod_name, "status": "downloading",
                "bytes": downloaded, "total": total
            }));
        }
    }
    drop(file);

    let _ = app.emit("download-progress", serde_json::json!({
        "mod_name": mod_name, "status": "extracting", "bytes": downloaded, "total": total
    }));

    // Extract ZIP
    let extract_dir = temp_dir.path().join("extracted");
    std::fs::create_dir_all(&extract_dir).map_err(|e| format!("Dir create error: {e}"))?;

    let zip_file = std::fs::File::open(&zip_path).map_err(|e| format!("Zip open error: {e}"))?;
    let mut archive = zip::ZipArchive::new(zip_file).map_err(|e| format!("Zip read error: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("Zip entry error: {e}"))?;
        let out_path = extract_dir.join(entry.mangled_name());

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).ok();
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            let mut out_file = std::fs::File::create(&out_path)
                .map_err(|e| format!("Extract file error: {e}"))?;
            std::io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("Extract copy error: {e}"))?;
        }
    }

    // Find tp2 file in extracted contents
    let tp2_path = find_tp2_in_extracted(&extract_dir);
    if tp2_path.is_none() {
        return Err(format!("No .tp2 file found after extracting {mod_name}. The archive may not be a valid mod."));
    }
    let tp2_path = tp2_path.unwrap();

    // The mod folder is the parent directory containing the tp2
    let mod_folder = tp2_path.parent().unwrap_or(&extract_dir);

    // Copy the mod folder to mod_dir
    let dest = Path::new(mod_dir).join(mod_folder.file_name().unwrap_or(std::ffi::OsStr::new(mod_name)));
    if !dest.exists() {
        copy_dir_recursive(mod_folder, &dest)?;
    }

    // Verify tp2 exists in destination
    let tp2_filename = tp2_path.file_name().unwrap().to_string_lossy().to_lowercase();
    let verified = find_file_recursive(&dest, &tp2_filename, 3);

    let _ = app.emit("download-progress", serde_json::json!({
        "mod_name": mod_name, "status": if verified { "done" } else { "verify_failed" },
        "bytes": downloaded, "total": total
    }));

    Ok(DownloadResult {
        success: verified,
        mod_name: mod_name.to_string(),
        bytes_downloaded: downloaded,
        message: if verified {
            format!("Downloaded and extracted to {}", dest.display())
        } else {
            "Downloaded but tp2 verification failed".to_string()
        },
    })
}

/// Find a .tp2 file recursively in extracted directory
fn find_tp2_in_extracted(dir: &Path) -> Option<std::path::PathBuf> {
    if !dir.is_dir() { return None; }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_file() {
                if path.extension().map_or(false, |ext| ext.eq_ignore_ascii_case("tp2")) {
                    return Some(path);
                }
            }
        }
        // Check subdirs (depth-first)
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                if entry.path().is_dir() {
                    if let Some(found) = find_tp2_in_extracted(&entry.path()) {
                        return Some(found);
                    }
                }
            }
        }
    }
    None
}

/// Recursively copy a directory
fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("mkdir error: {e}"))?;
    if let Ok(entries) = std::fs::read_dir(src) {
        for entry in entries.filter_map(|e| e.ok()) {
            let src_path = entry.path();
            let dest_path = dest.join(entry.file_name());
            if src_path.is_dir() {
                copy_dir_recursive(&src_path, &dest_path)?;
            } else {
                std::fs::copy(&src_path, &dest_path)
                    .map_err(|e| format!("copy error: {e}"))?;
            }
        }
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct DownloadResult {
    pub success: bool,
    pub mod_name: String,
    pub bytes_downloaded: u64,
    pub message: String,
}

// ─── Install Comparison ───

/// Compare an exported WeiDU.log against what's actually installed in the game directory.
/// Parses both logs, diffs them, and groups missing components by mod.
#[tauri::command]
pub async fn compare_install_logs(export_log_path: String, game_dir: String) -> Result<CompareResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
    let export_entries = parse_weidu_log_file(&export_log_path)?;

    // Parse installed logs from game dir (both BG2 and BGEE if present)
    let bg2_log = Path::new(&game_dir).join("WeiDU.log");
    let bgee_log = Path::new(&game_dir).join("WeiDU-BGEE.log");

    let mut installed_entries = Vec::new();
    if bg2_log.exists() {
        installed_entries.extend(parse_weidu_log_file(&bg2_log.to_string_lossy())?);
    }
    if bgee_log.exists() {
        installed_entries.extend(parse_weidu_log_file(&bgee_log.to_string_lossy())?);
    }

    // Also check parent dir for BGEE log (BG1 game dir is separate)
    // Try common BGEE locations based on the BG2 path
    let bg2_path = Path::new(&game_dir);
    if let Some(parent) = bg2_path.parent() {
        // e.g., .../Baldur's Gate Enhanced Edition/WeiDU-BGEE.log
        for sibling in &["Baldur's Gate Enhanced Edition", "Baldur's Gate - Enhanced Edition"] {
            let bg1_log = parent.join(sibling).join("WeiDU.log");
            if bg1_log.exists() && bg1_log != bg2_log {
                installed_entries.extend(parse_weidu_log_file(&bg1_log.to_string_lossy())?);
            }
        }
    }

    // Build installed set: (tp2_path_lower, component_number)
    let installed_set: std::collections::HashSet<(String, String)> = installed_entries
        .iter()
        .map(|e| (e.tp2_lower.clone(), e.component.clone()))
        .collect();

    // Find missing entries and group by mod
    let mut mod_groups: std::collections::HashMap<String, ModCompareGroup> = std::collections::HashMap::new();

    for entry in &export_entries {
        let key = (entry.tp2_lower.clone(), entry.component.clone());
        let mod_name = entry.mod_name.clone();

        let group = mod_groups.entry(mod_name.clone()).or_insert_with(|| ModCompareGroup {
            mod_name: mod_name.clone(),
            total_in_export: 0,
            installed_count: 0,
            missing_components: Vec::new(),
        });
        group.total_in_export += 1;

        if installed_set.contains(&key) {
            group.installed_count += 1;
        } else {
            group.missing_components.push(entry.display_name.clone());
        }
    }

    // Build result
    let mut missing_mods: Vec<MissingMod> = Vec::new();
    let mut partial_mods = 0usize;
    let mut completely_missing_mods = 0usize;
    let mut total_missing = 0usize;

    for group in mod_groups.values() {
        if group.missing_components.is_empty() {
            continue;
        }
        total_missing += group.missing_components.len();
        if group.installed_count == 0 {
            completely_missing_mods += 1;
        } else {
            partial_mods += 1;
        }
        missing_mods.push(MissingMod {
            mod_name: group.mod_name.clone(),
            missing_components: group.missing_components.clone(),
            total_in_export: group.total_in_export,
            installed_count: group.installed_count,
        });
    }

    // Sort: completely missing first (by component count desc), then partial
    missing_mods.sort_by(|a, b| {
        let a_complete = a.installed_count == 0;
        let b_complete = b.installed_count == 0;
        b_complete.cmp(&a_complete)
            .then(b.missing_components.len().cmp(&a.missing_components.len()))
    });

    Ok(CompareResult {
        export_count: export_entries.len(),
        installed_count: installed_entries.len(),
        missing_count: total_missing,
        missing_mods,
        partial_mods,
        completely_missing_mods,
    })
    }).await.map_err(|e| e.to_string())?
}

struct WeiduLogEntry {
    tp2_lower: String,
    mod_name: String,
    component: String,
    display_name: String,
}

struct ModCompareGroup {
    mod_name: String,
    total_in_export: usize,
    installed_count: usize,
    missing_components: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct CompareResult {
    pub export_count: usize,
    pub installed_count: usize,
    pub missing_count: usize,
    pub missing_mods: Vec<MissingMod>,
    pub partial_mods: usize,
    pub completely_missing_mods: usize,
}

#[derive(serde::Serialize)]
pub struct MissingMod {
    pub mod_name: String,
    pub missing_components: Vec<String>,
    pub total_in_export: usize,
    pub installed_count: usize,
}

/// Parse a WeiDU.log file into structured entries.
fn parse_weidu_log_file(path: &str) -> Result<Vec<WeiduLogEntry>, String> {
    let bytes = std::fs::read(path)
        .map_err(|e| format!("Failed to read {path}: {e}"))?;
    let contents = String::from_utf8_lossy(&bytes);

    let mut entries = Vec::new();
    for line in contents.lines() {
        let line = line.trim();
        if !line.starts_with('~') { continue; }

        // Format: ~tp2_path~ #lang #component // name
        let parts: Vec<&str> = line.splitn(2, '~').skip(1).collect();
        if parts.is_empty() { continue; }
        let rest = parts[0];
        // Find the closing ~
        if let Some(tilde_pos) = rest.find('~') {
            let tp2_path = &rest[..tilde_pos];
            let after_tilde = rest[tilde_pos + 1..].trim();

            // Parse #lang #component
            let nums: Vec<&str> = after_tilde.split_whitespace().collect();
            let component = if nums.len() >= 2 {
                nums[1].trim_start_matches('#').to_string()
            } else {
                continue;
            };

            // Extract mod name from tp2 path
            let tp2_lower = tp2_path.to_lowercase();
            let tp2_normalized = tp2_lower.replace('\\', "/");
            let path_parts: Vec<&str> = tp2_normalized.split('/').map(|s| s.trim()).collect();
            let mod_name = if path_parts.len() > 1 {
                path_parts[0].to_string()
            } else {
                tp2_lower.replace(".tp2", "")
            };

            // Display name from comment
            let display_name = if let Some(comment_pos) = after_tilde.find("//") {
                after_tilde[comment_pos + 2..].trim().to_string()
            } else {
                format!("#{component}")
            };

            entries.push(WeiduLogEntry {
                tp2_lower,
                mod_name,
                component,
                display_name,
            });
        }
    }
    Ok(entries)
}

/// Read a file's contents as a string (for importing logs, debug files).
/// Uses lossy UTF-8 conversion to handle WeiDU debug logs that contain
/// non-UTF-8 bytes (extended ASCII, binary fragments).
/// Caps at 50MB to avoid freezing the WebView.
#[tauri::command]
pub async fn read_file_contents(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let metadata = std::fs::metadata(&path)
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        if metadata.len() > 50 * 1024 * 1024 {
            return Err(format!(
                "File too large ({:.0} MB). Use 'Parse Debug File' for large WSETUP.DEBUG files.",
                metadata.len() as f64 / (1024.0 * 1024.0)
            ));
        }
        let bytes = std::fs::read(&path)
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }).await.map_err(|e| e.to_string())?
}

/// Parse a large WeiDU debug log in the Rust backend (for files too big for the WebView).
/// Scans line-by-line without loading the entire file into memory.
#[tauri::command]
pub async fn parse_debug_file(path: String) -> Result<DebugParseSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
    use std::io::{BufRead, BufReader};

    let file = std::fs::File::open(&path)
        .map_err(|e| format!("Failed to open {path}: {e}"))?;
    let reader = BufReader::new(file);

    let mut weidu_ver: Option<String> = None;
    let mut errors: Vec<DebugIssue> = Vec::new();
    let mut warnings: Vec<DebugIssue> = Vec::new();
    let mut success: Vec<String> = Vec::new();
    let mut installed_with_warnings: usize = 0;  // Count of "INSTALLED WITH WARNINGS" result lines
    let mut total_lines: usize = 0;

    let error_patterns: &[(&str, &str)] = &[
        ("NOT INSTALLED DUE TO ERRORS", "install_failed"),
        ("ERROR Installing", "install_error"),
        ("ERROR Re-Installing", "reinstall_error"),
        ("Unable to Unify", "unify_error"),
    ];

    // INSTALLED WITH WARNINGS is tracked separately (in installed_with_warnings counter).
    // warn_patterns is empty — real WARNING: lines are caught by the starts_with check below.
    let warn_patterns: &[(&str, &str)] = &[];

    // Track seen error messages to deduplicate
    // (WeiDU prints both "ERROR Installing [X]" and "NOT INSTALLED DUE TO ERRORS X")
    let mut seen_errors = std::collections::HashSet::<String>::new();

    for line_result in reader.split(b'\n') {
        let raw = match line_result {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(_) => continue,
        };
        total_lines += 1;
        let line = raw.trim();

        // Extract WeiDU version
        if weidu_ver.is_none() {
            if let Some(pos) = line.to_lowercase().find("weidu v") {
                let ver_str = &line[pos..];
                if let Some(end) = ver_str.find(|c: char| c == '\r' || c == '\n') {
                    weidu_ver = Some(ver_str[..end].trim().to_string());
                } else {
                    weidu_ver = Some(ver_str.trim().to_string());
                }
            }
        }

        // Check success (cap at 2000 to avoid huge response)
        // Count both clean installs and installs with warnings as "installed"
        if line.contains("SUCCESSFULLY INSTALLED") && success.len() < 2000 {
            success.push(line.chars().take(200).collect());
            continue;
        }
        if line.contains("INSTALLED WITH WARNINGS") && success.len() < 2000 {
            installed_with_warnings += 1;
            success.push(line.chars().take(200).collect());
            continue;
        }

        // Check errors (cap at 500, deduplicate)
        if errors.len() < 500 {
            for &(pattern, cat) in error_patterns {
                if line.contains(pattern) {
                    // Extract mod name for dedup: "ERROR Installing [Valen]" → "Valen"
                    let msg: String = line.chars().take(250).collect();
                    let dedup_key = if let Some(start) = msg.find('[') {
                        if let Some(end) = msg.find(']') {
                            msg[start + 1..end].to_string()
                        } else {
                            msg.clone()
                        }
                    } else {
                        // "NOT INSTALLED DUE TO ERRORS Valen" → extract after pattern
                        msg.replace(pattern, "").trim().to_string()
                    };

                    let dedup_key = format!("{cat}:{dedup_key}");
                    if !seen_errors.contains(&dedup_key) {
                        seen_errors.insert(dedup_key);
                        errors.push(DebugIssue {
                            line_num: total_lines,
                            category: cat.to_string(),
                            message: msg,
                        });
                    }
                    break;
                }
            }
        }

        // Check warnings — only real WeiDU warnings
        // "INSTALLED WITH WARNINGS" is a result line (always relevant)
        // "WARNING:" at start of line is a WeiDU diagnostic (usually relevant)
        // Skip: lines that just contain "WARNING" as part of a string/menu/lua text
        if warnings.len() < 500 {
            // First check specific patterns
            for &(pattern, cat) in warn_patterns {
                if line.contains(pattern) {
                    warnings.push(DebugIssue {
                        line_num: total_lines,
                        category: cat.to_string(),
                        message: line.chars().take(250).collect(),
                    });
                    break;
                }
            }
            // Then check lines starting with "WARNING:" (WeiDU's format)
            if line.starts_with("WARNING:") || line.starts_with("WARNING ") {
                // Filter out noise: menu text, lua strings, "no longer needs fixing"
                let is_noise = line.contains("no longer needs fixing")
                    || line.contains("Infinity_PushMenu")
                    || line.contains("eetStrings.")
                    || line.contains("name '")
                    || line.contains("text lua");
                if !is_noise {
                    warnings.push(DebugIssue {
                        line_num: total_lines,
                        category: "warning".to_string(),
                        message: line.chars().take(250).collect(),
                    });
                }
            }
        }
    }

    let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

    Ok(DebugParseSummary {
        weidu_version: weidu_ver,
        errors,
        warnings,
        success_count: success.len(),
        installed_with_warnings,
        success_sample: success.into_iter().take(50).collect(),
        total_lines,
        file_size_mb: (file_size as f64 / (1024.0 * 1024.0) * 10.0).round() / 10.0,
    })
    }).await.map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct DebugParseSummary {
    pub weidu_version: Option<String>,
    pub errors: Vec<DebugIssue>,
    pub warnings: Vec<DebugIssue>,
    pub success_count: usize,
    pub installed_with_warnings: usize,
    pub success_sample: Vec<String>,
    pub total_lines: usize,
    pub file_size_mb: f64,
}

#[derive(serde::Serialize)]
pub struct DebugIssue {
    pub line_num: usize,
    pub category: String,
    pub message: String,
}

// ─── GUI Logging ───

/// Path to the gui.log file in the app config directory.
fn gui_log_path() -> Result<std::path::PathBuf, String> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| "Cannot determine config directory".to_string())?;
    let app_dir = config_dir.join("infinity-mod-runner");
    std::fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create config dir: {e}"))?;
    Ok(app_dir.join(crate::paths::FILE_GUI_LOG))
}

/// State file next to gui.log, tracking the last logged version so rotate_gui_log
/// can detect version bumps without parsing the log itself.
fn gui_log_state_path() -> Result<std::path::PathBuf, String> {
    Ok(gui_log_path()?.with_file_name("gui.log.state.json"))
}

const GUI_LOG_SIZE_CAP: u64 = 5 * 1024 * 1024; // 5 MB
const GUI_LOG_NUMBERED_MAX: u32 = 3;            // gui.log.1, .2, .3
const GUI_LOG_TOTAL_CAP: usize = 10;            // hard cap across all generations

/// Result of rotate_gui_log: rotated/reason/prev_file for a SESSION-START line,
/// plus optional health warnings that surface silent failures from a previous
/// session (e.g. frontend crashed before calling rotate, so gui.log grew past
/// the size cap without being rotated).
#[derive(serde::Serialize)]
pub struct GuiLogRotateResult {
    pub rotated: bool,
    pub reason: String,
    pub prev_file: Option<String>,
    /// Non-empty if the pre-rotation state of gui.log looked unhealthy.
    /// Frontend surfaces these as WARN log lines.
    pub health_warnings: Vec<String>,
}

/// Rotate `gui.log` on app startup. Idempotent per process: the first call per
/// session does the work, subsequent calls are no-ops so background writes during
/// the same session don't trigger additional rotations.
///
/// Rules, evaluated in this order:
///   1. If the app version differs from the last-logged version → rename
///      `gui.log` → `gui.log.prev-<old_version>` and start fresh.
///   2. Otherwise, if `gui.log` > 5 MB → shift `gui.log.2→3`, `.1→2`, `.0→.1`,
///      move `gui.log → gui.log.1`. Keep 3 numbered generations.
///   3. Otherwise → nothing.
///
/// After rotating, sweep `gui.log.prev-*` files if the total count across all
/// generations exceeds `GUI_LOG_TOTAL_CAP`. Oldest-mtime prev files go first.
#[tauri::command]
pub async fn rotate_gui_log(current_version: String) -> Result<GuiLogRotateResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        static ROTATED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if ROTATED.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Ok(GuiLogRotateResult {
                rotated: false, reason: "already rotated this session".into(),
                prev_file: None, health_warnings: Vec::new(),
            });
        }

        let log_path = gui_log_path()?;
        let state_path = gui_log_state_path()?;
        let log_dir = log_path.parent()
            .ok_or_else(|| "gui.log has no parent dir".to_string())?
            .to_path_buf();

        // Load previous state
        let prev_version: Option<String> = std::fs::read_to_string(&state_path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.get("last_version").and_then(|x| x.as_str()).map(String::from));

        let log_exists = log_path.exists();
        let log_size = std::fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);

        // ── Health observations (pre-rotation state of previous session) ──
        // The whole point of this block is to catch cases where the PREVIOUS
        // session failed to rotate — e.g. the frontend crashed before calling
        // `rotate_gui_log`. We don't act on these here (rotation still runs
        // normally below); we just record them so the frontend can surface a
        // WARN. If a warning recurs across launches, that's the signal we want.
        let mut health_warnings: Vec<String> = Vec::new();

        // H1: gui.log exceeds the size cap by a meaningful margin (2×) despite
        //     the previous session presumably having had a chance to rotate.
        //     The normal size-cap rotation rule below will handle it; we just
        //     note that it happened for visibility.
        if log_exists && log_size > GUI_LOG_SIZE_CAP * 2 {
            health_warnings.push(format!(
                "gui.log was {:.1} MB at startup (>2× cap) — previous session likely did not call rotate_gui_log",
                log_size as f64 / 1_048_576.0
            ));
        }

        // H2: state file missing but gui.log is large enough that we'd have
        //     expected at least one rotation to have written the state. Implies
        //     the frontend has never successfully called rotate_gui_log.
        if log_exists && log_size > GUI_LOG_SIZE_CAP && !state_path.exists() {
            health_warnings.push(
                "gui.log.state.json missing despite gui.log exceeding size cap — frontend may never have successfully completed a rotate_gui_log call".to_string()
            );
        }

        // H3: orphan numbered generations beyond GUI_LOG_NUMBERED_MAX that we'd
        //     never create ourselves — something external wrote them, or older
        //     code left them behind. Purely informational.
        let orphan_count = (GUI_LOG_NUMBERED_MAX + 1..=20)
            .filter(|i| log_dir.join(format!("gui.log.{i}")).exists())
            .count();
        if orphan_count > 0 {
            health_warnings.push(format!(
                "found {orphan_count} orphan gui.log.N files beyond generation {GUI_LOG_NUMBERED_MAX} — safe to delete manually"
            ));
        }

        let mut result = GuiLogRotateResult {
            rotated: false, reason: String::new(), prev_file: None,
            health_warnings,
        };

        // Rule 1: version bump
        if log_exists && prev_version.as_deref().is_some_and(|v| v != current_version) {
            let old_ver = prev_version.as_deref().unwrap_or("unknown");
            let safe_ver = old_ver.replace(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '-', "_");
            let target = log_dir.join(format!("gui.log.prev-{safe_ver}"));
            let _ = std::fs::rename(&log_path, &target);
            result.rotated = true;
            result.reason = format!("version bump {old_ver} → {current_version}");
            result.prev_file = Some(target.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string());
        }
        // Rule 2: size cap
        else if log_exists && log_size > GUI_LOG_SIZE_CAP {
            // Shift existing numbered gens: drop .N, shift N-1→N, …, 1→2
            let drop_path = log_dir.join(format!("gui.log.{GUI_LOG_NUMBERED_MAX}"));
            let _ = std::fs::remove_file(&drop_path);
            for i in (1..GUI_LOG_NUMBERED_MAX).rev() {
                let from = log_dir.join(format!("gui.log.{i}"));
                let to = log_dir.join(format!("gui.log.{}", i + 1));
                if from.exists() { let _ = std::fs::rename(&from, &to); }
            }
            // Move current gui.log → gui.log.1
            let one = log_dir.join("gui.log.1");
            let _ = std::fs::rename(&log_path, &one);
            result.rotated = true;
            result.reason = format!("size cap {:.1} MB > 5 MB", log_size as f64 / 1_048_576.0);
            result.prev_file = Some("gui.log.1".to_string());
        }

        // Persist the new version stamp
        let new_state = serde_json::json!({ "last_version": current_version });
        let _ = std::fs::write(&state_path, serde_json::to_string_pretty(&new_state).unwrap_or_default());

        // Total-cap cleanup: if (numbered + prev-*) > GUI_LOG_TOTAL_CAP, remove oldest prev-* files.
        if let Ok(entries) = std::fs::read_dir(&log_dir) {
            let mut prev_files: Vec<(std::path::PathBuf, std::time::SystemTime)> = entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.file_name().to_string_lossy().starts_with("gui.log.prev-")
                })
                .filter_map(|e| e.metadata().ok().and_then(|m| m.modified().ok()).map(|t| (e.path(), t)))
                .collect();

            let numbered_count = (1..=GUI_LOG_NUMBERED_MAX)
                .filter(|i| log_dir.join(format!("gui.log.{i}")).exists())
                .count();
            let total = prev_files.len() + numbered_count;
            if total > GUI_LOG_TOTAL_CAP {
                let to_drop = total - GUI_LOG_TOTAL_CAP;
                prev_files.sort_by_key(|(_, t)| *t);
                for (p, _) in prev_files.into_iter().take(to_drop) {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }

        Ok(result)
    }).await.map_err(|e| e.to_string())?
}

/// Append an entry to gui.log. Timestamp provided by the frontend (ISO format).
/// Rotation happens exclusively via `rotate_gui_log` on startup — no inline rotation
/// from the write path.
#[tauri::command]
pub fn gui_log(timestamp: String, level: String, category: String, message: String) -> Result<(), String> {
    use std::io::Write;
    let path = gui_log_path()?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open gui.log: {e}"))?;

    writeln!(file, "{timestamp} [{level}] [{category}] {message}")
        .map_err(|e| format!("Failed to write gui.log: {e}"))?;
    Ok(())
}

/// Read the gui.log contents (for export/debug panel).
#[tauri::command]
pub async fn read_gui_log() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = gui_log_path()?;
        if !path.exists() {
            return Ok(String::new());
        }
        std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read gui.log: {e}"))
    }).await.map_err(|e| e.to_string())?
}

/// Clear the gui.log (start fresh).
#[tauri::command]
pub async fn clear_gui_log() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = gui_log_path()?;
        if path.exists() {
            std::fs::write(&path, "")
                .map_err(|e| format!("Failed to clear gui.log: {e}"))?;
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

/// Get the path to gui.log (so users know where to find it).
#[tauri::command]
pub async fn get_gui_log_path() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        gui_log_path().map(|p| p.to_string_lossy().to_string())
    }).await.map_err(|e| e.to_string())?
}

/// Search PATH for a binary by name.
fn which(name: &str) -> Result<String, ()> {
    let path_var = std::env::var("PATH").map_err(|_| ())?;
    let sep = if cfg!(windows) { ';' } else { ':' };
    for dir in path_var.split(sep) {
        let candidate = Path::new(dir).join(name);
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }
    Err(())
}

// ─── Download Plan Cache ───

/// Write a filtered WeiDU.log to a temp file.
/// Used when the user has excluded components from the install order.
#[tauri::command]
pub async fn write_temp_log(content: String, filename: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let temp_dir = std::env::temp_dir().join("infinity-mod-runner");
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("Failed to create temp dir: {e}"))?;
        let path = temp_dir.join(&filename);
        std::fs::write(&path, &content)
            .map_err(|e| format!("Failed to write temp log: {e}"))?;
        Ok(path.to_string_lossy().to_string())
    }).await.map_err(|e| e.to_string())?
}

/// Path to the download plan cache file in the app config directory.
fn download_cache_path() -> Result<std::path::PathBuf, String> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| "Cannot determine config directory".to_string())?;
    let app_dir = config_dir.join("infinity-mod-runner");
    std::fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create config dir: {e}"))?;
    Ok(app_dir.join("download_cache.json"))
}

/// Count installed components by reading the game's weidu.log directly.
/// This is the ground truth — WeiDU writes to it after every component.
#[tauri::command]
pub async fn count_weidu_log_entries(game_dir: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let log_path = Path::new(&game_dir).join("weidu.log");
        if !log_path.exists() {
            return Ok(0);
        }
        // Use share mode on Windows for concurrent access
        #[cfg(target_os = "windows")]
        let contents = {
            use std::os::windows::fs::OpenOptionsExt;
            let file = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0x00000001 | 0x00000002 | 0x00000004)
                .open(&log_path)
                .map_err(|e| format!("weidu.log open: {e}"))?;
            use std::io::Read;
            let mut buf = Vec::new();
            let mut reader = std::io::BufReader::new(file);
            reader.read_to_end(&mut buf).map_err(|e| format!("weidu.log read: {e}"))?;
            String::from_utf8_lossy(&buf).to_string()
        };
        #[cfg(not(target_os = "windows"))]
        let contents = std::fs::read_to_string(&log_path)
            .map_err(|e| format!("weidu.log read: {e}"))?;
        // Count lines starting with ~ (actual mod entries)
        let count = contents.lines().filter(|l| l.starts_with('~')).count();
        Ok(count)
    }).await.map_err(|e| e.to_string())?
}

/// Save the download plan entries as JSON for persistence across sessions.
#[tauri::command]
pub fn save_download_cache(data: String) -> Result<(), String> {
    let path = download_cache_path()?;
    std::fs::write(&path, &data)
        .map_err(|e| format!("Failed to write download cache: {e}"))
}

/// Load the cached download plan from disk.
#[tauri::command]
pub fn load_download_cache() -> Result<Option<String>, String> {
    let path = download_cache_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read download cache: {e}"))?;
    Ok(Some(contents))
}

// ─── Install Report ───

/// Save an install report JSON to the specified path.
#[tauri::command]
pub fn save_install_report(report_json: String, path: String) -> Result<(), String> {
    let dest = std::path::Path::new(&path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {e}"))?;
    }
    std::fs::write(dest, &report_json)
        .map_err(|e| format!("Failed to write install report: {e}"))
}

// ─── Native WeiDU Installer ───

use crate::installer::orchestrator::{InstallState, PausePoint, run_eet_install};
use crate::installer::{InstallConfig, ErrorDecision};

/// Global install state — shared between the orchestrator thread and Tauri commands.
static NATIVE_INSTALL_STATE: std::sync::LazyLock<InstallState> =
    std::sync::LazyLock::new(InstallState::new);

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInstallArgs {
    pub weidu_path: String,
    pub bg2_game_dir: String,
    pub bg1_game_dir: Option<String>,
    pub mod_directory: String,
    pub eet_log_path: String,
    pub bgee_log_path: Option<String>,
    pub language: String,
    pub language_index: u32,
    pub skip_installed: bool,
    pub timeout: u64,
    pub never_abort: bool,
    pub abort_on_warnings: bool,
    pub weidu_log_mode: String,
    pub max_batch_size: Option<usize>,
    /// Heavy-mod batch size override. When None, falls back to
    /// `installer::FORCE_SMALL_BATCH_SIZE` (3). Values >3 are experimental —
    /// some heavy mods segfault WeiDU with larger batches.
    pub heavy_batch_size: Option<usize>,
    pub pause_points: Vec<PausePointArg>,
    pub bcs_scanner: Option<bool>,
    pub auto_skip_after_retry: Option<bool>,
    pub suppress_readmes: Option<bool>,
    pub data_directory: Option<String>,
    pub pause_on_guard: Option<bool>,
    /// Redirect override/ to a fast drive for the install. Off by default.
    pub override_fast_drive: Option<bool>,
    /// Target path for the override redirect (e.g. `R:\\` for a RAM disk).
    /// Must be on a different volume than the game for any benefit.
    pub override_fast_drive_path: Option<String>,
    /// If true (default), the pre-biff optimization deletes original files
    /// from override/ after MAKE_BIFF succeeds. The original behavior kept
    /// them there, which meant MAKE_BIFF had no effect on WeiDU's iteration
    /// cost — override/ stayed at ~122k files on a megainstall, and SFO-
    /// heavy mods walked all of them. With cleanup on, override/ drops to
    /// a few dozen files post-BIFF. Defaults to true on new installs.
    ///
    /// Precedence order: install_config.json's top-level
    /// `enable_biff_delete_optimization` wins over this UI value when set
    /// (so the A/B test harness can pin the flag from JSON alone). If
    /// install_config.json doesn't set it, the UI/default value here
    /// applies.
    pub enable_biff_delete_optimization: Option<bool>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PausePointArg {
    pub after_mod_index: usize,
    pub message: String,
    pub phase: String,
}

/// Start a native EET install. Runs in a background thread, streaming
/// events to the GUI.
#[tauri::command]
pub async fn start_native_install(
    app: AppHandle,
    args: NativeInstallArgs,
) -> Result<(), String> {
    if NATIVE_INSTALL_STATE.running.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("Install already running".to_string());
    }

    let mut config = InstallConfig {
        weidu_path: std::path::PathBuf::from(&args.weidu_path),
        bg2_game_dir: std::path::PathBuf::from(&args.bg2_game_dir),
        bg1_game_dir: args.bg1_game_dir.as_ref().map(std::path::PathBuf::from),
        mod_directory: std::path::PathBuf::from(&args.mod_directory),
        language: args.language.clone(),
        language_index: args.language_index,
        max_batch_size: args.max_batch_size.unwrap_or(25),
        skip_installed: args.skip_installed,
        timeout_secs: args.timeout,
        weidu_log_mode: args.weidu_log_mode.clone(),
        never_abort: args.never_abort,
        abort_on_warnings: args.abort_on_warnings,
        post_copy_delay_ms: 0, // sync_all() handles flush; delay only needed for network drives
        ocamlrunparam: "s=16M,o=500,O=1000000".to_string(),
        bcs_scanner: args.bcs_scanner.unwrap_or(false),
        // Populated from RuntimeConfig below; defaults here just so the struct
        // is constructible before that override lands.
        force_small_batch_mods: crate::installer::FORCE_SMALL_BATCH_MODS.iter().map(|s| s.to_string()).collect(),
        // Frontend-driven override; falls back to the compile-time default
        // (3) when the user hasn't touched the setting.
        force_small_batch_size: args.heavy_batch_size.unwrap_or(crate::installer::FORCE_SMALL_BATCH_SIZE),
        // Populated from RuntimeConfig immediately after construction.
        per_mod_timeout_secs: std::collections::HashMap::new(),
        force_single_cn_mods: std::collections::HashMap::new(),
        auto_skip_after_retry: args.auto_skip_after_retry.unwrap_or(false),
        suppress_readmes: args.suppress_readmes.unwrap_or(true),
        sibling_directories: std::collections::HashMap::new(),
        readln_defaults: std::collections::HashMap::new(),
        readln_fallback: "1".to_string(),
        readln_timeout_secs: 30,
        data_directory: args.data_directory.clone(),
        tlk_prewarm: true,
        tlk_fast_drive: false,
        tlk_fast_drive_path: None,
        override_fast_drive: args.override_fast_drive.unwrap_or(false),
        override_fast_drive_path: args.override_fast_drive_path.clone(),
        pause_on_guard: args.pause_on_guard.unwrap_or(false),
        enable_biff_delete_optimization: args.enable_biff_delete_optimization.unwrap_or(true),
    };

    // Load runtime config (readln defaults, etc.) from bundled install_config.json
    if let Ok(exe_dir) = std::env::current_exe().and_then(|p| Ok(p.parent().unwrap_or(std::path::Path::new(".")).to_path_buf())) {
        let rt = crate::installer::RuntimeConfig::load(&exe_dir);
        config.readln_defaults = rt.readln_defaults;
        config.readln_fallback = rt.readln_fallback;
        config.readln_timeout_secs = rt.readln_timeout_secs;
        config.sibling_directories = rt.sibling_directories.clone();
        config.force_small_batch_mods = rt.force_small_batch_mods;
        // Precedence: UI setting (args.heavy_batch_size) wins over
        // install_config.json's force_small_batch_size. Without this guard,
        // a user who cranked Heavy batch size to 10 in the Install tab
        // would get silently reverted to the JSON default — exactly what
        // happened to the 11.6h install, where heavy=10 was set in the UI
        // and immediately clobbered to 3 right before the batch planner
        // ran. RuntimeConfig still wins when the UI hasn't passed a value
        // (i.e. programmatic callers / legacy paths).
        if args.heavy_batch_size.is_none() {
            config.force_small_batch_size = rt.force_small_batch_size;
        }
        config.per_mod_timeout_secs = rt.per_mod_timeout_secs;
        config.force_single_cn_mods = rt.force_single_cn_mods;
        // Precedence for the BIFF-delete A/B toggle: install_config.json
        // wins over whatever the UI passed. This lets the A/B harness pin
        // the variant from JSON alone — no UI toggling between runs.
        if let Some(v) = rt.enable_biff_delete_optimization {
            config.enable_biff_delete_optimization = v;
        }
    }

    let pause_points: Vec<PausePoint> = args.pause_points.iter().map(|p| PausePoint {
        after_mod_index: p.after_mod_index,
        message: p.message.clone(),
        phase: p.phase.clone(),
    }).collect();

    let eet_log = std::path::PathBuf::from(&args.eet_log_path);
    let bgee_log = args.bgee_log_path.as_ref().map(std::path::PathBuf::from);

    // Run the install in a background thread
    tauri::async_runtime::spawn_blocking(move || {
        let bgee_ref = bgee_log.as_deref();
        // run_eet_install emits install:complete via tracker internally
        let _summary = run_eet_install(
            &app, &config, bgee_ref, &eet_log, &pause_points, &NATIVE_INSTALL_STATE,
        );
    });

    Ok(())
}

/// Run a dry run — validates the pipeline without executing WeiDU.
#[tauri::command]
pub async fn start_dry_run(
    app: AppHandle,
    args: NativeInstallArgs,
) -> Result<(), String> {
    let mut config = InstallConfig {
        weidu_path: std::path::PathBuf::from(&args.weidu_path),
        bg2_game_dir: std::path::PathBuf::from(&args.bg2_game_dir),
        bg1_game_dir: args.bg1_game_dir.as_ref().map(std::path::PathBuf::from),
        mod_directory: std::path::PathBuf::from(&args.mod_directory),
        language: args.language.clone(),
        language_index: 0,
        max_batch_size: args.max_batch_size.unwrap_or(25),
        skip_installed: args.skip_installed,
        timeout_secs: args.timeout,
        weidu_log_mode: args.weidu_log_mode.clone(),
        never_abort: true,
        abort_on_warnings: false,
        post_copy_delay_ms: 0,
        ocamlrunparam: String::new(),
        bcs_scanner: false,
        force_small_batch_mods: crate::installer::FORCE_SMALL_BATCH_MODS.iter().map(|s| s.to_string()).collect(),
        // Same override as start_native_install — the dry run must honour the
        // user's heavy_batch_size setting so batch/timing estimates reflect
        // what the real install will do.
        force_small_batch_size: args.heavy_batch_size.unwrap_or(crate::installer::FORCE_SMALL_BATCH_SIZE),
        per_mod_timeout_secs: std::collections::HashMap::new(),
        force_single_cn_mods: std::collections::HashMap::new(),
        auto_skip_after_retry: false,
        suppress_readmes: true,
        sibling_directories: std::collections::HashMap::new(),
        readln_defaults: std::collections::HashMap::new(),
        readln_fallback: "1".to_string(),
        readln_timeout_secs: 30,
        data_directory: args.data_directory.clone(),
        tlk_prewarm: true,
        tlk_fast_drive: false,
        tlk_fast_drive_path: None,
        override_fast_drive: args.override_fast_drive.unwrap_or(false),
        override_fast_drive_path: args.override_fast_drive_path.clone(),
        pause_on_guard: args.pause_on_guard.unwrap_or(false),
        enable_biff_delete_optimization: args.enable_biff_delete_optimization.unwrap_or(true),
    };

    if let Ok(exe_dir) = std::env::current_exe().and_then(|p| Ok(p.parent().unwrap_or(std::path::Path::new(".")).to_path_buf())) {
        let rt = crate::installer::RuntimeConfig::load(&exe_dir);
        config.readln_defaults = rt.readln_defaults;
        config.readln_fallback = rt.readln_fallback;
        config.readln_timeout_secs = rt.readln_timeout_secs;
        config.sibling_directories = rt.sibling_directories.clone();
        config.force_small_batch_mods = rt.force_small_batch_mods;
        // See start_native_install for the same guard: UI setting wins over
        // install_config.json. Without this, a dry run with heavy=10 in the
        // UI would still project batch counts at heavy=3 (19 batches for
        // dw_talents instead of 8) — which is exactly what was happening
        // and why the heavy-batch feature looked dead despite the full
        // UI → IPC wiring being correct end-to-end.
        if args.heavy_batch_size.is_none() {
            config.force_small_batch_size = rt.force_small_batch_size;
        }
        config.per_mod_timeout_secs = rt.per_mod_timeout_secs;
        config.force_single_cn_mods = rt.force_single_cn_mods;
        // Mirrors start_native_install: install_config.json's BIFF toggle
        // wins over UI. Dry run honours it too so the plan preview matches
        // what the real install will do.
        if let Some(v) = rt.enable_biff_delete_optimization {
            config.enable_biff_delete_optimization = v;
        }
    }

    let eet_log = std::path::PathBuf::from(&args.eet_log_path);
    let bgee_log = args.bgee_log_path.as_ref().map(std::path::PathBuf::from);

    tauri::async_runtime::spawn_blocking(move || {
        let bgee_ref = bgee_log.as_deref();
        let _report = crate::installer::dry_run::run_dry_run(
            &app, &config, bgee_ref, &eet_log,
        );
    });

    Ok(())
}

/// Send a Retry/Skip/Stop decision to the running install.
#[tauri::command]
pub fn install_decision(decision: String) -> Result<(), String> {
    let d = match decision.as_str() {
        "retry" => ErrorDecision::Retry,
        "skip" => ErrorDecision::Skip,
        "stop" => ErrorDecision::Stop,
        _ => return Err(format!("Unknown decision: {decision}")),
    };
    if let Ok(mut lock) = NATIVE_INSTALL_STATE.decision.lock() {
        *lock = Some(d);
    }
    Ok(())
}

/// Pause the native install at the next batch boundary.
#[tauri::command]
pub fn install_pause() -> Result<(), String> {
    NATIVE_INSTALL_STATE.paused.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// Resume a paused native install.
#[tauri::command]
pub fn install_resume() -> Result<(), String> {
    NATIVE_INSTALL_STATE.paused.store(false, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// Send input text to the running WeiDU process.
#[tauri::command]
pub fn install_send_input(text: String) -> Result<(), String> {
    crate::installer::runner::send_input(&text)
}

/// Test junction/symlink creation capability in a game directory.
/// Creates a temporary `.eetmr_junction_test` junction to `override/`,
/// removes it, and reports success/failure. Used by Ready Check to
/// catch environments where junctions are blocked (e.g. OneDrive-synced
/// folders, Dev Drives without elevation, exotic filesystems).
#[tauri::command]
pub fn test_junction_capability(game_dir: String) -> JunctionTestResult {
    let path = std::path::Path::new(&game_dir);
    let test_dir = path.join(".eetmr_junction_test");
    let test_target = path.join("override");

    if !test_target.exists() {
        return JunctionTestResult {
            ok: false,
            error: Some("override/ directory not found — is this a valid game dir?".to_string()),
        };
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::symlink_dir;
        if symlink_dir(&test_target, &test_dir).is_ok() {
            let _ = std::fs::remove_dir(&test_dir);
            return JunctionTestResult { ok: true, error: None };
        }
        // Fall back to cmd mklink /J (which doesn't require elevation)
        use std::os::windows::process::CommandExt;
        let result = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J",
                &test_dir.to_string_lossy(),
                &test_target.to_string_lossy()])
            .creation_flags(0x08000000)
            .output();
        match result {
            Ok(output) if output.status.success() => {
                let _ = std::fs::remove_dir(&test_dir);
                JunctionTestResult { ok: true, error: None }
            }
            Ok(output) => JunctionTestResult {
                ok: false,
                error: Some(format!("mklink /J failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim())),
            },
            Err(e) => JunctionTestResult { ok: false, error: Some(format!("cmd failed: {e}")) },
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        match std::os::unix::fs::symlink(&test_target, &test_dir) {
            Ok(_) => {
                let _ = std::fs::remove_file(&test_dir);
                JunctionTestResult { ok: true, error: None }
            }
            Err(e) => JunctionTestResult { ok: false, error: Some(format!("symlink failed: {e}")) },
        }
    }
}

/// Query free disk space on each of the configured directories in one
/// roundtrip so Ready Check doesn't need three separate invokes.
/// Any directory that fails lookup returns 0 for that slot; frontend treats
/// 0 as "unknown" and skips the check silently.
#[tauri::command]
pub fn check_disk_spaces(
    game_dir: String,
    data_dir: String,
    mod_dir: String,
) -> DiskSpaceReport {
    DiskSpaceReport {
        game_free: fs2::available_space(std::path::Path::new(&game_dir)).unwrap_or(0),
        data_free: fs2::available_space(std::path::Path::new(&data_dir)).unwrap_or(0),
        mod_free: fs2::available_space(std::path::Path::new(&mod_dir)).unwrap_or(0),
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JunctionTestResult {
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskSpaceReport {
    /// Bytes free on the volume hosting the game directory.
    pub game_free: u64,
    /// Bytes free on the volume hosting the data/backup directory.
    pub data_free: u64,
    /// Bytes free on the volume hosting the mod/Extracted directory.
    pub mod_free: u64,
}

/// Check if a previous install was interrupted (crash recovery).
/// Returns the checkpoint data if found, null otherwise.
#[tauri::command]
pub fn check_install_checkpoint(game_dir: String, data_directory: Option<String>) -> Result<Option<serde_json::Value>, String> {
    // Build a minimal config just for resolve_data_dir
    let config = InstallConfig {
        weidu_path: std::path::PathBuf::new(),
        bg2_game_dir: std::path::PathBuf::from(&game_dir),
        bg1_game_dir: None,
        mod_directory: std::path::PathBuf::new(),
        language: String::new(), language_index: 0,
        max_batch_size: 25, skip_installed: true, timeout_secs: 7200,
        weidu_log_mode: String::new(), never_abort: false, abort_on_warnings: false,
        post_copy_delay_ms: 0, ocamlrunparam: String::new(),
        bcs_scanner: false,
        force_small_batch_mods: Vec::new(), force_small_batch_size: 3,
        per_mod_timeout_secs: std::collections::HashMap::new(),
        force_single_cn_mods: std::collections::HashMap::new(),
        auto_skip_after_retry: false, suppress_readmes: true,
        sibling_directories: std::collections::HashMap::new(),
        readln_defaults: std::collections::HashMap::new(),
        readln_fallback: String::new(), readln_timeout_secs: 30,
        data_directory,
        tlk_prewarm: true, tlk_fast_drive: false, tlk_fast_drive_path: None,
        override_fast_drive: false, override_fast_drive_path: None,
        pause_on_guard: false, enable_biff_delete_optimization: false,
    };
    let data_dir = crate::installer::resolve_data_dir(&config);
    // Also check old location for migration
    let result = crate::installer::orchestrator::read_checkpoint(&data_dir);
    if result.is_some() { return Ok(result); }
    Ok(crate::installer::orchestrator::read_checkpoint(std::path::Path::new(&game_dir)))
}

/// Abort the native install (graceful → force kill).
#[tauri::command]
pub fn abort_native_install() -> Result<(), String> {
    // Emit into install.log before flipping the flag so the event lands
    // before any downstream [ABORT_SKIP]/[FATAL_SKIP] from batches mid-flight.
    // Idempotent: if no install is running the event no-ops.
    crate::installer::install_log::log_active_event(
        "USER_ABORT",
        "requested from GUI — install will halt after current batch completes",
    );
    NATIVE_INSTALL_STATE.abort_flag.store(true, std::sync::atomic::Ordering::SeqCst);
    crate::installer::runner::abort_weidu()
}

// ─── Pre-Install Patcher ───

#[derive(serde::Deserialize)]
pub(crate) struct PatchManifestEntry {
    pub(crate) id: u32,
    pub(crate) name: String,
    #[allow(dead_code)]
    pub(crate) description: String,
    pub(crate) target_mod: Option<String>,
    pub(crate) trigger: serde_json::Value,
    pub(crate) marker: serde_json::Value,
    #[allow(dead_code)]
    pub(crate) ops: Vec<serde_json::Value>,
    /// Defaults to true when missing — keeps existing manifest entries auto-selected.
    /// Set false in the manifest for patches that change behavior some users may want
    /// to opt out of (e.g., aggressive workarounds, experimental fixes).
    #[serde(default = "default_true")]
    #[allow(dead_code)]
    pub(crate) recommended: bool,
    /// Category for grouping and visual triage in the UI.
    /// Valid values: "required" | "bugfix" | "compat" | "performance" | "cosmetic".
    /// Missing entries default to "bugfix" — that's what most of the manifest is.
    #[serde(default = "default_category")]
    pub(crate) category: String,
}

fn default_true() -> bool { true }
fn default_category() -> String { "bugfix".to_string() }

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchStatus {
    pub id: u32,
    pub name: String,
    pub description: String,
    pub target_mod: Option<String>,
    pub status: String,  // "applicable", "already_patched", "not_needed"
    /// True if this patch is recommended-on-by-default for new users. False for opinionated
    /// or experimental patches that touch behavior some users want to keep. Frontend uses
    /// this to set the initial checkbox state in the per-patch selection UI.
    pub recommended: bool,
    /// Category for UI grouping — surfaced from the manifest. Values:
    /// "required" | "bugfix" | "compat" | "performance" | "cosmetic".
    pub category: String,
}

#[derive(serde::Serialize)]
pub struct PatchResult {
    pub id: u32,
    pub name: String,
    pub status: String,  // "applied", "already_patched", "failed"
    pub error: Option<String>,
}

pub(crate) fn load_manifest(resource_dir: &Path) -> Result<Vec<PatchManifestEntry>, String> {
    let manifest_path = resource_dir.join("patches").join("patch_manifest.json");
    let contents = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read patch manifest: {e}"))?;
    serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse patch manifest: {e}"))
}

/// Build a map of lowercase mod folder name → actual path on disk.
/// Scans mod_dir recursively for .tp2 files, derives the mod folder name
/// from each tp2's parent directory.
/// E.g., finds `Extracted/Artisans Kitpack/ArtisansKitpack/ArtisansKitpack.TP2`
///   → maps "artisanskitpack" → "Extracted/Artisans Kitpack/ArtisansKitpack"
pub(crate) fn build_mod_location_map(mod_dir: &Path) -> std::collections::HashMap<String, std::path::PathBuf> {
    let mut map = std::collections::HashMap::<String, (std::path::PathBuf, usize)>::new();

    fn scan(dir: &Path, map: &mut std::collections::HashMap<String, (std::path::PathBuf, usize)>, depth: usize, current_depth: usize) {
        if depth == 0 || !dir.is_dir() { return; }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_file() {
                    if path.extension().map_or(false, |ext| ext.eq_ignore_ascii_case("tp2")) {
                        if let Some(parent) = path.parent() {
                            let folder_name = parent.file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_lowercase();
                            // Prefer shallower paths (real mod dirs over nested copies)
                            let existing_depth = map.get(&folder_name).map(|v| v.1).unwrap_or(usize::MAX);
                            if current_depth < existing_depth {
                                map.insert(folder_name, (parent.to_path_buf(), current_depth));
                            }
                        }
                    }
                } else if path.is_dir() {
                    scan(&path, map, depth - 1, current_depth + 1);
                }
            }
        }
    }

    scan(mod_dir, &mut map, 4, 0);
    // Strip the depth tracking, return just the paths
    map.into_iter().map(|(k, (v, _))| (k, v)).collect()
}

/// Resolve a relative path like "angelo/setup-angelo.tp2" to its actual location.
/// Uses the mod location map to find where "angelo" actually lives on disk,
/// regardless of parent folder naming (e.g., "Extracted/Angelo NPC/angelo/").
fn resolve_mod_path_with_map(
    mod_dir: &Path,
    rel_path: &str,
    mod_locations: &std::collections::HashMap<String, std::path::PathBuf>,
) -> Option<std::path::PathBuf> {
    // Direct check first (fastest path)
    let direct = mod_dir.join(rel_path);
    if direct.exists() {
        return Some(direct);
    }

    // Extract the first path segment (the mod folder name) and look it up
    let normalized = rel_path.replace('\\', "/");
    let first_seg = normalized.split('/').next().unwrap_or(&normalized);
    let rest = if normalized.contains('/') { &normalized[first_seg.len() + 1..] } else { "" };

    if let Some(actual_mod_dir) = mod_locations.get(&first_seg.to_lowercase()) {
        let resolved = if rest.is_empty() {
            actual_mod_dir.to_path_buf()
        } else {
            actual_mod_dir.join(rest)
        };
        if resolved.exists() {
            return Some(resolved);
        }
    }

    None
}

/// Like `resolve_mod_path_with_map` but returns the constructed path EVEN IF the file
/// doesn't exist. Used by ops (rename_if_exists, copy_if_missing) that legitimately
/// operate on missing files — they need the correct path resolved by mod-prefix lookup
/// regardless of whether the file is currently there.
///
/// Resolution priority:
///   1. `mod_dir/rel_path` if it exists (fast path)
///   2. `mod_locations[prefix]/rest_of_path` if the prefix is in the map (existence not required)
///   3. `mod_dir/rel_path` as fallback (literal join — last resort)
///
/// The bug we're fixing: previously this returned None for missing files and callers
/// fell back to a literal `mod_dir.join(src)` which used the wrong directory name
/// (e.g. `Extracted/DSotSC/...` instead of `Extracted/Dark Side Of The Sword Coast/DSotSC/...`).
/// rename_if_exists then succeeded but operated on a non-existent path, creating files
/// in a sibling directory and leaving the actual mod folder broken.
fn resolve_mod_path_for_io(
    mod_dir: &Path,
    rel_path: &str,
    mod_locations: &std::collections::HashMap<String, std::path::PathBuf>,
) -> std::path::PathBuf {
    if let Some(p) = resolve_mod_path_with_map(mod_dir, rel_path, mod_locations) {
        return p;
    }
    // File doesn't exist at the resolved path, but the mod prefix may still be in the map.
    // Construct the path under the actual mod dir so callers operate on the right location.
    let normalized = rel_path.replace('\\', "/");
    let first_seg = normalized.split('/').next().unwrap_or(&normalized);
    let rest = if normalized.contains('/') { &normalized[first_seg.len() + 1..] } else { "" };
    if let Some(actual_mod_dir) = mod_locations.get(&first_seg.to_lowercase()) {
        return if rest.is_empty() {
            actual_mod_dir.to_path_buf()
        } else {
            actual_mod_dir.join(rest)
        };
    }
    // Truly unknown prefix — fall back to literal join. Caller's op will likely fail
    // (file doesn't exist + we don't know where the mod lives), which is the right outcome.
    mod_dir.join(rel_path)
}

pub(crate) fn check_trigger(
    mod_dir: &Path,
    game_dir: &Path,
    trigger: &serde_json::Value,
    mod_locations: &std::collections::HashMap<String, std::path::PathBuf>,
) -> bool {
    let ttype = trigger.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let path = trigger.get("path").and_then(|v| v.as_str()).unwrap_or("");
    match ttype {
        "dir_exists" | "file_exists" => resolve_mod_path_with_map(mod_dir, path, mod_locations).is_some(),
        "file_exists_game" => game_dir.join(path).exists(),
        "always" => true,
        _ => false,
    }
}

pub(crate) fn check_marker(
    mod_dir: &Path,
    game_dir: &Path,
    marker: &serde_json::Value,
    mod_locations: &std::collections::HashMap<String, std::path::PathBuf>,
) -> bool {
    let invert = marker.get("invert").and_then(|v| v.as_bool()).unwrap_or(false);

    if let Some(file) = marker.get("file").and_then(|v| v.as_str()) {
        // md5 marker — strongest form, detects per-version exactly
        if let Some(expected_md5) = marker.get("md5").and_then(|v| v.as_str()) {
            let filepath = resolve_mod_path_with_map(mod_dir, file, mod_locations)
                .unwrap_or_else(|| mod_dir.join(file));
            if !filepath.exists() {
                return if invert { true } else { false };
            }
            let bytes = match std::fs::read(&filepath) {
                Ok(b) => b,
                Err(_) => return false,
            };
            let actual = format!("{:x}", md5::compute(&bytes));
            let found = actual.eq_ignore_ascii_case(expected_md5);
            return if invert { !found } else { found };
        }
        if marker.get("text").is_none() || marker.get("text").unwrap().is_null() {
            // Bare file-exists marker: resolve against mod_dir / check_dir / check_game.
            // BUG-FIX (invert-flag): early returns here used to drop the `invert` flag,
            // so `{"file": X, "invert": true}` markers silently behaved as non-inverted —
            // meaning a patch that should apply when the file still exists would be
            // reported as already-applied and skipped. See patch #57 (imoen_forever
            // marker clear).
            let found = if let Some(check_dir) = marker.get("check_dir").and_then(|v| v.as_str()) {
                resolve_mod_path_with_map(mod_dir, check_dir, mod_locations).is_some()
            } else if let Some(check_game) = marker.get("check_game_file").and_then(|v| v.as_str()) {
                game_dir.join(check_game).exists()
            } else {
                resolve_mod_path_with_map(mod_dir, file, mod_locations).is_some()
            };
            return if invert { !found } else { found };
        }
        let text = marker.get("text").and_then(|v| v.as_str()).unwrap_or("");
        let filepath = resolve_mod_path_with_map(mod_dir, file, mod_locations)
            .unwrap_or_else(|| mod_dir.join(file));
        if !filepath.exists() { return false; }
        let contents = match std::fs::read_to_string(&filepath) {
            Ok(c) => c,
            Err(_) => {
                match std::fs::read(&filepath) {
                    Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
                    Err(_) => return false,
                }
            }
        };
        let found = contents.contains(text);
        if invert { !found } else { found }
    } else {
        // Marker without `file`: check_dir / check_game_file / check_game_dir /
        // check_game_file_contains. Same invert-flag bug as the `file` branch —
        // early returns dropped `invert`. Now honored across all sub-cases.
        let found = if let Some(check_dir) = marker.get("check_dir").and_then(|v| v.as_str()) {
            resolve_mod_path_with_map(mod_dir, check_dir, mod_locations).is_some()
        } else if let Some(check_game) = marker.get("check_game_file").and_then(|v| v.as_str()) {
            game_dir.join(check_game).exists()
        } else if let Some(check_game_dir) = marker.get("check_game_dir").and_then(|v| v.as_str()) {
            game_dir.join(check_game_dir).is_dir()
        } else if let Some(obj) = marker.get("check_game_file_contains") {
            let file = obj.get("file").and_then(|v| v.as_str()).unwrap_or("");
            let text = obj.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let filepath = game_dir.join(file);
            match std::fs::read_to_string(&filepath) {
                Ok(contents) => contents.contains(text),
                Err(_) => false,
            }
        } else {
            false
        };
        if invert { !found } else { found }
    }
}

// TODO: If user/mod-supplied patch manifests are ever supported, add path traversal
// validation here: canonicalize resolved paths and verify they start with mod_dir/game_dir.
// Currently safe because the manifest is bundled as a Tauri resource and authored by us.
fn apply_patch_ops(
    mod_dir: &Path,
    game_dir: &Path,
    resource_dir: &Path,
    ops: &[serde_json::Value],
    mod_locations: &std::collections::HashMap<String, std::path::PathBuf>,
) -> Result<(), String> {
    let files_dir = resource_dir.join("patches").join("files");

    for op in ops {
        let op_type = op.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match op_type {
            "copy" => {
                let src = op.get("src").and_then(|v| v.as_str())
                    .ok_or("copy op missing src")?;
                let dest = op.get("dest").and_then(|v| v.as_str())
                    .ok_or("copy op missing dest")?;
                let src_path = files_dir.join(src);
                let dest_path = resolve_mod_path_for_io(mod_dir, dest, mod_locations);
                if let Some(parent) = dest_path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("mkdir failed for {}: {e}", parent.display()))?;
                }
                std::fs::copy(&src_path, &dest_path)
                    .map_err(|e| format!("copy failed {} → {}: {e}", src_path.display(), dest_path.display()))?;
            }
            "replace" => {
                let file = op.get("file").and_then(|v| v.as_str())
                    .ok_or("replace op missing file")?;
                let find = op.get("find").and_then(|v| v.as_str())
                    .ok_or("replace op missing find")?;
                let replace_str = op.get("replace").and_then(|v| v.as_str())
                    .ok_or("replace op missing replace")?;
                // `required` defaults to true — failing the find aborts the patch.
                // Set `"required": false` on ops that may no-op safely (e.g. a fix that
                // was already applied by a previous patch version).
                let required = op.get("required").and_then(|v| v.as_bool()).unwrap_or(true);
                let filepath = resolve_mod_path_for_io(mod_dir, file, mod_locations);
                // Read as bytes — TP2/TPA files may contain Latin-1/Windows-1252 bytes
                // (e.g. German translation strings with 0x85 ellipsis). Our find/replace
                // strings are ASCII, and ASCII bytes are identical across UTF-8 and
                // Latin-1/CP1252, so byte-level replacement preserves non-ASCII bytes
                // untouched while doing the substitution correctly.
                let contents = std::fs::read(&filepath)
                    .map_err(|e| format!("read failed {}: {e}", filepath.display()))?;
                let find_bytes = find.as_bytes();
                let replace_bytes = replace_str.as_bytes();
                let new_contents = replace_bytes_all(&contents, find_bytes, replace_bytes);
                if new_contents == contents {
                    // Find bytes not found — check for line-ending mismatch (\r\n vs \n)
                    let find_normalized: Vec<u8> = find.replace("\r\n", "\n").into_bytes();
                    let contents_normalized = normalize_crlf_to_lf(&contents);
                    let normalized_result =
                        replace_bytes_all(&contents_normalized, &find_normalized, replace_bytes);
                    if normalized_result != contents_normalized {
                        std::fs::write(&filepath, &normalized_result)
                            .map_err(|e| format!("write failed {}: {e}", filepath.display()))?;
                    } else if required {
                        return Err(format!("find text not found in {}", filepath.display()));
                    }
                    // else: optional op, find not present → no-op silently
                } else {
                    std::fs::write(&filepath, &new_contents)
                        .map_err(|e| format!("write failed {}: {e}", filepath.display()))?;
                }
            }
            "delete_if_exists" => {
                // Remove a file if present. Idempotent: no-op if already gone.
                // Used when a patch's goal is simply "ensure this file doesn't exist"
                // — e.g. imoen_forever's stale do-once marker (patch #57). Distinct
                // from `rename_if_exists`, which has "restore pre-MOVE state"
                // semantics and would no-op here (the (src exists, dest missing)
                // case is treated as clean by that op).
                let path = op.get("path").and_then(|v| v.as_str())
                    .ok_or("delete_if_exists op missing path")?;
                let resolved = resolve_mod_path_for_io(mod_dir, path, mod_locations);
                if resolved.exists() {
                    std::fs::remove_file(&resolved)
                        .map_err(|e| format!("delete_if_exists failed {}: {e}", resolved.display()))?;
                }
            }
            "copy_if_missing" => {
                // Copy from one mod path to another mod path, only if dest doesn't exist.
                // Used to restore source files consumed by previous MOVE operations.
                let src = op.get("src").and_then(|v| v.as_str())
                    .ok_or("copy_if_missing op missing src")?;
                let dest = op.get("dest").and_then(|v| v.as_str())
                    .ok_or("copy_if_missing op missing dest")?;
                let src_path = resolve_mod_path_for_io(mod_dir, src, mod_locations);
                let dest_path = resolve_mod_path_for_io(mod_dir, dest, mod_locations);
                if !dest_path.exists() && src_path.exists() {
                    if let Some(parent) = dest_path.parent() {
                        std::fs::create_dir_all(parent).ok();
                    }
                    std::fs::copy(&src_path, &dest_path)
                        .map_err(|e| format!("copy_if_missing failed {} → {}: {e}", src_path.display(), dest_path.display()))?;
                }
            }
            "rename_if_exists" => {
                // Restore pre-MOVE state: if src is missing and dest exists, rename dest→src.
                // Used for mods whose MOVE operation consumes source files (DSotSC, NTotSC,
                // c#anotherfinehell). After one successful install, source is gone and dest
                // is present. WeiDU's MOVE on re-install then hits "destination exists" and
                // trips fallback→error. Renaming dest back to src restores the clean pre-install
                // state so the mod's own MOVE can run.
                //
                // Semantics (param names: src = desired source filename, dest = desired dest):
                //   - src exists AND dest missing: no-op (clean pre-install state)
                //   - src missing AND dest exists: rename dest → src (restore)
                //   - both exist: delete dest (mod already installed — restore clean state)
                //   - both missing: error (mod package is broken)
                let src = op.get("src").and_then(|v| v.as_str())
                    .ok_or("rename_if_exists op missing src")?;
                let dest = op.get("dest").and_then(|v| v.as_str())
                    .ok_or("rename_if_exists op missing dest")?;
                let src_path = resolve_mod_path_for_io(mod_dir, src, mod_locations);
                let dest_path = resolve_mod_path_for_io(mod_dir, dest, mod_locations);
                match (src_path.exists(), dest_path.exists()) {
                    (true, false) => { /* clean state, no-op */ }
                    (false, true) => {
                        if let Some(parent) = src_path.parent() {
                            std::fs::create_dir_all(parent).ok();
                        }
                        std::fs::rename(&dest_path, &src_path)
                            .map_err(|e| format!("rename_if_exists failed {} → {}: {e}", dest_path.display(), src_path.display()))?;
                    }
                    (true, true) => {
                        std::fs::remove_file(&dest_path)
                            .map_err(|e| format!("rename_if_exists cleanup failed {}: {e}", dest_path.display()))?;
                    }
                    (false, false) => {
                        return Err(format!("rename_if_exists: both src and dest missing — {} and {}", src_path.display(), dest_path.display()));
                    }
                }
            }
            "rename" => {
                let from = op.get("from").and_then(|v| v.as_str())
                    .ok_or("rename op missing from")?;
                let to = op.get("to").and_then(|v| v.as_str())
                    .ok_or("rename op missing to")?;
                let from_path = resolve_mod_path_for_io(mod_dir, from, mod_locations);
                // For 'to', resolve the first segment the same way as 'from'
                let to_path = resolve_mod_path_for_io(mod_dir, to, mod_locations);
                if from_path.exists() {
                    if let Some(parent) = to_path.parent() {
                        std::fs::create_dir_all(parent).ok();
                    }
                    std::fs::copy(&from_path, &to_path)
                        .map_err(|e| format!("rename failed {} → {}: {e}", from_path.display(), to_path.display()))?;
                }
            }
            "mkdir" => {
                let path = op.get("path").and_then(|v| v.as_str())
                    .ok_or("mkdir op missing path")?;
                let dir_path = game_dir.join(path);
                std::fs::create_dir_all(&dir_path)
                    .map_err(|e| format!("mkdir failed {}: {e}", dir_path.display()))?;
            }
            "copy_to_game" => {
                let src_mod = op.get("src_mod").and_then(|v| v.as_str())
                    .ok_or("copy_to_game op missing src_mod")?;
                let dest_game = op.get("dest_game").and_then(|v| v.as_str())
                    .ok_or("copy_to_game op missing dest_game")?;
                let src_path = resolve_mod_path_with_map(mod_dir, src_mod, mod_locations)
                    .unwrap_or_else(|| mod_dir.join(src_mod));
                let dest_path = game_dir.join(dest_game);
                if let Some(parent) = dest_path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("mkdir failed for {}: {e}", parent.display()))?;
                }
                if src_path.exists() {
                    std::fs::copy(&src_path, &dest_path)
                        .map_err(|e| format!("copy_to_game failed {} → {}: {e}", src_path.display(), dest_path.display()))?;
                }
            }
            "write_to_game" => {
                // Write content directly to a game file (creates if missing)
                let file = op.get("file").and_then(|v| v.as_str())
                    .ok_or("write_to_game op missing file")?;
                let content = op.get("content").and_then(|v| v.as_str())
                    .ok_or("write_to_game op missing content")?;
                let filepath = game_dir.join(file);
                if let Some(parent) = filepath.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("mkdir failed for {}: {e}", parent.display()))?;
                }
                std::fs::write(&filepath, content.replace("\\n", "\n"))
                    .map_err(|e| format!("write_to_game failed {}: {e}", filepath.display()))?;
            }
            "append_to_game" => {
                // Append a line to a game file if the line doesn't already exist
                let file = op.get("file").and_then(|v| v.as_str())
                    .ok_or("append_to_game op missing file")?;
                let line = op.get("line").and_then(|v| v.as_str())
                    .ok_or("append_to_game op missing line")?;
                let unless = op.get("unless").and_then(|v| v.as_str()).unwrap_or(line);
                let filepath = game_dir.join(file);
                if filepath.exists() {
                    let contents = std::fs::read_to_string(&filepath)
                        .map_err(|e| format!("read failed {}: {e}", filepath.display()))?;
                    if !contents.contains(unless) {
                        use std::io::Write;
                        let mut f = std::fs::OpenOptions::new()
                            .append(true)
                            .open(&filepath)
                            .map_err(|e| format!("open failed {}: {e}", filepath.display()))?;
                        writeln!(f, "{}", line)
                            .map_err(|e| format!("append failed {}: {e}", filepath.display()))?;
                    }
                }
            }
            _ => {
                return Err(format!("Unknown op type: {op_type}"));
            }
        }
    }
    Ok(())
}

/// Scan all patches from the bundled manifest and check their status.
#[tauri::command]
pub async fn scan_patches(
    app: AppHandle,
    mod_dir: String,
    game_dir: String,
) -> Result<Vec<PatchStatus>, String> {
    let resource_dir = app.path().resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {e}"))?;

    tauri::async_runtime::spawn_blocking(move || {
        let manifest = load_manifest(&resource_dir)?;
        let mod_path = Path::new(&mod_dir);
        let game_path = Path::new(&game_dir);

        // Build tp2-based mod location map once (scans mod_dir recursively)
        let mod_locations = build_mod_location_map(mod_path);

        let mut results = Vec::new();

        // Per-patch scan trace — opt-in via PATCH_TRACE=1 env var. Useful
        // when the UI's banner disagrees with the visible patch-list state.
        // Output goes to stderr (captured by gui.log's stderr fallback path).
        let trace = std::env::var("PATCH_TRACE").ok().as_deref() == Some("1");
        if trace {
            eprintln!("PATCH_TRACE mod_dir={} game_dir={}",
                mod_path.display(), game_path.display());
        }

        for entry in &manifest {
            let triggered = check_trigger(mod_path, game_path, &entry.trigger, &mod_locations);
            if !triggered {
                if trace {
                    eprintln!("PATCH_TRACE #{:3}: trigger_failed → not_needed  [{}]",
                        entry.id, entry.name);
                }
                results.push(PatchStatus {
                    id: entry.id,
                    name: entry.name.clone(),
                    description: entry.description.clone(),
                    target_mod: entry.target_mod.clone(),
                    status: "not_needed".to_string(),
                    recommended: entry.recommended,
                    category: entry.category.clone(),
                });
                continue;
            }

            let already_patched = check_marker(mod_path, game_path, &entry.marker, &mod_locations);
            if trace {
                eprintln!("PATCH_TRACE #{:3}: trigger_ok marker={} → {}  [{}]",
                    entry.id,
                    serde_json::to_string(&entry.marker).unwrap_or_default(),
                    if already_patched { "already_patched" } else { "applicable" },
                    entry.name);
            }
            results.push(PatchStatus {
                id: entry.id,
                name: entry.name.clone(),
                description: entry.description.clone(),
                target_mod: entry.target_mod.clone(),
                status: if already_patched { "already_patched" } else { "applicable" }.to_string(),
                recommended: entry.recommended,
                category: entry.category.clone(),
            });
        }

        Ok(results)
    }).await.map_err(|e| e.to_string())?
}

/// Apply selected patches by ID.
#[tauri::command]
pub async fn apply_patches(
    app: AppHandle,
    mod_dir: String,
    game_dir: String,
    patch_ids: Vec<u32>,
) -> Result<Vec<PatchResult>, String> {
    let resource_dir = app.path().resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {e}"))?;

    tauri::async_runtime::spawn_blocking(move || {
        let manifest = load_manifest(&resource_dir)?;
        let mod_path = Path::new(&mod_dir);
        let game_path = Path::new(&game_dir);

        // Build tp2-based mod location map once
        let mod_locations = build_mod_location_map(mod_path);

        let mut results = Vec::new();

        let id_set: std::collections::HashSet<u32> = patch_ids.into_iter().collect();

        for entry in &manifest {
            if !id_set.contains(&entry.id) { continue; }

            // Re-check marker (idempotent)
            let already_patched = check_marker(mod_path, game_path, &entry.marker, &mod_locations);
            if already_patched {
                results.push(PatchResult {
                    id: entry.id,
                    name: entry.name.clone(),
                    status: "already_patched".to_string(),
                    error: None,
                });
                continue;
            }

            // Apply the patch ops
            match apply_patch_ops(mod_path, game_path, &resource_dir, &entry.ops, &mod_locations) {
                Ok(()) => {
                    results.push(PatchResult {
                        id: entry.id,
                        name: entry.name.clone(),
                        status: "applied".to_string(),
                        error: None,
                    });
                }
                Err(e) => {
                    results.push(PatchResult {
                        id: entry.id,
                        name: entry.name.clone(),
                        status: "failed".to_string(),
                        error: Some(e),
                    });
                }
            }
        }

        Ok(results)
    }).await.map_err(|e| e.to_string())?
}

// ─── Backup & Restore ───

use crate::backup;

/// Global backup state — shared between the backup thread and Tauri commands.
static BACKUP_STATE: std::sync::LazyLock<BackupState> =
    std::sync::LazyLock::new(BackupState::new);

struct BackupState {
    abort_flag: std::sync::atomic::AtomicBool,
    running: std::sync::atomic::AtomicBool,
}

impl BackupState {
    fn new() -> Self {
        Self {
            abort_flag: std::sync::atomic::AtomicBool::new(false),
            running: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

#[tauri::command]
pub async fn estimate_backup(
    game_dir: String,
    backup_dir: String,
    mode: String,
) -> Result<backup::BackupEstimate, String> {
    tauri::async_runtime::spawn_blocking(move || {
        backup::estimate_backup(Path::new(&game_dir), Path::new(&backup_dir), &mode)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_backup(
    app: AppHandle,
    game_dir: String,
    backup_dir: String,
    name: String,
    mode: String,
    // Which game this backup represents. One of "bg1" | "bg2" | "iwd" |
    // "iwd2" | "pst". Defaults to "bg2" if the caller omits — preserves
    // back-compat for clients built before Phase 9b.
    game_kind: Option<String>,
) -> Result<backup::BackupManifest, String> {
    if BACKUP_STATE.running.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("Backup already in progress".to_string());
    }
    if NATIVE_INSTALL_STATE.running.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("Cannot create backup while install is running".to_string());
    }

    BACKUP_STATE.abort_flag.store(false, std::sync::atomic::Ordering::SeqCst);
    BACKUP_STATE.running.store(true, std::sync::atomic::Ordering::SeqCst);

    let kind = game_kind.unwrap_or_else(|| "bg2".to_string());
    let result = tauri::async_runtime::spawn_blocking(move || {
        let r = backup::create_backup(
            &app, Path::new(&game_dir), Path::new(&backup_dir),
            &name, &mode, &kind, &BACKUP_STATE.abort_flag,
        );
        BACKUP_STATE.running.store(false, std::sync::atomic::Ordering::SeqCst);
        r
    }).await.map_err(|e| e.to_string())?;

    result
}

#[tauri::command]
pub async fn list_backups(backup_dir: String) -> Result<Vec<backup::BackupInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        backup::list_backups(Path::new(&backup_dir))
    }).await.map_err(|e| e.to_string())?
}

/// Find every WeiDU mod-local `backup/` directory under `mod_dir`.
///
/// A WeiDU mod folder is identified as "a directory containing at least one .tp2 file".
/// Its WeiDU backup state lives in a `backup/` subdirectory next to the .tp2. After a
/// game-dir restore (which wipes WeiDU.log), those mod-local backups are orphaned — they
/// track "I installed component X" for a game that no longer believes X is installed.
/// WeiDU's next install may then attempt an uninstall that doesn't match the current
/// game state, producing weird errors.
///
/// Returns a list of (backup_path, size_bytes) tuples without deleting anything.
fn find_orphan_mod_backups(mod_dir: &Path) -> Vec<(std::path::PathBuf, u64)> {
    let mut results = Vec::new();
    fn walk(dir: &Path, out: &mut Vec<(std::path::PathBuf, u64)>, depth: usize) {
        if depth > 6 { return; } // safety cap — typical nesting is 2-3
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        let mut has_tp2 = false;
        let mut backup_subdir: Option<std::path::PathBuf> = None;
        let mut child_dirs: Vec<std::path::PathBuf> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if path.extension().and_then(|e| e.to_str()).map(|s| s.eq_ignore_ascii_case("tp2")).unwrap_or(false) {
                    has_tp2 = true;
                }
            } else if path.is_dir() {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.eq_ignore_ascii_case("backup") {
                    backup_subdir = Some(path.clone());
                } else {
                    child_dirs.push(path);
                }
            }
        }
        if has_tp2 {
            if let Some(b) = backup_subdir {
                let size = dir_size(&b);
                out.push((b, size));
            }
        }
        // Recurse into non-backup children (Extracted dirs often have Pretty Name/mod_prefix/)
        for c in child_dirs {
            walk(&c, out, depth + 1);
        }
    }
    fn dir_size(p: &Path) -> u64 {
        let mut total = 0u64;
        if let Ok(it) = std::fs::read_dir(p) {
            for e in it.flatten() {
                let path = e.path();
                if path.is_file() {
                    if let Ok(meta) = path.metadata() { total += meta.len(); }
                } else if path.is_dir() {
                    total += dir_size(&path);
                }
            }
        }
        total
    }
    walk(mod_dir, &mut results, 0);
    results
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanBackup {
    pub path: String,
    pub mod_name: String,
    pub size_bytes: u64,
}

/// Enumerate mod-local WeiDU backup/ dirs under mod_dir for UI display.
/// Exposed so ReadyCheck can surface them the same way patches are surfaced:
/// user sees a list, clicks "Clean" to invoke clean_orphan_backups.
///
/// Safety note: we don't cross-reference WeiDU.log. In the common "orphaned after
/// game-restore" case, ALL backups listed here ARE orphaned. In the rare case where
/// a user hasn't restored and has a valid WeiDU.log that references these backups,
/// cleaning them would impair WeiDU's ability to uninstall — so we surface this as
/// a user-choice action, not an automatic sweep.
#[tauri::command]
pub async fn scan_orphan_backups(mod_dir: String) -> Result<Vec<OrphanBackup>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = Path::new(&mod_dir);
        let entries = find_orphan_mod_backups(dir);
        let mut out = Vec::new();
        for (p, size) in entries {
            let mod_name = p.parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();
            out.push(OrphanBackup {
                path: p.to_string_lossy().to_string(),
                mod_name,
                size_bytes: size,
            });
        }
        Ok(out)
    }).await.map_err(|e| e.to_string())?
}

/// Delete specified mod-local backup/ dirs. Safe because WeiDU regenerates them on install.
#[tauri::command]
pub async fn clean_orphan_backups(paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cleaned = Vec::new();
        for p in paths {
            let path = Path::new(&p);
            // Safety: require path component "backup" (case-insensitive) and at least one .tp2 sibling.
            let is_backup = path.file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.eq_ignore_ascii_case("backup"))
                .unwrap_or(false);
            let parent_has_tp2 = path.parent()
                .and_then(|pp| std::fs::read_dir(pp).ok())
                .map(|it| it.flatten().any(|e|
                    e.path().extension().and_then(|x| x.to_str()).map(|s| s.eq_ignore_ascii_case("tp2")).unwrap_or(false)
                ))
                .unwrap_or(false);
            if !is_backup || !parent_has_tp2 {
                continue; // refuse to delete anything that doesn't look like a WeiDU mod backup
            }
            if std::fs::remove_dir_all(path).is_ok() {
                cleaned.push(p);
            }
        }
        Ok(cleaned)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn restore_backup(
    app: AppHandle,
    backup_path: String,
    game_dir: String,
    mod_dir: Option<String>,
) -> Result<(), String> {
    if BACKUP_STATE.running.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("Backup operation already in progress".to_string());
    }
    if NATIVE_INSTALL_STATE.running.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("Cannot restore while install is running".to_string());
    }

    BACKUP_STATE.abort_flag.store(false, std::sync::atomic::Ordering::SeqCst);
    BACKUP_STATE.running.store(true, std::sync::atomic::Ordering::SeqCst);

    let app_for_emit = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let r = backup::restore_backup(
            &app, Path::new(&backup_path), Path::new(&game_dir),
            &BACKUP_STATE.abort_flag,
        );
        BACKUP_STATE.running.store(false, std::sync::atomic::Ordering::SeqCst);
        r
    }).await.map_err(|e| e.to_string())?;

    result?;

    // Auto-purge orphaned mod-local WeiDU backup/ dirs. After a game-dir restore these
    // backups track components that the restored game no longer considers installed —
    // leaving them risks WeiDU attempting an uninstall-before-reinstall against phantom
    // state. Silent best-effort: failure to clean is not a restore failure.
    if let Some(md) = mod_dir {
        let md = md.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let entries = find_orphan_mod_backups(Path::new(&md));
            let mut count = 0u32;
            let mut bytes = 0u64;
            for (p, size) in entries {
                if std::fs::remove_dir_all(&p).is_ok() {
                    count += 1;
                    bytes += size;
                }
            }
            if count > 0 {
                let msg = format!(
                    "[Infinity Mod Runner] Cleaned {count} orphaned mod backup{} ({:.1} MB reclaimed)",
                    if count == 1 { "" } else { "s" },
                    bytes as f64 / 1_048_576.0
                );
                let _ = app_for_emit.emit("backup:stdout", msg);
            }
        }).await;
    }

    Ok(())
}

#[tauri::command]
pub async fn delete_backup(backup_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        backup::delete_backup(Path::new(&backup_path))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn verify_backup(backup_path: String) -> Result<backup::VerifyResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        backup::verify_backup(Path::new(&backup_path))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn abort_backup() -> Result<(), String> {
    BACKUP_STATE.abort_flag.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

// ── Windows Defender exclusion management ─────────────────────────────
//
// Exposes the four functions from `defender.rs` to the frontend so the
// UI can:
//   - Show an accurate pre-install advisory (is Defender even active?)
//   - Check if the game dir is already excluded (no need to re-prompt)
//   - Request admin elevation to add / remove an exclusion
//
// See `defender.rs` for the rationale. All commands are safe to call on
// non-Windows (they return `NotApplicable` / false / trivial success).

/// Query Defender's real-time protection state. Returns a small enum the
/// UI pattern-matches to render the right copy ("Defender is active,
/// excluding will save ~4h" vs. "3rd-party AV — no impact").
#[tauri::command]
pub fn defender_status() -> crate::defender::DefenderStatus {
    crate::defender::status()
}

/// Check if a specific path is already in Defender's exclusion list. No
/// admin needed; used by the UI to avoid prompting for UAC when the
/// exclusion is already in place.
#[tauri::command]
pub fn defender_is_path_excluded(path: String) -> bool {
    crate::defender::is_path_excluded(std::path::Path::new(&path))
}

/// Add a path to Defender's exclusion list. Will trigger exactly one
/// UAC prompt. Returns:
///   - Ok(true)  exclusion is present afterwards (we added it, or it
///               already existed)
///   - Ok(false) user cancelled the UAC prompt; install can still run
///               but Defender will scan every write
///   - Err(msg)  structural failure (PowerShell missing, Group Policy
///               blocked the add, etc.)
#[tauri::command]
pub fn defender_add_exclusion(path: String) -> Result<bool, String> {
    crate::defender::add_exclusion(std::path::Path::new(&path))
}

/// Remove a path from Defender's exclusion list. Same return semantics
/// as `defender_add_exclusion`. Intended for use after an install
/// completes, when the user checked the "auto-remove after install"
/// option — leaves the system in the same Defender state it was in
/// before we touched it.
#[tauri::command]
pub fn defender_remove_exclusion(path: String) -> Result<bool, String> {
    crate::defender::remove_exclusion(std::path::Path::new(&path))
}

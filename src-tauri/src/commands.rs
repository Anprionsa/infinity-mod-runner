use crate::config::AppConfig;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// Load persisted config from disk.
#[tauri::command]
pub fn load_config() -> Result<AppConfig, String> {
    let cfg: AppConfig = confy::load("eet-mod-runner", "config")
        .map_err(|e| format!("Failed to load config: {e}"))?;
    Ok(cfg)
}

/// Save config to disk.
#[tauri::command]
pub fn save_config(config: AppConfig) -> Result<(), String> {
    confy::store("eet-mod-runner", "config", &config)
        .map_err(|e| format!("Failed to save config: {e}"))?;
    Ok(())
}

/// Check if a directory contains chitin.key (valid IE game dir).
/// Handles case-insensitive matching on Linux where the file may be Chitin.key or CHITIN.KEY.
#[tauri::command]
pub fn validate_game_dir(path: String) -> Result<bool, String> {
    let dir = Path::new(&path);
    if !dir.exists() {
        return Ok(false);
    }
    // Try common case variants
    for name in &["chitin.key", "Chitin.key", "CHITIN.KEY", "chitin.KEY"] {
        if dir.join(name).exists() {
            return Ok(true);
        }
    }
    // Fallback: scan directory entries case-insensitively
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            if entry.file_name().to_string_lossy().eq_ignore_ascii_case("chitin.key") {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Search PATH for weidu/weidu.exe.
#[tauri::command]
pub fn detect_weidu() -> Result<Option<String>, String> {
    if let Ok(path) = which("weidu") {
        return Ok(Some(path));
    }
    if let Ok(path) = which("weidu.exe") {
        return Ok(Some(path));
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
        if Path::new(p).exists() {
            return Ok(Some(p.to_string()));
        }
    }
    Ok(None)
}

/// Search PATH for mod_installer.
#[tauri::command]
pub fn detect_mod_installer() -> Result<Option<String>, String> {
    if let Ok(path) = which("mod_installer") {
        return Ok(Some(path));
    }
    if let Ok(path) = which("mod_installer.exe") {
        return Ok(Some(path));
    }
    Ok(None)
}

/// Check if a game directory appears to be a fresh, unmodified install.
#[tauri::command]
pub fn check_game_freshness(path: String) -> Result<GameFreshness, String> {
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
pub fn get_binary_version(path: String) -> Result<Option<String>, String> {
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

    // WeiDU prints something like "WeiDU version 24900" or "[weidu] WeiDU version 25100"
    // mod_installer prints its version differently
    for line in combined.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            // Return the first non-empty line as the version info
            return Ok(Some(trimmed.to_string()));
        }
    }
    Ok(None)
}

/// Read install_status.json from the game directory (written by mod_installer).
/// Uses read() instead of read_to_string() for more reliable access on Windows
/// when mod_installer may have the file open for writing.
#[tauri::command]
pub fn read_install_status(game_dir: String) -> Result<Option<InstallStatus>, String> {
    let status_path = Path::new(&game_dir).join("install_status.json");
    if !status_path.exists() {
        return Ok(None);
    }
    // Read as bytes to handle potential locking issues.
    // Return the error string so the frontend can log it.
    let bytes = match std::fs::read(&status_path) {
        Ok(b) => b,
        Err(e) => {
            // Return the error so the GUI can log why reads are failing
            return Err(format!("status read error: {e}"));
        }
    };
    let contents = String::from_utf8_lossy(&bytes);
    // Trim any trailing nulls or whitespace from partial writes
    let trimmed = contents.trim().trim_end_matches('\0');
    if trimmed.is_empty() {
        return Ok(None);
    }
    match serde_json::from_str::<InstallStatus>(trimmed) {
        Ok(status) => Ok(Some(status)),
        Err(_) => {
            // Partially written — retry next poll
            Ok(None)
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct InstallStatus {
    pub current: usize,
    pub total: usize,
    #[serde(rename = "mod")]
    pub mod_name: String,
    pub component: String,
    pub status: String,
    pub errors: usize,
    pub warnings: usize,
    pub skipped: usize,
    pub last_updated: String,
}

/// Read new lines from install_errors.log, starting after `after_line`.
#[tauri::command]
pub fn read_error_log(game_dir: String, after_line: usize) -> Result<ErrorLogResult, String> {
    let log_path = Path::new(&game_dir).join("install_errors.log");
    if !log_path.exists() {
        return Ok(ErrorLogResult {
            entries: Vec::new(),
            total_lines: 0,
        });
    }
    let contents = std::fs::read_to_string(&log_path)
        .map_err(|e| format!("Failed to read install_errors.log: {e}"))?;

    let all_lines: Vec<&str> = contents.lines().collect();
    let total_lines = all_lines.len();

    let entries: Vec<ErrorLogEntry> = all_lines
        .into_iter()
        .skip(after_line)
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| parse_error_line(line))
        .collect();

    Ok(ErrorLogResult {
        entries,
        total_lines,
    })
}

#[derive(serde::Serialize)]
pub struct ErrorLogResult {
    pub entries: Vec<ErrorLogEntry>,
    pub total_lines: usize,
}

#[derive(serde::Serialize)]
pub struct ErrorLogEntry {
    pub timestamp: String,
    pub level: String,
    pub mod_name: String,
    pub message: String,
}

/// Parse a single line from install_errors.log.
/// Format: "2026-04-02T12:42:15Z ERROR dw_talents#60100 "message" — details"
fn parse_error_line(line: &str) -> Option<ErrorLogEntry> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }

    // Try to parse structured format: TIMESTAMP LEVEL MOD_INFO MESSAGE
    // Timestamp is ISO format up to first space
    let mut parts = line.splitn(3, ' ');
    let timestamp = parts.next().unwrap_or("").to_string();
    let level = parts.next().unwrap_or("").to_string();
    let rest = parts.next().unwrap_or("").to_string();

    // Extract mod name from rest (everything before the first quote or dash)
    let (mod_name, message) = if let Some(quote_pos) = rest.find('"') {
        let mn = rest[..quote_pos].trim().to_string();
        let msg = rest[quote_pos..].to_string();
        (mn, msg)
    } else if let Some(dash_pos) = rest.find(" — ") {
        let mn = rest[..dash_pos].trim().to_string();
        let msg = rest[dash_pos + 5..].to_string();
        (mn, msg)
    } else {
        (String::new(), rest)
    };

    // Validate level is one we expect
    let normalized_level = match level.to_uppercase().as_str() {
        "ERROR" | "WARN" | "SKIP" | "RETRY" => level.to_uppercase(),
        _ => return Some(ErrorLogEntry {
            timestamp: String::new(),
            level: "INFO".to_string(),
            mod_name: String::new(),
            message: line.to_string(),
        }),
    };

    Some(ErrorLogEntry {
        timestamp,
        level: normalized_level,
        mod_name,
        message,
    })
}

/// PID of the running install process (for abort). No Mutex around Child.
static INSTALL_PID: Mutex<Option<u32>> = Mutex::new(None);
/// Stdin handle — separate so we can write without blocking on wait.
static INSTALL_STDIN: Mutex<Option<std::process::ChildStdin>> = Mutex::new(None);

/// Start mod_installer as a subprocess, streaming output via Tauri events.
#[tauri::command]
pub fn start_install(
    app: AppHandle,
    mod_installer_path: String,
    args: Vec<String>,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    let mut cmd = Command::new(&mod_installer_path);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::piped());

    // Prevent a blank CMD window from appearing on Windows
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to start mod_installer: {e}"))?;

    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();

    // Store PID and stdin separately — no Mutex around Child itself
    {
        let mut lock = INSTALL_PID.lock().map_err(|e| e.to_string())?;
        *lock = Some(pid);
    }
    {
        let mut lock = INSTALL_STDIN.lock().map_err(|e| e.to_string())?;
        *lock = stdin;
    }

    let app_out = app.clone();
    let app_err = app.clone();
    let app_exit = app.clone();

    // Stream stdout
    if let Some(out) = stdout {
        std::thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let _ = app_out.emit("install-stdout", &line);
                }
            }
        });
    }

    // Stream stderr
    if let Some(err) = stderr {
        std::thread::spawn(move || {
            let reader = BufReader::new(err);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let _ = app_err.emit("install-stderr", &line);
                }
            }
        });
    }

    // Wait for exit in a thread — owns the Child, no Mutex needed
    std::thread::spawn(move || {
        let exit_code = match child.wait() {
            Ok(status) => status.code().unwrap_or(-1),
            Err(_) => -1,
        };
        // Clear PID and stdin (use .ok() to avoid panic on poisoned mutex)
        if let Ok(mut lock) = INSTALL_PID.lock() {
            *lock = None;
        }
        if let Ok(mut lock) = INSTALL_STDIN.lock() {
            *lock = None;
        }
        let _ = app_exit.emit("install-exit", exit_code);
    });

    Ok(())
}

/// Send input to the running mod_installer process stdin.
#[tauri::command]
pub fn send_install_input(text: String) -> Result<(), String> {
    use std::io::Write;
    let mut lock = INSTALL_STDIN.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut stdin) = *lock {
        stdin.write_all(text.as_bytes()).map_err(|e| format!("stdin write failed: {e}"))?;
        stdin.write_all(b"\n").map_err(|e| format!("stdin write failed: {e}"))?;
        stdin.flush().map_err(|e| format!("stdin flush failed: {e}"))?;
        return Ok(());
    }
    Err("No running install process".to_string())
}

/// Kill the running mod_installer process and its entire process tree.
#[tauri::command]
pub fn abort_install() -> Result<(), String> {
    let pid = {
        let lock = INSTALL_PID.lock().map_err(|e| e.to_string())?;
        *lock
    };

    if let Some(pid) = pid {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            // Fire and forget — taskkill in background thread
            std::thread::spawn(move || {
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(0x08000000)
                    .output();
            });
        }
        #[cfg(not(target_os = "windows"))]
        {
            // Kill the process and its children. We send SIGTERM to the process
            // (not the process group, since we didn't start it as a group leader).
            // Then follow up with SIGKILL if it doesn't die.
            if pid > 0 {
                std::thread::spawn(move || {
                    unsafe {
                        libc::kill(pid as i32, libc::SIGTERM);
                    }
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    unsafe {
                        libc::kill(pid as i32, libc::SIGKILL);
                    }
                });
            }
        }
    }
    Ok(())
}

// ─── Pause / Resume ───

/// Request a pause by creating a `pause_requested` file in the game directory.
/// mod_installer checks for this file between mods and pauses if found.
#[tauri::command]
pub fn request_pause(game_dir: String) -> Result<(), String> {
    let pause_file = Path::new(&game_dir).join("pause_requested");
    std::fs::write(&pause_file, "paused by EET Mod Runner")
        .map_err(|e| format!("Failed to create pause file: {e}"))?;
    Ok(())
}

/// Resume by deleting the `pause_requested` file.
#[tauri::command]
pub fn request_resume(game_dir: String) -> Result<(), String> {
    let pause_file = Path::new(&game_dir).join("pause_requested");
    if pause_file.exists() {
        std::fs::remove_file(&pause_file)
            .map_err(|e| format!("Failed to remove pause file: {e}"))?;
    }
    Ok(())
}

/// Check if a pause is currently requested or active.
#[tauri::command]
pub fn check_pause_state(game_dir: String) -> Result<PauseState, String> {
    let pause_file = Path::new(&game_dir).join("pause_requested");
    let pause_requested = pause_file.exists();

    // Check install_status.json for "paused" status (mod_installer confirms the pause)
    let status_path = Path::new(&game_dir).join("install_status.json");
    let is_paused = if status_path.exists() {
        std::fs::read_to_string(&status_path)
            .ok()
            .and_then(|s| serde_json::from_str::<InstallStatus>(&s).ok())
            .map(|s| s.status == "paused")
            .unwrap_or(false)
    } else {
        false
    };

    Ok(PauseState {
        pause_requested,
        is_paused,
    })
}

#[derive(serde::Serialize)]
pub struct PauseState {
    pub pause_requested: bool,
    pub is_paused: bool,
}

// ─── Install Comparison ───

/// Compare an exported WeiDU.log against what's actually installed in the game directory.
/// Parses both logs, diffs them, and groups missing components by mod.
#[tauri::command]
pub fn compare_install_logs(export_log_path: String, game_dir: String) -> Result<CompareResult, String> {
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
pub fn read_file_contents(path: String) -> Result<String, String> {
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
}

/// Parse a large WeiDU debug log in the Rust backend (for files too big for the WebView).
/// Scans line-by-line without loading the entire file into memory.
#[tauri::command]
pub fn parse_debug_file(path: String) -> Result<DebugParseSummary, String> {
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
    let app_dir = config_dir.join("eet-mod-runner");
    std::fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create config dir: {e}"))?;
    Ok(app_dir.join("gui.log"))
}

/// Append an entry to gui.log. Timestamp provided by the frontend (ISO format).
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
pub fn read_gui_log() -> Result<String, String> {
    let path = gui_log_path()?;
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read gui.log: {e}"))
}

/// Clear the gui.log (start fresh).
#[tauri::command]
pub fn clear_gui_log() -> Result<(), String> {
    let path = gui_log_path()?;
    if path.exists() {
        std::fs::write(&path, "")
            .map_err(|e| format!("Failed to clear gui.log: {e}"))?;
    }
    Ok(())
}

/// Get the path to gui.log (so users know where to find it).
#[tauri::command]
pub fn get_gui_log_path() -> Result<String, String> {
    gui_log_path().map(|p| p.to_string_lossy().to_string())
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

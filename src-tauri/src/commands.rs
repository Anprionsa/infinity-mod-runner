use crate::config::AppConfig;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

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

/// Read install_status.json from the game directory (written by mod_installer).
/// Uses read() instead of read_to_string() for more reliable access on Windows
/// when mod_installer may have the file open for writing.
#[tauri::command]
pub async fn read_install_status(game_dir: String) -> Result<Option<InstallStatus>, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let status_path = Path::new(&game_dir).join("install_status.json");
    if !status_path.exists() {
        return Ok(None);
    }

    // On Windows, use explicit share mode to read files that mod_installer may have open.
    // std::fs::read can return cached/stale data if the file is being written to by another process.
    #[cfg(target_os = "windows")]
    let bytes = {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x00000001;
        const FILE_SHARE_WRITE: u32 = 0x00000002;
        const FILE_SHARE_DELETE: u32 = 0x00000004;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(&status_path);
        match file {
            Ok(mut f) => {
                use std::io::Read;
                let mut buf = Vec::new();
                match f.read_to_end(&mut buf) {
                    Ok(_) => buf,
                    Err(e) => return Err(format!("status read error: {e}")),
                }
            }
            Err(e) => return Err(format!("status open error: {e}")),
        }
    };

    #[cfg(not(target_os = "windows"))]
    let bytes = match std::fs::read(&status_path) {
        Ok(b) => b,
        Err(e) => return Err(format!("status read error: {e}")),
    };

    let contents = String::from_utf8_lossy(&bytes);
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
  }).await.map_err(|e| e.to_string())?
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
pub async fn read_error_log(game_dir: String, after_line: usize) -> Result<ErrorLogResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    }).await.map_err(|e| e.to_string())?
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
pub async fn start_install(
    app: AppHandle,
    mod_installer_path: String,
    args: Vec<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    }).await.map_err(|e| e.to_string())?
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

/// Gracefully stop the running install. Sends Ctrl+C (CTRL_BREAK_EVENT on Windows,
/// SIGINT on Unix) first, waits 10 seconds, then force-kills if still alive.
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
            std::thread::spawn(move || {
                // First try graceful: send CTRL_BREAK_EVENT to the process
                // This lets WeiDU finish its current operation and clean up
                unsafe {
                    // GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT=1, processGroupId=pid)
                    #[link(name = "kernel32")]
                    unsafe extern "system" {
                        fn GenerateConsoleCtrlEvent(event: u32, group_id: u32) -> i32;
                    }
                    GenerateConsoleCtrlEvent(1, pid);
                }

                // Wait up to 10 seconds for graceful exit
                std::thread::sleep(std::time::Duration::from_secs(10));

                // Check if still alive by trying taskkill without /F first
                let check = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(0x08000000)
                    .output();
                if let Ok(output) = check {
                    if !output.status.success() {
                        // Already dead — good
                    }
                }
            });
        }
        #[cfg(not(target_os = "windows"))]
        {
            if pid > 0 {
                std::thread::spawn(move || {
                    // Graceful: SIGINT (Ctrl+C equivalent)
                    unsafe {
                        libc::kill(pid as i32, libc::SIGINT);
                    }
                    // Wait 10 seconds
                    std::thread::sleep(std::time::Duration::from_secs(10));
                    // Force kill if still alive
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
            result.insert(tp2_path.clone(), found_tp2s.contains(&tp2_filename));
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
    use std::io::{Read, Write};

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
        .header("User-Agent", "EET-Mod-Runner/0.8.0")
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

/// Path to the download plan cache file in the app config directory.
fn download_cache_path() -> Result<std::path::PathBuf, String> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| "Cannot determine config directory".to_string())?;
    let app_dir = config_dir.join("eet-mod-runner");
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

// ─── Pre-Install Patcher ───

#[derive(serde::Deserialize)]
struct PatchManifestEntry {
    id: u32,
    name: String,
    description: String,
    target_mod: Option<String>,
    trigger: serde_json::Value,
    marker: serde_json::Value,
    ops: Vec<serde_json::Value>,
}

#[derive(serde::Serialize)]
pub struct PatchStatus {
    pub id: u32,
    pub name: String,
    pub description: String,
    pub target_mod: Option<String>,
    pub status: String,  // "applicable", "already_patched", "not_needed"
}

#[derive(serde::Serialize)]
pub struct PatchResult {
    pub id: u32,
    pub name: String,
    pub status: String,  // "applied", "already_patched", "failed"
    pub error: Option<String>,
}

fn load_manifest(resource_dir: &Path) -> Result<Vec<PatchManifestEntry>, String> {
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
fn build_mod_location_map(mod_dir: &Path) -> std::collections::HashMap<String, std::path::PathBuf> {
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

fn check_trigger(
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

fn check_marker(
    mod_dir: &Path,
    game_dir: &Path,
    marker: &serde_json::Value,
    mod_locations: &std::collections::HashMap<String, std::path::PathBuf>,
) -> bool {
    let invert = marker.get("invert").and_then(|v| v.as_bool()).unwrap_or(false);

    if let Some(file) = marker.get("file").and_then(|v| v.as_str()) {
        if marker.get("text").is_none() || marker.get("text").unwrap().is_null() {
            if let Some(check_dir) = marker.get("check_dir").and_then(|v| v.as_str()) {
                return resolve_mod_path_with_map(mod_dir, check_dir, mod_locations).is_some();
            }
            if let Some(check_game) = marker.get("check_game_file").and_then(|v| v.as_str()) {
                return game_dir.join(check_game).exists();
            }
            return resolve_mod_path_with_map(mod_dir, file, mod_locations).is_some();
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
        if let Some(check_dir) = marker.get("check_dir").and_then(|v| v.as_str()) {
            return resolve_mod_path_with_map(mod_dir, check_dir, mod_locations).is_some();
        }
        if let Some(check_game) = marker.get("check_game_file").and_then(|v| v.as_str()) {
            return game_dir.join(check_game).exists();
        }
        if let Some(check_game_dir) = marker.get("check_game_dir").and_then(|v| v.as_str()) {
            return game_dir.join(check_game_dir).is_dir();
        }
        // Check if a game file contains a specific string
        if let Some(obj) = marker.get("check_game_file_contains") {
            let file = obj.get("file").and_then(|v| v.as_str()).unwrap_or("");
            let text = obj.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let filepath = game_dir.join(file);
            if filepath.exists() {
                if let Ok(contents) = std::fs::read_to_string(&filepath) {
                    return contents.contains(text);
                }
            }
            return false;
        }
        false
    }
}

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
                let dest_path = resolve_mod_path_with_map(mod_dir, dest, mod_locations)
                    .unwrap_or_else(|| mod_dir.join(dest));
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
                let filepath = resolve_mod_path_with_map(mod_dir, file, mod_locations)
                    .unwrap_or_else(|| mod_dir.join(file));
                let contents = std::fs::read_to_string(&filepath)
                    .map_err(|e| format!("read failed {}: {e}", filepath.display()))?;
                let new_contents = contents.replace(find, replace_str);
                if new_contents != contents {
                    std::fs::write(&filepath, &new_contents)
                        .map_err(|e| format!("write failed {}: {e}", filepath.display()))?;
                }
            }
            "rename" => {
                let from = op.get("from").and_then(|v| v.as_str())
                    .ok_or("rename op missing from")?;
                let to = op.get("to").and_then(|v| v.as_str())
                    .ok_or("rename op missing to")?;
                let from_path = resolve_mod_path_with_map(mod_dir, from, mod_locations)
                    .unwrap_or_else(|| mod_dir.join(from));
                // For 'to', resolve the first segment the same way as 'from'
                let to_path = resolve_mod_path_with_map(mod_dir, to, mod_locations)
                    .unwrap_or_else(|| mod_dir.join(to));
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

        for entry in &manifest {
            let triggered = check_trigger(mod_path, game_path, &entry.trigger, &mod_locations);
            if !triggered {
                results.push(PatchStatus {
                    id: entry.id,
                    name: entry.name.clone(),
                    description: entry.description.clone(),
                    target_mod: entry.target_mod.clone(),
                    status: "not_needed".to_string(),
                });
                continue;
            }

            let already_patched = check_marker(mod_path, game_path, &entry.marker, &mod_locations);
            results.push(PatchStatus {
                id: entry.id,
                name: entry.name.clone(),
                description: entry.description.clone(),
                target_mod: entry.target_mod.clone(),
                status: if already_patched { "already_patched" } else { "applicable" }.to_string(),
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

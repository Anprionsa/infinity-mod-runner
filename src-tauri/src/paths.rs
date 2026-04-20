//! Centralized resolver for every file Infinity Mod Runner writes to disk.
//!
//! Phase 21a: before this module, log paths were derived ad-hoc in every
//! consumer — `commands.rs` built `gui.log`, `install_log.rs` built
//! `install.log`, `file_guard.rs` built `guard_report.json`, and so on.
//! That led to subtle drift risks (the UI telling the user "logs live
//! at X" while the Rust code wrote them at Y). Now everything goes
//! through `resolve_log_paths` so the UI surface and the writing code
//! agree by construction.
//!
//! Layout is intentionally NOT centralized into one folder:
//!
//!   * `gui.log` + `config.toml` live in Tauri's OS-standard app-config
//!     dir (%APPDATA% on Windows, ~/Library/Application Support on macOS,
//!     ~/.config on Linux). Moving them breaks Tauri convention and the
//!     "Windows Settings → Apps → clear data" UX.
//!   * `install.log` and its siblings live in `<data_dir>/<game-hash>/`.
//!     The per-game hash is load-bearing: multiple game installs on one
//!     machine must not share an install log.
//!   * Backups (not handled here) live in a user-configurable directory
//!     because a BG2 megainstall snapshot can be tens of GB.
//!
//! The "centralization" story is about the USER-FACING SURFACE: one
//! Tauri command (`get_log_paths`) returns every path, and the UI can
//! present them as a single list — even though they live in three
//! different roots.

use crate::config::AppConfig;
use serde::Serialize;
use std::path::PathBuf;

// ── Canonical filenames ────────────────────────────────────────────
// These literal strings appear in exactly one place (here). Writers
// in install_log.rs, file_guard.rs, orchestrator.rs, etc. join these
// constants onto their data_dir instead of hardcoding the filename.
// Phase 21a drift prevention — any future rename goes through this
// module so the UI and the writer can't disagree.

/// `gui.log` basename (lives in app_config_root).
pub const FILE_GUI_LOG: &str = "gui.log";
/// `install.log` basename (lives in game_data_dir).
pub const FILE_INSTALL_LOG: &str = "install.log";
/// `guard_report.json` basename (lives in game_data_dir).
pub const FILE_GUARD_REPORT: &str = "guard_report.json";
/// `checkpoint.json` basename (lives in game_data_dir).
pub const FILE_CHECKPOINT: &str = "checkpoint.json";
/// `reports/` subdirectory name (lives under game_data_dir).
pub const DIR_REPORTS: &str = "reports";

/// Every log / report / state path the app knows about, for a given
/// config. Fields are `Option<PathBuf>` when the path depends on a
/// game directory being configured — a fresh-install user with no
/// paths set yet gets `None` for everything per-game, but still gets
/// `gui_log`, `config_toml`, and `app_config_root`.
#[derive(Debug, Clone, Serialize)]
pub struct LogPaths {
    /// `gui.log` — app-lifecycle log, in Tauri app-config dir.
    pub gui_log: PathBuf,
    /// Rotated siblings: `gui.log.1` through `gui.log.N` + any
    /// `gui.log.prev-<version>` left over from previous app versions.
    /// Ordered newest → oldest by filesystem mtime. Empty if none exist.
    pub gui_log_rotated: Vec<PathBuf>,
    /// `install.log` for the currently-configured game. `None` when
    /// `bg2_game_dir` isn't set yet (can't compute the per-game hash).
    pub install_log: Option<PathBuf>,
    /// Directory holding `install_report_*.json` files. May not exist
    /// yet even when `Some(_)` — only created on first Save Report.
    pub reports_dir: Option<PathBuf>,
    /// `guard_report.json` — File Guard's cross-mod-corruption log.
    /// Only written when the guard fires during an install.
    pub guard_report: Option<PathBuf>,
    /// `checkpoint.json` — resume state, cleared on successful complete.
    pub checkpoint: Option<PathBuf>,
    /// `config.toml` — user configuration. Confy-managed; path varies
    /// per OS. Resolved via `confy::get_configuration_file_path` so
    /// this module never has to know the confy naming rules.
    pub config_toml: PathBuf,
    /// Resolved data root (user's `data_directory` setting, or the
    /// fallback `<exe-dir>/data/`). The per-game subfolder under this
    /// is where `install.log` et al live. `None` when no game dir is
    /// set (fallback root exists, but there's no per-game subdir yet).
    pub data_root: Option<PathBuf>,
    /// Per-game subfolder (`<data_root>/<game-hash>`). Same `None`
    /// condition as the other per-game paths.
    pub game_data_dir: Option<PathBuf>,
    /// Tauri's OS-standard app-config dir. Parent of gui.log and
    /// config.toml. Always resolvable — can't be configured away.
    pub app_config_root: PathBuf,
}

/// Resolve every known log/report/state path for the given config.
///
/// Does NOT create any directories as a side effect — resolution is
/// pure. Callers that need a directory created before writing should
/// do it themselves (the install logger already handles this).
pub fn resolve_log_paths(config: &AppConfig) -> Result<LogPaths, String> {
    // ── Tauri app-config root ──
    let app_config_root = dirs::config_dir()
        .ok_or_else(|| "Cannot determine OS config directory".to_string())?
        .join("infinity-mod-runner");

    // ── gui.log + rotated siblings ──
    let gui_log = app_config_root.join(FILE_GUI_LOG);
    let gui_log_rotated = collect_rotated_gui_logs(&app_config_root);

    // ── config.toml (confy-managed path) ──
    let config_toml = confy::get_configuration_file_path("infinity-mod-runner", "config")
        .map_err(|e| format!("Failed to resolve config path: {e}"))?;

    // ── Data root ──
    // Mirrors `installer::resolve_data_dir` so the writer and the
    // reporter agree. If the user set `data_directory`, use it; else
    // fall back to `<exe-dir>/data`. When neither works (e.g. portable
    // mode without a resolvable exe dir), report `None` — the caller
    // surfaces that to the user as "not yet created".
    let data_root = config.data_directory.as_ref()
        .map(PathBuf::from)
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.join("data")))
        });

    // ── Per-game subfolder and its contents ──
    // Requires bg2_game_dir to be set — that's what `resolve_data_dir`
    // hashes. If a user only has bg1/iwd configured (unusual), they'll
    // see no game-specific logs here; that's accurate, because no
    // install has run for this config yet.
    let (game_data_dir, install_log, reports_dir, guard_report, checkpoint) = match (
        config.bg2_game_dir.as_deref(),
        data_root.as_ref(),
    ) {
        (Some(bg2), Some(root)) if !bg2.is_empty() => {
            let game_hash = short_path_hash(bg2);
            let dir = root.join(&game_hash);
            (
                Some(dir.clone()),
                Some(dir.join(FILE_INSTALL_LOG)),
                Some(dir.join(DIR_REPORTS)),
                Some(dir.join(FILE_GUARD_REPORT)),
                Some(dir.join(FILE_CHECKPOINT)),
            )
        }
        _ => (None, None, None, None, None),
    };

    Ok(LogPaths {
        gui_log,
        gui_log_rotated,
        install_log,
        reports_dir,
        guard_report,
        checkpoint,
        config_toml,
        data_root,
        game_data_dir,
        app_config_root,
    })
}

/// Same deterministic hash the installer uses for per-game data dirs.
/// Duplicated here (rather than calling `installer::short_path_hash`)
/// to avoid a dependency cycle — `installer` uses paths from `paths`,
/// so `paths` can't import from `installer`. The implementation is
/// cheap; the risk of drift is addressed by a test below.
fn short_path_hash(input: &str) -> String {
    let normalized = input.replace('\\', "/").to_lowercase();
    // FNV-1a 64-bit, truncated to 12 hex chars. Exactly mirrors
    // `installer::short_path_hash`; tested below.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in normalized.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:012x}", hash & 0x0000ffffffffffff)
}

/// Scan `app_config_root` for rotated gui.log files. Two shapes:
///
///   * `gui.log.1` .. `gui.log.N` — current numbered-rotation files
///   * `gui.log.prev-<version>` — a rename the rotator performs when
///     it detects a version bump, preserving the last session of the
///     prior version separately from the numbered rotation
///
/// Order: newest-mtime first so UI panels can show "most recent first"
/// without re-sorting. Empty vec when the dir doesn't exist or no
/// rotated files are present.
fn collect_rotated_gui_logs(app_config_root: &std::path::Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(app_config_root) else { return Vec::new() };
    let mut found: Vec<(PathBuf, std::time::SystemTime)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name();
            let n = name.to_string_lossy();
            let matches = n.starts_with("gui.log.")
                && n != "gui.log"
                && n != "gui.log.state.json";
            if !matches { return None; }
            let meta = e.metadata().ok()?;
            let mtime = meta.modified().ok()?;
            Some((e.path(), mtime))
        })
        .collect();
    // Newest first.
    found.sort_by(|a, b| b.1.cmp(&a.1));
    found.into_iter().map(|(p, _)| p).collect()
}

// ── Tauri commands ─────────────────────────────────────────────────

/// Return every resolvable log/report path for the currently-loaded config.
/// The frontend calls this once when the Logs & Diagnostics panel mounts
/// and on every ~30s refresh tick while visible.
#[tauri::command]
pub fn get_log_paths(config: AppConfig) -> Result<LogPathsWithMeta, String> {
    let paths = resolve_log_paths(&config)?;
    Ok(enrich_with_file_metadata(paths))
}

/// LogPaths + per-file metadata (size + modified timestamp) for the UI.
/// Kept as a separate struct so the pure-path resolver (`resolve_log_paths`)
/// stays testable without touching the filesystem, while the UI gets
/// everything it needs in one round-trip.
#[derive(Debug, Clone, Serialize)]
pub struct LogPathsWithMeta {
    pub paths: LogPaths,
    /// Parallel data: for each path in `paths`, whether it exists, its
    /// size, and its last-modified time (millis since Unix epoch).
    /// Shape chosen so the frontend can render "— size — modified" per
    /// row without caring about Option<PathBuf> layout.
    pub files: Vec<FileMeta>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileMeta {
    /// Short identifier the frontend matches on ("gui_log", "install_log",
    /// "config_toml", etc.). Stable API — don't rename without updating
    /// LogsPanel.tsx.
    pub key: String,
    /// Resolved path as a display string, or null when the path
    /// couldn't be computed (e.g. no game dir configured).
    pub path: Option<String>,
    /// Whether the file (or directory, for reports_dir / game_data_dir)
    /// currently exists on disk.
    pub exists: bool,
    /// Size in bytes. For directories, sum of immediate children.
    /// Zero when the path doesn't exist or is unresolved.
    pub size: u64,
    /// Last-modified time in millis since Unix epoch. Zero when the
    /// path doesn't exist or the modified time can't be read.
    pub modified_ms: u64,
}

fn enrich_with_file_metadata(paths: LogPaths) -> LogPathsWithMeta {
    // Helper: file or dir (for reports_dir) existence + size + mtime.
    // For directories, we sum immediate children — good enough for the
    // UI's "size" readout and doesn't recurse into unbounded trees.
    fn meta(path: &std::path::Path) -> (bool, u64, u64) {
        let Ok(m) = std::fs::metadata(path) else { return (false, 0, 0) };
        let mtime_ms = m.modified().ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if m.is_file() {
            return (true, m.len(), mtime_ms);
        }
        if m.is_dir() {
            let size = std::fs::read_dir(path)
                .ok()
                .map(|entries| entries
                    .filter_map(|e| e.ok())
                    .filter_map(|e| e.metadata().ok())
                    .filter(|m| m.is_file())
                    .map(|m| m.len())
                    .sum::<u64>())
                .unwrap_or(0);
            return (true, size, mtime_ms);
        }
        (false, 0, 0)
    }

    fn file_meta(key: &str, path: Option<&std::path::Path>) -> FileMeta {
        match path {
            Some(p) => {
                let (exists, size, modified_ms) = meta(p);
                FileMeta {
                    key: key.to_string(),
                    path: Some(p.display().to_string()),
                    exists, size, modified_ms,
                }
            }
            None => FileMeta {
                key: key.to_string(),
                path: None,
                exists: false,
                size: 0,
                modified_ms: 0,
            },
        }
    }

    let files = vec![
        file_meta("gui_log", Some(&paths.gui_log)),
        file_meta("config_toml", Some(&paths.config_toml)),
        file_meta("app_config_root", Some(&paths.app_config_root)),
        file_meta("data_root", paths.data_root.as_deref()),
        file_meta("game_data_dir", paths.game_data_dir.as_deref()),
        file_meta("install_log", paths.install_log.as_deref()),
        file_meta("reports_dir", paths.reports_dir.as_deref()),
        file_meta("guard_report", paths.guard_report.as_deref()),
        file_meta("checkpoint", paths.checkpoint.as_deref()),
    ];

    LogPathsWithMeta { paths, files }
}

/// Open a file's containing folder (or the folder itself) in the OS
/// file manager. Uses platform-native "reveal in explorer" semantics
/// when available — Windows highlights the file, macOS selects it,
/// Linux just opens the parent directory because there's no universal
/// "select this file" API across the Linux file-manager zoo.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("explorer.exe");
        if p.is_file() {
            // `/select,<file>` asks Explorer to open the parent and
            // highlight the file. Note: Explorer is peculiar about
            // the comma — no space between `/select,` and the path.
            cmd.arg(format!("/select,{}", path));
        } else {
            cmd.arg(&path);
        }
        // Explorer returns exit code 1 even on success in some
        // configurations — treat spawn-succeeded as OK, ignore the
        // child's exit status.
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to open Explorer: {e}"))
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if p.is_file() {
            cmd.args(["-R", &path]);
        } else {
            cmd.arg(&path);
        }
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to open Finder: {e}"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Linux has no universal "reveal" API — xdg-open the parent
        // directory when given a file, or the dir itself otherwise.
        let target = if p.is_file() {
            p.parent().map(|pp| pp.to_path_buf()).unwrap_or(p.to_path_buf())
        } else {
            p.to_path_buf()
        };
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to run xdg-open: {e}"))
    }
}

// ── Diagnostic bundle (Phase 21d) ──────────────────────────────────

/// Config fields whose values get replaced with `<redacted-{field}>`
/// when building a diagnostic bundle. These are the path fields — the
/// install paths, mod directory, backup directories, custom WeiDU
/// binary, custom data dir, custom fast-drive target. Everything else
/// in `config.toml` (booleans, numbers, language codes, telemetry
/// opt-in, saved preferences blob) is non-sensitive and kept intact.
///
/// The `forge_data_url` case is special-cased in the redactor: only
/// non-default values are redacted, so the default Forge URL stays
/// visible for context (helpful when debugging "am I hitting the
/// right Forge?").
const REDACTED_FIELDS: &[&str] = &[
    "bg1_game_dir",
    "bg2_game_dir",
    "iwd_game_dir",
    "iwd2_game_dir",
    "pst_game_dir",
    "mod_directory",
    "weidu_path",
    "data_directory",
    "backup_directory",
    "backup_directory_bg1",
    "backup_directory_bg2",
    "backup_directory_iwd",
    "backup_directory_iwd2",
    "backup_directory_pst",
    "override_fast_drive_path",
    "last_log_path",
    "eet_log_path",
    "bgee_log_path",
];

const DEFAULT_FORGE_URL: &str = "https://anprionsa.github.io/infinity-mod-forge";

/// Redact path-shaped config values from a TOML string. Line-based
/// rewrite rather than round-trip TOML parsing — we want the output
/// to stay human-readable and comment-preserving, and confy doesn't
/// use exotic TOML shapes so regex is safe here.
fn redact_config_toml(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for line in raw.lines() {
        let trimmed = line.trim_start();
        let mut rewritten: Option<String> = None;
        for field in REDACTED_FIELDS {
            // Match `field = "…"` or `field = 123` or `field =` (empty).
            // Also handle `field = [values]` defensively, though none
            // of our redacted fields are currently arrays.
            if trimmed.starts_with(field) {
                let after = &trimmed[field.len()..];
                // Require an `=` to follow (possibly with whitespace)
                // to avoid matching e.g. `field_extra`.
                if let Some(eq_idx) = after.find('=') {
                    let pre_eq = &after[..eq_idx];
                    if pre_eq.chars().all(|c| c.is_whitespace()) {
                        let indent = &line[..line.len() - trimmed.len()];
                        rewritten = Some(format!(
                            "{}{} = \"<redacted-{}>\"",
                            indent, field, field
                        ));
                        break;
                    }
                }
            }
        }
        // Special case: forge_data_url — redact only if non-default.
        if rewritten.is_none() && trimmed.starts_with("forge_data_url") {
            let after = &trimmed["forge_data_url".len()..];
            if let Some(eq_idx) = after.find('=') {
                let pre_eq = &after[..eq_idx];
                if pre_eq.chars().all(|c| c.is_whitespace()) {
                    let value_part = after[eq_idx + 1..].trim();
                    // Strip surrounding quotes if present for the compare.
                    let value_unquoted = value_part.trim_matches('"');
                    if !value_unquoted.is_empty() && value_unquoted != DEFAULT_FORGE_URL {
                        let indent = &line[..line.len() - trimmed.len()];
                        rewritten = Some(format!(
                            "{}forge_data_url = \"<redacted-forge_data_url>\"",
                            indent
                        ));
                    }
                }
            }
        }
        out.push_str(rewritten.as_deref().unwrap_or(line));
        out.push('\n');
    }
    out
}

/// Summary returned from `create_diagnostic_bundle`. Carries the final
/// bundle path plus a manifest the UI can display to reassure the user
/// what's inside before they hand it off. No personal paths in the
/// summary itself — only filenames and sizes.
#[derive(Debug, Clone, Serialize)]
pub struct BundleSummary {
    pub bundle_path: String,
    pub bundle_size: u64,
    pub entries: Vec<BundleEntry>,
    pub redacted_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BundleEntry {
    pub name: String,
    pub size: u64,
}

/// Package the app's logs + a redacted copy of the config into a zip
/// file the user can hand off to a forum post or help chat. Local only
/// — no network. Output path is the user's choice (picked via file
/// picker on the UI side); this command just writes to whatever
/// absolute path it gets.
///
/// Contents:
///   - gui.log + all rotated gui.log.* siblings
///   - install.log (if present for this game)
///   - Latest 3 install_report_*.json files (if present)
///   - guard_report.json (if present)
///   - config-redacted.toml (path fields replaced with sentinels)
///   - BUNDLE_INFO.txt (manifest: what's inside, redaction rules,
///     app version, OS, timestamp)
///   - README.md (a bundled copy of resources/LOGS.md so the recipient
///     has context on the file formats)
#[tauri::command]
pub fn create_diagnostic_bundle(
    config: AppConfig,
    output_path: String,
) -> Result<BundleSummary, String> {
    use std::io::{Read, Write};

    let paths = resolve_log_paths(&config)?;

    // Open the output file for writing.
    let out_file = std::fs::File::create(&output_path)
        .map_err(|e| format!("Failed to create bundle file: {e}"))?;
    let mut zip = zip::ZipWriter::new(out_file);
    let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(6));

    let mut entries: Vec<BundleEntry> = Vec::new();

    // Helper to add a file (by-path) to the zip under a given archive name.
    let mut add_file = |archive_name: &str, src: &std::path::Path, entries: &mut Vec<BundleEntry>| -> Result<(), String> {
        let mut f = match std::fs::File::open(src) {
            Ok(f) => f,
            Err(_) => return Ok(()), // Skip missing files silently.
        };
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)
            .map_err(|e| format!("Read {}: {e}", src.display()))?;
        let size = buf.len() as u64;
        zip.start_file(archive_name, opts)
            .map_err(|e| format!("Zip start_file: {e}"))?;
        zip.write_all(&buf)
            .map_err(|e| format!("Zip write: {e}"))?;
        entries.push(BundleEntry { name: archive_name.to_string(), size });
        Ok(())
    };

    // 1. gui.log + rotated siblings. Rotated files go under a subdir
    // so the recipient can tell at a glance which is current.
    add_file("gui.log", &paths.gui_log, &mut entries)?;
    for rotated in &paths.gui_log_rotated {
        let name = rotated.file_name()
            .map(|n| format!("gui-log-rotated/{}", n.to_string_lossy()))
            .unwrap_or_else(|| "gui-log-rotated/unknown".to_string());
        add_file(&name, rotated, &mut entries)?;
    }

    // 2. install.log for the current game.
    if let Some(p) = &paths.install_log {
        add_file("install.log", p, &mut entries)?;
    }

    // 3. Latest 3 install_report_*.json files.
    if let Some(reports_dir) = &paths.reports_dir {
        if let Ok(read) = std::fs::read_dir(reports_dir) {
            let mut candidates: Vec<(std::path::PathBuf, std::time::SystemTime)> = read
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.file_name().to_string_lossy().starts_with("install_report_")
                        && e.file_name().to_string_lossy().ends_with(".json")
                })
                .filter_map(|e| {
                    let meta = e.metadata().ok()?;
                    let mtime = meta.modified().ok()?;
                    Some((e.path(), mtime))
                })
                .collect();
            candidates.sort_by(|a, b| b.1.cmp(&a.1));
            for (p, _) in candidates.into_iter().take(3) {
                let name = p.file_name()
                    .map(|n| format!("reports/{}", n.to_string_lossy()))
                    .unwrap_or_else(|| "reports/unknown.json".to_string());
                add_file(&name, &p, &mut entries)?;
            }
        }
    }

    // 4. guard_report.json.
    if let Some(p) = &paths.guard_report {
        add_file("guard_report.json", p, &mut entries)?;
    }

    // 5. Redacted config. Read, redact, write to zip as a string.
    if paths.config_toml.exists() {
        let raw = std::fs::read_to_string(&paths.config_toml)
            .map_err(|e| format!("Read config.toml: {e}"))?;
        let redacted = redact_config_toml(&raw);
        let bytes = redacted.as_bytes();
        zip.start_file("config-redacted.toml", opts)
            .map_err(|e| format!("Zip start_file: {e}"))?;
        zip.write_all(bytes)
            .map_err(|e| format!("Zip write: {e}"))?;
        entries.push(BundleEntry {
            name: "config-redacted.toml".to_string(),
            size: bytes.len() as u64,
        });
    }

    // 6. BUNDLE_INFO.txt — manifest.
    let app_version = env!("CARGO_PKG_VERSION");
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let timestamp = simple_utc_timestamp();
    let manifest = build_bundle_manifest(
        &entries,
        app_version,
        os,
        arch,
        &timestamp,
    );
    let manifest_bytes = manifest.as_bytes();
    zip.start_file("BUNDLE_INFO.txt", opts)
        .map_err(|e| format!("Zip start_file: {e}"))?;
    zip.write_all(manifest_bytes)
        .map_err(|e| format!("Zip write: {e}"))?;
    entries.push(BundleEntry {
        name: "BUNDLE_INFO.txt".to_string(),
        size: manifest_bytes.len() as u64,
    });

    // 7. Bundled copy of resources/LOGS.md as README.md so the recipient
    // sees documentation first when extracting the zip. Written as
    // embedded content (loaded at build-time via include_str!) — the
    // source file lives under `src-tauri/resources/` (tracked in git)
    // so the binary is always self-contained and fresh clones / CI
    // can build without depending on the gitignored `docs/` folder.
    let docs_content = include_str!("../resources/LOGS.md");
    zip.start_file("README.md", opts)
        .map_err(|e| format!("Zip start_file: {e}"))?;
    zip.write_all(docs_content.as_bytes())
        .map_err(|e| format!("Zip write: {e}"))?;
    entries.push(BundleEntry {
        name: "README.md".to_string(),
        size: docs_content.len() as u64,
    });

    zip.finish().map_err(|e| format!("Zip finish: {e}"))?;

    let bundle_size = std::fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(BundleSummary {
        bundle_path: output_path,
        bundle_size,
        entries,
        redacted_fields: REDACTED_FIELDS.iter().map(|s| s.to_string()).collect(),
    })
}

/// Minimal ISO-ish UTC timestamp `YYYY-MM-DD HH:MM:SS UTC`. Duplicates the
/// approach in `backup::format_timestamp` so we don't need a chrono dep
/// just for a human-readable timestamp in the manifest. Leap-year math
/// only needs to hold for the Gregorian calendar past epoch, which is
/// comfortable for the app's lifetime.
fn simple_utc_timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Day-of-epoch → Y-M-D (Gregorian, simplified from backup::days_to_date).
    let mut year: u64 = 1970;
    let mut d = days;
    loop {
        let year_days = if is_leap_year(year) { 366 } else { 365 };
        if d < year_days { break; }
        d -= year_days;
        year += 1;
    }
    let months_days = if is_leap_year(year) {
        [31u64, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31u64, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut month = 1usize;
    for (idx, dim) in months_days.iter().enumerate() {
        if d < *dim {
            month = idx + 1;
            break;
        }
        d -= *dim;
    }
    let day = d + 1;
    format!("{year:04}-{month:02}-{day:02} {hours:02}:{minutes:02}:{seconds:02} UTC")
}

fn is_leap_year(y: u64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn build_bundle_manifest(
    entries: &[BundleEntry],
    app_version: &str,
    os: &str,
    arch: &str,
    timestamp: &str,
) -> String {
    let mut out = String::new();
    out.push_str("Infinity Mod Runner — Diagnostic Bundle\n");
    out.push_str(&format!("Generated: {}\n", timestamp));
    out.push_str(&format!("App version: {}\n", app_version));
    out.push_str(&format!("Platform: {}-{}\n", os, arch));
    out.push_str("\n");
    out.push_str("Contents:\n");
    for e in entries {
        out.push_str(&format!(
            "  {:<44}  {:>10} bytes\n",
            e.name,
            e.size
        ));
    }
    out.push_str("\n");
    out.push_str("Redaction:\n");
    out.push_str("  config-redacted.toml has the following fields replaced\n");
    out.push_str("  with `<redacted-{field-name}>` sentinels:\n");
    for f in REDACTED_FIELDS {
        out.push_str(&format!("    - {}\n", f));
    }
    out.push_str("  forge_data_url is redacted only if non-default.\n");
    out.push_str("  gui.log and install.log are NOT redacted — they may\n");
    out.push_str("  contain paths in log prefixes and error messages.\n");
    out.push_str("  Eyeball before sharing if your install paths are\n");
    out.push_str("  sensitive.\n");
    out.push_str("\n");
    out.push_str("See README.md (bundled copy of resources/LOGS.md) for\n");
    out.push_str("context on each file's format.\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_path_hash_matches_installer_hash() {
        // Sanity check: the hash function duplicated here MUST produce
        // the same output as `installer::short_path_hash` for the same
        // input, or else `resolve_log_paths` will return the wrong
        // `game_data_dir` and UI readouts will diverge from where the
        // install actually writes. If this test ever fails, either fix
        // the duplicate OR consolidate both callers onto one function.
        let input = "C:\\Games\\Baldur's Gate II Enhanced Edition";
        let local = short_path_hash(input);
        let installer = crate::installer::short_path_hash(input);
        assert_eq!(local, installer, "paths::short_path_hash drifted from installer::short_path_hash");
    }

    #[test]
    fn resolve_without_game_dir_yields_none_for_per_game_paths() {
        let cfg = AppConfig::default();
        let paths = resolve_log_paths(&cfg).expect("should resolve");
        assert!(paths.install_log.is_none());
        assert!(paths.reports_dir.is_none());
        assert!(paths.guard_report.is_none());
        assert!(paths.checkpoint.is_none());
        assert!(paths.game_data_dir.is_none());
        // Session-level paths always resolve.
        assert!(paths.gui_log.to_string_lossy().ends_with("gui.log"));
        assert!(paths.config_toml.to_string_lossy().ends_with(".toml"));
    }

    #[test]
    fn resolve_with_game_dir_yields_per_game_paths() {
        let mut cfg = AppConfig::default();
        cfg.bg2_game_dir = Some("C:\\Games\\BG2EE".to_string());
        let paths = resolve_log_paths(&cfg).expect("should resolve");
        // Per-game paths all Some, and all end with the expected filename.
        assert!(paths.install_log.as_ref().unwrap().to_string_lossy().ends_with("install.log"));
        assert!(paths.reports_dir.as_ref().unwrap().to_string_lossy().ends_with("reports"));
        assert!(paths.guard_report.as_ref().unwrap().to_string_lossy().ends_with("guard_report.json"));
        assert!(paths.checkpoint.as_ref().unwrap().to_string_lossy().ends_with("checkpoint.json"));
        // game_data_dir is their common parent.
        let game_dir = paths.game_data_dir.as_ref().unwrap();
        assert!(paths.install_log.as_ref().unwrap().starts_with(game_dir));
    }
}

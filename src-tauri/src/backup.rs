//! Game directory backup & restore — full or selective snapshots.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

// ── Types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub version: u32,
    pub name: String,
    pub timestamp: String,
    pub mode: String, // "full" or "selective"
    pub game_dir: String,
    pub total_bytes: u64,
    pub file_count: u64,
    pub completed: bool,
    /// Lowercased names of every top-level entry (files AND directories) that
    /// existed in the game directory at the moment the backup was created.
    /// Used by selective restore to remove post-install side-folders that
    /// don't contain a .tp2 themselves (e.g. TDD subfolders, Mercenaries
    /// asset dirs). Empty on old backups — the restore logic treats empty
    /// as "no inventory available, fall back to tp2-only heuristic".
    #[serde(default)]
    pub pre_install_top_level: Vec<String>,
    /// Which game this backup represents. One of "bg1" | "bg2" | "iwd" |
    /// "iwd2" | "pst". Defaults to "bg2" for backward compatibility with
    /// older backups that didn't carry this marker — pre-9b backups were
    /// all BG2 since that was the only supported target.
    #[serde(default = "default_game_kind")]
    pub game_kind: String,
}

fn default_game_kind() -> String { "bg2".to_string() }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub name: String,
    pub timestamp: String,
    pub mode: String,
    pub total_bytes: u64,
    pub file_count: u64,
    pub path: String,
    pub completed: bool,
    /// Which game this backup represents ("bg1" | "bg2" | "iwd" | "iwd2" | "pst").
    /// Populated from the backup's manifest; defaults to "bg2" for pre-9b
    /// backups that didn't carry this marker.
    pub game_kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupProgress {
    pub bytes_copied: u64,
    pub total_bytes: u64,
    pub files_copied: u64,
    pub total_files: u64,
    pub current_file: String,
    pub phase: String, // "scanning", "copying", "complete"
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEstimate {
    pub total_bytes: u64,
    pub file_count: u64,
    pub available_space: u64,
    pub has_enough_space: bool,
}

// ── Selective backup targets ──

/// Extensions to include at game dir root for selective backup.
const SELECTIVE_ROOT_EXTENSIONS: &[&str] = &["ids", "bcs"];

/// Specific root files to include.
const SELECTIVE_ROOT_FILES: &[&str] = &["chitin.key"];

/// Directories to copy entirely in selective mode.
const SELECTIVE_DIRS: &[&str] = &["override"];

// ── Estimate ──

/// Estimate backup size and check available space.
pub fn estimate_backup(game_dir: &Path, backup_dir: &Path, mode: &str) -> Result<BackupEstimate, String> {
    let (total_bytes, file_count) = walk_backup_sources(game_dir, mode)?;
    let available_space = get_available_space(backup_dir)
        .unwrap_or(u64::MAX); // If we can't check, assume enough

    Ok(BackupEstimate {
        total_bytes,
        file_count,
        available_space,
        // Need ~5% overhead for manifest + directory structure
        has_enough_space: available_space > total_bytes + (total_bytes / 20),
    })
}

/// Walk backup source files and return (total_bytes, file_count).
fn walk_backup_sources(game_dir: &Path, mode: &str) -> Result<(u64, u64), String> {
    let mut total_bytes = 0u64;
    let mut file_count = 0u64;

    if mode == "full" {
        walk_dir_recursive(game_dir, &mut |_path, size| {
            total_bytes += size;
            file_count += 1;
        })?;
    } else {
        // Selective: specific files + dirs
        for_each_selective_file(game_dir, &mut |_rel, _abs, size| {
            total_bytes += size;
            file_count += 1;
            Ok(())
        })?;
    }

    Ok((total_bytes, file_count))
}

// ── Create backup ──

/// Create a backup of the game directory.
pub fn create_backup(
    app: &AppHandle,
    game_dir: &Path,
    backup_dir: &Path,
    name: &str,
    mode: &str,
    game_kind: &str,
    abort: &AtomicBool,
) -> Result<BackupManifest, String> {
    // Create timestamped folder
    let timestamp = format_timestamp();
    let safe_name = sanitize_name(name);
    let folder_name = format!("{}_{}", timestamp, safe_name);
    let dest = backup_dir.join(&folder_name);

    std::fs::create_dir_all(&dest)
        .map_err(|e| format!("Failed to create backup directory: {e}"))?;

    // Snapshot the top-level layout of the game dir BEFORE any install runs.
    // Selective restore uses this to distinguish pre-existing dirs from
    // install side-folders that should be removed on restore.
    let pre_install_top_level: Vec<String> = std::fs::read_dir(game_dir)
        .ok()
        .map(|rd| rd.filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_lowercase())
            .collect::<Vec<_>>())
        .unwrap_or_default();

    // Write initial manifest
    let mut manifest = BackupManifest {
        version: 1,
        name: name.to_string(),
        timestamp: timestamp.clone(),
        mode: mode.to_string(),
        game_dir: game_dir.to_string_lossy().to_string(),
        total_bytes: 0,
        file_count: 0,
        completed: false,
        pre_install_top_level,
        game_kind: game_kind.to_string(),
    };
    write_manifest(&dest, &manifest)?;

    // Scan for size estimate
    emit_progress(app, "backup:progress", &BackupProgress {
        bytes_copied: 0, total_bytes: 0, files_copied: 0, total_files: 0,
        current_file: String::new(), phase: "scanning".to_string(),
    });

    let (total_bytes, total_files) = walk_backup_sources(game_dir, mode)?;

    // Check available space
    let available = get_available_space(&dest).unwrap_or(u64::MAX);
    if available < total_bytes + (total_bytes / 20) {
        // Clean up empty backup dir
        let _ = std::fs::remove_dir_all(&dest);
        return Err(format!(
            "Insufficient disk space: need {} but only {} available",
            format_bytes(total_bytes), format_bytes(available)
        ));
    }

    // Copy files
    let mut bytes_copied = 0u64;
    let mut files_copied = 0u64;
    let mut last_emit = std::time::Instant::now();

    let mut copy_file = |rel_path: &Path, abs_path: &Path, size: u64| -> Result<(), String> {
        if abort.load(Ordering::SeqCst) {
            return Err("Backup cancelled".to_string());
        }

        let dest_path = dest.join(rel_path);
        if let Some(parent) = dest_path.parent() {
            std::fs::create_dir_all(long_path(parent))
                .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        copy_file_synced(&long_path(abs_path), &long_path(&dest_path))?;

        bytes_copied += size;
        files_copied += 1;

        // Emit progress every 200ms to avoid flooding
        if last_emit.elapsed().as_millis() > 200 {
            emit_progress(app, "backup:progress", &BackupProgress {
                bytes_copied, total_bytes, files_copied, total_files,
                current_file: rel_path.to_string_lossy().to_string(),
                phase: "copying".to_string(),
            });
            last_emit = std::time::Instant::now();
        }

        Ok(())
    };

    let result = if mode == "full" {
        copy_full_backup(game_dir, &mut copy_file)
    } else {
        copy_selective_backup(game_dir, &mut copy_file)
    };

    match result {
        Ok(()) => {
            manifest.total_bytes = bytes_copied;
            manifest.file_count = files_copied;
            manifest.completed = true;
            write_manifest(&dest, &manifest)?;

            emit_progress(app, "backup:progress", &BackupProgress {
                bytes_copied, total_bytes: bytes_copied, files_copied, total_files: files_copied,
                current_file: String::new(), phase: "complete".to_string(),
            });

            let _ = app.emit("backup:complete", serde_json::json!({
                "name": name,
                "mode": mode,
                "totalBytes": bytes_copied,
                "fileCount": files_copied,
                "path": dest.to_string_lossy(),
            }));

            Ok(manifest)
        }
        Err(e) => {
            // Leave incomplete manifest for cleanup
            let _ = app.emit("backup:error", e.clone());
            Err(e)
        }
    }
}

fn copy_full_backup(
    game_dir: &Path,
    copy_file: &mut dyn FnMut(&Path, &Path, u64) -> Result<(), String>,
) -> Result<(), String> {
    walk_dir_with_rel(game_dir, game_dir, &mut |rel_path, abs_path, size| {
        copy_file(rel_path, abs_path, size)
    })
}

fn copy_selective_backup(
    game_dir: &Path,
    copy_file: &mut dyn FnMut(&Path, &Path, u64) -> Result<(), String>,
) -> Result<(), String> {
    for_each_selective_file(game_dir, &mut |rel, abs, size| {
        copy_file(rel, abs, size)
    })
}

// ── Restore ──

/// Files and directories created by the Runner in the game directory.
/// Cleaned during backup restore to reset to a pristine snapshot.
const RUNNER_ARTIFACTS: &[&str] = &[
    ".eetmr_install.lock",
    ".eetmr_checkpoint.json",
    "eetmr_install.log",
];
const RUNNER_DIRS: &[&str] = &[
    "tlk_backups",
    "mod_installer_backups",
];

/// Restore a backup to the game directory.
/// This is a true "reset to snapshot" — cleans modified/added files before restoring.
pub fn restore_backup(
    app: &AppHandle,
    backup_path: &Path,
    game_dir: &Path,
    abort: &AtomicBool,
) -> Result<(), String> {
    let manifest = read_manifest(backup_path)?;
    if !manifest.completed {
        return Err("Cannot restore from an incomplete backup".to_string());
    }

    // ── Phase 1: Clean ──
    emit_progress(app, "restore:progress", &BackupProgress {
        bytes_copied: 0, total_bytes: manifest.total_bytes, files_copied: 0,
        total_files: manifest.file_count, current_file: "Cleaning game directory...".to_string(),
        phase: "cleaning".to_string(),
    });

    let _ = app.emit("install:stdout",
        "[Infinity Mod Runner] Restore: cleaning game directory...");

    let mut removed = 0u32;

    if manifest.mode == "full" {
        // Full backup: delete everything NOT in the backup (true reset)
        let mut backup_entries: HashSet<String> = HashSet::new();
        backup_entries.insert("manifest.json".to_string());
        if let Ok(entries) = std::fs::read_dir(backup_path) {
            for entry in entries.filter_map(|e| e.ok()) {
                backup_entries.insert(entry.file_name().to_string_lossy().to_lowercase());
            }
        }
        if let Ok(entries) = std::fs::read_dir(game_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                if abort.load(Ordering::SeqCst) {
                    return Err("Restore cancelled during cleanup".to_string());
                }
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if backup_entries.contains(&name) { continue; }
                let path = entry.path();
                let _ = app.emit("install:stdout",
                    format!("[Infinity Mod Runner] Removing: {}", entry.file_name().to_string_lossy()));
                if path.is_dir() { remove_dir_or_junction(&path); }
                else { let _ = std::fs::remove_file(&path); }
                removed += 1;
            }
        }
    } else {
        // Selective backup: only clean the specific things we backed up
        // 1. Remove override/ (will be restored from backup)
        let override_dir = game_dir.join("override");
        if override_dir.is_dir() {
            let _ = app.emit("install:stdout", "[Infinity Mod Runner] Clearing override/ ...");
            let _ = std::fs::remove_dir_all(&override_dir);
            removed += 1;
        }

        // 2. Remove weidu.log variants
        for name in &["weidu.log", "WeiDU.log", "WeiDU-BGEE.log", "weidu-bgee.log"] {
            let p = game_dir.join(name);
            if p.exists() { let _ = std::fs::remove_file(&p); removed += 1; }
        }

        // 3. Remove root IDS and BCS files
        if let Ok(entries) = std::fs::read_dir(game_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if !path.is_file() { continue; }
                if let Some(ext) = path.extension() {
                    let ext_lower = ext.to_string_lossy().to_lowercase();
                    if ext_lower == "ids" || ext_lower == "bcs" {
                        let _ = std::fs::remove_file(&path);
                        removed += 1;
                    }
                }
            }
        }

        // 4. Remove mod folders AND install side-folders.
        //
        // Two signals identify a top-level dir as "added by this install":
        //   a) It contains a .tp2 file (a WeiDU mod folder)
        //   b) It was NOT present in the pre-install inventory (side-folder
        //      added by a mod during install — e.g. TDD's asset dirs,
        //      Mercenaries' support dirs, anything not containing a tp2
        //      but still created by the install pipeline).
        //
        // Signal (b) requires `pre_install_top_level` to be populated in the
        // manifest. Older backups without that field fall back to (a) only.
        //
        // IMPORTANT: junction points must be removed with remove_dir (not
        // remove_dir_all) to avoid following the junction and deleting the
        // Extracted source. `remove_dir_or_junction` handles this.
        let pre_install: HashSet<String> = manifest.pre_install_top_level
            .iter().map(|s| s.to_lowercase()).collect();
        let have_inventory = !pre_install.is_empty();

        if let Ok(entries) = std::fs::read_dir(game_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                if abort.load(Ordering::SeqCst) {
                    return Err("Restore cancelled during cleanup".to_string());
                }
                let path = entry.path();
                if !path.is_dir() { continue; }

                let name_lower = entry.file_name().to_string_lossy().to_lowercase();

                let has_tp2 = std::fs::read_dir(&path).ok().map_or(false, |mut rd| {
                    rd.any(|e| e.ok().map_or(false, |e| {
                        e.path().extension().map_or(false, |ext| ext.eq_ignore_ascii_case("tp2"))
                    }))
                });
                let is_post_install_sidefolder = have_inventory && !pre_install.contains(&name_lower);

                if has_tp2 || is_post_install_sidefolder {
                    let label = if has_tp2 { "mod" } else { "side-folder" };
                    let _ = app.emit("install:stdout",
                        format!("[Infinity Mod Runner] Removing {}: {}", label, entry.file_name().to_string_lossy()));
                    remove_dir_or_junction(&path);
                    removed += 1;
                }
            }
        }

        // 5. Remove *.DEBUG files (both per-mod setup-*.DEBUG and WeiDU's
        //    global WSETUP.DEBUG). The original check only matched setup-*
        //    prefixed files, leaving WSETUP.DEBUG behind after restore.
        if let Ok(entries) = std::fs::read_dir(game_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let fname = entry.file_name().to_string_lossy().to_lowercase();
                let is_debug = fname.ends_with(".debug") || fname.ends_with(".debug.bak");
                if is_debug && (fname.starts_with("setup-") || fname == "wsetup.debug" || fname == "wsetup.debug.bak") {
                    let _ = std::fs::remove_file(entry.path());
                    removed += 1;
                }
            }
        }

        // 6. Remove non-mod WeiDU artifacts (setup-*.exe, setup-*.command, etc.)
        if let Ok(entries) = std::fs::read_dir(game_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let fname = entry.file_name().to_string_lossy().to_lowercase();
                if fname.starts_with("setup-") && (fname.ends_with(".exe") || fname.ends_with(".command")) {
                    let _ = std::fs::remove_file(entry.path());
                    removed += 1;
                }
            }
        }

        // 7. Remove WeiDU/mod-generated directories
        for dir_name in &["weidu_backup", "inlined", "weidu_external", "portraits"] {
            let p = game_dir.join(dir_name);
            if p.is_dir() {
                let _ = app.emit("install:stdout", format!("[Infinity Mod Runner] Removing: {dir_name}/"));
                remove_dir_or_junction(&p);
                removed += 1;
            }
        }

        // 8. Remove EEex/InfinityLoader files, batch files, weidu.conf, lua files, override.cre
        if let Ok(entries) = std::fs::read_dir(game_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if !path.is_file() { continue; }
                let fname = entry.file_name().to_string_lossy().to_string();
                let fname_lower = fname.to_lowercase();

                let should_remove =
                    // EEex / InfinityLoader files
                    fname_lower.starts_with("eeex") ||
                    fname_lower.starts_with("infinityloader") ||
                    // Lua-related files (but preserve engine.lua — vanilla game file needed by EET)
                    (fname_lower.contains("lua") && fname_lower != "engine.lua") ||
                    // Windows batch files
                    fname_lower.ends_with(".bat") ||
                    // WeiDU config
                    fname_lower == "weidu.conf" ||
                    // override.cre
                    fname_lower == "override.cre";

                if should_remove {
                    let _ = app.emit("install:stdout", format!("[Infinity Mod Runner] Removing: {fname}"));
                    let _ = std::fs::remove_file(&path);
                    removed += 1;
                }
            }
        }
    }

    // Clean Infinity Mod Runner artifacts regardless of backup mode
    for name in RUNNER_ARTIFACTS {
        let p = game_dir.join(name);
        if p.exists() { let _ = std::fs::remove_file(&p); removed += 1; }
    }
    for name in RUNNER_DIRS {
        let p = game_dir.join(name);
        if p.is_dir() { remove_dir_or_junction(&p); removed += 1; }
    }

    let _ = app.emit("install:stdout",
        format!("[Infinity Mod Runner] Cleanup complete: {removed} items removed"));

    if abort.load(Ordering::SeqCst) {
        return Err("Restore cancelled during cleanup".to_string());
    }

    // ── Phase 2: Restore from backup ──
    let _ = app.emit("install:stdout",
        format!("[Infinity Mod Runner] Restore: copying {} files from backup...", manifest.file_count));

    let total_bytes = manifest.total_bytes;
    let total_files = manifest.file_count;
    let mut bytes_copied = 0u64;
    let mut files_copied = 0u64;
    let mut last_emit = std::time::Instant::now();

    walk_dir_with_rel(backup_path, backup_path, &mut |rel_path, abs_path, size| {
        if rel_path == Path::new("manifest.json") {
            return Ok(());
        }

        if abort.load(Ordering::SeqCst) {
            return Err("Restore cancelled".to_string());
        }

        let dest_path = game_dir.join(rel_path);
        if let Some(parent) = dest_path.parent() {
            std::fs::create_dir_all(long_path(parent))
                .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        copy_file_synced(&long_path(abs_path), &long_path(&dest_path))?;

        bytes_copied += size;
        files_copied += 1;

        if last_emit.elapsed().as_millis() > 200 {
            emit_progress(app, "restore:progress", &BackupProgress {
                bytes_copied, total_bytes, files_copied, total_files,
                current_file: rel_path.to_string_lossy().to_string(),
                phase: "restoring".to_string(),
            });
            last_emit = std::time::Instant::now();
        }

        Ok(())
    })?;

    let _ = app.emit("restore:complete", serde_json::json!({
        "name": manifest.name,
        "filesRestored": files_copied,
    }));

    Ok(())
}

// ── List & Delete ──

/// List all backups in the backup directory.
pub fn list_backups(backup_dir: &Path) -> Result<Vec<BackupInfo>, String> {
    let mut backups = Vec::new();

    if !backup_dir.exists() {
        return Ok(backups);
    }

    let entries = std::fs::read_dir(backup_dir)
        .map_err(|e| format!("read_dir {}: {e}", backup_dir.display()))?;

    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_dir() { continue; }

        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() { continue; }

        if let Ok(manifest) = read_manifest(&path) {
            backups.push(BackupInfo {
                name: manifest.name,
                timestamp: manifest.timestamp,
                mode: manifest.mode,
                total_bytes: manifest.total_bytes,
                file_count: manifest.file_count,
                path: path.to_string_lossy().to_string(),
                completed: manifest.completed,
                game_kind: manifest.game_kind,
            });
        }
    }

    // Sort newest first
    backups.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(backups)
}

// ── Verify ──

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
    /// True when manifest file_count + total_bytes match what's on disk,
    /// and the manifest flagged the backup as completed.
    pub ok: bool,
    /// What the manifest claims.
    pub manifest_file_count: u64,
    pub manifest_total_bytes: u64,
    /// What we actually see on disk (excluding manifest.json itself).
    pub actual_file_count: u64,
    pub actual_total_bytes: u64,
    /// Human-readable notes. Empty when `ok` is true.
    pub issues: Vec<String>,
}

/// Lightweight integrity check on a backup directory. Walks the backup
/// contents and compares observed file count + total bytes against the
/// manifest. Does NOT byte-hash files — that would be minutes for a
/// large selective backup. The goal is to catch truncated / partially
/// deleted backups before the user starts a restore.
pub fn verify_backup(backup_path: &Path) -> Result<VerifyResult, String> {
    let manifest = read_manifest(backup_path)?;
    let mut actual_files = 0u64;
    let mut actual_bytes = 0u64;
    walk_dir_recursive(backup_path, &mut |p, size| {
        // Skip the manifest itself — it's not part of the captured game data.
        if p.file_name().map(|n| n == "manifest.json").unwrap_or(false) { return; }
        actual_files += 1;
        actual_bytes += size;
    })?;

    let mut issues = Vec::new();
    if !manifest.completed {
        issues.push("Backup is marked incomplete (creation was interrupted).".to_string());
    }
    if manifest.file_count != actual_files {
        issues.push(format!(
            "File count mismatch: manifest expects {}, on disk {}.",
            manifest.file_count, actual_files,
        ));
    }
    if manifest.total_bytes.abs_diff(actual_bytes) > manifest.total_bytes / 100 {
        // Tolerate < 1% drift (filesystem block rounding, sparse files).
        issues.push(format!(
            "Total bytes mismatch: manifest {}, on disk {}.",
            manifest.total_bytes, actual_bytes,
        ));
    }

    Ok(VerifyResult {
        ok: issues.is_empty(),
        manifest_file_count: manifest.file_count,
        manifest_total_bytes: manifest.total_bytes,
        actual_file_count: actual_files,
        actual_total_bytes: actual_bytes,
        issues,
    })
}

/// Delete a backup directory. Verifies manifest.json exists to prevent accidental deletion.
pub fn delete_backup(backup_path: &Path) -> Result<(), String> {
    let manifest_path = backup_path.join("manifest.json");
    if !manifest_path.exists() {
        return Err("Not a valid backup directory (no manifest.json found)".to_string());
    }

    std::fs::remove_dir_all(backup_path)
        .map_err(|e| format!("Failed to delete backup: {e}"))?;

    Ok(())
}

// ── Helpers ──

/// Walk directory recursively, calling `f(path, size)` for each file.
fn walk_dir_recursive(dir: &Path, f: &mut dyn FnMut(&Path, u64)) -> Result<(), String> {
    if !dir.is_dir() { return Ok(()); }
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_dir() {
            walk_dir_recursive(&path, f)?;
        } else if path.is_file() {
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            f(&path, size);
        }
    }
    Ok(())
}

/// Walk directory recursively with relative paths, calling `f(rel_path, abs_path, size)`.
fn walk_dir_with_rel(
    dir: &Path,
    base: &Path,
    f: &mut dyn FnMut(&Path, &Path, u64) -> Result<(), String>,
) -> Result<(), String> {
    if !dir.is_dir() { return Ok(()); }
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_dir() {
            walk_dir_with_rel(&path, base, f)?;
        } else if path.is_file() {
            let rel = path.strip_prefix(base).unwrap_or(&path);
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            f(rel, &path, size)?;
        }
    }
    Ok(())
}

/// Iterate over selective backup files: root files, IDS/BCS, override/, weidu.log, dialog.tlk.
fn for_each_selective_file(
    game_dir: &Path,
    f: &mut dyn FnMut(&Path, &Path, u64) -> Result<(), String>,
) -> Result<(), String> {
    let root_exts: HashSet<&str> = SELECTIVE_ROOT_EXTENSIONS.iter().copied().collect();

    // Root-level files
    if let Ok(entries) = std::fs::read_dir(game_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if !path.is_file() { continue; }
            let fname = entry.file_name().to_string_lossy().to_string();
            let fname_lower = fname.to_lowercase();

            // Specific named files
            let is_named = SELECTIVE_ROOT_FILES.iter().any(|n| fname_lower == *n)
                || fname_lower == "weidu.log";

            // Extension match (IDS, BCS)
            let is_ext = path.extension()
                .map(|e| root_exts.contains(e.to_string_lossy().to_lowercase().as_str()))
                .unwrap_or(false);

            if is_named || is_ext {
                let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                let rel = Path::new(&fname);
                f(rel, &path, size)?;
            }
        }
    }

    // Selective directories (override/)
    for dir_name in SELECTIVE_DIRS {
        let dir_path = game_dir.join(dir_name);
        if dir_path.is_dir() {
            walk_dir_with_rel(&dir_path, game_dir, f)?;
        }
    }

    // lang/*/dialog.tlk
    let lang_dir = game_dir.join("lang");
    if lang_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&lang_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let lang_path = entry.path();
                if !lang_path.is_dir() { continue; }
                let tlk = lang_path.join("dialog.tlk");
                if tlk.is_file() {
                    let size = std::fs::metadata(&tlk).map(|m| m.len()).unwrap_or(0);
                    let rel = tlk.strip_prefix(game_dir).unwrap_or(&tlk);
                    f(rel, &tlk, size)?;
                }
                // Also check dialogf.tlk (female strings for some languages)
                let tlkf = lang_path.join("dialogf.tlk");
                if tlkf.is_file() {
                    let size = std::fs::metadata(&tlkf).map(|m| m.len()).unwrap_or(0);
                    let rel = tlkf.strip_prefix(game_dir).unwrap_or(&tlkf);
                    f(rel, &tlkf, size)?;
                }
            }
        }
    }

    Ok(())
}

/// Copy a single file with sync_all.
fn copy_file_synced(src: &Path, dest: &Path) -> Result<(), String> {
    let mut src_file = std::fs::File::open(src)
        .map_err(|e| format!("open {}: {e}", src.display()))?;
    let mut dest_file = std::fs::File::create(dest)
        .map_err(|e| format!("create {}: {e}", dest.display()))?;
    io::copy(&mut src_file, &mut dest_file)
        .map_err(|e| format!("copy {} -> {}: {e}", src.display(), dest.display()))?;
    dest_file.sync_all()
        .map_err(|e| format!("sync {}: {e}", dest.display()))?;
    Ok(())
}

/// Get available space on the drive containing `path`.
fn get_available_space(path: &Path) -> Result<u64, String> {
    fs2::available_space(path)
        .map_err(|e| format!("Cannot check disk space: {e}"))
}

/// Write manifest.json to a backup directory.
fn write_manifest(backup_dir: &Path, manifest: &BackupManifest) -> Result<(), String> {
    let json = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("serialize manifest: {e}"))?;
    std::fs::write(backup_dir.join("manifest.json"), json)
        .map_err(|e| format!("write manifest: {e}"))
}

/// Read manifest.json from a backup directory.
fn read_manifest(backup_dir: &Path) -> Result<BackupManifest, String> {
    let path = backup_dir.join("manifest.json");
    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("read manifest: {e}"))?;
    serde_json::from_str(&contents)
        .map_err(|e| format!("parse manifest: {e}"))
}

/// Format timestamp as YYYY-MM-DD_HH-MM-SS.
fn format_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Simple UTC timestamp formatting without chrono dependency
    let secs = now;
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Days since epoch to Y-M-D (simplified leap year calculation)
    let (year, month, day) = days_to_date(days);
    format!("{year:04}-{month:02}-{day:02}_{hours:02}-{minutes:02}-{seconds:02}")
}

/// Convert days since Unix epoch to (year, month, day).
fn days_to_date(mut days: u64) -> (u64, u64, u64) {
    let mut year = 1970u64;
    loop {
        let days_in_year = if is_leap(year) { 366 } else { 365 };
        if days < days_in_year { break; }
        days -= days_in_year;
        year += 1;
    }
    let leap = is_leap(year);
    let month_days: [u64; 12] = [
        31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut month = 0u64;
    for (i, &md) in month_days.iter().enumerate() {
        if days < md { month = i as u64 + 1; break; }
        days -= md;
    }
    if month == 0 { month = 12; }
    (year, month, days + 1)
}

fn is_leap(year: u64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Sanitize backup name for use as directory name.
fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

/// Format bytes as human-readable string.
fn format_bytes(bytes: u64) -> String {
    if bytes >= 1_073_741_824 {
        format!("{:.1} GB", bytes as f64 / 1_073_741_824.0)
    } else if bytes >= 1_048_576 {
        format!("{:.1} MB", bytes as f64 / 1_048_576.0)
    } else {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    }
}

/// Apply \\?\ long path prefix on Windows for paths >240 chars.
fn long_path(p: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let s = p.to_string_lossy();
        if s.len() > 240 && !s.starts_with(r"\\?\") {
            PathBuf::from(format!(r"\\?\{}", s))
        } else {
            p.to_path_buf()
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        p.to_path_buf()
    }
}

/// Remove a directory, handling junction points correctly.
/// Junction points must use remove_dir (not remove_dir_all) to avoid
/// following the junction and deleting the source directory contents.
fn remove_dir_or_junction(path: &Path) {
    #[cfg(target_os = "windows")]
    {
        // Check if it's a junction/reparse point
        use std::os::windows::fs::MetadataExt;
        let is_junction = std::fs::symlink_metadata(path)
            .map(|m| m.file_attributes() & 0x400 != 0) // FILE_ATTRIBUTE_REPARSE_POINT
            .unwrap_or(false);
        if is_junction {
            // Remove junction itself, not its contents
            let _ = std::fs::remove_dir(path);
            return;
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // On Unix, check if it's a symlink
        if std::fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            let _ = std::fs::remove_file(path);
            return;
        }
    }
    // Regular directory — remove recursively
    let _ = std::fs::remove_dir_all(path);
}

fn emit_progress(app: &AppHandle, event: &str, progress: &BackupProgress) {
    let _ = app.emit(event, progress);
}

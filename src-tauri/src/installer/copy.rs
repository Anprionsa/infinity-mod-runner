//! Mod directory setup — junction points (Windows) or symlinks (Unix) for speed,
//! with fallback to safe copy with sync_all per file.

use std::path::Path;
use std::io;

/// Set up a mod directory in the game dir. Tries junction/symlink first (instant),
/// falls back to full copy with sync_all (safe but slow).
pub fn copy_mod_to_game(src: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        // Check if destination seems complete (or is already a junction/symlink)
        if is_junction_or_symlink(dest) {
            return Ok(()); // Already linked
        }
        let src_count = count_files(src);
        let dest_count = count_files(dest);
        if dest_count >= src_count.saturating_sub(2) {
            let has_tp2 = std::fs::read_dir(dest)
                .ok()
                .map(|rd| rd.filter_map(|e| e.ok()).any(|e| {
                    e.path().extension().map_or(false, |ext| ext.eq_ignore_ascii_case("tp2"))
                }))
                .unwrap_or(false);
            if has_tp2 {
                return Ok(()); // Already complete
            }
        }
    }

    // Try junction/symlink first (instant, no I/O)
    if try_create_junction(src, dest) {
        return Ok(());
    }

    // Fallback: full copy with sync_all
    copy_dir_synced(src, dest)
}

/// Try to create a directory junction (Windows) or symlink (Unix).
/// Returns true on success, false on failure (caller should fall back to copy).
fn try_create_junction(src: &Path, dest: &Path) -> bool {
    // Don't create junction if dest already exists
    if dest.exists() { return false; }

    #[cfg(target_os = "windows")]
    {
        // Use Windows API directly — avoids spawning cmd.exe per junction (~10x faster)
        create_junction_ntapi(src, dest)
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Unix symlinks
        std::os::unix::fs::symlink(src, dest).is_ok()
    }
}

/// Create a directory junction using the Windows API directly.
/// This is much faster than spawning `cmd /c mklink /J` for each junction.
#[cfg(target_os = "windows")]
fn create_junction_ntapi(target: &Path, junction: &Path) -> bool {
    // We prefer std::os::windows::fs::symlink_dir (no subprocess), falling back
    // to `cmd /c mklink /J`. symlink_dir may require developer mode or elevation
    // on older Windows; the mklink fallback works without elevation.

    // Try symlink_dir first (no subprocess, instant)
    if std::os::windows::fs::symlink_dir(target, junction).is_ok() {
        return true;
    }

    // Fallback: cmd /c mklink /J (works without elevation)
    use std::os::windows::process::CommandExt;
    let result = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J",
            &junction.to_string_lossy(),
            &target.to_string_lossy()])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();
    match result {
        Ok(output) => output.status.success(),
        Err(_) => false,
    }
}

/// Check if a path is a junction point or symlink.
fn is_junction_or_symlink(path: &Path) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => meta.file_type().is_symlink(),
        Err(_) => false,
    }
}

/// Copy directory recursively with sync_all on each file.
fn copy_dir_synced(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest)
        .map_err(|e| format!("mkdir {}: {e}", dest.display()))?;

    let entries = std::fs::read_dir(src)
        .map_err(|e| format!("read_dir {}: {e}", src.display()))?;

    for entry in entries.filter_map(|e| e.ok()) {
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_synced(&src_path, &dest_path)?;
        } else {
            copy_file_synced(&src_path, &dest_path)?;
        }
    }

    // Sync directory on non-Windows
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(dir) = std::fs::File::open(dest) {
            let _ = dir.sync_all();
        }
    }

    Ok(())
}

/// Copy a single file with sync_all to ensure write-cache flush.
fn copy_file_synced(src: &Path, dest: &Path) -> Result<(), String> {
    let mut src_file = std::fs::File::open(src)
        .map_err(|e| format!("open {}: {e}", src.display()))?;
    let mut dest_file = std::fs::File::create(dest)
        .map_err(|e| format!("create {}: {e}", dest.display()))?;

    io::copy(&mut src_file, &mut dest_file)
        .map_err(|e| format!("copy {} -> {}: {e}", src.display(), dest.display()))?;

    // Critical: sync to disk before WeiDU reads the file
    dest_file.sync_all()
        .map_err(|e| format!("sync {}: {e}", dest.display()))?;

    Ok(())
}

fn count_files(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|rd| rd.count())
        .unwrap_or(0)
}

/// Find a mod's folder by searching for its tp2 file recursively.
/// Returns the parent directory of the tp2 file.
pub fn find_mod_folder(mod_dir: &Path, mod_name: &str, tp_file: &str, depth: usize) -> Option<std::path::PathBuf> {
    find_mod_recursive(mod_dir, mod_name, tp_file, depth)
}

fn find_mod_recursive(dir: &Path, mod_name: &str, tp_file: &str, remaining_depth: usize) -> Option<std::path::PathBuf> {
    if remaining_depth == 0 || !dir.is_dir() { return None; }

    // Check files at this level first (prefer shallower matches)
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_file()
                && entry.file_name().to_string_lossy().eq_ignore_ascii_case(tp_file)
            {
                if let Some(parent) = path.parent() {
                    if parent.file_name()
                        .map_or(false, |n| n.to_string_lossy().eq_ignore_ascii_case(mod_name))
                    {
                        return Some(parent.to_path_buf());
                    }
                }
            }
        }
    }

    // Then recurse into subdirectories
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            if entry.path().is_dir() {
                if let Some(found) = find_mod_recursive(&entry.path(), mod_name, tp_file, remaining_depth - 1) {
                    return Some(found);
                }
            }
        }
    }

    None
}

/// Pre-scan the mod directory once and build a map of mod_name → folder path.
/// This replaces 400+ recursive find_mod_folder calls with a single directory walk.
/// Key is lowercase mod folder name; value is the parent directory containing it.
pub fn build_mod_folder_index(mod_dir: &Path, depth: usize) -> std::collections::HashMap<String, std::path::PathBuf> {
    let mut index = std::collections::HashMap::new();
    index_tp2_recursive(mod_dir, depth, &mut index);
    index
}

/// Directory names to skip during indexing — these contain partial/patched files, not full mods.
const INDEX_SKIP_DIRS: &[&str] = &["Infinity Mod Forge Patches", "infinity-mod-forge-patches", "EET Mod Forge Patches", "eet-mod-forge-patches", "patches", ".git"];

fn index_tp2_recursive(
    dir: &Path,
    remaining_depth: usize,
    index: &mut std::collections::HashMap<String, std::path::PathBuf>,
) {
    if remaining_depth == 0 || !dir.is_dir() { return; }

    // Skip known non-mod directories
    if let Some(dir_name) = dir.file_name() {
        let name = dir_name.to_string_lossy();
        if INDEX_SKIP_DIRS.iter().any(|skip| name.eq_ignore_ascii_case(skip)) {
            return;
        }
    }

    if let Ok(entries) = std::fs::read_dir(dir) {
        let entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();

        // Check for TP2 files at this level
        for entry in &entries {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    if ext.eq_ignore_ascii_case("tp2") {
                        if let Some(parent) = path.parent() {
                            if let Some(folder_name) = parent.file_name() {
                                let key = folder_name.to_string_lossy().to_lowercase();
                                // Don't overwrite — prefer shallower matches
                                index.entry(key).or_insert_with(|| parent.to_path_buf());
                            }
                        }
                    }
                }
            }
        }

        // Recurse into subdirectories
        for entry in &entries {
            if entry.path().is_dir() {
                index_tp2_recursive(&entry.path(), remaining_depth - 1, index);
            }
        }
    }
}

/// Look up a mod in a pre-built index. Falls back to recursive search on miss.
pub fn find_mod_in_index(
    index: &std::collections::HashMap<String, std::path::PathBuf>,
    mod_dir: &Path,
    mod_name: &str,
    tp_file: &str,
    depth: usize,
) -> Option<std::path::PathBuf> {
    // Fast O(1) lookup
    if let Some(path) = index.get(&mod_name.to_lowercase()) {
        return Some(path.clone());
    }
    // Fallback for mods with non-standard folder names
    find_mod_folder(mod_dir, mod_name, tp_file, depth)
}

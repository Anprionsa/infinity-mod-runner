//! DEBUG file management — backup before batch, parse after, restore merged.

use std::path::{Path, PathBuf};

/// Backup the DEBUG file before a batch runs.
/// Renames setup-{MOD}.DEBUG → setup-{MOD}.DEBUG.bak
/// If a backup already exists, appends current content to it first.
pub fn backup_debug(game_dir: &Path, mod_name: &str) -> Option<PathBuf> {
    let debug_file = game_dir.join(format!("setup-{mod_name}.DEBUG"));
    let backup_file = game_dir.join(format!("setup-{mod_name}.DEBUG.bak"));

    if !debug_file.exists() {
        return None;
    }

    if backup_file.exists() {
        // Append current content to existing backup, then delete current
        if let Ok(current) = std::fs::read_to_string(&debug_file) {
            if let Ok(mut backup) = std::fs::read_to_string(&backup_file) {
                backup.push('\n');
                backup.push_str(&current);
                let _ = std::fs::write(&backup_file, &backup);
            }
        }
        let _ = std::fs::remove_file(&debug_file);
    } else {
        // First time — just rename
        let _ = std::fs::rename(&debug_file, &backup_file);
    }

    Some(backup_file)
}

/// Restore the DEBUG file after a batch completes.
/// Merges backup + new content, writes back to DEBUG, deletes backup.
pub fn restore_debug(game_dir: &Path, mod_name: &str) {
    let debug_file = game_dir.join(format!("setup-{mod_name}.DEBUG"));
    let backup_file = game_dir.join(format!("setup-{mod_name}.DEBUG.bak"));

    if !backup_file.exists() {
        return;
    }

    let backup_content = std::fs::read_to_string(&backup_file).unwrap_or_default();
    let new_content = std::fs::read_to_string(&debug_file).unwrap_or_default();

    // Merge: backup + separator + new
    let merged = if new_content.is_empty() {
        backup_content
    } else if backup_content.is_empty() {
        new_content
    } else {
        format!("{backup_content}\n{new_content}")
    };

    let _ = std::fs::write(&debug_file, &merged);
    let _ = std::fs::remove_file(&backup_file);
}

/// Backup dialog.tlk with rotating slots (max_backups).
/// Source: game_dir (where dialog.tlk lives). Destination: data_dir (the Runner's own folder).
pub fn backup_tlk(game_dir: &Path, data_dir: &Path, language: &str, max_backups: usize) {
    // Find dialog.tlk — check configured language first, then fallbacks
    let tlk_paths = [
        game_dir.join("lang").join(language).join("dialog.tlk"),
        game_dir.join("lang").join("en_US").join("dialog.tlk"),
        game_dir.join("dialog.tlk"),
    ];
    let tlk = tlk_paths.iter().find(|p| p.exists());
    let Some(tlk_path) = tlk else { return };

    let backup_dir = data_dir.join("tlk_backups");
    let _ = std::fs::create_dir_all(&backup_dir);

    // Rotate: delete oldest, shift others down
    let oldest = backup_dir.join(format!("dialog.tlk.{max_backups}"));
    let _ = std::fs::remove_file(&oldest);

    for i in (1..max_backups).rev() {
        let from = backup_dir.join(format!("dialog.tlk.{i}"));
        let to = backup_dir.join(format!("dialog.tlk.{}", i + 1));
        let _ = std::fs::rename(&from, &to);
    }

    // Copy current as slot 1 (newest)
    let newest = backup_dir.join("dialog.tlk.1");
    let _ = std::fs::copy(tlk_path, &newest);
}

/// Validate dialog.tlk header integrity.
/// Returns Ok(()) if valid, Err(message) if corrupted.
pub fn check_tlk_integrity(game_dir: &Path, language: &str) -> Result<(), String> {
    let tlk_paths = [
        game_dir.join("lang").join(language).join("dialog.tlk"),
        game_dir.join("lang").join("en_US").join("dialog.tlk"),
        game_dir.join("dialog.tlk"),
    ];
    let tlk = tlk_paths.iter().find(|p| p.exists());
    let Some(tlk_path) = tlk else { return Ok(()) }; // No TLK to check

    // Only read the first 18 bytes (header) — dialog.tlk can be 200MB+
    use std::io::Read;
    let file = std::fs::File::open(tlk_path)
        .map_err(|e| format!("Failed to open dialog.tlk: {e}"))?;
    let file_size = file.metadata().map(|m| m.len()).unwrap_or(0) as usize;

    if file_size < 18 {
        return Err("dialog.tlk too small (< 18 bytes)".to_string());
    }

    let mut file = file; // rebind for read_exact
    let mut data = vec![0u8; 18];
    file.read_exact(&mut data)
        .map_err(|e| format!("Failed to read dialog.tlk header: {e}"))?;

    // Check signature: "TLK V1  " (8 bytes)
    let sig = &data[0..8];
    if sig != b"TLK V1  " {
        return Err(format!("Invalid TLK signature: {:?}", String::from_utf8_lossy(sig)));
    }

    // Read string count (bytes 10-13, little-endian u32)
    let num_strings = u32::from_le_bytes([data[10], data[11], data[12], data[13]]) as usize;
    // Read string data offset (bytes 14-17)
    let string_data_offset = u32::from_le_bytes([data[14], data[15], data[16], data[17]]) as usize;

    // Expected offset = header(18) + entries(num_strings * 26)
    let expected_offset = 18 + (num_strings * 26);
    if string_data_offset < expected_offset {
        return Err(format!(
            "TLK offset mismatch: data_offset={string_data_offset}, expected>={expected_offset} for {num_strings} strings"
        ));
    }

    if file_size < string_data_offset {
        return Err(format!(
            "TLK truncated: file={file_size} bytes, needs at least {string_data_offset}",
        ));
    }

    Ok(())
}

/// Backup watched files (ACTION.IDS, TRIGGER.IDS, etc.) before a batch.
/// Source: game_dir/override (where the files live). Destination: data_dir.
pub fn backup_watched_files(
    game_dir: &Path,
    data_dir: &Path,
    mod_name: &str,
    watched: &[&str],
) -> Vec<(String, Vec<u8>)> {
    let backup_dir = data_dir.join("watched_backups").join(sanitize_name(mod_name));
    let _ = std::fs::create_dir_all(&backup_dir);

    let mut backups = Vec::new();
    for filename in watched {
        // Case-insensitive file lookup (Linux has case-sensitive filesystems)
        let src = find_file_case_insensitive(&game_dir.join("override"), filename);
        let Some(src) = src else { continue };
        if src.exists() {
            if let Ok(data) = std::fs::read(&src) {
                if data.len() > 100 { // Skip empty/stub files
                    let _ = std::fs::write(backup_dir.join(filename), &data);
                    backups.push((filename.to_string(), data));
                }
            }
        }
    }
    backups
}

/// Check watched files for corruption and restore if needed.
pub fn check_and_restore_watched_files(
    game_dir: &Path,
    backups: &[(String, Vec<u8>)],
) -> Vec<String> {
    let mut restored = Vec::new();

    for (filename, old_data) in backups {
        let path = find_file_case_insensitive(&game_dir.join("override"), filename)
            .unwrap_or_else(|| game_dir.join("override").join(filename));
        if !path.exists() { continue; }

        let Ok(new_data) = std::fs::read(&path) else { continue };

        let corrupted = if filename.to_lowercase().ends_with(".bcs") {
            // BCS: check for severe truncation (<50% of previous size)
            new_data.len() < old_data.len() / 2
        } else if filename.to_lowercase().ends_with(".ids") {
            // IDS: check for growth + duplicate entries
            if new_data.len() > old_data.len() {
                has_duplicate_ids_entries(&new_data)
            } else {
                false
            }
        } else {
            false
        };

        if corrupted {
            let _ = std::fs::write(&path, old_data);
            restored.push(filename.clone());
        }
    }

    restored
}

/// Check if an IDS file has duplicate opcode entries.
fn has_duplicate_ids_entries(data: &[u8]) -> bool {
    let content = String::from_utf8_lossy(data);
    let mut seen = std::collections::HashSet::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") { continue; }
        // IDS format: "147 RemoveSpellRES(S:Spell*)"
        // Key on the opcode number
        if let Some(opcode) = trimmed.split_whitespace().next() {
            if !seen.insert(opcode.to_string()) {
                return true; // Duplicate found
            }
        }
    }
    false
}

/// After a segfault, parse the WSETUP.DEBUG to identify which BCS file caused the crash.
/// Looks for the last BCS file that was being processed (loaded/decompiled/extended).
/// Returns the override path to the problematic BCS if found.
pub fn identify_crash_bcs(game_dir: &Path, mod_name: &str) -> Vec<PathBuf> {
    let debug_file = game_dir.join(format!("setup-{mod_name}.DEBUG"));
    // Also check the fresh (non-backed-up) DEBUG
    let alt_debug = game_dir.join("WSETUP.DEBUG");

    let mut candidates = Vec::new();

    for path in &[&debug_file, &alt_debug] {
        if !path.exists() { continue; }
        let contents = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => match std::fs::read(path) {
                Ok(b) => String::from_utf8_lossy(&b).to_string(),
                Err(_) => continue,
            },
        };

        // Read the last 500 lines — the crash happens at the end
        let lines: Vec<&str> = contents.lines().collect();
        let start = if lines.len() > 500 { lines.len() - 500 } else { 0 };

        for line in &lines[start..] {
            // Pattern: "[./override/FILENAME.BCS] loaded" or "Extending game scripts"
            // followed by crash
            if let Some(bcs) = extract_bcs_from_line(line) {
                let bcs_path = game_dir.join("override").join(&bcs);
                if bcs_path.exists() && !candidates.contains(&bcs_path) {
                    candidates.push(bcs_path);
                }
            }
        }
    }

    // Return the LAST few BCS files found — the crash is most likely on the last one
    if candidates.len() > 3 {
        candidates.drain(..candidates.len() - 3);
    }
    candidates
}

/// Extract a BCS filename from a DEBUG log line.
fn extract_bcs_from_line(line: &str) -> Option<String> {
    let line_lower = line.to_lowercase();

    // Pattern: "[./override/SOMETHING.bcs] loaded"
    if line_lower.contains(".bcs]") && line_lower.contains("loaded") {
        if let Some(start) = line.rfind('/') {
            if let Some(end) = line[start..].find(']') {
                let name = &line[start + 1..start + end];
                if name.to_lowercase().ends_with(".bcs") {
                    return Some(name.to_string());
                }
            }
        }
    }

    // Pattern: "Extending game scripts ... dest is SOMETHING.bcs"
    if line_lower.contains("dest is") && line_lower.contains(".bcs") {
        let parts: Vec<&str> = line.split("dest is").collect();
        if parts.len() >= 2 {
            let name = parts[1].trim();
            if name.to_lowercase().ends_with(".bcs") {
                return Some(name.to_string());
            }
        }
    }

    None
}

/// Replace a problematic BCS with an empty valid BCS script.
/// This allows WeiDU to process it without crashing on decompile.
pub fn replace_with_empty_bcs(path: &Path) -> Result<(), String> {
    // Minimal valid compiled BCS: empty script
    let empty_bcs = b"SC\nCR\n0\n";
    std::fs::write(path, empty_bcs)
        .map_err(|e| format!("Failed to replace {}: {e}", path.display()))
}

/// Find a file in a directory by case-insensitive name match.
/// On Windows this is redundant (filesystem is case-insensitive) but on Linux it's needed.
fn find_file_case_insensitive(dir: &Path, filename: &str) -> Option<PathBuf> {
    // Fast path: exact match
    let exact = dir.join(filename);
    if exact.exists() { return Some(exact); }
    // Slow path: scan directory
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            if entry.file_name().to_string_lossy().eq_ignore_ascii_case(filename) {
                return Some(entry.path());
            }
        }
    }
    None
}

fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

// ── BCS corruption scanner ──────────────────────────────────────────────────
// Detects WeiDU's round-trip bug: when DECOMPILE_AND_PATCH encounters a BCS
// that can't be round-tripped, WeiDU claims "Returning original BCS unchanged"
// but actually writes truncated/corrupted data.  We snapshot BCS sizes before
// each batch, compare after, and auto-restore + report the culprit mod.

/// A snapshot of all .BCS files in override/ with their sizes.
pub struct BcsSnapshot {
    /// filename (uppercase) → (full path, size in bytes)
    files: std::collections::HashMap<String, (PathBuf, u64)>,
}

/// One detected corruption event.
#[derive(Clone)]
pub struct BcsCorruption {
    pub filename: String,
    pub path: PathBuf,
    pub size_before: u64,
    pub size_after: u64,
    pub restored: bool,
}

impl BcsSnapshot {
    /// Scan override/ for all .BCS files and record their sizes.
    /// Only records files > 64 bytes (skip stubs/empties).
    pub fn capture(game_dir: &Path) -> Self {
        let override_dir = game_dir.join("override");
        let mut files = std::collections::HashMap::new();

        if let Ok(entries) = std::fs::read_dir(&override_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.to_lowercase().ends_with(".bcs") {
                    continue;
                }
                if let Ok(meta) = entry.metadata() {
                    let size = meta.len();
                    if size > 64 {
                        files.insert(name.to_uppercase(), (entry.path(), size));
                    }
                }
            }
        }

        Self { files }
    }

    /// Compare current BCS files against this snapshot.  Returns corruptions
    /// found (BCS files that shrunk by >30%).  If `auto_restore` is true,
    /// the original bytes are read from `backup_data` and written back.
    pub fn detect_corruptions(
        &self,
        game_dir: &Path,
        backup_data: &std::collections::HashMap<String, Vec<u8>>,
    ) -> Vec<BcsCorruption> {
        let override_dir = game_dir.join("override");
        let mut corruptions = Vec::new();

        for (key, (path, old_size)) in &self.files {
            // Re-stat the file
            let current_path = find_file_case_insensitive(&override_dir, &path.file_name().unwrap().to_string_lossy())
                .unwrap_or_else(|| path.clone());
            let new_size = match std::fs::metadata(&current_path) {
                Ok(m) => m.len(),
                Err(_) => continue, // File deleted — not our concern
            };

            // Corruption = shrunk by >30%
            if new_size < *old_size * 7 / 10 {
                let mut restored = false;

                // Try to restore from our in-memory backup
                if let Some(original_bytes) = backup_data.get(key) {
                    if std::fs::write(&current_path, original_bytes).is_ok() {
                        restored = true;
                    }
                }

                corruptions.push(BcsCorruption {
                    filename: path.file_name().unwrap().to_string_lossy().to_string(),
                    path: current_path,
                    size_before: *old_size,
                    size_after: new_size,
                    restored,
                });
            }
        }

        corruptions
    }

    /// Read the actual bytes of all tracked BCS files into memory.
    /// Call this right before the batch runs, so we have pristine copies.
    pub fn read_backup_data(&self) -> std::collections::HashMap<String, Vec<u8>> {
        let mut data = std::collections::HashMap::new();
        for (key, (path, _)) in &self.files {
            if let Ok(bytes) = std::fs::read(path) {
                data.insert(key.clone(), bytes);
            }
        }
        data
    }
}

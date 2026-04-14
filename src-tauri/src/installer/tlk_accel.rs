//! TLK Acceleration — reduces dialog.tlk I/O overhead during installation.
//!
//! Tier 1 (always-on): Pre-warm OS page cache by reading TLK into memory.
//! Tier 2 (opt-in): Junction lang/{language}/ to a fast temp drive (SSD/RAM).

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

/// TLK accelerator — manages page-cache pre-warming and optional fast-drive junction.
pub struct TlkAccelerator {
    game_dir: PathBuf,
    language: String,
    lang_dir: PathBuf,             // game_dir/lang/{language}
    fast_dir: Option<PathBuf>,     // temp location for Tier 2
    redirected: bool,              // true if junction is active
    prewarm_enabled: bool,
    fast_drive_enabled: bool,
    last_prewarm: std::time::Instant,
}

impl TlkAccelerator {
    pub fn new(
        game_dir: &Path,
        language: &str,
        prewarm: bool,
        fast_drive: bool,
        fast_drive_path: Option<&str>,
    ) -> Self {
        let lang_dir = game_dir.join("lang").join(language);

        // Determine fast dir location
        let fast_dir = if fast_drive {
            let base = fast_drive_path
                .map(PathBuf::from)
                .unwrap_or_else(|| std::env::temp_dir());
            let game_hash = super::short_path_hash(&game_dir.to_string_lossy());
            Some(base.join(format!("eet-mod-runner-tlk-{game_hash}")))
        } else {
            None
        };

        Self {
            game_dir: game_dir.to_path_buf(),
            language: language.to_string(),
            lang_dir,
            fast_dir,
            redirected: false,
            prewarm_enabled: prewarm,
            fast_drive_enabled: fast_drive,
            last_prewarm: std::time::Instant::now(),
        }
    }

    /// Pre-install setup: pre-warm page cache and optionally set up fast-drive junction.
    pub fn setup(&mut self, app: &AppHandle) -> Result<(), String> {
        // Always clean up stale state from previous crash
        Self::cleanup_stale(&self.game_dir, &self.language);

        // Tier 1: Pre-warm page cache
        if self.prewarm_enabled {
            self.prewarm(app);
        }

        // Tier 2: Fast-drive junction
        if self.fast_drive_enabled {
            if let Some(fast_dir) = self.fast_dir.clone() {
                self.setup_fast_drive(app, &fast_dir)?;
            }
        }

        Ok(())
    }

    /// Periodic maintenance — re-warm cache if stale, sync TLK for crash safety.
    pub fn periodic_sync(&mut self, app: &AppHandle, batch_idx: usize) {
        // Re-warm page cache every 10 minutes (OS may evict during long installs)
        if self.prewarm_enabled && self.last_prewarm.elapsed().as_secs() > 600 {
            self.prewarm(app);
        }

        // Tier 2: periodic TLK sync for crash safety
        if self.redirected && batch_idx > 0 && batch_idx % 25 == 0 {
            if let Some(ref fast_dir) = self.fast_dir {
                let fast_tlk = fast_dir.join("dialog.tlk");
                if fast_tlk.exists() {
                    // Copy to shadow backup (the .eetmr_backup dir has the original)
                    let backup_dir = self.game_dir.join("lang")
                        .join(format!("{}.eetmr_backup", self.language));
                    if backup_dir.is_dir() {
                        let _ = std::fs::copy(&fast_tlk, backup_dir.join("dialog.tlk"));
                    }
                }
            }
        }
    }

    /// Post-install cleanup: remove junction, copy TLK back.
    pub fn teardown(&mut self, app: &AppHandle) -> Result<(), String> {
        if !self.redirected {
            return Ok(());
        }

        let fast_dir = self.fast_dir.as_ref()
            .ok_or("Fast dir not set but redirected flag is true")?;

        let _ = app.emit("install:stdout",
            "[EET Mod Runner] TLK acceleration: restoring original lang directory...");

        let backup_dir = self.game_dir.join("lang")
            .join(format!("{}.eetmr_backup", self.language));

        // 1. Remove junction
        if self.lang_dir.exists() {
            #[cfg(target_os = "windows")]
            {
                // Junction: remove with remove_dir (not remove_dir_all)
                let _ = std::fs::remove_dir(&self.lang_dir);
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = std::fs::remove_file(&self.lang_dir); // symlink
            }
        }

        // 2. Rename backup back
        if backup_dir.is_dir() {
            std::fs::rename(&backup_dir, &self.lang_dir)
                .map_err(|e| format!("Failed to restore lang dir: {e}"))?;
        } else {
            // No backup — recreate the dir
            std::fs::create_dir_all(&self.lang_dir)
                .map_err(|e| format!("Failed to recreate lang dir: {e}"))?;
        }

        // 3. Copy TLK from fast dir to restored location (it's the newest version)
        let fast_tlk = fast_dir.join("dialog.tlk");
        if fast_tlk.exists() {
            let dest = self.lang_dir.join("dialog.tlk");
            std::fs::copy(&fast_tlk, &dest)
                .map_err(|e| format!("Failed to copy TLK back: {e}"))?;
        }
        let fast_tlkf = fast_dir.join("dialogf.tlk");
        if fast_tlkf.exists() {
            let dest = self.lang_dir.join("dialogf.tlk");
            std::fs::copy(&fast_tlkf, &dest)
                .map_err(|e| format!("Failed to copy dialogf.tlk back: {e}"))?;
        }

        // 4. Clean up fast dir
        let _ = std::fs::remove_dir_all(fast_dir);

        self.redirected = false;
        let _ = app.emit("install:stdout",
            "[EET Mod Runner] TLK acceleration: restored successfully");

        Ok(())
    }

    /// Clean up stale junction from a previous crash.
    pub fn cleanup_stale(game_dir: &Path, language: &str) {
        let lang_dir = game_dir.join("lang").join(language);
        let backup_dir = game_dir.join("lang").join(format!("{language}.eetmr_backup"));

        if !backup_dir.exists() {
            return; // No stale state
        }

        // Remove any junction at lang_dir
        if lang_dir.exists() {
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::fs::MetadataExt;
                let is_junction = std::fs::symlink_metadata(&lang_dir)
                    .map(|m| m.file_attributes() & 0x400 != 0)
                    .unwrap_or(false);
                if is_junction {
                    let _ = std::fs::remove_dir(&lang_dir);
                } else {
                    // Real dir — remove it (shouldn't happen, but safe)
                    let _ = std::fs::remove_dir_all(&lang_dir);
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                if std::fs::symlink_metadata(&lang_dir)
                    .map(|m| m.file_type().is_symlink()).unwrap_or(false)
                {
                    let _ = std::fs::remove_file(&lang_dir);
                } else {
                    let _ = std::fs::remove_dir_all(&lang_dir);
                }
            }
        }

        // Check for fast dir with newer TLK
        let temp_pattern = std::env::temp_dir();
        // Look for eet-mod-runner-tlk-* dirs in temp
        if let Ok(entries) = std::fs::read_dir(&temp_pattern) {
            for entry in entries.filter_map(|e| e.ok()) {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("eet-mod-runner-tlk-") {
                    let fast_tlk = entry.path().join("dialog.tlk");
                    let backup_tlk = backup_dir.join("dialog.tlk");
                    if fast_tlk.exists() && backup_tlk.exists() {
                        // Use whichever is larger (TLK only grows during install)
                        let fast_size = std::fs::metadata(&fast_tlk).map(|m| m.len()).unwrap_or(0);
                        let backup_size = std::fs::metadata(&backup_tlk).map(|m| m.len()).unwrap_or(0);
                        if fast_size > backup_size {
                            let _ = std::fs::copy(&fast_tlk, &backup_tlk);
                        }
                    }
                    // Clean up fast dir
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }

        // Rename backup back
        let _ = std::fs::rename(&backup_dir, &lang_dir);
    }

    // ── Private methods ──

    fn prewarm(&mut self, app: &AppHandle) {
        let tlk_path = self.find_tlk();
        if let Some(ref path) = tlk_path {
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            let size_mb = size as f64 / 1_048_576.0;
            let _ = app.emit("install:stdout",
                format!("[EET Mod Runner] Pre-warming dialog.tlk ({:.1} MB) into page cache...", size_mb));

            let start = std::time::Instant::now();
            // Read entire file — OS keeps it in page cache
            let _ = std::fs::read(path);
            let elapsed = start.elapsed();

            let _ = app.emit("install:stdout",
                format!("[EET Mod Runner] Page cache warm ({:.0}ms)", elapsed.as_millis()));
            self.last_prewarm = std::time::Instant::now();
        }
    }

    fn setup_fast_drive(&mut self, app: &AppHandle, fast_dir: &Path) -> Result<(), String> {
        if !self.lang_dir.is_dir() {
            return Err(format!("Lang directory not found: {}", self.lang_dir.display()));
        }

        // Check if fast dir is on a different volume (same volume = no benefit)
        // Simple heuristic: compare drive letters on Windows
        #[cfg(target_os = "windows")]
        {
            let game_drive = self.lang_dir.to_string_lossy().chars().next();
            let fast_drive = fast_dir.to_string_lossy().chars().next();
            if game_drive == fast_drive {
                let _ = app.emit("install:stdout",
                    "[EET Mod Runner] TLK fast-drive: same drive as game, skipping junction (no benefit)");
                return Ok(());
            }
        }

        let _ = app.emit("install:stdout",
            format!("[EET Mod Runner] TLK fast-drive: redirecting lang to {}", fast_dir.display()));

        // 1. Create fast dir
        std::fs::create_dir_all(fast_dir)
            .map_err(|e| format!("Failed to create fast dir: {e}"))?;

        // 2. Copy contents of lang dir to fast dir
        if let Ok(entries) = std::fs::read_dir(&self.lang_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let src = entry.path();
                if src.is_file() {
                    let dest = fast_dir.join(entry.file_name());
                    std::fs::copy(&src, &dest)
                        .map_err(|e| format!("Copy to fast dir: {e}"))?;
                }
            }
        }

        // 3. Rename original to backup
        let backup_dir = self.game_dir.join("lang")
            .join(format!("{}.eetmr_backup", self.language));
        std::fs::rename(&self.lang_dir, &backup_dir)
            .map_err(|e| format!("Failed to rename lang dir: {e}"))?;

        // 4. Create junction
        #[cfg(target_os = "windows")]
        {
            let output = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J",
                    &self.lang_dir.to_string_lossy(),
                    &fast_dir.to_string_lossy()])
                .output()
                .map_err(|e| format!("mklink /J failed: {e}"))?;
            if !output.status.success() {
                // Rollback: rename backup back
                let _ = std::fs::rename(&backup_dir, &self.lang_dir);
                let _ = std::fs::remove_dir_all(fast_dir);
                return Err("Failed to create junction for TLK fast-drive".to_string());
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::os::unix::fs::symlink(fast_dir, &self.lang_dir)
                .map_err(|e| {
                    let _ = std::fs::rename(&backup_dir, &self.lang_dir);
                    let _ = std::fs::remove_dir_all(fast_dir);
                    format!("Symlink failed: {e}")
                })?;
        }

        self.redirected = true;
        let tlk_size = fast_dir.join("dialog.tlk")
            .metadata().map(|m| m.len()).unwrap_or(0);
        let _ = app.emit("install:stdout",
            format!("[EET Mod Runner] TLK fast-drive active — dialog.tlk ({:.1} MB) on fast storage",
                tlk_size as f64 / 1_048_576.0));

        Ok(())
    }

    fn find_tlk(&self) -> Option<PathBuf> {
        let paths = [
            self.game_dir.join("lang").join(&self.language).join("dialog.tlk"),
            self.game_dir.join("lang").join("en_US").join("dialog.tlk"),
            self.game_dir.join("dialog.tlk"),
        ];
        paths.into_iter().find(|p| p.exists())
    }
}

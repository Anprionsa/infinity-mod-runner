//! Override Acceleration — redirects game/override to a fast drive (SSD or RAM disk)
//! during install, then copies back on completion.
//!
//! Rationale: WeiDU's COPY_EXISTING_REGEXP iterates every file in override for
//! pattern matching. With 10K+ BCS files accumulated by mid-install, each iteration
//! becomes the dominant cost. Moving override to a faster volume (especially a RAM
//! disk) can turn thousands of per-file random reads into near-free memory access.
//!
//! Pattern mirrors `tlk_accel.rs`:
//!   setup() at phase start → copy override to fast dir, junction game/override → fast dir
//!   teardown() at phase end → remove junction, copy files back, clean up fast dir
//!   cleanup_stale() on next launch → recover if a previous run crashed mid-redirect
//!
//! Safety considerations:
//!   • Fast dir on same volume as game = no benefit → skip junction
//!   • Fast dir runs out of space mid-install = disaster → check available_space upfront
//!   • Crash mid-install = leftover junction + backup dir → cleanup_stale finds and unwinds
//!   • RAM disk power loss = data loss → periodic sync-back every N batches (caller-driven)

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

/// Override accelerator — junctions the game/override directory to a fast drive
/// during install. Caller is responsible for calling setup() before the batch loop
/// and teardown() after it completes (or on abort).
pub struct OverrideAccelerator {
    game_dir: PathBuf,
    override_dir: PathBuf,       // game_dir/override
    fast_dir: Option<PathBuf>,   // fast drive target
    redirected: bool,
    enabled: bool,
}

impl OverrideAccelerator {
    pub fn new(
        game_dir: &Path,
        enabled: bool,
        fast_drive_path: Option<&str>,
    ) -> Self {
        let override_dir = game_dir.join("override");

        let fast_dir = if enabled {
            let base = fast_drive_path
                .map(PathBuf::from)
                .unwrap_or_else(|| std::env::temp_dir());
            let game_hash = super::short_path_hash(&game_dir.to_string_lossy());
            Some(base.join(format!("infinity-mod-runner-override-{game_hash}")))
        } else {
            None
        };

        Self {
            game_dir: game_dir.to_path_buf(),
            override_dir,
            fast_dir,
            redirected: false,
            enabled,
        }
    }

    /// Pre-install setup: copy override/ to fast dir, junction the original path.
    /// Skips silently if fast dir is on the same volume as the game dir (no benefit).
    pub fn setup(&mut self, app: &AppHandle) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }

        Self::cleanup_stale(&self.game_dir);

        let fast_dir = match self.fast_dir.as_ref() {
            Some(d) => d.clone(),
            None => return Ok(()),
        };

        // Same-volume check — on Windows, compare drive letters. If both are on
        // the same volume, junction gains nothing and costs a large copy up-front.
        #[cfg(target_os = "windows")]
        {
            let game_drive = self.override_dir.to_string_lossy().chars().next();
            let fast_drive = fast_dir.to_string_lossy().chars().next();
            if game_drive == fast_drive {
                let _ = app.emit("install:stdout",
                    "[Infinity Mod Runner] Override fast-drive: same drive as game, skipping (no benefit)");
                return Ok(());
            }
        }

        // Bail early if override doesn't exist (fresh install scenario).
        if !self.override_dir.is_dir() {
            let _ = app.emit("install:stdout",
                "[Infinity Mod Runner] Override fast-drive: override/ doesn't exist yet, skipping");
            return Ok(());
        }

        // Check available space on fast drive. We need roughly 2× override's
        // current size (it grows during install). Bail if tight to avoid a
        // mid-install out-of-space failure.
        let override_size = directory_size(&self.override_dir).unwrap_or(0);
        let needed = override_size * 3; // generous: current + 2× growth room
        let available = fs2::available_space(fast_dir.parent().unwrap_or(&fast_dir))
            .unwrap_or(0);
        if needed > 0 && available > 0 && available < needed {
            let _ = app.emit("install:stdout",
                format!("[Infinity Mod Runner] Override fast-drive: insufficient space on target ({:.1} GB free, {:.1} GB needed). Skipping.",
                    available as f64 / 1_073_741_824.0,
                    needed as f64 / 1_073_741_824.0));
            return Ok(());
        }

        let _ = app.emit("install:stdout",
            format!("[Infinity Mod Runner] Override fast-drive: redirecting override/ ({:.1} MB) to {}",
                override_size as f64 / 1_048_576.0, fast_dir.display()));

        // 1. Create fast dir
        std::fs::create_dir_all(&fast_dir)
            .map_err(|e| format!("Failed to create fast dir: {e}"))?;

        // 2. Copy override/ contents to fast dir. Must be deep copy — override
        //    contains thousands of files. Emit progress periodically so the
        //    user sees something is happening.
        let start = std::time::Instant::now();
        let copied = copy_dir_recursive(&self.override_dir, &fast_dir, app)
            .map_err(|e| {
                let _ = std::fs::remove_dir_all(&fast_dir); // best-effort cleanup
                format!("Failed to copy override to fast dir: {e}")
            })?;
        let elapsed = start.elapsed();
        let _ = app.emit("install:stdout",
            format!("[Infinity Mod Runner] Override fast-drive: copied {} files in {}",
                copied, format_duration(elapsed)));

        // 3. Rename the original override to a backup location
        let backup_dir = self.game_dir.join("override.eetmr_backup");
        if backup_dir.exists() {
            let _ = std::fs::remove_dir_all(&backup_dir);
        }
        if let Err(e) = std::fs::rename(&self.override_dir, &backup_dir) {
            // Rollback
            let _ = std::fs::remove_dir_all(&fast_dir);
            return Err(format!("Failed to rename override dir: {e}"));
        }

        // 4. Create junction from game/override → fast_dir
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let output = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J",
                    &self.override_dir.to_string_lossy(),
                    &fast_dir.to_string_lossy()])
                .creation_flags(0x08000000)
                .output()
                .map_err(|e| {
                    // Rollback: restore backup
                    let _ = std::fs::rename(&backup_dir, &self.override_dir);
                    let _ = std::fs::remove_dir_all(&fast_dir);
                    format!("mklink /J failed: {e}")
                })?;
            if !output.status.success() {
                let _ = std::fs::rename(&backup_dir, &self.override_dir);
                let _ = std::fs::remove_dir_all(&fast_dir);
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Failed to create junction: {}", stderr.trim()));
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::os::unix::fs::symlink(&fast_dir, &self.override_dir)
                .map_err(|e| {
                    let _ = std::fs::rename(&backup_dir, &self.override_dir);
                    let _ = std::fs::remove_dir_all(&fast_dir);
                    format!("Symlink failed: {e}")
                })?;
        }

        self.redirected = true;
        let _ = app.emit("install:stdout",
            "[Infinity Mod Runner] \u{2713} Override fast-drive active — all override/ I/O now on fast storage");

        Ok(())
    }

    /// Post-install teardown: remove junction, copy fast-dir contents back,
    /// restore original override/. On success, fast dir is cleaned up.
    pub fn teardown(&mut self, app: &AppHandle) -> Result<(), String> {
        if !self.redirected {
            return Ok(());
        }
        let fast_dir = self.fast_dir.as_ref()
            .ok_or("Fast dir not set but redirected flag is true")?
            .clone();

        let _ = app.emit("install:stdout",
            "[Infinity Mod Runner] Override fast-drive: restoring override/ from fast storage...");

        let backup_dir = self.game_dir.join("override.eetmr_backup");

        // 1. Remove the junction
        if self.override_dir.exists() {
            #[cfg(target_os = "windows")]
            {
                let _ = std::fs::remove_dir(&self.override_dir);
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = std::fs::remove_file(&self.override_dir);
            }
        }

        // 2. Rename backup back to override
        if backup_dir.is_dir() {
            std::fs::rename(&backup_dir, &self.override_dir)
                .map_err(|e| format!("Failed to restore override dir: {e}"))?;
        } else {
            std::fs::create_dir_all(&self.override_dir)
                .map_err(|e| format!("Failed to recreate override dir: {e}"))?;
        }

        // 3. Copy newer files from fast dir into the restored override.
        //    Fast dir has everything the install wrote; override backup has
        //    the pre-install state. Fast dir wins for any file present in both.
        let start = std::time::Instant::now();
        let copied = copy_dir_recursive(&fast_dir, &self.override_dir, app)
            .map_err(|e| format!("Failed to copy fast-dir contents back: {e}"))?;
        let elapsed = start.elapsed();

        // 4. Clean up fast dir
        let _ = std::fs::remove_dir_all(&fast_dir);

        self.redirected = false;
        let _ = app.emit("install:stdout",
            format!("[Infinity Mod Runner] Override fast-drive: restored {} files in {}",
                copied, format_duration(elapsed)));

        Ok(())
    }

    /// Clean up leftover junction + backup from a crashed previous run.
    /// Called on app startup and phase setup.
    pub fn cleanup_stale(game_dir: &Path) {
        let override_dir = game_dir.join("override");
        let backup_dir = game_dir.join("override.eetmr_backup");

        if !backup_dir.exists() {
            return; // Nothing to clean
        }

        // If override still exists and is a junction, remove it
        if override_dir.exists() {
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::fs::MetadataExt;
                let is_junction = std::fs::symlink_metadata(&override_dir)
                    .map(|m| m.file_attributes() & 0x400 != 0)
                    .unwrap_or(false);
                if is_junction {
                    let _ = std::fs::remove_dir(&override_dir);
                }
                // If it's not a junction, leave it (we can't safely delete user data)
            }
            #[cfg(not(target_os = "windows"))]
            {
                if std::fs::symlink_metadata(&override_dir)
                    .map(|m| m.file_type().is_symlink()).unwrap_or(false)
                {
                    let _ = std::fs::remove_file(&override_dir);
                }
            }
        }

        // Look for our fast-dir in temp — if found, copy its contents into the
        // backup dir before restoring (fast dir has newer writes from the crashed install).
        let temp = std::env::temp_dir();
        if let Ok(entries) = std::fs::read_dir(&temp) {
            for entry in entries.filter_map(|e| e.ok()) {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("infinity-mod-runner-override-") {
                    // Best-effort copy back (don't fail startup if this errors)
                    if let Ok(fast_entries) = std::fs::read_dir(entry.path()) {
                        for fe in fast_entries.filter_map(|e| e.ok()) {
                            let dest = backup_dir.join(fe.file_name());
                            if fe.path().is_file() {
                                let _ = std::fs::copy(fe.path(), &dest);
                            }
                        }
                    }
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }

        // Rename backup back to override
        if !override_dir.exists() {
            let _ = std::fs::rename(&backup_dir, &override_dir);
        }
    }
}

/// Recursively copy src to dst. Returns total files copied. Emits progress every 1000 files.
fn copy_dir_recursive(src: &Path, dst: &Path, app: &AppHandle) -> std::io::Result<usize> {
    std::fs::create_dir_all(dst)?;
    let mut count = 0usize;
    let mut last_report = 0usize;
    copy_dir_inner(src, dst, &mut count, &mut last_report, app)?;
    Ok(count)
}

fn copy_dir_inner(
    src: &Path,
    dst: &Path,
    count: &mut usize,
    last_report: &mut usize,
    app: &AppHandle,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            std::fs::create_dir_all(&dst_path)?;
            copy_dir_inner(&src_path, &dst_path, count, last_report, app)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
            *count += 1;
            if *count - *last_report >= 1000 {
                let _ = app.emit("install:stdout",
                    format!("[Infinity Mod Runner] Override fast-drive: copied {} files...", count));
                *last_report = *count;
            }
        }
    }
    Ok(())
}

/// Compute total size of a directory's files recursively.
fn directory_size(path: &Path) -> std::io::Result<u64> {
    let mut total = 0u64;
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if meta.is_dir() {
            total += directory_size(&entry.path()).unwrap_or(0);
        } else {
            total += meta.len();
        }
    }
    Ok(total)
}

fn format_duration(d: std::time::Duration) -> String {
    let s = d.as_secs();
    if s >= 60 { format!("{}m {}s", s / 60, s % 60) }
    else { format!("{}.{}s", s, d.subsec_millis() / 100) }
}

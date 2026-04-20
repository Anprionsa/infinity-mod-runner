//! Install orchestrator — the main install loop that ties all pieces together.
//!
//! Sequence per phase (BG1 or EET):
//!   1. Parse exported WeiDU.log → Vec<Component>
//!   2. Filter out already-installed (diff against game's weidu.log)
//!   3. Group into batches
//!   4. For each batch:
//!      a. Locate mod folder, copy to game dir
//!      b. Backup DEBUG + dialog.tlk + watched files
//!      c. Run WeiDU (with I/O streaming)
//!      d. Check results, restore DEBUG, check watched files
//!      e. On error → wait for GUI decision (Retry/Skip/Stop)
//!      f. On pause point → wait for GUI resume

use super::{
    Component, ComponentResult, ComponentStatus, ErrorDecision,
    InstallConfig, InstallSummary, ESSENTIAL_MODS, WATCHED_FILES,
};
use super::batch::group_into_batches;
use super::copy::{copy_mod_to_game, find_mod_folder};
use super::debug_mgr::{
    backup_debug, restore_debug, backup_tlk, check_tlk_integrity,
    backup_watched_files, check_and_restore_watched_files,
};
use super::log_diff::{parse_weidu_log, filter_already_installed, is_component_installed};
use super::runner::run_batch;
use super::tracker::InstallTracker;
use super::install_log::{self, SharedLogger};
use super::tlk_accel::TlkAccelerator;
use super::override_accel::OverrideAccelerator;

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Shared state for the install — accessible from Tauri commands.
pub struct InstallState {
    pub abort_flag: AtomicBool,
    pub paused: AtomicBool,
    pub decision: Mutex<Option<ErrorDecision>>,
    pub running: AtomicBool,
}

impl InstallState {
    pub fn new() -> Self {
        Self {
            abort_flag: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            decision: Mutex::new(None),
            running: AtomicBool::new(false),
        }
    }

    pub fn reset(&self) {
        self.abort_flag.store(false, Ordering::SeqCst);
        self.paused.store(false, Ordering::SeqCst);
        if let Ok(mut d) = self.decision.lock() { *d = None; }
        self.running.store(true, Ordering::SeqCst);
    }
}

/// Pause point from the GUI.
pub struct PausePoint {
    pub after_mod_index: usize,
    pub message: String,
    pub phase: String, // "bgee" or "eet"
}

/// Run a full EET install (BG1 phase + EET phase).
pub fn run_eet_install(
    app: &AppHandle,
    config: &InstallConfig,
    exported_bgee_log: Option<&Path>,
    exported_eet_log: &Path,
    pause_points: &[PausePoint],
    state: &InstallState,
) -> InstallSummary {
    state.reset();

    // Resolve data directory for Infinity Mod Runner artifacts
    let data_dir = super::resolve_data_dir(config);

    // Migrate old artifacts from game dir to data dir (one-time)
    migrate_old_artifacts(&config.bg2_game_dir, &data_dir);

    // Clean up any stale TLK junction from a previous crash
    TlkAccelerator::cleanup_stale(&config.bg2_game_dir, &config.language);
    OverrideAccelerator::cleanup_stale(&config.bg2_game_dir);

    // Single-instance lockfile — prevent concurrent installs
    let lockfile_path = data_dir.join("install.lock");
    if lockfile_path.exists() {
        let _ = app.emit("install:error", "Another install is already running. If this is a stale lock from a crash, delete install.lock in your data directory.");
        state.running.store(false, std::sync::atomic::Ordering::SeqCst);
        return InstallSummary {
            total_components: 0, success: 0, warnings: 0, errors: 1,
            skipped: 0, skipped_cascade: 0, already_installed: 0, elapsed_ms: 0, aborted: true,
        };
    }
    let _ = std::fs::write(&lockfile_path, format!("Infinity Mod Runner install started at {}", chrono_now()));

    // Patch WeiDU's PE header to increase stack size (prevents stack overflow segfaults)
    match super::pe_patch::ensure_adequate_stack(&config.weidu_path) {
        Ok(true) => {
            let _ = app.emit("install:stdout",
                "[Infinity Mod Runner] Patched WeiDU stack size to 32MB (prevents 0xc0000005 stack overflow)");
            let _ = app.emit("install:stdout",
                "[Infinity Mod Runner] NOTE: If your antivirus quarantines weidu.exe after this patch, add an exception for it and re-download weidu.exe");
        }
        Ok(false) => {} // Already adequate
        Err(e) => {
            let _ = app.emit("install:stdout",
                format!("[Infinity Mod Runner] WARNING: Could not patch WeiDU stack: {e}"));
        }
    }

    // Persistent install log
    let logger = install_log::create_logger(&data_dir);
    install_log::shared_log(&logger, &format!("Install started — weidu: {}", config.weidu_path.display()));
    // Make the logger reachable from `abort_native_install` so a user-triggered
    // abort can emit [USER_ABORT] into install.log with the rest of the session's
    // events (rather than only going to gui.log).
    install_log::set_active_logger(logger.clone());

    // File-guard: snapshot+restore guard for cross-mod silent file corruption.
    // Loads system + user allowlists, clears prior snapshots, prepares for hook calls
    // in the batch loop.
    let resource_dir = app.path().resource_dir().unwrap_or_else(|_| std::env::current_dir().unwrap_or_default());
    let session_id = format!("{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0));
    if let Err(e) = super::file_guard::init(&data_dir, &resource_dir, session_id) {
        install_log::shared_log(&logger, &format!("file_guard init failed (continuing without guard): {e}"));
    } else {
        install_log::shared_log(&logger,
            &format!("file_guard initialized (pause_on_guard={})", config.pause_on_guard));
    }

    // Count total components across both phases for progress tracking
    let bgee_components = exported_bgee_log
        .map(|p| parse_weidu_log(p).unwrap_or_default())
        .unwrap_or_default();
    let eet_components = parse_weidu_log(exported_eet_log).unwrap_or_default();

    let total = bgee_components.len() + eet_components.len();
    install_log::shared_log(&logger, &format!("Total components: {total} ({} BGEE + {} EET)", bgee_components.len(), eet_components.len()));
    let mut tracker = InstallTracker::new(app.clone(), total, logger.clone());

    // ── Phase 1: BG1 (optional) ──
    if let (Some(bgee_log), Some(bg1_dir)) = (exported_bgee_log, &config.bg1_game_dir) {
        // Check if EET is already installed in BG2's weidu.log
        let eet_already = is_eet_installed(&config.bg2_game_dir);
        if !eet_already {
            let _ = app.emit("install:phase", "bgee");
            let bgee_pause_points: Vec<&PausePoint> = pause_points.iter()
                .filter(|p| p.phase == "bgee")
                .collect();

            let result = run_phase(
                app, config, bg1_dir, &data_dir, bgee_log,
                &bgee_pause_points, "bgee", state, &mut tracker, &logger,
            );

            if state.abort_flag.load(Ordering::SeqCst) {
                let summary = tracker.build_summary(true);
                tracker.emit_complete(&summary);
                clear_checkpoint(&data_dir);
                let _ = std::fs::remove_file(&lockfile_path);
                state.running.store(false, Ordering::SeqCst);
                return summary;
            }

            if let Err(e) = result {
                let _ = app.emit("install:error", e);
            }
        } else {
            // Skip BG1 phase — EET already imported
            let _ = app.emit("install:stdout", "[Infinity Mod Runner] EET already installed, skipping BG1 phase");
            // Mark BGEE components as already installed
            let bgee_already: Vec<ComponentResult> = bgee_components.iter().map(|comp| ComponentResult {
                mod_name: comp.mod_name.clone(),
                component: comp.component,
                component_name: comp.component_name.clone(),
                status: ComponentStatus::AlreadyInstalled,
                message: None,
                warnings: Vec::new(),
            }).collect();
            if !bgee_already.is_empty() {
                tracker.emit_batch_done(0, &bgee_already);
                tracker.record_results(&bgee_already);
            }
        }
    }

    // ── Phase 2: EET ──
    if !state.abort_flag.load(Ordering::SeqCst) {
        let _ = app.emit("install:phase", "eet");
        let eet_pause_points: Vec<&PausePoint> = pause_points.iter()
            .filter(|p| p.phase == "eet")
            .collect();

        let result = run_phase(
            app, config, &config.bg2_game_dir, &data_dir, exported_eet_log,
            &eet_pause_points, "eet", state, &mut tracker, &logger,
        );

        if let Err(e) = result {
            let _ = app.emit("install:error", e);
        }
    }

    let aborted = state.abort_flag.load(Ordering::SeqCst);
    let summary = tracker.build_summary(aborted);
    tracker.emit_complete(&summary);

    // Log final summary
    install_log::shared_log(&logger, &format!(
        "Install {} — {} total, {} success, {} warnings, {} errors, {} skipped, {} already installed, {}ms elapsed",
        if aborted { "ABORTED" } else { "COMPLETE" },
        summary.total_components, summary.success, summary.warnings, summary.errors,
        summary.skipped, summary.already_installed, summary.elapsed_ms
    ));

    // Preserve DEBUG files — copy all *.DEBUG from game dir to data dir for post-mortem analysis
    {
        let debug_dir = data_dir.join("debug_logs");
        let _ = std::fs::create_dir_all(&debug_dir);
        let mut preserved = 0usize;
        if let Ok(entries) = std::fs::read_dir(&config.bg2_game_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.to_lowercase().ends_with(".debug") {
                    let dest = debug_dir.join(&name);
                    if std::fs::copy(entry.path(), &dest).is_ok() {
                        preserved += 1;
                    }
                }
            }
        }
        if preserved > 0 {
            let _ = app.emit("install:stdout",
                format!("[Infinity Mod Runner] Preserved {preserved} DEBUG files to {}", debug_dir.display()));
            install_log::shared_log(&logger,
                &format!("Preserved {preserved} DEBUG files to {}", debug_dir.display()));
        }
    }

    // Clean up lockfile and checkpoint
    clear_checkpoint(&data_dir);
    let _ = std::fs::remove_file(&lockfile_path);

    // Clear the global active-logger handle so abort_native_install stops
    // trying to log to a stale logger between runs.
    install_log::set_active_logger(None);

    state.running.store(false, Ordering::SeqCst);
    summary
}

/// Write a checkpoint file after each batch for crash recovery.
fn write_checkpoint(data_dir: &Path, batch_idx: usize, mod_name: &str, phase: &str, total_batches: usize) {
    let checkpoint = serde_json::json!({
        "batch_idx": batch_idx,
        "mod_name": mod_name,
        "phase": phase,
        "total_batches": total_batches,
        "timestamp": chrono_now(),
    });
    let path = data_dir.join(crate::paths::FILE_CHECKPOINT);
    let _ = std::fs::write(&path, checkpoint.to_string());
}

/// Mid-install override optimization: compress override/ into a .bif so SFO mods
/// iterate far fewer files per COPY_EXISTING_REGEXP. Creates a temporary TP2,
/// runs WeiDU's MAKE_BIFF, then cleans up. IDS files are moved aside before
/// biffing and restored after — eet_end needs them as individual files.
///
/// Returns the count of files biffed on success.
fn run_prebiff_optimization(
    game_dir: &Path,
    config: &super::InstallConfig,
    logger: &Option<super::install_log::SharedLogger>,
) -> Result<usize, String> {
    let override_dir = game_dir.join("override");
    let temp_ids_dir = game_dir.join(".eetmr_ids_stash");

    // 1. Move IDS files out of override (eet_end can't parse biffed IDS)
    let _ = std::fs::create_dir_all(&temp_ids_dir);
    let mut ids_moved = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&override_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.to_uppercase().ends_with(".IDS") {
                let dest = temp_ids_dir.join(&name);
                if std::fs::rename(entry.path(), &dest).is_ok() {
                    ids_moved.push(name);
                }
            }
        }
    }
    install_log::shared_log_event(logger, "PREBIFF",
        &format!("Stashed {} IDS files to {}", ids_moved.len(), temp_ids_dir.display()));

    // Snapshot the list of files we're about to biff — we need the exact
    // paths so we can delete them from override/ AFTER MAKE_BIFF succeeds.
    //
    // Rationale: WeiDU's MAKE_BIFF *copies* files into the biff without
    // removing the originals from override/. That means the biff sits
    // unused — WeiDU's resource lookup checks override/ first, finds the
    // file still there, and loads from disk anyway. For SFO-heavy mods
    // like dw_talents that iterate the full override file set (one real
    // install walked 122k files for cn:60200, taking 4.9h), the biff had
    // zero effect. Deleting the originals after successful biffing is
    // what actually shrinks the iteration surface.
    //
    // Resource-resolution safety: WeiDU checks override → biff → default.
    // Once we delete from override, reads fall through to the biff and
    // return the same bytes. Writes (COPY / EXTEND / etc.) always go to
    // override regardless, so downstream patches still land where the
    // mod expects them — just in a now-near-empty override/.
    //
    // Directory-iteration risk: a small number of mods iterate the
    // override/ directory directly (not the resource namespace). Those
    // would miss biffed files. We haven't observed this in the wild, but
    // this delete step is gated by `config.enable_biff_delete_optimization`
    // so users can disable it if a specific install needs the belt-and-
    // suspenders override/ directory for compatibility. The A/B harness
    // in weidu_experimental/tools/ pins this flag via install_config.json
    // (see RuntimeConfig::enable_biff_delete_optimization), and
    // analyze_install_log.py greps the `[PREBIFF] delete_optimization=...`
    // line below to confirm which variant ran.
    let mut biffed_files: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&override_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_file() {
                biffed_files.push(path);
            }
        }
    }
    let biff_count = biffed_files.len();

    if biff_count == 0 {
        // Nothing to biff — restore IDS and return
        restore_ids_files(&temp_ids_dir, &override_dir);
        return Ok(0);
    }

    // 2. Create temporary TP2 for MAKE_BIFF.
    //
    // Syntax (verified against WeiDU source at tpaction.ml:463 TP_Biff and
    // real mod usage — e.g. HQ_SoundClips_BG2EE):
    //
    //   MAKE_BIFF ~biffname~ BEGIN ~directory~ ~regex~ END
    //
    // The BEGIN/END block contains (directory, regex) pairs. WeiDU opens
    // each directory, stats each entry, matches filenames against the
    // regex (case-insensitive via Str.regexp_case_fold, regular files
    // only — subdirs skipped by the S_REG check), and packs matches into
    // `data/<name>.bif` with a corresponding chitin.key update.
    //
    // We use `^.*$` to match every filename in override/. The earlier
    // stash moved IDS files out (eet_end needs them loose, not biffed),
    // so only biff-safe resources remain. Earlier versions of this TP2
    // had `BEGIN override END` without the regex — WeiDU parsed that as
    // a zero-pair list, iterated nothing, wrote no biff, and returned 0.
    // The BIFF-delete cleanup then correctly skipped with
    // `reason=biff_missing`, which is why the 2026-04-20 run saw no
    // speedup on dw_talents.
    let tp2_dir = game_dir.join("eetmr_optimize");
    let _ = std::fs::create_dir_all(&tp2_dir);
    let tp2_content = r#"BACKUP ~eetmr_optimize/backup~
AUTHOR ~Infinity Mod Runner (auto-generated)~
AUTO_EVAL_STRINGS

BEGIN ~Mid-Install Override Optimization~
  MAKE_BIFF ~eetmr_prebiff~ BEGIN ~override~ ~^.*$~ END
"#;
    let tp2_path = tp2_dir.join("setup-eetmr_optimize.tp2");
    std::fs::write(&tp2_path, tp2_content)
        .map_err(|e| format!("Failed to write temp TP2: {e}"))?;

    // 3. Run WeiDU MAKE_BIFF
    let weidu = &config.weidu_path;
    #[cfg(target_os = "windows")]
    let status = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new(weidu)
            .current_dir(game_dir)
            .args([
                "eetmr_optimize/setup-eetmr_optimize.tp2",
                "--force-install", "0",
                "--no-exit-pause",
                "--quick-log",
                "--language", "0",
            ])
            .env("OCAMLRUNPARAM", &config.ocamlrunparam)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
    };
    #[cfg(not(target_os = "windows"))]
    let status = {
        std::process::Command::new(weidu)
            .current_dir(game_dir)
            .args([
                "eetmr_optimize/setup-eetmr_optimize.tp2",
                "--force-install", "0",
                "--no-exit-pause",
                "--quick-log",
                "--language", "0",
            ])
            .env("OCAMLRUNPARAM", &config.ocamlrunparam)
            .output()
    };

    let biff_ok = match status {
        Ok(output) => {
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                install_log::shared_log_event(logger, "PREBIFF",
                    &format!("WeiDU exited {}: {}", output.status, stderr.trim()));
                false
            } else {
                true
            }
        }
        Err(e) => {
            install_log::shared_log_event(logger, "PREBIFF",
                &format!("Failed to run WeiDU: {e}"));
            false
        }
    };

    // 4. Restore IDS files regardless of biff success
    restore_ids_files(&temp_ids_dir, &override_dir);

    // 5. Clean up temp TP2 + weidu.log entry
    let _ = std::fs::remove_dir_all(&tp2_dir);
    // Remove the eetmr_optimize entry from weidu.log so it doesn't pollute
    // the user's mod list. This is safe because MAKE_BIFF is a one-shot
    // optimization, not a real mod that needs uninstall tracking.
    clean_weidu_log_entry(game_dir, "eetmr_optimize");

    if biff_ok {
        // 6. Delete the originals from override/ — this is what actually
        // reduces the iteration surface for SFO-heavy mods. Up through the
        // 2026-04-19 megainstall, this step was missing and MAKE_BIFF's
        // effect was purely additive (bigger data/ dir, unchanged override/).
        //
        // We only delete files we snapshotted BEFORE running MAKE_BIFF, so
        // any new files introduced by MAKE_BIFF itself (it writes a biff
        // entry to chitin.key but may also produce auxiliary files) are
        // left alone. We also verify the biff file actually exists and is
        // non-empty before deleting — a corrupted/empty biff would mean
        // the files are gone from both places, which is unrecoverable.
        let biff_path = game_dir.join("data").join("eetmr_prebiff.bif");
        let biff_exists = biff_path.metadata()
            .map(|m| m.is_file() && m.len() > 1024)  // Non-trivial size
            .unwrap_or(false);

        let mut deleted = 0usize;
        let mut delete_errors = 0usize;
        // Reason is one of a small enum the analyzer can key on without
        // parsing prose: "ran" | "biff_missing" | "disabled".
        let reason: &str;
        if config.enable_biff_delete_optimization && biff_exists {
            for path in &biffed_files {
                match std::fs::remove_file(path) {
                    Ok(()) => deleted += 1,
                    Err(_) => delete_errors += 1,
                }
            }
            reason = "ran";
        } else if !biff_exists {
            reason = "biff_missing";
        } else {
            reason = "disabled";
        }

        // Verify by counting remaining override files — if cleanup
        // actually fired, this should drop dramatically.
        let remaining = std::fs::read_dir(&override_dir)
            .map(|rd| rd.filter_map(|e| e.ok()).count())
            .unwrap_or(0);

        // Single structured line the A/B analyzer keys on. Kept as
        // `key=value` pairs so it parses trivially with a regex or
        // `.split('=')`. Do NOT reorder keys — the weidu_experimental
        // analyzer (`analyze_install_log.py`) pins on this format.
        // Add new fields at the END of the list.
        install_log::shared_log_event(logger, "PREBIFF",
            &format!(
                "delete_optimization={} reason={} biffed={} deleted={} delete_errors={} override_before={} override_after={} biff_file_size={}",
                config.enable_biff_delete_optimization,
                reason,
                biff_count,
                deleted,
                delete_errors,
                biff_count + ids_moved.len(),
                remaining,
                biff_path.metadata().map(|m| m.len()).unwrap_or(0),
            ));

        Ok(biff_count)
    } else {
        Err("WeiDU MAKE_BIFF failed (see install log)".to_string())
    }
}

/// Move all files from temp IDS stash back to override.
fn restore_ids_files(stash_dir: &Path, override_dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(stash_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let dest = override_dir.join(entry.file_name());
            let _ = std::fs::rename(entry.path(), &dest);
        }
    }
    let _ = std::fs::remove_dir(stash_dir);
}

/// Remove a specific mod's entries from weidu.log. Used to clean up the
/// synthetic eetmr_optimize entry so it doesn't pollute the user's mod list.
fn clean_weidu_log_entry(game_dir: &Path, mod_name: &str) {
    let log_path = game_dir.join("weidu.log");
    if let Ok(content) = std::fs::read_to_string(&log_path) {
        let needle = mod_name.to_lowercase();
        let cleaned: Vec<&str> = content.lines()
            .filter(|line| !line.to_lowercase().contains(&needle))
            .collect();
        let _ = std::fs::write(&log_path, cleaned.join("\n") + "\n");
    }
}

/// Report from a preservation attempt — callers can log this or emit it to the
/// UI so silent preservation failures become visible.
#[derive(Default)]
pub struct PreservationReport {
    /// Files successfully copied into `debug_logs/`.
    pub preserved: usize,
    /// `(relative source name, error message)` for any copy that failed. A
    /// missing source file is NOT a failure — only actual I/O errors show up
    /// here.
    pub failures: Vec<(String, String)>,
}

impl PreservationReport {
    pub fn had_failures(&self) -> bool {
        !self.failures.is_empty()
    }
}

/// Preserve debug files when a batch errors / warns / silent-skips — copy per-mod
/// DEBUG and WSETUP.DEBUG to the data directory before the next batch overwrites
/// them. Also called from the rolling in-flight snapshot (see `debug_snapshot`).
///
/// Returns a `PreservationReport` so callers can see whether copies actually
/// succeeded; previously we used `let _ = std::fs::copy(...)` and silently lost
/// evidence when e.g. a stale file handle or disk error blocked the copy. The
/// `#21` aborted install revealed this: the abort path called this function but
/// the preserved `WSETUP-dw_talents.DEBUG` was stale from a prior install — we
/// had no signal the copy silently failed.
///
/// `logger` is used to log each individual copy failure with its reason (path,
/// io::Error). Missing source files are NOT logged — they're the common case
/// (most mods don't produce a `setup-MOD.DEBUG` on success).
pub(super) fn preserve_error_debug_files(
    game_dir: &Path,
    data_dir: &Path,
    mod_name: &str,
    logger: &Option<SharedLogger>,
) -> PreservationReport {
    let mut report = PreservationReport::default();
    let debug_dir = data_dir.join("debug_logs");
    if let Err(e) = std::fs::create_dir_all(&debug_dir) {
        let msg = format!("failed to create debug_logs dir {}: {e}", debug_dir.display());
        install_log::shared_log_event(logger, "DEBUG_PRESERVE_FAIL", &msg);
        report.failures.push((debug_dir.display().to_string(), e.to_string()));
        return report;
    }

    // Per-mod debug file (setup-MODNAME.DEBUG)
    // Try multiple case variants since WeiDU is inconsistent
    for prefix in &["setup-", "SETUP-", "Setup-", ""] {
        let name = format!("{prefix}{mod_name}.DEBUG");
        let src = game_dir.join(&name);
        if src.exists() {
            let dest = debug_dir.join(format!("setup-{mod_name}.DEBUG"));
            match std::fs::copy(&src, &dest) {
                Ok(_) => report.preserved += 1,
                Err(e) => {
                    let msg = format!(
                        "copy {} → {} failed: {e}",
                        src.display(), dest.display()
                    );
                    install_log::shared_log_event(logger, "DEBUG_PRESERVE_FAIL", &msg);
                    report.failures.push((name.clone(), e.to_string()));
                }
            }
            break;
        }
    }

    // Global WSETUP.DEBUG — rename per mod to avoid overwrites
    let wsetup = game_dir.join("WSETUP.DEBUG");
    if wsetup.exists() {
        let dest = debug_dir.join(format!("WSETUP-{mod_name}.DEBUG"));
        match std::fs::copy(&wsetup, &dest) {
            Ok(_) => report.preserved += 1,
            Err(e) => {
                let msg = format!(
                    "copy {} → {} failed: {e}",
                    wsetup.display(), dest.display()
                );
                install_log::shared_log_event(logger, "DEBUG_PRESERVE_FAIL", &msg);
                report.failures.push(("WSETUP.DEBUG".to_string(), e.to_string()));
            }
        }
    }

    report
}

/// Remove checkpoint file on clean completion.
fn clear_checkpoint(data_dir: &Path) {
    let _ = std::fs::remove_file(data_dir.join(crate::paths::FILE_CHECKPOINT));
}

/// Check for a previous checkpoint (crash recovery).
pub fn read_checkpoint(data_dir: &std::path::Path) -> Option<serde_json::Value> {
    let path = data_dir.join(crate::paths::FILE_CHECKPOINT);
    if !path.exists() { return None; }
    let contents = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&contents).ok()
}

/// Migrate artifact files from the game directory to the per-game data
/// directory — one-time, idempotent. Runs on every install start; no-op
/// when the source files don't exist.
fn migrate_old_artifacts(game_dir: &Path, data_dir: &Path) {
    let migrations = [
        (".eetmr_checkpoint.json", crate::paths::FILE_CHECKPOINT),
        ("eetmr_install.log", crate::paths::FILE_INSTALL_LOG),
    ];
    for (old_name, new_name) in &migrations {
        let old_path = game_dir.join(old_name);
        let new_path = data_dir.join(new_name);
        if old_path.exists() && !new_path.exists() {
            let _ = std::fs::rename(&old_path, &new_path);
        } else if old_path.exists() {
            let _ = std::fs::remove_file(&old_path); // New already exists, just clean up old
        }
    }
    // Migrate directories
    let dir_migrations = [
        ("tlk_backups", "tlk_backups"),
        ("mod_installer_backups", "watched_backups"),
    ];
    for (old_name, new_name) in &dir_migrations {
        let old_path = game_dir.join(old_name);
        let new_path = data_dir.join(new_name);
        if old_path.is_dir() && !new_path.exists() {
            let _ = std::fs::rename(&old_path, &new_path);
        } else if old_path.is_dir() {
            let _ = std::fs::remove_dir_all(&old_path);
        }
    }
    // Clean old lockfile
    let old_lock = game_dir.join(".eetmr_install.lock");
    if old_lock.exists() { let _ = std::fs::remove_file(&old_lock); }
}

fn chrono_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{now}")
}

/// Extract the first WeiDU string literal from a tp2 line — `~X~`, `"X"`,
/// or `'X'`. Scans for the first occurrence of any of the three openers and
/// returns the content up to the matching closer. Returns None if no
/// well-formed literal is found. Used to parse AT_ hook payloads.
fn extract_weidu_string_literal(line: &str) -> Option<String> {
    // Find the earliest opener across ~, ", '
    let candidates: Vec<(usize, char)> = ['~', '"', '\'']
        .iter()
        .filter_map(|&c| line.find(c).map(|i| (i, c)))
        .collect();
    let (open_idx, delim) = candidates.into_iter().min_by_key(|&(i, _)| i)?;
    let rest = &line[open_idx + 1..];
    let close_rel = rest.find(delim)?;
    Some(rest[..close_rel].to_string())
}

/// Extract the first shell-style token from a payload string, respecting
/// `"..."` and `'...'` quoting. Used by the AT_INTERACTIVE_EXIT script
/// staging to find the executable path from lines like:
///
///   `foo.bat arg1 arg2`              → `foo.bat`
///   `"my folder/foo.bat" arg1`       → `my folder/foo.bat`
///   `'has space.bat'`                → `has space.bat`
///   `foo.bat`                         → `foo.bat`
///
/// A split on whitespace would break the embedded-space case; this helper
/// scans character by character and closes on unquoted whitespace.
fn extract_first_path_token(payload: &str) -> String {
    let trimmed = payload.trim_start();
    let mut chars = trimmed.chars().peekable();
    let mut out = String::new();
    let first = match chars.peek() {
        Some(&c) => c,
        None => return String::new(),
    };
    if first == '"' || first == '\'' {
        // Quoted: consume the opening quote, read until matching close.
        let quote = first;
        chars.next();
        for c in chars {
            if c == quote { break; }
            out.push(c);
        }
    } else {
        // Unquoted: read until whitespace.
        for c in chars {
            if c.is_whitespace() { break; }
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod at_hook_tests {
    use super::extract_first_path_token;

    #[test]
    fn unquoted_no_args() {
        assert_eq!(extract_first_path_token("foo.bat"), "foo.bat");
    }
    #[test]
    fn unquoted_with_args() {
        assert_eq!(extract_first_path_token("foo.bat arg1 arg2"), "foo.bat");
    }
    #[test]
    fn double_quoted_spaces() {
        assert_eq!(extract_first_path_token("\"my folder/foo.bat\" arg1"), "my folder/foo.bat");
    }
    #[test]
    fn single_quoted_spaces() {
        assert_eq!(extract_first_path_token("'has space.bat'"), "has space.bat");
    }
    #[test]
    fn leading_whitespace() {
        assert_eq!(extract_first_path_token("   foo.bat"), "foo.bat");
    }
    #[test]
    fn empty() {
        assert_eq!(extract_first_path_token(""), "");
    }

    use super::extract_weidu_string_literal;

    #[test]
    fn tilde_literal() {
        assert_eq!(extract_weidu_string_literal("AT_EXIT ~foo.bat~").as_deref(), Some("foo.bat"));
    }
    #[test]
    fn double_quote_literal() {
        assert_eq!(extract_weidu_string_literal("AT_EXIT \"foo.bat\"").as_deref(), Some("foo.bat"));
    }
    #[test]
    fn single_quote_literal() {
        assert_eq!(extract_weidu_string_literal("AT_EXIT 'foo.bat'").as_deref(), Some("foo.bat"));
    }
    #[test]
    fn missing_close() {
        assert_eq!(extract_weidu_string_literal("AT_EXIT ~foo.bat"), None);
    }
    #[test]
    fn first_opener_wins() {
        // Content has both ~ and " — earliest wins.
        assert_eq!(extract_weidu_string_literal("AT_EXIT ~x~ \"y\"").as_deref(), Some("x"));
    }

    // Path-traversal detection sanity: we rely on Path::components() seeing
    // `..` as Component::ParentDir. Guard against a regression where that
    // invariant changes or someone mis-constructs the Path.
    #[test]
    fn traversal_components_detected() {
        use std::path::{Component, Path};
        let has_pd = |s: &str| Path::new(s).components().any(|c| matches!(c, Component::ParentDir));
        assert!(has_pd("../foo.bat"));
        assert!(has_pd("foo/../../bar.bat"));
        assert!(has_pd("a/b/../c.bat"));
        assert!(!has_pd("foo.bat"));
        assert!(!has_pd("sub/foo.bat"));
        assert!(!has_pd("sub/inner/foo.bat"));
    }

    #[test]
    fn absolute_path_detected() {
        use std::path::Path;
        // Unix absolute
        assert!(Path::new("/etc/passwd.bat").is_absolute());
        // Windows absolute (only meaningful on Windows CI; on Linux this
        // is a relative path starting with a drive-letter-looking segment).
        // Keep the assertion conditional to avoid CI divergence.
        #[cfg(windows)]
        assert!(Path::new("C:\\windows\\system32\\foo.bat").is_absolute());
        // Relative paths not flagged.
        assert!(!Path::new("foo.bat").is_absolute());
        assert!(!Path::new("sub/foo.bat").is_absolute());
    }
}

/// Return (copies_made, copies_failed) for AT_INTERACTIVE_EXIT script targets.
///
/// Parses each mod's tp2 (in the game dir, post-copy) for lines of the form
/// `AT_INTERACTIVE_EXIT ~payload~` where `payload` references an executable
/// script (.bat, .exe, .cmd, .sh, .py). For each such reference:
///
///   1. Resolve the referenced path AS IF it were game-dir-relative
///      (that's how WeiDU invokes it — shell cwd is the game dir).
///   2. If the file already exists at that game-dir path (either because the
///      mod's own COPY actions put it there, or because it's inside the
///      mod folder the runner already junctioned), skip — nothing to do.
///   3. Otherwise, hunt for the script in the mod source tree:
///      - inside the mod folder at the ref path
///      - at the mod's parent directory (the impasylum pattern)
///      - two levels up (for deeply-nested extraction layouts)
///      - as a bare basename anywhere under the mod's parent
///   4. If found, copy it into the game dir at the ref path so WeiDU's
///      AT_INTERACTIVE_EXIT shell-out finds it.
///   5. Log every copy for post-install forensics.
///
/// This generalizes a class of silent in-game bugs: mods that rely on
/// post-install shell scripts (audio conversion, TIZ→TIS tileset extraction,
/// cleanup) but place the script outside the mod folder. Observed in at least
/// 9 Extracted mods during v1.0.2 testing (Improved Asylum, Fade NPC, Alassa
/// NPC, Yoshimo Romance, Secret of Bone Hill, The Darkest Day, Sheena,
/// Varshoon, Return to Tradesmeet) — all silently skipped their post-install
/// asset conversion because the shell couldn't find the bat.
///
/// Scope: this does NOT modify AT_INTERACTIVE_EXIT itself. The line stays in
/// the tp2 and WeiDU still fires it — we just ensure the referenced script
/// is where WeiDU expects it. If the mod author didn't ship the script at all
/// (a separate class of author bug), this step can't help and the hook still
/// fails at runtime; it logs "script not found in source" so the user sees why.
pub(crate) struct AtExitStaging {
    pub copied: usize,
    pub failed: usize,
    /// Absolute paths staged into the game dir. Used by the post-install
    /// cleanup step to remove them after WeiDU has finished firing its
    /// AT_ hooks. Deduped — multi-mod references to the same target don't
    /// get copied or tracked twice.
    pub staged_paths: Vec<std::path::PathBuf>,
}

fn ensure_at_interactive_exit_scripts(
    mod_dir: &Path,
    game_dir: &Path,
    batches: &[super::Batch],
    logger: &Option<SharedLogger>,
) -> AtExitStaging {
    let mut copied = 0usize;
    let mut failed = 0usize;
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    // Staged-target dedup: if mod A and mod B both reference `foo.bat`, only
    // the first mod actually stages; subsequent references are no-ops even
    // when the target is missing at hunt time. Set key is the canonical
    // absolute target path.
    let mut staged_paths: Vec<std::path::PathBuf> = Vec::new();
    let mut staged_set: std::collections::HashSet<std::path::PathBuf> = std::collections::HashSet::new();

    // Build a mod_locations map so we can find each mod's source directory
    // (the tp2's parent) regardless of parent-folder naming drift.
    let mod_locations = crate::commands::build_mod_location_map(mod_dir);

    for batch in batches {
        let key = (batch.mod_name.to_lowercase(), batch.tp_file.to_lowercase());
        if !seen.insert(key) { continue; }

        let tp2_path = game_dir.join(&batch.mod_name).join(&batch.tp_file);
        if !tp2_path.exists() { continue; }

        let content = match std::fs::read_to_string(&tp2_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        for line in content.lines() {
            let trimmed = line.trim();
            // AT_NOW fires during install; AT_INSTALL at component install;
            // AT_UNINSTALL at component removal; AT_EXIT / AT_INTERACTIVE_EXIT
            // at WeiDU shutdown. All of them can reference external scripts,
            // and all of them fire inside WeiDU's shell-out — so the target
            // script must be at the game-dir-relative path. Audit found 14
            // tp2s using AT_NOW/AT_INSTALL/AT_UNINSTALL with bat/exe/sh refs.
            let is_at_hook = trimmed.starts_with("AT_INTERACTIVE_EXIT")
                || trimmed.starts_with("AT_EXIT")
                || trimmed.starts_with("AT_NOW")
                || trimmed.starts_with("AT_INSTALL")
                || trimmed.starts_with("AT_UNINSTALL");
            if !is_at_hook { continue; }
            // Skip the ones `suppress_readmes` already commented out.
            if trimmed.starts_with("//") { continue; }
            // Extract the string-literal payload. WeiDU's grammar accepts
            // `~X~`, `"X"`, and `'X'` as equivalent string delimiters in
            // this position. Find whichever opens first.
            let payload = match extract_weidu_string_literal(trimmed) {
                Some(p) => p,
                None => continue,
            };
            let payload = payload.as_str();
            // First shell-style token of the payload is the path (rest may be
            // args). Respects `"..."` / `'...'` quoting so paths with spaces
            // (e.g. `"my folder/foo.bat"`) are extracted intact.
            let ref_path_string = extract_first_path_token(payload);
            let ref_path = ref_path_string.as_str();
            if ref_path.is_empty() { continue; }
            // WeiDU variables (`%MOD_FOLDER%`, `%os_slash%`, etc.) only resolve
            // inside WeiDU's execution context; we can't pre-stage scripts whose
            // paths contain them. Log-and-skip so the user knows the hook fired
            // from a variable path and we didn't touch it.
            if ref_path.contains('%') {
                install_log::shared_log(logger, &format!(
                    "[AT_EXIT_HOOK] skip {}: ref {:?} contains WeiDU variable — can't pre-resolve",
                    batch.mod_name, ref_path,
                ));
                continue;
            }
            // Only act on executable-script extensions; readmes / other things
            // are either already suppressed or not our concern.
            let lower = ref_path.to_lowercase();
            let is_script = lower.ends_with(".bat")
                || lower.ends_with(".exe")
                || lower.ends_with(".cmd")
                || lower.ends_with(".sh")
                || lower.ends_with(".py");
            if !is_script { continue; }

            // Path-traversal defense. Two layers:
            //   1. Lexical rejection of any `..` component in the ref path —
            //      Windows `Path::starts_with` is component-wise, so
            //      `BG2EE/../../../etc` does START with the `BG2EE` component
            //      and would falsely pass a naive canonicalize-then-starts-with
            //      check when `canonicalize` fails on a non-existent target
            //      parent (canonicalize returns Err for missing paths and we'd
            //      fall back to the non-canonical pathbuf).
            //   2. If the parent *does* exist and canonicalizes, verify the
            //      canonical form still lives inside the canonical game dir —
            //      catches exotic escapes via symlinks / junctions.
            let ref_path_obj = std::path::Path::new(ref_path);
            let has_parent_dir_component = ref_path_obj
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir));
            if has_parent_dir_component {
                install_log::shared_log(logger, &format!(
                    "[AT_EXIT_HOOK] skip {}: ref {:?} contains `..` path-traversal segment",
                    batch.mod_name, ref_path,
                ));
                continue;
            }
            let target = game_dir.join(ref_path);
            // Also reject absolute ref paths — they'd let WeiDU write to
            // anywhere on disk. `join()` on an absolute path silently
            // discards game_dir, so this check catches that before we create
            // any directories.
            if ref_path_obj.is_absolute() {
                install_log::shared_log(logger, &format!(
                    "[AT_EXIT_HOOK] skip {}: ref {:?} is absolute; refusing to stage outside game dir",
                    batch.mod_name, ref_path,
                ));
                continue;
            }
            // Symlink-hardening: if the parent already exists on disk,
            // canonicalize it and verify we're still inside canonical
            // game_dir. If it doesn't exist (common — we may be the first
            // to create the subdir), the lexical check above already guards us.
            if let (Ok(canonical_game), Some(target_parent)) = (game_dir.canonicalize(), target.parent()) {
                if let Ok(canonical_parent) = target_parent.canonicalize() {
                    if !canonical_parent.starts_with(&canonical_game) {
                        install_log::shared_log(logger, &format!(
                            "[AT_EXIT_HOOK] skip {}: ref {:?} escapes game dir via symlink (resolved to {})",
                            batch.mod_name, ref_path, canonical_parent.display(),
                        ));
                        continue;
                    }
                }
            }
            if target.exists() { continue; }

            // Hunt for the script in the mod's source tree. The mod folder in
            // the source map is the *parent* of the tp2 (mod_locations points
            // to that). Check candidate locations in order of likelihood.
            let mod_src = match mod_locations.get(&batch.mod_name.to_lowercase()) {
                Some(p) => p.clone(),
                None => continue, // can't resolve mod source → skip
            };
            let basename = std::path::Path::new(ref_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| ref_path.to_string());

            let mut candidates: Vec<std::path::PathBuf> = vec![
                mod_src.join(ref_path),                    // mod folder + ref path
                mod_src.join(&basename),                   // mod folder + basename
            ];
            if let Some(parent) = mod_src.parent() {
                candidates.push(parent.join(ref_path));    // mod parent + ref path (impasylum case)
                candidates.push(parent.join(&basename));   // mod parent + basename
                if let Some(grandparent) = parent.parent() {
                    candidates.push(grandparent.join(ref_path));
                    candidates.push(grandparent.join(&basename));
                }
            }

            let src = candidates.iter().find(|p| p.is_file());
            let Some(src) = src else {
                install_log::shared_log(logger, &format!(
                    "[AT_EXIT_HOOK] skip {}: referenced script {:?} not found in mod source for {}",
                    batch.mod_name, ref_path, batch.mod_name,
                ));
                continue;
            };

            if let Some(dest_parent) = target.parent() {
                if !dest_parent.exists() {
                    let _ = std::fs::create_dir_all(dest_parent);
                }
            }
            // Dedup across mods: another mod may already have staged
            // this exact target; don't re-copy.
            if staged_set.contains(&target) { continue; }
            match std::fs::copy(src, &target) {
                Ok(_) => {
                    copied += 1;
                    install_log::shared_log(logger, &format!(
                        "[AT_EXIT_HOOK] {} -> {} (mod={})",
                        src.display(), target.display(), batch.mod_name,
                    ));
                    staged_set.insert(target.clone());
                    staged_paths.push(target.clone());
                }
                Err(e) => {
                    failed += 1;
                    install_log::shared_log(logger, &format!(
                        "[AT_EXIT_HOOK] FAILED {} -> {}: {e}",
                        src.display(), target.display(),
                    ));
                }
            }
        }
    }

    AtExitStaging { copied, failed, staged_paths }
}

/// The SFO2e/DS shared library ships a `ds.tph` containing a `ds_sort_ids`
/// function. That function has a longstanding bug: when fed a headerless IDS
/// file, it emits a corrupted sort — duplicate "N M" entries, same-index
/// collisions, and under some conditions a null byte at the old header
/// position. STATS.IDS is the canonical victim; post-ds_sort_ids it looks
/// like:
///
/// ```text
/// IDS V1.0          <- synthesized header (from prior cleanup) or missing
/// \x00              <- stale null byte
/// 3 ARMORCLASS
/// 3 ACCRUSHINGMOD   <- duplicate index 3
/// 5 ACCRUSHINGMOD   <- same name, different index
/// ```
///
/// Across a megainstall, 10+ mods call `ds_sort_ids STR_VAR ids=stats` in
/// sequence (each their own ds.tph copy). Every call re-corrupts STATS.IDS;
/// the damage accumulates and every later mod that reads STATS.IDS (every
/// script-writing mod) emits `WARNING: error parsing STATS.IDS:
/// Parsing.Parse_error`.
///
/// v1.0.2 patched 6 of 22 ds.tph copies via per-mod manifest entries. This
/// step generalizes the fix: scan the game dir (post-mod-copy) for every
/// `ds.tph`, locate the canonical `LAF ds_sort_ids STR_VAR ids=stats END`
/// call site (all 15 observed occurrences use this exact whitespace), and
/// insert a cleanup block immediately after. Idempotent via the
/// `_eetmr_ids_cleanup` text marker — ds.tph files already marked (e.g. by
/// the legacy manifest patches) are skipped. Returns (patched, skipped).
///
/// The cleanup block itself does:
///   1. Strip spurious `N M\n` entries (the original ds_sort_ids bug).
///   2. If `IDS V1.0` header missing, prepend it.
/// Null-byte stripping intentionally omitted — once every call site is
/// covered, fresh corruption doesn't accumulate, so the null-byte pattern
/// (which was a consequence of unpatched iterations piling up) stops.
fn ensure_ds_ids_cleanup_all(
    game_dir: &Path,
    batches: &[super::Batch],
    logger: &Option<SharedLogger>,
) -> (usize, usize) {
    // Exact anchor confirmed present in all 15 ds.tph files that call
    // ds_sort_ids on stats (Python audit: zero whitespace variance across
    // the real mod set).
    const ANCHOR: &str = "LAF ds_sort_ids STR_VAR ids=stats END";
    const MARKER: &str = "_eetmr_ids_cleanup";
    const CLEANUP_BLOCK: &str = "\n// _eetmr_ids_cleanup: runner-injected. Strips spurious \"N M\" entries\n\
// from ds_sort_ids's headerless-IDS parse bug, then ensures IDS V1.0 header.\n\
// Applied automatically to every ds.tph in the install — not per-mod.\nCOPY_EXISTING ~stats.ids~ ~override~\n  \
REPLACE_TEXTUALLY ~^[0-9]+ [0-9]+\\(%WNL%\\|%LNL%\\|%MNL%\\)~ ~\\1~\n  \
PATCH_IF INDEX_BUFFER (~IDS V1.0~) < 0 BEGIN\n    \
INSERT_BYTES 0x0 11\n    \
WRITE_ASCIIE 0x0 ~IDS V1.0%WNL%~\n  \
END\nBUT_ONLY";

    let mut patched = 0usize;
    let mut skipped_already_marked = 0usize;
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for batch in batches {
        let mod_name_key = batch.mod_name.to_lowercase();
        if !seen.insert(mod_name_key.clone()) { continue; }
        let mod_root = game_dir.join(&batch.mod_name);
        if !mod_root.is_dir() { continue; }

        // Recursive BFS for ds.tph (case-insensitive match on filename).
        // Depth-bounded so we don't walk forever into unexpected structures.
        let mut stack: Vec<(std::path::PathBuf, u32)> = vec![(mod_root.clone(), 0)];
        let mut ds_files: Vec<std::path::PathBuf> = Vec::new();
        const MAX_DEPTH: u32 = 6;
        while let Some((dir, depth)) = stack.pop() {
            if depth > MAX_DEPTH { continue; }
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_dir() {
                    stack.push((path, depth + 1));
                } else if path.is_file() {
                    if let Some(name) = path.file_name() {
                        if name.to_string_lossy().eq_ignore_ascii_case("ds.tph") {
                            ds_files.push(path);
                        }
                    }
                }
            }
        }

        for ds in &ds_files {
            let Ok(content) = std::fs::read_to_string(ds) else { continue };
            if content.contains(MARKER) {
                skipped_already_marked += 1;
                continue;
            }
            let Some(idx) = content.find(ANCHOR) else { continue };
            let cut = idx + ANCHOR.len();
            let mut new_content = String::with_capacity(content.len() + CLEANUP_BLOCK.len());
            new_content.push_str(&content[..cut]);
            new_content.push_str(CLEANUP_BLOCK);
            new_content.push_str(&content[cut..]);
            match std::fs::write(ds, &new_content) {
                Ok(_) => {
                    patched += 1;
                    install_log::shared_log(logger, &format!(
                        "[DS_CLEANUP] patched {} (mod={})",
                        ds.display(), batch.mod_name,
                    ));
                }
                Err(e) => {
                    install_log::shared_log(logger, &format!(
                        "[DS_CLEANUP] write failed {} (mod={}): {e}",
                        ds.display(), batch.mod_name,
                    ));
                }
            }
        }
    }

    (patched, skipped_already_marked)
}

/// Remove files previously staged by `ensure_at_interactive_exit_scripts`.
/// Called at install end after WeiDU has had its chance to fire AT_ hooks.
/// Silently ignores missing files (WeiDU's own cleanup inside a bat may have
/// already removed the target, e.g. `del oggdec.exe` in asyinstall.bat) and
/// logs each delete for forensics. Leaves the parent directories in place —
/// they may hold user data unrelated to the staging.
fn cleanup_at_exit_staged_scripts(
    staged: &[std::path::PathBuf],
    logger: &Option<SharedLogger>,
) -> usize {
    let mut removed = 0usize;
    for path in staged {
        match std::fs::remove_file(path) {
            Ok(_) => {
                removed += 1;
                install_log::shared_log(logger, &format!(
                    "[AT_EXIT_HOOK] cleanup removed {}", path.display()
                ));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // WeiDU's own bat may have self-deleted; not a failure.
            }
            Err(e) => {
                install_log::shared_log(logger, &format!(
                    "[AT_EXIT_HOOK] cleanup failed {}: {e}", path.display()
                ));
            }
        }
    }
    removed
}

/// Run a single phase (BG1 or EET).
fn run_phase(
    app: &AppHandle,
    config: &InstallConfig,
    game_dir: &Path,
    data_dir: &Path,
    exported_log: &Path,
    pause_points: &[&PausePoint],
    phase_name: &str,
    state: &InstallState,
    tracker: &mut InstallTracker,
    logger: &Option<SharedLogger>,
) -> Result<(), String> {
    // 1. Parse exported log
    let all_components = parse_weidu_log(exported_log)
        .map_err(|e| format!("Failed to parse log: {e}"))?;

    // 2. Filter already installed
    let components = if config.skip_installed {
        filter_already_installed(&all_components, game_dir)
    } else {
        all_components.clone()
    };

    let skipped_count = all_components.len() - components.len();
    if skipped_count > 0 {
        let _ = app.emit("install:stdout",
            format!("[Infinity Mod Runner] Skipping {skipped_count} already-installed components"));
        // Record in tracker and emit to frontend so progress bar and status column reflect the true starting point
        let already_results: Vec<ComponentResult> = all_components.iter()
            .filter(|c| !components.iter().any(|ic| ic.tp_file.eq_ignore_ascii_case(&c.tp_file) && ic.component == c.component))
            .map(|c| ComponentResult {
                mod_name: c.mod_name.clone(),
                component: c.component,
                component_name: c.component_name.clone(),
                status: ComponentStatus::AlreadyInstalled,
                message: None,
                warnings: Vec::new(),
            })
            .collect();
        if !already_results.is_empty() {
            tracker.emit_batch_done(0, &already_results);
            tracker.record_results(&already_results);
        }
    }

    // 3. Group into batches
    let batches = group_into_batches(
        &components,
        config.max_batch_size,
        &config.force_small_batch_mods,
        config.force_small_batch_size,
        &config.force_single_cn_mods,
    );
    let total_batches = batches.len();

    let _ = app.emit("install:stdout",
        format!("[Infinity Mod Runner] {} components in {} batches", components.len(), total_batches));

    // 3b. Pre-junction all unique mods before the batch loop.
    // This front-loads all file I/O so the batch loop is pure WeiDU execution.
    {
        let mut junctioned: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut junction_ok = 0usize;
        let mut junction_fail = 0usize;
        let unique_mods: Vec<(String, String)> = batches.iter()
            .filter_map(|b| {
                let key = b.mod_name.to_lowercase();
                if junctioned.contains(&key) { return None; }
                junctioned.insert(key);
                Some((b.mod_name.clone(), b.tp_file.clone()))
            })
            .collect();
        let total_mods = unique_mods.len();

        // Build mod folder index once (single directory walk) instead of
        // doing 400+ recursive searches.
        let _ = app.emit("install:stdout",
            format!("[Infinity Mod Runner] Indexing mod directory..."));
        let mod_index = super::copy::build_mod_folder_index(&config.mod_directory, 5);
        let _ = app.emit("install:stdout",
            format!("[Infinity Mod Runner] Found {} mods in index, linking {total_mods} to game dir...", mod_index.len()));

        for (idx, (mod_name, tp_file)) in unique_mods.iter().enumerate() {
            let dest = game_dir.join(mod_name);
            if dest.exists() {
                junction_ok += 1;
                continue;
            }
            if idx % 50 == 0 {
                let _ = app.emit("install:stdout",
                    format!("[Infinity Mod Runner] Linking mods {}/{}...", idx + 1, total_mods));
            }
            if let Some(src) = super::copy::find_mod_in_index(&mod_index, &config.mod_directory, mod_name, tp_file, 5) {
                match copy_mod_to_game(&src, &dest) {
                    Ok(_) => junction_ok += 1,
                    Err(e) => {
                        junction_fail += 1;
                        let _ = app.emit("install:stdout",
                            format!("[Infinity Mod Runner] WARNING: Failed to link '{}': {e}", mod_name));
                    }
                }
            }
        }
        // Junction sibling directories (e.g., TDD alongside TDDz)
        let mut sibling_count = 0usize;
        for (mod_key, siblings) in &config.sibling_directories {
            // Only junction siblings if the main mod was junctioned
            if !junctioned.contains(mod_key) { continue; }
            for sibling_name in siblings {
                let sibling_dest = game_dir.join(sibling_name);
                if sibling_dest.exists() { continue; }
                // Find the sibling in the same parent as the main mod
                if let Some(main_src) = super::copy::find_mod_in_index(&mod_index, &config.mod_directory, mod_key, "", 5) {
                    if let Some(parent) = main_src.parent() {
                        let sibling_src = parent.join(sibling_name);
                        if sibling_src.exists() {
                            match copy_mod_to_game(&sibling_src, &sibling_dest) {
                                Ok(_) => {
                                    sibling_count += 1;
                                    let _ = app.emit("install:stdout",
                                        format!("[Infinity Mod Runner] Linked sibling directory '{}' for '{}'", sibling_name, mod_key));
                                }
                                Err(e) => {
                                    let _ = app.emit("install:stdout",
                                        format!("[Infinity Mod Runner] WARNING: Failed to link sibling '{}': {e}", sibling_name));
                                }
                            }
                        }
                    }
                }
            }
        }

        let _ = app.emit("install:stdout",
            format!("[Infinity Mod Runner] {junction_ok} mods ready ({junction_fail} failed{})",
                if sibling_count > 0 { format!(", {sibling_count} siblings") } else { String::new() }));
    }

    // 3c. Neutralize AT_INTERACTIVE_EXIT in all TP2 files (prevents mods from
    //     opening READMEs/docs during automated install).
    //
    // Path note: `batch.tp_file` is the filename ONLY (e.g. "ZELINK.TP2"),
    // parsed by log_diff.rs from the last path segment. The TP2 actually
    // lives at `<game>/<mod_name>/<tp_file>` — engine.rs formats this same
    // way when invoking WeiDU. The previous version of this loop joined
    // only game_dir + tp_file, which silently missed every mod whose
    // TP2 sits inside its mod folder (i.e. nearly all of them), leaving
    // `AT_INTERACTIVE_EXIT ~VIEW ...~` active and readme popups firing
    // e.g. zelink during its interactive-exit step.
    //
    // Dedupe on (mod_name, tp_file) — two batches can share the same TP2
    // when a mod is split across the install order (e.g. imoen_forever
    // with BG1 and BG2 components) and we only need to patch it once.
    if config.suppress_readmes {
        let mut neutralized = 0usize;
        let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
        for batch in &batches {
            let key = (batch.mod_name.to_lowercase(), batch.tp_file.to_lowercase());
            if !seen.insert(key) { continue; }
            let tp2_path = game_dir.join(&batch.mod_name).join(&batch.tp_file);
            if !tp2_path.exists() { continue; }
            if let Ok(content) = std::fs::read_to_string(&tp2_path) {
                if content.contains("AT_INTERACTIVE_EXIT") {
                    let patched = content.lines().map(|line| {
                        let trimmed = line.trim();
                        if trimmed.starts_with("AT_INTERACTIVE_EXIT") || trimmed.starts_with("AT_EXIT") {
                            if trimmed.contains("VIEW") || trimmed.contains(".rtf") || trimmed.contains(".htm")
                                || trimmed.contains(".txt") || trimmed.contains(".pdf") || trimmed.contains(".doc")
                            {
                                format!("// _eetmr_suppressed: {line}")
                            } else {
                                line.to_string()
                            }
                        } else {
                            line.to_string()
                        }
                    }).collect::<Vec<_>>().join("\n");
                    if patched != content {
                        let _ = std::fs::write(&tp2_path, &patched);
                        neutralized += 1;
                    }
                }
            }
        }
        if neutralized > 0 {
            let _ = app.emit("install:stdout",
                format!("[Infinity Mod Runner] Suppressed AT_INTERACTIVE_EXIT in {neutralized} TP2 files (no readme popups)"));
            install_log::shared_log(logger, &format!("Suppressed AT_INTERACTIVE_EXIT in {neutralized} TP2 files"));
        }
    }

    // 3d. Ensure AT_INTERACTIVE_EXIT script targets (.bat / .exe / .cmd / .sh)
    //     are present in the game dir. `suppress_readmes` above only comments
    //     out readme-style exit hooks; real scripts (audio decoding, tileset
    //     extraction, etc.) are kept as-is. But mod authors sometimes place the
    //     script OUTSIDE the mod folder (e.g. `Improved Asylum/asyinstall.bat`
    //     lives at the mod's parent dir, not inside `impasylum/`), and the
    //     bulk mod-copy loop above only copies the mod folder itself — so the
    //     referenced script never reaches the game dir, WeiDU fires the hook,
    //     and Windows prints `'foo.bat' is not recognized`. The script's work
    //     (OGG→WAV decoding, TIZ→TIS tileset extraction) never happens.
    //
    //     This step audits every mod's tp2 for AT_INTERACTIVE_EXIT → script,
    //     resolves the referenced path against the mod's source tree, and
    //     copies missing scripts into the game dir so the hook can find them.
    //     See patches/install_config.json comments; supersedes patch #63
    //     (impasylum-specific copy) by handling all 9+ mods with this pattern
    //     (fade, alassa, yoshimoromance, bone hill, darkest day, sheena,
    //     varshoon, return to tradesmeet, imnesvale's sibling case, etc.).
    let at_exit_staging = ensure_at_interactive_exit_scripts(
        &config.mod_directory, game_dir, &batches, logger,
    );
    if at_exit_staging.copied > 0 || at_exit_staging.failed > 0 {
        let _ = app.emit("install:stdout", format!(
            "[Infinity Mod Runner] Staged {} AT_ hook script(s) into game dir{}",
            at_exit_staging.copied,
            if at_exit_staging.failed > 0 {
                format!(" ({} failed — see install.log [AT_EXIT_HOOK])", at_exit_staging.failed)
            } else { String::new() },
        ));
    }

    // 3e. ds.tph STATS.IDS-cleanup injection. Any mod shipping the SFO2e/DS
    //     helper library contains a `ds.tph` that calls `ds_sort_ids` on
    //     STATS.IDS. The sort routine has a well-known bug: when fed a
    //     headerless IDS, it emits spurious "N M" duplicate entries and can
    //     leave stale null bytes at the old header position. Across a
    //     megainstall, 10+ copies of ds.tph run independently, each corrupting
    //     STATS.IDS further. v1.0.2 added manual per-mod manifest patches for
    //     6 of the 22 ds.tph copies; this step generalizes that to all mods
    //     with the shared call site. Observed v1.0.3 Test #41: STATS.IDS in
    //     override/ had embedded nulls + 40+ duplicate-index entries despite
    //     6-mod patching. Auto-patching all 15 call sites eliminates the class.
    {
        let ds = ensure_ds_ids_cleanup_all(game_dir, &batches, logger);
        if ds.0 > 0 {
            let _ = app.emit("install:stdout", format!(
                "[Infinity Mod Runner] Injected ds_sort_ids cleanup into {} ds.tph file(s){}",
                ds.0,
                if ds.1 > 0 {
                    format!(" ({} already marked, skipped)", ds.1)
                } else { String::new() },
            ));
        }
    }

    // Track mod index for pause points
    let mut current_mod_index = 0usize;

    // Track mods where ALL components failed (exit code 2) — skip subsequent batches for the same mod
    let mut failed_mods: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Mid-install BIFF optimization: fires once before the first SFO-heavy
    // mod runs. Compresses override/ into a .bif via a temporary WeiDU TP2
    // so that subsequent COPY_EXISTING_REGEXP iterations scan near-zero
    // files instead of 10K+. IDS files are excluded (moved aside during
    // biff, restored after) to avoid breaking eet_end's IDS parsing.
    let mut prebiff_done = false;
    let sfo_heavy: std::collections::HashSet<&str> = ["dw_talents", "stratagems", "mih_tweaks"]
        .iter().cloned().collect();

    // Track TLK size to avoid redundant backups (only backup when TLK changes)
    let mut last_tlk_size: u64 = {
        let tlk_paths = [
            game_dir.join("lang").join(&config.language).join("dialog.tlk"),
            game_dir.join("lang").join("en_US").join("dialog.tlk"),
            game_dir.join("dialog.tlk"),
        ];
        tlk_paths.iter().find_map(|p| std::fs::metadata(p).ok().map(|m| m.len())).unwrap_or(0)
    };
    let mut last_mod_name = String::new();

    // BCS corruption tracking across the entire phase
    let mut bcs_corruptions: Vec<(String, super::debug_mgr::BcsCorruption)> = Vec::new();

    // 3c. TLK acceleration — pre-warm page cache and optionally redirect to fast drive
    let mut tlk_accel = TlkAccelerator::new(
        game_dir, &config.language,
        config.tlk_prewarm,
        config.tlk_fast_drive,
        config.tlk_fast_drive_path.as_deref(),
    );
    if let Err(e) = tlk_accel.setup(app) {
        let _ = app.emit("install:stdout",
            format!("[Infinity Mod Runner] WARNING: TLK acceleration setup failed: {e}"));
    }

    // 3d. Override acceleration — redirect game/override to fast drive (opt-in).
    //     Setup is expensive (copies override/ to fast storage, minutes for big
    //     installs) but pays off across thousands of subsequent iterations.
    //     Teardown copies everything back at the end.
    let mut override_accel = OverrideAccelerator::new(
        game_dir,
        config.override_fast_drive,
        config.override_fast_drive_path.as_deref(),
    );
    if let Err(e) = override_accel.setup(app) {
        let _ = app.emit("install:stdout",
            format!("[Infinity Mod Runner] WARNING: Override fast-drive setup failed (continuing without): {e}"));
    }

    // 4. For each batch
    for (batch_idx, batch) in batches.iter().enumerate() {
        if state.abort_flag.load(Ordering::SeqCst) {
            break;
        }

        // Check for pause. Two paths reach this point:
        //   (a) User clicked "Pause" in the UI → install_pause() flipped the
        //       atomic, but no event was emitted. We fire install:pause here
        //       so the frontend can transition Pausing... → Paused, freeze
        //       the elapsed timer, and log a confirmation line.
        //   (b) Pre-configured PausePoint triggered below already emitted
        //       install:pause itself, so if we see paused=true here without
        //       first detecting a user request, it's the tail end of (b) —
        //       still correct to wait, just no duplicate event.
        //
        // We only emit the event once per pause so the log isn't spammed if
        // wait_if_paused is called multiple times in a row (e.g. abort
        // checks inside the loop).
        let was_paused = state.paused.load(Ordering::SeqCst);
        if was_paused {
            tracker.emit_pause("Paused — install will resume when you click Resume.");
            install_log::shared_log_event(&logger, "PAUSE",
                "user-requested pause reached at batch boundary");
        }
        wait_if_paused(state);
        if was_paused && !state.abort_flag.load(Ordering::SeqCst) {
            tracker.emit_resumed();
            install_log::shared_log_event(&logger, "PAUSE", "resumed");
        }

        // Track mod transitions for pause points
        if batch.mod_name != last_mod_name {
            // Check for pause point after the previous mod
            if !last_mod_name.is_empty() {
                if let Some(pp) = pause_points.iter()
                    .find(|p| p.after_mod_index == current_mod_index.saturating_sub(1))
                {
                    tracker.emit_pause(&pp.message);
                    state.paused.store(true, Ordering::SeqCst);
                    wait_if_paused(state);
                    if !state.abort_flag.load(Ordering::SeqCst) {
                        tracker.emit_resumed();
                    }
                }
            }
            last_mod_name = batch.mod_name.clone();
            current_mod_index += 1;
        }

        // Mid-install BIFF: trigger once when we first hit an SFO-heavy mod.
        // Only fires if override has 5000+ files (otherwise not worth the biff time).
        //
        // Diagnostic logging: unconditional install_log entry on every batch
        // so we can see whether the BIFF check is being reached and what
        // values it sees. Without this, failures are silent.
        if !prebiff_done {
            let mod_key = batch.mod_name.to_lowercase();
            let is_sfo = sfo_heavy.contains(mod_key.as_str());
            // Log once per unique mod name we consider — not every batch
            // (would spam the log). This gives us a record of "did we see
            // dw_talents/stratagems/mih_tweaks and correctly classify it?"
            if batch.mod_name != last_mod_name || batch_idx == 0 {
                install_log::shared_log_event(logger, "PREBIFF_CHECK",
                    &format!("batch_idx={} mod='{}' is_sfo={} prebiff_done={}",
                        batch_idx, batch.mod_name, is_sfo, prebiff_done));
            }
            if is_sfo {
                prebiff_done = true;
                let override_dir = game_dir.join("override");
                let file_count = std::fs::read_dir(&override_dir)
                    .map(|rd| rd.filter_map(|e| e.ok()).count())
                    .unwrap_or(0);
                // Always emit the entry signal — so users and auditors can
                // see the BIFF step was actually reached (previous silent
                // skip made it ambiguous whether the code fired at all).
                let _ = app.emit("install:stdout",
                    format!("[Infinity Mod Runner] \u{2699} BIFF check reached for '{}' — override has {} files", batch.mod_name, file_count));
                install_log::shared_log_event(logger, "PREBIFF",
                    &format!("Reached for mod='{}' override_files={}", batch.mod_name, file_count));
                if file_count >= 5000 {
                    let _ = app.emit("install:stdout",
                        format!("[Infinity Mod Runner] \u{2699} Optimizing override/ ({} files) before SFO-heavy mods...", file_count));
                    install_log::shared_log_event(logger, "PREBIFF",
                        &format!("Starting: {} override files before first SFO mod '{}'", file_count, batch.mod_name));
                    match run_prebiff_optimization(game_dir, config, logger) {
                        Ok(biffed) => {
                            let _ = app.emit("install:stdout",
                                format!("[Infinity Mod Runner] \u{2713} Biffed {} files — SFO mods will run faster", biffed));
                            install_log::shared_log_event(logger, "PREBIFF",
                                &format!("Complete: biffed {} files", biffed));
                        }
                        Err(e) => {
                            let _ = app.emit("install:stdout",
                                format!("[Infinity Mod Runner] \u{26A0} Pre-biff optimization failed (continuing without): {}", e));
                            install_log::shared_log_event(logger, "PREBIFF",
                                &format!("Failed (non-fatal): {}", e));
                        }
                    }
                } else {
                    let _ = app.emit("install:stdout",
                        format!("[Infinity Mod Runner] \u{26A0} BIFF skipped: only {} override files (threshold 5000)", file_count));
                    install_log::shared_log_event(logger, "PREBIFF",
                        &format!("Skipped: only {} override files (threshold 5000)", file_count));
                }
            }
        }

        // Pre-skip: if this mod already had a total failure, skip without running WeiDU
        if failed_mods.contains(&batch.mod_name.to_lowercase()) {
            let skipped: Vec<ComponentResult> = batch.components.iter().map(|c| {
                ComponentResult {
                    mod_name: c.mod_name.clone(),
                    component: c.component,
                    component_name: c.component_name.clone(),
                    status: ComponentStatus::Skipped,
                    message: Some("Pre-skipped: earlier batch for this mod failed completely".to_string()),
                    warnings: Vec::new(),
                }
            }).collect();
            let _ = app.emit("install:stdout",
                format!("[Infinity Mod Runner] Pre-skipping {} components in '{}' (earlier batch failed)",
                    skipped.len(), batch.mod_name));
            install_log::shared_log_event(logger, "PRE_SKIP",
                &format!("'{}': {} components (earlier batch failed)", batch.mod_name, skipped.len()));
            tracker.record_results(&skipped);
            // Emit batch_done so the frontend progress counter and Issues
            // panel see these pre-skipped components. Without this, the
            // counter drifts: summary is correct (record_results incremented
            // the tracker) but the frontend's `completedCompsRef` never
            // gets the batch_done event, causing the progress bar to show
            // <100% at "Completed" and the Issues panel to miss the skips.
            tracker.emit_batch_done(batch_idx, &skipped);
            continue;
        }

        // Write checkpoint for crash recovery
        write_checkpoint(data_dir, batch_idx, &batch.mod_name, phase_name, total_batches);

        // Emit batch start
        let comp_names: Vec<String> = batch.components.iter()
            .map(|c| format!("{}#{}", c.component_name, c.component))
            .collect();
        install_log::shared_log_event(logger, "BATCH_START",
            &format!("{}/{} '{}' ({} components)", batch_idx + 1, total_batches, batch.mod_name, batch.components.len()));
        // If any component in this batch is in the known-slow list, propagate
        // the first match's explanation to the frontend so the Slow Batch UI
        // can show a targeted message ("do not abort — this is expected") in
        // place of the generic timeout warning.
        let mod_lower = batch.mod_name.to_lowercase();
        let known_slow: Option<&'static str> = batch.components.iter()
            .find_map(|c| super::known_slow_reason(&mod_lower, c.component));
        tracker.emit_batch_start_with_hints(
            batch_idx, total_batches, &batch.mod_name, &comp_names, known_slow,
        );

        // file_guard pre-batch snapshot: capture current state of override/ before WeiDU runs.
        // Lets post_batch detect what THIS batch newly wrote/modified.
        super::file_guard::pre_batch(game_dir);

        // 4a. Locate mod folder and copy to game dir
        let mod_folder = find_mod_folder(&config.mod_directory, &batch.mod_name, &batch.tp_file, 5);
        if let Some(src) = &mod_folder {
            let dest = game_dir.join(&batch.mod_name);
            if let Err(e) = copy_mod_to_game(src, &dest) {
                let _ = app.emit("install:stdout",
                    format!("[Infinity Mod Runner] WARNING: Failed to copy {}: {e}", batch.mod_name));
            }
            // Pause for filesystem sync (only needed for network drives — default 0ms)
            if config.post_copy_delay_ms > 0 {
                std::thread::sleep(std::time::Duration::from_millis(config.post_copy_delay_ms));
            }
        } else {
            // Mod not found in extracted directory — check if already in game dir
            let in_game = game_dir.join(&batch.mod_name).is_dir();
            if !in_game {
                let _ = app.emit("install:stdout",
                    format!("[Infinity Mod Runner] WARNING: Mod '{}' not found in mod directory or game directory", batch.mod_name));
            }
        }

        // 4b. Backup DEBUG, TLK, watched files
        backup_debug(game_dir, &batch.mod_name);
        // Only backup TLK if it changed since last backup (saves ~80GB of I/O over 400 batches)
        {
            let current_tlk_size = {
                let tlk_paths = [
                    game_dir.join("lang").join(&config.language).join("dialog.tlk"),
                    game_dir.join("lang").join("en_US").join("dialog.tlk"),
                    game_dir.join("dialog.tlk"),
                ];
                tlk_paths.iter().find_map(|p| std::fs::metadata(p).ok().map(|m| m.len())).unwrap_or(0)
            };
            if current_tlk_size != last_tlk_size {
                backup_tlk(game_dir, data_dir, &config.language, 10);
                last_tlk_size = current_tlk_size;
            }
        }
        // Only backup watched files if they exist (most mods don't touch IDS/BCS)
        let watched_backups = if batch_idx % 5 == 0 || batch.components.len() > 3 {
            // Full backup every 5th batch + large batches (likely heavy mods)
            backup_watched_files(game_dir, data_dir, &batch.mod_name, &WATCHED_FILES)
        } else {
            Vec::new()
        };

        // 4b½. BCS corruption scanner — snapshot before WeiDU runs.
        // Opt-in via config.bcs_scanner (debug installs only — reads all override BCS files).
        // When enabled, only scans on mods known to bulk-process BCS files,
        // or every 10th batch as a safety net.
        let bcs_scan_this_batch = config.bcs_scanner && (matches!(
            batch.mod_name.to_lowercase().as_str(),
            "dw_talents" | "stratagems" | "cdtweaks" | "iwdification"
            | "spell_rev" | "mih_metamod" | "mih_eq" | "mih_fr"
        ) || batch_idx % 10 == 0);

        let (bcs_snapshot, bcs_backup_data) = if bcs_scan_this_batch {
            let snapshot = super::debug_mgr::BcsSnapshot::capture(game_dir);
            let data = snapshot.read_backup_data();
            (Some(snapshot), data)
        } else {
            (None, std::collections::HashMap::new())
        };

        // 4c. Run WeiDU
        //
        // Wrap the WeiDU call in an in-flight snapshot guard. A background
        // thread copies WSETUP.DEBUG to `data_dir/debug_logs/` every
        // DEFAULT_INTERVAL_SECS (5 min) while WeiDU runs. If the user
        // force-closes the runner mid-batch (as happened on install #21's
        // dw_talents batch 384 stall) we still have the last <5 min of
        // WeiDU debug output on disk — no amount of orchestrator
        // post-processing can help if the process itself dies.
        //
        // The guard stays alive for the rest of this loop iteration so we
        // can call `cleanup_inflight()` on clean-success paths; the thread
        // stops automatically when the guard drops at the end of the
        // iteration.
        let snapshot_guard = super::debug_snapshot::SnapshotGuard::start(
            game_dir.to_path_buf(),
            data_dir.to_path_buf(),
            batch.mod_name.clone(),
            logger.clone(),
            super::debug_snapshot::DEFAULT_INTERVAL_SECS,
        );
        let batch_result = run_batch(app, batch, config, game_dir, &state.abort_flag, logger);

        // 4d. Restore DEBUG, check watched files (only if we backed them up), check TLK
        restore_debug(game_dir, &batch.mod_name);
        let restored_files = if !watched_backups.is_empty() {
            check_and_restore_watched_files(game_dir, &watched_backups)
        } else {
            Vec::new()
        };
        if !restored_files.is_empty() {
            let _ = app.emit("install:stdout",
                format!("[Infinity Mod Runner] Restored corrupted files: {}", restored_files.join(", ")));
        }
        if let Err(e) = check_tlk_integrity(game_dir, &config.language) {
            let _ = app.emit("install:stdout",
                format!("[Infinity Mod Runner] WARNING: dialog.tlk integrity issue: {e}"));
        }

        // 4d½. BCS corruption detection — compare snapshot, restore, report
        if let Some(snapshot) = &bcs_snapshot {
            let corruptions = snapshot.detect_corruptions(game_dir, &bcs_backup_data);
            if !corruptions.is_empty() {
                let restored_count = corruptions.iter().filter(|c| c.restored).count();
                let total = corruptions.len();
                let _ = app.emit("install:stdout", format!(
                    "[Infinity Mod Runner] BCS CORRUPTION DETECTED: {} files corrupted by '{}' batch #{} ({} auto-restored)",
                    total, batch.mod_name, batch_idx, restored_count
                ));
                for c in &corruptions {
                    let status = if c.restored { "RESTORED" } else { "NOT RESTORED" };
                    let _ = app.emit("install:stdout", format!(
                        "[Infinity Mod Runner]   {} {} → {} bytes [{}]",
                        c.filename, c.size_before, c.size_after, status
                    ));
                }
                // Accumulate for the final report
                for c in corruptions {
                    bcs_corruptions.push((batch.mod_name.clone(), c));
                }
            }
        }

        // TLK acceleration: periodic sync + cache re-warm
        tlk_accel.periodic_sync(app, batch_idx);

        // 4e. Handle results
        match batch_result {
            Ok(results) => {
                // Detect segfault (0xc0000005 / SIGSEGV) — identify problematic BCS and retry
                let is_segfault = results.iter().any(|r| {
                    r.message.as_deref().map_or(false, |m| m.contains("0xc0000005") || m.contains("signal 11"))
                });
                if is_segfault {
                    let _ = app.emit("install:stdout",
                        format!("[Infinity Mod Runner] Segfault detected in batch for '{}' — attempting recovery", batch.mod_name));

                    // Step 1: Identify problematic BCS files from DEBUG log
                    let crash_bcs = super::debug_mgr::identify_crash_bcs(game_dir, &batch.mod_name);
                    if !crash_bcs.is_empty() {
                        for bcs in &crash_bcs {
                            let name = bcs.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                            let _ = app.emit("install:stdout",
                                format!("[Infinity Mod Runner] Replacing corrupt {} with empty BCS to allow install to continue", name));
                            let _ = super::debug_mgr::replace_with_empty_bcs(bcs);
                        }
                    }

                    // Step 2: Also clean IDS files (duplicate entries cause BCS round-trip failures)
                    let watched_restore = check_and_restore_watched_files(game_dir, &watched_backups);
                    if !watched_restore.is_empty() {
                        let _ = app.emit("install:stdout",
                            format!("[Infinity Mod Runner] Restored corrupted: {}", watched_restore.join(", ")));
                    }

                    // Step 3: Retry — if batch was >1, retry one at a time; else just retry the single component
                    if batch.components.len() > 1 {
                        let _ = app.emit("install:stdout",
                            format!("[Infinity Mod Runner] Retrying {} components one at a time", batch.components.len()));
                        // Parse weidu.log once for all checks in this retry loop
                        let installed_set = super::log_diff::installed_set_from_game(game_dir);
                        for comp in &batch.components {
                            if state.abort_flag.load(Ordering::SeqCst) { break; }
                            if super::log_diff::is_in_installed_set(&installed_set, &comp.tp_file, comp.component) {
                                tracker.record_results(&[ComponentResult {
                                    mod_name: comp.mod_name.clone(),
                                    component: comp.component,
                                    component_name: comp.component_name.clone(),
                                    status: ComponentStatus::Success,
                                    message: Some("Installed before segfault".to_string()),
                                    warnings: Vec::new(),
                                }]);
                                continue;
                            }
                            let single_batch = super::Batch {
                                mod_name: batch.mod_name.clone(),
                                tp_file: batch.tp_file.clone(),
                                lang: batch.lang,
                                components: vec![comp.clone()],
                                batch_index: batch_idx,
                            };
                            backup_debug(game_dir, &batch.mod_name);
                            backup_tlk(game_dir, data_dir, &config.language, 10);
                            let single_result = run_batch(app, &single_batch, config, game_dir, &state.abort_flag, logger);
                            restore_debug(game_dir, &batch.mod_name);

                            if let Ok(sr) = single_result {
                                // If this single retry also segfaults, try BCS fix again
                                let sr_segfault = sr.iter().any(|r| {
                                    r.message.as_deref().map_or(false, |m| m.contains("0xc0000005") || m.contains("signal 11"))
                                });
                                if sr_segfault {
                                    let more_bcs = super::debug_mgr::identify_crash_bcs(game_dir, &batch.mod_name);
                                    for bcs in &more_bcs {
                                        let _ = super::debug_mgr::replace_with_empty_bcs(bcs);
                                    }
                                    // One more try after fixing
                                    backup_debug(game_dir, &batch.mod_name);
                                    let final_result = run_batch(app, &single_batch, config, game_dir, &state.abort_flag, logger);
                                    restore_debug(game_dir, &batch.mod_name);
                                    if let Ok(fr) = final_result {
                                        let refined = refine_results_from_log(game_dir, &single_batch.components, &fr);
                                        tracker.record_results(&refined);
                                    } else {
                                        tracker.record_results(&[ComponentResult {
                                            mod_name: comp.mod_name.clone(), component: comp.component,
                                            component_name: comp.component_name.clone(),
                                            status: ComponentStatus::Error,
                                            message: Some("Failed after BCS fix attempt".to_string()),
                                            warnings: Vec::new(),
                                        }]);
                                    }
                                } else {
                                    let refined = refine_results_from_log(game_dir, &single_batch.components, &sr);
                                    tracker.record_results(&refined);
                                }
                            } else {
                                tracker.record_results(&[ComponentResult {
                                    mod_name: comp.mod_name.clone(), component: comp.component,
                                    component_name: comp.component_name.clone(),
                                    status: ComponentStatus::Error,
                                    message: Some("Failed even as single component".to_string()),
                                    warnings: Vec::new(),
                                }]);
                            }
                        }
                    } else {
                        // Single component batch — retry once after BCS fix
                        let comp = &batch.components[0];
                        if !is_component_installed(game_dir, &comp.tp_file, comp.component) {
                            backup_debug(game_dir, &batch.mod_name);
                            backup_tlk(game_dir, data_dir, &config.language, 10);
                            let retry_result = run_batch(app, batch, config, game_dir, &state.abort_flag, logger);
                            restore_debug(game_dir, &batch.mod_name);
                            if let Ok(rr) = retry_result {
                                let refined = refine_results_from_log(game_dir, &batch.components, &rr);
                                tracker.record_results(&refined);
                            } else {
                                tracker.record_results(&[ComponentResult {
                                    mod_name: comp.mod_name.clone(), component: comp.component,
                                    component_name: comp.component_name.clone(),
                                    status: ComponentStatus::Error,
                                    message: Some("Failed after BCS fix".to_string()),
                                    warnings: Vec::new(),
                                }]);
                            }
                        } else {
                            tracker.record_results(&[ComponentResult {
                                mod_name: comp.mod_name.clone(), component: comp.component,
                                component_name: comp.component_name.clone(),
                                status: ComponentStatus::Warning,
                                message: Some("Installed despite segfault".to_string()),
                                warnings: Vec::new(),
                            }]);
                        }
                    }
                    continue; // Skip normal error handling
                }

                let has_errors = results.iter().any(|r| r.status == ComponentStatus::Error);

                if has_errors {
                    // Immediately preserve debug files before retry/next batch overwrites them
                    let _ = preserve_error_debug_files(game_dir, &data_dir, &batch.mod_name, logger);

                    // Check weidu.log to see which actually installed
                    let refined = refine_results_from_log(game_dir, &batch.components, &results);

                    let succeeded: Vec<ComponentResult> = refined.iter()
                        .filter(|r| r.status != ComponentStatus::Error)
                        .cloned()
                        .collect();
                    let still_failed: Vec<ComponentResult> = refined.iter()
                        .filter(|r| r.status == ComponentStatus::Error)
                        .cloned()
                        .collect();

                    // Record succeeded components immediately so progress reflects them.
                    tracker.record_results(&succeeded);

                    // If ALL components failed, mark this mod for pre-skipping subsequent batches
                    if succeeded.is_empty() && !still_failed.is_empty() {
                        failed_mods.insert(batch.mod_name.to_lowercase());
                    }

                    // `final_results` accumulates every component's POST-retry/POST-decision
                    // status. We emit a single batch_done with this vec at the end of the
                    // block — never mid-retry. This keeps the frontend's per-batch log line
                    // in sync with the tracker's summary counters.
                    //
                    // Previously, emit_batch_done fired BEFORE retry, so a batch that had 3
                    // errors reclassified-to-skipped via auto_skip_after_retry showed up as
                    // "0 ok, 3 err" in the gui.log but "0 err, 3 skip" in the final summary
                    // — a confusing discrepancy for anyone auditing the log.
                    let mut final_results: Vec<ComponentResult> = succeeded.clone();
                    let mut should_break = false;

                    if !still_failed.is_empty() {
                        let is_essential = ESSENTIAL_MODS.contains(&batch.mod_name.to_lowercase().as_str());
                        if is_essential {
                            // Record failures as Error, fire fatal event, abort.
                            tracker.record_results(&still_failed);
                            final_results.extend(still_failed.iter().cloned());
                            let _ = app.emit("install:stdout",
                                format!("[Infinity Mod Runner] FATAL: Essential mod '{}' failed. Aborting.", batch.mod_name));
                            // Structured event so the frontend can write a distinct
                            // gui.log line and tag the "aborted" summary with the
                            // real cause. Payload is the lowercased tp2 mod name.
                            let _ = app.emit("install:fatal", serde_json::json!({
                                "mod_name": batch.mod_name.to_lowercase(),
                                "reason": "essential_mod_failed",
                            }));
                            state.abort_flag.store(true, Ordering::SeqCst);
                            should_break = true;
                        } else {
                            let error_msg = still_failed.iter()
                                .map(|r| format!("#{}: {}", r.component, r.message.as_deref().unwrap_or("failed")))
                                .collect::<Vec<_>>()
                                .join("; ");

                            if config.auto_skip_after_retry {
                                // Don't emit batch_error (which triggers the GUI dialog) —
                                // just log it and handle automatically
                                let _ = app.emit("install:stdout",
                                    format!("[Infinity Mod Runner] Batch error in '{}': {}", batch.mod_name, error_msg));
                                // Auto mode: retry once, then skip remaining failures
                                let retry_set = super::log_diff::installed_set_from_game(game_dir);
                                let failed_comps: Vec<Component> = batch.components.iter()
                                    .filter(|c| !super::log_diff::is_in_installed_set(&retry_set, &c.tp_file, c.component))
                                    .cloned()
                                    .collect();
                                if !failed_comps.is_empty() {
                                    let _ = app.emit("install:stdout",
                                        format!("[Infinity Mod Runner] Auto-retry: {} failed components in '{}'", failed_comps.len(), batch.mod_name));
                                    install_log::shared_log_event(logger, "AUTO_RETRY",
                                        &format!("'{}': {} components", batch.mod_name, failed_comps.len()));
                                    let retry_batch = super::Batch {
                                        mod_name: batch.mod_name.clone(),
                                        tp_file: batch.tp_file.clone(),
                                        lang: batch.lang,
                                        components: failed_comps,
                                        batch_index: batch_idx,
                                    };
                                    backup_debug(game_dir, &batch.mod_name);
                                    let retry_result = run_batch(app, &retry_batch, config, game_dir, &state.abort_flag, logger);
                                    restore_debug(game_dir, &batch.mod_name);
                                    if let Ok(retry_results) = retry_result {
                                        let refined_retry = refine_results_from_log(game_dir, &retry_batch.components, &retry_results);
                                        // Detect abort-cancellation so downstream can distinguish
                                        // abort-induced skips from retry-exhausted skips.
                                        let aborted_now = state.abort_flag.load(Ordering::SeqCst);
                                        let retry_failed: Vec<ComponentResult> = refined_retry.iter()
                                            .filter(|r| r.status == ComponentStatus::Error)
                                            .map(|r| ComponentResult {
                                                status: ComponentStatus::Skipped,
                                                message: if aborted_now {
                                                    Some("Cancelled: install aborted".to_string())
                                                } else {
                                                    r.message.clone()
                                                },
                                                ..r.clone()
                                            })
                                            .collect();
                                        let retry_ok: Vec<ComponentResult> = refined_retry.iter()
                                            .filter(|r| r.status != ComponentStatus::Error)
                                            .cloned()
                                            .collect();
                                        if !retry_failed.is_empty() {
                                            let _ = app.emit("install:stdout",
                                                format!("[Infinity Mod Runner] Auto-skip: {} still failed after retry in '{}'",
                                                    retry_failed.len(), batch.mod_name));
                                            install_log::shared_log_event(logger, "AUTO_SKIP",
                                                &format!("'{}': {} components skipped after retry", batch.mod_name, retry_failed.len()));
                                        }
                                        tracker.record_results(&retry_ok);
                                        tracker.record_results(&retry_failed);
                                        final_results.extend(retry_ok);
                                        final_results.extend(retry_failed);
                                    } else {
                                        // Retry itself failed to start (usually abort_flag set) —
                                        // skip all failures, tagging as cancelled when aborted.
                                        let aborted_now = state.abort_flag.load(Ordering::SeqCst);
                                        let skipped: Vec<ComponentResult> = still_failed.iter().map(|r| {
                                            ComponentResult {
                                                status: ComponentStatus::Skipped,
                                                message: if aborted_now {
                                                    Some("Cancelled: install aborted".to_string())
                                                } else {
                                                    r.message.clone()
                                                },
                                                ..r.clone()
                                            }
                                        }).collect();
                                        tracker.record_results(&skipped);
                                        final_results.extend(skipped);
                                    }
                                } else {
                                    tracker.record_results(&still_failed);
                                    final_results.extend(still_failed.iter().cloned());
                                }
                            } else if !config.never_abort {
                                // Show error dialog to user (only in manual mode)
                                tracker.emit_batch_error(batch_idx, &batch.mod_name, &error_msg, true);
                                let decision = wait_for_decision(state);
                                match decision {
                                    ErrorDecision::Retry => {
                                        let retry_set = super::log_diff::installed_set_from_game(game_dir);
                                        let failed_comps: Vec<Component> = batch.components.iter()
                                            .filter(|c| !super::log_diff::is_in_installed_set(&retry_set, &c.tp_file, c.component))
                                            .cloned()
                                            .collect();
                                        if !failed_comps.is_empty() {
                                            let retry_batch = super::Batch {
                                                mod_name: batch.mod_name.clone(),
                                                tp_file: batch.tp_file.clone(),
                                                lang: batch.lang,
                                                components: failed_comps,
                                                batch_index: batch_idx,
                                            };
                                            let retry_result = run_batch(app, &retry_batch, config, game_dir, &state.abort_flag, logger);
                                            if let Ok(retry_results) = retry_result {
                                                let refined_retry = refine_results_from_log(game_dir, &retry_batch.components, &retry_results);
                                                tracker.record_results(&refined_retry);
                                                final_results.extend(refined_retry);
                                            } else {
                                                // Retry couldn't run (abort?) — keep originals as errors
                                                tracker.record_results(&still_failed);
                                                final_results.extend(still_failed.iter().cloned());
                                            }
                                        } else {
                                            // All components installed on retry check
                                            tracker.record_results(&still_failed);
                                            final_results.extend(still_failed.iter().cloned());
                                        }
                                    }
                                    ErrorDecision::Skip => {
                                        // Record failures as skipped
                                        let skipped: Vec<ComponentResult> = still_failed.iter().map(|r| {
                                            ComponentResult { status: ComponentStatus::Skipped, ..r.clone() }
                                        }).collect();
                                        tracker.record_results(&skipped);
                                        final_results.extend(skipped);
                                        let _ = app.emit("install:stdout",
                                            format!("[Infinity Mod Runner] Skipping failed components in '{}'", batch.mod_name));
                                    }
                                    ErrorDecision::Stop => {
                                        tracker.record_results(&still_failed);
                                        final_results.extend(still_failed.iter().cloned());
                                        state.abort_flag.store(true, Ordering::SeqCst);
                                        should_break = true;
                                    }
                                }
                            } else {
                                // never_abort mode — record failures and continue
                                tracker.record_results(&still_failed);
                                final_results.extend(still_failed.iter().cloned());
                            }
                        }
                    }

                    // Single batch_done event with the POST-retry/POST-decision state.
                    // Ordering matters: must come AFTER all record_results calls in this
                    // block so the emitted results match the tracker's internal counters.
                    tracker.emit_batch_done(batch_idx, &final_results);
                    // file_guard post-batch: detect cross-mod silent corruption, restore or pause per setting.
                    let pause_events = super::file_guard::post_batch(
                        game_dir, batch_idx, &batch.mod_name, config.pause_on_guard, logger);
                    for ev in &pause_events {
                        let _ = app.emit("install:guard-event-pause", ev);
                    }

                    if should_break { break; }
                } else {
                    // WeiDU exited 0 but that doesn't guarantee every component installed —
                    // a single `NOT INSTALLED DUE TO ERRORS <cn>` inside a multi-component
                    // batch still exits 0. Reconcile against weidu.log to catch silent skips.
                    let refined = refine_results_from_log(game_dir, &batch.components, &results);
                    let silent_skips: Vec<&ComponentResult> = refined.iter()
                        .filter(|r| r.status == ComponentStatus::Skipped)
                        .collect();
                    // Preservation policy for the "WeiDU exited 0" branch:
                    //   a) silent skips (component missing from weidu.log) — always preserve
                    //   b) any Warning component (WITH_WARNINGS in WeiDU output) — also
                    //      preserve. Pre-#22: warnings were logged but produced no preserved
                    //      debug file, so diagnosing e.g. "0 ok, 1 warn" mods like darian was
                    //      impossible after the fact. Since warnings are sparse (~19 batches
                    //      in #21's 465-batch run), the disk cost is minimal and the
                    //      diagnostic value is high.
                    let has_warnings = refined.iter()
                        .any(|r| r.status == ComponentStatus::Warning);
                    if !silent_skips.is_empty() || has_warnings {
                        let _ = preserve_error_debug_files(game_dir, &data_dir, &batch.mod_name, logger);
                    } else {
                        // Clean success — drop any in-flight snapshot files
                        // from this batch so the preserved-debug listing only
                        // reflects batches that actually had issues.
                        snapshot_guard.cleanup_inflight();
                    }
                    if !silent_skips.is_empty() {
                        for r in &silent_skips {
                            let msg = format!("batch {} '{}' cn:{} '{}' — WeiDU exited 0 but not in weidu.log",
                                batch_idx, batch.mod_name, r.component, r.component_name);
                            install_log::shared_log_event(logger, "SILENT_SKIP", &msg);
                            let _ = app.emit("install:stdout",
                                format!("[Infinity Mod Runner] SILENT_SKIP: {} cn:{} '{}'",
                                    batch.mod_name, r.component, r.component_name));
                        }
                    }
                    tracker.record_results(&refined);
                    tracker.emit_batch_done(batch_idx, &refined);
                    // file_guard post-batch: detect cross-mod silent corruption, restore or pause per setting.
                    let pause_events = super::file_guard::post_batch(
                        game_dir, batch_idx, &batch.mod_name, config.pause_on_guard, logger);
                    for ev in &pause_events {
                        let _ = app.emit("install:guard-event-pause", ev);
                    }
                }
            }
            Err(e) => {
                // Fatal error (couldn't even start WeiDU)
                let _ = preserve_error_debug_files(game_dir, &data_dir, &batch.mod_name, logger);
                let _ = app.emit("install:stdout",
                    format!("[Infinity Mod Runner] ERROR: {e}"));
                let error_results: Vec<ComponentResult> = batch.components.iter().map(|c| {
                    ComponentResult {
                        mod_name: c.mod_name.clone(),
                        component: c.component,
                        component_name: c.component_name.clone(),
                        status: ComponentStatus::Error,
                        message: Some(e.clone()),
                        warnings: Vec::new(),
                    }
                }).collect();
                tracker.record_results(&error_results);
                tracker.emit_batch_error(batch_idx, &batch.mod_name, &e, false);

                // Distinguish a user-triggered abort from a real WeiDU
                // spawn failure. When abort_flag is set, WeiDU was never
                // launched because the orchestrator saw the signal — "WeiDU
                // failed to start" is misleading. Emit ABORT_SKIP with the
                // real reason so the transcript is self-explaining.
                let user_aborted = state.abort_flag.load(Ordering::SeqCst);
                if user_aborted {
                    install_log::shared_log_event(logger, "ABORT_SKIP",
                        &format!("'{}': user aborted before WeiDU launched", batch.mod_name));
                    break;
                }
                if config.auto_skip_after_retry || config.never_abort {
                    // Auto-skip or never_abort: log and continue
                    install_log::shared_log_event(logger, "FATAL_SKIP",
                        &format!("'{}': WeiDU failed to start, skipping batch", batch.mod_name));
                } else {
                    state.abort_flag.store(true, Ordering::SeqCst);
                    break;
                }
            }
        }
    }

    // End-of-phase BCS corruption report
    if config.bcs_scanner && !bcs_corruptions.is_empty() {
        let _ = app.emit("install:stdout", format!(
            "\n[Infinity Mod Runner] ═══ BCS Corruption Report ({} phase) ═══",
            phase_name
        ));
        let _ = app.emit("install:stdout", format!(
            "[Infinity Mod Runner] {} BCS files were corrupted during this install:",
            bcs_corruptions.len()
        ));

        // Group by culprit mod
        let mut by_mod: std::collections::BTreeMap<String, Vec<&super::debug_mgr::BcsCorruption>> =
            std::collections::BTreeMap::new();
        for (mod_name, corruption) in &bcs_corruptions {
            by_mod.entry(mod_name.clone()).or_default().push(corruption);
        }
        for (mod_name, corruptions) in &by_mod {
            let _ = app.emit("install:stdout", format!(
                "[Infinity Mod Runner]   {} — {} files:", mod_name, corruptions.len()
            ));
            for c in corruptions {
                let status = if c.restored { "auto-restored" } else { "NOT restored" };
                let _ = app.emit("install:stdout", format!(
                    "[Infinity Mod Runner]     {} ({} → {} bytes) [{}]",
                    c.filename, c.size_before, c.size_after, status
                ));
            }
        }
        let _ = app.emit("install:stdout",
            "[Infinity Mod Runner] Use this report to create targeted patches for these mods.".to_string());
        let _ = app.emit("install:stdout",
            "[Infinity Mod Runner] ═══════════════════════════════════════════".to_string());
    }

    // Teardown TLK acceleration
    if let Err(e) = tlk_accel.teardown(app) {
        let _ = app.emit("install:stdout",
            format!("[Infinity Mod Runner] WARNING: TLK acceleration teardown failed: {e}"));
    }

    // Teardown override acceleration (restore override/ from fast drive)
    if let Err(e) = override_accel.teardown(app) {
        let _ = app.emit("install:stdout",
            format!("[Infinity Mod Runner] WARNING: Override fast-drive teardown failed: {e}"));
    }

    // AT_ hook staged-script cleanup. Scripts we pre-staged for
    // AT_INTERACTIVE_EXIT/AT_EXIT/AT_NOW/etc. firing are cruft once the
    // phase's batch loop completes — WeiDU has had every chance to invoke
    // them. WeiDU's own scripts (asyinstall.bat, tisbiff.bat, etc.)
    // typically self-delete their companion binaries (oggdec.exe,
    // tisunpack.exe) but leave themselves behind. We remove them here so
    // the game dir stays clean across reinstalls. Missing files are fine
    // — WeiDU's own bat may have deleted the target already.
    let cleaned = cleanup_at_exit_staged_scripts(&at_exit_staging.staged_paths, logger);
    if cleaned > 0 {
        let _ = app.emit("install:stdout", format!(
            "[Infinity Mod Runner] Cleaned up {cleaned} AT_ hook staged script(s)"
        ));
    }

    Ok(())
}

/// Refine batch results by checking the game's weidu.log for actual install status.
/// Reconcile batch results against the actual weidu.log state:
///  - Error  BUT in weidu.log        → Warning  ("Installed with errors")
///  - Success BUT NOT in weidu.log   → Skipped  ("Silent skip: WeiDU reported OK but component not installed")
///
/// The second case catches components that silently failed inside a batch where
/// WeiDU still exited 0 — this happens when one mod's `BEGIN` block hits an
/// internal error (e.g. `NOT INSTALLED DUE TO ERRORS <component>`) but adjacent
/// components succeed. Without this check, the failing component appears as
/// Success in the UI and no AUTO_SKIP event fires.
///
/// Parses weidu.log once and checks all components against the parsed set.
///
/// NO_LOG_RECORD awareness: some WeiDU components legitimately don't write to
/// weidu.log (they declare `NO_LOG_RECORD` in the tp2). For those, absence from
/// weidu.log does NOT imply a silent skip. We scan each mod's tp2 once per call
/// and, if it contains `NO_LOG_RECORD`, we skip the Success→Skipped downgrade
/// for every component of that mod (conservative — full tp2 parsing to identify
/// the exact NO_LOG_RECORD components is more complex than worth).
fn refine_results_from_log(
    game_dir: &Path,
    components: &[Component],
    results: &[ComponentResult],
) -> Vec<ComponentResult> {
    // Parse once, check many
    let installed = parse_weidu_log(&super::log_diff::find_weidu_log(game_dir)).unwrap_or_default();
    let installed_set: std::collections::HashSet<(String, u32)> = installed.iter()
        .map(|c| (c.tp_file.to_lowercase(), c.component))
        .collect();

    // Cache NO_LOG_RECORD status per (mod_name, tp_file) so we don't re-read
    // the same tp2 for every component in the batch.
    let mut no_log_record_cache: std::collections::HashMap<(String, String), bool> =
        std::collections::HashMap::new();

    // Scan WSETUP.DEBUG once per call for WeiDU Sys_error — see
    // `wsetup_sys_error_detail` doc. Lazy so we don't read the file when
    // no Success→Skipped candidate needs it.
    let mut sys_error_cache: Option<Option<String>> = None;

    results.iter().zip(components).map(|(result, comp)| {
        let key = (comp.tp_file.to_lowercase(), comp.component);
        let in_log = installed_set.contains(&key);
        match result.status {
            ComponentStatus::Error if in_log => ComponentResult {
                status: ComponentStatus::Warning,
                message: Some("Installed with errors (found in weidu.log)".to_string()),
                ..result.clone()
            },
            ComponentStatus::Success if !in_log => {
                // Before flagging as silent skip, check if this mod uses NO_LOG_RECORD.
                let cache_key = (comp.mod_name.clone(), comp.tp_file.clone());
                let has_no_log = *no_log_record_cache.entry(cache_key).or_insert_with(|| {
                    tp2_has_no_log_record(game_dir, &comp.mod_name, &comp.tp_file)
                });
                if has_no_log {
                    // Legitimate silence — keep as Success (no downgrade).
                    return result.clone();
                }
                // Next: check if WeiDU fatal-errored at startup. When the tp2
                // file doesn't exist, WeiDU prints `FATAL ERROR: Sys_error(...)`
                // and exits — but still exits 0 on some paths, so the batch
                // looks successful even though nothing ran. Promote those
                // components from Skipped → Error so they surface in the UI
                // (and the preset/Forge catalog can be fixed). See Test #38
                // klatu: Forge catalog pointed to `klatu\klatu.tp2` but actual
                // file was `klatu\setup-klatu.tp2`, so all 11 batch components
                // silently skipped.
                let sys_err_detail: Option<String> = sys_error_cache
                    .get_or_insert_with(|| wsetup_sys_error_detail(game_dir))
                    .clone();
                if let Some(detail) = sys_err_detail {
                    ComponentResult {
                        status: ComponentStatus::Error,
                        message: Some(format!(
                            "WeiDU Sys_error — tp2 file not found or unreadable: {}",
                            detail
                        )),
                        ..result.clone()
                    }
                } else {
                    ComponentResult {
                        status: ComponentStatus::Skipped,
                        message: Some("Silent skip: WeiDU exited 0 but component not in weidu.log".to_string()),
                        ..result.clone()
                    }
                }
            },
            _ => result.clone(),
        }
    }).collect()
}

/// Read WSETUP.DEBUG (overwritten by each WeiDU invocation; still present when
/// this runs post-batch) and look for a `FATAL ERROR: Sys_error(...)` line.
/// Returns the captured detail (path + reason) if present — caller uses
/// `Some(detail)` as a signal to promote Success→Skipped reclassification to
/// Success→Error because WeiDU never actually ran the batch's components.
fn wsetup_sys_error_detail(game_dir: &Path) -> Option<String> {
    let path = game_dir.join("WSETUP.DEBUG");
    let bytes = std::fs::read(&path).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    for line in text.lines() {
        if let Some(pos) = line.find("FATAL ERROR: Sys_error(") {
            // Return the parenthesized detail for the Error message.
            let tail = &line[pos + "FATAL ERROR: Sys_error(".len()..];
            let detail = tail.trim_end_matches(')').trim().to_string();
            // Cap length so the Issues panel doesn't get a giant payload.
            let capped = if detail.len() > 300 {
                format!("{}…", &detail[..300])
            } else {
                detail
            };
            return Some(capped);
        }
    }
    None
}

/// Scans a mod's tp2 for the `NO_LOG_RECORD` directive. Returns true if the
/// directive appears in any non-comment line, false otherwise (or if the tp2
/// can't be located/read). Intentionally conservative: any hit disables the
/// Success→Skipped downgrade for every component of that mod.
fn tp2_has_no_log_record(game_dir: &Path, mod_name: &str, tp_file: &str) -> bool {
    use std::io::Read;
    // WeiDU is case-insensitive on tp2 names; try common placements.
    let candidates = [
        game_dir.join(mod_name).join(tp_file),
        game_dir.join(mod_name).join(tp_file.to_lowercase()),
        game_dir.join(mod_name).join(tp_file.to_uppercase()),
        game_dir.join(tp_file),
        game_dir.join(tp_file.to_lowercase()),
    ];
    for candidate in &candidates {
        let mut f = match std::fs::File::open(candidate) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let mut bytes = Vec::new();
        if f.read_to_end(&mut bytes).is_err() { continue; }
        // tp2 strings can be non-UTF-8; lossy is fine for directive scan.
        let text = String::from_utf8_lossy(&bytes);
        // Strip line comments (// ...) before matching so commented-out markers don't trigger.
        // WeiDU also supports /* */ block comments; we don't strip those because an
        // NO_LOG_RECORD inside a block comment is vanishingly rare and the penalty
        // (one false-positive skip of the silent-skip downgrade) is minor.
        return text.lines().any(|line| {
            let before_comment = line.split("//").next().unwrap_or(line);
            before_comment.contains("NO_LOG_RECORD")
        });
    }
    false
}

/// Check if EET core is already installed in the game's weidu.log.
fn is_eet_installed(game_dir: &Path) -> bool {
    is_component_installed(game_dir, "EET.TP2", 0)
        || is_component_installed(game_dir, "setup-eet.tp2", 0)
}

/// Wait while the install is paused.
fn wait_if_paused(state: &InstallState) {
    while state.paused.load(Ordering::SeqCst) && !state.abort_flag.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// Wait for a Retry/Skip/Stop decision from the GUI.
fn wait_for_decision(state: &InstallState) -> ErrorDecision {
    // Clear any stale decision from a previous error dialog
    if let Ok(mut lock) = state.decision.lock() {
        let _ = lock.take();
    }
    // Now wait for the GUI to send a fresh decision
    loop {
        if state.abort_flag.load(Ordering::SeqCst) {
            return ErrorDecision::Stop;
        }
        if let Ok(mut lock) = state.decision.lock() {
            if let Some(decision) = lock.take() {
                return decision;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

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

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

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

    // Resolve data directory for EETMR artifacts
    let data_dir = super::resolve_data_dir(config);

    // Migrate old artifacts from game dir to data dir (one-time)
    migrate_old_artifacts(&config.bg2_game_dir, &data_dir);

    // Clean up any stale TLK junction from a previous crash
    TlkAccelerator::cleanup_stale(&config.bg2_game_dir, &config.language);

    // Single-instance lockfile — prevent concurrent installs
    let lockfile_path = data_dir.join("install.lock");
    if lockfile_path.exists() {
        let _ = app.emit("install:error", "Another install is already running. If this is a stale lock from a crash, delete install.lock in your data directory.");
        state.running.store(false, std::sync::atomic::Ordering::SeqCst);
        return InstallSummary {
            total_components: 0, success: 0, warnings: 0, errors: 1,
            skipped: 0, already_installed: 0, elapsed_ms: 0, aborted: true,
        };
    }
    let _ = std::fs::write(&lockfile_path, format!("EET Mod Runner install started at {}", chrono_now()));

    // Patch WeiDU's PE header to increase stack size (prevents stack overflow segfaults)
    match super::pe_patch::ensure_adequate_stack(&config.weidu_path) {
        Ok(true) => {
            let _ = app.emit("install:stdout",
                "[EET Mod Runner] Patched WeiDU stack size to 32MB (prevents 0xc0000005 stack overflow)");
            let _ = app.emit("install:stdout",
                "[EET Mod Runner] NOTE: If your antivirus quarantines weidu.exe after this patch, add an exception for it and re-download weidu.exe");
        }
        Ok(false) => {} // Already adequate
        Err(e) => {
            let _ = app.emit("install:stdout",
                format!("[EET Mod Runner] WARNING: Could not patch WeiDU stack: {e}"));
        }
    }

    // Persistent install log
    let logger = install_log::create_logger(&data_dir);
    install_log::shared_log(&logger, &format!("Install started — weidu: {}", config.weidu_path.display()));

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
            let _ = app.emit("install:stdout", "[EET Mod Runner] EET already installed, skipping BG1 phase");
            // Mark BGEE components as already installed
            let bgee_already: Vec<ComponentResult> = bgee_components.iter().map(|comp| ComponentResult {
                mod_name: comp.mod_name.clone(),
                component: comp.component,
                component_name: comp.component_name.clone(),
                status: ComponentStatus::AlreadyInstalled,
                message: None,
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
                format!("[EET Mod Runner] Preserved {preserved} DEBUG files to {}", debug_dir.display()));
            install_log::shared_log(&logger,
                &format!("Preserved {preserved} DEBUG files to {}", debug_dir.display()));
        }
    }

    // Clean up lockfile and checkpoint
    clear_checkpoint(&data_dir);
    let _ = std::fs::remove_file(&lockfile_path);

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
    let path = data_dir.join("checkpoint.json");
    let _ = std::fs::write(&path, checkpoint.to_string());
}

/// Preserve debug files when a batch errors — copy per-mod DEBUG and WSETUP.DEBUG
/// to the data directory before the next batch overwrites them.
fn preserve_error_debug_files(game_dir: &Path, data_dir: &Path, mod_name: &str) {
    let debug_dir = data_dir.join("debug_logs");
    let _ = std::fs::create_dir_all(&debug_dir);

    // Per-mod debug file (setup-MODNAME.DEBUG)
    // Try multiple case variants since WeiDU is inconsistent
    for prefix in &["setup-", "SETUP-", "Setup-", ""] {
        let name = format!("{prefix}{mod_name}.DEBUG");
        let src = game_dir.join(&name);
        if src.exists() {
            let dest = debug_dir.join(format!("setup-{mod_name}.DEBUG"));
            let _ = std::fs::copy(&src, &dest);
            break;
        }
    }

    // Global WSETUP.DEBUG — rename per mod to avoid overwrites
    let wsetup = game_dir.join("WSETUP.DEBUG");
    if wsetup.exists() {
        let dest = debug_dir.join(format!("WSETUP-{mod_name}.DEBUG"));
        let _ = std::fs::copy(&wsetup, &dest);
    }
}

/// Remove checkpoint file on clean completion.
fn clear_checkpoint(data_dir: &Path) {
    let _ = std::fs::remove_file(data_dir.join("checkpoint.json"));
}

/// Check for a previous checkpoint (crash recovery).
pub fn read_checkpoint(data_dir: &std::path::Path) -> Option<serde_json::Value> {
    let path = data_dir.join("checkpoint.json");
    if !path.exists() { return None; }
    let contents = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&contents).ok()
}

/// Migrate old EETMR artifacts from game directory to data directory (one-time).
fn migrate_old_artifacts(game_dir: &Path, data_dir: &Path) {
    let migrations = [
        (".eetmr_checkpoint.json", "checkpoint.json"),
        ("eetmr_install.log", "install.log"),
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
            format!("[EET Mod Runner] Skipping {skipped_count} already-installed components"));
        // Record in tracker and emit to frontend so progress bar and status column reflect the true starting point
        let already_results: Vec<ComponentResult> = all_components.iter()
            .filter(|c| !components.iter().any(|ic| ic.tp_file.eq_ignore_ascii_case(&c.tp_file) && ic.component == c.component))
            .map(|c| ComponentResult {
                mod_name: c.mod_name.clone(),
                component: c.component,
                component_name: c.component_name.clone(),
                status: ComponentStatus::AlreadyInstalled,
                message: None,
            })
            .collect();
        if !already_results.is_empty() {
            tracker.emit_batch_done(0, &already_results);
            tracker.record_results(&already_results);
        }
    }

    // 3. Group into batches
    let batches = group_into_batches(&components, config.max_batch_size);
    let total_batches = batches.len();

    let _ = app.emit("install:stdout",
        format!("[EET Mod Runner] {} components in {} batches", components.len(), total_batches));

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
            format!("[EET Mod Runner] Indexing mod directory..."));
        let mod_index = super::copy::build_mod_folder_index(&config.mod_directory, 5);
        let _ = app.emit("install:stdout",
            format!("[EET Mod Runner] Found {} mods in index, linking {total_mods} to game dir...", mod_index.len()));

        for (idx, (mod_name, tp_file)) in unique_mods.iter().enumerate() {
            let dest = game_dir.join(mod_name);
            if dest.exists() {
                junction_ok += 1;
                continue;
            }
            if idx % 50 == 0 {
                let _ = app.emit("install:stdout",
                    format!("[EET Mod Runner] Linking mods {}/{}...", idx + 1, total_mods));
            }
            if let Some(src) = super::copy::find_mod_in_index(&mod_index, &config.mod_directory, mod_name, tp_file, 5) {
                match copy_mod_to_game(&src, &dest) {
                    Ok(_) => junction_ok += 1,
                    Err(e) => {
                        junction_fail += 1;
                        let _ = app.emit("install:stdout",
                            format!("[EET Mod Runner] WARNING: Failed to link '{}': {e}", mod_name));
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
                                        format!("[EET Mod Runner] Linked sibling directory '{}' for '{}'", sibling_name, mod_key));
                                }
                                Err(e) => {
                                    let _ = app.emit("install:stdout",
                                        format!("[EET Mod Runner] WARNING: Failed to link sibling '{}': {e}", sibling_name));
                                }
                            }
                        }
                    }
                }
            }
        }

        let _ = app.emit("install:stdout",
            format!("[EET Mod Runner] {junction_ok} mods ready ({junction_fail} failed{})",
                if sibling_count > 0 { format!(", {sibling_count} siblings") } else { String::new() }));
    }

    // 3c. Neutralize AT_INTERACTIVE_EXIT in all TP2 files (prevents mods from
    //     opening READMEs/docs during automated install).
    if config.suppress_readmes {
        let mut neutralized = 0usize;
        for batch in &batches {
            let tp2_path = game_dir.join(&batch.tp_file);
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
                format!("[EET Mod Runner] Suppressed AT_INTERACTIVE_EXIT in {neutralized} TP2 files (no readme popups)"));
            install_log::shared_log(logger, &format!("Suppressed AT_INTERACTIVE_EXIT in {neutralized} TP2 files"));
        }
    }

    // Track mod index for pause points
    let mut current_mod_index = 0usize;

    // Track mods where ALL components failed (exit code 2) — skip subsequent batches for the same mod
    let mut failed_mods: std::collections::HashSet<String> = std::collections::HashSet::new();

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
            format!("[EET Mod Runner] WARNING: TLK acceleration setup failed: {e}"));
    }

    // 4. For each batch
    for (batch_idx, batch) in batches.iter().enumerate() {
        if state.abort_flag.load(Ordering::SeqCst) {
            break;
        }

        // Check for pause
        wait_if_paused(state);

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
                }
            }
            last_mod_name = batch.mod_name.clone();
            current_mod_index += 1;
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
                }
            }).collect();
            let _ = app.emit("install:stdout",
                format!("[EET Mod Runner] Pre-skipping {} components in '{}' (earlier batch failed)",
                    skipped.len(), batch.mod_name));
            install_log::shared_log_event(logger, "PRE_SKIP",
                &format!("'{}': {} components (earlier batch failed)", batch.mod_name, skipped.len()));
            tracker.record_results(&skipped);
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
        tracker.emit_batch_start(batch_idx, total_batches, &batch.mod_name, &comp_names);

        // 4a. Locate mod folder and copy to game dir
        let mod_folder = find_mod_folder(&config.mod_directory, &batch.mod_name, &batch.tp_file, 5);
        if let Some(src) = &mod_folder {
            let dest = game_dir.join(&batch.mod_name);
            if let Err(e) = copy_mod_to_game(src, &dest) {
                let _ = app.emit("install:stdout",
                    format!("[EET Mod Runner] WARNING: Failed to copy {}: {e}", batch.mod_name));
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
                    format!("[EET Mod Runner] WARNING: Mod '{}' not found in mod directory or game directory", batch.mod_name));
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
                format!("[EET Mod Runner] Restored corrupted files: {}", restored_files.join(", ")));
        }
        if let Err(e) = check_tlk_integrity(game_dir, &config.language) {
            let _ = app.emit("install:stdout",
                format!("[EET Mod Runner] WARNING: dialog.tlk integrity issue: {e}"));
        }

        // 4d½. BCS corruption detection — compare snapshot, restore, report
        if let Some(snapshot) = &bcs_snapshot {
            let corruptions = snapshot.detect_corruptions(game_dir, &bcs_backup_data);
            if !corruptions.is_empty() {
                let restored_count = corruptions.iter().filter(|c| c.restored).count();
                let total = corruptions.len();
                let _ = app.emit("install:stdout", format!(
                    "[EET Mod Runner] BCS CORRUPTION DETECTED: {} files corrupted by '{}' batch #{} ({} auto-restored)",
                    total, batch.mod_name, batch_idx, restored_count
                ));
                for c in &corruptions {
                    let status = if c.restored { "RESTORED" } else { "NOT RESTORED" };
                    let _ = app.emit("install:stdout", format!(
                        "[EET Mod Runner]   {} {} → {} bytes [{}]",
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
                        format!("[EET Mod Runner] Segfault detected in batch for '{}' — attempting recovery", batch.mod_name));

                    // Step 1: Identify problematic BCS files from DEBUG log
                    let crash_bcs = super::debug_mgr::identify_crash_bcs(game_dir, &batch.mod_name);
                    if !crash_bcs.is_empty() {
                        for bcs in &crash_bcs {
                            let name = bcs.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                            let _ = app.emit("install:stdout",
                                format!("[EET Mod Runner] Replacing corrupt {} with empty BCS to allow install to continue", name));
                            let _ = super::debug_mgr::replace_with_empty_bcs(bcs);
                        }
                    }

                    // Step 2: Also clean IDS files (duplicate entries cause BCS round-trip failures)
                    let watched_restore = check_and_restore_watched_files(game_dir, &watched_backups);
                    if !watched_restore.is_empty() {
                        let _ = app.emit("install:stdout",
                            format!("[EET Mod Runner] Restored corrupted: {}", watched_restore.join(", ")));
                    }

                    // Step 3: Retry — if batch was >1, retry one at a time; else just retry the single component
                    if batch.components.len() > 1 {
                        let _ = app.emit("install:stdout",
                            format!("[EET Mod Runner] Retrying {} components one at a time", batch.components.len()));
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
                                }]);
                            }
                        } else {
                            tracker.record_results(&[ComponentResult {
                                mod_name: comp.mod_name.clone(), component: comp.component,
                                component_name: comp.component_name.clone(),
                                status: ComponentStatus::Warning,
                                message: Some("Installed despite segfault".to_string()),
                            }]);
                        }
                    }
                    continue; // Skip normal error handling
                }

                let has_errors = results.iter().any(|r| r.status == ComponentStatus::Error);

                if has_errors {
                    // Immediately preserve debug files before retry/next batch overwrites them
                    preserve_error_debug_files(game_dir, &data_dir, &batch.mod_name);

                    // Check weidu.log to see which actually installed
                    let refined = refine_results_from_log(game_dir, &batch.components, &results);
                    tracker.emit_batch_done(batch_idx, &refined);

                    let succeeded: Vec<ComponentResult> = refined.iter()
                        .filter(|r| r.status != ComponentStatus::Error)
                        .cloned()
                        .collect();
                    let still_failed: Vec<&ComponentResult> = refined.iter()
                        .filter(|r| r.status == ComponentStatus::Error)
                        .collect();

                    // Record only the succeeded components now — failed ones
                    // will be recorded after the retry/skip decision
                    tracker.record_results(&succeeded);

                    // If ALL components failed, mark this mod for pre-skipping subsequent batches
                    if succeeded.is_empty() && !still_failed.is_empty() {
                        failed_mods.insert(batch.mod_name.to_lowercase());
                    }

                    if !still_failed.is_empty() {
                        let is_essential = ESSENTIAL_MODS.contains(&batch.mod_name.to_lowercase().as_str());
                        if is_essential {
                            // Record the failures and abort
                            let failures: Vec<ComponentResult> = still_failed.iter().map(|r| (*r).clone()).collect();
                            tracker.record_results(&failures);
                            let _ = app.emit("install:stdout",
                                format!("[EET Mod Runner] FATAL: Essential mod '{}' failed. Aborting.", batch.mod_name));
                            state.abort_flag.store(true, Ordering::SeqCst);
                            break;
                        }

                        let error_msg = still_failed.iter()
                            .map(|r| format!("#{}: {}", r.component, r.message.as_deref().unwrap_or("failed")))
                            .collect::<Vec<_>>()
                            .join("; ");

                        if config.auto_skip_after_retry {
                            // Don't emit batch_error (which triggers the GUI dialog) —
                            // just log it and handle automatically
                            let _ = app.emit("install:stdout",
                                format!("[EET Mod Runner] Batch error in '{}': {}", batch.mod_name, error_msg));
                            // Auto mode: retry once, then skip remaining failures
                            let retry_set = super::log_diff::installed_set_from_game(game_dir);
                            let failed_comps: Vec<Component> = batch.components.iter()
                                .filter(|c| !super::log_diff::is_in_installed_set(&retry_set, &c.tp_file, c.component))
                                .cloned()
                                .collect();
                            if !failed_comps.is_empty() {
                                let _ = app.emit("install:stdout",
                                    format!("[EET Mod Runner] Auto-retry: {} failed components in '{}'", failed_comps.len(), batch.mod_name));
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
                                    let retry_failed: Vec<ComponentResult> = refined_retry.iter()
                                        .filter(|r| r.status == ComponentStatus::Error)
                                        .map(|r| ComponentResult { status: ComponentStatus::Skipped, ..r.clone() })
                                        .collect();
                                    let retry_ok: Vec<ComponentResult> = refined_retry.iter()
                                        .filter(|r| r.status != ComponentStatus::Error)
                                        .cloned()
                                        .collect();
                                    if !retry_failed.is_empty() {
                                        let _ = app.emit("install:stdout",
                                            format!("[EET Mod Runner] Auto-skip: {} still failed after retry in '{}'",
                                                retry_failed.len(), batch.mod_name));
                                        install_log::shared_log_event(logger, "AUTO_SKIP",
                                            &format!("'{}': {} components skipped after retry", batch.mod_name, retry_failed.len()));
                                    }
                                    tracker.record_results(&retry_ok);
                                    tracker.record_results(&retry_failed);
                                } else {
                                    // Retry itself failed to start — skip all
                                    let skipped: Vec<ComponentResult> = still_failed.iter().map(|r| {
                                        ComponentResult { status: ComponentStatus::Skipped, ..(*r).clone() }
                                    }).collect();
                                    tracker.record_results(&skipped);
                                }
                            } else {
                                let failures: Vec<ComponentResult> = still_failed.iter().map(|r| (*r).clone()).collect();
                                tracker.record_results(&failures);
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
                                        }
                                    } else {
                                        // All components installed on retry check
                                        let failures: Vec<ComponentResult> = still_failed.iter().map(|r| (*r).clone()).collect();
                                        tracker.record_results(&failures);
                                    }
                                }
                                ErrorDecision::Skip => {
                                    // Record failures as skipped
                                    let skipped: Vec<ComponentResult> = still_failed.iter().map(|r| {
                                        ComponentResult { status: ComponentStatus::Skipped, ..(*r).clone() }
                                    }).collect();
                                    tracker.record_results(&skipped);
                                    let _ = app.emit("install:stdout",
                                        format!("[EET Mod Runner] Skipping failed components in '{}'", batch.mod_name));
                                }
                                ErrorDecision::Stop => {
                                    let failures: Vec<ComponentResult> = still_failed.iter().map(|r| (*r).clone()).collect();
                                    tracker.record_results(&failures);
                                    state.abort_flag.store(true, Ordering::SeqCst);
                                    break;
                                }
                            }
                        } else {
                            // never_abort mode — record failures and continue
                            let failures: Vec<ComponentResult> = still_failed.iter().map(|r| (*r).clone()).collect();
                            tracker.record_results(&failures);
                        }
                    }
                } else {
                    // All success
                    tracker.record_results(&results);
                    tracker.emit_batch_done(batch_idx, &results);
                }
            }
            Err(e) => {
                // Fatal error (couldn't even start WeiDU)
                preserve_error_debug_files(game_dir, &data_dir, &batch.mod_name);
                let _ = app.emit("install:stdout",
                    format!("[EET Mod Runner] ERROR: {e}"));
                let error_results: Vec<ComponentResult> = batch.components.iter().map(|c| {
                    ComponentResult {
                        mod_name: c.mod_name.clone(),
                        component: c.component,
                        component_name: c.component_name.clone(),
                        status: ComponentStatus::Error,
                        message: Some(e.clone()),
                    }
                }).collect();
                tracker.record_results(&error_results);
                tracker.emit_batch_error(batch_idx, &batch.mod_name, &e, false);

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
            "\n[EET Mod Runner] ═══ BCS Corruption Report ({} phase) ═══",
            phase_name
        ));
        let _ = app.emit("install:stdout", format!(
            "[EET Mod Runner] {} BCS files were corrupted during this install:",
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
                "[EET Mod Runner]   {} — {} files:", mod_name, corruptions.len()
            ));
            for c in corruptions {
                let status = if c.restored { "auto-restored" } else { "NOT restored" };
                let _ = app.emit("install:stdout", format!(
                    "[EET Mod Runner]     {} ({} → {} bytes) [{}]",
                    c.filename, c.size_before, c.size_after, status
                ));
            }
        }
        let _ = app.emit("install:stdout",
            "[EET Mod Runner] Use this report to create targeted patches for these mods.".to_string());
        let _ = app.emit("install:stdout",
            "[EET Mod Runner] ═══════════════════════════════════════════".to_string());
    }

    // Teardown TLK acceleration
    if let Err(e) = tlk_accel.teardown(app) {
        let _ = app.emit("install:stdout",
            format!("[EET Mod Runner] WARNING: TLK acceleration teardown failed: {e}"));
    }

    Ok(())
}

/// Refine batch results by checking the game's weidu.log for actual install status.
/// Components that WeiDU reported as errors but are actually in weidu.log → Warning.
/// Parses weidu.log once and checks all components against the parsed set.
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

    results.iter().zip(components).map(|(result, comp)| {
        if result.status == ComponentStatus::Error {
            let key = (comp.tp_file.to_lowercase(), comp.component);
            if installed_set.contains(&key) {
                ComponentResult {
                    status: ComponentStatus::Warning,
                    message: Some("Installed with errors (found in weidu.log)".to_string()),
                    ..result.clone()
                }
            } else {
                result.clone()
            }
        } else {
            result.clone()
        }
    }).collect()
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

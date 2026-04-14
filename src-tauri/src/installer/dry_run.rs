//! Dry run mode — validates the full install pipeline without running WeiDU.
//!
//! Checks: log parsing, batch grouping, mod folder availability, READLN coverage,
//! junction creation, and resource estimates.

use super::batch::group_into_batches;
use super::copy::build_mod_folder_index;
use super::log_diff::{parse_weidu_log, filter_already_installed};
use super::{InstallConfig, FORCE_SMALL_BATCH_MODS};

use std::path::Path;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, serde::Serialize)]
pub struct DryRunReport {
    pub total_components: usize,
    pub total_batches: usize,
    pub already_installed_count: usize,
    pub unique_mods: usize,
    pub mods: Vec<DryRunMod>,
    pub missing_mods: Vec<String>,
    pub uncovered_readln: Vec<String>,
    pub covered_readln: Vec<String>,
    pub junction_ok: bool,
    pub junction_error: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DryRunMod {
    pub mod_name: String,
    pub component_count: usize,
    pub batch_count: usize,
    pub found: bool,
    pub small_batch: bool,
    pub has_readln: bool,
    pub readln_configured: bool,
}

/// Helper to emit a line to the GUI.
fn emit(app: &AppHandle, msg: &str) {
    let _ = app.emit("install:stdout", msg);
}

pub fn run_dry_run(
    app: &AppHandle,
    config: &InstallConfig,
    exported_bgee_log: Option<&Path>,
    exported_eet_log: &Path,
) -> DryRunReport {
    emit(app, "");
    emit(app, "[EET Mod Runner] ════════════════════════════════════════════");
    emit(app, "[EET Mod Runner]              DRY RUN REPORT");
    emit(app, "[EET Mod Runner] ════════════════════════════════════════════");

    // ── 1. Parse logs ──
    let bgee_components = exported_bgee_log
        .map(|p| parse_weidu_log(p).unwrap_or_default())
        .unwrap_or_default();
    let eet_components = parse_weidu_log(exported_eet_log).unwrap_or_default();
    let total_raw = bgee_components.len() + eet_components.len();

    emit(app, "");
    emit(app, "[EET Mod Runner] ── LOG PARSING ──");
    emit(app, &format!("[EET Mod Runner]   Total in export: {} components ({} BGEE + {} EET)",
        total_raw, bgee_components.len(), eet_components.len()));

    // ── 2. Filter already installed ──
    let already_installed_count = if config.skip_installed {
        let filtered = filter_already_installed(&eet_components, &config.bg2_game_dir);
        let count = eet_components.len() - filtered.len();
        let bgee_count = if let Some(bg1) = &config.bg1_game_dir {
            let bf = filter_already_installed(&bgee_components, bg1);
            bgee_components.len() - bf.len()
        } else { 0 };
        count + bgee_count
    } else {
        0
    };

    let components_to_install: Vec<_> = if config.skip_installed {
        let bgee_filtered = if let Some(bg1) = &config.bg1_game_dir {
            filter_already_installed(&bgee_components, bg1)
        } else {
            bgee_components.clone()
        };
        let eet_filtered = filter_already_installed(&eet_components, &config.bg2_game_dir);
        bgee_filtered.into_iter().chain(eet_filtered).collect()
    } else {
        bgee_components.iter().chain(eet_components.iter()).cloned().collect()
    };

    if already_installed_count > 0 {
        emit(app, &format!("[EET Mod Runner]   Already installed: {} (will skip)", already_installed_count));
    }
    emit(app, &format!("[EET Mod Runner]   To install: {} components", components_to_install.len()));

    // ── 3. Group into batches ──
    let batches = group_into_batches(&components_to_install, config.max_batch_size);
    let total_batches = batches.len();
    let total_components = components_to_install.len();

    emit(app, &format!("[EET Mod Runner]   Batches: {}", total_batches));

    // ── 4. Build mod folder index ──
    emit(app, "");
    emit(app, "[EET Mod Runner] ── MOD AVAILABILITY ──");
    let mod_index = build_mod_folder_index(&config.mod_directory, 5);

    // ── 5. Check each unique mod ──
    let mut seen = std::collections::HashSet::new();
    let mut mods = Vec::new();
    let mut missing_mods = Vec::new();
    let mut small_batch_mods_in_install = Vec::new();

    for batch in &batches {
        let key = batch.mod_name.to_lowercase();
        if !seen.insert(key.clone()) { continue; }

        let found_in_index = mod_index.contains_key(&key);
        let found_in_game = config.bg2_game_dir.join(&batch.mod_name).exists();
        let found = found_in_index || found_in_game;

        let component_count = batches.iter()
            .filter(|b| b.mod_name.to_lowercase() == key)
            .map(|b| b.components.len())
            .sum::<usize>();
        let batch_count = batches.iter()
            .filter(|b| b.mod_name.to_lowercase() == key)
            .count();

        let is_small_batch = FORCE_SMALL_BATCH_MODS.contains(&key.as_str());
        let has_readln = if let Some(folder) = mod_index.get(&key) {
            has_readln_in_tp2(folder)
        } else {
            false
        };
        let readln_configured = config.readln_defaults.contains_key(&key);

        if !found {
            missing_mods.push(batch.mod_name.clone());
        }
        if is_small_batch {
            small_batch_mods_in_install.push((batch.mod_name.clone(), component_count, batch_count));
        }

        mods.push(DryRunMod {
            mod_name: batch.mod_name.clone(),
            component_count,
            batch_count,
            found,
            small_batch: is_small_batch,
            has_readln,
            readln_configured,
        });
    }

    let unique_mods = mods.len();
    emit(app, &format!("[EET Mod Runner]   {} unique mods in install", unique_mods));
    emit(app, &format!("[EET Mod Runner]   {} found in Extracted directory", mod_index.len()));

    if missing_mods.is_empty() {
        emit(app, "[EET Mod Runner]   All mods found ✓");
    } else {
        emit(app, &format!("[EET Mod Runner]   MISSING {} mods:", missing_mods.len()));
        for m in &missing_mods {
            emit(app, &format!("[EET Mod Runner]     - {m}"));
        }
    }

    // ── 6. Heavy mods (small batch) ──
    if !small_batch_mods_in_install.is_empty() {
        emit(app, "");
        emit(app, "[EET Mod Runner] ── HEAVY MODS (small batch = 3) ──");
        for (name, comps, batches) in &small_batch_mods_in_install {
            emit(app, &format!("[EET Mod Runner]   {name}: {comps} components in {batches} batches"));
        }
    }

    // ── 7. READLN coverage ──
    emit(app, "");
    emit(app, "[EET Mod Runner] ── READLN PROMPT COVERAGE ──");

    let mut covered_readln = Vec::new();
    let mut uncovered_readln = Vec::new();
    let readln_mods: Vec<&DryRunMod> = mods.iter().filter(|m| m.has_readln).collect();

    if readln_mods.is_empty() {
        emit(app, "[EET Mod Runner]   No mods with READLN prompts detected");
    } else {
        for m in &readln_mods {
            if m.readln_configured {
                let answers = config.readln_defaults.get(&m.mod_name.to_lowercase())
                    .map(|a| a.join(", "))
                    .unwrap_or_default();
                emit(app, &format!("[EET Mod Runner]   {} — configured [{}]", m.mod_name, answers));
                covered_readln.push(m.mod_name.clone());
            } else {
                emit(app, &format!("[EET Mod Runner]   {} — NOT CONFIGURED (will use fallback \"{}\" after {}s timeout)",
                    m.mod_name, config.readln_fallback, config.readln_timeout_secs));
                uncovered_readln.push(m.mod_name.clone());
            }
        }
    }

    // Also show configured mods not in the READLN list (pre-configured but no READLN detected — fine, just informational)
    let configured_not_in_install: Vec<_> = config.readln_defaults.keys()
        .filter(|k| !mods.iter().any(|m| m.mod_name.to_lowercase() == **k))
        .collect();
    if !configured_not_in_install.is_empty() {
        emit(app, &format!("[EET Mod Runner]   ({} configured mods not in this install: {})",
            configured_not_in_install.len(),
            configured_not_in_install.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")));
    }

    // ── 8. Junction test ──
    emit(app, "");
    emit(app, "[EET Mod Runner] ── SYSTEM CHECKS ──");
    let (junction_ok, junction_error) = test_junction(&config.bg2_game_dir);
    if junction_ok {
        emit(app, "[EET Mod Runner]   Junction/symlink: OK");
    } else {
        emit(app, &format!("[EET Mod Runner]   Junction/symlink: FAILED — {}",
            junction_error.as_deref().unwrap_or("unknown")));
    }

    // ── 9. Time estimate ──
    // Based on Test #23 data: ~100 batches/hour for normal mods, heavy mods slower
    let heavy_batch_count: usize = small_batch_mods_in_install.iter().map(|(_, _, b)| b).sum();
    let normal_batch_count = total_batches - heavy_batch_count;
    let est_minutes = (normal_batch_count as f64 / 1.7) + (heavy_batch_count as f64 / 0.5); // ~1.7 batches/min normal, ~0.5/min heavy
    let est_hours = est_minutes / 60.0;
    emit(app, &format!("[EET Mod Runner]   Estimated install time: {:.0}min ({:.1}h)",
        est_minutes, est_hours));

    // ── 10. Mod list ──
    emit(app, "");
    emit(app, "[EET Mod Runner] ── MOD LIST (install order) ──");
    for m in &mods {
        let flags: Vec<&str> = [
            if !m.found { Some("MISSING") } else { None },
            if m.small_batch { Some("heavy") } else { None },
            if m.has_readln && !m.readln_configured { Some("READLN!") } else { None },
            if m.has_readln && m.readln_configured { Some("readln-ok") } else { None },
        ].into_iter().flatten().collect();

        let flag_str = if flags.is_empty() {
            String::new()
        } else {
            format!(" [{}]", flags.join(", "))
        };
        emit(app, &format!("[EET Mod Runner]   {} — {} components, {} batches{}",
            m.mod_name, m.component_count, m.batch_count, flag_str));
    }

    // ── Summary ──
    emit(app, "");
    emit(app, "[EET Mod Runner] ── SUMMARY ──");
    let mut warnings = Vec::new();
    if !missing_mods.is_empty() {
        let w = format!("{} mods missing from Extracted", missing_mods.len());
        warnings.push(w.clone());
        emit(app, &format!("[EET Mod Runner]   WARNING: {w}"));
    }
    if !uncovered_readln.is_empty() {
        let w = format!("{} mods with uncovered READLN (fallback after {}s)", uncovered_readln.len(), config.readln_timeout_secs);
        warnings.push(w.clone());
        emit(app, &format!("[EET Mod Runner]   WARNING: {w}"));
    }
    if !junction_ok {
        warnings.push("Junction/symlink creation failed".to_string());
    }
    if warnings.is_empty() {
        emit(app, "[EET Mod Runner]   No issues found — ready to install");
    }
    emit(app, &format!("[EET Mod Runner]   {} components, {} batches, ~{:.0}min estimated",
        total_components, total_batches, est_minutes));

    emit(app, "[EET Mod Runner] ════════════════════════════════════════════");

    let report = DryRunReport {
        total_components,
        total_batches,
        already_installed_count,
        unique_mods,
        mods,
        missing_mods,
        uncovered_readln,
        covered_readln,
        junction_ok,
        junction_error,
        warnings,
    };

    let _ = app.emit("install:dry_run_complete", serde_json::json!(&report));
    report
}

/// Check if a mod folder contains TP2 files with READLN directives.
fn has_readln_in_tp2(folder: &Path) -> bool {
    if let Ok(entries) = std::fs::read_dir(folder) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().map_or(false, |e| e.eq_ignore_ascii_case("tp2")) {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    let upper = content.to_uppercase();
                    if upper.contains("ACTION_READLN") || upper.contains("READLN") {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Test junction/symlink creation in the game directory.
fn test_junction(game_dir: &Path) -> (bool, Option<String>) {
    let test_dir = game_dir.join(".eetmr_junction_test");
    let test_target = game_dir.join("override"); // always exists in BG2

    if !test_target.exists() {
        return (false, Some("override/ directory not found — is this a valid game dir?".to_string()));
    }

    // Try symlink
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::symlink_dir;
        match symlink_dir(&test_target, &test_dir) {
            Ok(_) => {
                let _ = std::fs::remove_dir(&test_dir);
                return (true, None);
            }
            Err(_) => {
                // Fall back to junction via cmd
                use std::os::windows::process::CommandExt;
                let result = std::process::Command::new("cmd")
                    .args(["/c", "mklink", "/J",
                        &test_dir.to_string_lossy(),
                        &test_target.to_string_lossy()])
                    .creation_flags(0x08000000)
                    .output();
                match result {
                    Ok(output) if output.status.success() => {
                        let _ = std::fs::remove_dir(&test_dir);
                        (true, None)
                    }
                    Ok(output) => {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        (false, Some(format!("mklink /J failed: {}", stderr.trim())))
                    }
                    Err(e) => (false, Some(format!("cmd failed: {e}"))),
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        match std::os::unix::fs::symlink(&test_target, &test_dir) {
            Ok(_) => {
                let _ = std::fs::remove_file(&test_dir);
                (true, None)
            }
            Err(e) => (false, Some(format!("symlink failed: {e}"))),
        }
    }
}

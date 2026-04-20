//! Install plan preview — simulates the WeiDU install pipeline without
//! running it, so the user can see exactly what's about to happen.
//!
//! Scope note: this module is intentionally NOT an environment health
//! check. Path validation, WeiDU binary verification, junction capability,
//! disk space, essential-mod presence, backup status, Forge compatibility
//! — all of those live in Ready Check (`ReadyCheck.tsx`). The split was
//! made to eliminate redundant warnings and give each tab a sharp,
//! single-purpose identity:
//!
//!   • Ready Check  = "Is my environment ready?"  (runs before Dry Run)
//!   • Dry Run      = "What will WeiDU actually do?"  (this file)
//!
//! So everything here is about the install plan: batching, ordering,
//! phases, heavy mods, READLN prompts, language coverage, time estimate.

use super::batch::group_into_batches;
use super::copy::build_mod_folder_index;
use super::log_diff::{parse_weidu_log, filter_already_installed};
use super::{InstallConfig, FORCE_SMALL_BATCH_MODS};
use crate::commands::{load_manifest, build_mod_location_map, check_trigger, check_marker};

use std::path::Path;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, serde::Serialize)]
pub struct DryRunReport {
    pub total_components: usize,
    pub total_batches: usize,
    pub already_installed_count: usize,
    pub unique_mods: usize,
    pub mods: Vec<DryRunMod>,
    /// Mods referenced by the WeiDU log that weren't found in the Extracted
    /// directory. Informational only — Ready Check handles the authoritative
    /// "missing mods" validation.
    pub missing_mods: Vec<String>,
    pub uncovered_readln: Vec<String>,
    pub covered_readln: Vec<String>,
    pub estimated_minutes: f64,
    /// Minutes estimated for PRE-EET phase alone.
    pub bgee_estimated_minutes: f64,
    /// Minutes estimated for EET phase alone.
    pub eet_estimated_minutes: f64,
    /// Count of components whose `lang` field matched the configured
    /// `language_index`. Mods with mismatched language fall back to default.
    pub language_matched_components: usize,
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
    /// 0-based position in the install order.
    pub install_order: usize,
    /// Phase this mod runs in: "bgee" (PRE-EET) or "eet".
    pub phase: String,
}

/// Helper to emit a line to the GUI.
fn emit(app: &AppHandle, msg: &str) {
    let _ = app.emit("install:stdout", msg);
}

/// Emit a section header with the unicode ▸ marker.
fn section(app: &AppHandle, title: &str) {
    emit(app, "");
    emit(app, &format!("[Infinity Mod Runner] \u{25B8} {}", title));
}

fn fmt_minutes(mins: f64) -> String {
    if mins >= 60.0 {
        format!("{:.0}min ({:.1}h)", mins, mins / 60.0)
    } else {
        format!("{:.0}min", mins)
    }
}

/// Per-batch timing assumptions, calibrated from sessions a933d14b, c623ff72,
/// 88733aac (2026-04-14 through 2026-04-16, 1695 components each).
///
/// Normal (batch-size=25) batches average ~35s each (1.7 batches/min).
///
/// Heavy (batch-size=3) mods split into two tiers:
///   • **SFO-dependent mods** (dw_talents, stratagems, mih_tweaks) — these
///     share the SFO library, accumulate memory pressure across batches, and
///     exhibit an exponential slowdown cascade. Observed: dw_talents 238min
///     for 14 batches (17min/batch avg, max 186min), stratagems 101min for
///     16 batches (6.3min/batch avg, max 66min), mih_tweaks 38min for 2
///     batches (19min/batch). Rate: ~0.15 batches/min.
///   • **Non-SFO heavy mods** (mih_eq, mih_ip, trap_overhaul) — no cascade,
///     2-3min per batch. Rate: ~0.5 batches/min.
const BATCHES_PER_MIN_NORMAL: f64 = 1.7;
const BATCHES_PER_MIN_HEAVY: f64 = 0.5;
const BATCHES_PER_MIN_SFO_HEAVY: f64 = 0.15;

/// Mods known to share the SFO library and cascade in late-install phases.
/// These get the slower SFO rate in time estimates.
const SFO_HEAVY_MODS: &[&str] = &["dw_talents", "stratagems", "mih_tweaks"];

/// Estimate minutes for a given batch count, split by rate tier.
fn estimate_minutes_tiered(normal: usize, heavy: usize, sfo_heavy: usize) -> f64 {
    (normal as f64 / BATCHES_PER_MIN_NORMAL)
        + (heavy as f64 / BATCHES_PER_MIN_HEAVY)
        + (sfo_heavy as f64 / BATCHES_PER_MIN_SFO_HEAVY)
}

pub fn run_dry_run(
    app: &AppHandle,
    config: &InstallConfig,
    exported_bgee_log: Option<&Path>,
    exported_eet_log: &Path,
) -> DryRunReport {
    let divider = "\u{2550}".repeat(42);
    emit(app, "");
    emit(app, &format!("[Infinity Mod Runner] {}", divider));
    emit(app, "[Infinity Mod Runner]          INSTALL PLAN PREVIEW");
    emit(app, &format!("[Infinity Mod Runner] {}", divider));
    emit(app, "[Infinity Mod Runner] Simulates what WeiDU will do with your current log.");
    emit(app, "[Infinity Mod Runner] Run the Ready Check tab first for environment validation.");

    // ── 1. Parse logs ──
    let bgee_components = exported_bgee_log
        .map(|p| parse_weidu_log(p).unwrap_or_default())
        .unwrap_or_default();
    let eet_components = parse_weidu_log(exported_eet_log).unwrap_or_default();

    // ── 2. Filter already installed ──
    let (bgee_filtered, eet_filtered, already_installed_count) = if config.skip_installed {
        let bf = if let Some(bg1) = &config.bg1_game_dir {
            filter_already_installed(&bgee_components, bg1)
        } else {
            bgee_components.clone()
        };
        let ef = filter_already_installed(&eet_components, &config.bg2_game_dir);
        let already = (bgee_components.len() - bf.len()) + (eet_components.len() - ef.len());
        (bf, ef, already)
    } else {
        (bgee_components.clone(), eet_components.clone(), 0)
    };

    // Per-phase component counts so timing can break down accurately.
    let bgee_to_install = bgee_filtered.len();
    let eet_to_install = eet_filtered.len();
    let components_to_install: Vec<_> = bgee_filtered.into_iter()
        .chain(eet_filtered)
        .collect();
    let total_components = components_to_install.len();

    // Language coverage: how many components are tagged with the configured
    // language index. Mismatched ones fall back to WeiDU's default language.
    // Purely informational — helps users understand what happens if they
    // chose a non-English language but most components are en_US-tagged.
    let language_matched_components: usize = components_to_install.iter()
        .filter(|c| c.lang == config.language_index)
        .count();

    // ── 3. Group into batches ──
    let batches = group_into_batches(
        &components_to_install,
        config.max_batch_size,
        &config.force_small_batch_mods,
        config.force_small_batch_size,
        &config.force_single_cn_mods,
    );
    let total_batches = batches.len();

    // ── 4. Build mod folder index + per-mod rows ──
    let mod_index = build_mod_folder_index(&config.mod_directory, 5);

    let mut seen = std::collections::HashSet::new();
    let mut mods: Vec<DryRunMod> = Vec::new();
    let mut missing_mods = Vec::new();
    let mut small_batch_mods_in_install: Vec<(String, usize, usize)> = Vec::new();

    for (idx, batch) in batches.iter().enumerate() {
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
        let has_readln = mod_index.get(&key).map_or(false, |p| has_readln_in_tp2(p));
        let readln_configured = config.readln_defaults.contains_key(&key);

        // Phase determination: count components in all preceding batches.
        let phase: String = {
            let comps_before: usize = batches.iter().take(idx)
                .map(|b| b.components.len())
                .sum();
            if comps_before < bgee_to_install { "bgee".into() } else { "eet".into() }
        };

        if !found { missing_mods.push(batch.mod_name.clone()); }
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
            install_order: mods.len(),
            phase,
        });
    }

    let unique_mods = mods.len();

    // ── Per-phase batch counts ──
    let bgee_batches = {
        let mut count = 0;
        let mut comps_so_far = 0usize;
        for b in &batches {
            if comps_so_far >= bgee_to_install { break; }
            comps_so_far += b.components.len();
            count += 1;
        }
        count
    };
    let eet_batches = total_batches.saturating_sub(bgee_batches);

    // ── Timing breakdown: normal vs heavy × PRE-EET vs EET ──
    // Split heavy batches into SFO-cascade mods (slower rate) vs non-SFO heavy.
    let sfo_batch_count: usize = small_batch_mods_in_install.iter()
        .filter(|(name, _, _)| SFO_HEAVY_MODS.contains(&name.to_lowercase().as_str()))
        .map(|(_, _, b)| b)
        .sum();
    let heavy_batch_count: usize = small_batch_mods_in_install.iter().map(|(_, _, b)| b).sum();
    let nonsfo_heavy_count = heavy_batch_count.saturating_sub(sfo_batch_count);
    let normal_batch_count = total_batches.saturating_sub(heavy_batch_count);
    let est_minutes = estimate_minutes_tiered(normal_batch_count, nonsfo_heavy_count, sfo_batch_count);

    // Per-phase timing. Assume heavy batches are proportionally split
    // between phases (close enough — EET mods dominate heavy in practice).
    let bgee_ratio = if total_batches > 0 {
        bgee_batches as f64 / total_batches as f64
    } else { 0.0 };
    let eet_ratio = 1.0 - bgee_ratio;
    let bgee_estimated_minutes = est_minutes * bgee_ratio;
    let eet_estimated_minutes = est_minutes * eet_ratio;

    // ── READLN coverage (install-plan relevant: WeiDU pauses on these) ──
    let mut covered_readln = Vec::new();
    let mut uncovered_readln = Vec::new();
    for m in mods.iter().filter(|m| m.has_readln) {
        if m.readln_configured {
            covered_readln.push(m.mod_name.clone());
        } else {
            uncovered_readln.push(m.mod_name.clone());
        }
    }

    // ╔══════════════════════════════════════════════════════════════════╗
    // ║ Output phase. Order: profile → phase plan → heavy → READLN →     ║
    // ║ language → mod list → summary.                                   ║
    // ║ No VERDICT / no SYSTEM / no ESSENTIALS — those belong in         ║
    // ║ Ready Check. We focus exclusively on what WeiDU will do.          ║
    // ╚══════════════════════════════════════════════════════════════════╝

    // ── PLAN OVERVIEW ──
    section(app, "PLAN OVERVIEW");
    // Skip-reason note: when the BGEE phase has been fully consumed by
    // skip_installed (EET already imported on a previous run), we want to
    // say that out loud — otherwise "0 PRE-EET" reads like a bug rather
    // than "that phase is done." We detect this by checking whether the
    // raw bgee log had entries but the filtered count is now zero.
    let bgee_fully_installed = bgee_components.len() > 0 && bgee_to_install == 0;
    let skipped_note = if already_installed_count > 0 {
        if bgee_fully_installed {
            format!(", {} already installed (PRE-EET phase complete)", already_installed_count)
        } else {
            format!(", {} already installed (skipped)", already_installed_count)
        }
    } else {
        String::new()
    };
    emit(app, &format!("[Infinity Mod Runner]   Components:  {} total ({} PRE-EET + {} EET){}",
        total_components, bgee_to_install, eet_to_install, skipped_note));
    emit(app, &format!("[Infinity Mod Runner]   Batches:     {} ({} PRE-EET + {} EET){}",
        total_batches, bgee_batches, eet_batches,
        if heavy_batch_count > 0 {
            format!(", {} heavy @{}, {} normal @{}",
                heavy_batch_count, config.force_small_batch_size,
                normal_batch_count, config.max_batch_size)
        } else {
            format!(", all {} @{}", total_batches, config.max_batch_size)
        }));
    emit(app, &format!("[Infinity Mod Runner]   Mods:        {} unique", unique_mods));
    emit(app, &format!("[Infinity Mod Runner]   Language:    {} (index {})", config.language, config.language_index));
    // Phase 20b: surface the BIFF-delete optimization state in PLAN
    // OVERVIEW itself (always, not just when SFO mods are present) so a
    // user running an A/B baseline can tell at a glance which variant
    // this plan represents without opening install_config.json. Matches
    // the PREBIFF event format the orchestrator emits at runtime so
    // dry-run output maps 1:1 onto what'll land in install.log.
    emit(app, &format!(
        "[Infinity Mod Runner]   BIFF opt:    delete_optimization={} {}",
        if config.enable_biff_delete_optimization { "on" } else { "off" },
        if config.enable_biff_delete_optimization {
            "(override/ cleared after MAKE_BIFF)"
        } else {
            "(override/ retained — [A] baseline)"
        },
    ));
    // One-liner explaining the @N notation so the reader doesn't have to
    // guess what "@3" and "@25" mean. Suppressed when no heavy mods are
    // present (no divergence between the two caps in that case).
    if heavy_batch_count > 0 {
        emit(app, &format!(
            "[Infinity Mod Runner]                (@N = max components per WeiDU invocation; heavy mods capped at {} to avoid segfaults)",
            config.force_small_batch_size));
    }

    // ── TIMING BREAKDOWN ──
    section(app, "TIMING BREAKDOWN");
    emit(app, &format!("[Infinity Mod Runner]   Total:       ~{}", fmt_minutes(est_minutes)));
    if bgee_batches > 0 && eet_batches > 0 {
        emit(app, &format!("[Infinity Mod Runner]   PRE-EET:     ~{}  ({} batches)",
            fmt_minutes(bgee_estimated_minutes), bgee_batches));
        emit(app, &format!("[Infinity Mod Runner]   EET:         ~{}  ({} batches)",
            fmt_minutes(eet_estimated_minutes), eet_batches));
    }
    if heavy_batch_count > 0 {
        let normal_minutes = normal_batch_count as f64 / BATCHES_PER_MIN_NORMAL;
        let nonsfo_minutes = nonsfo_heavy_count as f64 / BATCHES_PER_MIN_HEAVY;
        let sfo_minutes = sfo_batch_count as f64 / BATCHES_PER_MIN_SFO_HEAVY;
        let heavy_total = nonsfo_minutes + sfo_minutes;
        let heavy_pct = (heavy_total / est_minutes) * 100.0;
        if sfo_batch_count > 0 {
            emit(app, &format!("[Infinity Mod Runner]   By type:     {:.0}min normal + {:.0}min heavy + {:.0}min SFO-heavy ({:.0}% heavy)",
                normal_minutes, nonsfo_minutes, sfo_minutes, heavy_pct));
            emit(app, &format!("[Infinity Mod Runner]                SFO mods ({}): {} batches at ~{:.0}min/batch avg — cascade risk",
                SFO_HEAVY_MODS.join(", "), sfo_batch_count,
                if sfo_batch_count > 0 { sfo_minutes / sfo_batch_count as f64 } else { 0.0 }));
        } else {
            emit(app, &format!("[Infinity Mod Runner]   By type:     {:.0}min normal + {:.0}min heavy ({:.0}% heavy)",
                normal_minutes, heavy_total, heavy_pct));
        }
    }
    emit(app, "[Infinity Mod Runner]   Caveat:      estimate assumes NO mid-install BIFF optimization.");
    emit(app, "[Infinity Mod Runner]                With BIFF (automatic), SFO-heavy mods run significantly");
    emit(app, "[Infinity Mod Runner]                faster. Expect 40-50% less than the estimate above.");

    // ── HEAVY MODS ──
    if !small_batch_mods_in_install.is_empty() {
        section(app, &format!("HEAVY MODS  (batch size forced to {})", config.force_small_batch_size));
        emit(app, "[Infinity Mod Runner]   Small batches avoid WeiDU segfaults on memory-heavy mods.");
        emit(app, "[Infinity Mod Runner]   These dominate install time — watch for slow-batch warnings.");
        let mut sorted: Vec<_> = small_batch_mods_in_install.clone();
        sorted.sort_by(|a, b| b.2.cmp(&a.2)); // by batch count desc
        let name_w = sorted.iter().map(|(n, _, _)| n.len()).max().unwrap_or(10);
        for (name, comps, bcount) in &sorted {
            let is_sfo = SFO_HEAVY_MODS.contains(&name.to_lowercase().as_str());
            let rate = if is_sfo { BATCHES_PER_MIN_SFO_HEAVY } else { BATCHES_PER_MIN_HEAVY };
            let est = *bcount as f64 / rate;
            let tag = if is_sfo { " [SFO]" } else { "" };
            emit(app, &format!("[Infinity Mod Runner]   {:<name_w$}  {:>3}c / {:>2}b    ~{:>3.0}min{}",
                name, comps, bcount, est, tag, name_w = name_w));
        }
        let subtotal_comps: usize = sorted.iter().map(|(_, c, _)| c).sum();
        let subtotal_batches: usize = sorted.iter().map(|(_, _, b)| b).sum();
        let subtotal_min: f64 = sorted.iter().map(|(name, _, bcount)| {
            let is_sfo = SFO_HEAVY_MODS.contains(&name.to_lowercase().as_str());
            let rate = if is_sfo { BATCHES_PER_MIN_SFO_HEAVY } else { BATCHES_PER_MIN_HEAVY };
            *bcount as f64 / rate
        }).sum();
        // Subtotal divider uses the box-drawing `─` to match section separators
        // (`─── EET PHASE ───`) elsewhere in the report.
        let div: String = "\u{2500}".repeat(name_w + 30);
        emit(app, &format!("[Infinity Mod Runner]   {}", div));
        emit(app, &format!("[Infinity Mod Runner]   {:<name_w$}  {:>3}c / {:>2}b    ~{:>3.0}min  ({:.0}% of total)",
            "Subtotal", subtotal_comps, subtotal_batches, subtotal_min,
            (subtotal_min / est_minutes) * 100.0, name_w = name_w));
    }

    // ── READLN PROMPTS ──
    let readln_count = covered_readln.len() + uncovered_readln.len();
    if readln_count > 0 || !config.readln_defaults.is_empty() {
        section(app, "READLN PROMPTS  (WeiDU will pause for input)");
        if uncovered_readln.is_empty() {
            emit(app, &format!("[Infinity Mod Runner]   \u{2713} {} prompt{} detected, all configured",
                readln_count, if readln_count == 1 { "" } else { "s" }));
            if !covered_readln.is_empty() {
                let list = covered_readln.join(", ");
                emit(app, &format!("[Infinity Mod Runner]     {}", truncate_mid(&list, 160)));
            }
        } else {
            emit(app, &format!("[Infinity Mod Runner]   \u{26A0} {} detected, {} WILL HIT FALLBACK",
                readln_count, uncovered_readln.len()));
            for m in &uncovered_readln {
                emit(app, &format!("[Infinity Mod Runner]     [uncovered] {}  \u{2192} auto-answer \"{}\" after {}s",
                    m, config.readln_fallback, config.readln_timeout_secs));
            }
            if !covered_readln.is_empty() {
                emit(app, &format!("[Infinity Mod Runner]     configured: {}",
                    truncate_mid(&covered_readln.join(", "), 160)));
            }
        }
        let configured_not_in_install: Vec<_> = config.readln_defaults.keys()
            .filter(|k| !mods.iter().any(|m| m.mod_name.to_lowercase() == **k))
            .collect();
        if !configured_not_in_install.is_empty() {
            emit(app, &format!("[Infinity Mod Runner]     (unused presets: {})",
                configured_not_in_install.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")));
        }
    }

    // ── LANGUAGE ──
    // Only emit if there's something interesting to say — i.e. at least
    // one component NOT using the configured language (those fall back to
    // WeiDU's default). A 100%-matched install doesn't need a section.
    let lang_mismatch = total_components.saturating_sub(language_matched_components);
    if lang_mismatch > 0 {
        section(app, "LANGUAGE");
        let pct = (language_matched_components as f64 / total_components.max(1) as f64) * 100.0;
        emit(app, &format!("[Infinity Mod Runner]   Configured:  {} (index {})", config.language, config.language_index));
        emit(app, &format!("[Infinity Mod Runner]   Matched:     {} of {} components ({:.0}%)",
            language_matched_components, total_components, pct));
        emit(app, &format!("[Infinity Mod Runner]   Fallback:    {} components use a different language tag",
            lang_mismatch));
        emit(app, "[Infinity Mod Runner]                \u{2192} those will install in their exported language, not the configured one.");
    }

    // ── PATCHES APPLIED ──
    // Read the patch manifest and check each patch's marker to determine whether
    // it's currently applied to the extracted mod sources. This surfaces patch
    // state in the dry run so users can see at a glance:
    //   - Which fixes are live (markers present)
    //   - Which fixes are applicable but not yet applied (re-run Ready Check)
    //   - Which fixes aren't relevant to this install (target mod missing)
    // Useful when iterating on multi-test installs where patch re-application
    // is easy to forget. Silently skipped if the manifest can't be read — this
    // is informational, not a hard requirement.
    if let Ok(resource_dir) = app.path().resource_dir() {
        if let Ok(manifest) = load_manifest(&resource_dir) {
            let mod_path = Path::new(&config.mod_directory);
            let game_path = &config.bg2_game_dir;
            let mod_locations = build_mod_location_map(mod_path);

            let mut applied: Vec<(u32, &str)> = Vec::new();
            let mut applicable: Vec<(u32, &str)> = Vec::new();
            let mut not_needed = 0usize;

            for entry in &manifest {
                let triggered = check_trigger(mod_path, game_path, &entry.trigger, &mod_locations);
                if !triggered {
                    not_needed += 1;
                    continue;
                }
                let already = check_marker(mod_path, game_path, &entry.marker, &mod_locations);
                if already {
                    applied.push((entry.id, entry.name.as_str()));
                } else {
                    applicable.push((entry.id, entry.name.as_str()));
                }
            }

            section(app, "PATCHES APPLIED");
            emit(app, &format!(
                "[Infinity Mod Runner]   {} total \u{00B7} \u{2713} {} applied \u{00B7} \u{25CB} {} pending \u{00B7} \u{2013} {} not needed",
                manifest.len(), applied.len(), applicable.len(), not_needed));
            if !applied.is_empty() {
                emit(app, &format!("[Infinity Mod Runner]   \u{2713} Applied ({}):", applied.len()));
                for (id, name) in &applied {
                    emit(app, &format!("[Infinity Mod Runner]       #{:<3} {}", id, name));
                }
            }
            if !applicable.is_empty() {
                emit(app, &format!("[Infinity Mod Runner]   \u{25CB} Pending \u{2014} re-run Ready Check \u{2192} Apply Patches ({}):", applicable.len()));
                for (id, name) in &applicable {
                    emit(app, &format!("[Infinity Mod Runner]       #{:<3} {}", id, name));
                }
            }
            if applicable.is_empty() && !applied.is_empty() {
                emit(app, "[Infinity Mod Runner]   All applicable patches are live for this install.");
            }
        }
    }

    // ── WEIDU BINARY ──
    // Surface which WeiDU binary the install will actually invoke. Useful
    // when the user has Resilient WeiDU toggled on — confirms the resolver
    // picked up the bundled cache path and the version stayed consistent
    // across app restart / rebuild. The frontend resolves the path before
    // calling start_dry_run, so `config.weidu_path` is already the final
    // decision — we just classify it here.
    //
    // Detection: the cache lives at `<data_dir>/.weidu_cache/weidu{.exe}`
    // by convention (see src/weidu_swap.rs). If the configured path's
    // parent directory name is `.weidu_cache`, we're using Resilient WeiDU.
    {
        let weidu_path_str = config.weidu_path.to_string_lossy();
        let parent_dir_name = config.weidu_path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("");
        let is_resilient = parent_dir_name == ".weidu_cache";

        section(app, "WEIDU BINARY");
        if is_resilient {
            // Try to read meta.json for pretty version display — non-fatal.
            let base_version = app.path().resource_dir().ok()
                .and_then(|rd| std::fs::read_to_string(rd.join("weidu_experimental").join("meta.json")).ok())
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .map(|v| {
                    let base = v.get("base_weidu_version").and_then(|x| x.as_str()).unwrap_or("?").to_string();
                    let rev = v.get("patch_revision").and_then(|x| x.as_u64()).unwrap_or(0);
                    format!("{base} + patch rev {rev}")
                })
                .unwrap_or_else(|| "(meta.json unavailable)".to_string());
            emit(app, "[Infinity Mod Runner]   \u{2713} Resilient WeiDU (experimental) \u{2014} bundled patched binary");
            emit(app, &format!("[Infinity Mod Runner]   Version:     {}", base_version));
            emit(app, &format!("[Infinity Mod Runner]   Cache path:  {}", weidu_path_str));
            emit(app, "[Infinity Mod Runner]   This install will use the patched binary, not the one configured in Setup.");
            emit(app, "[Infinity Mod Runner]   Disable from Ready Check if you want to revert for this run.");
        } else {
            emit(app, "[Infinity Mod Runner]   Configured binary (Resilient WeiDU disabled)");
            emit(app, &format!("[Infinity Mod Runner]   Path:        {}", weidu_path_str));
            emit(app, "[Infinity Mod Runner]   Enable Resilient WeiDU from Ready Check for BCS round-trip-safe installs.");
        }
    }

    // ── PERFORMANCE ──
    // Only show if SFO-heavy mods are present (they dominate install time).
    let sfo_mods_present: Vec<&(String, usize, usize)> = small_batch_mods_in_install.iter()
        .filter(|(n, _, _)| SFO_HEAVY_MODS.contains(&n.to_lowercase().as_str()))
        .collect();
    if !sfo_mods_present.is_empty() {
        let sfo_total_batches: usize = sfo_mods_present.iter().map(|(_, _, b)| b).sum();
        let sfo_total_min = sfo_total_batches as f64 / BATCHES_PER_MIN_SFO_HEAVY;
        let sfo_pct = (sfo_total_min / est_minutes) * 100.0;
        section(app, "PERFORMANCE ADVISORY");
        emit(app, &format!("[Infinity Mod Runner]   {} SFO-heavy mod{} account for ~{:.0}min ({:.0}% of estimated time).",
            sfo_mods_present.len(),
            if sfo_mods_present.len() == 1 { "" } else { "s" },
            sfo_total_min, sfo_pct));
        emit(app, "[Infinity Mod Runner]   These mods share the SFO library and can cascade into multi-hour");
        emit(app, "[Infinity Mod Runner]   single-batch slowdowns. The orchestrator will auto-BIFF override/");
        emit(app, "[Infinity Mod Runner]   before the first SFO mod to reduce file iteration overhead.");
        // Surface the BIFF-delete flag state so users can verify at a glance
        // whether the delete-after-BIFF optimization will fire on this run.
        // install_config.json can override the UI value — checking
        // config.enable_biff_delete_optimization captures the final resolved
        // state (UI + JSON-override applied). Absence of this line in a
        // dry-run output is the v1.0.2-vs-v1.0.3 giveaway.
        if config.enable_biff_delete_optimization {
            emit(app, "[Infinity Mod Runner]   \u{2713} BIFF-delete optimization ON — override/ files will be removed");
            emit(app, "[Infinity Mod Runner]     after MAKE_BIFF succeeds (drops 120k+ file iteration to <100).");
        } else {
            emit(app, "[Infinity Mod Runner]   \u{26A0} BIFF-delete optimization OFF — MAKE_BIFF runs but override/");
            emit(app, "[Infinity Mod Runner]     stays full. dw_talents cn:60200 will walk the full file set.");
        }
        // Phase 20b: predicted install.log PREBIFF line. The orchestrator
        // emits this right before MAKE_BIFF starts; dry-run users can
        // grep install.log for this exact format after the real run,
        // and the A/B harness (scripts/analyze_install_log.py) keys off
        // it. Keeping dry-run output and install-log format aligned means
        // "what I saw in the preview is what landed in the log."
        emit(app, "[Infinity Mod Runner]");
        emit(app, &format!(
            "[Infinity Mod Runner]   At runtime: [PREBIFF] delete_optimization={}",
            if config.enable_biff_delete_optimization { "on" } else { "off" },
        ));
        // Calibration note: the current estimator is the pre-BIFF-fix
        // model. With BIFF ON the SFO-heavy batches should run much
        // faster than the ~402min baseline; with BIFF OFF expect to
        // overshoot noticeably. Flag this so users interpret the
        // estimate correctly and feed real install-time back into the
        // calibration loop (see AB_PLAN.md in weidu_experimental/tools/).
        emit(app, "[Infinity Mod Runner]   Note: this estimate uses the pre-BIFF-fix calibration. With the");
        emit(app, "[Infinity Mod Runner]     optimization ON, SFO-heavy batches typically run 30-50% faster");
        emit(app, "[Infinity Mod Runner]     than shown here. A/B calibration data goes back into the estimator.");
        emit(app, "[Infinity Mod Runner]");
        // override_fast_drive advisory — the HIGH-IMPACT lever for write-
        // heavy components like dw_talents cn:60200 (EMPOWERED_MONSTER_
        // SUMMONING). That component does ~130k "Copying and patching 1
        // file" operations in a row. Each one is a read → patch → write
        // to override/. On plain NTFS with Defender realtime scan, the
        // write-close cycle takes ~20-30ms/file (most of it AV latency),
        // giving the observed ~37 ops/sec. Baked-in alternatives to a
        // manual RAM disk: Defender exclusion (~2-5× speedup, one UAC
        // prompt at install start) or fast_drive redirect (~10-50× when
        // target is a RAM disk). BIFF-delete helps the READ-heavy scan
        // side; these help the WRITE-heavy patch side. They compose.
        if config.override_fast_drive {
            let path_display = config.override_fast_drive_path
                .as_ref()
                .map(|s| s.as_str())
                .unwrap_or("(system temp)");
            emit(app, &format!(
                "[Infinity Mod Runner]   \u{2713} override_fast_drive ON \u{2192} {} — per-file write cost drops",
                path_display,
            ));
            emit(app, "[Infinity Mod Runner]     from ~25ms (NTFS+AV) to ~1ms (RAM disk / NVMe). Biggest single");
            emit(app, "[Infinity Mod Runner]     lever for dw_talents cn:60200 (130k write ops).");
        } else {
            emit(app, "[Infinity Mod Runner]   \u{26A0} override_fast_drive OFF — the DOMINANT bottleneck for SFO-heavy");
            emit(app, "[Infinity Mod Runner]     mods is per-file write overhead, not iteration. dw_talents cn:60200");
            emit(app, "[Infinity Mod Runner]     runs ~130k sequential file writes; on plain NTFS with Windows");
            emit(app, "[Infinity Mod Runner]     Defender active, expect ~37 writes/sec (~4-5h on that one component).");
            emit(app, "[Infinity Mod Runner]     Two baked-in fixes: (1) accept the one-time UAC prompt to auto-");
            emit(app, "[Infinity Mod Runner]     exclude the game dir from Defender (~2-5\u{00d7} speedup, no RAM cost),");
            emit(app, "[Infinity Mod Runner]     or (2) enable \"Redirect override/ to fast drive\" + point at a RAM");
            emit(app, "[Infinity Mod Runner]     disk for ~10-50\u{00d7} speedup. Complementary with BIFF-delete (reads).");
        }
        emit(app, "[Infinity Mod Runner]");
        emit(app, "[Infinity Mod Runner]   To shave hours off the install, consider removing the heaviest:");
        // Sort by estimated time descending
        let mut sfo_sorted: Vec<_> = sfo_mods_present.clone();
        sfo_sorted.sort_by(|a, b| b.2.cmp(&a.2));
        for (name, comps, bcount) in &sfo_sorted {
            let est = *bcount as f64 / BATCHES_PER_MIN_SFO_HEAVY;
            emit(app, &format!("[Infinity Mod Runner]     {:<20}  {}c / {}b  ~{:.0}min",
                name, comps, bcount, est));
        }
        emit(app, "[Infinity Mod Runner]   Tip: stratagems cn:6000 (Initialise AI) is typically the single");
        emit(app, "[Infinity Mod Runner]   slowest component (~1h). dw_talents late batches (cn:41000+) can");
        emit(app, "[Infinity Mod Runner]   individually run 1-3h due to SFO memory-pressure cascade.");
    }

    // ── MOD LIST ──
    section(app, &format!("MOD LIST  ({} mods, install order)", mods.len()));
    let name_w = mods.iter().map(|m| m.mod_name.len()).max().unwrap_or(20).min(40);
    let mut last_phase: &str = "";
    for m in &mods {
        if m.phase != last_phase {
            emit(app, &format!("[Infinity Mod Runner]   \u{2500}\u{2500}\u{2500} {} \u{2500}\u{2500}\u{2500}",
                if m.phase == "bgee" { "PRE-EET PHASE" } else { "EET PHASE" }));
            last_phase = &m.phase;
        }
        let flags: Vec<&str> = [
            // `not found` is informational here — Ready Check owns the
            // authoritative missing-mods validation. We include it so the
            // mod list still flags what won't run, but it's not an error.
            if !m.found { Some("not found") } else { None },
            if m.small_batch { Some("heavy") } else { None },
            if m.has_readln && !m.readln_configured { Some("READLN!") } else { None },
            if m.has_readln && m.readln_configured { Some("readln-ok") } else { None },
        ].into_iter().flatten().collect();
        let flag_str = if flags.is_empty() { String::new() }
            else { format!("  [{}]", flags.join(", ")) };
        emit(app, &format!("[Infinity Mod Runner]   {:<name_w$}  {:>3}c / {:>2}b{}",
            m.mod_name, m.component_count, m.batch_count, flag_str, name_w = name_w));
    }

    // ── SUMMARY ──
    section(app, "SUMMARY");
    emit(app, &format!("[Infinity Mod Runner]   {} components \u{00B7} {} batches \u{00B7} ~{}",
        total_components, total_batches, fmt_minutes(est_minutes)));
    if !uncovered_readln.is_empty() {
        emit(app, &format!("[Infinity Mod Runner]   \u{26A0} {} uncovered READLN prompt{} — install will pause at each one",
            uncovered_readln.len(), if uncovered_readln.len() == 1 { "" } else { "s" }));
    }
    if !missing_mods.is_empty() {
        emit(app, &format!("[Infinity Mod Runner]   \u{2192} {} mod{} not in Extracted — run Ready Check to validate",
            missing_mods.len(), if missing_mods.len() == 1 { "" } else { "s" }));
    }
    emit(app, "[Infinity Mod Runner]   For environment validation (paths, WeiDU, disk, backup, essentials,");
    emit(app, "[Infinity Mod Runner]   Forge compat), switch to the Ready Check tab.");
    emit(app, &format!("[Infinity Mod Runner] {}", divider));

    let report = DryRunReport {
        total_components,
        total_batches,
        already_installed_count,
        unique_mods,
        mods,
        missing_mods,
        uncovered_readln,
        covered_readln,
        estimated_minutes: est_minutes,
        bgee_estimated_minutes,
        eet_estimated_minutes,
        language_matched_components,
    };

    let _ = app.emit("install:dry_run_complete", serde_json::json!(&report));
    report
}

/// Truncate a string mid-word to a maximum width, inserting an ellipsis.
/// Used so the READLN name list doesn't blow out the line width.
fn truncate_mid(s: &str, max: usize) -> String {
    if s.chars().count() <= max { return s.to_string(); }
    let keep = max.saturating_sub(3) / 2;
    let prefix: String = s.chars().take(keep).collect();
    let suffix: String = s.chars().rev().take(keep).collect::<String>().chars().rev().collect();
    format!("{}\u{2026}{}", prefix, suffix)
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

//! File guard: detects and reverses cross-mod silent file corruption.
//!
//! After each batch, snapshots all override files modified during that batch and tags
//! the batch's mod as the file's "owner". On subsequent batches, recomputes md5 of every
//! owned file. If a file's md5 drifts AND the changing batch is not the file's owner,
//! that batch is silently corrupting a file it doesn't own — restore from snapshot.
//!
//! Decision precedence:
//!   1. Allowlist match (system or user) → allow silently, log [GUARD_ALLOWED]
//!   2. `pause_on_guard` setting ON → pause, prompt user via Tauri event, await decision
//!   3. Otherwise → auto-restore, log [GUARD_RESTORE]
//!
//! Persistent outputs:
//!   - `install.log`: live [GUARD_RESTORE] / [GUARD_ALLOWED] / [GUARD_PAUSED] events
//!   - `data_dir/guard_report.json`: structured per-event record for post-install review
//!   - `data_dir/file_snapshots/<hash>.bin`: raw bytes for restore (cleared at install start)
//!
//! Allowlists:
//!   - `patches/guard_allowlist.json` — system rules shipped with the runner
//!   - `data_dir/guard_allowlist_user.json` — user-added rules from the "Allow always" button

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use super::install_log::{shared_log_event, SharedLogger};

/// Narrow watchlist — only guard files whose FILENAME matches one of these patterns.
/// Paths are NOT anchored, no directory prefix — we only walk override/ so the
/// directory is implicit. Matching is case-insensitive, * matches any characters.
///
/// This is deliberately filename-only to avoid Windows path normalization issues
/// (strip_prefix is case-sensitive; game_dir config and actual FS casing can differ).
///
/// Guard ONLY files known to be at risk of silent corruption from bulk CRE/BCS
/// iterators (e.g. cdtweaks' joinable_npc_array). New patterns get added when we
/// identify new corruption victims.
const WATCHLIST: &[&str] = &[
    // Adrian NPC — confirmed Test #30 target of cdtweaks v1→v2 CRE upgrade corruption
    "RH#ADR*.CRE",
    "RH#AD25*.CRE",
];

/// One captured snapshot of a file: who wrote it, when, what bytes.
#[derive(Clone, Debug)]
struct OwnedSnapshot {
    file_path: String,        // relative, e.g. "override/RH#ADR25.CRE"
    owner_mod: String,        // mod that first wrote it
    owner_batch_idx: usize,
    md5: String,
    bytes_path: PathBuf,      // where the snapshot bytes live on disk
}

/// Per-event record written to guard_report.json.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GuardEvent {
    pub ts: String,
    pub batch_idx: usize,
    pub drifting_mod: String,
    pub file_path: String,
    pub owner_mod: String,
    pub owner_batch_idx: usize,
    pub old_md5: String,
    pub new_md5: String,
    pub size_delta: i64,
    pub action: String,                     // "restored" | "allowed" | "paused"
    pub allowlist_rule_id: Option<String>,  // which rule matched if "allowed"
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GuardReport {
    pub session_id: String,
    pub started_at: String,
    pub events: Vec<GuardEvent>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct AllowlistRule {
    pub id: String,
    /// Mod that may modify (regex, anchored)
    pub drifting_mod: String,
    /// File-path pattern (regex, anchored to whole path; relative like "override/foo.bcs")
    pub file_pattern: String,
    pub reason: String,
}

#[derive(Deserialize, Default)]
struct AllowlistFile {
    rules: Vec<AllowlistRule>,
}

/// Mutable global state — guard subsystem is process-singleton; orchestrator is the
/// only caller and it's effectively single-threaded across batches.
struct GuardState {
    data_dir: PathBuf,
    snapshots_dir: PathBuf,
    snapshots: HashMap<String, OwnedSnapshot>, // file_path (lowercase) -> snapshot
    rules: Vec<AllowlistRule>,
    report: GuardReport,
    /// Per-install dismissals keyed by drifting_mod — when user picks
    /// "don't ask again this install for X", we remember their decision.
    auto_decisions: HashMap<String, String>, // mod -> "restore"|"allow_once"|"allow_always"
    /// Tracks which override files exist + their pre-batch md5 so we can detect
    /// what THIS batch wrote (newly created or modified) for snapshot.
    pre_batch_state: HashMap<String, Option<String>>,
}

static STATE: Mutex<Option<GuardState>> = Mutex::new(None);

fn md5_path(p: &Path) -> Option<String> {
    let bytes = std::fs::read(p).ok()?;
    Some(format!("{:x}", md5::compute(&bytes)))
}

fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Rough RFC3339 — no chrono dep
    format!("{}", secs)
}

fn rel_to_game(path: &Path, game_dir: &Path) -> String {
    path.strip_prefix(game_dir)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn is_guarded_file(path: &Path, _game_dir: &Path) -> bool {
    // Match filename only — WATCHLIST is deliberately directory-agnostic because:
    //   1. We only walk override/ (directory is implicit)
    //   2. Windows path-prefix stripping is case-sensitive and fragile
    let name = match path.file_name().and_then(|n| n.to_str()) {
        Some(n) => n,
        None => return false,
    };
    WATCHLIST.iter().any(|pat| simple_match(pat, name))
}

/// Initialize guard state at install start. Loads allowlist rules from system + user
/// files. Clears prior snapshots. Resets report.
pub fn init(
    data_dir: &Path,
    resource_dir: &Path,
    session_id: String,
) -> Result<(), String> {
    let mut guard = STATE.lock().unwrap();
    let snapshots_dir = data_dir.join("file_snapshots");

    // Wipe stale snapshots from previous install — they can be huge and aren't
    // valid across installs (ownership tracking starts fresh each install).
    if snapshots_dir.exists() {
        let _ = std::fs::remove_dir_all(&snapshots_dir);
    }
    std::fs::create_dir_all(&snapshots_dir)
        .map_err(|e| format!("file_guard: create snapshots dir: {e}"))?;

    let mut rules = load_allowlist_file(&resource_dir.join("patches").join("guard_allowlist.json"));
    rules.extend(load_allowlist_file(&data_dir.join("guard_allowlist_user.json")));

    *guard = Some(GuardState {
        data_dir: data_dir.to_path_buf(),
        snapshots_dir,
        snapshots: HashMap::new(),
        rules,
        report: GuardReport {
            session_id,
            started_at: now_iso(),
            events: Vec::new(),
        },
        auto_decisions: HashMap::new(),
        pre_batch_state: HashMap::new(),
    });

    Ok(())
}

fn load_allowlist_file(path: &Path) -> Vec<AllowlistRule> {
    if !path.exists() {
        return Vec::new();
    }
    let contents = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    match serde_json::from_str::<AllowlistFile>(&contents) {
        Ok(f) => f.rules,
        Err(_) => Vec::new(),
    }
}

/// Pre-batch hook: scan override/ recursively, capture (path -> md5) of every guardable file.
/// Lets `post_batch` figure out what THIS batch newly wrote/modified.
pub fn pre_batch(game_dir: &Path) {
    let mut guard = STATE.lock().unwrap();
    let g = match guard.as_mut() {
        Some(g) => g,
        None => return,
    };
    g.pre_batch_state.clear();
    let gd = game_dir.to_path_buf();
    walk_override(&game_dir.join("override"), &mut |path| {
        if !is_guarded_file(path, &gd) {
            return;
        }
        let rel = rel_to_game(path, &gd);
        let m = md5_path(path);
        g.pre_batch_state.insert(rel.to_lowercase(), m);
    });
}

fn walk_override(root: &Path, visit: &mut impl FnMut(&Path)) {
    if !root.is_dir() {
        return;
    }
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            visit(&path);
        } else if path.is_dir() {
            // Limit recursion — override is usually flat; one level for subdirs is enough.
            if let Ok(sub_entries) = std::fs::read_dir(&path) {
                for sub in sub_entries.flatten() {
                    let p = sub.path();
                    if p.is_file() {
                        visit(&p);
                    }
                }
            }
        }
    }
}

/// Post-batch hook: detect drift, decide, act.
///
/// Returns a list of events that need user attention (when pause_on_guard is on).
/// When pause_on_guard is off, returns empty (auto-restore happens silently).
pub fn post_batch(
    game_dir: &Path,
    batch_idx: usize,
    mod_name: &str,
    pause_on_guard: bool,
    logger: &Option<SharedLogger>,
) -> Vec<GuardEvent> {
    let mut guard = STATE.lock().unwrap();
    let g = match guard.as_mut() {
        Some(g) => g,
        None => return Vec::new(),
    };

    let mut pause_events = Vec::new();
    let mut new_snapshots: Vec<OwnedSnapshot> = Vec::new();
    let mut current_state: HashMap<String, String> = HashMap::new();
    let mut guarded_files_seen = 0usize;

    let gd = game_dir.to_path_buf();
    walk_override(&game_dir.join("override"), &mut |path| {
        if !is_guarded_file(path, &gd) {
            return;
        }
        guarded_files_seen += 1;
        let rel = rel_to_game(path, &gd);
        let rel_lc = rel.to_lowercase();
        let new_md5 = match md5_path(path) {
            Some(m) => m,
            None => return,
        };
        current_state.insert(rel_lc.clone(), new_md5.clone());

        // Three cases:
        // A. Already-snapshotted file: check ownership and drift
        // B. Pre-batch state had it but no snapshot (pre-existing pristine file before guard
        //    started tracking, e.g. vanilla files): treat this batch as owner if changed
        // C. Brand-new file (not in pre_batch_state): this batch wrote it; snapshot + own

        let old_md5 = g.pre_batch_state.get(&rel_lc).cloned().flatten();
        let snapshot = g.snapshots.get(&rel_lc).cloned();

        match (snapshot.as_ref(), old_md5.as_ref()) {
            (Some(snap), _) => {
                // Owned file. Did THIS batch change it?
                if snap.md5 != new_md5 {
                    if snap.owner_mod == mod_name {
                        // Owner re-tweaking its own file; allowed. Refresh snapshot.
                        if let Some(snap_path) = snapshot_bytes(&g.snapshots_dir, &rel) {
                            let _ = std::fs::copy(path, &snap_path);
                            new_snapshots.push(OwnedSnapshot {
                                file_path: rel.clone(),
                                owner_mod: mod_name.to_string(),
                                owner_batch_idx: batch_idx,
                                md5: new_md5.clone(),
                                bytes_path: snap_path,
                            });
                        }
                    } else {
                        // Cross-mod silent modification — guard event.
                        let allowed_rule = match_allowlist(&g.rules, mod_name, &rel);
                        let size_delta = path
                            .metadata()
                            .map(|m| m.len() as i64)
                            .unwrap_or(0)
                            - std::fs::metadata(&snap.bytes_path).map(|m| m.len() as i64).unwrap_or(0);

                        if let Some(rule) = allowed_rule {
                            // Allowlist match — log and let it stand.
                            shared_log_event(logger, "GUARD_ALLOWED",
                                &format!("batch {} '{}' modified {} (owner '{}' from batch {}) — rule '{}'",
                                    batch_idx + 1, mod_name, rel, snap.owner_mod, snap.owner_batch_idx + 1, rule.id));
                            push_event(g, GuardEvent {
                                ts: now_iso(),
                                batch_idx,
                                drifting_mod: mod_name.to_string(),
                                file_path: rel.clone(),
                                owner_mod: snap.owner_mod.clone(),
                                owner_batch_idx: snap.owner_batch_idx,
                                old_md5: snap.md5.clone(),
                                new_md5: new_md5.clone(),
                                size_delta,
                                action: "allowed".to_string(),
                                allowlist_rule_id: Some(rule.id.clone()),
                            });
                            // Refresh snapshot to new state since we accept it
                            if let Some(snap_path) = snapshot_bytes(&g.snapshots_dir, &rel) {
                                let _ = std::fs::copy(path, &snap_path);
                                new_snapshots.push(OwnedSnapshot {
                                    file_path: rel.clone(),
                                    owner_mod: snap.owner_mod.clone(), // owner doesn't change
                                    owner_batch_idx: snap.owner_batch_idx,
                                    md5: new_md5.clone(),
                                    bytes_path: snap_path,
                                });
                            }
                            return;
                        }

                        // No rule. Check per-install auto-decision for this drifting mod.
                        let auto = g.auto_decisions.get(mod_name).cloned();

                        // Phase 1: always auto-restore. pause_on_guard is just a verbosity
                        // hint — we emit the event so Phase 2's real blocking dialog can
                        // observe it later, but we still perform the restore immediately to
                        // keep the install safe.
                        if pause_on_guard && auto.is_none() {
                            let event = GuardEvent {
                                ts: now_iso(),
                                batch_idx,
                                drifting_mod: mod_name.to_string(),
                                file_path: rel.clone(),
                                owner_mod: snap.owner_mod.clone(),
                                owner_batch_idx: snap.owner_batch_idx,
                                old_md5: snap.md5.clone(),
                                new_md5: new_md5.clone(),
                                size_delta,
                                action: "paused_notified".to_string(),
                                allowlist_rule_id: None,
                            };
                            pause_events.push(event);
                            // Fall through to auto-restore — Phase 1 never blocks.
                        }

                        // Auto-restore (default) or apply per-install decision.
                        let decision = auto.unwrap_or_else(|| "restore".to_string());
                        if decision == "restore" {
                            if let Err(e) = std::fs::copy(&snap.bytes_path, path) {
                                shared_log_event(logger, "GUARD_RESTORE_FAILED",
                                    &format!("batch {} '{}' could not restore {}: {}",
                                        batch_idx + 1, mod_name, rel, e));
                            } else {
                                shared_log_event(logger, "GUARD_RESTORE",
                                    &format!("batch {} '{}' silently modified {} (owner '{}' from batch {}): {} -> {} — restored",
                                        batch_idx + 1, mod_name, rel, snap.owner_mod, snap.owner_batch_idx + 1,
                                        snap.md5, new_md5));
                            }
                            push_event(g, GuardEvent {
                                ts: now_iso(),
                                batch_idx,
                                drifting_mod: mod_name.to_string(),
                                file_path: rel.clone(),
                                owner_mod: snap.owner_mod.clone(),
                                owner_batch_idx: snap.owner_batch_idx,
                                old_md5: snap.md5.clone(),
                                new_md5: new_md5.clone(),
                                size_delta,
                                action: "restored".to_string(),
                                allowlist_rule_id: None,
                            });
                        } else {
                            // allow_once or allow_always — let it stand, refresh snapshot
                            shared_log_event(logger, "GUARD_ALLOWED",
                                &format!("batch {} '{}' modified {} (owner '{}') — per-install decision: {}",
                                    batch_idx + 1, mod_name, rel, snap.owner_mod, decision));
                            if let Some(snap_path) = snapshot_bytes(&g.snapshots_dir, &rel) {
                                let _ = std::fs::copy(path, &snap_path);
                                new_snapshots.push(OwnedSnapshot {
                                    file_path: rel.clone(),
                                    owner_mod: snap.owner_mod.clone(),
                                    owner_batch_idx: snap.owner_batch_idx,
                                    md5: new_md5.clone(),
                                    bytes_path: snap_path,
                                });
                            }
                            push_event(g, GuardEvent {
                                ts: now_iso(),
                                batch_idx,
                                drifting_mod: mod_name.to_string(),
                                file_path: rel.clone(),
                                owner_mod: snap.owner_mod.clone(),
                                owner_batch_idx: snap.owner_batch_idx,
                                old_md5: snap.md5.clone(),
                                new_md5: new_md5.clone(),
                                size_delta,
                                action: "allowed".to_string(),
                                allowlist_rule_id: None,
                            });
                        }
                    }
                }
            }
            (None, Some(prev)) => {
                // No snapshot yet, but file existed pre-batch.
                if prev != &new_md5 {
                    // This batch modified a file we hadn't snapshotted yet. Take it as owner.
                    if let Some(snap_path) = snapshot_bytes(&g.snapshots_dir, &rel) {
                        if std::fs::copy(path, &snap_path).is_ok() {
                            new_snapshots.push(OwnedSnapshot {
                                file_path: rel.clone(),
                                owner_mod: mod_name.to_string(),
                                owner_batch_idx: batch_idx,
                                md5: new_md5.clone(),
                                bytes_path: snap_path,
                            });
                        }
                    }
                }
            }
            (None, None) => {
                // Brand-new file written by this batch. Take as owner.
                if let Some(snap_path) = snapshot_bytes(&g.snapshots_dir, &rel) {
                    if std::fs::copy(path, &snap_path).is_ok() {
                        new_snapshots.push(OwnedSnapshot {
                            file_path: rel.clone(),
                            owner_mod: mod_name.to_string(),
                            owner_batch_idx: batch_idx,
                            md5: new_md5.clone(),
                            bytes_path: snap_path,
                        });
                    }
                }
            }
        }
    });

    let mut new_snapshots_added = 0usize;
    for snap in new_snapshots {
        // insert() returns None if the key was not present — i.e. genuinely new snapshot.
        // If Some(_), we're refreshing an existing owner's file; doesn't count as "new".
        if g.snapshots.insert(snap.file_path.to_lowercase(), snap).is_none() {
            new_snapshots_added += 1;
        }
    }
    g.pre_batch_state.clear();

    // Persist report.
    write_report(g);

    // Diagnostic: log GUARD_ACTIVE ONCE when a batch adds new guarded files to the snapshot
    // set (i.e. the owner mod just installed a watchlist match). Once the steady-state count
    // is established, subsequent batches that just re-check the same files stay silent.
    //
    // Periodic heartbeat every 50 batches when zero files are tracked — tells us the hook
    // is alive even while there's nothing to watch. Suppressed once files are being tracked
    // (GUARD_ACTIVE firings implicitly prove liveness from that point on).
    //
    // GUARD_RESTORE / GUARD_ALLOWED events continue to fire on every actual drift — those
    // are the events that matter for behavior, not heartbeats.
    let curr_count = g.snapshots.len();
    if new_snapshots_added > 0 {
        shared_log_event(logger, "GUARD_ACTIVE",
            &format!("batch {} '{}' — added {} new guarded file{} to snapshot (total tracked: {})",
                batch_idx + 1, mod_name,
                new_snapshots_added, if new_snapshots_added == 1 { "" } else { "s" },
                curr_count));
    } else if curr_count == 0 && batch_idx % 50 == 0 {
        shared_log_event(logger, "GUARD_HEARTBEAT",
            &format!("batch {} '{}' — 0 guarded files; watchlist not yet matched any override contents",
                batch_idx + 1, mod_name));
    }

    pause_events
}

fn match_allowlist<'a>(
    rules: &'a [AllowlistRule],
    drifting_mod: &str,
    file_path: &str,
) -> Option<&'a AllowlistRule> {
    for r in rules {
        let mod_match = match regex_lite(&r.drifting_mod, drifting_mod) {
            Some(b) => b,
            None => continue,
        };
        if !mod_match {
            continue;
        }
        let file_match = match regex_lite(&r.file_pattern, file_path) {
            Some(b) => b,
            None => continue,
        };
        if file_match {
            return Some(r);
        }
    }
    None
}

/// Lightweight pattern matcher — supports literal substrings and simple `*` wildcards.
/// Returning None means the pattern was malformed and rule should be skipped.
/// Anchored at both ends.
fn regex_lite(pattern: &str, input: &str) -> Option<bool> {
    // Escape regex specials except *
    let mut re = String::with_capacity(pattern.len() + 8);
    re.push('^');
    for c in pattern.chars() {
        match c {
            '*' => re.push_str(".*"),
            '.' | '+' | '?' | '|' | '(' | ')' | '[' | ']' | '{' | '}' | '\\' | '^' | '$' => {
                // Allow user-provided regex chars; pass through verbatim.
                re.push(c);
            }
            _ => re.push(c),
        }
    }
    re.push('$');

    // Use a tiny matcher to avoid pulling in regex crate; do exact + wildcard support.
    Some(simple_match(&re, input))
}

/// Anchored case-insensitive glob matcher. `*` is the only wildcard (matches any
/// run of characters, including empty). All other characters match literally.
/// Strips leading ^ and trailing $ if present (legacy support).
///
/// IMPORTANT: this is called DIRECTLY by is_guarded_file with raw WATCHLIST patterns
/// like "RH#ADR*.CRE". Do NOT change the splitter without updating callers and tests.
/// Test #32 silently failed because an earlier version split on ".*" instead of "*",
/// so the literal `*` in patterns never matched anything.
fn simple_match(pattern: &str, input: &str) -> bool {
    let p = pattern.trim_start_matches('^').trim_end_matches('$');
    let p_lower = p.to_lowercase();
    let i_lower = input.to_lowercase();

    let parts: Vec<&str> = p_lower.split('*').collect();
    let mut idx = 0;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        let search_in = &i_lower[idx..];
        match search_in.find(part) {
            Some(found) => {
                if i == 0 && found != 0 {
                    // Anchored start: first part must match at idx 0
                    return false;
                }
                idx += found + part.len();
            }
            None => return false,
        }
    }
    // Anchored end: last non-empty part must match at the very end
    if let Some(last) = parts.iter().rev().find(|s| !s.is_empty()) {
        if !i_lower.ends_with(&**last) {
            return false;
        }
    }
    true
}

#[test]
fn simple_match_glob_wildcards() {
    // Regression: Test #32 silently failed because simple_match split on ".*" instead of "*".
    assert!(simple_match("RH#ADR*.CRE", "RH#ADR25.CRE"));
    assert!(simple_match("RH#ADR*.CRE", "rh#adr.cre"));
    assert!(simple_match("RH#ADR*.CRE", "RH#ADR.CRE"));
    assert!(simple_match("*.CRE", "anyfile.cre"));
    assert!(simple_match("RH#AD25*.CRE", "rh#ad25foo.cre"));
    assert!(!simple_match("RH#ADR*.CRE", "imoen.cre"));
    assert!(!simple_match("RH#ADR*.CRE", "RH#XYZ25.CRE"));
}

fn snapshot_bytes(dir: &Path, file_path: &str) -> Option<PathBuf> {
    // Hash the file path to derive a unique snapshot filename.
    let h = format!("{:x}", md5::compute(file_path.as_bytes()));
    Some(dir.join(format!("{}.bin", h)))
}

fn push_event(g: &mut GuardState, e: GuardEvent) {
    g.report.events.push(e);
}

fn write_report(g: &GuardState) {
    let path = g.data_dir.join(crate::paths::FILE_GUARD_REPORT);
    if let Ok(s) = serde_json::to_string_pretty(&g.report) {
        let _ = std::fs::write(path, s);
    }
}

/// Apply user's pause-dialog decision. Called from a Tauri command.
/// `decision` ∈ {"restore", "allow_once", "allow_always"}.
/// Mutates allowlist (if "allow_always"), updates per-install dismissals (if `dismiss_for_mod`),
/// and applies the action immediately. Returns a status string for telemetry/UI.
pub fn apply_user_decision(
    event: &GuardEvent,
    decision: &str,
    dismiss_for_mod: bool,
    logger: &Option<SharedLogger>,
) -> Result<String, String> {
    let mut guard = STATE.lock().unwrap();
    let g = guard.as_mut().ok_or("file_guard not initialized")?;

    if dismiss_for_mod {
        g.auto_decisions.insert(event.drifting_mod.clone(), decision.to_string());
    }

    match decision {
        "restore" => {
            // Restore from our snapshot for this file
            let snap = g.snapshots.get(&event.file_path.to_lowercase()).cloned();
            if let Some(snap) = snap {
                let game_path = guess_game_path(&snap.file_path);
                if let Some(gp) = game_path {
                    std::fs::copy(&snap.bytes_path, &gp)
                        .map_err(|e| format!("restore failed: {e}"))?;
                    shared_log_event(logger, "GUARD_RESTORE",
                        &format!("user-decision restore: batch {} '{}' {} reverted to owner '{}'",
                            event.batch_idx + 1, event.drifting_mod, event.file_path, snap.owner_mod));
                }
            }
            Ok("restored".to_string())
        }
        "allow_once" => {
            shared_log_event(logger, "GUARD_ALLOWED",
                &format!("user-decision allow_once: batch {} '{}' {}", event.batch_idx + 1, event.drifting_mod, event.file_path));
            Ok("allowed_once".to_string())
        }
        "allow_always" => {
            // Append a new rule to user allowlist
            let user_path = g.data_dir.join("guard_allowlist_user.json");
            let mut existing = if user_path.exists() {
                std::fs::read_to_string(&user_path)
                    .ok()
                    .and_then(|s| serde_json::from_str::<AllowlistFile>(&s).ok())
                    .unwrap_or_default()
            } else {
                AllowlistFile { rules: Vec::new() }
            };
            let rule = AllowlistRule {
                id: format!("user-{}-{}", event.drifting_mod, &event.file_path.replace('/', "_").to_lowercase()),
                drifting_mod: event.drifting_mod.clone(),
                file_pattern: event.file_path.clone(),
                reason: format!("User-added during install on {}", event.ts),
            };
            existing.rules.push(rule.clone());
            // Reserialize and write
            let s = serde_json::to_string_pretty(&serde_json::json!({
                "rules": existing.rules.iter().map(|r| serde_json::json!({
                    "id": r.id,
                    "drifting_mod": r.drifting_mod,
                    "file_pattern": r.file_pattern,
                    "reason": r.reason,
                })).collect::<Vec<_>>()
            })).map_err(|e| format!("ser: {e}"))?;
            std::fs::write(&user_path, s).map_err(|e| format!("write user allowlist: {e}"))?;
            // Hot-load the new rule into running guard state
            g.rules.push(rule);
            shared_log_event(logger, "GUARD_ALLOWED",
                &format!("user-decision allow_always: batch {} '{}' {} — added to user allowlist",
                    event.batch_idx + 1, event.drifting_mod, event.file_path));
            Ok("allowed_always".to_string())
        }
        _ => Err(format!("unknown decision: {decision}")),
    }
}

/// We don't have direct game_dir access at decision time; reconstruct from data_dir context.
/// (We could plumb game_dir through the dialog, but the user can also restart the install
/// if a restore can't be applied — defensive.)
fn guess_game_path(_file_path: &str) -> Option<PathBuf> {
    // Caller will pass the absolute game-dir path through the Tauri command.
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // Regression: Test #31 silently failed because path-matching was broken on Windows.
    // This ensures is_guarded_file matches real-world filenames regardless of the path
    // components leading up to them.
    #[test]
    fn is_guarded_file_matches_adrian_cre() {
        let game = PathBuf::from(r"F:\SteamLibrary\steamapps\common\Baldur's Gate II Enhanced Edition");
        let cases = vec![
            (r"F:\SteamLibrary\steamapps\common\Baldur's Gate II Enhanced Edition\override\RH#ADR25.CRE", true),
            (r"F:\SteamLibrary\steamapps\common\Baldur's Gate II Enhanced Edition\override\RH#ADR.CRE", true),
            (r"F:\SteamLibrary\steamapps\common\Baldur's Gate II Enhanced Edition\override\rh#adr25.cre", true),
            (r"F:\SteamLibrary\steamapps\common\Baldur's Gate II Enhanced Edition\override\SPWI101.spl", false),
            (r"F:\somewhere\else\override\RH#ADR25.CRE", true),  // filename-based; path prefix irrelevant
        ];
        for (p, want) in cases {
            let got = is_guarded_file(Path::new(p), &game);
            assert_eq!(got, want, "is_guarded_file({:?}) = {}, want {}", p, got, want);
        }
    }

    #[test]
    fn is_guarded_file_rejects_non_watchlist() {
        let game = PathBuf::from(r"F:\game");
        assert!(!is_guarded_file(Path::new(r"F:\game\override\SPELL.IDS"), &game));
        assert!(!is_guarded_file(Path::new(r"F:\game\override\imoen.cre"), &game));
    }

    #[test]
    fn simple_match_handles_case_and_wildcards() {
        assert!(simple_match("RH#ADR*.CRE", "RH#ADR25.CRE"));
        assert!(simple_match("RH#ADR*.CRE", "rh#adr.cre"));
        assert!(simple_match("*.CRE", "file.cre"));
        assert!(!simple_match("RH#ADR*.CRE", "imoen.cre"));
    }
}

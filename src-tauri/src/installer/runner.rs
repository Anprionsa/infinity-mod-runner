//! Process runner — spawns WeiDU, pipes I/O, handles interactive prompts.

use super::{Batch, ComponentResult, ComponentStatus, InstallConfig, EET_AUTO_FILL_TRIGGER};
use super::engine::{build_weidu_command, clean_path};
use super::install_log::SharedLogger;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use tauri::{AppHandle, Emitter};

/// Global stdin handle for the currently running WeiDU process.
/// Stored globally so the GUI can send input via a Tauri command.
static WEIDU_STDIN: Mutex<Option<std::process::ChildStdin>> = Mutex::new(None);
static WEIDU_PID: Mutex<Option<u32>> = Mutex::new(None);

/// Prompt coordination — prevents auto-response and GUI input from racing.
/// Tracks when a prompt was forwarded to the GUI, enabling timeout-based auto-answer.
static PROMPT_FORWARDED_AT: Mutex<Option<std::time::Instant>> = Mutex::new(None);
/// Guard to prevent both timeout thread and GUI input from answering the same prompt.
static PROMPT_ANSWER_SENT: AtomicBool = AtomicBool::new(false);

fn set_prompt_forwarded() {
    if let Ok(mut lock) = PROMPT_FORWARDED_AT.lock() {
        *lock = Some(std::time::Instant::now());
    }
    PROMPT_ANSWER_SENT.store(false, Ordering::SeqCst);
}

fn clear_prompt_forwarded() {
    if let Ok(mut lock) = PROMPT_FORWARDED_AT.lock() {
        *lock = None;
    }
}

fn is_prompt_forwarded() -> bool {
    PROMPT_FORWARDED_AT.lock().ok()
        .map(|lock| lock.is_some())
        .unwrap_or(false)
}

/// Per-batch component timing state — used by the stdout reader thread to
/// attribute WeiDU's SUCCESSFULLY INSTALLED / INSTALLED WITH WARNINGS /
/// NOT INSTALLED DUE TO ERRORS lines to the component at the matching
/// index in the batch. Emits `install:component_done` events with
/// per-component wall-clock durations for the Runner's measurement trace.
///
/// Also holds the per-component stdout-observed outcome (`observed`) so
/// `run_batch` can downgrade individual components from Success to Warning
/// when WeiDU printed "installed with warnings" for them. Without this,
/// batches where WeiDU exits 0 but one component warned were reported as
/// blanket Success — the warning never reached the Issues panel. See
/// `build_results_from_observed` below.
struct ComponentTimer {
    components: Vec<super::Component>,
    next_idx: usize,
    last_end: std::time::Instant,
    /// Parallel to `components`: what WeiDU's stdout reported for each.
    /// None = no completion line seen (e.g. batch died before this
    /// component ran). "success" | "warning" | "error" otherwise.
    observed: Vec<Option<&'static str>>,
    /// Parallel to `components`: raw `WARNING:` lines observed in WeiDU
    /// stdout while the component was installing. We push into slot
    /// `next_idx` — warnings always appear BEFORE the corresponding
    /// "SUCCESSFULLY INSTALLED" line that advances the index — so the
    /// lines attributed to component N are the ones WeiDU printed while
    /// working on N. Capped at MAX_WARN_PER_COMPONENT lines to bound the
    /// IPC payload on pathological mods that emit thousands of warns.
    warnings: Vec<Vec<String>>,
}

/// Hard ceiling on captured warnings per component. A pathological mod can
/// emit tens of thousands of warn lines (Trap Overhaul's 256-slot IDS loop
/// was a recent example). Beyond this we keep the first N and add a
/// "...truncated" marker so the UI knows the list was clipped; dropping
/// the rest keeps the serialized batch_done payload from ballooning past
/// a few MB in the megainstall worst case.
const MAX_WARN_PER_COMPONENT: usize = 50;

/// Classify a WeiDU output line as a component-complete line and return
/// the normalized status. None means not a component-complete line.
fn classify_component_line(ll: &str) -> Option<&'static str> {
    if ll.contains("successfully installed") {
        Some("success")
    } else if ll.contains("installed with warnings") {
        Some("warning")
    } else if ll.contains("not installed due to") {
        // "NOT INSTALLED DUE TO ERRORS" - real failure
        // "NOT INSTALLED DUE TO ACTION_IF" etc. - skipped-by-predicate
        // Both report the same way; batch_done has the authoritative
        // classification. For timing purposes the distinction doesn't matter.
        Some("error")
    } else {
        None
    }
}

/// Return true if a WeiDU stdout line is a WARNING: diagnostic we want to
/// capture for later classification. Matches the common WeiDU shapes:
///   "WARNING: ..."
///   "WARNING [file.tra]: ..."
///   "  WARNING: ..." (leading whitespace)
/// Case-insensitive. Excludes the "installed with warnings" summary line
/// (that's already captured by `classify_component_line` as a status
/// indicator, not a diagnostic).
fn is_warning_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    let lo = trimmed.to_ascii_lowercase();
    // The literal verb "warning" must start a line (after whitespace) and
    // be followed by a delimiter (:, [, whitespace). Otherwise we'd match
    // prose like "WARNING enemies spotted" in mod install chatter.
    if !lo.starts_with("warning") {
        return false;
    }
    let after = &lo[7..]; // everything after "warning"
    // Require a punctuation or bracket to follow — eliminates false
    // matches like "warnings produced" in summary lines.
    let next = after.chars().next();
    matches!(next, Some(':') | Some(' ') | Some('[') | Some('(') | Some('\t'))
        && !lo.contains("installed with warnings")
}

/// Capture a WARNING line against the component currently installing.
/// Attributes to slot `next_idx` — warnings always precede the
/// SUCCESSFULLY INSTALLED / INSTALLED WITH WARNINGS line that advances
/// that index. Caps at MAX_WARN_PER_COMPONENT; beyond that, pushes a
/// truncation marker once and drops the rest so pathological logs don't
/// inflate the IPC payload.
fn capture_warning(timer: &Arc<Mutex<ComponentTimer>>, line: &str) {
    let Ok(mut t) = timer.lock() else { return };
    let idx = t.next_idx;
    if idx >= t.warnings.len() { return; }
    let list = &mut t.warnings[idx];
    if list.len() < MAX_WARN_PER_COMPONENT {
        list.push(line.to_string());
    } else if list.len() == MAX_WARN_PER_COMPONENT {
        // Push exactly one truncation marker, then stop accumulating.
        list.push(format!(
            "[Infinity Mod Runner] ... truncated: capped at {} warnings per component",
            MAX_WARN_PER_COMPONENT
        ));
    }
}

/// Emit `install:component_done` for the next component in the batch.
/// Called from the stdout reader thread each time WeiDU reports a
/// component outcome. Timing is the elapsed wall-clock since the PREVIOUS
/// component finished (or since the batch started, for the first one).
fn emit_component_done(
    app: &AppHandle,
    timer: &Arc<Mutex<ComponentTimer>>,
    status: &str,
) {
    let Ok(mut t) = timer.lock() else { return };
    if t.next_idx >= t.components.len() { return; }
    let comp = t.components[t.next_idx].clone();
    let now = std::time::Instant::now();
    let duration_ms = now.duration_since(t.last_end).as_millis() as u64;
    t.last_end = now;
    let idx = t.next_idx;
    // Record the observed status against the component slot so `run_batch`
    // can build per-component ComponentResults afterwards. Pin to the enum
    // of static strings classify_component_line produces so lifetime is
    // trivially 'static.
    let observed_static: Option<&'static str> = match status {
        "success" => Some("success"),
        "warning" => Some("warning"),
        "error"   => Some("error"),
        _ => None,
    };
    if idx < t.observed.len() {
        t.observed[idx] = observed_static;
    }
    t.next_idx += 1;
    drop(t);
    let _ = app.emit("install:component_done", serde_json::json!({
        "mod_name": comp.mod_name,
        "component": comp.component,
        "component_name": comp.component_name,
        "duration_ms": duration_ms,
        "status": status,
    }));
}


/// Run a single batch — spawns WeiDU, streams I/O, returns results.
pub fn run_batch(
    app: &AppHandle,
    batch: &Batch,
    config: &InstallConfig,
    game_dir: &Path,
    abort_flag: &AtomicBool,
    logger: &Option<SharedLogger>,
) -> Result<Vec<ComponentResult>, String> {
    if abort_flag.load(Ordering::SeqCst) {
        return Err("Install aborted".to_string());
    }

    let mut cmd = build_weidu_command(batch, config, game_dir);
    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to start WeiDU: {e}"))?;

    let pid = child.id();

    // Store PID and stdin globally for abort/input
    {
        let mut lock = WEIDU_PID.lock().map_err(|e| e.to_string())?;
        *lock = Some(pid);
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();
    {
        let mut lock = WEIDU_STDIN.lock().map_err(|e| e.to_string())?;
        *lock = stdin;
    }

    let _ = app.emit("install:pid", pid);

    // EET auto-fill state
    let eet_filled = Arc::new(AtomicBool::new(false));
    let bg1_dir = config.bg1_game_dir.as_ref().map(|p| clean_path(p));

    // Reset prompt state for this batch
    clear_prompt_forwarded();

    // READLN auto-answer state for this batch
    let mod_key = batch.mod_name.to_lowercase();
    let readln_answers: Vec<String> = config.readln_defaults
        .get(&mod_key)
        .cloned()
        .unwrap_or_default();
    let readln_fallback = config.readln_fallback.clone();
    let readln_timeout_secs = config.readln_timeout_secs;

    // Per-component timing tracker (Phase 7d, --measure mode always on).
    //
    // WeiDU processes components in the `--force-install` order we provide,
    // emitting one of "SUCCESSFULLY INSTALLED" / "INSTALLED WITH WARNINGS" /
    // "NOT INSTALLED DUE TO ERRORS" lines per component in that same order.
    // By matching the Nth match to batch.components[N], we can attribute
    // wall-clock time to individual components without needing to parse the
    // component number from WeiDU's text (it varies in format and locale).
    //
    // The tracker is shared with the stdout-reading thread via Arc<Mutex<>>.
    // `batch_done` in orchestrator.rs is still the source of truth for
    // status; this only provides timing granularity for the trace recorder
    // on the frontend.
    let batch_components: Vec<super::Component> = batch.components.clone();
    let observed_init = vec![None; batch_components.len()];
    let warnings_init = vec![Vec::new(); batch_components.len()];
    let component_timer = Arc::new(Mutex::new(ComponentTimer {
        components: batch_components,
        next_idx: 0,
        last_end: std::time::Instant::now(),
        observed: observed_init,
        warnings: warnings_init,
    }));
    let component_timer_out = component_timer.clone();

    // Stream stdout in a thread — handles prompt detection with coordination
    let app_out = app.clone();
    let eet_filled_out = eet_filled.clone();
    let bg1_dir_out = bg1_dir.clone();
    let logger_out = logger.clone();
    let stdout_handle = if let Some(out) = stdout {
        Some(std::thread::spawn(move || {
            let mut readln_idx = 0usize; // tracks which READLN answer to use next
            let mut bulk_op_pending: Option<u64> = None; // tracks "Copying and patching N files" awaiting type detection
            let mut bulk_op_total: u64 = 0;   // total files in current bulk operation
            let mut bulk_op_count: u64 = 0;   // files processed so far
            let mut bulk_op_last_pct: u64 = 0; // last percentage emitted (avoid spam)
            let reader = BufReader::new(out);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let _ = app_out.emit("install:stdout", &line);

                    // Detect bulk operation file type from the first loaded file after the count
                    if let Some(count) = bulk_op_pending.take() {
                        if let Some(annotation) = annotate_bulk_operation(count, &line) {
                            let _ = app_out.emit("install:stdout", &annotation);
                        }
                        bulk_op_total = count;
                        bulk_op_count = 0;
                        bulk_op_last_pct = 0;
                    }

                    // Track progress within bulk operations (500+ files)
                    if bulk_op_total > 0 {
                        let ll = line.to_lowercase();
                        if ll.contains("] loaded,") || ll.contains("] copied") || ll.starts_with("copied [") || ll.starts_with("not copying") {
                            bulk_op_count += 1;
                            let pct = (bulk_op_count * 100) / bulk_op_total;
                            // Emit every 10% (so max 10 updates per bulk op)
                            if pct >= bulk_op_last_pct + 10 {
                                bulk_op_last_pct = pct;
                                let _ = app_out.emit("install:stdout",
                                    format!("  ^ {bulk_op_count}/{bulk_op_total} files processed ({pct}%)"));
                            }
                        }
                        // Reset when a new operation starts or component finishes
                        if ll.contains("successfully installed")
                            || ll.contains("not installed due to")
                            || ll.contains("installed with warnings")
                        {
                            bulk_op_total = 0;
                        }
                    }

                    // Per-component timing emit. Runs independently of bulk
                    // tracking above — this detects the same lines but is
                    // concerned with install:component_done events rather
                    // than bulk-op reset.
                    {
                        let ll_comp = line.to_lowercase();
                        if let Some(status) = classify_component_line(&ll_comp) {
                            emit_component_done(&app_out, &component_timer_out, status);
                        } else if is_warning_line(&line) {
                            // Capture raw WARNING lines against whichever
                            // component is currently installing. The frontend
                            // later matches these against the Forge's known-
                            // issue catalog to classify severity and surface
                            // a "6 cosmetic · 1 unknown" breakdown in the
                            // Issues panel.
                            capture_warning(&component_timer_out, &line);
                        }
                    }

                    // Detect "Copying and patching N files ..." for large operations
                    if let Some(count) = parse_bulk_file_count(&line) {
                        if count >= 500 {
                            bulk_op_pending = Some(count);
                        } else {
                            // Small operation resets bulk tracking
                            // (don't reset — small ops happen between bulk loads)
                        }
                    }

                    // Annotate confusing WeiDU messages
                    if let Some(note) = annotate_weidu_message(&line) {
                        let _ = app_out.emit("install:stdout", &note);
                    }

                    // Log to persistent log — only runner messages and errors
                    // (batch results are logged by the tracker at batch level)
                    if let Some(ref lg) = logger_out {
                        let ll = line.to_lowercase();
                        if line.contains("[Infinity Mod Runner]")
                            || ll.contains("not installed due to")
                        {
                            if let Ok(mut l) = lg.lock() {
                                l.log(&line);
                            }
                        }
                    }

                    let line_lower = line.to_lowercase();

                    // Skip log-like lines — these are never prompts
                    let is_log_line = line.starts_with('[')
                        || line.starts_with("  ")
                        || line.starts_with('~')  // weidu.log format: ~mod/file.tp2~ #0 #0
                        || line_lower.starts_with("copying")
                        || line_lower.starts_with("patching")
                        || line_lower.starts_with("extending")
                        || line_lower.starts_with("compiling")
                        || line_lower.starts_with("processing")
                        || line_lower.starts_with("saving")
                        || line_lower.starts_with("appending")
                        || line_lower.contains("[info]")
                        || line_lower.contains("[warn")
                        || line_lower.contains("[error")
                        || line_lower.contains("successfully installed")
                        || line_lower.contains("not installed due to")
                        || line_lower.contains("installed with warnings")
                        || line_lower.contains("skipping")
                        || line_lower.contains("characters,")   // "276298 characters, 2583 entries added to DIALOG.TLK"
                        || line_lower.contains("string entries") // "[./lang/en_US/dialog.tlk] created, 79276 string entries"
                        || line.len() > 300;

                    if is_log_line {
                        continue;
                    }

                    // EET auto-fill: always takes priority (specific prompt, not ambiguous)
                    if let Some(ref bg1) = bg1_dir_out {
                        if !eet_filled_out.load(Ordering::SeqCst)
                            && line_lower.contains(&EET_AUTO_FILL_TRIGGER.to_lowercase())
                        {
                            eet_filled_out.store(true, Ordering::SeqCst);
                            send_to_weidu(&format!("{bg1}"));
                            continue;
                        }
                    }

                    // If GUI is handling a prompt, don't auto-respond
                    if is_prompt_forwarded() {
                        continue;
                    }

                    // Known prompt patterns — auto-respond
                    let is_yes_no = line_lower.contains("[y]es")
                        || line_lower.contains("yes or no")
                        || line_lower.contains("[y/n]")
                        || line_lower.contains("is this correct");

                    let is_choice = line_lower.contains("choose one:")
                        || line_lower.contains("select one");

                    if is_yes_no {
                        // Wait briefly to ensure this is a real prompt (no more stdout coming)
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        if !is_prompt_forwarded() {
                            send_to_weidu("Y");
                        }
                    } else if is_choice {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        if !is_prompt_forwarded() {
                            send_to_weidu("1");
                        }
                    } else if line.len() < 200 && (line.ends_with("?") || line.trim().ends_with(":")) {
                        // Potential READLN prompt — try auto-answer from config
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        if !is_prompt_forwarded() {
                            if readln_idx < readln_answers.len() {
                                // Use configured answer for this mod
                                let answer = &readln_answers[readln_idx];
                                readln_idx += 1;
                                let _ = app_out.emit("install:stdout",
                                    format!("[Infinity Mod Runner] Auto-answering READLN: {answer}"));
                                send_to_weidu(answer);
                            } else if !readln_fallback.is_empty() {
                                // Use fallback (default "1")
                                let _ = app_out.emit("install:stdout",
                                    format!("[Infinity Mod Runner] Auto-answering READLN (fallback): {readln_fallback}"));
                                send_to_weidu(&readln_fallback);
                            } else {
                                // No config, no fallback — forward to GUI with timeout
                                set_prompt_forwarded();
                                let _ = app_out.emit("install:input_needed", serde_json::json!({
                                    "prompt": &line,
                                }));
                                // Spawn timeout watcher — auto-answers if GUI doesn't respond
                                if readln_timeout_secs > 0 {
                                    let timeout_fallback = readln_fallback.clone();
                                    let app_timeout = app_out.clone();
                                    std::thread::spawn(move || {
                                        std::thread::sleep(std::time::Duration::from_secs(readln_timeout_secs));
                                        if is_prompt_forwarded()
                                            && !PROMPT_ANSWER_SENT.swap(true, Ordering::SeqCst)
                                        {
                                            clear_prompt_forwarded();
                                            let _ = app_timeout.emit("install:stdout", format!(
                                                "[Infinity Mod Runner] READLN timeout after {readln_timeout_secs}s, auto-answering: {timeout_fallback}"));
                                            send_to_weidu(&timeout_fallback);
                                        }
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }))
    } else {
        None
    };

    // Stream stderr. Also opportunistically parse the BCS buffer cache
    // stats line that the patched WeiDU emits at process exit, and
    // forward it as a structured `install:bcs_cache_stats` event so the
    // UI can surface hit rates / memory for A/B measurement.
    let app_err = app.clone();
    let logger_err = logger.clone();
    let batch_index_err = batch.batch_index;
    let mod_name_err = batch.mod_name.clone();
    let stderr_handle = if let Some(err) = stderr {
        Some(std::thread::spawn(move || {
            let reader = BufReader::new(err);
            for line in reader.lines() {
                if let Ok(line) = line {
                    // BCS cache lines are diagnostics from the patched
                    // WeiDU's at_exit handler, NOT errors. Three cases:
                    //   1. JSON prefix (`BCS_CACHE_STATS_JSON {...}`) —
                    //      wire format for the structured event emitter
                    //      below. Suppressed from the UI because the
                    //      human-readable line that follows carries the
                    //      same information in a readable form. Still
                    //      parsed here for the `install:bcs_cache_stats`
                    //      event AND still written to install.log below
                    //      so A/B analysis scripts can grep it later.
                    //   2. Human-readable summary (`BCS buffer cache: ...`)
                    //      — shown as stdout (not stderr-red) because it's
                    //      informational, not an error.
                    //   3. Everything else on stderr stays as stderr.
                    let is_json_bcs = line.starts_with(super::cache_stats::WIRE_PREFIX);
                    let is_human_bcs = line.starts_with("BCS buffer cache:");
                    if is_json_bcs {
                        // Don't emit to UI — the human-readable summary
                        // already covers it for the user. Still parsed +
                        // logged to disk below.
                    } else if is_human_bcs {
                        let _ = app_err.emit("install:stdout", &line);
                    } else {
                        let _ = app_err.emit("install:stderr", &line);
                    }
                    // Three-state parse: None = not a cache line (ignore),
                    // Ok = forward as success event, Err = prefix matched
                    // but body was malformed — surface as a diagnostic so
                    // format drift is loud rather than silent.
                    match super::cache_stats::try_parse_line(&line) {
                        None => {}
                        Some(Ok(stats)) => {
                            let _ = app_err.emit(
                                "install:bcs_cache_stats",
                                // Field name is `batch_idx` (not `batch_index`)
                                // to match every other batch-indexed event in
                                // the runner — see orchestrator.rs, tracker.rs.
                                // The frontend's listener on this event reads
                                // `batch_idx`; the earlier mismatch produced
                                // `NaN` in the tooltip's "batch #" readout.
                                serde_json::json!({
                                    "batch_idx": batch_index_err,
                                    "mod_name": mod_name_err.clone(),
                                    "enabled": stats.enabled,
                                    "hits": stats.hits,
                                    "misses": stats.misses,
                                    "hit_rate_pct": stats.hit_rate_pct,
                                    "evictions": stats.evictions,
                                    "peak_kb": stats.peak_kb,
                                    "current_kb": stats.current_kb,
                                    "max_mb": stats.max_mb,
                                }),
                            );
                        }
                        Some(Err(err)) => {
                            let _ = app_err.emit(
                                "install:bcs_cache_stats_parse_error",
                                serde_json::json!({
                                    "batch_idx": batch_index_err,
                                    "mod_name": mod_name_err.clone(),
                                    "raw_body": err.raw_body,
                                    "reason": err.reason,
                                }),
                            );
                        }
                    }
                    if let Some(ref lg) = logger_err {
                        if let Ok(mut l) = lg.lock() {
                            l.log_stderr(&line);
                        }
                    }
                }
            }
        }))
    } else {
        None
    };

    // Wait for process with timeout. Some mods (notably dw_talents HLAs on
    // megainstalls) legitimately exceed the 2h global cap; InstallConfig
    // exposes a per-mod override map keyed by lowercase mod_name.
    let effective_timeout_secs = config.per_mod_timeout_secs
        .get(&batch.mod_name.to_lowercase())
        .copied()
        .unwrap_or(config.timeout_secs);
    let timeout = std::time::Duration::from_secs(effective_timeout_secs);
    let start = std::time::Instant::now();
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {
                if start.elapsed() > timeout {
                    // Timeout — kill the process
                    let _ = child.kill();
                    break Err(format!("WeiDU timed out after {}s", effective_timeout_secs));
                }
                if abort_flag.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    // Also kill process tree on Windows (WeiDU may have spawned children)
                    #[cfg(target_os = "windows")]
                    {
                        if let Some(pid) = WEIDU_PID.lock().ok().and_then(|l| *l) {
                            use std::os::windows::process::CommandExt;
                            let _ = std::process::Command::new("taskkill")
                                .args(["/PID", &pid.to_string(), "/T", "/F"])
                                .creation_flags(0x08000000)
                                .output();
                        }
                    }
                    break Err("Install aborted".to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => break Err(format!("WeiDU process error: {e}")),
        }
    };

    // Clean up global handles
    {
        if let Ok(mut lock) = WEIDU_PID.lock() { *lock = None; }
        if let Ok(mut lock) = WEIDU_STDIN.lock() { *lock = None; }
    }

    // Wait for I/O threads
    if let Some(h) = stdout_handle { let _ = h.join(); }
    if let Some(h) = stderr_handle { let _ = h.join(); }

    let (exit_code, is_segfault) = match exit_status {
        Ok(status) => {
            let code = status.code().unwrap_or(-1);

            // Detect segfault — platform-specific
            #[cfg(target_os = "windows")]
            let segfault = code == -1073741819; // 0xC0000005 STATUS_ACCESS_VIOLATION

            #[cfg(unix)]
            let segfault = {
                use std::os::unix::process::ExitStatusExt;
                status.signal() == Some(11) // SIGSEGV
            };

            #[cfg(not(any(target_os = "windows", unix)))]
            let segfault = false;

            (code, segfault)
        }
        Err(msg) => {
            return Ok(batch.components.iter().map(|comp| {
                ComponentResult {
                    mod_name: comp.mod_name.clone(),
                    component: comp.component,
                    component_name: comp.component_name.clone(),
                    status: ComponentStatus::Error,
                    message: Some(msg.clone()),
                    warnings: Vec::new(),
                }
            }).collect());
        }
    };

    // WeiDU exit code 3 = success (cleanup/cosmetic issue, not a real error)
    let success = exit_code == 0 || exit_code == 3;
    let error_detail = if is_segfault {
        let heavy_mods = super::FORCE_SMALL_BATCH_MODS.join(", ");
        Some(format!(
            "WeiDU crashed with 0xc0000005 (access violation). This is usually caused by: \
            (1) too many components in one batch — try reducing batch size, \
            (2) a mod doing heavy COPY_EXISTING_REGEXP — known affected: {heavy_mods}, \
            (3) corrupt game files from a previous failed install. \
            The install will attempt to retry with fewer components."
        ))
    } else if !success {
        Some(format!("WeiDU exit code: {exit_code}"))
    } else {
        None
    };

    // Build results — we'll refine with DEBUG parsing in the orchestrator.
    //
    // When the batch succeeded (exit 0/3), consult the stdout-observed
    // per-component status so a component WeiDU tagged "installed with
    // warnings" lands as ComponentStatus::Warning rather than Success.
    // Before this, any component with a harmless-but-noisy warning (e.g.
    // cdtweaks's "Installed with errors (found in weidu.log)" flow) still
    // showed as Success in the Issues panel — which meant warning-only
    // mods were entirely invisible in the post-install review surface.
    //
    // When the batch failed (non-zero exit), we stick with the blanket
    // Error classification here and let `refine_results_from_log` in the
    // orchestrator reclassify per-component using weidu.log as the
    // authority — that path already handles Error→Warning upgrades when
    // the log shows the component actually did install.
    let (observed_snapshot, warnings_snapshot): (Vec<Option<&'static str>>, Vec<Vec<String>>) =
        component_timer
            .lock()
            .map(|t| (t.observed.clone(), t.warnings.clone()))
            .unwrap_or_else(|_| (
                vec![None; batch.components.len()],
                vec![Vec::new(); batch.components.len()],
            ));

    let results: Vec<ComponentResult> = batch.components.iter()
        .enumerate()
        .map(|(idx, comp)| {
            let observed = observed_snapshot.get(idx).copied().flatten();
            let warnings = warnings_snapshot.get(idx).cloned().unwrap_or_default();
            // Per-component stdout from WeiDU is authoritative for the
            // component's outcome — regardless of whether the batch as a
            // whole exited 0 (success) or non-zero (one later component
            // errored and triggered rollback of ITS changes, but earlier
            // SUCCESSFULLY INSTALLED components are real).
            //
            // Previously we took a "batch failed → blanket Error" path, which
            // caused Test #37 imoen_forever: 6 components printed
            // "SUCCESSFULLY INSTALLED" to stdout but were misclassified as
            // Warning ("Installed with errors (found in weidu.log)") after
            // refine_results_from_log saw them in weidu.log. They should be
            // Success.
            //
            // Classification rules (applied in both success and failure cases):
            //   observed = Some("success") → Success
            //   observed = Some("warning") → Warning
            //   observed = Some("error")   → Error
            //   observed = None            → depends on batch exit:
            //     batch success → Success (no line seen, trust batch exit)
            //     batch failure → Error   (could be the failing component
            //                              or one that never ran — let
            //                              refine_results_from_log decide
            //                              Error→Skipped/Warning based on
            //                              weidu.log presence)
            let (status, message) = match observed {
                Some("success") => (ComponentStatus::Success, None),
                Some("warning") => (
                    ComponentStatus::Warning,
                    Some("Installed with warnings".to_string()),
                ),
                Some("error") => (
                    ComponentStatus::Error,
                    Some("Component reported NOT INSTALLED".to_string()),
                ),
                _ => {
                    // No completion line observed.
                    if success {
                        (ComponentStatus::Success, error_detail.clone())
                    } else {
                        (ComponentStatus::Error, error_detail.clone())
                    }
                }
            };
            ComponentResult {
                mod_name: comp.mod_name.clone(),
                component: comp.component,
                component_name: comp.component_name.clone(),
                status,
                message,
                warnings,
            }
        })
        .collect();

    Ok(results)
}

/// Send text to the running WeiDU process stdin (from GUI input).
/// Clears the prompt-forwarded flag so auto-response can resume.
pub fn send_input(text: &str) -> Result<(), String> {
    // Guard: if timeout thread already answered, don't double-answer
    if PROMPT_ANSWER_SENT.swap(true, Ordering::SeqCst) {
        return Ok(()); // Timeout already answered
    }
    clear_prompt_forwarded();
    let mut lock = WEIDU_STDIN.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut s) = *lock {
        writeln!(s, "{}", text).map_err(|e| format!("stdin write: {e}"))?;
        s.flush().map_err(|e| format!("stdin flush: {e}"))?;
        return Ok(());
    }
    Err("No running WeiDU process".to_string())
}

/// Annotate confusing WeiDU messages with user-friendly explanations.
/// Returns Some(annotation) if the line matches a known pattern, None otherwise.
fn annotate_weidu_message(line: &str) -> Option<String> {
    let ll = line.to_lowercase();

    // "[*.IDS] forgotten" — IDS cache cleared
    if ll.contains("forgotten") && ll.contains(".ids]") {
        return Some("  ^ IDS cache cleared (normal after modifying .IDS files)".to_string());
    }
    // "Not copying [X] because it did not change"
    if ll.contains("not copying") && ll.contains("did not change") {
        return Some("  ^ File unchanged by patch — skipped (normal, saves disk writes)".to_string());
    }
    // "round-trip failure" / "Returning original BCS unchanged"
    if ll.contains("round-trip failure") {
        return Some("  ^ BCS file can't be decompiled+recompiled cleanly — original preserved (known WeiDU limitation)".to_string());
    }
    // "cannot be decompiled"
    if ll.contains("cannot be decompiled") && ll.contains(".bcs") {
        return Some("  ^ Script uses actions/triggers not in current IDS files — original preserved".to_string());
    }
    // "LEXER ERROR" on BCS
    if ll.contains("lexer error") && ll.contains(".bcs") {
        return Some("  ^ Script file has invalid format — may have been corrupted by a previous mod".to_string());
    }
    // "Unable to Unlink" — file permission issue during rollback
    if ll.contains("unable to unlink") {
        return Some("  ^ File locked during rollback cleanup (harmless — Windows file locking)".to_string());
    }
    // "Parsing.Parse_error"
    if ll.contains("parsing.parse_error") && !ll.contains("error:") {
        return Some("  ^ Script parse failed — usually caused by missing IDS entries from earlier mods".to_string());
    }
    // "ERROR: Unix.Unix_error"
    if ll.contains("unix.unix_error") && ll.contains("eacces") {
        return Some("  ^ File access denied — another process may have it open (antivirus?)".to_string());
    }

    None
}

/// Parse "Copying and patching N files ..." and return N.
fn parse_bulk_file_count(line: &str) -> Option<u64> {
    let ll = line.to_lowercase();
    if !ll.starts_with("copying and patching") || !ll.contains("files") {
        return None;
    }
    // Extract the number between "patching " and " files"
    let after_patching = line.find("patching ").map(|i| &line[i + 9..])?;
    let num_str: String = after_patching.chars().take_while(|c| c.is_ascii_digit()).collect();
    num_str.parse().ok()
}

/// After a large "Copying and patching N files" line, look at the first loaded file
/// to determine the file type and emit a user-friendly annotation.
fn annotate_bulk_operation(count: u64, next_line: &str) -> Option<String> {
    // Next line is usually "[./override/FILENAME.EXT] loaded, N bytes"
    let ll = next_line.to_lowercase();
    let ext = if ll.contains(".itm]") {
        "ITM"
    } else if ll.contains(".spl]") {
        "SPL"
    } else if ll.contains(".cre]") {
        "CRE"
    } else if ll.contains(".bcs]") {
        "BCS"
    } else if ll.contains(".eff]") {
        "EFF"
    } else if ll.contains(".dlg]") {
        "DLG"
    } else if ll.contains(".are]") {
        "ARE"
    } else if ll.contains(".2da]") {
        "2DA"
    } else {
        return Some(format!("  ^ Bulk operation: {count} files (this may take a few minutes)"));
    };

    let purpose = match ext {
        "ITM" => "items — likely kit usability, item tweaks, or spell changes",
        "SPL" => "spells — likely spell modifications or kit ability patches",
        "CRE" => "creatures — likely AI scripts, stat adjustments, or kit assignments",
        "BCS" => "scripts — likely AI or trigger patching (watch for round-trip warnings)",
        "EFF" => "effects — likely spell effect modifications",
        "DLG" => "dialogues — likely NPC interaction or quest patches",
        "ARE" => "areas — likely area script or encounter modifications",
        "2DA" => "tables — likely game rule or class/kit table updates",
        _ => "files",
    };

    Some(format!("  ^ Bulk-patching {count} {ext} files ({purpose})"))
}

/// Internal: send text to WeiDU stdin from the stdout reading thread.
fn send_to_weidu(text: &str) {
    if let Ok(mut lock) = WEIDU_STDIN.lock() {
        if let Some(ref mut s) = *lock {
            let _ = writeln!(s, "{}", text);
            let _ = s.flush();
        }
    }
}

/// Abort the running WeiDU process.
pub fn abort_weidu() -> Result<(), String> {
    let pid = {
        let lock = WEIDU_PID.lock().map_err(|e| e.to_string())?;
        *lock
    };

    if let Some(pid) = pid {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            // Graceful first: CTRL_BREAK_EVENT
            unsafe {
                #[link(name = "kernel32")]
                unsafe extern "system" {
                    fn GenerateConsoleCtrlEvent(event: u32, group_id: u32) -> i32;
                }
                GenerateConsoleCtrlEvent(1, pid);
            }
            // Force kill tree after 3s in background (kills WeiDU + any child processes)
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                // Check if still running
                let check = std::process::Command::new("tasklist")
                    .args(["/FI", &format!("PID eq {pid}"), "/NH"])
                    .creation_flags(0x08000000)
                    .output();
                let still_running = check.map(|o| {
                    let out = String::from_utf8_lossy(&o.stdout);
                    out.contains(&pid.to_string())
                }).unwrap_or(false);

                if still_running {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .creation_flags(0x08000000)
                        .output();
                }
            });
        }
        #[cfg(not(target_os = "windows"))]
        {
            if pid > 0 {
                std::thread::spawn(move || {
                    unsafe { libc::kill(pid as i32, libc::SIGINT); }
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    unsafe { libc::kill(pid as i32, libc::SIGKILL); }
                });
            }
        }
    }
    Ok(())
}

/// Force-kill WeiDU immediately. Used on app close where we can't wait for
/// the graceful shutdown background thread.
pub fn force_kill_weidu() {
    let pid = WEIDU_PID.lock().ok().and_then(|l| *l);
    let Some(pid) = pid else { return };

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .output();
    }

    #[cfg(not(target_os = "windows"))]
    {
        if pid > 0 {
            unsafe { libc::kill(pid as i32, libc::SIGKILL); }
        }
    }
}

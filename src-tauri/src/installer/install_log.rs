//! Persistent install log — writes runner messages to disk for post-mortem analysis.
//!
//! Captures [Infinity Mod Runner] status messages, batch events, BCS scanner output,
//! and progress milestones. Does NOT capture raw WeiDU output (that goes to WSETUP.DEBUG).

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub type SharedLogger = Arc<Mutex<InstallLogger>>;

pub struct InstallLogger {
    writer: BufWriter<File>,
    path: PathBuf,
    components_logged: usize,
}

impl InstallLogger {
    /// Open (or create) the install log in append mode. Writes a session header.
    pub fn new(data_dir: &Path) -> Result<Self, String> {
        // Filename from paths::FILE_INSTALL_LOG — canonical source of truth.
        // Drift prevention: changing the name requires changing the const,
        // which flows here and to `resolve_log_paths` simultaneously.
        let path = data_dir.join(crate::paths::FILE_INSTALL_LOG);
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("Failed to open install log: {e}"))?;

        let mut logger = Self {
            writer: BufWriter::new(file),
            path: path.clone(),
            components_logged: 0,
        };

        // Session header
        let ts = format_timestamp();
        let sep = "=".repeat(80);
        let _ = writeln!(logger.writer, "\n{sep}");
        let _ = writeln!(logger.writer, "Infinity Mod Runner Install Session — {ts}");
        let _ = writeln!(logger.writer, "{sep}");
        let _ = logger.writer.flush();

        Ok(logger)
    }

    /// Log a plain message.
    pub fn log(&mut self, msg: &str) {
        let ts = format_time();
        let _ = writeln!(self.writer, "[{ts}] {msg}");
        let _ = self.writer.flush();
    }

    /// Log a structured event.
    pub fn log_event(&mut self, event_type: &str, details: &str) {
        let ts = format_time();
        let _ = writeln!(self.writer, "[{ts}] [{event_type}] {details}");
        let _ = self.writer.flush();
    }

    /// Log a progress milestone (called frequently, only writes every 50 components).
    pub fn log_progress(&mut self, current: usize, total: usize, success: usize, errors: usize, skipped: usize) {
        self.components_logged = current;
        // Only log every 50 components or at 100%
        if current % 50 == 0 || current == total {
            let ts = format_time();
            let _ = writeln!(self.writer,
                "[{ts}] [PROGRESS] {current}/{total} (success:{success} errors:{errors} skipped:{skipped})");
            let _ = self.writer.flush();
        }
    }

    /// Log a stdout line from the runner (only logs [Infinity Mod Runner] prefixed messages).
    pub fn log_runner_stdout(&mut self, line: &str) {
        if line.contains("[Infinity Mod Runner]") {
            let ts = format_time();
            let _ = writeln!(self.writer, "[{ts}] {line}");
            let _ = self.writer.flush();
        }
    }

    /// Log a stderr line (only short error-like lines, plus any BCS
    /// buffer cache stats emissions — those are always short and don't
    /// contain "error/fatal/warning" but are essential for post-install
    /// A/B diagnosis of the experimental cache).
    pub fn log_stderr(&mut self, line: &str) {
        if line.len() < 300 {
            let is_cache_line = line.starts_with("BCS_CACHE_STATS_JSON ")
                || line.starts_with("BCS buffer cache: ");
            let lower = line.to_lowercase();
            let is_error = lower.contains("error")
                || lower.contains("fatal")
                || lower.contains("warning");
            if is_cache_line || is_error {
                let ts = format_time();
                let _ = writeln!(self.writer, "[{ts}] [STDERR] {line}");
                let _ = self.writer.flush();
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Create a shared logger. Returns None (with a warning) if the file can't be opened.
pub fn create_logger(data_dir: &Path) -> Option<SharedLogger> {
    match InstallLogger::new(data_dir) {
        Ok(logger) => Some(Arc::new(Mutex::new(logger))),
        Err(e) => {
            eprintln!("WARNING: Could not create install log: {e}");
            None
        }
    }
}

/// Convenience: log to a SharedLogger if present.
pub fn shared_log(logger: &Option<SharedLogger>, msg: &str) {
    if let Some(lg) = logger {
        if let Ok(mut l) = lg.lock() {
            l.log(msg);
        }
    }
}

/// Convenience: log event to a SharedLogger if present.
pub fn shared_log_event(logger: &Option<SharedLogger>, event_type: &str, details: &str) {
    if let Some(lg) = logger {
        if let Ok(mut l) = lg.lock() {
            l.log_event(event_type, details);
        }
    }
}

/// Globally-accessible handle to the currently-active install logger.
///
/// Set by the orchestrator at install start, cleared at install end.
/// Lets external callers (e.g. the `abort_native_install` Tauri command)
/// emit events like `[USER_ABORT]` into install.log without having to
/// thread the logger through the async command surface.
static ACTIVE_LOGGER: std::sync::OnceLock<Mutex<Option<SharedLogger>>> = std::sync::OnceLock::new();

fn active_logger_slot() -> &'static Mutex<Option<SharedLogger>> {
    ACTIVE_LOGGER.get_or_init(|| Mutex::new(None))
}

/// Register the active install logger so `log_active_event` can find it.
pub fn set_active_logger(logger: Option<SharedLogger>) {
    if let Ok(mut slot) = active_logger_slot().lock() {
        *slot = logger;
    }
}

/// Log an event to the currently-active install logger if any. Silent if
/// no install is running.
pub fn log_active_event(event_type: &str, details: &str) {
    if let Ok(slot) = active_logger_slot().lock() {
        if let Some(lg) = slot.as_ref() {
            if let Ok(mut l) = lg.lock() {
                l.log_event(event_type, details);
            }
        }
    }
}

fn format_timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Simple UTC timestamp (no chrono dependency)
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let days = secs / 86400;
    // Approximate date from epoch days (good enough for logging)
    let (y, mo, d) = epoch_days_to_date(days);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{m:02}:{s:02} UTC")
}

fn format_time() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    format!("{h:02}:{m:02}:{s:02}")
}

/// Approximate date from epoch days (no leap second handling, good enough for logging).
fn epoch_days_to_date(days: u64) -> (u64, u64, u64) {
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

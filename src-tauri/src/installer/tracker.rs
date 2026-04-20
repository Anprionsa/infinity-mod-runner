//! Progress tracking — emits events for each component/batch transition.

use super::{ComponentResult, ComponentStatus, InstallSummary};
use super::install_log::{self, SharedLogger};
use tauri::{AppHandle, Emitter};
use std::time::Instant;

pub struct InstallTracker {
    app: AppHandle,
    start_time: Instant,
    total_components: usize,
    current: usize,
    success: usize,
    warnings: usize,
    errors: usize,
    skipped: usize,
    /// Subset of `skipped` where the message begins with "Pre-skipped:" —
    /// components the orchestrator fast-skipped because the mod's earlier
    /// batch failed. Surfaced in the completion summary so the "N skipped"
    /// figure can be read as "M primary + (N-M) cascade".
    skipped_cascade: usize,
    already_installed: usize,
    logger: Option<SharedLogger>,
}

impl InstallTracker {
    pub fn new(app: AppHandle, total_components: usize, logger: Option<SharedLogger>) -> Self {
        Self {
            app,
            start_time: Instant::now(),
            total_components,
            current: 0,
            success: 0,
            warnings: 0,
            errors: 0,
            skipped: 0,
            skipped_cascade: 0,
            already_installed: 0,
            logger,
        }
    }

    pub fn emit_batch_start(&self, batch_idx: usize, total_batches: usize, mod_name: &str, components: &[String]) {
        let _ = self.app.emit("install:batch_start", serde_json::json!({
            "batch_idx": batch_idx,
            "total_batches": total_batches,
            "mod_name": mod_name,
            "components": components,
        }));
    }

    /// Same as `emit_batch_start` but carries an optional `known_slow_reason`
    /// when the batch contains a component marked as known-slow by
    /// `installer::known_slow_reason`. The Slow Batch UI uses this to show a
    /// targeted "this is expected, don't abort" message instead of the
    /// generic slow-batch warning.
    pub fn emit_batch_start_with_hints(
        &self,
        batch_idx: usize,
        total_batches: usize,
        mod_name: &str,
        components: &[String],
        known_slow_reason: Option<&str>,
    ) {
        let _ = self.app.emit("install:batch_start", serde_json::json!({
            "batch_idx": batch_idx,
            "total_batches": total_batches,
            "mod_name": mod_name,
            "components": components,
            "known_slow_reason": known_slow_reason,
        }));
    }

    pub fn emit_component_start(&self, mod_name: &str, component: u32, component_name: &str) {
        let _ = self.app.emit("install:component_start", serde_json::json!({
            "mod_name": mod_name,
            "component": component,
            "component_name": component_name,
        }));
    }

    pub fn record_results(&mut self, results: &[ComponentResult]) {
        for r in results {
            self.current += 1;
            match r.status {
                ComponentStatus::Success => self.success += 1,
                ComponentStatus::Warning => self.warnings += 1,
                ComponentStatus::Error => self.errors += 1,
                ComponentStatus::Skipped => {
                    self.skipped += 1;
                    // Classify cascade skips by their message prefix —
                    // orchestrator.rs emits exactly this string when fast-skipping
                    // a batch because the mod's previous batch hard-failed. Any
                    // other Skipped (REQUIRE_PREDICATE, retry-exhausted, user
                    // abort, WeiDU silent skip) stays in the "primary" bucket.
                    if r.message
                        .as_deref()
                        .map(|m| m.starts_with("Pre-skipped:"))
                        .unwrap_or(false)
                    {
                        self.skipped_cascade += 1;
                    }
                }
                ComponentStatus::AlreadyInstalled => self.already_installed += 1,
            }
        }
        // Emit progress
        let _ = self.app.emit("install:progress", serde_json::json!({
            "current": self.current,
            "total": self.total_components,
            "success": self.success,
            "warnings": self.warnings,
            "errors": self.errors,
            "skipped": self.skipped,
            "elapsed_ms": self.start_time.elapsed().as_millis() as u64,
        }));
        // Log progress milestones
        if let Some(ref lg) = self.logger {
            if let Ok(mut l) = lg.lock() {
                l.log_progress(self.current, self.total_components, self.success, self.errors, self.skipped);
            }
        }
    }

    pub fn emit_batch_done(&self, batch_idx: usize, results: &[ComponentResult]) {
        let _ = self.app.emit("install:batch_done", serde_json::json!({
            "batch_idx": batch_idx,
            "results": results,
        }));
    }

    pub fn emit_batch_error(&self, batch_idx: usize, mod_name: &str, error: &str, can_retry: bool) {
        let _ = self.app.emit("install:batch_error", serde_json::json!({
            "batch_idx": batch_idx,
            "mod_name": mod_name,
            "error": error,
            "can_retry": can_retry,
        }));
        install_log::shared_log_event(&self.logger, "BATCH_ERROR",
            &format!("batch {} '{}': {}", batch_idx, mod_name, error));
    }

    pub fn emit_pause(&self, message: &str) {
        let _ = self.app.emit("install:pause", serde_json::json!({
            "message": message,
        }));
    }

    /// Emitted when the orchestrator exits a pause (either pre-configured
    /// PausePoint or user-requested via `install_pause`). The frontend uses
    /// this to unfreeze the elapsed-time counter and clear any "Paused"
    /// banner, independent of whatever Resume click path it took.
    pub fn emit_resumed(&self) {
        let _ = self.app.emit("install:resumed", serde_json::json!({}));
    }

    pub fn emit_input_needed(&self, prompt: &str) {
        let _ = self.app.emit("install:input_needed", serde_json::json!({
            "prompt": prompt,
        }));
    }

    pub fn build_summary(&self, aborted: bool) -> InstallSummary {
        InstallSummary {
            total_components: self.total_components,
            success: self.success,
            warnings: self.warnings,
            errors: self.errors,
            skipped: self.skipped,
            skipped_cascade: self.skipped_cascade,
            already_installed: self.already_installed,
            elapsed_ms: self.start_time.elapsed().as_millis() as u64,
            aborted,
        }
    }

    pub fn emit_complete(&self, summary: &InstallSummary) {
        let _ = self.app.emit("install:complete", serde_json::json!(summary));
    }
}

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
                ComponentStatus::Skipped => self.skipped += 1,
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
            already_installed: self.already_installed,
            elapsed_ms: self.start_time.elapsed().as_millis() as u64,
            aborted,
        }
    }

    pub fn emit_complete(&self, summary: &InstallSummary) {
        let _ = self.app.emit("install:complete", serde_json::json!(summary));
    }
}

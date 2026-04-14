//! Native WeiDU installer engine — replaces mod_installer subprocess.
//!
//! Calls WeiDU directly with piped I/O, streaming progress events to the GUI.
//! Supports per-batch error recovery (Retry/Skip/Stop), DEBUG file management,
//! pause points, and EET two-phase installation.

pub mod batch;
pub mod engine;
pub mod runner;
pub mod tracker;
pub mod debug_mgr;
pub mod orchestrator;
pub mod pe_patch;
pub mod log_diff;
pub mod copy;
pub mod tlk_accel;
pub mod install_log;
pub mod dry_run;

use std::path::PathBuf;
use serde::{Deserialize, Serialize};

/// A single WeiDU component to install.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Component {
    pub tp_file: String,        // e.g., "SETUP-EEFIXPACK.TP2"
    pub mod_name: String,       // e.g., "eefixpack" (folder name, lowercase)
    pub lang: u32,              // Language index (usually 0)
    pub component: u32,         // Component number
    pub component_name: String, // Human-readable name
}

/// A batch of components from the same mod to install in one WeiDU call.
#[derive(Debug, Clone)]
pub struct Batch {
    pub mod_name: String,
    pub tp_file: String,
    pub lang: u32,
    pub components: Vec<Component>,
    pub batch_index: usize,
}

/// Result of installing a single component.
#[derive(Debug, Clone, Serialize)]
pub struct ComponentResult {
    pub mod_name: String,
    pub component: u32,
    pub component_name: String,
    pub status: ComponentStatus,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ComponentStatus {
    Success,
    Warning,
    Error,
    Skipped,
    AlreadyInstalled,
}

/// Summary of the entire install.
#[derive(Debug, Clone, Serialize)]
pub struct InstallSummary {
    pub total_components: usize,
    pub success: usize,
    pub warnings: usize,
    pub errors: usize,
    pub skipped: usize,
    pub already_installed: usize,
    pub elapsed_ms: u64,
    pub aborted: bool,
}

/// User decision after a batch error.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorDecision {
    Retry,
    Skip,
    Stop,
}

/// Install configuration.
#[derive(Debug, Clone)]
pub struct InstallConfig {
    pub weidu_path: PathBuf,
    pub bg2_game_dir: PathBuf,
    pub bg1_game_dir: Option<PathBuf>,
    pub mod_directory: PathBuf,
    pub language: String,           // e.g., "en_US"
    pub language_index: u32,        // e.g., 0
    pub max_batch_size: usize,      // default 25
    pub skip_installed: bool,
    pub timeout_secs: u64,
    pub weidu_log_mode: String,     // e.g., "autolog,logapp,log-extern"
    pub never_abort: bool,
    pub abort_on_warnings: bool,
    pub post_copy_delay_ms: u64,    // default 500, increase for network drives
    pub ocamlrunparam: String,      // OCaml GC tuning (default: "s=16M,o=500,O=1000000")
    pub bcs_scanner: bool,          // Enable BCS corruption scanner (debug installs)
    pub readln_defaults: std::collections::HashMap<String, Vec<String>>,
    pub readln_fallback: String,
    pub readln_timeout_secs: u64,   // Timeout for GUI-forwarded READLN prompts (default 30)
    pub auto_skip_after_retry: bool, // Auto retry once, then skip on failure (no GUI prompt)
    pub suppress_readmes: bool,      // Suppress AT_INTERACTIVE_EXIT readme popups
    pub sibling_directories: std::collections::HashMap<String, Vec<String>>,
    pub data_directory: Option<String>, // Where EETMR stores its own artifacts (default: next to exe)
    pub tlk_prewarm: bool,             // Pre-warm TLK into page cache (default: true)
    pub tlk_fast_drive: bool,          // Junction lang dir to fast drive (default: false)
    pub tlk_fast_drive_path: Option<String>, // Custom fast drive path (default: temp_dir)
}

/// Resolve the data directory for EETMR artifacts (lockfile, checkpoint, install log, backups).
/// Returns a per-game subfolder based on a hash of the game directory path.
pub fn resolve_data_dir(config: &InstallConfig) -> std::path::PathBuf {
    let base = config.data_directory.as_ref()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.join("data")))
                .unwrap_or_else(|| std::path::PathBuf::from("data"))
        });
    let game_hash = short_path_hash(&config.bg2_game_dir.to_string_lossy());
    let dir = base.join(&game_hash);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Simple deterministic hash of a path string → 12-char hex.
pub fn short_path_hash(input: &str) -> String {
    let normalized = input.replace('\\', "/").to_lowercase();
    // FNV-1a hash — fast, no external deps, good distribution
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in normalized.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:012x}", hash)
}

/// Default values — can be overridden by patches/install_config.json at runtime.
pub const FORCE_SMALL_BATCH_MODS: &[&str] = &["mih_eq", "mih_ip", "mih_tweaks", "trap_overhaul", "dw_talents", "stratagems"];
pub const FORCE_SMALL_BATCH_SIZE: usize = 3;
pub const DEFAULT_MAX_BATCH_SIZE: usize = 25;
pub const ESSENTIAL_MODS: &[&str] = &["dlcmerger", "eefixpack", "eet", "eet_end"];
pub const WATCHED_FILES: &[&str] = &["ACTION.IDS", "TRIGGER.IDS", "AREATYPE.IDS", "BD0120.BCS"];
pub const EET_AUTO_FILL_TRIGGER: &str = "Enter the full path to your BG:EE+SoD installation";

/// Runtime-configurable install parameters (loaded from install_config.json if available).
pub struct RuntimeConfig {
    pub force_small_batch_mods: Vec<String>,
    pub force_small_batch_size: usize,
    pub essential_mods: Vec<String>,
    pub watched_files: Vec<String>,
    pub eet_auto_fill_trigger: String,
    pub ocamlrunparam: String,
    pub pe_stack_reserve_mb: u64,
    /// Per-mod READLN auto-answers. Key = lowercase mod name, value = list of responses in order.
    pub readln_defaults: std::collections::HashMap<String, Vec<String>>,
    /// Fallback answer for unrecognized READLN prompts (default: "1").
    pub readln_fallback: String,
    pub readln_timeout_secs: u64,
    /// Sibling directories to junction alongside a mod. Key = lowercase mod folder, Value = list of sibling folder names.
    pub sibling_directories: std::collections::HashMap<String, Vec<String>>,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            force_small_batch_mods: FORCE_SMALL_BATCH_MODS.iter().map(|s| s.to_string()).collect(),
            force_small_batch_size: FORCE_SMALL_BATCH_SIZE,
            essential_mods: ESSENTIAL_MODS.iter().map(|s| s.to_string()).collect(),
            watched_files: WATCHED_FILES.iter().map(|s| s.to_string()).collect(),
            eet_auto_fill_trigger: EET_AUTO_FILL_TRIGGER.to_string(),
            ocamlrunparam: "s=16M,o=500,O=1000000".to_string(),
            pe_stack_reserve_mb: 32,
            readln_defaults: std::collections::HashMap::new(),
            readln_fallback: "1".to_string(),
            readln_timeout_secs: 30,
            sibling_directories: std::collections::HashMap::new(),
        }
    }
}

impl RuntimeConfig {
    /// Load from a JSON file, falling back to defaults for missing fields.
    pub fn load(resource_dir: &std::path::Path) -> Self {
        let path = resource_dir.join("patches").join("install_config.json");
        if !path.exists() {
            return Self::default();
        }
        let contents = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => return Self::default(),
        };
        let json: serde_json::Value = match serde_json::from_str(&contents) {
            Ok(v) => v,
            Err(_) => return Self::default(),
        };

        let defaults = Self::default();
        Self {
            force_small_batch_mods: json.get("force_small_batch_mods")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or(defaults.force_small_batch_mods),
            force_small_batch_size: json.get("force_small_batch_size")
                .and_then(|v| v.as_u64()).map(|v| v as usize)
                .unwrap_or(defaults.force_small_batch_size),
            essential_mods: json.get("essential_mods")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or(defaults.essential_mods),
            watched_files: json.get("watched_files")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or(defaults.watched_files),
            eet_auto_fill_trigger: json.get("eet_auto_fill_trigger")
                .and_then(|v| v.as_str()).map(|s| s.to_string())
                .unwrap_or(defaults.eet_auto_fill_trigger),
            ocamlrunparam: json.get("ocamlrunparam")
                .and_then(|v| v.as_str()).map(|s| s.to_string())
                .unwrap_or(defaults.ocamlrunparam),
            pe_stack_reserve_mb: json.get("pe_stack_reserve_mb")
                .and_then(|v| v.as_u64())
                .unwrap_or(defaults.pe_stack_reserve_mb),
            readln_defaults: json.get("readln_defaults")
                .and_then(|v| v.as_object())
                .map(|obj| {
                    obj.iter()
                        .filter(|(k, _)| !k.starts_with('_')) // skip _comment
                        .filter_map(|(k, v)| {
                            let answers: Vec<String> = v.as_array()?
                                .iter()
                                .filter_map(|s| s.as_str().map(|s| s.to_string()))
                                .collect();
                            Some((k.to_lowercase(), answers))
                        })
                        .collect()
                })
                .unwrap_or_default(),
            readln_fallback: json.get("readln_fallback")
                .and_then(|v| v.as_str()).map(|s| s.to_string())
                .unwrap_or(defaults.readln_fallback),
            readln_timeout_secs: json.get("readln_timeout_secs")
                .and_then(|v| v.as_u64())
                .unwrap_or(defaults.readln_timeout_secs),
            sibling_directories: json.get("sibling_directories")
                .and_then(|v| v.as_object())
                .map(|obj| {
                    obj.iter()
                        .filter(|(k, _)| !k.starts_with('_'))
                        .filter_map(|(k, v)| {
                            let siblings: Vec<String> = v.as_array()?
                                .iter()
                                .filter_map(|s| s.as_str().map(|s| s.to_string()))
                                .collect();
                            Some((k.to_lowercase(), siblings))
                        })
                        .collect()
                })
                .unwrap_or_default(),
        }
    }
}

//! Native WeiDU installer engine.
//!
//! Calls WeiDU directly with piped I/O, streaming progress events to the GUI.
//! Supports per-batch error recovery (Retry/Skip/Stop), DEBUG file management,
//! pause points, and EET two-phase installation.

pub mod batch;
pub mod engine;
pub mod runner;
pub mod tracker;
pub mod debug_mgr;
pub mod debug_snapshot;
pub mod orchestrator;
pub mod pe_patch;
pub mod log_diff;
pub mod copy;
pub mod tlk_accel;
pub mod override_accel;
pub mod install_log;
pub mod dry_run;
pub mod file_guard;
pub mod cache_stats;

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
#[derive(Debug, Clone, Serialize, Default)]
pub struct ComponentResult {
    pub mod_name: String,
    pub component: u32,
    pub component_name: String,
    pub status: ComponentStatus,
    pub message: Option<String>,
    /// Raw `WARNING:` lines observed in WeiDU stdout while this component
    /// was installing. Populated regardless of the final `status` —
    /// components can emit warnings AND still end in Success (WeiDU returns
    /// non-zero only for `not installed due to errors`, not inline warns).
    /// The frontend matches these lines against the Forge's per-mod `ki`
    /// patterns + global `known_issues.json` to render a severity
    /// breakdown ("6 cosmetic · 1 unknown") instead of an undifferentiated
    /// "Installed with warnings" count. Empty for clean components so the
    /// serialized payload stays small on the happy path.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ComponentStatus {
    #[default]
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
    /// Subset of `skipped` that were pre-skipped by the orchestrator because
    /// an earlier batch of the same mod failed completely (see the
    /// `Pre-skipped: earlier batch for this mod failed completely` path in
    /// orchestrator.rs). Kept as a separate count so the completion log can
    /// distinguish "X primary skips, Y cascade skips" — a primary skip is
    /// typically something a mod author could action, a cascade skip is
    /// downstream damage from a prior failure.
    #[serde(default)]
    pub skipped_cascade: usize,
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
    /// Per-mod timeout override in seconds (key = lowercase mod_name).
    /// Falls back to `timeout_secs` when the mod isn't in the map. Used for
    /// known-slow mods whose batches legitimately exceed the 2h global cap
    /// (e.g. dw_talents HLAs graph-walk on megainstalls with 120k override
    /// files). Configured via `install_config.json::per_mod_timeout_secs`.
    pub per_mod_timeout_secs: std::collections::HashMap<String, u64>,
    /// Per-mod component-numbers that must run as SINGLE-component batches
    /// (key = lowercase mod_name, value = list of cn). When a component from
    /// the list appears, the batcher breaks the batch so it runs alone.
    /// Used to shard dw_talents's slowest cn (60200 Revised HLAs, 60300
    /// Leveller) so a 2h timeout kills only one component instead of three.
    /// Configured via `install_config.json::force_single_cn_mods`.
    pub force_single_cn_mods: std::collections::HashMap<String, Vec<u32>>,
    pub weidu_log_mode: String,     // e.g., "autolog,logapp,log-extern"
    pub never_abort: bool,
    pub abort_on_warnings: bool,
    pub post_copy_delay_ms: u64,    // default 500, increase for network drives
    pub ocamlrunparam: String,      // OCaml GC tuning (default: "s=16M,o=500,O=1000000")
    pub bcs_scanner: bool,          // Enable BCS corruption scanner (debug installs)
    /// Mods whose components get packed into small batches (anti-segfault measure).
    /// Default: dw_talents, stratagems, mih_tweaks, mih_eq, mih_ip, trap_overhaul.
    pub force_small_batch_mods: Vec<String>,
    /// Batch size for the small-batch mods above. Default: 3. Raising this to 10-25
    /// reduces WeiDU invocation count (save ~5s startup per batch × 18 batches for
    /// dw_talents = ~90s saved) but increases segfault risk if the SFO Lua engine
    /// runs out of heap within a single invocation. With OCAMLRUNPARAM s=16M and
    /// the 32MB stack patch we apply, larger batches are usually safe.
    pub force_small_batch_size: usize,
    pub readln_defaults: std::collections::HashMap<String, Vec<String>>,
    pub readln_fallback: String,
    pub readln_timeout_secs: u64,   // Timeout for GUI-forwarded READLN prompts (default 30)
    pub auto_skip_after_retry: bool, // Auto retry once, then skip on failure (no GUI prompt)
    pub suppress_readmes: bool,      // Suppress AT_INTERACTIVE_EXIT readme popups
    pub sibling_directories: std::collections::HashMap<String, Vec<String>>,
    pub data_directory: Option<String>, // Where Infinity Mod Runner stores its own artifacts (default: next to exe)
    pub tlk_prewarm: bool,             // Pre-warm TLK into page cache (default: true)
    pub tlk_fast_drive: bool,          // Junction lang dir to fast drive (default: false)
    pub tlk_fast_drive_path: Option<String>, // Custom fast drive path (default: temp_dir)
    /// Redirect override/ to a fast drive (SSD or RAM disk) for the duration
    /// of the install. Can save 2-5× on I/O-heavy operations (SFO pattern scans)
    /// when target is a RAM disk. Off by default because target must be on a
    /// different volume than the game with 3× override size free.
    pub override_fast_drive: bool,
    /// Target path for override redirect (usually an NVMe, SSD, or RAM disk
    /// mount point). Falls back to system temp_dir when None.
    pub override_fast_drive_path: Option<String>,
    /// If true, file-guard surfaces every event as a pause-and-decide dialog; if false,
    /// guard auto-restores silently (default).
    pub pause_on_guard: bool,
    /// If true, the pre-biff optimization deletes original files from
    /// override/ after MAKE_BIFF succeeds. Without this, MAKE_BIFF copies
    /// files into the biff but leaves them in override/ — the biff sits
    /// unused and SFO-heavy mods still walk the full override. With this
    /// enabled, override/ shrinks to ~IDS + loose extras, and iteration
    /// cost drops by orders of magnitude (observed: 122k → ~60 files on
    /// one test install). On by default for new installs; can be disabled
    /// if a specific mod relies on iterating override/ as a directory
    /// (rare — most use WeiDU's resource namespace, which includes biffed
    /// files). Clamp-safe: if MAKE_BIFF fails or produces a zero-byte biff,
    /// the cleanup is skipped regardless of this flag.
    ///
    /// Named to match the A/B harness in `weidu_experimental/tools/`: the
    /// analyzer parses install.log for a `[PREBIFF] delete_optimization=...`
    /// line and cross-references against this flag. Same name in
    /// install_config.json so operators can toggle a single key to flip
    /// between baseline / biff-only / combined variants.
    pub enable_biff_delete_optimization: bool,
}

/// Resolve the data directory for Infinity Mod Runner artifacts (lockfile, checkpoint, install log, backups).
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

/// Map of (lowercase mod name, component number) → plain-English reason the
/// component is known to be slow on megainstalls. Consumed by the frontend's
/// Slow Batch UI so users running dw_talents cn:60200 (install #21 abort
/// cause) see "Revised HLAs — expected 30–90 min on megainstalls, do NOT
/// abort unless WeiDU output has been frozen for >10 min" instead of the
/// generic "this batch is running longer than usual" message.
///
/// The list is intentionally conservative — only components with repeated
/// test-cycle evidence of being slow-but-legitimate. Returning `None` means
/// the slow UI falls back to the generic tip.
pub fn known_slow_reason(mod_name_lower: &str, component: u32) -> Option<&'static str> {
    match (mod_name_lower, component) {
        // Talents of Faerun — SFO-heavy HLA graph walks. On megainstalls with
        // 120k+ override files these legitimately run 30–90 min each. cn:60200
        // (Revised HLAs) is the one that caused install #21 to be aborted at
        // 60 min — the user had no signal it was going to take that long.
        ("dw_talents", 60200) => Some(
            "Revised HLAs — a full override-dir walk that normally takes 30–90 minutes \
             on megainstalls. WeiDU is not stalled; let it run unless output has been \
             frozen for >10 minutes."
        ),
        ("dw_talents", 60300) => Some(
            "Leveller — another full override-dir walk, similar timing to cn:60200. \
             Not a stall; let it run."
        ),
        // Stratagems SCS AI scripting — known-slow on megainstalls.
        ("stratagems", 6000) => Some(
            "SCS AI — iterates and patches the full creature/script set. On megainstalls \
             this routinely takes 20+ minutes. Not a stall."
        ),
        _ => None,
    }
}
pub const DEFAULT_MAX_BATCH_SIZE: usize = 25;
pub const ESSENTIAL_MODS: &[&str] = &["dlcmerger", "eefixpack", "eet", "eet_end"];
pub const WATCHED_FILES: &[&str] = &["ACTION.IDS", "TRIGGER.IDS", "AREATYPE.IDS", "BD0120.BCS"];
pub const EET_AUTO_FILL_TRIGGER: &str = "Enter the full path to your BG:EE+SoD installation";

/// Runtime-configurable install parameters (loaded from install_config.json if available).
pub struct RuntimeConfig {
    pub force_small_batch_mods: Vec<String>,
    pub force_small_batch_size: usize,
    /// Per-mod timeout override (seconds). Mirrors InstallConfig field — loaded
    /// from install_config.json::per_mod_timeout_secs, then copied into
    /// InstallConfig at install-start time.
    pub per_mod_timeout_secs: std::collections::HashMap<String, u64>,
    /// Per-mod cn list for single-component batch sharding. Mirrors
    /// InstallConfig::force_single_cn_mods.
    pub force_single_cn_mods: std::collections::HashMap<String, Vec<u32>>,
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
    /// Optional override for the BIFF-delete optimization. When `Some`, this
    /// value wins over whatever the UI/frontend passed in — lets the A/B
    /// harness pin the flag from install_config.json alone:
    ///
    ///   enable_biff_delete_optimization: false   // [A] baseline
    ///   enable_biff_delete_optimization: true    // [C] biff-only, [D] combined
    ///
    /// `None` (default when absent from install_config.json) means "respect
    /// the caller's value" — i.e. the UI setting, which defaults to true.
    pub enable_biff_delete_optimization: Option<bool>,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        // Seed per-mod timeout for known-slow SFO-heavy mods. Absent entries
        // fall back to InstallConfig::timeout_secs (default 7200 = 2h).
        let mut per_mod_timeout_secs = std::collections::HashMap::new();
        per_mod_timeout_secs.insert("dw_talents".to_string(), 21600u64); // 6h — HLAs graph-walk exceeds 2h on megainstalls

        // Seed per-mod single-cn sharding. dw_talents cn:60200 (Revised HLAs)
        // and cn:60300 (Leveller) each do a full override-dir scan — shard
        // them so a timeout kills only the slow component, not its batch-mates.
        let mut force_single_cn_mods = std::collections::HashMap::new();
        force_single_cn_mods.insert("dw_talents".to_string(), vec![60200u32, 60300]);

        Self {
            force_small_batch_mods: FORCE_SMALL_BATCH_MODS.iter().map(|s| s.to_string()).collect(),
            force_small_batch_size: FORCE_SMALL_BATCH_SIZE,
            per_mod_timeout_secs,
            force_single_cn_mods,
            essential_mods: ESSENTIAL_MODS.iter().map(|s| s.to_string()).collect(),
            watched_files: WATCHED_FILES.iter().map(|s| s.to_string()).collect(),
            eet_auto_fill_trigger: EET_AUTO_FILL_TRIGGER.to_string(),
            ocamlrunparam: "s=16M,o=500,O=1000000".to_string(),
            pe_stack_reserve_mb: 32,
            readln_defaults: std::collections::HashMap::new(),
            readln_fallback: "1".to_string(),
            readln_timeout_secs: 30,
            sibling_directories: std::collections::HashMap::new(),
            enable_biff_delete_optimization: None,
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
            per_mod_timeout_secs: json.get("per_mod_timeout_secs")
                .and_then(|v| v.as_object())
                .map(|obj| {
                    obj.iter()
                        .filter(|(k, _)| !k.starts_with('_'))
                        .filter_map(|(k, v)| v.as_u64().map(|secs| (k.to_lowercase(), secs)))
                        .collect()
                })
                .unwrap_or(defaults.per_mod_timeout_secs),
            force_single_cn_mods: json.get("force_single_cn_mods")
                .and_then(|v| v.as_object())
                .map(|obj| {
                    obj.iter()
                        .filter(|(k, _)| !k.starts_with('_'))
                        .filter_map(|(k, v)| {
                            let cns: Vec<u32> = v.as_array()?
                                .iter()
                                .filter_map(|e| e.as_u64().map(|n| n as u32))
                                .collect();
                            Some((k.to_lowercase(), cns))
                        })
                        .collect()
                })
                .unwrap_or(defaults.force_single_cn_mods),
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
            // A/B harness toggle: pin the BIFF-delete optimization from
            // install_config.json alone. `None` means "not set in JSON,
            // defer to the caller's value". Accepts bool shapes only —
            // `"true"`/`"false"` strings are rejected (catch user typos).
            enable_biff_delete_optimization: json.get("enable_biff_delete_optimization")
                .and_then(|v| v.as_bool()),
        }
    }
}

use serde::{Deserialize, Serialize};

/// Persisted user configuration for the mod runner.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    pub bg2_game_dir: Option<String>,
    pub bg1_game_dir: Option<String>,
    pub mod_directory: Option<String>,
    pub weidu_path: Option<String>,
    pub mod_installer_path: Option<String>,
    pub forge_data_url: Option<String>,
    pub last_log_path: Option<String>,
    pub eet_log_path: Option<String>,
    pub bgee_log_path: Option<String>,
    // Essential install options
    #[serde(default = "default_true")]
    pub skip_installed: bool,
    #[serde(default = "default_timeout")]
    pub timeout: u64,
    #[serde(default)]
    pub download_mods: bool,
    #[serde(default)]
    pub abort_on_warnings: bool,
    #[serde(default)]
    pub never_abort: bool,
    // Advanced install options
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default = "default_depth")]
    pub depth: u32,
    #[serde(default)]
    pub strict_matching: bool,
    #[serde(default)]
    pub overwrite: bool,
    #[serde(default = "default_true")]
    pub check_last_installed: bool,
    #[serde(default = "default_tick")]
    pub tick: u32,
    #[serde(default = "default_lookback")]
    pub lookback: u32,
    #[serde(default = "default_weidu_log_mode")]
    pub weidu_log_mode: String,
    #[serde(default)]
    pub casefold: bool,
    #[serde(default)]
    pub generic_weidu_args: String,
    // Telemetry: None = never asked, Some(true) = opted in, Some(false) = opted out
    #[serde(default)]
    pub telemetry_opt_in: Option<bool>,
    // Backup directory: where game snapshots are stored
    #[serde(default)]
    pub backup_directory: Option<String>,
    // Data directory: where EETMR stores its own artifacts (logs, checkpoints, backups)
    #[serde(default)]
    pub data_directory: Option<String>,
    // UI language (en, de, fr, pl)
    #[serde(default)]
    pub ui_language: Option<String>,
}

fn default_true() -> bool { true }
fn default_timeout() -> u64 { 7200 }
fn default_language() -> String { "en_US".to_string() }
fn default_depth() -> u32 { 5 }
fn default_tick() -> u32 { 500 }
fn default_lookback() -> u32 { 10 }
fn default_weidu_log_mode() -> String { "autolog,logapp,log-extern".to_string() }



use serde::{Deserialize, Serialize};

/// Persisted user configuration for the mod runner.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct AppConfig {
    pub bg2_game_dir: Option<String>,
    pub bg1_game_dir: Option<String>,
    /// IWD:EE install directory. Optional — only used for backup/restore
    /// coverage when mods touch IWD (cross-game content, some tweaks).
    #[serde(default)]
    pub iwd_game_dir: Option<String>,
    /// Icewind Dale II install directory. Optional.
    #[serde(default)]
    pub iwd2_game_dir: Option<String>,
    /// Planescape: Torment EE install directory. Optional.
    #[serde(default)]
    pub pst_game_dir: Option<String>,
    pub mod_directory: Option<String>,
    pub weidu_path: Option<String>,
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
    /// Fallback WeiDU language — used when the primary language isn't
    /// available for a specific mod. Defaults to `en_US` since that's the
    /// locale every EET-compatible mod ships. The actual retry-on-fallback
    /// logic is TODO: when a per-mod install fails with a
    /// "Language not supported" diagnostic from WeiDU, the orchestrator
    /// should retry the batch with `--use-lang <language_fallback>`.
    #[serde(default = "default_language")]
    pub language_fallback: String,
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
    /// Optional per-game backup directory overrides. When Some(path), the
    /// panel uses that path for that game instead of `backup_directory`.
    /// None (default) means "use the global path". Useful when games live
    /// on different drives.
    #[serde(default)]
    pub backup_directory_bg1: Option<String>,
    #[serde(default)]
    pub backup_directory_bg2: Option<String>,
    #[serde(default)]
    pub backup_directory_iwd: Option<String>,
    #[serde(default)]
    pub backup_directory_iwd2: Option<String>,
    #[serde(default)]
    pub backup_directory_pst: Option<String>,
    // Data directory: where Infinity Mod Runner stores its own artifacts (logs, checkpoints, backups)
    #[serde(default)]
    pub data_directory: Option<String>,
    // UI language (en, de, fr, pl)
    #[serde(default)]
    pub ui_language: Option<String>,
    /// File-guard: when true, install pauses on every guard event (cross-mod silent
    /// modification) and prompts the user for restore/allow_once/allow_always.
    /// When false (default), guard auto-restores silently — recommended for most users.
    /// Power users / debugging sessions may want this on to inspect every event.
    #[serde(default)]
    pub pause_on_guard: bool,
    /// Delete original files from override/ after the pre-install MAKE_BIFF
    /// succeeds. Default true. Without this, MAKE_BIFF has no performance
    /// benefit — WeiDU's resource resolution checks override/ first and loads
    /// from disk even though the biff has the same files. With cleanup
    /// enabled, override drops to a handful of files post-BIFF and SFO-heavy
    /// mods (dw_talents cn:60200, stratagems cn:6000) run much faster.
    /// Disable only if a specific mod iterates override/ as a directory
    /// (rare — most use WeiDU's resource namespace, which sees biffed files).
    ///
    /// install_config.json's `enable_biff_delete_optimization` key wins
    /// over this UI value when present — see RuntimeConfig. The A/B test
    /// harness uses that for variant pinning.
    #[serde(default = "default_true")]
    pub enable_biff_delete_optimization: bool,
    /// Experimental: use the bundled patched WeiDU binary instead of the one at
    /// `weidu_path`. When enabled, the installer extracts the bundled binary
    /// to a cache directory and invokes THAT path — the user's configured
    /// `weidu_path` is left untouched, and the game directory is not modified
    /// in any way. Off by default; toggled via Ready Check tab with a
    /// confirmation modal. See `weidu_experimental/README.md` for background.
    #[serde(default)]
    pub use_experimental_weidu: bool,
    /// Ceiling on components per WeiDU invocation for non-heavy mods. Heavy
    /// mods (dw_talents/stratagems/mih_*/trap_overhaul) are independently
    /// capped at `heavy_batch_size` regardless of this value. Clamped to
    /// 1..=100 at the UI layer; default 25.
    #[serde(default = "default_max_batch_size")]
    pub max_batch_size: u32,
    /// Ceiling on components per WeiDU invocation for HEAVY mods
    /// (dw_talents, stratagems, mih_eq, mih_ip, mih_tweaks, trap_overhaul).
    /// These mods historically segfault WeiDU's OCaml GC when given large
    /// batches; the conservative default 3 has been safe in every observed
    /// install. Power users testing the upper bound — e.g. checking if a
    /// stack-patched WeiDU can survive larger batches for faster wall clock
    /// — can raise this at their own risk. Clamped 1..=25 at the UI.
    #[serde(default = "default_heavy_batch_size")]
    pub heavy_batch_size: u32,
    /// First-run welcome card dismissal timestamp (ISO8601). `None` means
    /// the user has never seen and dismissed the card — the next launch
    /// with `bg2_game_dir` still empty shows the card. A Some(_) value is
    /// a one-way door: we never show the card again even if the user wipes
    /// their config fields and starts over, because that'd be annoying for
    /// power users testing config edge cases. Re-showing is only possible
    /// by explicitly nulling this field in `config.toml`.
    #[serde(default)]
    pub welcome_dismissed_at: Option<String>,
    /// Opt-in guided mode: locks tabs in sequence (Setup → Mods → Ready
    /// Check → Install) and surfaces explicit "Next" buttons in each
    /// panel. Default false — power users and returning users are not
    /// subjected to the gating. Can be toggled at any time from Setup.
    #[serde(default)]
    pub guided_mode: bool,
    /// JSON-serialized snapshot of the user's preferred install-tab
    /// settings, captured when they click "Save my preferences" on the
    /// Install tab. `None` = the user has never saved preferences. We
    /// store it as a JSON string (not a typed struct) so the field set
    /// can grow without a schema migration — the frontend is the
    /// authority on which keys end up in the snapshot, and the backend
    /// just round-trips the blob. Survives restart via confy, which
    /// replaces the old localStorage approach that WebView2 could wipe
    /// between runs under some profile states.
    #[serde(default)]
    pub saved_install_defaults: Option<String>,
    /// Phase 22 (Windows Defender exclusion): when true, the installer
    /// adds the BG2 game directory to Defender's exclusion list via
    /// `Add-MpPreference` at install start. Requires admin elevation —
    /// triggers one UAC prompt per install where the exclusion isn't
    /// already in place. Default false so installs never produce
    /// surprise UAC prompts without opt-in. The first-run modal sets
    /// this on when the user clicks "Add exclusion & continue".
    ///
    /// No auto-remove on install end: we opt for permanent exclusion
    /// over per-install add/remove symmetry. Trades one cleanup UAC
    /// per install for the user's time. Users who want the exclusion
    /// gone can remove it manually via Windows Security settings.
    #[serde(default)]
    pub auto_defender_exclusion: bool,
    /// Phase 22: sticky flag set when the user clicks "Don't ask again"
    /// in the Defender pre-install modal. Once true, the modal never
    /// appears again — the checkbox in Install → Advanced remains
    /// available as the opt-in path. Separate from
    /// `auto_defender_exclusion` because "don't ask" ≠ "never use the
    /// feature": a user can enable the checkbox later even after
    /// dismissing the modal.
    #[serde(default)]
    pub defender_prompt_dismissed: bool,
}

fn default_max_batch_size() -> u32 { 25 }
fn default_heavy_batch_size() -> u32 { 3 }

fn default_true() -> bool { true }
fn default_timeout() -> u64 { 7200 }
fn default_language() -> String { "en_US".to_string() }
fn default_depth() -> u32 { 5 }
fn default_tick() -> u32 { 500 }
fn default_lookback() -> u32 { 10 }
fn default_weidu_log_mode() -> String { "autolog,logapp,log-extern".to_string() }



//! WeiDU command builder — constructs the exact command line for WeiDU invocation.

use super::{Batch, InstallConfig};
use std::path::Path;

/// Strip the Windows extended-length path prefix that Rust's canonicalize() adds.
/// WeiDU cannot parse `\\?\C:\...` paths.
#[cfg(windows)]
pub fn strip_extended_prefix(path: &str) -> String {
    path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
}

#[cfg(not(windows))]
pub fn strip_extended_prefix(path: &str) -> String {
    path.to_string()
}

/// Clean a PathBuf for WeiDU consumption (strip extended prefix).
pub fn clean_path(path: &Path) -> String {
    strip_extended_prefix(&path.to_string_lossy())
}

/// Build WeiDU arguments for a batch of components.
///
/// Produces: `modname/mod.tp2 --force-install N --force-install M ... --use-lang en_US --language 0 --no-exit-pause --logapp`
pub fn build_weidu_args(batch: &Batch, config: &InstallConfig) -> Vec<String> {
    let mut args = Vec::new();

    // First arg: relative tp2 path (e.g., "eefixpack/setup-eefixpack.tp2")
    // Always use forward slash — WeiDU expects Unix-style paths even on Windows
    let tp2_path = format!("{}/{}", batch.mod_name, batch.tp_file);
    args.push(tp2_path);

    // Component numbers: --force-install N for each
    for comp in &batch.components {
        args.push("--force-install".to_string());
        args.push(comp.component.to_string());
    }

    // Language
    args.push("--use-lang".to_string());
    args.push(config.language.clone());
    args.push("--language".to_string());
    args.push(batch.lang.to_string());

    // Standard flags for automated install
    args.push("--no-exit-pause".to_string());
    args.push("--noautoupdate".to_string());  // Skip WeiDU self-update check
    args.push("--quick-log".to_string());     // Faster weidu.log writes (skip descriptive names)
    args.push("--autolog".to_string());       // Ensure setup-MODNAME.DEBUG files are created

    // Log mode flags
    for flag in parse_log_mode(&config.weidu_log_mode) {
        args.push(flag);
    }

    args
}

/// Parse the weidu_log_mode string into WeiDU flags.
/// Input: "autolog,logapp,log-extern"
/// Output: ["--logapp", "--log", "path"] etc.
fn parse_log_mode(mode: &str) -> Vec<String> {
    let mut flags = Vec::new();
    // Always add --logapp first if present
    if mode.contains("logapp") {
        flags.push("--logapp".to_string());
    }
    // Other flags
    for part in mode.split(',') {
        match part.trim() {
            "logapp" => {} // Already added
            "autolog" => {
                // --autolog is the default WeiDU behavior, no flag needed
            }
            "log-extern" => {
                flags.push("--log-extern".to_string());
            }
            _ => {}
        }
    }
    flags
}

/// Build the full Command for WeiDU execution.
pub fn build_weidu_command(
    batch: &Batch,
    config: &InstallConfig,
    game_dir: &Path,
) -> std::process::Command {
    let weidu_path = clean_path(&config.weidu_path);
    let game_dir_clean = clean_path(game_dir);

    let args = build_weidu_args(batch, config);

    let mut cmd = std::process::Command::new(&weidu_path);
    cmd.current_dir(&game_dir_clean)
        .args(&args)
        // OCaml GC tuning — prevents 0xc0000005 segfaults on large installs:
        //   s=16M  = 128MB minor heap (64x default ~2MB, reduces minor GC frequency)
        //   o=500  = 500% space overhead (5x default, reduces major GC frequency)
        //   O=1000000 = disable heap compaction (compaction relocates memory blocks,
        //               can trigger stale-pointer crashes in WeiDU's unsafe-string code)
        // Note: l= is ONLY for bytecode (ocamlrun), not native code. WeiDU is native.
        .env("OCAMLRUNPARAM", &config.ocamlrunparam)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // Prevent blank CMD window on Windows + enable graceful shutdown
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP (needed for GenerateConsoleCtrlEvent)
        cmd.creation_flags(0x08000000 | 0x00000200);
    }

    // On Unix: increase stack size to 32MB for the WeiDU process (prevents stack overflow segfaults)
    // PE patching handles this on Windows; on Unix we use pre_exec + setrlimit
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            let stack_size: libc::rlim_t = 32 * 1024 * 1024; // 32 MB
            let rlim = libc::rlimit { rlim_cur: stack_size, rlim_max: stack_size };
            libc::setrlimit(libc::RLIMIT_STACK, &rlim);
            Ok(())
        });
    }

    cmd
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::installer::{Batch, Component, InstallConfig};
    use std::path::PathBuf;

    fn test_config() -> InstallConfig {
        InstallConfig {
            weidu_path: PathBuf::from("C:/weidu/weidu.exe"),
            bg2_game_dir: PathBuf::from("C:/Games/BG2EE"),
            bg1_game_dir: None,
            mod_directory: PathBuf::from("C:/Mods"),
            language: "en_US".to_string(),
            language_index: 0,
            max_batch_size: 25,
            skip_installed: true,
            timeout_secs: 7200,
            weidu_log_mode: "autolog,logapp,log-extern".to_string(),
            never_abort: false,
            abort_on_warnings: false,
            post_copy_delay_ms: 500,
            ocamlrunparam: "s=16M,o=500,O=1000000".to_string(),
            bcs_scanner: false,
            force_small_batch_mods: crate::installer::FORCE_SMALL_BATCH_MODS.iter().map(|s| s.to_string()).collect(),
            force_small_batch_size: crate::installer::FORCE_SMALL_BATCH_SIZE,
            per_mod_timeout_secs: std::collections::HashMap::new(),
            force_single_cn_mods: std::collections::HashMap::new(),
            readln_defaults: std::collections::HashMap::new(),
            readln_fallback: "1".to_string(),
            readln_timeout_secs: 30,
            auto_skip_after_retry: false,
            suppress_readmes: true,
            sibling_directories: std::collections::HashMap::new(),
            data_directory: None,
            tlk_prewarm: false,
            tlk_fast_drive: false,
            tlk_fast_drive_path: None,
            override_fast_drive: false,
            override_fast_drive_path: None,
            pause_on_guard: false,
            enable_biff_delete_optimization: false,
        }
    }

    #[test]
    fn test_args_single_component() {
        let batch = Batch {
            mod_name: "eefixpack".to_string(),
            tp_file: "setup-eefixpack.tp2".to_string(),
            lang: 0,
            components: vec![Component {
                tp_file: "setup-eefixpack.tp2".to_string(),
                mod_name: "eefixpack".to_string(),
                lang: 0,
                component: 0,
                component_name: "Core Fixes".to_string(),
            }],
            batch_index: 0,
        };
        let args = build_weidu_args(&batch, &test_config());
        assert!(args.contains(&"--force-install".to_string()));
        assert!(args.contains(&"0".to_string()));
        assert!(args.contains(&"--no-exit-pause".to_string()));
        assert!(args.contains(&"--logapp".to_string()));
    }
}

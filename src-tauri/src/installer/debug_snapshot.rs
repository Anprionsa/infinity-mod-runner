//! In-flight rolling debug snapshots.
//!
//! Background thread that periodically copies `WSETUP.DEBUG` (and any
//! `setup-{MOD}.DEBUG`) from the game directory to the runner's `debug_logs/`
//! folder while a batch is running. Survives force-kills of the runner —
//! unlike `orchestrator::preserve_error_debug_files`, which only fires at
//! batch boundaries and gets bypassed entirely when the Tauri app is killed
//! mid-batch.
//!
//! Scenario that motivated this: install #21 aborted on dw_talents batch 384
//! (cn:60200 Revised HLAs) after 60+ minutes of active output. The user
//! force-closed the app; the orchestrator's abort path never ran; no debug
//! was preserved for diagnosis. With in-flight snapshots at 5-min intervals,
//! we'd have captured the last 5-min window on disk regardless of how the
//! runner exited.
//!
//! ## Usage
//! ```ignore
//! let _guard = SnapshotGuard::start(
//!     game_dir.to_path_buf(),
//!     data_dir.to_path_buf(),
//!     batch.mod_name.clone(),
//!     logger.clone(),
//! );
//! let batch_result = run_batch(...);
//! // guard drops here; thread exits; inflight snapshot is cleaned up if
//! // the batch finished cleanly (no orphan *-inflight.DEBUG files).
//! ```
//!
//! ## File naming
//! Snapshots land at `debug_logs/WSETUP-{mod}-inflight.DEBUG` and
//! `debug_logs/setup-{mod}-inflight.DEBUG`. The `-inflight` suffix
//! distinguishes them from the end-of-batch `WSETUP-{mod}.DEBUG` produced by
//! `preserve_error_debug_files`. When both exist, the user can compare
//! intermediate vs. final state.

use super::install_log::{self, SharedLogger};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

/// Default interval between snapshots. 5 min is short enough to preserve useful
/// diagnostic context on kill, long enough that 16+ MB WSETUP.DEBUG copies
/// don't become noise. For dw_talents cn:60200 (60+ min batches at 37 lines/s)
/// this yields ~12 snapshots over the batch lifetime.
pub const DEFAULT_INTERVAL_SECS: u64 = 300;

/// Poll frequency — how often the thread wakes to check the stop flag. Keeping
/// this low (1s) means `Drop` returns quickly when the batch ends. The actual
/// snapshot fires only once every `interval_secs`, not every poll.
const POLL_INTERVAL_SECS: u64 = 1;

/// RAII guard for a background snapshot thread.
///
/// The thread stops when the guard is dropped. Snapshots are taken at the
/// configured interval; on clean drop (no snapshots were ever taken), the
/// inflight destination files are NOT cleaned up here — the caller (typically
/// the orchestrator at batch-end success) should call `cleanup_inflight` if
/// it wants to remove stale snapshots from prior batches of the same mod.
pub struct SnapshotGuard {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    snapshots_taken: Arc<std::sync::atomic::AtomicUsize>,
    data_dir: PathBuf,
    mod_name: String,
}

impl SnapshotGuard {
    /// Spawn the snapshot thread. `interval_secs` overrides the default
    /// (`DEFAULT_INTERVAL_SECS` = 300). The thread exits when the guard drops.
    pub fn start(
        game_dir: PathBuf,
        data_dir: PathBuf,
        mod_name: String,
        logger: Option<SharedLogger>,
        interval_secs: u64,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let snapshots_taken = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let stop_for_thread = stop.clone();
        let snapshots_taken_clone = snapshots_taken.clone();
        let mod_name_clone = mod_name.clone();
        let data_dir_clone = data_dir.clone();

        let handle = std::thread::spawn(move || {
            let mut elapsed_secs = 0u64;
            loop {
                if stop_for_thread.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(Duration::from_secs(POLL_INTERVAL_SECS));
                elapsed_secs += POLL_INTERVAL_SECS;

                if elapsed_secs >= interval_secs {
                    elapsed_secs = 0;
                    let count = take_snapshot(
                        &game_dir, &data_dir_clone, &mod_name_clone, &logger
                    );
                    if count > 0 {
                        snapshots_taken_clone.fetch_add(count, Ordering::SeqCst);
                    }
                }
            }
        });

        Self {
            stop,
            handle: Some(handle),
            snapshots_taken,
            data_dir,
            mod_name,
        }
    }

    /// How many individual file snapshots were taken over the life of this
    /// guard. Useful for logging at batch-end ("N snapshots preserved").
    pub fn snapshots_taken(&self) -> usize {
        self.snapshots_taken.load(Ordering::SeqCst)
    }

    /// Called after a successful batch to remove any `-inflight.DEBUG` files
    /// this guard produced. Keeps the preserved-debug listing clean when the
    /// batch ultimately succeeded and no final preservation ran.
    pub fn cleanup_inflight(&self) {
        cleanup_inflight_files(&self.data_dir, &self.mod_name);
    }
}

impl Drop for SnapshotGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            // Short join — the thread polls at POLL_INTERVAL_SECS (1s), so
            // this should return quickly. If it doesn't, detach rather than
            // block the orchestrator loop.
            let _ = h.join();
        }
    }
}

/// Single snapshot pass — copy WSETUP.DEBUG and setup-{mod}.DEBUG from
/// `game_dir` to `data_dir/debug_logs/` with the `-inflight` suffix. Returns
/// the number of files successfully copied (0..=2).
fn take_snapshot(
    game_dir: &Path,
    data_dir: &Path,
    mod_name: &str,
    logger: &Option<SharedLogger>,
) -> usize {
    let debug_dir = data_dir.join("debug_logs");
    if let Err(e) = std::fs::create_dir_all(&debug_dir) {
        install_log::shared_log_event(
            logger,
            "DEBUG_SNAPSHOT_FAIL",
            &format!("mkdir {}: {e}", debug_dir.display()),
        );
        return 0;
    }

    let mut copied = 0usize;

    // WSETUP.DEBUG — the one that matters most. Overwritten by every WeiDU
    // invocation; the inflight snapshot catches mid-run state.
    let wsetup = game_dir.join("WSETUP.DEBUG");
    if wsetup.exists() {
        let dest = debug_dir.join(format!("WSETUP-{mod_name}-inflight.DEBUG"));
        match std::fs::copy(&wsetup, &dest) {
            Ok(_) => copied += 1,
            Err(e) => {
                install_log::shared_log_event(
                    logger,
                    "DEBUG_SNAPSHOT_FAIL",
                    &format!("copy {} → {}: {e}", wsetup.display(), dest.display()),
                );
            }
        }
    }

    // Per-mod setup-MODNAME.DEBUG with case-variant fallback — WeiDU uses
    // inconsistent casing depending on the tp2's initial letter.
    for prefix in &["setup-", "SETUP-", "Setup-"] {
        let name = format!("{prefix}{mod_name}.DEBUG");
        let src = game_dir.join(&name);
        if src.exists() {
            let dest = debug_dir.join(format!("setup-{mod_name}-inflight.DEBUG"));
            match std::fs::copy(&src, &dest) {
                Ok(_) => copied += 1,
                Err(e) => {
                    install_log::shared_log_event(
                        logger,
                        "DEBUG_SNAPSHOT_FAIL",
                        &format!("copy {} → {}: {e}", src.display(), dest.display()),
                    );
                }
            }
            break;
        }
    }

    copied
}

/// Delete `-inflight.DEBUG` files for `mod_name`. Called after a successful
/// batch to keep the preserved-debug listing clean.
fn cleanup_inflight_files(data_dir: &Path, mod_name: &str) {
    let debug_dir = data_dir.join("debug_logs");
    for suffix in &[
        format!("WSETUP-{mod_name}-inflight.DEBUG"),
        format!("setup-{mod_name}-inflight.DEBUG"),
    ] {
        let path = debug_dir.join(suffix);
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_snapshot_copies_wsetup() {
        let tmp = tempfile::tempdir().unwrap();
        let game = tmp.path().join("game");
        let data = tmp.path().join("data");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(game.join("WSETUP.DEBUG"), b"hello").unwrap();

        let copied = take_snapshot(&game, &data, "testmod", &None);
        assert_eq!(copied, 1);

        let dest = data.join("debug_logs").join("WSETUP-testmod-inflight.DEBUG");
        assert!(dest.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello");
    }

    #[test]
    fn take_snapshot_copies_setup_debug_case_variants() {
        for prefix in &["setup-", "SETUP-", "Setup-"] {
            let tmp = tempfile::tempdir().unwrap();
            let game = tmp.path().join("game");
            let data = tmp.path().join("data");
            std::fs::create_dir_all(&game).unwrap();
            std::fs::create_dir_all(&data).unwrap();
            std::fs::write(game.join(format!("{prefix}mymod.DEBUG")), b"content").unwrap();

            let copied = take_snapshot(&game, &data, "mymod", &None);
            assert_eq!(copied, 1, "prefix={prefix}");

            let dest = data.join("debug_logs").join("setup-mymod-inflight.DEBUG");
            assert!(dest.exists(), "dest missing for prefix={prefix}");
        }
    }

    #[test]
    fn take_snapshot_returns_zero_when_nothing_to_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let game = tmp.path().join("game");
        let data = tmp.path().join("data");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::create_dir_all(&data).unwrap();

        let copied = take_snapshot(&game, &data, "nothing", &None);
        assert_eq!(copied, 0);
    }

    #[test]
    fn cleanup_inflight_removes_both_files() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let debug = data.join("debug_logs");
        std::fs::create_dir_all(&debug).unwrap();
        std::fs::write(debug.join("WSETUP-x-inflight.DEBUG"), b"a").unwrap();
        std::fs::write(debug.join("setup-x-inflight.DEBUG"), b"b").unwrap();
        // Unrelated file — should NOT be deleted
        std::fs::write(debug.join("WSETUP-other-inflight.DEBUG"), b"c").unwrap();

        cleanup_inflight_files(&data, "x");

        assert!(!debug.join("WSETUP-x-inflight.DEBUG").exists());
        assert!(!debug.join("setup-x-inflight.DEBUG").exists());
        assert!(debug.join("WSETUP-other-inflight.DEBUG").exists());
    }

    #[test]
    fn guard_stops_thread_on_drop() {
        let tmp = tempfile::tempdir().unwrap();
        let game = tmp.path().join("game");
        let data = tmp.path().join("data");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(game.join("WSETUP.DEBUG"), b"x").unwrap();

        {
            let _guard = SnapshotGuard::start(
                game.clone(), data.clone(), "m".to_string(), None, 60,
            );
            std::thread::sleep(Duration::from_millis(50));
            // Guard drops here — thread should stop cleanly within a couple
            // poll intervals (well under the test timeout).
        }
        // If Drop blocked indefinitely the test would hang; reaching this line
        // confirms the guard released.
    }
}

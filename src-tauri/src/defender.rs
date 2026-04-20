//! Windows Defender integration — programmatic exclusion management for
//! the game directory during an install.
//!
//! ## Why this exists
//!
//! On Windows with Defender's real-time protection enabled, every file
//! CloseHandle triggers a realtime scan of the file's contents. This adds
//! roughly 20 ms to the ~5 ms "raw" file-close cost. For SFO-heavy mods
//! that run thousands of sequential COPY+PATCH ops (dw_talents cn:60200
//! does ~130,000 of them in one component), the cumulative scan cost is
//! enormous — roughly 54 minutes of pure Defender overhead on that single
//! component, projected from observed throughput on the 2026-04-20 run.
//!
//! Excluding the game directory from Defender for the install's duration
//! drops per-op cost from ~25 ms to ~5 ms, a ~5× speedup on write-heavy
//! batches. dw_talents cn:60200 is projected to run ~1 h instead of ~5 h.
//!
//! ## API shape
//!
//! Four functions: [`status`], [`is_path_excluded`], [`add_exclusion`],
//! [`remove_exclusion`]. All are cross-platform (stub / no-op on non-
//! Windows) and idempotent (safe to call repeatedly). The add/remove
//! paths require admin elevation, obtained via PowerShell's
//! `Start-Process -Verb RunAs` — that produces a single UAC dialog the
//! user must accept. A user who cancels the UAC prompt gets
//! `Ok(false)` back (not an `Err`), and the caller is expected to
//! continue the install at degraded speed.
//!
//! ## Why PowerShell instead of a native crate
//!
//! `Get-MpPreference` / `Add-MpPreference` / `Remove-MpPreference` are
//! the official Microsoft-supported way to manage Defender. The
//! underlying WMI classes (`MSFT_MpPreference`) can be called directly
//! via the `windows` crate, but that's ~300 extra lines of COM setup
//! versus a single PowerShell invocation. We already depend on
//! PowerShell being present (every supported Windows version has it
//! built-in), so the cost is zero additional dependencies.

use std::path::Path;
use std::process::Command;

/// Defender realtime-protection state.
///
/// Reported to the frontend so the pre-install UI can show an accurate
/// "this will speed up your install by X" message instead of promising
/// a speedup that can't happen (e.g. user has Norton and Defender is
/// already inactive).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DefenderStatus {
    /// Defender exists and realtime protection is on. Adding an exclusion
    /// will produce a measurable speedup on file-write-heavy workloads.
    Active,
    /// Defender exists but realtime protection is disabled. Either the
    /// user turned it off, group policy disabled it, or a third-party AV
    /// (Norton, Avast, etc.) registered with Windows Security Center and
    /// Defender deferred. Adding a Defender exclusion won't help here —
    /// the 3rd-party AV is doing the scanning.
    Inactive,
    /// Not running on Windows (macOS, Linux). All exclusion operations
    /// silently no-op. Caller should treat this as "nothing to do, no
    /// impact on install speed either way."
    NotApplicable,
    /// The status query itself failed — PowerShell not in PATH, policy
    /// restriction on Get-MpComputerStatus, exotic Windows edition that
    /// doesn't expose Defender cmdlets (Windows Server Core without the
    /// AV role, for example). Treat as "don't try automatic management"
    /// and let the user handle it manually.
    Unknown,
}

// ── Status ────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
pub fn status() -> DefenderStatus {
    // `(Get-MpComputerStatus).RealTimeProtectionEnabled` is the
    // authoritative read. No admin needed. Wrapped in try/catch so we
    // cleanly report "Unknown" on locked-down systems rather than
    // propagating a PowerShell exception.
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "try { (Get-MpComputerStatus).RealTimeProtectionEnabled } catch { 'ERROR' }",
        ])
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let trimmed = stdout.trim().to_lowercase();
            match trimmed.as_str() {
                "true" => DefenderStatus::Active,
                "false" => DefenderStatus::Inactive,
                _ => DefenderStatus::Unknown,
            }
        }
        _ => DefenderStatus::Unknown,
    }
}

#[cfg(not(target_os = "windows"))]
pub fn status() -> DefenderStatus {
    DefenderStatus::NotApplicable
}

// ── Exclusion list query ──────────────────────────────────────────────

/// Returns true if the given path is already in Defender's exclusion
/// list. Used by [`add_exclusion`] for idempotency (never asks for UAC
/// if the exclusion is already in place) and by the post-add verify
/// (confirms the elevation actually succeeded vs. was silently blocked
/// by Group Policy).
#[cfg(target_os = "windows")]
pub fn is_path_excluded(path: &Path) -> bool {
    // Canonicalize for comparison. Defender normalizes paths too (trailing
    // slash, case), and we want "C:\Foo" to match "c:\foo\". If canon
    // fails (path doesn't exist on disk — shouldn't happen pre-install
    // but be tolerant), fall back to the provided path.
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let target = normalize_for_cmp(&canonical.to_string_lossy());

    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            // -join with newline makes the output line-delimited no matter
            // how PowerShell would normally format the array (can otherwise
            // be space-separated or truncated on long lists).
            "(Get-MpPreference).ExclusionPath -join [Environment]::NewLine",
        ])
        .output();

    let Ok(o) = output else {
        return false;
    };
    if !o.status.success() {
        return false;
    }

    let stdout = String::from_utf8_lossy(&o.stdout);
    stdout
        .lines()
        .map(normalize_for_cmp)
        .any(|line| line == target)
}

#[cfg(not(target_os = "windows"))]
pub fn is_path_excluded(_path: &Path) -> bool {
    false
}

#[cfg(target_os = "windows")]
fn normalize_for_cmp(s: &str) -> String {
    // Strip trailing backslashes and lowercase for Windows filesystem
    // case-insensitive comparison. UNC paths / drive letters normalize fine
    // because they don't have interior whitespace.
    s.trim().trim_end_matches(['\\', '/']).to_lowercase()
}

// ── Add / remove (both require admin elevation) ───────────────────────

/// Add `path` to Defender's exclusion list. Returns:
///   - `Ok(true)`  — the exclusion is present after the call (either we
///                   added it, or it was already there)
///   - `Ok(false)` — we couldn't add it and the exclusion is NOT present
///                   (most commonly: user cancelled the UAC prompt).
///                   The install should continue at degraded speed.
///   - `Err(msg)`  — PowerShell couldn't be invoked at all, or another
///                   unrecoverable error (Defender disabled by policy,
///                   etc.). Caller should log and continue without the
///                   exclusion.
#[cfg(target_os = "windows")]
pub fn add_exclusion(path: &Path) -> Result<bool, String> {
    if is_path_excluded(path) {
        return Ok(true);
    }

    let path_str = path.to_string_lossy();
    // Escape single quotes: PowerShell uses '' to represent a literal '
    // inside a single-quoted string.
    let escaped = path_str.replace('\'', "''");

    // Two-layer PowerShell. The OUTER powershell runs non-elevated and
    // uses `Start-Process -Verb RunAs` to spawn an elevated child; the
    // INNER command (passed as -Command) runs as admin and performs the
    // actual Add-MpPreference call.
    //
    // `-Wait` blocks until the elevated child exits, so our Command's
    // exit code reflects the result of the add (not just "UAC was
    // acknowledged"). `-WindowStyle Hidden` keeps the elevated PowerShell
    // console invisible — otherwise a black flash appears.
    let inner = format!("Add-MpPreference -ExclusionPath '{}'", escaped);
    let outer = format!(
        "Start-Process -FilePath powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',\"{}\"",
        // Escape double quotes for the outer string context
        inner.replace('"', "`\"")
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &outer])
        .output()
        .map_err(|e| format!("Failed to invoke PowerShell: {e}"))?;

    // Final authority on success is whether the path is now in the list.
    // Process exit code isn't reliable — elevation cancellation returns
    // varied error codes across Windows versions and the elevated child
    // may succeed/fail independently.
    if is_path_excluded(path) {
        Ok(true)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr_trim = stderr.trim();
        // UAC cancellation typically produces no stderr or a "cancelled"
        // substring. We treat silent failure as "user cancelled" rather
        // than erroring — erroring would fail the install, and cancelling
        // a perf optimization shouldn't do that.
        if stderr_trim.is_empty()
            || stderr_trim.contains("cancel")
            || stderr_trim.contains("1223")
        {
            Ok(false)
        } else {
            Err(format!("Add-MpPreference failed: {stderr_trim}"))
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn add_exclusion(_path: &Path) -> Result<bool, String> {
    Ok(false)
}

/// Remove `path` from Defender's exclusion list. Same return semantics as
/// [`add_exclusion`]. Safe to call when the path isn't actually in the
/// list (returns `Ok(true)` immediately — "the exclusion is not present
/// after the call" is the post-condition, which holds trivially).
#[cfg(target_os = "windows")]
pub fn remove_exclusion(path: &Path) -> Result<bool, String> {
    if !is_path_excluded(path) {
        return Ok(true);
    }

    let path_str = path.to_string_lossy();
    let escaped = path_str.replace('\'', "''");
    let inner = format!("Remove-MpPreference -ExclusionPath '{}'", escaped);
    let outer = format!(
        "Start-Process -FilePath powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',\"{}\"",
        inner.replace('"', "`\"")
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &outer])
        .output()
        .map_err(|e| format!("Failed to invoke PowerShell: {e}"))?;

    if !is_path_excluded(path) {
        Ok(true)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr_trim = stderr.trim();
        if stderr_trim.is_empty()
            || stderr_trim.contains("cancel")
            || stderr_trim.contains("1223")
        {
            Ok(false)
        } else {
            Err(format!("Remove-MpPreference failed: {stderr_trim}"))
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn remove_exclusion(_path: &Path) -> Result<bool, String> {
    Ok(true)
}

//! Experimental WeiDU binary — bundled-and-cached model.
//!
//! The design contract in one paragraph:
//!   Infinity Mod Runner ships a patched WeiDU binary for each supported platform.
//!   When the user opts in (Settings/Ready Check → Resilient WeiDU), the
//!   orchestrator extracts that bundled binary into a cache directory at
//!   `<data_dir>/.weidu_cache/weidu{.exe}` and invokes THAT path as its
//!   installer. The user's configured `weidu_path` is never touched, and
//!   the game directory is never modified in any way — no `setup-*.exe`
//!   swapping, no backup dir, no state to revert. Toggling the feature off
//!   simply restores the normal "use the configured `weidu_path`" behavior
//!   on the next install start.
//!
//! See `src-tauri/weidu_experimental/README.md` for the maintenance workflow
//! that produces the bundled binaries.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

// ── Types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeiduExperimentalMeta {
    pub schema_version: u32,
    pub feature_id: String,
    pub display_name: String,
    pub status: String,
    pub base_weidu_version: String,
    pub patch_revision: u32,
    pub build_version: String,
    pub description: String,
    pub what_it_changes: Vec<String>,
    pub risks: Vec<String>,
    #[serde(default)]
    pub complementary: String,
    /// Where the bundled binary came from. The meta.json field was renamed
    /// from `upstream_source` (URL-only) to `upstream_snapshot` (descriptive
    /// text that happens to start with a URL). We accept both names so an
    /// older meta.json from a previous build still deserializes — e.g. the
    /// dry-run path doesn't break just because someone regenerated the
    /// bundled WeiDU meta with new field names.
    #[serde(alias = "upstream_snapshot")]
    pub upstream_source: String,
    /// Relative path inside the experimental dir that holds the source tree
    /// the patched WeiDU was built from. Optional — older meta.json files
    /// predate this field and should still load.
    #[serde(default)]
    pub source_tree: String,
    pub platforms: BTreeMap<String, PlatformEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformEntry {
    pub zip: String,
    pub zip_sha256: String,
    pub zip_size: u64,
    pub weidu_path_in_zip: String,
    pub weidu_sha256: String,
    pub weidu_size: u64,
}

/// Public status surface. Reflects on-disk truth, not user preference —
/// the frontend reads the `use_experimental_weidu` config value separately.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapStatus {
    /// A bundled binary exists for the running platform.
    pub supported: bool,
    /// `"windows-x86_64" | "macos" | "linux-x86_64"` — None if the current
    /// platform isn't in the meta.json platforms map.
    pub platform_key: Option<String>,
    /// Absolute path where the cached binary lives (or would live) when
    /// extracted. Useful for the UI to display the resolved target.
    pub cache_path: Option<String>,
    /// True iff the cache file exists AND its SHA256 matches the meta.json
    /// `weidu_sha256`. False if missing, corrupt, or stale from a previous
    /// version of the bundled binary.
    pub cache_valid: bool,
    /// Full meta.json contents — for rendering the description/risks panel.
    pub meta: Option<WeiduExperimentalMeta>,
}

// ── Platform detection ──

fn current_platform_key() -> Option<&'static str> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    { return Some("windows-x86_64"); }
    #[cfg(target_os = "macos")]
    { return Some("macos"); }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    { return Some("linux-x86_64"); }
    #[allow(unreachable_code)]
    None
}

// ── Resource loading ──

fn weidu_experimental_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {e}"))?;
    Ok(resource_dir.join("weidu_experimental"))
}

fn load_meta(app: &AppHandle) -> Result<WeiduExperimentalMeta, String> {
    let meta_path = weidu_experimental_dir(app)?.join("meta.json");
    let contents = std::fs::read_to_string(&meta_path).map_err(|e| {
        format!(
            "Failed to read experimental WeiDU meta.json at {}: {e}",
            meta_path.display()
        )
    })?;
    serde_json::from_str(&contents).map_err(|e| format!("Failed to parse meta.json: {e}"))
}

// ── Cache location ──

/// Resolve the cache root for the patched WeiDU binary.
///
/// The cache is NOT per-game-dir — the same bundled binary serves any install,
/// so we sit above `resolve_data_dir`'s per-game subdir. Layout:
///
///   <data_directory or exe/data>/.weidu_cache/weidu{.exe}
///
/// When `data_directory` is None we fall back to `<exe-dir>/data/.weidu_cache`,
/// mirroring `installer::resolve_data_dir`'s default base.
fn cache_dir_for(data_directory: Option<&str>) -> PathBuf {
    let base: PathBuf = match data_directory {
        Some(s) if !s.is_empty() => PathBuf::from(s),
        _ => std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.join("data")))
            .unwrap_or_else(|| PathBuf::from("data")),
    };
    base.join(".weidu_cache")
}

fn cache_binary_path(cache_dir: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    return cache_dir.join("weidu.exe");
    #[cfg(not(target_os = "windows"))]
    return cache_dir.join("weidu");
}

// ── Hashing ──

fn sha256_file(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

// ── Zip extraction ──

fn extract_patched_bytes(
    app: &AppHandle,
    meta: &WeiduExperimentalMeta,
) -> Result<Vec<u8>, String> {
    let platform = current_platform_key().ok_or_else(|| {
        "Experimental WeiDU is not built for this platform".to_string()
    })?;
    let entry = meta.platforms.get(platform).ok_or_else(|| {
        format!("No experimental WeiDU build bundled for platform '{platform}'")
    })?;

    let zip_path = weidu_experimental_dir(app)?.join(&entry.zip);
    let zip_bytes = std::fs::read(&zip_path)
        .map_err(|e| format!("Failed to read bundled zip {}: {e}", zip_path.display()))?;

    let actual_zip_sha = sha256_bytes(&zip_bytes);
    if actual_zip_sha != entry.zip_sha256 {
        return Err(format!(
            "Bundled zip for {platform} failed integrity check — expected {}, got {}",
            entry.zip_sha256, actual_zip_sha
        ));
    }

    let cursor = std::io::Cursor::new(&zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| format!("Failed to open bundled zip: {e}"))?;
    let mut file = archive.by_name(&entry.weidu_path_in_zip).map_err(|e| {
        format!(
            "Bundled zip missing expected entry '{}': {e}",
            entry.weidu_path_in_zip
        )
    })?;
    let mut bytes = Vec::with_capacity(entry.weidu_size as usize);
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read weidu binary from zip: {e}"))?;

    let actual_bin_sha = sha256_bytes(&bytes);
    if actual_bin_sha != entry.weidu_sha256 {
        return Err(format!(
            "Extracted binary failed integrity check — expected {}, got {}",
            entry.weidu_sha256, actual_bin_sha
        ));
    }

    Ok(bytes)
}

// ── Status computation ──

pub fn compute_status_inner(
    app: &AppHandle,
    data_directory: Option<&str>,
) -> Result<SwapStatus, String> {
    let meta = load_meta(app).ok();
    let platform_key = current_platform_key().map(String::from);
    let supported = meta
        .as_ref()
        .and_then(|m| platform_key.as_ref().and_then(|k| m.platforms.get(k)))
        .is_some();

    let cache_dir = cache_dir_for(data_directory);
    let cache_bin = cache_binary_path(&cache_dir);
    let cache_path = Some(cache_bin.to_string_lossy().to_string());

    let expected_sha = meta
        .as_ref()
        .and_then(|m| platform_key.as_ref().and_then(|k| m.platforms.get(k)))
        .map(|p| p.weidu_sha256.clone());

    let cache_valid = match (cache_bin.exists(), &expected_sha) {
        (true, Some(expected)) => match sha256_file(&cache_bin) {
            Ok(actual) => actual == *expected,
            Err(_) => false,
        },
        _ => false,
    };

    Ok(SwapStatus {
        supported,
        platform_key,
        cache_path,
        cache_valid,
        meta,
    })
}

// ── Extract ──

/// Ensure the patched binary exists in the cache and matches the expected hash.
/// Re-extracts if missing or stale. Returns the absolute path of the cached binary.
///
/// Called both by the explicit user action (Enable button) and by the
/// orchestrator's path resolver at install start — the latter makes the feature
/// self-healing if the cache was deleted between runs.
pub fn extract_inner(
    app: &AppHandle,
    data_directory: Option<&str>,
) -> Result<PathBuf, String> {
    let meta = load_meta(app)?;
    let platform = current_platform_key()
        .ok_or_else(|| "Experimental WeiDU is not built for this platform".to_string())?;
    let entry = meta
        .platforms
        .get(platform)
        .ok_or_else(|| format!("No experimental WeiDU build bundled for platform '{platform}'"))?;

    let cache_dir = cache_dir_for(data_directory);
    let cache_bin = cache_binary_path(&cache_dir);

    // Short-circuit: already extracted and hash matches.
    if cache_bin.exists() {
        if let Ok(actual) = sha256_file(&cache_bin) {
            if actual == entry.weidu_sha256 {
                return Ok(cache_bin);
            }
        }
    }

    // Re-extract.
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create cache dir {}: {e}", cache_dir.display()))?;

    let bytes = extract_patched_bytes(app, &meta)?;
    std::fs::write(&cache_bin, &bytes)
        .map_err(|e| format!("Failed to write cached binary {}: {e}", cache_bin.display()))?;

    // Unix: honor exec bit. No-op on Windows.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&cache_bin)
            .map_err(|e| format!("Failed to stat {}: {e}", cache_bin.display()))?
            .permissions();
        perms.set_mode(perms.mode() | 0o755);
        std::fs::set_permissions(&cache_bin, perms)
            .map_err(|e| format!("Failed to chmod {}: {e}", cache_bin.display()))?;
    }

    log::info!(
        "weidu_swap: extracted patched binary ({} bytes) to {}",
        bytes.len(),
        cache_bin.display()
    );
    Ok(cache_bin)
}

// ── Clear cache ──

pub fn clear_cache_inner(data_directory: Option<&str>) -> Result<(), String> {
    let cache_dir = cache_dir_for(data_directory);
    let cache_bin = cache_binary_path(&cache_dir);
    if cache_bin.exists() {
        std::fs::remove_file(&cache_bin)
            .map_err(|e| format!("Failed to remove cached binary: {e}"))?;
    }
    // If the dir is now empty, remove it too to keep the tree tidy.
    if let Ok(mut it) = std::fs::read_dir(&cache_dir) {
        if it.next().is_none() {
            let _ = std::fs::remove_dir(&cache_dir);
        }
    }
    Ok(())
}

// ── Path resolver — the hook the installer calls ──

/// Return the path the installer should invoke as its WeiDU binary.
///
/// When `enabled=false`, returns `configured_path` verbatim. When `enabled=true`,
/// ensures the bundled binary is extracted to the cache and returns that path.
/// If extraction fails (unsupported platform, corrupt zip, etc.) returns an Err
/// so the install is aborted cleanly — we explicitly do NOT silently fall back
/// to `configured_path` because that would change install behavior from under
/// the user without warning.
pub fn resolve_path_inner(
    app: &AppHandle,
    data_directory: Option<&str>,
    configured_path: &str,
    enabled: bool,
) -> Result<String, String> {
    if !enabled {
        return Ok(configured_path.to_string());
    }
    let cached = extract_inner(app, data_directory)?;
    Ok(cached.to_string_lossy().to_string())
}

// ── Tauri commands ──

#[tauri::command]
pub fn weidu_swap_status(
    app: AppHandle,
    data_directory: Option<String>,
) -> Result<SwapStatus, String> {
    compute_status_inner(&app, data_directory.as_deref())
}

#[tauri::command]
pub fn weidu_swap_extract(
    app: AppHandle,
    data_directory: Option<String>,
) -> Result<SwapStatus, String> {
    extract_inner(&app, data_directory.as_deref())?;
    compute_status_inner(&app, data_directory.as_deref())
}

#[tauri::command]
pub fn weidu_swap_clear_cache(
    app: AppHandle,
    data_directory: Option<String>,
) -> Result<SwapStatus, String> {
    clear_cache_inner(data_directory.as_deref())?;
    compute_status_inner(&app, data_directory.as_deref())
}

#[tauri::command]
pub fn weidu_swap_resolve_path(
    app: AppHandle,
    data_directory: Option<String>,
    configured_path: String,
    enabled: bool,
) -> Result<String, String> {
    resolve_path_inner(&app, data_directory.as_deref(), &configured_path, enabled)
}

/// Return the bundled `meta.json` without touching any files.
#[tauri::command]
pub fn weidu_swap_meta(app: AppHandle) -> Result<WeiduExperimentalMeta, String> {
    load_meta(&app)
}

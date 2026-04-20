import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { AppConfig } from "../App";

export async function loadConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("load_config");
}

export async function saveConfig(config: AppConfig): Promise<void> {
  return invoke("save_config", { config });
}

export async function validateGameDir(path: string): Promise<boolean> {
  return invoke<boolean>("validate_game_dir", { path });
}

export async function detectWeidu(): Promise<string | null> {
  return invoke<string | null>("detect_weidu");
}

export async function readFileContents(path: string): Promise<string> {
  return invoke<string>("read_file_contents", { path });
}

export interface GameFreshness {
  is_fresh: boolean;
  has_weidu_log: boolean;
  weidu_log_entries: number;
  override_count: number;
  dialog_tlk_size: number;
  dialog_tlk_mb: number;
  has_setup_scripts: boolean;
  warnings: string[];
}

export async function checkGameFreshness(
  path: string,
): Promise<GameFreshness> {
  return invoke<GameFreshness>("check_game_freshness", { path });
}

export async function getBinaryVersion(path: string): Promise<string | null> {
  return invoke<string | null>("get_binary_version", { path });
}

export interface ErrorLogEntry {
  timestamp: string;
  level: string;
  mod_name: string;
  message: string;
  /** Raw `WARNING:` lines the Rust runner captured during this component's
   * install. Propagated from the `install:batch_done` event payload so the
   * Issues panel can classify them via `warning-classifier.ts` without
   * having to re-parse WeiDU stdout. Undefined when the component emitted
   * no warnings or was an error/skip outcome. */
  warnings?: string[];
}

export interface WeiduVerification {
  success: boolean;
  version: string | null;
  error: string | null;
}

export interface ModDirScan {
  exists: boolean;
  mod_count: number;
  tp2_count: number;
  sample_mods: string[];
  error: string | null;
}

export async function verifyWeidu(weiduPath: string): Promise<WeiduVerification> {
  return invoke<WeiduVerification>("verify_weidu", { weiduPath });
}

export async function scanModDirectory(modDir: string): Promise<ModDirScan> {
  return invoke<ModDirScan>("scan_mod_directory", { modDir });
}

// ─── Ready-Check environment probes ───
// These moved from the Dry Run report into Ready Check as part of the
// split: Ready Check owns "is the environment ready?" (this file),
// Dry Run owns "what will WeiDU actually do?".

export interface JunctionTestResult {
  ok: boolean;
  error: string | null;
}

export async function testJunctionCapability(gameDir: string): Promise<JunctionTestResult> {
  return invoke<JunctionTestResult>("test_junction_capability", { gameDir });
}

export interface DiskSpaceReport {
  gameFree: number; // bytes, 0 = lookup failed
  dataFree: number;
  modFree: number;
}

export async function checkDiskSpaces(
  gameDir: string,
  dataDir: string,
  modDir: string,
): Promise<DiskSpaceReport> {
  return invoke<DiskSpaceReport>("check_disk_spaces", { gameDir, dataDir, modDir });
}

// ─── WeiDU Version Check ───

export interface WeiduVersionInfo {
  localVersion: number;        // e.g., 25201
  localVersionStr: string;     // e.g., "252.01"
  isNightly: boolean;          // "under development" in output
  latestVersion: number;       // e.g., 25100
  latestVersionStr: string;    // e.g., "251.00"
  latestTag: string;           // e.g., "v251.00"
  updateAvailable: boolean;    // latestVersion > localVersion (only for stable)
  downloadUrl: string | null;  // platform-specific ZIP URL
}

/** Parse WeiDU version number from --version output like "[path] WeiDU version 25100" */
export function parseWeiduVersion(versionStr: string): { version: number; isNightly: boolean } {
  const match = versionStr.match(/version\s+(\d+)/i);
  const version = match ? parseInt(match[1], 10) : 0;
  const isNightly = versionStr.toLowerCase().includes("under development")
    || versionStr.toLowerCase().includes("nightly")
    || versionStr.toLowerCase().includes("dev");
  return { version, isNightly };
}

/** Format version number 25100 → "251.00" */
function formatWeiduVersion(v: number): string {
  return `${Math.floor(v / 100)}.${String(v % 100).padStart(2, "0")}`;
}

/** Check for WeiDU updates via GitHub API */
export async function checkWeiduUpdate(localVersionStr: string): Promise<WeiduVersionInfo> {
  const { version: localVersion, isNightly } = parseWeiduVersion(localVersionStr);

  // Fetch latest release from GitHub
  const resp = await fetch("https://api.github.com/repos/WeiDUorg/weidu/releases/latest", {
    headers: { Accept: "application/vnd.github.v3+json" },
  });
  if (!resp.ok) throw new Error(`GitHub API: ${resp.status}`);
  const release = await resp.json();

  const tagName: string = release.tag_name || "";
  const latestMatch = tagName.match(/v?(\d+)\.(\d+)/);
  const latestVersion = latestMatch
    ? parseInt(latestMatch[1], 10) * 100 + parseInt(latestMatch[2], 10)
    : 0;

  // Pick platform-specific download URL
  const platform = navigator.platform?.toLowerCase() || "";
  let assetKeyword = "Windows";
  if (platform.includes("linux")) assetKeyword = "Linux";
  else if (platform.includes("mac")) {
    assetKeyword = navigator.userAgent?.includes("ARM") || platform.includes("arm") ? "Mac-ARM" : "Mac";
  }
  const assets: { name: string; browser_download_url: string }[] = release.assets || [];
  const asset = assets.find(a => a.name.includes(assetKeyword) && !a.name.includes("legacy"));
  const downloadUrl = asset?.browser_download_url || null;

  // Update available only if local is a stable release AND older than latest
  const updateAvailable = !isNightly && latestVersion > localVersion;

  return {
    localVersion,
    localVersionStr: formatWeiduVersion(localVersion),
    isNightly,
    latestVersion,
    latestVersionStr: formatWeiduVersion(latestVersion),
    latestTag: tagName,
    updateAvailable,
    downloadUrl,
  };
}

export async function checkModExists(
  modDir: string,
  gameDir: string,
  tp2Path: string,
): Promise<boolean> {
  return invoke<boolean>("check_mod_exists", { modDir, gameDir, tp2Path });
}

export async function pickDirectory(title: string): Promise<string | null> {
  const result = await open({ directory: true, title });
  return result as string | null;
}

export async function pickFile(
  title: string,
  filters?: { name: string; extensions: string[] }[],
): Promise<string | null> {
  const result = await open({ directory: false, title, filters });
  return result as string | null;
}

/** Save-dialog picker. Returns the selected file path, or null if the
 * user cancelled. Used by the Diagnostic Bundle feature to let users
 * choose where the output zip goes (default: Downloads folder). */
export async function pickSaveLocation(
  title: string,
  defaultName: string,
  filters?: { name: string; extensions: string[] }[],
): Promise<string | null> {
  const result = await save({ title, defaultPath: defaultName, filters });
  return result as string | null;
}

export async function writeTempLog(content: string, filename: string): Promise<string> {
  return invoke<string>("write_temp_log", { content, filename });
}

// ─── Native WeiDU Installer ───

export interface NativeInstallArgs {
  weiduPath: string;
  bg2GameDir: string;
  bg1GameDir: string | null;
  modDirectory: string;
  eetLogPath: string;
  bgeeLogPath: string | null;
  language: string;
  languageIndex: number;
  skipInstalled: boolean;
  timeout: number;
  neverAbort: boolean;
  abortOnWarnings: boolean;
  weiduLogMode: string;
  maxBatchSize?: number;
  /** Per-batch cap for heavy mods (dw_talents, stratagems, mih_*,
   * trap_overhaul). Default 3; raising is a stress-test setting. */
  heavyBatchSize?: number;
  pausePoints: { afterModIndex: number; message: string; phase: string }[];
  bcsScanner?: boolean;
  autoSkipAfterRetry?: boolean;
  suppressReadmes?: boolean;
  dataDirectory?: string | null;
  pauseOnGuard?: boolean;
  /** Redirect game/override/ to a fast drive during install. Advanced option. */
  overrideFastDrive?: boolean;
  /** Target path for the override redirect (e.g. "R:\\" for a RAM disk,
   * or another NVMe mount). Only used when overrideFastDrive is true.
   * Must be on a DIFFERENT volume than the game or no benefit. */
  overrideFastDrivePath?: string | null;
  /** Delete original files from override/ after MAKE_BIFF succeeds during
   * the mid-install BIFF optimization. Default true. Without this, the
   * BIFF step is a no-op for performance — WeiDU's resource resolution
   * hits override/ first and loads from disk anyway. With this enabled,
   * override drops from ~120k files to ~60 on megainstalls, and SFO-
   * heavy mods (dw_talents cn:60200, stratagems cn:6000) that iterate
   * the resource namespace run dramatically faster.
   *
   * Takes precedence over nothing — install_config.json's
   * `enable_biff_delete_optimization` overrides this when set, so the
   * A/B test harness can pin variants from JSON alone. */
  enableBiffDeleteOptimization?: boolean;
}

export async function startNativeInstall(args: NativeInstallArgs): Promise<void> {
  return invoke("start_native_install", { args });
}

export async function startDryRun(args: NativeInstallArgs): Promise<void> {
  return invoke("start_dry_run", { args });
}

export async function installDecision(decision: "retry" | "skip" | "stop"): Promise<void> {
  return invoke("install_decision", { decision });
}

export async function installPause(): Promise<void> {
  return invoke("install_pause");
}

export async function installResume(): Promise<void> {
  return invoke("install_resume");
}

export async function installSendInput(text: string): Promise<void> {
  return invoke("install_send_input", { text });
}

export async function abortNativeInstall(): Promise<void> {
  return invoke("abort_native_install");
}

// ─── Pre-Install Patcher ───

export interface PatchStatus {
  id: number;
  name: string;
  description: string;
  targetMod: string | null;
  status: "applicable" | "already_patched" | "not_needed";
  recommended: boolean;
  category: PatchCategory;
}

/** Category buckets surfaced from `patch_manifest.json`. Drives grouping,
 * badge color, and "sticky required" behavior in the Ready Check patch list. */
export type PatchCategory =
  | "required"      // install breaks without it — sticky selection
  | "bugfix"        // WeiDU-level fix (crash, BCS round-trip, SFO lib) — majority
  | "compat"        // cross-mod compatibility shim
  | "performance"   // throughput/perf optimization — reserved, empty today
  | "cosmetic";     // UI/HLA/description fixes, non-functional

export interface PatchResult {
  id: number;
  name: string;
  status: "applied" | "already_patched" | "failed";
  error: string | null;
}

export async function scanPatches(
  modDir: string,
  gameDir: string,
): Promise<PatchStatus[]> {
  return invoke<PatchStatus[]>("scan_patches", { modDir, gameDir });
}

export async function applyPatches(
  modDir: string,
  gameDir: string,
  patchIds: number[],
): Promise<PatchResult[]> {
  return invoke<PatchResult[]>("apply_patches", { modDir, gameDir, patchIds });
}

// ─── Install Report ───

export async function saveInstallReport(
  reportJson: string,
  path: string,
): Promise<void> {
  return invoke("save_install_report", { reportJson, path });
}

// ─── Backup & Restore ───

export interface BackupEstimate {
  totalBytes: number;
  fileCount: number;
  availableSpace: number;
  hasEnoughSpace: boolean;
}

export interface BackupInfo {
  name: string;
  timestamp: string;
  mode: string;
  totalBytes: number;
  fileCount: number;
  path: string;
  completed: boolean;
  /** Which game this backup represents ("bg1" | "bg2" | "iwd" | "iwd2" | "pst").
   * Defaults to "bg2" for backups created before Phase 9b — those didn't
   * carry a game_kind marker and were always BG2 back then. */
  gameKind: string;
}

export interface BackupProgress {
  bytesCopied: number;
  totalBytes: number;
  filesCopied: number;
  totalFiles: number;
  currentFile: string;
  phase: string;
}

export async function estimateBackup(gameDir: string, backupDir: string, mode: string): Promise<BackupEstimate> {
  return invoke<BackupEstimate>("estimate_backup", { gameDir, backupDir, mode });
}

export async function createBackup(gameDir: string, backupDir: string, name: string, mode: string, gameKind: string): Promise<void> {
  return invoke("create_backup", { gameDir, backupDir, name, mode, gameKind });
}

export async function listBackups(backupDir: string): Promise<BackupInfo[]> {
  return invoke<BackupInfo[]>("list_backups", { backupDir });
}

export async function restoreBackup(backupPath: string, gameDir: string, modDir?: string): Promise<void> {
  return invoke("restore_backup", { backupPath, gameDir, modDir });
}

export interface OrphanBackup {
  path: string;
  modName: string;
  sizeBytes: number;
}

export async function scanOrphanBackups(modDir: string): Promise<OrphanBackup[]> {
  return invoke<OrphanBackup[]>("scan_orphan_backups", { modDir });
}

export async function cleanOrphanBackups(paths: string[]): Promise<string[]> {
  return invoke<string[]>("clean_orphan_backups", { paths });
}

export interface VerifyResult {
  /** True when the manifest's file count + total bytes match what's on
   * disk AND the backup is marked completed. False means the backup is
   * suspect — file count mismatch, truncated archive, or creation was
   * interrupted. Inspect `issues` for details. */
  ok: boolean;
  manifestFileCount: number;
  manifestTotalBytes: number;
  actualFileCount: number;
  actualTotalBytes: number;
  /** Human-readable list of mismatches. Empty when `ok` is true. */
  issues: string[];
}

export async function verifyBackup(backupPath: string): Promise<VerifyResult> {
  return invoke<VerifyResult>("verify_backup", { backupPath });
}

export async function deleteBackup(backupPath: string): Promise<void> {
  return invoke("delete_backup", { backupPath });
}

export async function abortBackup(): Promise<void> {
  return invoke("abort_backup");
}

// ── Experimental WeiDU (bundled patched binary used at install start) ──

export interface WeiduExperimentalPlatformEntry {
  zip: string;
  zip_sha256: string;
  zip_size: number;
  weidu_path_in_zip: string;
  weidu_sha256: string;
  weidu_size: number;
}

export interface WeiduExperimentalMeta {
  schema_version: number;
  feature_id: string;
  display_name: string;
  status: string;
  base_weidu_version: string;
  patch_revision: number;
  build_version: string;
  description: string;
  what_it_changes: string[];
  risks: string[];
  complementary?: string;
  /** Provenance string for the bundled binary. Rust deserializes either
   * `upstream_source` or `upstream_snapshot` from meta.json into this field,
   * so the frontend always sees `upstream_source` in the serialized struct
   * regardless of which spelling the meta.json used. May be a plain URL
   * (older meta.json format) or descriptive text containing a URL (newer
   * format) — the panel renders it via `formatProvenance()` which extracts
   * the URL for href use when present. */
  upstream_source: string;
  /** Relative path inside the experimental dir holding the source tree the
   * binary was built from. Empty string when the meta.json predates this
   * field. */
  source_tree?: string;
  platforms: Record<string, WeiduExperimentalPlatformEntry>;
}

/** On-disk truth about the experimental weidu cache. `cacheValid=true` means
 * the cached binary file exists AND its SHA256 matches meta.json — no
 * re-extract needed before use. */
export interface WeiduSwapStatus {
  supported: boolean;
  platformKey: string | null;
  cachePath: string | null;
  cacheValid: boolean;
  meta: WeiduExperimentalMeta | null;
}

export async function weiduSwapStatus(dataDirectory?: string | null): Promise<WeiduSwapStatus> {
  return invoke<WeiduSwapStatus>("weidu_swap_status", { dataDirectory: dataDirectory ?? null });
}

/** Extract the bundled binary to the cache (idempotent — no-op if already valid). */
export async function weiduSwapExtract(dataDirectory?: string | null): Promise<WeiduSwapStatus> {
  return invoke<WeiduSwapStatus>("weidu_swap_extract", { dataDirectory: dataDirectory ?? null });
}

/** Remove the cached binary. Does not affect any config — the feature is
 * driven by `use_experimental_weidu` in config, not by cache presence. */
export async function weiduSwapClearCache(dataDirectory?: string | null): Promise<WeiduSwapStatus> {
  return invoke<WeiduSwapStatus>("weidu_swap_clear_cache", { dataDirectory: dataDirectory ?? null });
}

/** Resolve the weidu path the installer should invoke. Called right before
 * install/dry-run start. When `enabled=false` returns `configuredPath`
 * verbatim; when `enabled=true` ensures the bundled binary is extracted and
 * returns the cache path. Fails rather than silently falling back, so a
 * broken bundle surfaces clearly to the user. */
export async function weiduSwapResolvePath(
  configuredPath: string,
  enabled: boolean,
  dataDirectory?: string | null,
): Promise<string> {
  return invoke<string>("weidu_swap_resolve_path", {
    configuredPath,
    enabled,
    dataDirectory: dataDirectory ?? null,
  });
}

export async function weiduSwapMeta(): Promise<WeiduExperimentalMeta> {
  return invoke<WeiduExperimentalMeta>("weidu_swap_meta");
}

// ─── Windows Defender exclusion management ───
//
// Thin wrappers over the `defender_*` Tauri commands. All four calls are
// safe on non-Windows (`status` returns `not_applicable`, the booleans
// return trivial success). The UI uses `status` + `is_path_excluded` to
// decide whether to show the pre-install exclusion modal at all —
// pointless to prompt on Linux or when Norton already disabled Defender.

/** Realtime-protection state reported by Defender. `not_applicable` on
 * non-Windows. `unknown` when the query itself failed (locked-down
 * Windows edition, PowerShell missing from PATH, etc.). */
export type DefenderStatus =
  | "active"
  | "inactive"
  | "not_applicable"
  | "unknown";

export async function defenderStatus(): Promise<DefenderStatus> {
  return invoke<DefenderStatus>("defender_status");
}

/** Check whether `path` is already in Defender's exclusion list. No admin
 * needed. Returns false on non-Windows. */
export async function defenderIsPathExcluded(path: string): Promise<boolean> {
  return invoke<boolean>("defender_is_path_excluded", { path });
}

/** Add `path` to Defender's exclusion list. Triggers one UAC prompt.
 * Returns:
 *   - true  — exclusion is present afterwards (we added it OR it was
 *             already there)
 *   - false — user cancelled UAC; install can still run, just slower
 * Throws when a structural failure occurred (PowerShell not found,
 * Group Policy blocked the add, etc.). */
export async function defenderAddExclusion(path: string): Promise<boolean> {
  return invoke<boolean>("defender_add_exclusion", { path });
}

/** Remove `path` from Defender's exclusion list. Same semantics as add —
 * `true` if the path is absent from the list after the call. Use after
 * an install completes when the user opted into auto-remove. */
export async function defenderRemoveExclusion(path: string): Promise<boolean> {
  return invoke<boolean>("defender_remove_exclusion", { path });
}

// ─── Log paths / diagnostics (Phase 21) ───

/** Per-file metadata paired with a LogPaths entry. `key` is a stable
 * identifier the UI matches on ("gui_log", "install_log", etc.).
 * `path` is null when the path couldn't be computed (e.g. no game dir
 * configured). `size` is 0 for missing files and for unresolved paths. */
export interface FileMeta {
  key: string;
  path: string | null;
  exists: boolean;
  size: number;
  modified_ms: number;
}

/** The full log-path surface + per-file metadata. Returned by
 * `get_log_paths` in one round-trip so LogsPanel doesn't have to stat
 * each path separately. */
export interface LogPathsWithMeta {
  paths: {
    gui_log: string;
    gui_log_rotated: string[];
    install_log: string | null;
    reports_dir: string | null;
    guard_report: string | null;
    checkpoint: string | null;
    config_toml: string;
    data_root: string | null;
    game_data_dir: string | null;
    app_config_root: string;
  };
  files: FileMeta[];
}

/** Resolve every log / report / state path for the given config + stat
 * each. Called by LogsPanel on mount + every ~30s while visible.
 * Fails only on OS-level "can't find config dir" — per-game paths
 * that depend on unset fields come back as `null` rather than
 * erroring, so the UI renders "not present — will be created when…". */
export async function getLogPaths(config: import("../App").AppConfig): Promise<LogPathsWithMeta> {
  return invoke<LogPathsWithMeta>("get_log_paths", { config });
}

/** Open a file or folder in the OS file manager. Windows highlights the
 * file if `path` is a file; macOS selects it; Linux opens the parent
 * directory (no universal reveal API across Linux file managers). */
export async function openPath(path: string): Promise<void> {
  return invoke<void>("open_path", { path });
}

export interface BundleEntry {
  name: string;
  size: number;
}

export interface BundleSummary {
  bundle_path: string;
  bundle_size: number;
  entries: BundleEntry[];
  redacted_fields: string[];
}

/** Package gui.log + install.log + reports + guard + redacted config
 * into a local zip at `outputPath`. Local operation only — no network.
 * Returns a manifest of what was bundled so the UI can reassure the
 * user what's inside before they attach it anywhere. */
export async function createDiagnosticBundle(
  config: import("../App").AppConfig,
  outputPath: string,
): Promise<BundleSummary> {
  return invoke<BundleSummary>("create_diagnostic_bundle", {
    config,
    outputPath,
  });
}

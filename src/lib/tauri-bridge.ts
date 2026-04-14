import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
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

// Old mod_installer interfaces removed — native installer uses Tauri events

export interface ErrorLogEntry {
  timestamp: string;
  level: string;
  mod_name: string;
  message: string;
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
  pausePoints: { afterModIndex: number; message: string; phase: string }[];
  bcsScanner?: boolean;
  autoSkipAfterRetry?: boolean;
  suppressReadmes?: boolean;
  dataDirectory?: string | null;
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
  target_mod: string | null;
  status: "applicable" | "already_patched" | "not_needed";
}

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

export async function createBackup(gameDir: string, backupDir: string, name: string, mode: string): Promise<void> {
  return invoke("create_backup", { gameDir, backupDir, name, mode });
}

export async function listBackups(backupDir: string): Promise<BackupInfo[]> {
  return invoke<BackupInfo[]>("list_backups", { backupDir });
}

export async function restoreBackup(backupPath: string, gameDir: string): Promise<void> {
  return invoke("restore_backup", { backupPath, gameDir });
}

export async function deleteBackup(backupPath: string): Promise<void> {
  return invoke("delete_backup", { backupPath });
}

export async function abortBackup(): Promise<void> {
  return invoke("abort_backup");
}

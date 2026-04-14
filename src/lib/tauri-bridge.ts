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

export async function detectModInstaller(): Promise<string | null> {
  return invoke<string | null>("detect_mod_installer");
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

export interface InstallStatus {
  current: number;
  total: number;
  mod: string;  // JSON key is "mod" due to #[serde(rename = "mod")] in Rust
  component: string;
  status: string;
  errors: number;
  warnings: number;
  skipped: number;
  last_updated: string;
}

export interface ErrorLogEntry {
  timestamp: string;
  level: string;
  mod_name: string;
  message: string;
}

export interface ErrorLogResult {
  entries: ErrorLogEntry[];
  total_lines: number;
}

export async function readInstallStatus(
  gameDir: string,
): Promise<InstallStatus | null> {
  return invoke<InstallStatus | null>("read_install_status", {
    gameDir,
  });
}

export async function readErrorLog(
  gameDir: string,
  afterLine: number,
): Promise<ErrorLogResult> {
  return invoke<ErrorLogResult>("read_error_log", {
    gameDir,
    afterLine,
  });
}

export interface PauseState {
  pause_requested: boolean;
  is_paused: boolean;
}

export async function requestPause(gameDir: string): Promise<void> {
  return invoke("request_pause", { gameDir });
}

export async function requestResume(gameDir: string): Promise<void> {
  return invoke("request_resume", { gameDir });
}

export async function checkPauseState(gameDir: string): Promise<PauseState> {
  return invoke<PauseState>("check_pause_state", { gameDir });
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

export async function countWeiduLogEntries(gameDir: string): Promise<number> {
  return invoke<number>("count_weidu_log_entries", { gameDir });
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

/**
 * GUI Logger — writes timestamped entries to gui.log via Rust backend.
 *
 * This log captures ONLY GUI-level events (not WeiDU output, not mod_installer logs).
 * Categories:
 *   APP     — launch, shutdown, version
 *   CONFIG  — config load/save
 *   IMPORT  — log file import results
 *   PREFLIGHT — pre-flight check results
 *   INSTALL — install start/stop/abort, state transitions
 *   POLL    — status polling results (sampled, not every poll)
 *   INVOKE  — Tauri invoke call failures
 *   UI      — tab switches, user actions
 *   ERROR   — uncaught exceptions, promise rejections
 */

import { invoke } from "@tauri-apps/api/core";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
type LogCategory =
  | "APP"
  | "CONFIG"
  | "IMPORT"
  | "PREFLIGHT"
  | "INSTALL"
  | "POLL"
  | "INVOKE"
  | "UI"
  | "ERROR";

// Buffer entries in case Rust backend isn't ready yet
const pendingEntries: { timestamp: string; level: LogLevel; category: LogCategory; message: string }[] = [];
let backendReady = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function timestamp(): string {
  return new Date().toISOString();
}

async function flush() {
  if (pendingEntries.length === 0) return;
  const entries = [...pendingEntries];
  pendingEntries.length = 0;

  for (const entry of entries) {
    try {
      await invoke("gui_log", entry);
      backendReady = true;
    } catch {
      // Backend not ready yet — put it back
      pendingEntries.unshift(entry);
      break;
    }
  }
}

function enqueue(level: LogLevel, category: LogCategory, message: string) {
  const entry = { timestamp: timestamp(), level, category, message };
  pendingEntries.push(entry);

  // Also log to browser console for dev
  const consoleMethod = level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
  consoleMethod(`[GUI:${category}] ${message}`);

  // Flush periodically (not per-entry to avoid hammering invoke)
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, backendReady ? 500 : 2000);
  }
}

/** The public logger API */
export const guiLog = {
  debug(category: LogCategory, message: string) {
    enqueue("DEBUG", category, message);
  },
  info(category: LogCategory, message: string) {
    enqueue("INFO", category, message);
  },
  warn(category: LogCategory, message: string) {
    enqueue("WARN", category, message);
  },
  error(category: LogCategory, message: string) {
    enqueue("ERROR", category, message);
  },

  /** Force flush all pending entries now (e.g., before app close) */
  async flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flush();
  },
};

/** Read the full gui.log contents */
export async function readGuiLog(): Promise<string> {
  return invoke<string>("read_gui_log");
}

/** Clear the gui.log */
export async function clearGuiLog(): Promise<void> {
  return invoke("clear_gui_log");
}

/** Get the file path of gui.log */
export async function getGuiLogPath(): Promise<string> {
  return invoke<string>("get_gui_log_path");
}

/** Install global error handlers to capture uncaught exceptions */
export function installGlobalErrorHandlers() {
  window.addEventListener("error", (event) => {
    guiLog.error("ERROR", `Uncaught: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    guiLog.error("ERROR", `Unhandled promise rejection: ${event.reason}`);
  });
}

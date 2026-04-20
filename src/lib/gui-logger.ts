/**
 * GUI Logger — writes timestamped entries to `gui.log` via Rust backend.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  LOG FORMAT (stable contract for parsers — humans AND AIs)
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  Each line:   TIMESTAMP [LEVEL] [CATEGORY] PROSE [key=value key=value …]
 *
 *  - TIMESTAMP is ISO-8601 UTC, e.g. `2026-04-14T00:29:21.863Z`
 *  - LEVEL is one of: DEBUG, INFO, WARN, ERROR
 *  - CATEGORY is one of: APP, CONFIG, IMPORT, PREFLIGHT, READYCHECK, INSTALL,
 *      DOWNLOAD, POLL, INVOKE, UI, ERROR, PRESET, BACKUP, EXPERIMENTAL
 *  - PROSE is a free-text description (human-readable)
 *  - Optional structured tail in `[brackets]` at end: space-separated `key=value`.
 *    Parsers that don't care can ignore it. Values with spaces are quoted.
 *
 *  SESSION BOUNDARIES
 *  ------------------
 *  Each app launch emits:
 *     [INFO] [APP] ─── SESSION-START ─── version=<ver>
 *  Grep `SESSION-START` to enumerate launches.
 *
 *  INSTALL EVENT TAXONOMY
 *  ----------------------
 *  An install produces one contiguous group of INSTALL lines, all sharing a
 *  `session=<id>` tail. `grep session=<id>` reconstructs the full install.
 *
 *     start       Install kicked off. Tail: total_comps, total_batches, weidu.
 *                 Emitted once total_batches becomes known (first batch_start);
 *                 may appear AFTER one or more `Pre-install:` lines if the
 *                 orchestrator reports already-installed components first.
 *     pre_install Pre-install already-installed record. Prose:
 *                 `Pre-install: <mod> — N components already installed`.
 *                 Always precedes `start` in a session where something was
 *                 already installed from a prior run. Tail: session, comp.
 *     batch_done  One batch finished. Tail: batch=N/M, session, [comp=x/y]
 *                 Prose names the mod + per-status counts. If err+warn > 0,
 *                 prose ends with `— see WSETUP.DEBUG`.
 *     batch_error A batch failed (not just a warn). Tail: session, batch.
 *     pause       Pause point hit. Tail: session.
 *     fatal       An essential mod failed; orchestrator will auto-abort.
 *                 ERROR level. Prose: `FATAL: essential mod 'X' failed …`.
 *                 Always precedes an `aborted` complete line.
 *     complete    Install finished successfully. Prose: `Completed in …`.
 *     aborted     Install stopped early. Prose: `Aborted at batch N/M after …`
 *                 OR `Aborted (essential mod 'X' failed) at batch N/M …` when
 *                 preceded by a fatal event. Tail carries `cause=<reason>`
 *                 when applicable. Both variants include the full tally.
 *                 "Aborted" alone (no cause tail, no preceding fatal line) is
 *                 user-initiated — look above for `Abort requested by user`.
 *
 *  ARITHMETIC INVARIANT
 *  --------------------
 *  For every complete/aborted line:
 *      ok + err + warn + skip + already + pending == total
 *  `already` = components detected as already-installed and skipped at plan time
 *  (omitted from tally when zero). `pending` = components never reached (abort
 *  mid-install; omitted when zero). On a clean `complete`, pending == 0.
 *
 *  PER-BATCH vs SUMMARY ERR/SKIP DISCREPANCY (not a bug)
 *  -----------------------------------------------------
 *  Adding up `err` counts from `batch_done` lines often does NOT equal the
 *  `err` count in the final `complete`/`aborted` line. This is intentional:
 *
 *    - `batch_done` reports the IMMEDIATE outcome of a batch when WeiDU finishes
 *      it. If 3 components erred, the line reads `0 ok, 3 err`.
 *    - The Rust orchestrator may then auto-retry the failed batch once
 *      (`auto_skip_after_retry`). If the retry doesn't fix anything, those
 *      components are RECLASSIFIED as `skipped` in the cumulative tracker.
 *    - The `complete`/`aborted` summary reflects post-retry final state, so
 *      the same components show up under `skip` instead of `err`.
 *
 *  In practice, summing per-batch errs ≈ summary skip count. The two views
 *  answer different questions:
 *    "What happened in this batch?"  →  per-batch `batch_done` line
 *    "What's the final disposition?" →  summary line tally
 *  When auditing, treat them as complementary, not contradictory.
 *
 *  TAB SWITCHES
 *  ------------
 *  Tab-switch events (`[DEBUG] [UI] Tab: …`) are console-only and NOT written
 *  to `gui.log`. Dev tools still show them.
 *
 *  ROTATION
 *  --------
 *  On startup, the Rust backend rotates `gui.log`:
 *    - If the app version differs from the last-logged version, the current
 *      `gui.log` is renamed `gui.log.prev-<old_version>` and a fresh log starts.
 *    - If `gui.log` exceeds 5 MB, it rotates to `gui.log.1` (keeping 3 gens).
 *  Per-version archives are kept indefinitely up to a total cap of 10 files.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { invoke } from "@tauri-apps/api/core";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
type LogCategory =
  | "APP"
  | "CONFIG"
  | "IMPORT"
  | "PREFLIGHT"
  | "READYCHECK"
  | "INSTALL"
  | "DOWNLOAD"
  | "POLL"
  | "INVOKE"
  | "UI"
  | "ERROR"
  | "PRESET"
  | "BACKUP"
  | "EXPERIMENTAL"
  | "DEFENDER";

interface LogOptions {
  /** When false, the entry is written to the console only, not to gui.log. Default true. */
  writeToFile?: boolean;
}

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

function enqueue(level: LogLevel, category: LogCategory, message: string, opts?: LogOptions) {
  // Always log to browser console for dev
  const consoleMethod = level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
  consoleMethod(`[GUI:${category}] ${message}`);

  // Optionally skip writing to file (tab switches, etc.)
  if (opts?.writeToFile === false) return;

  const entry = { timestamp: timestamp(), level, category, message };
  pendingEntries.push(entry);

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
  debug(category: LogCategory, message: string, opts?: LogOptions) {
    enqueue("DEBUG", category, message, opts);
  },
  info(category: LogCategory, message: string, opts?: LogOptions) {
    enqueue("INFO", category, message, opts);
  },
  warn(category: LogCategory, message: string, opts?: LogOptions) {
    enqueue("WARN", category, message, opts);
  },
  error(category: LogCategory, message: string, opts?: LogOptions) {
    enqueue("ERROR", category, message, opts);
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

// ─────────────────────────────────────────────────────────────────────────
//  Install session tracking
// ─────────────────────────────────────────────────────────────────────────
//  An "install session" is a single start→complete/abort run. All lines
//  belonging to the session carry a `session=<id>` tail. Batch timing is
//  tracked here so batch_done events can report their own duration.
// ─────────────────────────────────────────────────────────────────────────

interface InstallSession {
  id: string;           // 8-char hex
  startedAt: number;    // ms epoch
  totalBatches: number;
  totalComponents: number;
  batchStartTimes: Map<number, number>; // batch_idx -> ms epoch
  /** Highest batch_idx observed across batch_start / batch_done / batch_error.
   * Used by the "Aborted at batch N/M" summary so that auto-skip-after-retry
   * cascades (which skip many batch indices without firing batch_start) don't
   * undercount the final batch. Tracked as a 0-based index; formatted as +1. */
  lastBatchIdx: number;
  weiduVersion?: string; // remembered so the "Install started" line can tag it
  readyLogged: boolean;  // true once the "Install started" line has been emitted
  /** Set by `logInstallFatal` when an essential mod fails. Consumed by
   * `logInstallComplete` to tag the "Aborted" summary line with a cause. */
  abortCause?: { modName: string; reason: string };
}

let currentSession: InstallSession | null = null;

/** 8-char hex session id, preferring crypto.randomUUID() where available. */
function makeSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    }
  } catch { /* fall through */ }
  // Fallback: Math.random hex (fine for log correlation, not security)
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

/** Append a structured tail to a log message. */
export function withTail(message: string, extras: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(extras)) {
    if (v === undefined || v === null || v === "") continue;
    const str = String(v);
    // Quote values containing spaces
    parts.push(str.includes(" ") ? `${k}="${str}"` : `${k}=${str}`);
  }
  return parts.length ? `${message} [${parts.join(" ")}]` : message;
}

/** Start a new install session silently. Returns the session id.
 *
 * NOTE: We do NOT emit the "Install started" log line here. Rationale:
 * `total_batches` is unknown until the Rust orchestrator builds the plan
 * and fires the first `batch_start` event. Emitting here would hardcode
 * "0 batches" into the log. Instead, the ready line is emitted from
 * `noteBatchStart` the first time totalBatches transitions to non-zero. */
export function startInstallSession(totalComponents: number, totalBatches: number, weiduVersion?: string | null): string {
  const id = makeSessionId();
  currentSession = {
    id,
    startedAt: Date.now(),
    totalBatches,
    totalComponents,
    batchStartTimes: new Map(),
    lastBatchIdx: -1,
    weiduVersion: weiduVersion ?? undefined,
    readyLogged: false,
  };
  return id;
}

/** Called from batch_start event. Records start time, lazily populates
 * totalBatches, and emits the one-shot "Install started" ready line once we
 * know how many batches are in the plan. */
export function noteBatchStart(batchIdx: number, totalBatches?: number) {
  if (!currentSession) return;
  currentSession.batchStartTimes.set(batchIdx, Date.now());
  if (batchIdx > currentSession.lastBatchIdx) currentSession.lastBatchIdx = batchIdx;
  if (totalBatches && currentSession.totalBatches === 0) {
    currentSession.totalBatches = totalBatches;
  }
  if (!currentSession.readyLogged && currentSession.totalBatches > 0) {
    currentSession.readyLogged = true;
    guiLog.info("INSTALL", withTail(
      `Install started — ${currentSession.totalComponents} components, ${currentSession.totalBatches} batches`,
      { session: currentSession.id, weidu: currentSession.weiduVersion }
    ));
  }
}

/** Log a batch_done rollup. counts is the result of reducing the ComponentResult[] array.
 *
 * Two distinct shapes of batch_done come through:
 *   1. Real install batches (after a `batch_start` was recorded) — log as
 *      `Batch N/M done in Xs: <mod> — <counts>`
 *   2. Pre-install "already installed" records emitted by the Rust orchestrator
 *      before any batch_start fires (totalBatches still 0, no start time).
 *      These represent components the plan filtered out because they were
 *      already installed from a prior run. Log them with a dedicated prefix
 *      so they don't pollute the Batch N/M sequence with `1/0 done in ?`. */
export function logBatchDone(
  batchIdx: number,
  modDisplay: string,
  modTp2: string,
  counts: {
    ok: number; warn: number; err: number; skip: number; already: number;
    /** Subset of `skip`: components explicitly cancelled by an abort (not
     * organic retry-failures). When all non-success components in a batch
     * are cancellations, we emit a "cancelled" verb instead of "done" so the
     * log line reads as user-action rather than a mod failure. */
    cancelled?: number;
  },
  completedComponents: number,
) {
  if (!currentSession) return;
  const start = currentSession.batchStartTimes.get(batchIdx);
  if (batchIdx > currentSession.lastBatchIdx) currentSession.lastBatchIdx = batchIdx;
  const { totalBatches, totalComponents, id } = currentSession;

  // Pre-install already-installed record: no start time AND totalBatches
  // still unknown. Emit a distinct format.
  if (!start && totalBatches === 0) {
    const n = counts.ok + counts.already + counts.warn + counts.err + counts.skip;
    guiLog.info("INSTALL", withTail(
      `Pre-install: ${modDisplay} (${modTp2}) — ${n} components already installed`,
      { session: id, comp: `${completedComponents}/${totalComponents}` }
    ));
    return;
  }

  const durStr = start ? formatDuration(Date.now() - start) : "?";
  const batchNum = batchIdx + 1;
  const cancelled = counts.cancelled ?? 0;
  // "Fully cancelled" = no successful work AND every non-success component is
  // a cancellation. These batches get the "cancelled" verb to reflect that
  // the user pulled the plug mid-batch rather than the mod genuinely failing.
  const fullyCancelled = cancelled > 0 && counts.ok === 0 && counts.err === 0
    && counts.warn === 0 && cancelled === counts.skip;
  // "Cascade-skipped" = no batch_start was ever recorded (durStr === "?") AND
  // every component is a skip. This is the tracker.rs pre-skip path: an
  // upstream batch in the same mod failed, so downstream batches are emitted
  // with all components flagged skip and no timing. Using the "done in ?"
  // phrase for these is misleading — read as "we don't know how long".
  // "cascade-skipped" is the accurate verb: the orchestrator never actually
  // ran WeiDU for these components.
  const cascadeSkipped = !start && counts.skip > 0
    && counts.ok === 0 && counts.err === 0 && counts.warn === 0 && cancelled === 0;

  const parts = [`${counts.ok} ok`];
  if (counts.warn) parts.push(`${counts.warn} warn`);
  if (counts.err) parts.push(`${counts.err} err`);
  if (counts.skip) {
    // Split skip into "skip" and "cancelled" so the line shows both.
    const organicSkip = counts.skip - cancelled;
    if (organicSkip > 0) parts.push(`${organicSkip} skip`);
    if (cancelled > 0) parts.push(`${cancelled} cancelled`);
  }
  if (counts.already) parts.push(`${counts.already} already`);
  const hasProblems = counts.err > 0 || counts.warn > 0;
  const tail = hasProblems ? " — see WSETUP.DEBUG" : "";
  const verb = fullyCancelled ? "cancelled" : cascadeSkipped ? "cascade-skipped" : "done";
  // Omit "in ?" for cascade-skips — the placeholder makes the line look like
  // we lost timing data when in fact the batch was never run.
  const durSuffix = cascadeSkipped ? "" : ` in ${durStr}`;
  const msg = withTail(
    `Batch ${batchNum}/${totalBatches} ${verb}${durSuffix}: ${modDisplay} (${modTp2}) — ${parts.join(", ")}${tail}`,
    { session: id, comp: `${completedComponents}/${totalComponents}` }
  );
  // Severity: real errors/warnings → WARN. Fully-cancelled is just the user
  // aborting — INFO is appropriate (the abort itself logged a WARN earlier).
  const level: LogLevel = counts.err > 0 ? "WARN"
    : (counts.warn > 0 && !fullyCancelled) ? "WARN"
    : "INFO";
  if (level === "WARN") guiLog.warn("INSTALL", msg);
  else guiLog.info("INSTALL", msg);
}

/** Log a batch_error (whole-batch failure, distinct from per-component errors). */
export function logBatchError(batchIdx: number, modName: string, error: string) {
  if (!currentSession) {
    guiLog.error("INSTALL", `Batch error: ${modName} — ${error}`);
    return;
  }
  if (batchIdx > currentSession.lastBatchIdx) currentSession.lastBatchIdx = batchIdx;
  guiLog.error("INSTALL", withTail(
    `Batch ${batchIdx + 1}/${currentSession.totalBatches} failed: ${modName} — ${error}`,
    { session: currentSession.id }
  ));
}

/** Log a pause event. */
export function logInstallPause(message: string) {
  guiLog.info("INSTALL", withTail(
    `Paused: ${message || "pause point reached"}`,
    { session: currentSession?.id }
  ));
}

/** Record that an essential mod failed, which will force an auto-abort.
 * Stored on the session so the final "Aborted" summary can name the cause.
 * `reason` is a short machine-readable tag (e.g. "essential_mod_failed"). */
export function logInstallFatal(modName: string, reason: string) {
  if (!currentSession) return;
  // Stash on the session for the complete handler to consume.
  currentSession.abortCause = { modName, reason };
  const sess = currentSession.id;
  guiLog.error("INSTALL", withTail(
    `FATAL: essential mod '${modName}' failed — install will auto-abort (reason=${reason})`,
    { session: sess }
  ));
}

/** Log install completion. Chooses Completed vs Aborted based on summary state. */
export function logInstallComplete(summary: {
  total_components: number;
  success: number;
  warnings: number;
  errors: number;
  skipped: number;
  /** Subset of `skipped` attributable to cascade (earlier batch of same mod
   * hard-failed, orchestrator pre-skipped downstream batches). Present on
   * builds with the cascade accounting change; older builds omit it.
   * Used to annotate the tally so `218 skip` can read as `218 skip (170 cascade)`. */
  skipped_cascade?: number;
  already_installed?: number;  // backend includes this; older builds may not
  elapsed_ms: number;
  aborted: boolean;
}) {
  if (!currentSession) {
    // Defensive — shouldn't happen, but still emit something
    guiLog.info("INSTALL", `Install finished (no session): ${summary.success}/${summary.total_components}`);
    return;
  }
  const { id } = currentSession;
  const durStr = formatDuration(summary.elapsed_ms || (Date.now() - currentSession.startedAt));
  const already = summary.already_installed ?? 0;
  // Arithmetic invariant: ok + err + warn + skip + already + pending == total.
  const accounted = summary.success + summary.errors + summary.warnings + summary.skipped + already;
  const pending = Math.max(0, summary.total_components - accounted);

  // Split the skip count so a reader can see how much of `N skip` is cascade
  // (downstream damage from a primary failure) vs primary (WeiDU actually
  // tried and gave up, or WeiDU silently skipped). A cascade-heavy tally
  // signals "one root-cause mod failed, N-cascade dependents died with it" —
  // different triage than M independent primary failures.
  const cascade = summary.skipped_cascade ?? 0;
  const primarySkip = Math.max(0, summary.skipped - cascade);
  const skipStr = cascade > 0
    ? `${summary.skipped} skip (${primarySkip} primary, ${cascade} cascade)`
    : `${summary.skipped} skip`;

  const tallyParts = [
    `${summary.success} ok`,
    `${summary.errors} err`,
    `${summary.warnings} warn`,
    skipStr,
  ];
  if (already > 0) tallyParts.push(`${already} already`);
  if (pending > 0) tallyParts.push(`${pending} pending`);
  const tally = tallyParts.join(", ");

  if (summary.aborted) {
    // "Aborted (cause) at batch N/M after T: <tally>"
    // Use the highest batch_idx we've seen — NOT batchStartTimes.size, which
    // undercounts when auto-skip-after-retry cascades skip batches without
    // ever firing batch_start (e.g. stratagems fails on batch 433, orchestrator
    // skips 434-448, resumes at 449 — size=0 delta but lastBatchIdx advances).
    const lastBatch = currentSession.lastBatchIdx >= 0
      ? Math.min(currentSession.totalBatches, currentSession.lastBatchIdx + 1)
      : 0;
    // If a fatal-essential-mod failure was recorded for this session, name it
    // explicitly so audits don't misread the auto-abort as user intent.
    const cause = currentSession.abortCause;
    const causeLabel = cause
      ? ` (essential mod '${cause.modName}' failed)`
      : "";
    guiLog.info("INSTALL", withTail(
      `Aborted${causeLabel} at batch ${lastBatch}/${currentSession.totalBatches} after ${durStr}: ${tally}`,
      { session: id, cause: cause?.reason }
    ));
  } else {
    guiLog.info("INSTALL", withTail(
      `Completed in ${durStr}: ${tally}`,
      { session: id }
    ));
  }
  currentSession = null;
}

/** Currently active install session, if any. */
export function getInstallSession(): InstallSession | null {
  return currentSession;
}

// ─────────────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms >= 3600000) return `${(ms / 3600000).toFixed(1)}h`;
  if (ms >= 60000) return `${Math.round(ms / 60000)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

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

/**
 * Rotate gui.log on startup. Called once before any other logging.
 * Returns `{ rotated, reason, prev_file, health_warnings }`. `health_warnings`
 * carries observations from the pre-rotation state — most importantly, signs
 * that the previous session crashed before completing its own rotation.
 */
export async function rotateGuiLog(currentVersion: string): Promise<{
  rotated: boolean;
  reason: string;
  prev_file?: string;
  health_warnings: string[];
}> {
  return invoke("rotate_gui_log", { currentVersion });
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

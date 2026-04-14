import { useState, useRef, useEffect, useCallback, useMemo } from "react";
// import { invoke } from "@tauri-apps/api/core"; // No longer needed — using typed wrappers
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { DEFAULT_FORGE_URL } from "../App";
import type { AppConfig, ParsedLog, InstallStatusMap } from "../App";
import { guiLog } from "../lib/gui-logger";
import {
  readFileContents,
  startNativeInstall,
  startDryRun,
  installDecision,
  installPause,
  installResume,
  installSendInput,
  abortNativeInstall,
  writeTempLog,
  saveInstallReport,
  type NativeInstallArgs,
  type ErrorLogEntry,
} from "../lib/tauri-bridge";
import { buildReport, type InstallReport } from "../lib/install-report";
import { fetchModIndex } from "../lib/forge-data";
import { shareReportOnGitHub } from "../lib/telemetry";
import { filterLogText } from "../lib/log-parser";
import { useI18n } from "../lib/i18n";

interface Props {
  config: AppConfig;
  parsedLog: ParsedLog | null;
  running: boolean;
  onRunningChange: (running: boolean) => void;
  onSaveConfig: (config: AppConfig) => void;
  weiduVersion?: string | null;
  excludedComponents?: Set<string>;
  pausePoints?: { afterModIndex: number; message: string; phase: string }[];
  backupExists?: boolean;
  onInstallStatus?: (status: InstallStatusMap) => void;
}

interface LogLine {
  text: string;
  type: "stdout" | "stderr" | "system";
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatTimestamp(iso: string, startTime: number): string {
  try {
    const t = new Date(iso).getTime();
    const elapsed = t - startTime;
    if (elapsed < 0) return iso.split("T")[1]?.split(".")[0] || "";
    return formatElapsed(elapsed);
  } catch {
    return "";
  }
}

// ─── Error categorization helpers ───

type ErrorCategory = "crash" | "failure" | "unknown";

function categorizeExitCode(message: string): ErrorCategory {
  if (message.includes("0xc0000005")) return "crash";
  if (message.includes("exit code: 2")) return "failure";
  return "unknown";
}

function exitCodeLabel(cat: ErrorCategory): string {
  switch (cat) {
    case "crash": return "WeiDU Crash";
    case "failure": return "Install Failed";
    case "unknown": return "Unknown Error";
  }
}

function exitCodeColor(cat: ErrorCategory): string {
  switch (cat) {
    case "crash": return "var(--pur)";
    case "failure": return "var(--red)";
    case "unknown": return "var(--org)";
  }
}

type SkipReason = "batch-retry" | "missing-from-log" | "other";

function categorizeSkip(message: string): SkipReason {
  if (message.includes("already in weidu.log after batch failure")) return "batch-retry";
  if (message.includes("reported success but not in weidu.log")) return "missing-from-log";
  return "other";
}

interface GroupedIssue {
  mod_name: string;
  level: string;
  entries: ErrorLogEntry[];
  // For errors: breakdown by exit code type
  crashCount: number;
  failureCount: number;
  unknownCount: number;
  // For skips: breakdown by reason
  batchRetryCount: number;
  missingFromLogCount: number;
  // First/last timestamp
  firstTime: string;
  lastTime: string;
}

function groupErrorEntries(entries: ErrorLogEntry[]): GroupedIssue[] {
  const map = new Map<string, GroupedIssue>();

  for (const entry of entries) {
    // Group key: mod_name + level (so errors and warns for same mod stay separate)
    const modKey = entry.mod_name || "(unknown)";
    const key = `${entry.level}:${modKey}`;

    if (!map.has(key)) {
      map.set(key, {
        mod_name: modKey,
        level: entry.level,
        entries: [],
        crashCount: 0,
        failureCount: 0,
        unknownCount: 0,
        batchRetryCount: 0,
        missingFromLogCount: 0,
        firstTime: entry.timestamp,
        lastTime: entry.timestamp,
      });
    }

    const group = map.get(key)!;
    group.entries.push(entry);
    group.lastTime = entry.timestamp;

    if (entry.level === "ERROR") {
      const cat = categorizeExitCode(entry.message);
      if (cat === "crash") group.crashCount++;
      else if (cat === "failure") group.failureCount++;
      else group.unknownCount++;
    }

    if (entry.level === "SKIP") {
      const reason = categorizeSkip(entry.message);
      if (reason === "batch-retry") group.batchRetryCount++;
      else if (reason === "missing-from-log") group.missingFromLogCount++;
    }
  }

  // Sort: RETRY first, then ERROR, then WARN, then SKIP
  const levelOrder: Record<string, number> = { RETRY: 0, ERROR: 1, WARN: 2, SKIP: 3, INFO: 4 };
  return [...map.values()].sort((a, b) => {
    const la = levelOrder[a.level] ?? 5;
    const lb = levelOrder[b.level] ?? 5;
    if (la !== lb) return la - lb;
    return a.firstTime.localeCompare(b.firstTime);
  });
}

function ToggleOption({ checked, onChange, label, hint }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string;
}) {
  return (
    <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, color: "var(--tx)", cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 2 }} />
      <div>
        {label}
        {hint && <div style={{ fontSize: 10, color: "var(--txd)", marginTop: 1 }}>{hint}</div>}
      </div>
    </label>
  );
}

function NumericOption({ value, onChange, label, suffix }: {
  value: number; onChange: (v: number) => void; label: string; suffix?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--tx)" }}>
      <span style={{ minWidth: 70 }}>{label}:</span>
      <input type="text" value={value} onChange={(e) => onChange(parseInt(e.target.value) || 0)}
        style={{ width: 70, background: "var(--bg2)", border: "1px solid var(--brd)", color: "var(--tx)", padding: "4px 8px", borderRadius: 4, fontSize: 13, textAlign: "center" }} />
      {suffix && <span style={{ color: "var(--txd)", fontSize: 11 }}>{suffix}</span>}
    </div>
  );
}

export default function InstallRunner({
  config,
  parsedLog,
  running,
  onRunningChange,
  onSaveConfig,
  weiduVersion,
  excludedComponents,
  pausePoints: pausePointsProp,
  backupExists,
  onInstallStatus,
}: Props) {
  const { t } = useI18n();
  const [showBackupWarning, setShowBackupWarning] = useState(false);
  const updateOption = (key: string, value: boolean | number) => {
    onSaveConfig({ ...config, [key]: value });
  };
  // Stdout/stderr log — ring buffer in ref, periodic flush to state for rendering
  const LOG_BUFFER_SIZE = 500;
  const logBuffer = useRef<LogLine[]>([]);   // Circular buffer of last N lines
  const logTotalCount = useRef(0);           // Total lines received (never shrinks)
  const pendingLines = useRef<LogLine[]>([]); // Lines waiting to be flushed
  const [displayLines, setDisplayLines] = useState<LogLine[]>([]);
  const [totalLineCount, setTotalLineCount] = useState(0);
  const [logExpanded, setLogExpanded] = useState(false);
  const logExpandedRef = useRef(false);
  logExpandedRef.current = logExpanded;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mod display name lookup (tp2 name → Forge display name)
  const modDisplayNames = useRef<Map<string, string>>(new Map());

  // Live install status per component — key is "mod_name:component"
  const installStatusRef = useRef<InstallStatusMap>(new Map());

  // Fetch mod index for display names on mount
  useEffect(() => {
    const baseUrl = config.forge_data_url || DEFAULT_FORGE_URL;
    fetchModIndex(baseUrl).then(index => {
      const arr = Array.isArray(index) ? index : Object.values(index);
      const map = new Map<string, string>();
      for (const entry of arr) {
        const tp2 = ((entry.t || "") as string).toLowerCase();
        const name = (entry.n || "") as string;
        if (tp2 && name) map.set(tp2, name);
        // Also map coWF aliases
        const coWF = ((entry as Record<string, unknown>).coWF || []) as (string | null)[];
        for (const wf of coWF) {
          if (wf && !map.has(wf.toLowerCase())) map.set(wf.toLowerCase(), name);
        }
      }
      modDisplayNames.current = map;
    }).catch(() => {}); // Non-critical
  }, [config.forge_data_url]);

  // Event-based progress (native installer — no file polling)
  const [currentMod, setCurrentMod] = useState<string>(""); // Display name (or tp2 fallback)
  const [currentModTp2, setCurrentModTp2] = useState<string>(""); // Always the tp2 name
  const [currentComponent, setCurrentComponent] = useState<string>("");
  const [progressCurrent, setProgressCurrent] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [_successCount, setSuccessCount] = useState(0); // Used by progress events
  const [warnCount, setWarnCount] = useState(0);
  const [errCount, setErrCount] = useState(0);
  const [skipCount, setSkipCount] = useState(0);
  const [currentPhase, setCurrentPhase] = useState<"bgee" | "eet" | "starting" | "done">("starting");

  // Error recovery dialog (Retry/Skip/Stop)
  const [batchError, setBatchError] = useState<{ modName: string; error: string; canRetry: boolean } | null>(null);

  const [errorEntries, setErrorEntries] = useState<ErrorLogEntry[]>([]);
  const errorEntriesRef = useRef<ErrorLogEntry[]>([]);

  // Process state
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [wasAborted, setWasAborted] = useState(false);
  const [inputNeeded, setInputNeeded] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [startError, setStartError] = useState<string | null>(null);
  const [pauseRequested, setPauseRequested] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const unlistenRefs = useRef<UnlistenFn[]>([]);

  // Install report
  const [reportState, setReportState] = useState<"idle" | "generating" | "done" | "error">("idle");
  const [lastReport, setLastReport] = useState<InstallReport | null>(null);

  // Timing + ETA
  const [startTime, setStartTime] = useState<number>(0);
  const [elapsed, setElapsed] = useState<number>(0);
  // Rolling window of (timestamp_ms, componentCount) samples for throughput calculation
  const throughputSamples = useRef<{ t: number; n: number }[]>([]);
  const [eta, setEta] = useState<string | null>(null);

  const logEndRef = useRef<HTMLDivElement>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const errorTimelineRef = useRef<HTMLDivElement>(null);
  const [logStickToBottom, setLogStickToBottom] = useState(true);
  const [logSearch, setLogSearch] = useState("");

  // Sync display when log is expanded (show current buffer contents immediately)
  useEffect(() => {
    if (logExpanded) {
      setDisplayLines([...logBuffer.current]);
    }
  }, [logExpanded]);

  // Auto-scroll log to bottom only if user hasn't scrolled up
  useEffect(() => {
    if (logExpanded && logStickToBottom && logEndRef.current) {
      logEndRef.current.scrollIntoView({ block: "end", behavior: "auto" });
    }
  }, [displayLines, logExpanded, logStickToBottom]);

  // Detect if user scrolled away from bottom
  const handleLogScroll = useCallback(() => {
    const el = logContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setLogStickToBottom(atBottom);
  }, []);

  // Auto-scroll error timeline
  useEffect(() => {
    if (errorTimelineRef.current) {
      errorTimelineRef.current.scrollTop = errorTimelineRef.current.scrollHeight;
    }
  }, [errorEntries]);

  // Old ETA effect removed — new one uses progressCurrent (see above)

  // Elapsed time counter
  useEffect(() => {
    if (!running || !startTime) return;
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTime);
    }, 1000);
    return () => clearInterval(interval);
  }, [running, startTime]);

  // Poll install_status.json and install_errors.log from BOTH game dirs
  // (BGEE phase writes to bg1 dir, EET phase writes to bg2 dir)
  const errorFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Batch error entry updates — accumulate in ref, flush to state periodically
  // Error entry batching removed — native installer emits errors via events

  // No polling needed — native installer emits events directly.
  // ETA is calculated from install:progress events.

  // ETA calculation driven by progressCurrent changes
  useEffect(() => {
    if (!running || progressTotal === 0) return;
    const now = Date.now();
    throughputSamples.current.push({ t: now, n: progressCurrent });
    const WINDOW_MS = 5 * 60 * 1000;
    throughputSamples.current = throughputSamples.current.filter((s) => now - s.t < WINDOW_MS);
    if (throughputSamples.current.length >= 2) {
      const oldest = throughputSamples.current[0];
      const elapsedSec = (now - oldest.t) / 1000;
      const done = progressCurrent - oldest.n;
      if (elapsedSec >= 30 && done > 0) {
        const rate = done / elapsedSec;
        const remaining = progressTotal - progressCurrent;
        const etaSec = remaining / rate;
        if (etaSec > 0 && etaSec < 86400) setEta(formatElapsed(etaSec * 1000));
        else setEta(null);
      }
    }
  }, [progressCurrent, progressTotal, running]);

  // No polling — native installer uses direct Tauri events

  const addLine = useCallback(
    (text: string, type: LogLine["type"] = "stdout") => {
      const line = { text, type };
      logTotalCount.current++;
      pendingLines.current.push(line);

      // Throttle state updates — flush every 250ms
      if (!flushTimer.current) {
        flushTimer.current = setTimeout(() => {
          flushTimer.current = null;
          // Move pending lines into the ring buffer
          const pending = pendingLines.current;
          pendingLines.current = [];

          if (pending.length >= LOG_BUFFER_SIZE) {
            // If we got more than the buffer size in one batch, just keep the tail
            logBuffer.current = pending.slice(-LOG_BUFFER_SIZE);
          } else {
            // Append and trim
            logBuffer.current.push(...pending);
            if (logBuffer.current.length > LOG_BUFFER_SIZE) {
              logBuffer.current = logBuffer.current.slice(-LOG_BUFFER_SIZE);
            }
          }

          // Always update the count (cheap)
          setTotalLineCount(logTotalCount.current);

          // Only update display state if the log panel is visible
          // This avoids re-rendering 500 div elements when the user can't see them
          if (logExpandedRef.current) {
            setDisplayLines([...logBuffer.current]);
          }
        }, 250);
      }
    },
    [],
  );

  // Cleanup event listeners and timers on unmount
  useEffect(() => {
    return () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
      if (errorFlushTimer.current) clearTimeout(errorFlushTimer.current);
      unlistenRefs.current.forEach((fn) => fn());
      unlistenRefs.current.length = 0;
    };
  }, []);

  const startInstall = useCallback(async () => {
    if (running) return;
    setStartError(null);
    setPauseRequested(false);
    setIsPaused(false);
    if (!config.weidu_path) {
      addLine("[ERROR] WeiDU path not configured — set it in Setup tab", "system");
      setLogExpanded(true);
      return;
    }
    if (!parsedLog) {
      addLine("[ERROR] No WeiDU.log imported — import logs first", "system");
      setLogExpanded(true);
      return;
    }

    // Reset state
    logBuffer.current = [];
    logTotalCount.current = 0;
    pendingLines.current = [];
    setDisplayLines([]);
    setTotalLineCount(0);
    setExitCode(null);
    setProgressCurrent(0);
    setProgressTotal(parsedLog.componentCount);
    setSuccessCount(0);
    setWarnCount(0);
    setErrCount(0);
    setSkipCount(0);
    setCurrentMod("");
    setCurrentModTp2("");
    setCurrentComponent("");
    setCurrentPhase("starting");
    installStatusRef.current = new Map();
    if (onInstallStatus) onInstallStatus(new Map());
    setBatchError(null);
    setErrorEntries([]);
    errorEntriesRef.current = [];
    setAbortPending(false);
    setWasAborted(false);
    if (errorFlushTimer.current) { clearTimeout(errorFlushTimer.current); errorFlushTimer.current = null; }
    setLogExpanded(false);
    setLogStickToBottom(true);
    throughputSamples.current = [];
    setEta(null);
    setStartTime(Date.now());
    setElapsed(0);
    onRunningChange(true);

    addLine("[EET Mod Runner] Starting native install (direct WeiDU)...", "system");
    guiLog.info("INSTALL", `Starting native install (${parsedLog?.componentCount || "?"} components, WeiDU: ${weiduVersion || "?"})`);

    // Build log paths (filter if components excluded)
    let eetLogFile = parsedLog.eetLogPath || null;
    let bgeeLogFile = parsedLog.bgeeLogPath || null;
    if (excludedComponents && excludedComponents.size > 0) {
      try {
        if (parsedLog.raw) {
          const filtered = filterLogText(parsedLog.raw, excludedComponents);
          eetLogFile = await writeTempLog(filtered, "WeiDU-filtered.log");
          addLine(`[EET Mod Runner] Filtered EET log (${excludedComponents.size} components excluded)`, "system");
        }
        if (parsedLog.bgeeRaw) {
          const filtered = filterLogText(parsedLog.bgeeRaw, excludedComponents);
          bgeeLogFile = await writeTempLog(filtered, "WeiDU-BGEE-filtered.log");
        }
      } catch (e) {
        addLine(`[EET Mod Runner] Filter failed: ${e}. Using original logs.`, "system");
      }
    }

    if (!eetLogFile) {
      addLine("[ERROR] No EET log path available", "system");
      onRunningChange(false);
      return;
    }

    try {
      // Set up event listeners for native install events
      const unlistenStdout = await listen<string>("install:stdout", (event) => {
        addLine(event.payload, "stdout");
      });
      const unlistenStderr = await listen<string>("install:stderr", (event) => {
        addLine(event.payload, "stderr");
      });
      const unlistenProgress = await listen<{
        current: number; total: number; success: number;
        warnings: number; errors: number; skipped: number; elapsed_ms: number;
      }>("install:progress", (event) => {
        const p = event.payload;
        setProgressCurrent(p.current);
        setProgressTotal(p.total);
        setSuccessCount(p.success);
        setWarnCount(p.warnings);
        setErrCount(p.errors);
        setSkipCount(p.skipped);
      });
      const unlistenBatchStart = await listen<{
        batch_idx: number; total_batches: number; mod_name: string; components: string[];
      }>("install:batch_start", (event) => {
        const tp2Name = event.payload.mod_name;
        const displayName = modDisplayNames.current.get(tp2Name.toLowerCase()) || tp2Name;
        setCurrentMod(displayName);
        setCurrentModTp2(tp2Name);
        const batchNum = event.payload.batch_idx + 1;
        const totalBatches = event.payload.total_batches;
        setCurrentComponent(`Batch ${batchNum}/${totalBatches}`);
        if (batchNum === 1 || batchNum % 25 === 0) {
          guiLog.info("INSTALL", `Batch ${batchNum}/${totalBatches}: ${displayName} (${tp2Name})`);
        }
      });
      const unlistenBatchError = await listen<{
        batch_idx: number; mod_name: string; error: string; can_retry: boolean;
      }>("install:batch_error", (event) => {
        guiLog.error("INSTALL", `Batch error: ${event.payload.mod_name} — ${event.payload.error}`);
        setBatchError({
          modName: event.payload.mod_name,
          error: event.payload.error,
          canRetry: event.payload.can_retry,
        });
      });
      const unlistenBatchDone = await listen<{
        batch_idx: number;
        results: { mod_name: string; component: number; status: string; message?: string }[];
      }>("install:batch_done", (event) => {
        for (const r of event.payload.results) {
          const key = `${r.mod_name}:${r.component}`;
          const status = r.status === "Success" ? "success"
            : r.status === "Warning" ? "warning"
            : r.status === "Error" ? "error"
            : r.status === "Skipped" ? "skipped"
            : r.status === "AlreadyInstalled" ? "success"
            : "success";
          installStatusRef.current.set(key, status);
        }
        // Push updated map to parent
        if (onInstallStatus) {
          onInstallStatus(new Map(installStatusRef.current));
        }
      });
      const unlistenPause = await listen<{ message: string }>("install:pause", (event) => {
        setIsPaused(true);
        addLine(`[EET Mod Runner] PAUSE: ${event.payload.message || "Pause point reached"}`, "system");
      });
      const unlistenPhase = await listen<string>("install:phase", (event) => {
        setCurrentPhase(event.payload as "bgee" | "eet");
        addLine(`[EET Mod Runner] Phase: ${event.payload}`, "system");
      });
      const unlistenInputNeeded = await listen<{ prompt: string }>("install:input_needed", (event) => {
        setInputNeeded(event.payload.prompt);
      });
      const unlistenError = await listen<string>("install:error", (event) => {
        addLine(`[EET Mod Runner] ERROR: ${event.payload}`, "system");
        guiLog.error("INSTALL", event.payload);
      });
      const unlistenComplete = await listen<{
        total_components: number; success: number; warnings: number;
        errors: number; skipped: number; elapsed_ms: number; aborted: boolean;
      }>("install:complete", (event) => {
        const s = event.payload;
        setExitCode(s.aborted ? 1 : s.errors > 0 ? 1 : 0);
        setWasAborted(s.aborted);
        setCurrentPhase("done");
        setBatchError(null);     // Clear any lingering error dialog
        setAbortPending(false);  // Clear abort banner
        setInputNeeded(null);    // Clear any input prompt
        onRunningChange(false);
        addLine(`[EET Mod Runner] Install complete: ${s.success} success, ${s.warnings} warnings, ${s.errors} errors, ${s.skipped} skipped`, "system");
        const durMs = s.elapsed_ms || (Date.now() - (startTime || Date.now()));
        const durStr = durMs > 3600000 ? `${(durMs/3600000).toFixed(1)}h` : durMs > 60000 ? `${Math.round(durMs/60000)}m` : `${Math.round(durMs/1000)}s`;
        guiLog.info("INSTALL", `Complete in ${durStr}: ${s.success} ok, ${s.errors} err, ${s.warnings} warn, ${s.skipped} skip${s.aborted ? " (ABORTED)" : ""} — ${s.success}/${s.total_components} total`);
        // OS notification
        try {
          if (Notification.permission === "granted") {
            new Notification("EET Mod Runner — Install Complete", {
              body: s.aborted
                ? "Installation was aborted."
                : `${s.success} success, ${s.errors} errors, ${s.warnings} warnings`,
            });
          } else if (Notification.permission !== "denied") {
            Notification.requestPermission().then((perm) => {
              if (perm === "granted") {
                new Notification("EET Mod Runner — Install Complete", {
                  body: `${s.success} success, ${s.errors} errors`,
                });
              }
            });
          }
        } catch { /* Notification API not available */ }
        // Cleanup all listeners
        unlistenStdout(); unlistenStderr(); unlistenProgress();
        unlistenBatchStart(); unlistenBatchError(); unlistenBatchDone(); unlistenPause();
        unlistenPhase(); unlistenInputNeeded(); unlistenError(); unlistenComplete();
      });

      unlistenRefs.current = [
        unlistenStdout, unlistenStderr, unlistenProgress,
        unlistenBatchStart, unlistenBatchError, unlistenBatchDone, unlistenPause,
        unlistenPhase, unlistenInputNeeded, unlistenError, unlistenComplete,
      ];

      // Launch native install
      const installArgs: NativeInstallArgs = {
        weiduPath: config.weidu_path!,
        bg2GameDir: config.bg2_game_dir!,
        bg1GameDir: config.bg1_game_dir || null,
        modDirectory: config.mod_directory!,
        eetLogPath: eetLogFile,
        bgeeLogPath: bgeeLogFile,
        language: config.language || "en_US",
        languageIndex: 0,
        skipInstalled: config.skip_installed,
        timeout: config.timeout,
        neverAbort: config.never_abort,
        abortOnWarnings: config.abort_on_warnings,
        weiduLogMode: config.weidu_log_mode || "autolog,logapp,log-extern",
        maxBatchSize: 25,
        pausePoints: pausePointsProp || [],
        bcsScanner: config.bcs_scanner,
        autoSkipAfterRetry: config.auto_skip_after_retry,
        suppressReadmes: config.suppress_readmes,
        dataDirectory: config.data_directory,
      };

      await startNativeInstall(installArgs);
    } catch (e) {
      const errMsg = String(e);
      addLine(`[EET Mod Runner] Failed to start: ${errMsg}`, "system");
      guiLog.error("INSTALL", `Failed to start: ${errMsg}`);
      setStartError(errMsg);
      setLogExpanded(true);
      onRunningChange(false);
      unlistenRefs.current.forEach((fn) => fn());
      unlistenRefs.current.length = 0;
    }
  }, [config, parsedLog, running, onRunningChange, addLine, excludedComponents]);

  const runDryRun = useCallback(async () => {
    if (running) return;
    setLogExpanded(true);
    addLine("[EET Mod Runner] Starting dry run...", "system");
    try {
      const eetLogFile = config.eet_log_path;
      const bgeeLogFile = config.bgee_log_path || null;
      if (!eetLogFile || !config.weidu_path) return;

      // Set up listeners for dry run output (same stdout stream as real install)
      const unlistenStdout = await listen<string>("install:stdout", (event) => {
        addLine(event.payload, "stdout");
      });
      const unlistenDryRunComplete = await listen<unknown>("install:dry_run_complete", (_event) => {
        addLine("[EET Mod Runner] Dry run report received", "system");
        // Clean up listeners
        unlistenStdout();
        unlistenDryRunComplete();
      });

      const installArgs = {
        weiduPath: config.weidu_path,
        bg2GameDir: config.bg2_game_dir!,
        bg1GameDir: config.bg1_game_dir || null,
        modDirectory: config.mod_directory!,
        eetLogPath: eetLogFile,
        bgeeLogPath: bgeeLogFile,
        language: config.language || "en_US",
        languageIndex: 0,
        skipInstalled: config.skip_installed,
        timeout: config.timeout,
        neverAbort: true,
        abortOnWarnings: false,
        weiduLogMode: config.weidu_log_mode || "autolog,logapp,log-extern",
        maxBatchSize: 25,
        pausePoints: [] as { afterModIndex: number; message: string; phase: string }[],
        bcsScanner: false,
        autoSkipAfterRetry: false,
      };
      await startDryRun(installArgs);
    } catch (e) {
      addLine(`[EET Mod Runner] Dry run failed: ${String(e)}`, "system");
    }
  }, [config, running, addLine]);

  // Input detection and stdout issue tracking now handled by native installer engine

  async function sendInput() {
    if (inputValue) {
      try {
        await installSendInput(inputValue);
        addLine(`[User Input] ${inputValue}`, "system");
        setInputValue("");
        setInputNeeded(null);
      } catch (e) {
        addLine(`[EET Mod Runner] Failed to send input: ${e}`, "system");
      }
    }
  }

  const [abortPending, setAbortPending] = useState(false);

  async function abortInstall() {
    if (abortPending) return;
    setAbortPending(true);
    try {
      await abortNativeInstall();
      addLine("[EET Mod Runner] Abort signal sent — WeiDU will be stopped after current operation...", "system");
      guiLog.warn("INSTALL", "Installation aborted by user");
    } catch (e) {
      addLine(`[EET Mod Runner] Failed to abort: ${e}`, "system");
      setAbortPending(false);
    }
  }

  async function togglePause() {
    if (isPaused || pauseRequested) {
      // Resume
      try {
        await installResume();
        setIsPaused(false);
        setPauseRequested(false);
        addLine("[EET Mod Runner] Resumed.", "system");
      } catch (e) {
        addLine(`[EET Mod Runner] Failed to resume: ${e}`, "system");
      }
    } else {
      // Pause at next batch boundary
      try {
        await installPause();
        setPauseRequested(true);
        addLine("[EET Mod Runner] Pause requested — will pause after current mod finishes.", "system");
      } catch (e) {
        addLine(`[EET Mod Runner] Failed to pause: ${e}`, "system");
      }
    }
  }

  const copyErrorReport = useCallback(async () => {
    if (!config.bg2_game_dir) return;
    try {
      const content = await readFileContents(
        config.bg2_game_dir.replace(/\\/g, "/") + "/install_errors.log",
      );
      await navigator.clipboard.writeText(content);
    } catch {
      // Fallback: copy from state
      const text = errorEntries
        .map((e) => `${e.timestamp} ${e.level} ${e.mod_name} ${e.message}`)
        .join("\n");
      await navigator.clipboard.writeText(text);
    }
  }, [config.bg2_game_dir, errorEntries]);

  const generateAndSaveReport = useCallback(async () => {
    if (!parsedLog || exitCode === null) return;
    setReportState("generating");
    try {
      const forgeBaseUrl = config.forge_data_url || DEFAULT_FORGE_URL;
      const report = await buildReport({
        parsedLog,
        errorEntries,
        bg1Status: null,
        bg2Status: null,
        exitCode,
        elapsedMs: elapsed,
        weiduVersion: weiduVersion || "unknown",
        forgeBaseUrl,
      });
      setLastReport(report);

      // Save to game dir
      const json = JSON.stringify(report, null, 2);
      const filename = `install-report-${report.timestamp.substring(0, 10)}-${report.id.substring(0, 8)}.json`;
      const dir = config.bg2_game_dir?.replace(/\\/g, "/");
      if (!dir) throw new Error("BG2 game directory not configured");
      await saveInstallReport(json, `${dir}/${filename}`);

      guiLog.info("INSTALL", `Install report saved: ${filename} (${report.components.length} components)`);
      setReportState("done");
    } catch (e) {
      guiLog.error("INSTALL", `Failed to generate report: ${e}`);
      setReportState("error");
    }
  }, [parsedLog, exitCode, errorEntries, elapsed, weiduVersion, config]);

  // Progress from native install events — simple, no polling needed
  const combinedCurrent = progressCurrent;
  const effectiveTotal = progressTotal > 0 ? progressTotal : (parsedLog?.componentCount ?? 0);
  const pct = effectiveTotal > 0
    ? Math.min(99, Math.round((combinedCurrent / effectiveTotal) * 100))
    : 0;

  const errorCount = errCount;
  const isComplete = exitCode !== null && !running;

  const activePhase: "bg1" | "eet" | "done" | "starting" = (() => {
    if (isComplete) return "done";
    if (currentPhase === "bgee") return "bg1";
    if (currentPhase === "eet") return "eet";
    return "starting";
  })();

  // Memoize expensive computations — only recalculate when errorEntries changes
  const groupedIssues = useMemo(() => groupErrorEntries(errorEntries), [errorEntries]);

  const errorBreakdown = useMemo(() => {
    let crashes = 0, failures = 0, unknown = 0, suspicious = 0;
    const errorMods = new Set<string>();
    for (const e of errorEntries) {
      if (e.level === "ERROR") {
        const cat = categorizeExitCode(e.message);
        if (cat === "crash") crashes++;
        else if (cat === "failure") failures++;
        else unknown++;
        errorMods.add(e.mod_name);
      }
      if (e.level === "SKIP" && categorizeSkip(e.message) === "missing-from-log") {
        suspicious++;
      }
    }
    return { crashes, failures, unknown, suspicious, uniqueMods: errorMods.size };
  }, [errorEntries]);

  const { crashes: totalCrashes, failures: totalFailures, unknown: totalUnknownErrors, suspicious: suspiciousSkips, uniqueMods: uniqueErrorMods } = errorBreakdown;

  // ─── Pre-install view ───
  if (!running && !isComplete) {
    return (
      <div>
        <h2>{t("install.heading", "Install Runner")}</h2>
        <p style={{ color: "var(--txd)", marginBottom: 20, fontSize: 13 }}>
          {t("install.desc", "Execute your mod installation directly via WeiDU. Real-time progress streaming, per-batch error recovery, and pause points.")}
        </p>

        {!config.weidu_path && (
          <div className="msg err">
            {t("install.no_weidu", "WeiDU path not configured. Set it in the Setup tab.")}
          </div>
        )}
        {!parsedLog && (
          <div className="msg warn">
            {t("install.no_log", "No log imported. Import a WeiDU.log first.")}
          </div>
        )}

        <h3>{t("install.options", "Install Options")}</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
          <ToggleOption checked={config.skip_installed} onChange={(v) => updateOption("skip_installed", v)} label={t("install.skip_installed", "Skip already installed")} hint="Resume interrupted installs" />
          <ToggleOption checked={config.never_abort} onChange={(v) => updateOption("never_abort", v)} label={t("install.never_abort", "Never abort (continue past errors)")} hint="Recommended for large installs" />
          <ToggleOption checked={config.abort_on_warnings} onChange={(v) => updateOption("abort_on_warnings", v)} label={t("install.abort_warnings", "Abort on warnings")} hint="Stop if WeiDU warns" />
          <ToggleOption checked={config.bcs_scanner} onChange={(v) => updateOption("bcs_scanner", v)} label="BCS corruption scanner" hint="Detect & restore WeiDU round-trip corruption" />
          <ToggleOption checked={config.auto_skip_after_retry} onChange={(v) => updateOption("auto_skip_after_retry", v)} label="Auto-skip after retry" hint="Auto retry+skip errors (no prompts)" />
          <ToggleOption checked={config.suppress_readmes} onChange={(v) => updateOption("suppress_readmes", v)} label="Suppress readme popups" hint="Prevent mods from opening docs during install" />
          <NumericOption value={config.timeout} onChange={(v) => updateOption("timeout", v)} label="Timeout per mod" suffix={`sec (${Math.round(config.timeout / 60)}m)`} />
        </div>

        {/* Advanced options */}
        <div className="log-toggle" onClick={() => setAdvancedOpen(!advancedOpen)}
          style={{ marginBottom: advancedOpen ? 8 : 16 }}>
          <span>
            <span className="toggle-arrow">{advancedOpen ? "\u25BC" : "\u25B6"}</span>
            {" "}{t("install.advanced", "Advanced Options")}
          </span>
        </div>
        {advancedOpen && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16, padding: "0 4px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--tx)" }}>
              <span style={{ minWidth: 70 }}>{t("install.language", "Language:")}</span>
              <input type="text" value={config.language} onChange={(e) => onSaveConfig({ ...config, language: e.target.value })}
                style={{ width: 80, background: "var(--bg2)", border: "1px solid var(--brd)", color: "var(--tx)", padding: "4px 8px", borderRadius: 4, fontSize: 13 }} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--tx)" }}>
              <span style={{ minWidth: 110 }}>WeiDU log mode:</span>
              <input type="text" value={config.weidu_log_mode} onChange={(e) => onSaveConfig({ ...config, weidu_log_mode: e.target.value })}
                style={{ flex: 1, background: "var(--bg2)", border: "1px solid var(--brd)", color: "var(--tx)", padding: "4px 8px", borderRadius: 4, fontSize: 13 }} />
            </div>
          </div>
        )}

        {startError && (
          <div className="msg err" style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("install.start_error", "Failed to start installation")}</div>
            <div style={{ fontSize: 12, wordBreak: "break-all" }}>{startError}</div>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
          <button
            className="btn btn-primary"
            onClick={() => {
              if (!backupExists) { setShowBackupWarning(true); return; }
              startInstall();
            }}
            disabled={!config.weidu_path || !parsedLog}
          >
            {t("install.start", "Start Installation")}
          </button>
          <button
            className="btn"
            onClick={runDryRun}
            disabled={!config.weidu_path || !parsedLog || running}
            style={{ opacity: 0.8 }}
          >
            {t("install.dry_run", "Dry Run")}
          </button>
        </div>

        {/* Dry run output log */}
        {displayLines.length > 0 && !running && (
          <div style={{ marginBottom: 16 }}>
            <div className="log-toggle" style={{ marginBottom: logExpanded ? 8 : 0, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span onClick={() => setLogExpanded(!logExpanded)} style={{ cursor: "pointer" }}>
                <span className="toggle-arrow">{logExpanded ? "\u25BC" : "\u25B6"}</span>
                {" "}Dry Run Output ({displayLines.length} lines)
              </span>
              {logExpanded && (
                <button
                  className="btn"
                  style={{ fontSize: 11, padding: "2px 10px", opacity: 0.7 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    const text = displayLines.map(l => l.text).join("\n");
                    navigator.clipboard.writeText(text);
                  }}
                >
                  Copy
                </button>
              )}
            </div>
            {logExpanded && (
              <div style={{ background: "var(--bg1)", border: "1px solid var(--brd)", borderRadius: 6, padding: 8, maxHeight: 400, overflow: "auto", fontFamily: "monospace", fontSize: 12 }}>
                {displayLines.map((line, i) => (
                  <div key={i} style={{ color: line.type === "system" ? "var(--gold)" : line.type === "stderr" ? "#f87171" : "var(--tx)", whiteSpace: "pre-wrap", lineHeight: 1.4 }}>
                    {line.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Backup warning dialog */}
        {showBackupWarning && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
            <div style={{ background: "#1a1a2e", border: "1px solid #555", borderRadius: 8, padding: 24, maxWidth: 480, textAlign: "center" }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: "var(--gold)", marginBottom: 12 }}>{t("install.no_backup_title", "No Backup Found")}</div>
              <div style={{ fontSize: 13, color: "#ccc", marginBottom: 16, lineHeight: 1.5 }}>
                It's recommended to create a backup before a multi-hour install.
                You can create one from the Ready Check tab, or continue without one.
              </div>
              <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
                <button className="btn" onClick={() => { setShowBackupWarning(false); startInstall(); }}
                  style={{ padding: "6px 20px" }}>
                  {t("install.continue_anyway", "Continue Anyway")}
                </button>
                <button className="btn" onClick={() => setShowBackupWarning(false)}
                  style={{ padding: "6px 20px", background: "var(--bg3)" }}>
                  {t("btn.cancel", "Cancel")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── Active install / post-install view ───
  return (
    <div>
      <h2>{t("install.heading", "Install Runner")}</h2>

      {/* ── Phase Banner ── */}
      {activePhase !== "done" && activePhase !== "starting" && (
        <div style={{
          textAlign: "center", padding: "5px 0", marginBottom: 8, borderRadius: 6,
          fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase",
          background: activePhase === "bg1"
            ? "linear-gradient(90deg, transparent, rgba(0,200,255,0.12), transparent)"
            : "linear-gradient(90deg, transparent, rgba(255,180,40,0.12), transparent)",
          color: activePhase === "bg1" ? "var(--cyn)" : "var(--gold)",
          borderTop: `1px solid ${activePhase === "bg1" ? "rgba(0,200,255,0.3)" : "rgba(255,180,40,0.3)"}`,
          borderBottom: `1px solid ${activePhase === "bg1" ? "rgba(0,200,255,0.3)" : "rgba(255,180,40,0.3)"}`,
        }}>
          {activePhase === "bg1" ? "PRE-EET" : "EET"}
        </div>
      )}

      {/* ── Status Dashboard ── */}
      <div className="install-dashboard">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div>
              <div className="current-mod">
                {isPaused ? t("install.paused", "Paused")
                  : currentMod
                    ? currentMod
                    : isComplete ? t("install.complete", "Installation complete")
                      : pauseRequested ? t("install.pausing", "Pausing after current mod...")
                        : combinedCurrent > 0 ? t("install.installing", "Installing...")
                          : t("install.starting", "Starting...")}
              </div>
              <div className="current-component">
                {currentModTp2 && currentMod !== currentModTp2
                  ? `${currentModTp2} \u2014 ${currentComponent || ""}`
                  : currentComponent
                    || (combinedCurrent > 0 ? `${combinedCurrent} of ${effectiveTotal} components processed`
                      : t("install.waiting", "Waiting for first mod..."))}
              </div>
            </div>
            {/* Activity indicator */}
            {running && !isComplete && (
              <div style={{ fontSize: 11, color: "var(--txd)", marginTop: 4, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{
                  width: 6, height: 6, borderRadius: "50%", background: "var(--grn)",
                  display: "inline-block", animation: "pulse 2s ease-in-out infinite",
                }} />
                {totalLineCount > 0 && (
                  <span>{totalLineCount >= 1000 ? `${(totalLineCount / 1000).toFixed(0)}K` : totalLineCount} log lines</span>
                )}
              </div>
            )}
            {/* Batch error dialog moved below stats row */}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {running && (
              <>
                <button
                  className="btn"
                  onClick={togglePause}
                  style={{
                    borderColor: isPaused ? "var(--grn)" : pauseRequested ? "var(--org)" : "var(--brd2)",
                    color: isPaused ? "var(--grn)" : pauseRequested ? "var(--org)" : "var(--tx)",
                  }}
                >
                  {isPaused ? t("install.resume_btn", "Resume") : pauseRequested ? t("install.pausing", "Pausing...") : t("install.pause_btn", "Pause")}
                </button>
                <button className="btn btn-danger" onClick={abortInstall} disabled={abortPending}>
                  {abortPending ? t("install.aborting", "Aborting...") : t("install.abort_btn", "Abort")}
                </button>
              </>
            )}
          </div>
        </div>

        <div className="progress-bar" style={{ height: 8 }}>
          <div className="fill" style={{ width: `${pct}%` }} />
        </div>

        {/* Pause/Abort pending banners */}
        {pauseRequested && !isPaused && (
          <div className="msg warn" style={{ marginTop: 8, fontSize: 12 }}>
            ⏸ Pause requested — will pause after the current mod finishes installing. This may take several minutes for large mods.
          </div>
        )}
        {abortPending && (
          <div className="msg err" style={{ marginTop: 8, fontSize: 12 }}>
            Abort signal sent — WeiDU will be force-killed in 3s if unresponsive...
          </div>
        )}

        <div className="stats-row">
          <div className="stat">
            <span className="stat-num" style={{ color: "var(--goldb)" }}>
              {combinedCurrent}
            </span>
            <span style={{ color: "var(--txd)" }}>
              / {effectiveTotal || "?"} components
            </span>
          </div>
          <div className="stat">
            <span className="stat-num" style={{ color: errorCount > 0 ? "var(--red)" : "var(--txd)" }}>
              {errorCount}
            </span>
            <span style={{ color: "var(--txd)" }}>errors</span>
          </div>
          <div className="stat">
            <span className="stat-num" style={{ color: warnCount > 0 ? "var(--org)" : "var(--txd)" }}>
              {warnCount}
            </span>
            <span style={{ color: "var(--txd)" }}>warnings</span>
          </div>
          <div className="stat">
            <span className="stat-num" style={{ color: "var(--txd)" }}>
              {skipCount}
            </span>
            <span style={{ color: "var(--txd)" }}>skipped</span>
          </div>
          <div className="stat" style={{ marginLeft: "auto", textAlign: "right" }}>
            <span style={{ color: "var(--txd)", fontSize: 11 }}>
              {formatElapsed(elapsed)}
            </span>
            {eta && running && (
              <span style={{ color: "var(--gold)", fontSize: 11, marginLeft: 8 }}>
                ~{eta} remaining
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Batch Error Recovery ── */}
      {batchError && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 14px", marginTop: 8, borderRadius: 6,
          background: "rgba(255,50,50,0.08)", border: "1px solid rgba(255,50,50,0.3)",
        }}>
          <div style={{ fontSize: 12 }}>
            <div style={{ fontWeight: 600, color: "var(--red)" }}>
              {t("install.batch_failed", "Batch failed:")} {batchError.modName}
            </div>
            <div style={{ color: "var(--txd)", marginTop: 2 }}>{batchError.error}</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0, marginLeft: 16 }}>
            {batchError.canRetry && (
              <button className="btn" onClick={() => { guiLog.info("INSTALL", `Decision: RETRY ${batchError.modName}`); installDecision("retry"); setBatchError(null); }}>
                {t("btn.retry", "Retry")}
              </button>
            )}
            <button className="btn" onClick={() => { guiLog.info("INSTALL", `Decision: SKIP ${batchError.modName}`); installDecision("skip"); setBatchError(null); }}>
              {t("btn.skip", "Skip")}
            </button>
            <button className="btn btn-danger" onClick={() => { guiLog.info("INSTALL", `Decision: STOP at ${batchError.modName}`); installDecision("stop"); setBatchError(null); }}>
              {t("install.stop_install", "Stop Install")}
            </button>
          </div>
        </div>
      )}

      {/* ── Post-Install Summary ── */}
      {isComplete && (
        <div className={`install-summary`}>
          <div
            className="summary-title"
            style={{ color: wasAborted ? "var(--gold)" : exitCode === 0 ? "var(--grn)" : "var(--red)" }}
          >
            {wasAborted ? t("install.title_aborted", "Installation Aborted") : exitCode === 0 ? t("install.title_complete", "Installation Complete") : t("install.title_errors", "Installation Finished with Errors")}
          </div>
          <div className="summary-time">
            {t("install.total_time", "Total time:")} {formatElapsed(elapsed)}
          </div>
          <div className="summary-grid" style={{ margin: "12px 0" }}>
            <div className="summary-card">
              <div className="number" style={{ color: "var(--grn)" }}>
                {Math.max(0, combinedCurrent - errorCount - skipCount)}
              </div>
              <div className="label">{t("install.card_installed", "Installed")}</div>
              {warnCount > 0 && (
                <div style={{ fontSize: 10, color: "var(--org)", marginTop: 4 }}>
                  {warnCount} with warnings
                </div>
              )}
            </div>
            <div className="summary-card">
              <div className="number" style={{ color: errorCount > 0 ? "var(--red)" : "var(--txd)" }}>
                {errorCount}
              </div>
              <div className="label">{t("install.card_errors", "Errors")}</div>
              {errorCount > 0 && (
                <div style={{ fontSize: 10, color: "var(--txd)", marginTop: 4 }}>
                  {totalCrashes > 0 && <div><span style={{ color: "var(--pur)" }}>{totalCrashes}</span> crashes</div>}
                  {totalFailures > 0 && <div><span style={{ color: "var(--red)" }}>{totalFailures}</span> failures</div>}
                  {totalUnknownErrors > 0 && <div><span style={{ color: "var(--org)" }}>{totalUnknownErrors}</span> unknown</div>}
                  {uniqueErrorMods > 0 && <div style={{ marginTop: 2 }}>{uniqueErrorMods} mods affected</div>}
                  {wasAborted && uniqueErrorMods === 0 && <div style={{ marginTop: 2 }}>from aborted batches</div>}
                </div>
              )}
            </div>
            <div className="summary-card">
              <div className="number" style={{ color: "var(--txd)" }}>
                {skipCount}
              </div>
              <div className="label">{t("install.card_skipped", "Skipped")}</div>
              {suspiciousSkips > 0 && (
                <div style={{ fontSize: 10, color: "var(--org)", marginTop: 4 }}>
                  {suspiciousSkips} suspicious
                </div>
              )}
            </div>
            {effectiveTotal > combinedCurrent && (
              <div className="summary-card">
                <div className="number" style={{ color: "var(--txd)" }}>
                  {effectiveTotal - combinedCurrent}
                </div>
                <div className="label">{t("install.card_unattempted", "Unattempted")}</div>
                <div style={{ fontSize: 10, color: "var(--txd)", marginTop: 4 }}>
                  {wasAborted ? "install was aborted" : "mod not found or skipped entirely"}
                </div>
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            <button className="btn" onClick={copyErrorReport}>
              {t("install.copy_error", "Copy Error Report")}
            </button>
            <button
              className="btn"
              onClick={generateAndSaveReport}
              disabled={reportState === "generating"}
            >
              {reportState === "generating" ? "Generating..." :
               reportState === "done" ? t("install.report_saved", "Report Saved") :
               reportState === "error" ? t("install.report_failed", "Report Failed") :
               t("install.save_report", "Save Install Report")}
            </button>
            {lastReport && config.telemetry_opt_in === true && (
              <button
                className="btn"
                onClick={async () => {
                  const ok = await shareReportOnGitHub(lastReport);
                  if (ok) {
                    guiLog.info("INSTALL", "Telemetry report copied to clipboard and GitHub opened");
                  }
                }}
                title="Copies report to clipboard and opens GitHub — paste and submit to share"
              >
                {t("install.share_report", "Share Report")}
              </button>
            )}
            <button className="btn btn-primary" onClick={() => {
              setExitCode(null);
              setProgressCurrent(0);
              setProgressTotal(0);
              setSuccessCount(0);
              setWarnCount(0);
              setErrCount(0);
              setSkipCount(0);
              setCurrentMod("");
              setCurrentComponent("");
              setCurrentPhase("starting");
              setBatchError(null);
              setErrorEntries([]);
              errorEntriesRef.current = [];
              logBuffer.current = [];
              logTotalCount.current = 0;
              pendingLines.current = [];
              setDisplayLines([]);
              setTotalLineCount(0);
              if (errorFlushTimer.current) { clearTimeout(errorFlushTimer.current); errorFlushTimer.current = null; }
              setExpandedGroups(new Set());
              setInputNeeded(null);
              setInputValue("");
              setLogExpanded(false);
              setLogStickToBottom(true);
              throughputSamples.current = [];
              setReportState("idle");
              setLastReport(null);
              setEta(null);
            }}>
              {t("install.new_install", "New Install")}
            </button>
          </div>
          {/* Telemetry opt-in prompt — shown once after first report is generated */}
          {lastReport && config.telemetry_opt_in === null && (
            <div className="msg info" style={{ marginTop: 12, fontSize: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {t("install.telemetry_title", "Help improve mod compatibility data?")}
              </div>
              <div style={{ marginBottom: 8, color: "var(--txd)" }}>
                {t("install.telemetry_desc", "Share anonymized install outcomes (mod IDs + pass/fail \u2014 no file paths or personal info) with the EET community. Reports are submitted as GitHub Issues so you can see exactly what's shared.")}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-primary" style={{ fontSize: 11, padding: "3px 10px" }} onClick={() => {
                  onSaveConfig({ ...config, telemetry_opt_in: true });
                }}>
                  {t("install.telemetry_enable", "Enable")}
                </button>
                <button className="btn" style={{ fontSize: 11, padding: "3px 10px" }} onClick={() => {
                  onSaveConfig({ ...config, telemetry_opt_in: false });
                }}>
                  {t("install.telemetry_decline", "No thanks")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Mass timeout warning removed — native installer handles timeouts per-batch */}

      {/* ── Input Panel ── */}
      {inputNeeded && running && (
        <div
          style={{
            background: "var(--bg-warn)",
            border: "1px solid var(--org)",
            borderRadius: 4,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ color: "var(--org)", fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
            {t("install.input_required", "Input Required")}
          </div>
          <div style={{ color: "var(--tx)", fontSize: 12, marginBottom: 8 }}>
            {inputNeeded}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendInput()}
              placeholder="Type your answer..."
              style={{
                flex: 1, background: "var(--bg2)", border: "1px solid var(--brd)",
                color: "var(--tx)", padding: "6px 10px", borderRadius: 4, fontSize: 13,
              }}
            />
            <button className="btn btn-primary" onClick={sendInput}>{t("btn.send", "Send")}</button>
          </div>
        </div>
      )}

      {/* ── Issues Panel (grouped by mod) ── */}
      {errorEntries.length > 0 && (
        <div className="error-timeline">
          <div className="error-timeline-header">
            <h3>Issues</h3>
            <div className="badges">
              {errorCount > 0 && (
                <span className="badge errors">
                  {errorCount} errors
                  {totalCrashes > 0 && ` (${totalCrashes} crashes)`}
                </span>
              )}
              {warnCount > 0 && (
                <span className="badge warnings">{warnCount} warnings</span>
              )}
              {skipCount > 0 && (
                <span className="badge skipped">
                  {skipCount} skipped
                  {suspiciousSkips > 0 && (
                    <span style={{ color: "var(--org)" }}> ({suspiciousSkips} suspicious)</span>
                  )}
                </span>
              )}
            </div>
          </div>
          <div className="error-timeline-list" ref={errorTimelineRef}>
            {groupedIssues.map((group) => {
              const key = `${group.level}:${group.mod_name}`;
              const isExpanded = expandedGroups.has(key);
              const isSingle = group.entries.length === 1;
              const toggleExpand = () => {
                setExpandedGroups((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                });
              };

              return (
                <div key={key}>
                  {/* Group header */}
                  <div
                    className={`error-entry level-${group.level.toLowerCase()}`}
                    style={{ cursor: isSingle ? "default" : "pointer" }}
                    onClick={isSingle ? undefined : toggleExpand}
                  >
                    <span className="entry-time">
                      {formatTimestamp(group.firstTime, startTime)}
                    </span>
                    <span className="entry-mod" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      {!isSingle && (
                        <span style={{ fontSize: 9, opacity: 0.7 }}>
                          {isExpanded ? "\u25BC" : "\u25B6"}
                        </span>
                      )}
                      {group.mod_name}
                      {!isSingle && (
                        <span style={{ fontSize: 10, opacity: 0.6, fontWeight: 400 }}>
                          ({group.entries.length})
                        </span>
                      )}
                    </span>
                    <span className="entry-msg">
                      {/* Summary line for groups */}
                      {group.level === "ERROR" && !isSingle && (
                        <span>
                          {group.entries.length} components failed
                          {group.crashCount > 0 && (
                            <span style={{ color: "var(--pur)", marginLeft: 6 }}>
                              {group.crashCount} crashes
                            </span>
                          )}
                          {group.failureCount > 0 && (
                            <span style={{ color: "var(--red)", marginLeft: 6 }}>
                              {group.failureCount} failures
                            </span>
                          )}
                        </span>
                      )}
                      {group.level === "ERROR" && isSingle && (
                        <span>
                          {group.entries[0].message}
                          <span style={{ color: exitCodeColor(categorizeExitCode(group.entries[0].message)), marginLeft: 6, fontSize: 10 }}>
                            [{exitCodeLabel(categorizeExitCode(group.entries[0].message))}]
                          </span>
                        </span>
                      )}
                      {group.level === "WARN" && (
                        isSingle
                          ? group.entries[0].message
                          : `${group.entries.length} components with warnings`
                      )}
                      {group.level === "SKIP" && !isSingle && (
                        <span>
                          {group.entries.length} skipped
                          {group.missingFromLogCount > 0 && (
                            <span style={{ color: "var(--org)", marginLeft: 6 }}>
                              {group.missingFromLogCount} suspicious
                            </span>
                          )}
                        </span>
                      )}
                      {group.level === "SKIP" && isSingle && (
                        <span>
                          {group.entries[0].message}
                          {categorizeSkip(group.entries[0].message) === "missing-from-log" && (
                            <span style={{ color: "var(--org)", marginLeft: 6, fontSize: 10 }}>
                              [Suspicious]
                            </span>
                          )}
                        </span>
                      )}
                      {group.level === "RETRY" && (
                        isSingle
                          ? group.entries[0].message
                          : `${group.entries.length} batch retries`
                      )}
                    </span>
                  </div>
                  {/* Expanded children */}
                  {isExpanded && !isSingle && (
                    <div style={{ paddingLeft: 20, borderLeft: "2px solid var(--brd2)", marginLeft: 8, marginBottom: 4 }}>
                      {group.entries.map((entry, i) => (
                        <div
                          key={i}
                          className={`error-entry level-${entry.level.toLowerCase()}`}
                          style={{ fontSize: 11, padding: "4px 10px" }}
                        >
                          <span className="entry-time" style={{ fontSize: 9 }}>
                            {formatTimestamp(entry.timestamp, startTime)}
                          </span>
                          <span className="entry-msg">
                            {entry.message}
                            {entry.level === "ERROR" && (
                              <span style={{ color: exitCodeColor(categorizeExitCode(entry.message)), marginLeft: 6, fontSize: 9 }}>
                                [{exitCodeLabel(categorizeExitCode(entry.message))}]
                              </span>
                            )}
                            {entry.level === "SKIP" && categorizeSkip(entry.message) === "missing-from-log" && (
                              <span style={{ color: "var(--org)", marginLeft: 6, fontSize: 9 }}>
                                [Suspicious]
                              </span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Collapsible Full Log ── */}
      <div
        className="log-toggle"
        onClick={() => setLogExpanded(!logExpanded)}
      >
        <span>
          <span className="toggle-arrow">
            {logExpanded ? "\u25BC" : "\u25B6"}
          </span>
          {" "}{t("install.full_log", "Full Log")} ({totalLineCount.toLocaleString()} lines)
        </span>
        <span style={{ fontSize: 11 }}>
          {logExpanded ? "Click to collapse" : "Click to expand"}
        </span>
      </div>

      {logExpanded && (
        <div style={{ position: "relative" }}>
          {/* Log search */}
          <div style={{ marginBottom: 4 }}>
            <input
              type="text" placeholder={t("install.search_log", "Search log...")} value={logSearch}
              onChange={(e) => setLogSearch(e.target.value)}
              style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--brd)", color: "var(--tx)", padding: "4px 8px", borderRadius: 3, fontSize: 11, outline: "none" }}
            />
          </div>
          <div
            ref={logContainerRef}
            className="log-output"
            onScroll={handleLogScroll}
            style={{
              height: "350px",
              maxHeight: "80vh",
              overflow: "auto",
              resize: "vertical",
            }}
          >
            {totalLineCount > LOG_BUFFER_SIZE && !logSearch && (
              <div style={{ color: "var(--txd)", fontSize: 11, padding: "4px 0", borderBottom: "1px solid var(--brd)", marginBottom: 4 }}>
                ... {(totalLineCount - LOG_BUFFER_SIZE).toLocaleString()} earlier lines not shown
              </div>
            )}
            {(logSearch ? displayLines.filter((l) => l.text.toLowerCase().includes(logSearch.toLowerCase())) : displayLines).map((line, i) => (
              <div
                key={i}
                className={
                  line.type === "stderr" ? "log-err"
                    : line.type === "system" ? "log-progress"
                    : ""
                }
              >
                {line.text}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
          {!logStickToBottom && (
            <button
              className="btn btn-primary"
              onClick={() => {
                setLogStickToBottom(true);
                logEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
              }}
              style={{
                position: "absolute",
                bottom: 16,
                right: 16,
                fontSize: 11,
                padding: "4px 12px",
                opacity: 0.9,
                zIndex: 10,
              }}
            >
              {t("install.jump_bottom", "Jump to bottom")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppConfig, ParsedLog } from "../App";
import { guiLog } from "../lib/gui-logger";
import {
  readInstallStatus,
  readErrorLog,
  readFileContents,
  requestPause,
  requestResume,
  type InstallStatus,
  type ErrorLogEntry,
} from "../lib/tauri-bridge";

interface Props {
  config: AppConfig;
  parsedLog: ParsedLog | null;
  running: boolean;
  onRunningChange: (running: boolean) => void;
  onSaveConfig: (config: AppConfig) => void;
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
}: Props) {
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

  // File-based monitoring — track both phases separately
  const [bg1Status, setBg1Status] = useState<InstallStatus | null>(null);
  const [bg2Status, setBg2Status] = useState<InstallStatus | null>(null);
  const [errorEntries, setErrorEntries] = useState<ErrorLogEntry[]>([]);
  const errorEntriesRef = useRef<ErrorLogEntry[]>([]); // Mutable accumulator
  const lastSeenLine = useRef(0);

  // Process state
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [inputNeeded, setInputNeeded] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [startError, setStartError] = useState<string | null>(null);
  const [pauseRequested, setPauseRequested] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const unlistenRefs = useRef<UnlistenFn[]>([]);

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

  // ETA calculation — runs whenever status changes
  useEffect(() => {
    if (!running) return;
    const combined = (bg1Status?.current ?? 0) + (bg2Status?.current ?? 0);
    const combinedTotal = (bg1Status?.total ?? 0) + (bg2Status?.total ?? 0);
    if (combinedTotal === 0) return;

    const now = Date.now();
    throughputSamples.current.push({ t: now, n: combined });

    // Keep last 5 minutes of samples
    const WINDOW_MS = 5 * 60 * 1000;
    throughputSamples.current = throughputSamples.current.filter(
      (s) => now - s.t < WINDOW_MS,
    );

    // Need at least 2 samples spread over 30+ seconds for a meaningful rate
    const samples = throughputSamples.current;
    if (samples.length >= 2) {
      const oldest = samples[0];
      const elapsedSec = (now - oldest.t) / 1000;
      const componentsDone = combined - oldest.n;

      if (elapsedSec >= 30 && componentsDone > 0) {
        const rate = componentsDone / elapsedSec;
        const remaining = combinedTotal - combined;
        const etaSec = remaining / rate;

        if (etaSec > 0 && etaSec < 86400) {
          setEta(formatElapsed(etaSec * 1000));
        } else {
          setEta(null);
        }
      }
    }
  }, [bg1Status, bg2Status, running]);

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
  const lastSeenErrorLineBg1 = useRef(0);
  const errorFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Batch error entry updates — accumulate in ref, flush to state periodically
  const appendErrors = useCallback((newEntries: ErrorLogEntry[]) => {
    if (newEntries.length === 0) return;
    errorEntriesRef.current.push(...newEntries);
    if (!errorFlushTimer.current) {
      errorFlushTimer.current = setTimeout(() => {
        errorFlushTimer.current = null;
        setErrorEntries([...errorEntriesRef.current]);
      }, 500);
    }
  }, []);

  // Polling via recursive setTimeout — each poll schedules the next AFTER completing.
  // Cannot silently die like setInterval with async callbacks.
  const pollCount = useRef(0);
  const lastLoggedCurrent = useRef(-1);
  const pollActive = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!running) {
      pollActive.current = false;
      return;
    }

    const bg1Dir = config.bg1_game_dir;
    const bg2Dir = config.bg2_game_dir;

    if (!bg1Dir && !bg2Dir) {
      guiLog.warn("POLL", "No game directories configured for polling");
      return;
    }

    guiLog.info("POLL", `Starting recursive polling: bg1=${bg1Dir || "none"}, bg2=${bg2Dir || "none"}`);
    pollActive.current = true;
    pollCount.current = 0;

    async function poll() {
      if (!pollActive.current) return;
      pollCount.current++;

      try {
        let bg1s: InstallStatus | null = null;
        let bg2s: InstallStatus | null = null;

        if (bg1Dir) {
          try {
            bg1s = await readInstallStatus(bg1Dir);
            if (bg1s) setBg1Status(bg1s);
          } catch (e) {
            // Log first 5, then every 100th failure
            if (pollCount.current <= 5 || pollCount.current % 100 === 0) {
              guiLog.warn("POLL", `BG1 read failed (poll ${pollCount.current}): ${e}`);
            }
          }
        }
        if (bg2Dir) {
          try {
            bg2s = await readInstallStatus(bg2Dir);
            if (bg2s) setBg2Status(bg2s);
          } catch (e) {
            if (pollCount.current <= 5 || pollCount.current % 100 === 0) {
              guiLog.warn("POLL", `BG2 read failed (poll ${pollCount.current}): ${e}`);
            }
          }
        }

        // Log progress changes
        const combined = (bg1s?.current ?? 0) + (bg2s?.current ?? 0);
        if (combined !== lastLoggedCurrent.current) {
          const total = (bg1s?.total ?? 0) + (bg2s?.total ?? 0);
          const mod = bg2s?.mod || bg1s?.mod || "?";
          guiLog.debug("POLL", `Progress: ${combined}/${total} mod=${mod}`);
          lastLoggedCurrent.current = combined;
        }

        // Heartbeat every 100 polls
        if (pollCount.current % 100 === 0) {
          guiLog.debug("POLL", `Heartbeat: poll #${pollCount.current}, combined=${combined}`);
        }

        // Detect paused state
        setIsPaused((bg2s?.status === "paused") || (bg1s?.status === "paused"));

        // Read errors
        if (bg2Dir) {
          try {
            const result = await readErrorLog(bg2Dir, lastSeenLine.current);
            if (result.entries.length > 0) appendErrors(result.entries);
            lastSeenLine.current = result.total_lines;
          } catch {}
        }
        if (bg1Dir) {
          try {
            const result = await readErrorLog(bg1Dir, lastSeenErrorLineBg1.current);
            if (result.entries.length > 0) appendErrors(result.entries);
            lastSeenErrorLineBg1.current = result.total_lines;
          } catch {}
        }
      } catch (e) {
        guiLog.error("POLL", `Poll ${pollCount.current} crashed: ${e}`);
      }

      // Schedule next poll — this is the key: always schedules, even after errors
      if (pollActive.current) {
        pollTimerRef.current = setTimeout(poll, 500);
      }
    }

    // Start the first poll
    pollTimerRef.current = setTimeout(poll, 500);

    return () => {
      guiLog.info("POLL", `Polling stopped after ${pollCount.current} polls`);
      pollActive.current = false;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [running, config.bg2_game_dir, config.bg1_game_dir, appendErrors]);

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
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      pollActive.current = false;
      unlistenRefs.current.forEach((fn) => fn());
      unlistenRefs.current.length = 0;
    };
  }, []);

  const startInstall = useCallback(async () => {
    // Guard against double-click
    if (running) return;
    setStartError(null);
    setPauseRequested(false);
    setIsPaused(false);
    // Clean up any stale pause file from previous run
    if (config.bg2_game_dir) requestResume(config.bg2_game_dir).catch(() => {});
    if (!config.mod_installer_path) {
      addLine("[ERROR] mod_installer path not configured — set it in Setup tab", "system");
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
    setBg1Status(null);
    setBg2Status(null);
    setErrorEntries([]);
    errorEntriesRef.current = [];
    logBuffer.current = [];
    logTotalCount.current = 0;
    pendingLines.current = [];
    setDisplayLines([]);
    setTotalLineCount(0);
    lastSeenLine.current = 0;
    lastSeenErrorLineBg1.current = 0;
    seenStdoutIssues.current.clear();
    if (errorFlushTimer.current) { clearTimeout(errorFlushTimer.current); errorFlushTimer.current = null; }
    setLogExpanded(false);
    setLogStickToBottom(true);
    throughputSamples.current = [];
    setEta(null);
    setStartTime(Date.now());
    setElapsed(0);
    onRunningChange(true);

    addLine("[EET Mod Runner] Starting installation...", "system");
    guiLog.info("INSTALL", `Starting install: ${config.mod_installer_path}`);

    const args: string[] = ["eet"];
    if (config.bg1_game_dir) args.push("--bg1-game-directory", config.bg1_game_dir);
    if (config.bg2_game_dir) args.push("--bg2-game-directory", config.bg2_game_dir);
    if (config.mod_directory) args.push("--mod-directories", config.mod_directory);
    if (config.weidu_path) args.push("--weidu-binary", config.weidu_path);
    if (parsedLog?.eetLogPath) args.push("--bg2-log-file", parsedLog.eetLogPath);
    if (parsedLog?.bgeeLogPath) args.push("--bg1-log-file", parsedLog.bgeeLogPath);
    // Install options — essential
    args.push("--skip-installed", config.skip_installed ? "true" : "false");
    args.push("--timeout", String(config.timeout));
    args.push("--download", config.download_mods ? "true" : "false");
    if (config.abort_on_warnings) args.push("--abort-on-warnings");
    if (config.never_abort) args.push("--never-abort");
    if (config.overwrite) args.push("--overwrite");
    args.push("--check-last-installed", config.check_last_installed ? "true" : "false");
    // Install options — advanced
    if (config.language && config.language !== "en_US") args.push("--language", config.language);
    if (config.depth !== 5) args.push("--depth", String(config.depth));
    if (config.strict_matching) args.push("--strict-matching");
    if (config.tick !== 500) args.push("--tick", String(config.tick));
    if (config.lookback !== 10) args.push("--lookback", String(config.lookback));
    if (config.weidu_log_mode && config.weidu_log_mode !== "autolog,logapp,log-extern") {
      args.push("--weidu-log-mode", config.weidu_log_mode);
    }
    if (config.casefold) args.push("--casefold");
    if (config.generic_weidu_args) args.push("--generic-weidu-args", config.generic_weidu_args);

    addLine(`[EET Mod Runner] Command: ${config.mod_installer_path} ${args.join(" ")}`, "system");

    try {
      // Set up event listeners for stdout/stderr/exit from Rust backend
      const unlistenStdout = await listen<string>("install-stdout", (event) => {
        try {
          addLine(event.payload, "stdout");
          detectInput(event.payload);
          detectStdoutIssue(event.payload);
        } catch (err) {
          console.error("Error processing stdout:", err);
        }
      });
      const unlistenStderr = await listen<string>("install-stderr", (event) => {
        addLine(event.payload, "stderr");
      });
      const unlistenExit = await listen<number>("install-exit", (event) => {
        const code = event.payload;
        setExitCode(code);
        onRunningChange(false);
        addLine(`[EET Mod Runner] Process exited with code ${code}`, "system");
        guiLog.info("INSTALL", `Process exited with code ${code}`);
        // Final poll from both dirs
        if (config.bg1_game_dir) {
          readInstallStatus(config.bg1_game_dir).then((s) => {
            if (s) setBg1Status(s);
          }).catch(() => {});
          readErrorLog(config.bg1_game_dir, lastSeenErrorLineBg1.current).then((result) => {
            if (result.entries.length > 0) appendErrors(result.entries);
          }).catch(() => {});
        }
        if (config.bg2_game_dir) {
          readInstallStatus(config.bg2_game_dir).then((s) => {
            if (s) setBg2Status(s);
          }).catch(() => {});
          readErrorLog(config.bg2_game_dir, lastSeenLine.current).then((result) => {
            if (result.entries.length > 0) appendErrors(result.entries);
          }).catch(() => {});
        }
        // Cleanup listeners
        unlistenStdout();
        unlistenStderr();
        unlistenExit();
      });
      unlistenRefs.current = [unlistenStdout, unlistenStderr, unlistenExit];

      // Spawn via Rust backend
      await invoke("start_install", {
        modInstallerPath: config.mod_installer_path,
        args,
      });
    } catch (e) {
      const errMsg = String(e);
      addLine(`[EET Mod Runner] Failed to start: ${errMsg}`, "system");
      guiLog.error("INSTALL", `Failed to start: ${errMsg}`);
      setStartError(errMsg);
      setLogExpanded(true);
      onRunningChange(false);
      // Clean up listeners that were set up before the invoke failed
      unlistenRefs.current.forEach((fn) => fn());
      unlistenRefs.current.length = 0;
    }
  }, [config, parsedLog, running, onRunningChange, addLine]);

  // Accumulate recent lines to build question context
  const recentLines = useRef<string[]>([]);

  function detectInput(line: string) {
    recentLines.current.push(line);
    // Keep last 15 lines for context
    if (recentLines.current.length > 15) recentLines.current.shift();

    // mod_installer signals: "[INFO] User Input required" or "[INFO] Question is"
    const modInstallerInput = /User Input required|Question is/i.test(line);

    // WeiDU patterns: [Y]es or [N]o, Choose, Select, Enter the full path, etc.
    const weiduPatterns = [
      /\[Y\]es\s+or\s+\[N\]o/i,
      /\bchoose\b.*:/i,
      /\bselect\b.*:/i,
      /\benter the full path\b/i,
      /\bdo you want\b/i,
      /\bwould you like\b/i,
      /\?\s*$/,
    ];
    const weiduInput = weiduPatterns.some((p) => p.test(line));

    if (modInstallerInput || weiduInput) {
      // Show the last few lines as context for the question
      const context = recentLines.current.slice(-5).join("\n");
      setInputNeeded(context);
    }
  }

  // Track which messages we've already surfaced to avoid duplicates
  const seenStdoutIssues = useRef(new Set<string>());

  function detectStdoutIssue(line: string) {
    // WeiDU prints these patterns for install results
    const patterns: { regex: RegExp; level: string }[] = [
      { regex: /INSTALLED WITH WARNINGS\s+(.+)/i, level: "WARN" },
      { regex: /NOT INSTALLED DUE TO ERRORS\s+(.+)/i, level: "ERROR" },
      { regex: /ERROR Installing \[(.+?)\]/i, level: "ERROR" },
      { regex: /ERROR Re-Installing \[(.+?)\]/i, level: "ERROR" },
    ];

    for (const { regex, level } of patterns) {
      const match = line.match(regex);
      if (match) {
        const key = `${level}:${match[1]}`;
        if (seenStdoutIssues.current.has(key)) return;
        seenStdoutIssues.current.add(key);

        const now = new Date().toISOString();
        appendErrors([{
          timestamp: now,
          level,
          mod_name: "",
          message: match[1].trim(),
        }]);
        return;
      }
    }
  }

  async function sendInput() {
    if (inputValue) {
      try {
        await invoke("send_install_input", { text: inputValue });
        addLine(`[User Input] ${inputValue}`, "system");
        setInputValue("");
        setInputNeeded(null);
      } catch (e) {
        addLine(`[EET Mod Runner] Failed to send input: ${e}`, "system");
      }
    }
  }

  async function abortInstall() {
    try {
      await invoke("abort_install");
      addLine("[EET Mod Runner] Installation aborted by user.", "system");
      guiLog.warn("INSTALL", "Installation aborted by user");
      onRunningChange(false);
    } catch (e) {
      addLine(`[EET Mod Runner] Failed to abort: ${e}`, "system");
    }
  }

  async function togglePause() {
    const gameDir = config.bg2_game_dir;
    if (!gameDir) return;

    if (pauseRequested) {
      // Resume
      try {
        await requestResume(gameDir);
        setPauseRequested(false);
        addLine("[EET Mod Runner] Resume requested — will continue after current pause.", "system");
        guiLog.info("INSTALL", "Resume requested");
      } catch (e) {
        addLine(`[EET Mod Runner] Failed to resume: ${e}`, "system");
      }
    } else {
      // Pause
      try {
        await requestPause(gameDir);
        setPauseRequested(true);
        addLine("[EET Mod Runner] Pause requested — will pause after current mod finishes.", "system");
        guiLog.info("INSTALL", "Pause requested");
      } catch (e) {
        addLine(`[EET Mod Runner] Failed to request pause: ${e}`, "system");
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

  // Combine both phases for display
  // Active status = whichever was updated most recently
  const activeStatus = (() => {
    if (!bg1Status && !bg2Status) return null;
    if (!bg1Status) return bg2Status;
    if (!bg2Status) return bg1Status;
    return bg2Status.last_updated >= bg1Status.last_updated ? bg2Status : bg1Status;
  })();

  // Combined progress = sum of both phases
  const combinedCurrent = (bg1Status?.current ?? 0) + (bg2Status?.current ?? 0);
  const combinedTotal = (bg1Status?.total ?? 0) + (bg2Status?.total ?? 0);

  const pct = combinedTotal > 0
    ? Math.round((combinedCurrent / combinedTotal) * 100)
    : 0;

  // Use install_status.json as source of truth for counts (avoids double-counting with errorEntries).
  // Fall back to errorEntries count only if no status files exist yet.
  const hasStatusData = bg1Status !== null || bg2Status !== null;
  const errorCount = hasStatusData
    ? (bg1Status?.errors ?? 0) + (bg2Status?.errors ?? 0)
    : errorEntries.filter((e) => e.level === "ERROR").length;
  const warnCount = hasStatusData
    ? (bg1Status?.warnings ?? 0) + (bg2Status?.warnings ?? 0)
    : errorEntries.filter((e) => e.level === "WARN").length;
  const skipCount = hasStatusData
    ? (bg1Status?.skipped ?? 0) + (bg2Status?.skipped ?? 0)
    : errorEntries.filter((e) => e.level === "SKIP").length;
  const isComplete = exitCode !== null && !running;

  // Determine which phase is active
  const currentPhase: "bg1" | "eet" | "done" | "starting" = (() => {
    if (isComplete) return "done";
    if (!activeStatus) return "starting";
    if (activeStatus === bg1Status && bg1Status?.status !== "complete") return "bg1";
    return "eet";
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
        <h2>Install Runner</h2>
        <p style={{ color: "var(--txd)", marginBottom: 20, fontSize: 13 }}>
          Execute mod_installer with your imported configuration. Real-time
          progress and error monitoring powered by install_status.json.
        </p>

        {!config.mod_installer_path && (
          <div className="msg err">
            mod_installer path not configured. Set it in the Setup tab.
          </div>
        )}
        {!parsedLog && (
          <div className="msg warn">
            No log imported. Import a WeiDU.log first.
          </div>
        )}

        <h3>Install Options</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
          <ToggleOption checked={config.skip_installed} onChange={(v) => updateOption("skip_installed", v)} label="Skip already installed" hint="Resume interrupted installs" />
          <ToggleOption checked={config.never_abort} onChange={(v) => updateOption("never_abort", v)} label="Never abort (continue past errors)" hint="Recommended for large installs" />
          <ToggleOption checked={config.download_mods} onChange={(v) => updateOption("download_mods", v)} label="Download missing mods" hint="Auto-download from GitHub" />
          <ToggleOption checked={config.overwrite} onChange={(v) => updateOption("overwrite", v)} label="Overwrite mod folders" hint="Force re-copy even if present" />
          <ToggleOption checked={config.abort_on_warnings} onChange={(v) => updateOption("abort_on_warnings", v)} label="Abort on warnings" hint="Stop if WeiDU warns" />
          <ToggleOption checked={config.check_last_installed} onChange={(v) => updateOption("check_last_installed", v)} label="Verify post-install" hint="Check component in weidu.log after" />
          <NumericOption value={config.timeout} onChange={(v) => updateOption("timeout", v)} label="Timeout" suffix={`sec (${Math.round(config.timeout / 60)}m)`} />
        </div>

        {/* Advanced options — collapsible */}
        <div
          className="log-toggle"
          onClick={() => setAdvancedOpen(!advancedOpen)}
          style={{ marginBottom: advancedOpen ? 8 : 16 }}
        >
          <span>
            <span className="toggle-arrow">{advancedOpen ? "\u25BC" : "\u25B6"}</span>
            {" "}Advanced Options
          </span>
        </div>
        {advancedOpen && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16, padding: "0 4px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--tx)" }}>
              <span style={{ minWidth: 70 }}>Language:</span>
              <input type="text" value={config.language} onChange={(e) => onSaveConfig({ ...config, language: e.target.value })}
                style={{ width: 80, background: "var(--bg2)", border: "1px solid var(--brd)", color: "var(--tx)", padding: "4px 8px", borderRadius: 4, fontSize: 13 }} />
            </div>
            <NumericOption value={config.depth} onChange={(v) => updateOption("depth", v)} label="Search depth" />
            <ToggleOption checked={config.strict_matching} onChange={(v) => updateOption("strict_matching", v)} label="Strict matching" hint="Match version + sub-component exactly" />
            <ToggleOption checked={config.casefold} onChange={(v) => updateOption("casefold", v)} label="Casefold (Linux ext4)" hint="Enable ext4 case-insensitive matching" />
            <NumericOption value={config.tick} onChange={(v) => updateOption("tick", v)} label="Poll interval" suffix="ms" />
            <NumericOption value={config.lookback} onChange={(v) => updateOption("lookback", v)} label="Lookback" suffix="lines" />
            <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--tx)" }}>
              <span style={{ minWidth: 110 }}>WeiDU log mode:</span>
              <input type="text" value={config.weidu_log_mode} onChange={(e) => onSaveConfig({ ...config, weidu_log_mode: e.target.value })}
                style={{ flex: 1, background: "var(--bg2)", border: "1px solid var(--brd)", color: "var(--tx)", padding: "4px 8px", borderRadius: 4, fontSize: 13 }} />
            </div>
            <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--tx)" }}>
              <span style={{ minWidth: 110 }}>Extra WeiDU args:</span>
              <input type="text" value={config.generic_weidu_args} onChange={(e) => onSaveConfig({ ...config, generic_weidu_args: e.target.value })}
                placeholder="e.g. --safe-exit,--noautoupdate"
                style={{ flex: 1, background: "var(--bg2)", border: "1px solid var(--brd)", color: "var(--tx)", padding: "4px 8px", borderRadius: 4, fontSize: 13 }} />
            </div>
          </div>
        )}

        {startError && (
          <div className="msg err" style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Failed to start installation</div>
            <div style={{ fontSize: 12, wordBreak: "break-all" }}>{startError}</div>
          </div>
        )}

        <button
          className="btn btn-primary"
          onClick={startInstall}
          disabled={!config.mod_installer_path || !parsedLog}
          style={{ marginBottom: 16 }}
        >
          Start Installation
        </button>
      </div>
    );
  }

  // ─── Active install / post-install view ───
  return (
    <div>
      <h2>Install Runner</h2>

      {/* ── Status Dashboard ── */}
      <div className="install-dashboard">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div className="current-mod">
                {isPaused ? "Paused"
                  : activeStatus?.mod
                    ? activeStatus.mod
                    : isComplete ? "Installation complete"
                      : pauseRequested ? "Pausing after current mod..."
                        : combinedCurrent > 0 ? "Installing..."
                          : "Starting..."}
              </div>
              {currentPhase !== "done" && currentPhase !== "starting" && (
                <span style={{
                  fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 10,
                  background: currentPhase === "bg1" ? "var(--bg-info)" : "var(--bg3)",
                  color: currentPhase === "bg1" ? "var(--cyn)" : "var(--gold)",
                  border: `1px solid ${currentPhase === "bg1" ? "var(--cyn)" : "var(--goldd)"}`,
                }}>
                  {currentPhase === "bg1" ? "BG1:EE Phase" : "EET Phase"}
                </span>
              )}
            </div>
            <div className="current-component">
              {activeStatus?.component
                || (combinedCurrent > 0 ? `${combinedCurrent} components processed`
                  : "Waiting for first mod...")}
              {activeStatus?.last_updated && (
                <span style={{ color: "var(--txd)", fontSize: 10, marginLeft: 8 }}>
                  (status: {activeStatus.last_updated.split("T")[1]?.replace("Z", "") || "?"})
                </span>
              )}
            </div>
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
                  {isPaused ? "Resume" : pauseRequested ? "Pausing..." : "Pause"}
                </button>
                <button className="btn btn-danger" onClick={abortInstall}>
                  Abort
                </button>
              </>
            )}
          </div>
        </div>

        <div className="progress-bar" style={{ height: 8 }}>
          <div className="fill" style={{ width: `${pct}%` }} />
        </div>

        <div className="stats-row">
          <div className="stat">
            <span className="stat-num" style={{ color: "var(--goldb)" }}>
              {combinedCurrent}
            </span>
            <span style={{ color: "var(--txd)" }}>
              / {combinedTotal || parsedLog?.componentCount || "?"} components
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

      {/* ── Post-Install Summary ── */}
      {isComplete && (
        <div className={`install-summary`}>
          <div
            className="summary-title"
            style={{ color: exitCode === 0 ? "var(--grn)" : "var(--red)" }}
          >
            {exitCode === 0 ? "Installation Complete" : `Installation Finished (exit code ${exitCode})`}
          </div>
          <div className="summary-time">
            Total time: {formatElapsed(elapsed)}
          </div>
          <div className="summary-grid" style={{ margin: "12px 0" }}>
            <div className="summary-card">
              <div className="number" style={{ color: "var(--grn)" }}>
                {Math.max(0, combinedCurrent - errorCount - skipCount)}
              </div>
              <div className="label">Installed</div>
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
              <div className="label">Errors</div>
              {errorCount > 0 && (
                <div style={{ fontSize: 10, color: "var(--txd)", marginTop: 4 }}>
                  {totalCrashes > 0 && <div><span style={{ color: "var(--pur)" }}>{totalCrashes}</span> crashes</div>}
                  {totalFailures > 0 && <div><span style={{ color: "var(--red)" }}>{totalFailures}</span> failures</div>}
                  {totalUnknownErrors > 0 && <div><span style={{ color: "var(--org)" }}>{totalUnknownErrors}</span> unknown</div>}
                  <div style={{ marginTop: 2 }}>{uniqueErrorMods} mods affected</div>
                </div>
              )}
            </div>
            <div className="summary-card">
              <div className="number" style={{ color: "var(--txd)" }}>
                {skipCount}
              </div>
              <div className="label">Skipped</div>
              {suspiciousSkips > 0 && (
                <div style={{ fontSize: 10, color: "var(--org)", marginTop: 4 }}>
                  {suspiciousSkips} suspicious
                </div>
              )}
            </div>
            {combinedTotal > combinedCurrent && (
              <div className="summary-card">
                <div className="number" style={{ color: "var(--txd)" }}>
                  {combinedTotal - combinedCurrent}
                </div>
                <div className="label">Unattempted</div>
                <div style={{ fontSize: 10, color: "var(--txd)", marginTop: 4 }}>
                  mod not found or skipped entirely
                </div>
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button className="btn" onClick={copyErrorReport}>
              Copy Error Report
            </button>
            <button className="btn btn-primary" onClick={() => {
              setExitCode(null);
              setBg1Status(null);
              setBg2Status(null);
              setErrorEntries([]);
              errorEntriesRef.current = [];
              logBuffer.current = [];
              logTotalCount.current = 0;
              pendingLines.current = [];
              setDisplayLines([]);
              setTotalLineCount(0);
              lastSeenLine.current = 0;
              lastSeenErrorLineBg1.current = 0;
              seenStdoutIssues.current.clear();
              if (errorFlushTimer.current) { clearTimeout(errorFlushTimer.current); errorFlushTimer.current = null; }
              setExpandedGroups(new Set());
              setInputNeeded(null);
              setInputValue("");
              setLogExpanded(false);
              setLogStickToBottom(true);
              throughputSamples.current = [];
              setEta(null);
            }}>
              New Install
            </button>
          </div>
        </div>
      )}

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
            Input Required
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
            <button className="btn btn-primary" onClick={sendInput}>Send</button>
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
          {" "}Full Log ({totalLineCount.toLocaleString()} lines)
        </span>
        <span style={{ fontSize: 11 }}>
          {logExpanded ? "Click to collapse" : "Click to expand"}
        </span>
      </div>

      {logExpanded && (
        <div style={{ position: "relative" }}>
          <div
            ref={logContainerRef}
            className="log-output"
            onScroll={handleLogScroll}
            style={{
              height: "350px",
              maxHeight: "80vh",
              overflow: "auto",
              resize: "vertical", /* Native browser resize handle */
            }}
          >
            {totalLineCount > LOG_BUFFER_SIZE && (
              <div style={{ color: "var(--txd)", fontSize: 11, padding: "4px 0", borderBottom: "1px solid var(--brd)", marginBottom: 4 }}>
                ... {(totalLineCount - LOG_BUFFER_SIZE).toLocaleString()} earlier lines not shown
              </div>
            )}
            {displayLines.map((line, i) => (
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
              Jump to bottom
            </button>
          )}
        </div>
      )}
    </div>
  );
}

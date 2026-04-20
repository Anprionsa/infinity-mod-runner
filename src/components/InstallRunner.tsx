import { useState, useRef, useEffect, useCallback, useMemo } from "react";
// import { invoke } from "@tauri-apps/api/core"; // No longer needed — using typed wrappers
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { DEFAULT_FORGE_URL } from "../App";
import type { AppConfig, ParsedLog, InstallStatusMap, InstallIssueMap, InstallIssue, Tab } from "../App";
import {
  guiLog,
  startInstallSession,
  noteBatchStart,
  logBatchDone,
  logBatchError,
  logInstallPause,
  logInstallComplete,
  logInstallFatal,
  getInstallSession,
  withTail,
} from "../lib/gui-logger";
import {
  readFileContents,
  startNativeInstall,
  startDryRun,
  weiduSwapResolvePath,
  getBinaryVersion,
  installDecision,
  installPause,
  installResume,
  installSendInput,
  abortNativeInstall,
  writeTempLog,
  saveInstallReport,
  getLogPaths,
  openPath,
  defenderStatus,
  defenderIsPathExcluded,
  defenderAddExclusion,
  type NativeInstallArgs,
  type ErrorLogEntry,
  type DefenderStatus,
} from "../lib/tauri-bridge";
import DefenderModal, { type DefenderModalResolution } from "./DefenderModal";
import { buildReport, type InstallReport } from "../lib/install-report";
import {
  fetchModIndex,
  fetchInstallProfiles,
  fetchAcceleratorCoefficients,
  fetchKnownIssues,
  type InstallProfileMap,
  type KnownIssue,
} from "../lib/forge-data";
import {
  classifyBatchWarnings,
  summaryText,
  categoryColor,
  categoryLabel,
  type ClassifiedWarning,
  type WarningSummary,
} from "../lib/warning-classifier";
import {
  CLASS_DEFAULT_BASELINE_SEC,
  inferHeavyClass,
  discountCoefficient,
  FALLBACK_ACCELERATOR_COEFFICIENTS,
  type AcceleratorCoefficients,
  type HeavyClass,
} from "../constants/install-baselines";
import { shareReportOnGitHub, shareTraceOnGitHub } from "../lib/telemetry";
import { filterLogText } from "../lib/log-parser";
import { useI18n } from "../lib/i18n";
import ResizablePanel, { computeFitHeight } from "./ResizablePanel";
import TransitionBanner from "./TransitionBanner";
import { WEIDU_LANGUAGES } from "../constants/languages";
import {
  DEFAULT_INSTALL_TIMEOUT_S,
  DEFAULT_MAX_BATCH,
  DEFAULT_HEAVY_BATCH,
  DEFAULT_WEIDU_LOG_MODE,
  DEFAULT_WEIDU_LANGUAGE,
} from "../constants/installer";
import { TraceRecorder, serializeTrace, type InstallTrace, type InstallTraceEntry } from "../lib/install-trace";
import Tip from "./Tip";

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
  onInstallIssues?: (issues: InstallIssueMap) => void;
  /** Cross-tab navigation for preconditions-list jump buttons (e.g.
   * "Configure WeiDU in Setup", "Import a mod list in Mods"). */
  onGoToTab?: (tab: Tab) => void;
  /** Transition banner gating — Ready Check just passed during this session. */
  showPreflightPassedBanner?: boolean;
  onDismissPreflightPassedBanner?: () => void;
}

interface LogLine {
  text: string;
  type: "stdout" | "stderr" | "system";
  /** Count of consecutive identical lines this entry represents. Omitted or
   * 1 means a single occurrence. Populated by `addLine` at ingestion so
   * the count accurately reflects the FULL run — not just what survives the
   * 500-line ring buffer. Before this, a 10000-line SFO burst displayed as
   * "×500" forever while totalLineCount climbed past 10000. */
  count?: number;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** Pretty-print a KB value as KB / MB with one decimal for MB. Used by
 *  the BCS cache badge tooltip and post-install card — peak_kb comes in
 *  kilobytes because the OCaml emitter divides bytes by 1024. */
function formatCacheKb(kb: number): string {
  if (kb < 1024) return `${kb} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** ETA display buckets — round up so the label never implies precision
 * the rate calculation can't justify.
 *
 *   under 1 min → "< 1m"
 *   1-5 min     → 30-sec buckets, e.g. "~3m 30s"
 *   5-30 min    → 1-min buckets,  e.g. "~17m"
 *   30-120 min  → 5-min range,    e.g. "~50-55m"
 *   > 2 hours   → half-hour steps,e.g. "≈ 2h", "≈ 2h30m"
 */
function formatEtaBucketed(etaSec: number): string {
  if (etaSec < 60) return "< 1m";
  if (etaSec < 5 * 60) {
    const bucket = Math.ceil(etaSec / 30) * 30;
    const m = Math.floor(bucket / 60);
    const s = bucket % 60;
    return s === 0 ? `~${m}m` : `~${m}m ${s}s`;
  }
  if (etaSec < 30 * 60) {
    const m = Math.ceil(etaSec / 60);
    return `~${m}m`;
  }
  if (etaSec < 120 * 60) {
    const bucket = Math.ceil(etaSec / (5 * 60));
    const lo = (bucket - 1) * 5;
    const hi = bucket * 5;
    return `~${lo}\u2013${hi}m`;
  }
  const halfHours = Math.round(etaSec / 1800);
  const h = Math.floor(halfHours / 2);
  const halfStep = halfHours % 2 === 1;
  // ASCII tilde for the "approximate" marker instead of `\u2248` (≈)
  // because the ≈ glyph renders as `?` or a tofu box in fonts that don't
  // include it — seen in the wild as "5h ? remaining" where the font
  // fallback ate the symbol. The sub-2h paths already use `~`; this
  // path now matches for consistency.
  return halfStep ? `~${h}h30m` : `~${h}h`;
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
  /** Worst-severity level found across `entries` — drives the row's color
   * tag and sort order. Individual entries keep their own levels for the
   * expanded view. RETRY > ERROR > WARN > SKIP > INFO. */
  level: string;
  entries: ErrorLogEntry[];
  /** Set of distinct levels present in `entries`. Filter chips activate a
   * group if its `levelsPresent` intersects the chosen filter set. */
  levelsPresent: Set<string>;
  /** Per-level counts for the row summary text. */
  errorCount: number;
  warnCount: number;
  skipCount: number;
  retryCount: number;
  // For errors: breakdown by exit code type
  crashCount: number;
  failureCount: number;
  unknownCount: number;
  // For skips: breakdown by reason
  batchRetryCount: number;
  missingFromLogCount: number;
  // First/last timestamp across all entries
  firstTime: string;
  lastTime: string;
}

// Severity ordering — higher number = more severe. Used to pick the row's
// primary level tag and to sort rows.
//
// SKIP outranks WARN: a skipped component means the mod wasn't installed
// at all for that slot — a more consequential outcome than a warning on
// a component that DID install. RETRY stays at the top because it
// indicates an active recovery mid-batch (the user needs to act / watch).
const LEVEL_SEVERITY: Record<string, number> = {
  RETRY: 4, ERROR: 3, SKIP: 2, WARN: 1, INFO: 0,
};

/** Sort mode for the Issues panel. "newest" puts the most-recent activity
 * at the top so a long-running install's new issues are visible without
 * scrolling; "severity" groups highest-severity issues first regardless
 * of timestamp. Default is "newest" because by the end of a 12h run there
 * can be 30+ entries — newest-first is what the user wants mid-install,
 * and severity sort is better as an explicit opt-in for post-mortem. */
type IssueSortMode = "newest" | "severity";

function groupErrorEntries(entries: ErrorLogEntry[], sortMode: IssueSortMode = "newest"): GroupedIssue[] {
  // Merge by normalized mod_name (case-insensitive) so case drift between
  // events doesn't split one mod into two rows. Previous design used
  // `level:mod_name` as the key, which produced up to four rows per mod
  // (one per level) — visually noisy and confusing when e.g. eet_end had
  // both an ERROR and a SKIP entry from the auto-abort cascade.
  const map = new Map<string, GroupedIssue>();

  for (const entry of entries) {
    const modKey = (entry.mod_name || "(unknown)").toLowerCase();

    if (!map.has(modKey)) {
      map.set(modKey, {
        mod_name: entry.mod_name || "(unknown)",
        level: entry.level,
        entries: [],
        levelsPresent: new Set(),
        errorCount: 0,
        warnCount: 0,
        skipCount: 0,
        retryCount: 0,
        crashCount: 0,
        failureCount: 0,
        unknownCount: 0,
        batchRetryCount: 0,
        missingFromLogCount: 0,
        firstTime: entry.timestamp,
        lastTime: entry.timestamp,
      });
    }

    const group = map.get(modKey)!;
    group.entries.push(entry);
    group.levelsPresent.add(entry.level);
    if (entry.timestamp < group.firstTime) group.firstTime = entry.timestamp;
    if (entry.timestamp > group.lastTime) group.lastTime = entry.timestamp;

    // Promote the row's primary level to the most severe entry seen.
    if ((LEVEL_SEVERITY[entry.level] ?? -1) > (LEVEL_SEVERITY[group.level] ?? -1)) {
      group.level = entry.level;
    }

    if (entry.level === "ERROR") {
      group.errorCount++;
      const cat = categorizeExitCode(entry.message);
      if (cat === "crash") group.crashCount++;
      else if (cat === "failure") group.failureCount++;
      else group.unknownCount++;
    } else if (entry.level === "WARN") {
      group.warnCount++;
    } else if (entry.level === "SKIP") {
      group.skipCount++;
      const reason = categorizeSkip(entry.message);
      if (reason === "batch-retry") group.batchRetryCount++;
      else if (reason === "missing-from-log") group.missingFromLogCount++;
    } else if (entry.level === "RETRY") {
      group.retryCount++;
    }
  }

  const groups = [...map.values()];
  if (sortMode === "newest") {
    // Newest-first: sort by last-seen timestamp (desc) so the mid-install
    // user sees what just happened at the top of the list. Ties break by
    // severity so a fresh warning doesn't outrank a fresh error at the
    // same timestamp.
    groups.sort((a, b) => {
      const t = b.lastTime.localeCompare(a.lastTime);
      if (t !== 0) return t;
      return (LEVEL_SEVERITY[b.level] ?? -1) - (LEVEL_SEVERITY[a.level] ?? -1);
    });
  } else {
    // Severity-first: original sort. Worst severity first, then oldest
    // within a severity level. Good for post-mortem analysis ("what's
    // broken, in rough order of appearance").
    groups.sort((a, b) => {
      const sa = LEVEL_SEVERITY[a.level] ?? -1;
      const sb = LEVEL_SEVERITY[b.level] ?? -1;
      if (sa !== sb) return sb - sa;
      return a.firstTime.localeCompare(b.firstTime);
    });
  }
  return groups;
}

function ToggleOption({ checked, onChange, label, hint, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean;
}) {
  return (
    <div className="settings-row">
      <div>
        <div className="settings-label">{label}</div>
        {hint && <div className="settings-hint">{hint}</div>}
      </div>
      <div className="settings-control">
        <div className="segmented" role="group" aria-label={label}>
          <button
            type="button"
            className={"segmented-btn" + (!checked ? " ac" : "")}
            onClick={() => onChange(false)}
            disabled={disabled}
            aria-pressed={!checked}
          >Off</button>
          <button
            type="button"
            className={"segmented-btn" + (checked ? " ac" : "")}
            onClick={() => onChange(true)}
            disabled={disabled}
            aria-pressed={checked}
          >On</button>
        </div>
      </div>
    </div>
  );
}

function NumericOption({ value, onChange, label, hint, suffix, width = 80, min, max }: {
  value: number; onChange: (v: number) => void; label: string; hint?: string; suffix?: string;
  width?: number; min?: number; max?: number;
}) {
  return (
    <div className="settings-row">
      <div>
        <div className="settings-label">{label}</div>
        {hint && <div className="settings-hint">{hint}</div>}
      </div>
      <div className="settings-control">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          onChange={(e) => {
            let n = parseInt(e.target.value) || 0;
            if (min !== undefined) n = Math.max(min, n);
            if (max !== undefined) n = Math.min(max, n);
            onChange(n);
          }}
          style={{ width, textAlign: "right" }}
        />
        {suffix && <span className="settings-suffix">{suffix}</span>}
      </div>
    </div>
  );
}

/**
 * Numeric setting that requires an explicit "Confirm" click to persist.
 *
 * Unlike `NumericOption`, which writes to disk on every keystroke, this
 * component keeps a local draft and only calls `onConfirm` when the user
 * clicks the adjacent Confirm button (or presses Enter in the input). Used
 * for power-user settings where the user needs unambiguous feedback that
 * their change was saved — e.g. heavy batch size, which has historically
 * caused confusion ("did my 10 actually stick, or did the dry run use 3?").
 *
 * Button states:
 *   - idle + clean (draft === saved)   → "Saved"   (gray, disabled)
 *   - dirty (draft !== saved)          → "Confirm" (amber, clickable)
 *   - briefly after confirm click      → "✓ Saved" (green, 2s flash)
 */
function ConfirmableNumericOption({
  value, onConfirm, label, hint, suffix, width = 80, min, max, dangerAbove,
}: {
  value: number;
  onConfirm: (v: number) => void;
  label: string;
  hint?: string;
  suffix?: string | ((draft: number) => string);
  width?: number;
  min?: number;
  max?: number;
  /** When draft > this value, render the Confirm button in red to signal risk. */
  dangerAbove?: number;
}) {
  const [draft, setDraft] = useState<number>(value);
  const [justSaved, setJustSaved] = useState(false);

  // Sync draft when the external value changes (e.g. config reload, reset).
  // Doesn't clobber an in-progress edit because the dependency is on `value`.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  // Clear the "just saved" green flash after 2s.
  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), 2000);
    return () => clearTimeout(t);
  }, [justSaved]);

  const dirty = draft !== value;
  const danger = dangerAbove !== undefined && draft > dangerAbove;

  const clamp = (n: number) => {
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    return n;
  };

  const commit = () => {
    if (!dirty) return;
    onConfirm(draft);
    setJustSaved(true);
  };

  const suffixText = typeof suffix === "function" ? suffix(draft) : suffix;

  // Button styling depends on state. Dirty+danger = red, dirty = amber, fresh
  // save = green, clean idle = muted.
  const btnColor = justSaved
    ? { bg: "#065f46", border: "#10b981", fg: "#d1fae5", label: "\u2713 Saved" }
    : dirty
      ? (danger
          ? { bg: "#991b1b", border: "#ef4444", fg: "#fee2e2", label: "Confirm" }
          : { bg: "#92400e", border: "#d97706", fg: "#fef3c7", label: "Confirm" })
      : { bg: "transparent", border: "#444", fg: "#888", label: "Saved" };

  // Phase 19f: the Confirm/Saved button used to sit inline with the
  // input, inflating this row's width beyond every sibling row (which
  // only have [toggle] or [input][suffix] on the control side). The
  // input column no longer aligned with other numeric rows, breaking
  // the column rhythm. New layout: the input + suffix stay inline with
  // the label (matching other NumericOption rows), and the Confirm
  // button drops onto a second line below the control only when dirty
  // or just-saved. Clean, idle state has no visible button — the row
  // reads identically to a plain NumericOption.
  const showButton = dirty || justSaved;
  return (
    <div className="settings-row">
      <div>
        <div className="settings-label">{label}</div>
        {hint && <div className="settings-hint">{hint}</div>}
      </div>
      <div className="settings-control" style={{ flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="number"
            value={draft}
            min={min}
            max={max}
            onChange={(e) => {
              const n = parseInt(e.target.value);
              setDraft(Number.isFinite(n) ? clamp(n) : (min ?? 0));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
            }}
            style={{
              width,
              textAlign: "right",
              // Subtle amber outline when dirty, so users notice the pending state
              // even if they stopped looking at the Confirm button below.
              outline: dirty ? "1px solid #d97706" : undefined,
            }}
          />
          {suffixText && <span className="settings-suffix">{suffixText}</span>}
        </div>
        {showButton && (
          <button
            type="button"
            onClick={commit}
            disabled={!dirty && !justSaved}
            style={{
              padding: "3px 10px",
              background: btnColor.bg,
              color: btnColor.fg,
              border: `1px solid ${btnColor.border}`,
              borderRadius: 4,
              cursor: dirty ? "pointer" : "default",
              fontSize: 11,
              fontWeight: dirty ? 600 : 400,
              whiteSpace: "nowrap",
              transition: "background 150ms, color 150ms, border 150ms",
              minWidth: 76,
            }}
            title={
              dirty
                ? (danger
                    ? "Click to save this risky value. It will take effect on your next dry run or install."
                    : "Click to save. It will take effect on your next dry run or install.")
                : (justSaved ? "Saved to disk" : "No pending changes")
            }
          >
            {btnColor.label}
          </button>
        )}
      </div>
    </div>
  );
}

function TextOption({ value, onChange, label, hint, width, placeholder }: {
  value: string; onChange: (v: string) => void; label: string; hint?: string;
  width?: number; placeholder?: string;
}) {
  return (
    <div className="settings-row">
      <div>
        <div className="settings-label">{label}</div>
        {hint && <div className="settings-hint">{hint}</div>}
      </div>
      <div className="settings-control">
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: width ?? 200 }}
        />
      </div>
    </div>
  );
}

function SelectOption({ value, onChange, label, hint, options, allowCustom, width }: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  hint?: string;
  options: { value: string; label: string }[];
  allowCustom?: boolean;
  width?: number;
}) {
  const knownValues = options.map((o) => o.value);
  const [userPickedCustom, setUserPickedCustom] = useState(false);
  const customMode = !!allowCustom && (userPickedCustom || !knownValues.includes(value));
  return (
    <div className="settings-row">
      <div>
        <div className="settings-label">{label}</div>
        {hint && <div className="settings-hint">{hint}</div>}
      </div>
      <div className="settings-control">
        {customMode ? (
          <>
            <input
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              style={{ width: width ?? 140 }}
              autoFocus
            />
            {allowCustom && (
              <button
                className="btn"
                type="button"
                onClick={() => { setUserPickedCustom(false); onChange(options[0].value); }}
                title="Back to preset list"
                style={{ fontSize: 11, padding: "2px 8px" }}
              >
                {"\u2190"}
              </button>
            )}
          </>
        ) : (
          <select
            value={value}
            onChange={(e) => {
              if (e.target.value === "__custom__") {
                setUserPickedCustom(true);
              } else {
                setUserPickedCustom(false);
                onChange(e.target.value);
              }
            }}
            style={{
              width: width ?? 200,
              background: "var(--bg2)",
              border: "1px solid var(--brd)",
              color: "var(--tx)",
              padding: "4px 8px",
              borderRadius: "var(--radius)",
              fontSize: "var(--fs-base)",
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label} ({o.value})</option>
            ))}
            {allowCustom && <option value="__custom__">Other…</option>}
          </select>
        )}
      </div>
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
  onInstallIssues,
  onGoToTab,
  showPreflightPassedBanner, onDismissPreflightPassedBanner,
}: Props) {
  const { t } = useI18n();
  const [showBackupWarning, setShowBackupWarning] = useState(false);
  // Phase 22: Windows Defender integration. Status read once on mount
  // (ms-scale PowerShell call, cheap enough) and cached for the Advanced
  // checkbox visibility. `showDefenderModal` gates the first-run prompt
  // that fires at Start Install click when all conditions hold.
  const [defenderState, setDefenderState] = useState<DefenderStatus | null>(null);
  const [showDefenderModal, setShowDefenderModal] = useState(false);
  useEffect(() => {
    defenderStatus()
      .then((s) => setDefenderState(s))
      .catch((e) => {
        guiLog.warn("DEFENDER", `status query failed: ${e}`);
        setDefenderState("unknown");
      });
  }, []);
  const updateOption = (key: string, value: boolean | number) => {
    onSaveConfig({ ...config, [key]: value });
  };

  // ── Install-settings persistence (Phase 18) ──
  //
  // Three user-facing actions, each with a different semantic meaning:
  //
  //   1. "Save my preferences"     — snapshots current install-tab options
  //                                  into config.saved_install_defaults.
  //                                  Survives restart via confy TOML write.
  //   2. "Restore my preferences"  — applies the saved snapshot back.
  //                                  Disabled when no snapshot exists.
  //   3. "Reset to program defaults" — reverts options to conservative
  //                                  factory values (the constants below).
  //                                  Destructive; confirmation modal gates.
  //
  // Historical note: v1.0.0-beta stored the snapshot in localStorage, which
  // WebView2 silently wiped under some profile states ("I saved my settings
  // but they came back as defaults after restart"). Moving to AppConfig
  // fixes that — confy writes a TOML file on every saveConfig and reads it
  // on boot, same path every other setting already uses. Migration of any
  // legacy localStorage snapshot happens in App.tsx init() post-TOML-load.
  const [prefsToast, setPrefsToast] = useState<string | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Keys that participate in the "preferences" snapshot. MUST cover every
  // user-visible install-tab option — missing entries cause a
  // "Restore my preferences" to silently leave them untouched, so a user
  // who e.g. saved heavy_batch_size=10 could end up with the program
  // default (3) after restore with no visible indication anything was
  // missed. Stays in sync with the settings UI rendered further below.
  const INSTALL_OPTION_KEYS = [
    "skip_installed", "never_abort", "abort_on_warnings", "auto_skip_after_retry",
    "bcs_scanner", "pause_on_guard", "suppress_readmes",
    "timeout", "max_batch_size", "heavy_batch_size",
    "override_fast_drive", "override_fast_drive_path",
    "language", "language_fallback", "weidu_log_mode",
  ] as const;

  // Conservative program defaults — the "factory settings" that
  // "Reset to program defaults" restores to. Sourced from the same
  // constants module that feeds defaultConfig in App.tsx, so these
  // stay in sync with the initial-state values a brand-new user sees
  // before they've touched anything. Bool defaults match Tauri's
  // Default derive, which matches a fresh App.tsx defaultConfig.
  const PROGRAM_INSTALL_DEFAULTS: Partial<AppConfig> = {
    skip_installed: true,
    never_abort: false,
    abort_on_warnings: false,
    auto_skip_after_retry: false,
    bcs_scanner: false,
    pause_on_guard: false,
    suppress_readmes: true,
    timeout: DEFAULT_INSTALL_TIMEOUT_S,
    max_batch_size: DEFAULT_MAX_BATCH,
    heavy_batch_size: DEFAULT_HEAVY_BATCH,
    override_fast_drive: false,
    override_fast_drive_path: "",
    language: DEFAULT_WEIDU_LANGUAGE,
    language_fallback: DEFAULT_WEIDU_LANGUAGE,
    weidu_log_mode: DEFAULT_WEIDU_LOG_MODE,
  };

  // Note: the v1.0.0-beta → v1.0.2+ localStorage-to-config migration
  // is performed in App.tsx's init() (after TOML load, before splash
  // completes). Doing it there avoids a race where this component
  // could mount with the default-config prop during splash and
  // accidentally overwrite the still-loading TOML state.

  const hasSavedPreferences = !!config.saved_install_defaults;

  const flashToast = useCallback((msg: string) => {
    setPrefsToast(msg);
    setTimeout(() => setPrefsToast(null), 2000);
  }, []);

  const savePreferences = useCallback(() => {
    const snapshot: Record<string, unknown> = {};
    for (const k of INSTALL_OPTION_KEYS) snapshot[k] = (config as unknown as Record<string, unknown>)[k];
    onSaveConfig({ ...config, saved_install_defaults: JSON.stringify(snapshot) });
    flashToast(t("install.prefs_saved", "Preferences saved"));
    guiLog.info("UI", "Install preferences saved to config");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, t, onSaveConfig, flashToast]);

  const restorePreferences = useCallback(() => {
    if (!config.saved_install_defaults) return;
    try {
      const snapshot = JSON.parse(config.saved_install_defaults) as Record<string, unknown>;
      onSaveConfig({ ...config, ...snapshot });
      flashToast(t("install.prefs_restored", "Preferences restored"));
      guiLog.info("UI", "Install preferences restored from config");
    } catch (e) {
      guiLog.warn("UI", `Failed to parse saved preferences: ${e}`);
      flashToast(t("install.prefs_parse_error", "Saved preferences were corrupted \u2014 could not restore"));
    }
  }, [config, onSaveConfig, t, flashToast]);

  const resetToProgramDefaults = useCallback(() => {
    onSaveConfig({ ...config, ...PROGRAM_INSTALL_DEFAULTS });
    flashToast(t("install.prefs_reset_done", "Reset to program defaults"));
    guiLog.info("UI", "Install options reset to program defaults");
    setShowResetConfirm(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, onSaveConfig, t, flashToast]);
  // Stdout/stderr log — ring buffer in ref, periodic flush to state for rendering.
  //
  // Buffer size is a dynamic ref, not a const, because dry runs and real
  // installs want different caps:
  //   - Install: 500 is plenty (an SFO burst can spew 10k+ identical lines;
  //     truncation is fine because the Issues panel + debug log are the
  //     sources of truth for post-mortem).
  //   - Dry run: the plan printout IS the primary artifact — the user is
  //     reading it end-to-end to validate what would happen. Capping to 500
  //     would silently drop the middle of a 2–5k-line plan. We go effectively
  //     unlimited (1,000,000) during a dry run and restore 500 for installs.
  // A paired state drives the "earlier lines not shown" banner so the
  // render path re-evaluates when the cap changes.
  const INSTALL_LOG_BUFFER_SIZE = 500;
  const DRY_RUN_LOG_BUFFER_SIZE = 1_000_000;
  const logBufferSizeRef = useRef(INSTALL_LOG_BUFFER_SIZE);
  const [logBufferSize, setLogBufferSize] = useState(INSTALL_LOG_BUFFER_SIZE);
  const logBuffer = useRef<LogLine[]>([]);   // Circular buffer of last N lines
  const logTotalCount = useRef(0);           // Total lines received (never shrinks)
  const pendingLines = useRef<LogLine[]>([]); // Lines waiting to be flushed
  const [displayLines, setDisplayLines] = useState<LogLine[]>([]);
  const [totalLineCount, setTotalLineCount] = useState(0);
  const [logExpanded, setLogExpanded] = useState(false);
  const logExpandedRef = useRef(false);
  logExpandedRef.current = logExpanded;
  // Log panel height — driven by the Forge-styled drag handle, not native CSS resize.
  const [logHeight, setLogHeight] = useState(350);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Issue panel filters. Empty set = show all (default). Click a filter chip
  // to add/remove its level from the active set.
  const [issueFilters, setIssueFilters] = useState<Set<"ERROR" | "WARN" | "SKIP" | "RETRY">>(new Set());
  const toggleIssueFilter = useCallback((level: "ERROR" | "WARN" | "SKIP" | "RETRY") => {
    setIssueFilters((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level); else next.add(level);
      return next;
    });
  }, []);
  // Issue panel sort order. Default "newest" matches mid-install UX — a
  // user watching a running 12h install wants "what just happened" at the
  // top, not the first warning from hour 1 that they've already seen.
  // "severity" is the old default, available via toggle for post-mortem.
  const [issueSortMode, setIssueSortMode] = useState<IssueSortMode>("newest");
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mod display name lookup (tp2 name → Forge display name)
  const modDisplayNames = useRef<Map<string, string>>(new Map());

  // Live install status per component — key is "mod_name:component"
  const installStatusRef = useRef<InstallStatusMap>(new Map());
  // Per-component issue detail — only populated for err/warn/skip results.
  const installIssuesRef = useRef<InstallIssueMap>(new Map());

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

  // Fetch the global known-issue catalog on mount. The Issues panel uses it
  // to classify raw WARNING lines shipped by the Rust runner so users see
  // "7 warnings · 6 cosmetic · 1 unknown" instead of an undifferentiated
  // "7 warnings" badge. Per-mod `ki` patterns would go here too in a later
  // iteration — for the first trial we rely only on the global catalog
  // (36 patterns covering TRA tags, kit shuffle, IDS collisions, etc.).
  // Failure degrades to "unknown" for every warning, which is the pre-
  // feature UX — safe fallback.
  useEffect(() => {
    const baseUrl = config.forge_data_url || DEFAULT_FORGE_URL;
    fetchKnownIssues(baseUrl)
      .then((issues) => setKnownIssueCatalog(issues))
      .catch((e) => {
        // Non-fatal; Issues panel falls back to unclassified rendering.
        if (typeof console !== "undefined") {
          console.warn("InstallRunner: fetchKnownIssues failed:", e);
        }
        setKnownIssueCatalog([]);
      });
  }, [config.forge_data_url]);

  // Event-based progress (native installer — no file polling)
  const [currentMod, setCurrentMod] = useState<string>(""); // Display name (or tp2 fallback)
  const [currentModTp2, setCurrentModTp2] = useState<string>(""); // Always the tp2 name
  const [currentComponent, setCurrentComponent] = useState<string>("");
  /** Slow-batch indicator state — rendered as a badge next to currentMod.
   * Null when no batch is slow. Populated by the watchdog interval once
   * the active batch crosses 5 min. `health` categorizes what WeiDU is
   * doing right now; `cascade` is true once a throughput drop is detected. */
  const [slowBatchUi, setSlowBatchUi] = useState<null | {
    elapsedMin: number;
    health: "progressing" | "stalled" | "quiet" | "scanning";
    stdoutAgeS: number | null;
    lastLine: string;
    cascade: boolean;
    /** Mod name, surfaced so the badge copy can reference it. */
    modName: string;
    /** Plain-English explanation from the backend when this batch contains
     * a known-slow component (e.g. dw_talents cn:60200). Present => show
     * "this is expected, don't abort" copy instead of the generic slow tip.
     * Null/undefined for every other slow batch. */
    knownSlowReason?: string | null;
  }>(null);

  /** Most recent BCS buffer-cache stats line parsed from WeiDU stderr at
   *  batch exit. Powers the per-batch hit-rate badge next to currentMod.
   *  Null until the first batch emits a stats line; holds the last seen
   *  sample afterward so the badge shows "last batch's hit rate" until
   *  overwritten by the next one. */
  const [bcsCacheCurrent, setBcsCacheCurrent] = useState<null | {
    batchIdx: number;
    modName: string;
    enabled: boolean;
    hits: number;
    misses: number;
    hitRatePct: number;
    evictions: number;
    peakKb: number;
    currentKb: number;
    maxMb: number;
  }>(null);

  /** History of every BCS cache stats line seen during this install. Used
   *  to compute the post-install aggregate card (total hits, peak memory,
   *  worst hit-rate batch). Entries are appended in batch order; a single
   *  batch can only emit once because at_exit runs once per WeiDU process. */
  const bcsCacheHistoryRef = useRef<Array<{
    batchIdx: number;
    modName: string;
    enabled: boolean;
    hits: number;
    misses: number;
    hitRatePct: number;
    evictions: number;
    peakKb: number;
    currentKb: number;
    maxMb: number;
  }>>([]);
  const [bcsCacheHistoryCount, setBcsCacheHistoryCount] = useState(0);

  /** Mods with legitimate long silent phases (big REGEXP scans over all CRE/
   *  BCS/DLG, PHP_EACH over thousands of entries, SFO library processing).
   *  Their quiet periods are expected behavior, not hangs — map "stalled" →
   *  "scanning" so the UI doesn't cry wolf. Lowercase mod-folder name match.
   *
   *  Criteria to add a mod here:
   *   1. Observed repeatedly going 5+ min with no stdout during normal install
   *   2. Verified (via debug log review) to actually be producing work, not hung
   *   3. User confirmation that this is known-slow-but-healthy behavior
   */
  const KNOWN_SLOW_SCANNERS = new Set<string>([
    "mih_eq",        // full CRE iteration across 7 monster-revision components (corporal, dragons, golems, liches, lycanthropes, magical beasts, spiders, slimes, vampires)
    "mih_ip",        // sibling of mih_eq, item revisions across ~4000 ITMs
    "dw_talents",    // SFO disjunctive_substitution on all DLG/BCS — can go silent during DECOMPILE_AND_PATCH on Brandock's 1.17MB c#brandj.dlg
    "stratagems",    // SCS AI-overhaul components (cn:6000 "Smarter general AI" especially) iterate every script in the game
    "ascension",     // ToB final-chapter overhaul does large CRE/ARE scans
  ]);
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

  // Global known-issue catalog — fetched once on install start so the Issues
  // panel can classify raw WARNING lines shipped by the Rust runner (per-
  // component `warnings: string[]`) into cosmetic/likely-benign/caution/
  // concerning/unknown categories. Null until fetched; empty array if the
  // fetch fails (classification silently degrades to "unknown" for every
  // line, which is fine — it's the same UX as before the feature existed).
  const [knownIssueCatalog, setKnownIssueCatalog] = useState<KnownIssue[] | null>(null);

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
  // Accumulated time (ms) spent in the Paused state across all pauses this
  // session. Subtracted from `(now - startTime)` so the visible elapsed
  // counter freezes during pauses — otherwise the user sees install-time
  // that wasn't actually doing work, which throws off ETA sanity checks.
  const pausedDurationRef = useRef<number>(0);
  // Wall-clock timestamp the current pause started (0 when not paused).
  // Cleared on resume after folding the delta into pausedDurationRef.
  const pauseStartedAtRef = useRef<number>(0);
  // Rolling window of (timestamp_ms, componentCount) samples for throughput calculation
  const throughputSamples = useRef<{ t: number; n: number }[]>([]);
  const [eta, setEta] = useState<string | null>(null);
  /** Exponentially-weighted smoothed rate (components/sec). Dampens the
   * spikes the raw-windowed rate produces when the install crosses heavy-mod
   * boundaries. Seeded on first stable sample, then updated each tick. */
  const smoothedRateRef = useRef<number | null>(null);

  // ── Baseline-driven ETA (Phase 7c) ──
  //
  // The rate-based algorithm (above) treats every component as equivalent.
  // When Forge has per-component `installProfile` data, we replace the
  // linear extrapolation with a workload sum: Σ(baseline × discount) over
  // remaining components. The EWMA smooths a "reality factor" — how much
  // slower/faster this rig is than the reference rig — so the estimate
  // adapts to hardware without per-user configuration.
  //
  // Falls back to the rate-based algorithm when profile data is missing
  // or insufficient (< 50% of the remaining plan has baselines).
  const [profileMap, setProfileMap] = useState<InstallProfileMap>(new Map());
  const [acceleratorCoeffs, setAcceleratorCoeffs] = useState<AcceleratorCoefficients>(
    FALLBACK_ACCELERATOR_COEFFICIENTS,
  );
  /** Per-component expected duration AFTER accelerator discount, keyed
   * `"modname:cn"`. Computed once per install start from the parsedLog +
   * profileMap + current config; read on every ETA tick. */
  const componentExpectedSecRef = useRef<Map<string, number>>(new Map());
  /** Sum of expected durations over the full plan. Used to blend the
   * baseline-driven estimate with rate-based fallback. */
  const totalExpectedSecRef = useRef<number>(0);
  /** EWMA of "reality factor" = actual_elapsed / expected_elapsed. Captures
   * rig differences from the reference. Seeded at 1.0 so early install
   * ticks don't over-extrapolate. */
  const realityFactorRef = useRef<number>(1.0);

  // ── Measurement trace (Phase 7d) ──
  // Records per-component wall-clock time while the install runs so users
  // (and later: telemetry) can contribute baselines back to Forge. Lives
  // in a ref so it doesn't trigger re-renders on every batch; the
  // post-install card reads entryCount via a state mirror.
  const traceRecorderRef = useRef<TraceRecorder>(new TraceRecorder());
  const [traceEntryCount, setTraceEntryCount] = useState(0);
  const [lastTrace, setLastTrace] = useState<InstallTrace | null>(null);

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


  // Elapsed time counter.
  //
  // Freezes while the install is paused by subtracting `pausedDurationRef`
  // (total paused ms) plus any open pause delta. This keeps the visible
  // counter aligned with actual work time, so ETA and per-batch rate math
  // don't get polluted by the user sipping coffee.
  useEffect(() => {
    if (!running || !startTime) return;
    const interval = setInterval(() => {
      const now = Date.now();
      const openPause = pauseStartedAtRef.current > 0
        ? now - pauseStartedAtRef.current
        : 0;
      setElapsed(now - startTime - pausedDurationRef.current - openPause);
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

  // Recompute expected-duration map when profile data or accelerator
  // coefficients change (they're fetched async during install start).
  useEffect(() => {
    if (!running || !parsedLog) return;
    const map = new Map<string, number>();
    let total = 0;
    const cfg = {
      overrideFastDrive: !!config.override_fast_drive,
      experimentalWeidu: !!config.use_experimental_weidu,
      batchSize: config.max_batch_size ?? 25,
    };
    const allEntries = [
      ...(parsedLog.bgeeEntries ?? []),
      ...parsedLog.entries,
    ];
    for (const e of allEntries) {
      const key = `${e.mod_name}:${e.component}`;
      const profileKey = `${e.mod_name.toLowerCase()}:${parseInt(e.component, 10)}`;
      const profile = profileMap.get(profileKey);
      const cls: HeavyClass = profile?.heavyClass ?? inferHeavyClass(e.mod_name);
      const base = profile?.baselineSec ?? CLASS_DEFAULT_BASELINE_SEC[cls];
      const sec = base * discountCoefficient(cfg, cls, acceleratorCoeffs);
      map.set(key, sec);
      total += sec;
    }
    componentExpectedSecRef.current = map;
    totalExpectedSecRef.current = total;
  }, [profileMap, acceleratorCoeffs, running, parsedLog, config.override_fast_drive, config.use_experimental_weidu, config.max_batch_size]);

  // ETA calculation driven by progressCurrent changes.
  //
  // Strategy:
  //   1. If we have expected-duration data for at least half the remaining
  //      components, use the BASELINE-SUM algorithm:
  //        - expectedElapsedSec = Σ(expected[done components])
  //        - realityFactor = elapsedSec / expectedElapsedSec (EWMA-smoothed)
  //        - etaSec = Σ(expected[remaining components]) × realityFactor
  //      This treats each remaining component by its actual cost, and the
  //      reality factor implicitly adapts to rig speed. A slow rig produces
  //      factor > 1; a fast rig produces factor < 1.
  //   2. Otherwise fall back to the rate-based algorithm (keeps working for
  //      ad-hoc mod lists Forge hasn't profiled).
  //   3. Both paths: EWMA-smooth, freeze on slow-batch cascade, bucket the
  //      display.
  useEffect(() => {
    if (!running || progressTotal === 0) return;
    const now = Date.now();
    throughputSamples.current.push({ t: now, n: progressCurrent });
    const WINDOW_MS = 5 * 60 * 1000;
    throughputSamples.current = throughputSamples.current.filter((s) => now - s.t < WINDOW_MS);

    // Freeze during slow cascade — keep the last-emitted ETA visible.
    if (slowBatchUi?.cascade) return;

    const elapsedSec = (now - startTime) / 1000;
    if (elapsedSec < 30) return; // wait for signal to stabilize

    // Compute done/remaining expected seconds from the ref map.
    const expectedMap = componentExpectedSecRef.current;
    let expectedDoneSec = 0;
    let expectedRemainingSec = 0;
    let coveredTotal = 0;
    let coveredRemaining = 0;
    const status = installStatusRef.current;
    for (const [key, sec] of expectedMap) {
      coveredTotal++;
      if (status.has(key)) {
        expectedDoneSec += sec;
      } else {
        expectedRemainingSec += sec;
        coveredRemaining++;
      }
    }

    // Use baseline algorithm when we have expected data AND at least some
    // progress to calibrate the reality factor.
    const useBaseline =
      coveredTotal > 0 && expectedDoneSec > 0 && coveredRemaining > 0;

    let etaSec: number | null = null;
    if (useBaseline) {
      const rawFactor = elapsedSec / expectedDoneSec;
      const ALPHA = 0.15;
      // Re-seed the factor the first time we have a valid measurement.
      // 1.0 is the initial seed from startInstall; if it was never touched,
      // blend from rawFactor directly.
      realityFactorRef.current =
        realityFactorRef.current === 1.0
          ? rawFactor
          : ALPHA * rawFactor + (1 - ALPHA) * realityFactorRef.current;
      // Clamp the factor so a single absurd sample can't send ETA wild.
      const factor = Math.max(0.1, Math.min(10, realityFactorRef.current));
      etaSec = expectedRemainingSec * factor;
    } else if (throughputSamples.current.length >= 2) {
      // Rate-based fallback.
      const oldest = throughputSamples.current[0];
      const windowSec = (now - oldest.t) / 1000;
      const done = progressCurrent - oldest.n;
      if (windowSec >= 30 && done > 0) {
        const rawRate = done / windowSec;
        if (smoothedRateRef.current === null) {
          smoothedRateRef.current = rawRate;
        } else {
          const ALPHA = 0.15;
          smoothedRateRef.current =
            ALPHA * rawRate + (1 - ALPHA) * smoothedRateRef.current;
        }
        const remaining = progressTotal - progressCurrent;
        etaSec = remaining / smoothedRateRef.current;
      }
    }

    if (etaSec !== null && etaSec > 0 && etaSec < 86400) {
      setEta(formatEtaBucketed(etaSec));
    }
  }, [progressCurrent, progressTotal, running, slowBatchUi?.cascade, startTime]);

  // No polling — native installer uses direct Tauri events

  const addLine = useCallback(
    (text: string, type: LogLine["type"] = "stdout") => {
      logTotalCount.current++;

      // Dedupe consecutive identical lines at INGESTION, not at render. The
      // render-time grouping further down only saw entries inside the 500-
      // line ring buffer, so a stream of 10k identical "Copying and patching
      // 1 file ..." lines capped the visible count at 500 even as the total
      // stream kept climbing. Here we instead peek the tail of pending (or
      // the buffer if pending is empty) and bump its `count` field rather
      // than appending a duplicate row.
      const pendingTail = pendingLines.current[pendingLines.current.length - 1];
      const bufferTail = logBuffer.current[logBuffer.current.length - 1];
      // pending > buffer: if there's ANY pending, the tail is always from
      // pending (buffer hasn't been touched since last flush). Only fall
      // through to buffer when pending is empty (nothing since last flush).
      const tail = pendingTail ?? bufferTail;

      if (tail && tail.text === text && tail.type === type) {
        tail.count = (tail.count ?? 1) + 1;
        // Fall through to schedule a flush so the updated count reaches the
        // display even when no NEW line is being pushed.
      } else {
        pendingLines.current.push({ text, type });
      }

      // Throttle state updates — flush every 250ms
      if (!flushTimer.current) {
        flushTimer.current = setTimeout(() => {
          flushTimer.current = null;
          // Move pending lines into the ring buffer
          const pending = pendingLines.current;
          pendingLines.current = [];

          // Read the live cap via ref so a dry run that raises the cap mid-run
          // takes effect immediately without waiting for callback re-creation.
          const cap = logBufferSizeRef.current;
          if (pending.length >= cap) {
            // If we got more than the buffer size in one batch, just keep the tail
            logBuffer.current = pending.slice(-cap);
          } else {
            // Append and trim
            logBuffer.current.push(...pending);
            if (logBuffer.current.length > cap) {
              logBuffer.current = logBuffer.current.slice(-cap);
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

  // Phase 22: gated Start-Install flow that threads through the Defender
  // prompt (if applicable) and the backup-warning modal before kicking
  // off the actual install. Modal-resolve paths call back here via
  // `proceedAfterDefender`, which continues from the backup-check step.
  const proceedAfterDefender = useCallback(() => {
    if (!backupExists) { setShowBackupWarning(true); return; }
    startInstall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backupExists]);

  /** Entry point for the Start Installation button. Decides whether to
   * show the Defender modal, apply the exclusion silently, or pass
   * straight through to the backup-check + install start. */
  const attemptStart = useCallback(async () => {
    if (running) return;
    onDismissPreflightPassedBanner?.();

    // Skip every Defender-related step on non-Windows platforms.
    const applicable = defenderState === "active" && !!config.bg2_game_dir && !config.override_fast_drive;

    // First-run prompt: modal pops only when Defender is active, the
    // user hasn't opted in AND hasn't dismissed the prompt AND the
    // exclusion isn't already in place.
    if (
      applicable
      && !config.auto_defender_exclusion
      && !config.defender_prompt_dismissed
      && config.bg2_game_dir
    ) {
      try {
        const excluded = await defenderIsPathExcluded(config.bg2_game_dir);
        if (!excluded) {
          setShowDefenderModal(true);
          return;
        }
      } catch (e) {
        // is_path_excluded failure is non-fatal; treat as "can't
        // determine, don't prompt" and fall through to the opt-in
        // checkbox path if any.
        guiLog.warn("DEFENDER", `is_path_excluded failed: ${e}`);
      }
    }

    // Silent-opt-in path: user already has auto_defender_exclusion on
    // (set via modal or Advanced checkbox). Apply the exclusion at
    // install start. On first call this fires UAC; on subsequent
    // installs the Rust-side `is_path_excluded` short-circuit makes
    // it a no-op.
    if (applicable && config.auto_defender_exclusion && config.bg2_game_dir) {
      try {
        const ok = await defenderAddExclusion(config.bg2_game_dir);
        guiLog.info("DEFENDER", `Pre-install exclusion check for ${config.bg2_game_dir}: ${ok ? "in place" : "not applied (UAC cancelled or failed)"}`);
      } catch (e) {
        // A failure here shouldn't block the install — exclusion is a
        // perf optimization. Log and proceed.
        guiLog.warn("DEFENDER", `pre-install add_exclusion failed: ${e}`);
      }
    }

    proceedAfterDefender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    running,
    onDismissPreflightPassedBanner,
    defenderState,
    config.bg2_game_dir,
    config.override_fast_drive,
    config.auto_defender_exclusion,
    config.defender_prompt_dismissed,
    proceedAfterDefender,
  ]);

  /** Resolve callback from DefenderModal. Applies config changes per
   * the resolution kind and then continues the install flow. */
  const onDefenderResolve = useCallback((result: DefenderModalResolution) => {
    setShowDefenderModal(false);
    if (result.kind === "add" && result.succeeded) {
      // User opted in AND UAC succeeded — flip the Advanced-tab
      // checkbox so future installs don't re-prompt and the Rust-side
      // is_path_excluded fast-path kicks in.
      onSaveConfig({ ...config, auto_defender_exclusion: true });
    } else if (result.kind === "never") {
      onSaveConfig({ ...config, defender_prompt_dismissed: true });
    }
    // "skip" or UAC-cancelled "add": no config changes. Modal will
    // re-appear on the next install for "skip"; sticky-dismissed for
    // "never". Proceed with the install either way.
    proceedAfterDefender();
  }, [config, onSaveConfig, proceedAfterDefender]);

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
    // Restore the install-time cap in case the user previously ran a dry
    // run that raised it to effectively-unlimited.
    logBufferSizeRef.current = INSTALL_LOG_BUFFER_SIZE;
    setLogBufferSize(INSTALL_LOG_BUFFER_SIZE);
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
    installIssuesRef.current = new Map();
    if (onInstallIssues) onInstallIssues(new Map());
    setBatchError(null);
    setErrorEntries([]);
    errorEntriesRef.current = [];
    setAbortPending(false);
    setWasAborted(false);
    if (errorFlushTimer.current) { clearTimeout(errorFlushTimer.current); errorFlushTimer.current = null; }
    setLogExpanded(false);
    setLogStickToBottom(true);
    throughputSamples.current = [];
    smoothedRateRef.current = null;
    realityFactorRef.current = 1.0;
    traceRecorderRef.current.start();
    setTraceEntryCount(0);
    setLastTrace(null);
    // Reset BCS cache telemetry — prior run's hits/misses shouldn't bleed
    // into this run's badge or post-install aggregate card.
    bcsCacheHistoryRef.current = [];
    setBcsCacheHistoryCount(0);
    setBcsCacheCurrent(null);
    // Precompute per-component expected duration from whatever profile data
    // we already have. The fetch kicks off in parallel below and overwrites
    // this when it lands — if the install finishes before the fetch, we
    // just ran on class-default estimates (which is still better than the
    // pure rate-based algorithm).
    {
      const map = new Map<string, number>();
      let total = 0;
      const cfg = {
        overrideFastDrive: !!config.override_fast_drive,
        experimentalWeidu: !!config.use_experimental_weidu,
        batchSize: config.max_batch_size ?? 25,
      };
      const allEntries = [
        ...(parsedLog?.bgeeEntries ?? []),
        ...(parsedLog?.entries ?? []),
      ];
      for (const e of allEntries) {
        const key = `${e.mod_name}:${e.component}`;
        const profileKey = `${e.mod_name.toLowerCase()}:${parseInt(e.component, 10)}`;
        const profile = profileMap.get(profileKey);
        const cls: HeavyClass = profile?.heavyClass ?? inferHeavyClass(e.mod_name);
        const base = profile?.baselineSec ?? CLASS_DEFAULT_BASELINE_SEC[cls];
        const sec = base * discountCoefficient(cfg, cls, acceleratorCoeffs);
        map.set(key, sec);
        total += sec;
      }
      componentExpectedSecRef.current = map;
      totalExpectedSecRef.current = total;
      guiLog.info(
        "INSTALL",
        `ETA: precomputed expected durations for ${map.size} components, total ${Math.round(total)}s`,
      );
    }
    // Kick off Forge fetch for install profiles + accelerator coefficients.
    // These may land after the install has already started — that's fine;
    // the next tick of the ETA effect will pick up the updated data.
    {
      const baseUrl = config.forge_data_url || DEFAULT_FORGE_URL;
      const modNames = Array.from(
        new Set(
          [
            ...(parsedLog?.bgeeEntries ?? []),
            ...(parsedLog?.entries ?? []),
          ].map((e) => e.mod_name),
        ),
      );
      Promise.all([
        fetchInstallProfiles(baseUrl, modNames).catch(() => new Map() as InstallProfileMap),
        fetchAcceleratorCoefficients(baseUrl).catch(() => FALLBACK_ACCELERATOR_COEFFICIENTS),
      ]).then(([pm, coeffs]) => {
        setProfileMap(pm);
        setAcceleratorCoeffs(coeffs);
        guiLog.info(
          "INSTALL",
          `ETA: loaded ${pm.size} install profiles + accelerator coefficients from Forge`,
        );
      });
    }
    setEta(null);
    setStartTime(Date.now());
    setElapsed(0);
    // Reset pause-time accumulator — any paused duration from a previous
    // install run would otherwise subtract from the new install's clock.
    pausedDurationRef.current = 0;
    pauseStartedAtRef.current = 0;
    onRunningChange(true);

    addLine("[Infinity Mod Runner] Starting native install (direct WeiDU)...", "system");

    // Resolve the actual WeiDU binary path BEFORE starting the session so the
    // `weidu=` tail in the "Install started" log reflects reality. If the user
    // has experimental Resilient WeiDU enabled we want the cache-path binary's
    // version in the log, not the configured-path version we pre-loaded on
    // app start. The same resolved path is reused below for installArgs.
    let resolvedWeiduPath: string;
    let sessionWeiduVersion = weiduVersion;
    try {
      resolvedWeiduPath = await weiduSwapResolvePath(
        config.weidu_path!,
        !!config.use_experimental_weidu,
        config.data_directory ?? null,
      );
      if (config.use_experimental_weidu && resolvedWeiduPath !== config.weidu_path) {
        // Experimental is on — fetch the actual version of the bundled binary
        // so the gui.log tail reads `weidu="[<cache_path>] WeiDU version ..."`
        // and matches what's really running. Non-fatal on failure; we fall back
        // to the pre-loaded version (which is still informational).
        try {
          const v = await getBinaryVersion(resolvedWeiduPath);
          if (v) sessionWeiduVersion = v;
        } catch {}
        addLine(
          `[Infinity Mod Runner] Using experimental Resilient WeiDU: ${resolvedWeiduPath}`,
          "system",
        );
        guiLog.info("EXPERIMENTAL", `Install will use patched WeiDU at ${resolvedWeiduPath}`);
      }
    } catch (e) {
      const errMsg = String(e);
      addLine(`[Infinity Mod Runner] Could not resolve WeiDU path: ${errMsg}`, "system");
      guiLog.error("INSTALL", `Failed to resolve WeiDU path: ${errMsg}`);
      setStartError(errMsg);
      setLogExpanded(true);
      onRunningChange(false);
      return;
    }

    // Start a new install session. Batch count is unknown until the backend reports
    // it; we pass 0 and update on the first batch_start event.
    startInstallSession(parsedLog?.componentCount || 0, 0, sessionWeiduVersion);
    // Log the effective batch sizes. We historically had a case where a user
    // set heavy_batch_size=10 in the UI, the setting never reached the
    // installer (legacy defaults-snapshot bug + silent save_config failure),
    // and the install quietly ran with heavy=3 — costing 37 extra minutes on
    // dw_talents alone. Logging the resolved values makes this class of
    // bug immediately visible in post-install diagnostics.
    const sessEff = getInstallSession();
    guiLog.info("INSTALL", withTail(
      `Batch sizes: normal=${config.max_batch_size ?? 25}, heavy=${config.heavy_batch_size ?? 3} (heavy applies to dw_talents, stratagems, mih_*, trap_overhaul)`,
      { session: sessEff?.id }
    ));
    // Performance-lever diagnostic: log BIFF-delete + fast-drive flag
    // states alongside batch sizes so install.log captures the full
    // performance picture at T+0. analyze_install_log.py's PERF_LEVERS_RE
    // keys on this exact format; field order is pinned. Post-mortem
    // analysis can tell which A/B variant actually ran without
    // cross-referencing the config.
    const biffDelete = (config as unknown as { enable_biff_delete_optimization?: boolean }).enable_biff_delete_optimization;
    const fastDrive = config.override_fast_drive;
    guiLog.info("INSTALL", withTail(
      `Performance levers: biff_delete=${biffDelete ? "on" : "off"}, override_fast_drive=${fastDrive ? "on" : "off"}` +
        (fastDrive && config.override_fast_drive_path
          ? ` (target: ${config.override_fast_drive_path.trim() || "system temp"})`
          : ""),
      { session: sessEff?.id }
    ));
    // Hard warning when fast_drive is OFF and the install contains SFO-
    // heavy mods — this is the single biggest lever for wall-clock, and
    // users who skip it routinely end up 4-5h into dw_talents cn:60200
    // wondering why. Emit as a WARN line so it sorts up in the issues
    // panel and is hard to miss, AND echo to the stdout pane so the user
    // sees it during install not just in scrollback.
    const sfoHeavyNames = ["dw_talents", "stratagems", "mih_tweaks"];
    const sfoHeavyPresent = parsedLog?.entries
      ? sfoHeavyNames.filter((name) =>
          parsedLog.entries.some((e) => e.mod_name.toLowerCase() === name)
        )
      : [];
    if (!fastDrive && sfoHeavyPresent.length > 0) {
      guiLog.warn("INSTALL", withTail(
        `override_fast_drive is OFF but the install includes ${sfoHeavyPresent.join(", ")} — ` +
          `expect ~4-5h on dw_talents cn:60200 alone (130k write ops \u00d7 ~25ms/op with NTFS+Defender). ` +
          `To cut that to ~10-20min: Install tab \u2192 Performance & advanced \u2192 enable "Redirect override/ to fast drive" \u2192 point at a RAM disk (e.g. R:\\). ` +
          `Alternatively, accept the one-time Defender-exclusion UAC prompt for ~2-5\u00d7 speedup without a RAM disk.`,
        { session: sessEff?.id }
      ));
      addLine(
        `[Infinity Mod Runner] \u26a0 Performance warning: override_fast_drive is OFF. ` +
          `With ${sfoHeavyPresent.join(", ")} in the plan, expect 4-5h on dw_talents cn:60200. ` +
          `Enable fast-drive in Advanced Options + point at a RAM disk, or accept the Defender-exclusion UAC prompt for a lesser speedup.`,
        "system"
      );
    }

    // Build log paths (filter if components excluded)
    let eetLogFile = parsedLog.eetLogPath || null;
    let bgeeLogFile = parsedLog.bgeeLogPath || null;
    if (excludedComponents && excludedComponents.size > 0) {
      try {
        if (parsedLog.raw) {
          const filtered = filterLogText(parsedLog.raw, excludedComponents);
          eetLogFile = await writeTempLog(filtered, "WeiDU-filtered.log");
          addLine(`[Infinity Mod Runner] Filtered EET log (${excludedComponents.size} components excluded)`, "system");
        }
        if (parsedLog.bgeeRaw) {
          const filtered = filterLogText(parsedLog.bgeeRaw, excludedComponents);
          bgeeLogFile = await writeTempLog(filtered, "WeiDU-BGEE-filtered.log");
        }
      } catch (e) {
        addLine(`[Infinity Mod Runner] Filter failed: ${e}. Using original logs.`, "system");
      }
    }

    if (!eetLogFile) {
      addLine("[ERROR] No EET log path available", "system");
      onRunningChange(false);
      return;
    }

    // ── Slow-batch watchdog state ──
    // Tracks the currently-running batch's start time, the last WeiDU stdout
    // line seen (and when), and which warning thresholds have already fired.
    // We emit escalating WARN entries to gui.log at 10/30/60 minute marks so
    // the user can tell whether WeiDU is genuinely progressing, silently
    // stuck, or looping. The last-stdout snippet is the key signal — if it's
    // changing the batch is working; if it's stale AND old, WeiDU is hung.
    const slowBatch = {
      batchIdx: -1 as number,
      modName: "" as string,
      modTp2: "" as string,
      totalBatches: 0 as number,
      startedAt: 0 as number,
      lastStdoutAt: 0 as number,
      lastStdoutLine: "" as string,
      lastStdoutCount: 0 as number,   // lines seen this batch
      firedThresholds: new Set<number>(),
      /** Throughput samples taken at each threshold fire, used to detect the
       * SFO memory-pressure cascade where per-minute line rate falls across
       * successive threshold windows. Each sample is { atMs, totalLines }; the
       * rate between adjacent samples is inferred at comparison time. */
      rateSamples: [] as { atMs: number; totalLines: number }[],
      /** Once true, the cascade has been flagged in a log line and on the UI
       * badge — don't re-flag every subsequent threshold. */
      cascadeFlagged: false,
      /** True once we've pushed any state to `slowBatchUi`. Gates the "clear
       * UI on batch_done" call so we don't churn state for fast batches. */
      uiShown: false,
      /** When the batch contains a known-slow component (e.g. dw_talents
       * cn:60200 Revised HLAs), the backend sends a plain-English reason via
       * the `known_slow_reason` field on `install:batch_start`. We store it
       * here so the Slow Batch tooltip can show the targeted "this is
       * expected — do NOT abort" message instead of the generic "slow batch"
       * tip. Install #21 abort lesson: users who don't know cn:60200 takes
       * 30–90 min interpret the 60-min stall as broken and kill the runner. */
      knownSlowReason: null as string | null,
    };

    try {
      // Set up event listeners for native install events
      const unlistenStdout = await listen<string>("install:stdout", (event) => {
        addLine(event.payload, "stdout");
        // Feed the slow-batch watchdog. Skip empty lines and Infinity Mod Runner
        // bracketed status lines — those are our own notices, not WeiDU work
        // signal.
        const line = event.payload;
        if (line && line.trim() && !line.startsWith("[Infinity Mod Runner]")) {
          slowBatch.lastStdoutAt = Date.now();
          slowBatch.lastStdoutLine = line.length > 180 ? line.slice(0, 180) + "\u2026" : line;
          slowBatch.lastStdoutCount += 1;
        }
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
      // Track progress-count per batch so batch_done can report the running total.
      const completedCompsRef = { current: 0 };
      const unlistenBatchStart = await listen<{
        batch_idx: number; total_batches: number; mod_name: string; components: string[];
        /** Set by the backend when any component in the batch is in
         * `installer::known_slow_reason`'s table (dw_talents cn:60200 etc.).
         * Null/undefined for every other batch. */
        known_slow_reason?: string | null;
      }>("install:batch_start", (event) => {
        const tp2Name = event.payload.mod_name;
        const displayName = modDisplayNames.current.get(tp2Name.toLowerCase()) || tp2Name;
        setCurrentMod(displayName);
        setCurrentModTp2(tp2Name);
        const batchNum = event.payload.batch_idx + 1;
        const totalBatches = event.payload.total_batches;
        setCurrentComponent(`Batch ${batchNum}/${totalBatches}`);
        noteBatchStart(event.payload.batch_idx, totalBatches);
        // Visible batch boundary in the UI log so WeiDU sub-process
        // transitions are legible. Without this, a mod split across
        // multiple WeiDU invocations (force-single-cn components,
        // heavy_batch_size caps, segfault retries) reads as "why did
        // BCS cache stats appear mid-batch?" — it's actually a new
        // WeiDU process starting, and each process emits its own
        // `at_exit` stats line. The marker makes that boundary
        // visible so "the last batch's BCS line is above, the next
        // one's components are below" is a one-glance read.
        const compCount = event.payload.components.length;
        const compLabel = compCount === 1 ? "1 component" : `${compCount} components`;
        addLine(
          `\u2500\u2500\u2500\u2500\u2500 Batch ${batchNum}/${totalBatches}: ${displayName} (${tp2Name}) \u2022 ${compLabel} \u2500\u2500\u2500\u2500\u2500`,
          "system",
        );
        // Reset slow-batch watchdog for the new batch.
        slowBatch.batchIdx = event.payload.batch_idx;
        slowBatch.modName = displayName;
        slowBatch.modTp2 = tp2Name;
        slowBatch.totalBatches = totalBatches;
        slowBatch.startedAt = Date.now();
        slowBatch.lastStdoutAt = 0;
        slowBatch.lastStdoutLine = "";
        slowBatch.lastStdoutCount = 0;
        slowBatch.firedThresholds = new Set();
        slowBatch.rateSamples = [];
        slowBatch.cascadeFlagged = false;
        slowBatch.knownSlowReason = event.payload.known_slow_reason ?? null;
        if (slowBatch.uiShown) {
          setSlowBatchUi(null);
          slowBatch.uiShown = false;
        }
        traceRecorderRef.current.beginBatch();
      });
      const unlistenBatchError = await listen<{
        batch_idx: number; mod_name: string; error: string; can_retry: boolean;
      }>("install:batch_error", (event) => {
        logBatchError(event.payload.batch_idx, event.payload.mod_name, event.payload.error);
        setBatchError({
          modName: event.payload.mod_name,
          error: event.payload.error,
          canRetry: event.payload.can_retry,
        });
      });
      const unlistenBatchDone = await listen<{
        batch_idx: number;
        results: { mod_name: string; component: number; component_name: string; status: string; message?: string; warnings?: string[] }[];
      }>("install:batch_done", (event) => {
        // Aggregate status counts across the batch's results and update per-component state map.
        //
        // IMPORTANT: the Rust backend's `ComponentStatus` enum has
        // `#[serde(rename_all = "snake_case")]`, so the JSON payload sends
        // `"success"` / `"warning"` / `"error"` / `"skipped"` / `"already_installed"`
        // — NOT the PascalCase Rust variant names. Comparing against PascalCase
        // silently falls through to the default branch, turning every component
        // into "success" in the status map and producing 0-count rollups.
        // `cancelled` is a view on `skip`: components marked Skipped whose
        // message indicates they were cancelled due to an abort (rather than
        // skipped after a failed retry). The Rust orchestrator tags these with
        // "Cancelled: install aborted". Frontend uses this to render a
        // distinct per-batch log line ("cancelled" instead of "done") so an
        // auditor can see at a glance that these weren't organic failures.
        const counts = { ok: 0, warn: 0, err: 0, skip: 0, already: 0, cancelled: 0 };
        const newEntries: ErrorLogEntry[] = [];
        let modTp2 = "";
        const ts = new Date().toISOString();
        // Build the trace slice for this batch as we iterate. The recorder
        // stamps "now - batchStart" when we call endBatch below.
        const traceSlice: Array<{ modName: string; component: number; status: InstallTraceEntry["status"] }> = [];
        for (const r of event.payload.results) {
          const key = `${r.mod_name}:${r.component}`;
          modTp2 = modTp2 || r.mod_name;
          const status = r.status === "success" ? "success"
            : r.status === "warning" ? "warning"
            : r.status === "error" ? "error"
            : r.status === "skipped" ? "skipped"
            : r.status === "already_installed" ? "already"
            : "success";
          installStatusRef.current.set(key, status);
          traceSlice.push({ modName: r.mod_name, component: r.component, status });
          if (r.status === "success") counts.ok++;
          else if (r.status === "warning") counts.warn++;
          else if (r.status === "error") counts.err++;
          else if (r.status === "skipped") {
            counts.skip++;
            if (r.message && r.message.startsWith("Cancelled:")) counts.cancelled++;
          }
          else if (r.status === "already_installed") counts.already++;

          // Surface non-success outcomes in the Issues panel so users and AIs
          // can see WHICH components errored/warned/skipped, not just the totals.
          // Already-installed results are skipped here — they're expected, not issues.
          if (r.status === "error" || r.status === "warning" || r.status === "skipped") {
            const levelStr: InstallIssue["level"] =
              r.status === "error" ? "ERROR" : r.status === "warning" ? "WARN" : "SKIP";
            newEntries.push({
              timestamp: ts,
              level: levelStr,
              mod_name: r.mod_name,
              message: r.message
                ? `[#${r.component}] ${r.component_name || ""}${r.component_name ? " — " : ""}${r.message}`
                : `[#${r.component}] ${r.component_name || "(unnamed component)"}`,
              warnings: r.warnings && r.warnings.length > 0 ? r.warnings : undefined,
            });
            // Also record in the issue map keyed by mod:component for the Mods
            // tab's per-component view. Same key shape as installStatusRef.
            // Carry the raw WARNING lines through so the Issues panel can
            // classify them against the Forge catalog and surface a severity
            // breakdown instead of treating every "Installed with warnings"
            // identically.
            installIssuesRef.current.set(key, {
              level: levelStr,
              componentName: r.component_name || "",
              message: r.message,
              timestamp: ts,
              warnings: r.warnings && r.warnings.length > 0 ? r.warnings : undefined,
            });
          }
        }
        if (newEntries.length > 0) {
          errorEntriesRef.current = [...errorEntriesRef.current, ...newEntries];
          setErrorEntries(errorEntriesRef.current);
          // Propagate to App so the Mods tab can render per-component detail.
          if (onInstallIssues) {
            onInstallIssues(new Map(installIssuesRef.current));
          }
        }

        completedCompsRef.current += event.payload.results.length;
        const displayName = modDisplayNames.current.get(modTp2.toLowerCase()) || modTp2;
        logBatchDone(event.payload.batch_idx, displayName, modTp2, counts, completedCompsRef.current);
        // Push updated map to parent
        if (onInstallStatus) {
          onInstallStatus(new Map(installStatusRef.current));
        }
        // Record per-component timings for the measurement trace. Batch
        // wall-clock is apportioned equally across its components inside
        // endBatch(). Already-installed entries contribute no real work
        // and are filtered from telemetry submission via compactTrace().
        traceRecorderRef.current.endBatch(traceSlice);
        setTraceEntryCount(traceRecorderRef.current.entryCount());
        // Clear slow-batch watchdog — this batch is done.
        slowBatch.batchIdx = -1;
        slowBatch.startedAt = 0;
        if (slowBatch.uiShown) {
          setSlowBatchUi(null);
          slowBatch.uiShown = false;
        }
      });
      // High-resolution timing: each WeiDU "SUCCESSFULLY INSTALLED" /
      // "INSTALLED WITH WARNINGS" / "NOT INSTALLED DUE TO ERRORS" line
      // produces a `install:component_done` event from the orchestrator.
      // We feed each into the trace recorder so per-component baselines
      // are attributed correctly (rather than apportioning batch wall-clock
      // evenly across the batch's components).
      const unlistenComponentDone = await listen<{
        mod_name: string;
        component: number;
        component_name: string;
        duration_ms: number;
        status: string;
      }>("install:component_done", (event) => {
        const p = event.payload;
        const sec = (p.duration_ms || 0) / 1000;
        const status: InstallTraceEntry["status"] =
          p.status === "success" ? "success"
            : p.status === "warning" ? "warning"
            : p.status === "error" ? "error"
            : p.status === "skipped" ? "skipped"
            : p.status === "already_installed" ? "already"
            : "success";
        traceRecorderRef.current.recordComponent(p.mod_name, p.component, sec, status);
        setTraceEntryCount(traceRecorderRef.current.entryCount());
      });
      // BCS buffer-cache stats emitted once per batch by the patched WeiDU's
      // at_exit handler. Populates the current-batch badge + the running
      // history used for the post-install aggregate card. A missing stats
      // line means WeiDU died hard (segfault/abort) — at_exit didn't run —
      // not that the cache was unused; so we don't try to synthesize a
      // zeroed entry when one doesn't arrive.
      const unlistenBcsCacheStats = await listen<{
        batch_idx: number;
        mod_name: string;
        enabled: boolean;
        hits: number;
        misses: number;
        hit_rate_pct: number;
        evictions: number;
        peak_kb: number;
        current_kb: number;
        max_mb: number;
      }>("install:bcs_cache_stats", (event) => {
        const p = event.payload;
        const tp2Name = p.mod_name;
        const displayName = modDisplayNames.current.get(tp2Name.toLowerCase()) || tp2Name;
        const entry = {
          batchIdx: p.batch_idx,
          modName: displayName,
          enabled: p.enabled,
          hits: p.hits,
          misses: p.misses,
          hitRatePct: p.hit_rate_pct,
          evictions: p.evictions,
          peakKb: p.peak_kb,
          currentKb: p.current_kb,
          maxMb: p.max_mb,
        };
        bcsCacheHistoryRef.current = [...bcsCacheHistoryRef.current, entry];
        setBcsCacheHistoryCount(bcsCacheHistoryRef.current.length);
        setBcsCacheCurrent(entry);
      });
      // Format-drift alarm. The prefix matched but the JSON body didn't
      // parse — surface a single line in the runner log so we don't silently
      // drop stats when the OCaml emitter changes shape. Not a fatal event;
      // the install continues normally.
      const unlistenBcsCacheParseError = await listen<{
        batch_idx: number;
        mod_name: string;
        raw_body: string;
        reason: string;
      }>("install:bcs_cache_stats_parse_error", (event) => {
        const p = event.payload;
        addLine(
          `[Infinity Mod Runner] BCS cache stats parse error (batch ${p.batch_idx}, ${p.mod_name}): ${p.reason}`,
          "system",
        );
        guiLog.warn("INSTALL", `BCS cache stats parse error: ${p.reason} | body=${p.raw_body.slice(0, 160)}`);
      });
      const unlistenPause = await listen<{ message: string }>("install:pause", (event) => {
        setIsPaused(true);
        setPauseRequested(false);  // transition Pausing... → Paused
        // Freeze the elapsed timer — remember when the pause started so the
        // ticker can subtract this open interval until resumed.
        if (pauseStartedAtRef.current === 0) {
          pauseStartedAtRef.current = Date.now();
        }
        addLine(`[Infinity Mod Runner] PAUSED — ${event.payload.message || "Pause point reached"}`, "system");
        logInstallPause(event.payload.message);
      });
      // The orchestrator fires install:resumed after wait_if_paused returns,
      // regardless of which path (button, auto-pause point, abort) cleared
      // the paused atomic. Roll the paused interval into the accumulator so
      // the elapsed timer picks up again from where it froze.
      const unlistenResumed = await listen<unknown>("install:resumed", () => {
        if (pauseStartedAtRef.current > 0) {
          pausedDurationRef.current += Date.now() - pauseStartedAtRef.current;
          pauseStartedAtRef.current = 0;
        }
        setIsPaused(false);
        setPauseRequested(false);
        addLine("[Infinity Mod Runner] Install resumed.", "system");
      });
      const unlistenPhase = await listen<string>("install:phase", (event) => {
        setCurrentPhase(event.payload as "bgee" | "eet");
        addLine(`[Infinity Mod Runner] Phase: ${event.payload}`, "system");
      });
      const unlistenInputNeeded = await listen<{ prompt: string }>("install:input_needed", (event) => {
        setInputNeeded(event.payload.prompt);
      });
      const unlistenError = await listen<string>("install:error", (event) => {
        addLine(`[Infinity Mod Runner] ERROR: ${event.payload}`, "system");
        const sess = getInstallSession();
        guiLog.error("INSTALL", sess ? withTail(event.payload, { session: sess.id }) : event.payload);
      });
      // Fatal: an essential mod failed and the orchestrator is auto-aborting.
      // Record this so the final "Aborted" summary line names the real cause
      // (not user intent) — critical for post-mortem audits.
      const unlistenFatal = await listen<{ mod_name: string; reason: string }>("install:fatal", (event) => {
        logInstallFatal(event.payload.mod_name, event.payload.reason);
      });
      const unlistenComplete = await listen<{
        total_components: number; success: number; warnings: number;
        errors: number; skipped: number;
        /** Cascade-skip subset of skipped — present on builds with the split-
         * skip accounting change. Absent on older backends, in which case the
         * tally line collapses to the legacy "N skip" form. */
        skipped_cascade?: number;
        already_installed: number;
        elapsed_ms: number; aborted: boolean;
      }>("install:complete", (event) => {
        const s = event.payload;
        // Build the measurement trace snapshot before resetting any state.
        try {
          const trace = traceRecorderRef.current.build({
            config,
            weiduVersion: weiduVersion || "",
            totalComponents: s.total_components,
            completed: !s.aborted && s.errors === 0,
          });
          setLastTrace(trace);
          guiLog.info("INSTALL", `Trace built: ${trace.entries.length} components, ${trace.totalDurationSec}s`);
        } catch (e) {
          guiLog.warn("INSTALL", `Failed to build trace: ${e}`);
        }
        setExitCode(s.aborted ? 1 : s.errors > 0 ? 1 : 0);
        setWasAborted(s.aborted);
        setCurrentPhase("done");
        setBatchError(null);     // Clear any lingering error dialog
        setAbortPending(false);  // Clear abort banner
        setInputNeeded(null);    // Clear any input prompt
        // Sync final tally state from the authoritative summary — the last
        // `install:progress` event may have fired BEFORE the erroring batch
        // recorded its result (common on fatal-essential-mod auto-abort, where
        // the orchestrator short-circuits to emit_complete without another
        // progress tick). Without this, errCount/warnCount/skipCount stay
        // stuck at stale pre-error values — which silently hides the Issues
        // panel's "errors" filter chip (gated on errorCount > 0) and makes
        // the live stats-row contradict the summary cards below.
        setSuccessCount(s.success);
        setWarnCount(s.warnings);
        setErrCount(s.errors);
        setSkipCount(s.skipped);
        setProgressCurrent(s.success + s.warnings + s.errors + s.skipped + (s.already_installed ?? 0));
        setProgressTotal(s.total_components);
        // Clear the "currently installing" mod banner — on abort, leaving
        // the last mod name there misleads readers into thinking the install
        // is still in progress with that mod.
        setCurrentMod("");
        setCurrentModTp2("");
        setCurrentComponent("");
        setSlowBatchUi(null);  // Clear any lingering slow-batch badge.
        onRunningChange(false);
        // Match the gui-logger tally formatting so what the user sees in the
        // runner log mirrors what lands in gui.log.
        const cascade = s.skipped_cascade ?? 0;
        const primarySkip = Math.max(0, s.skipped - cascade);
        const skipPhrase = cascade > 0
          ? `${s.skipped} skipped (${primarySkip} primary, ${cascade} cascade)`
          : `${s.skipped} skipped`;
        addLine(`[Infinity Mod Runner] Install complete: ${s.success} success, ${s.warnings} warnings, ${s.errors} errors, ${skipPhrase}`, "system");
        logInstallComplete(s);
        // OS notification
        try {
          if (Notification.permission === "granted") {
            new Notification("Infinity Mod Runner — Install Complete", {
              body: s.aborted
                ? "Installation was aborted."
                : `${s.success} success, ${s.errors} errors, ${s.warnings} warnings`,
            });
          } else if (Notification.permission !== "denied") {
            Notification.requestPermission().then((perm) => {
              if (perm === "granted") {
                new Notification("Infinity Mod Runner — Install Complete", {
                  body: `${s.success} success, ${s.errors} errors`,
                });
              }
            });
          }
        } catch { /* Notification API not available */ }
        // Cleanup all listeners + watchdog timer
        unlistenStdout(); unlistenStderr(); unlistenProgress();
        unlistenBatchStart(); unlistenBatchError(); unlistenBatchDone(); unlistenPause(); unlistenResumed();
        unlistenPhase(); unlistenInputNeeded(); unlistenError(); unlistenFatal(); unlistenComplete();
        unlistenComponentDone();
        unlistenBcsCacheStats(); unlistenBcsCacheParseError();
        clearInterval(slowBatchTimer);
      });

      // Slow-batch watchdog interval. Runs every 30s. Two responsibilities:
      //
      // 1. **Threshold-based WARN log lines** at 10 / 30 / 60 min marks.
      //    Each fires at most once per batch (firedThresholds Set) to avoid
      //    log spam. Each line carries elapsed, last-WeiDU-stdout snippet,
      //    stdout age, and a throughput verdict.
      //
      // 2. **Cascade detection** — if WeiDU's output line-rate falls more
      //    than 50% between adjacent threshold samples, we flag the log
      //    line and mark the UI badge with a cascade warning. This catches
      //    the SFO memory-pressure pattern seen in dw_talents sessions
      //    where batch times grow exponentially (2m → 4m → 9m → 51m).
      //
      // 3. **UI badge state** — once the batch crosses 5min, we start
      //    updating `slowBatchUi` state every tick so the dashboard can
      //    render a live badge next to currentMod. Cleared on batch_done.
      const SLOW_THRESHOLDS_MS = [10, 30, 60].map((m) => m * 60_000);
      const BADGE_VISIBLE_AFTER_MS = 5 * 60_000; // Show UI badge after 5min.
      const slowBatchTimer = setInterval(() => {
        if (slowBatch.batchIdx < 0 || slowBatch.startedAt === 0) return;
        const now = Date.now();
        const elapsed = now - slowBatch.startedAt;
        const quiet = slowBatch.lastStdoutAt === 0;
        const stdoutAgeMs = quiet ? elapsed : now - slowBatch.lastStdoutAt;
        // Map "stalled" → "scanning" for mods on the KNOWN_SLOW_SCANNERS list.
        // Those mods have legitimate long silent phases (full-game REGEXP
        // iterations over 10k+ files). Calling them "stalled" cries wolf.
        // The badge still shows so the user knows the batch is slow, just
        // with non-alarming copy.
        const isKnownSlow = KNOWN_SLOW_SCANNERS.has(slowBatch.modName.toLowerCase());
        const rawHealth: "progressing" | "stalled" | "quiet" = quiet
          ? "quiet"
          : stdoutAgeMs > 120_000
            ? "stalled"
            : "progressing";
        const health: "progressing" | "stalled" | "quiet" | "scanning" =
          isKnownSlow && (rawHealth === "stalled" || rawHealth === "quiet")
            ? "scanning"
            : rawHealth;

        // Threshold crossings → log lines + cascade check.
        for (const threshold of SLOW_THRESHOLDS_MS) {
          if (elapsed >= threshold && !slowBatch.firedThresholds.has(threshold)) {
            slowBatch.firedThresholds.add(threshold);
            // Record a rate sample for cascade detection.
            const sample = { atMs: elapsed, totalLines: slowBatch.lastStdoutCount };
            const prior = slowBatch.rateSamples[slowBatch.rateSamples.length - 1];
            slowBatch.rateSamples.push(sample);
            // Compute current-window rate (lines/min over the last threshold gap).
            //
            // Two different pathologies share the "slow batch" alert surface and
            // need distinct messaging:
            //   1. Cascade: currRate > 0 but meaningfully lower than prevRate.
            //      Symptom of SFO memory-pressure where throughput progressively
            //      decays batch over batch (e.g. stratagems batch 450: 482 → 225
            //      lines/min). Flagging as cascade is correct.
            //   2. Hang: currRate ≈ 0 for extended time. WeiDU is alive but
            //      producing no output — likely stuck in an internal loop
            //      (e.g. Trap Overhaul SPLSTATE.IDS 256-slot exhaustion, 0 → 0
            //      lines/min). NOT a cascade — wrong to label as SFO pressure.
            //
            // The original heuristic (`currRate < prevRate * 0.5`) was triggered
            // by 0 < any_positive * 0.5, so it mislabeled every hang as cascade.
            let cascadeNote = "";
            if (prior) {
              const prevRate = (prior.totalLines) / (prior.atMs / 60_000);
              const windowLines = sample.totalLines - prior.totalLines;
              const windowMin = (sample.atMs - prior.atMs) / 60_000;
              const currRate = windowMin > 0 ? windowLines / windowMin : 0;
              // Treat "essentially zero" as a hang even if a few stray lines
              // trickle out (keeps lenient): under 5 lines/min is indistinguishable
              // from stalled WeiDU for diagnostic purposes.
              const isHang = currRate < 5;
              const isDecay = !isHang && prevRate > 0 && currRate < prevRate * 0.5;
              if (isDecay) {
                slowBatch.cascadeFlagged = true;
                cascadeNote = ` \u26A0 throughput dropping (${Math.round(prevRate)} \u2192 ${Math.round(currRate)} lines/min) — likely SFO memory-pressure cascade`;
              } else if (isHang && prevRate > 0) {
                // Don't set cascadeFlagged — this is a hang, not a cascade. Keep
                // the UI pill distinct so "stalled" and "cascading" have different
                // meaning. The message itself makes the distinction clear for the
                // log reader.
                cascadeNote = ` \u26A0 throughput collapsed (${Math.round(prevRate)} \u2192 ~0 lines/min) — WeiDU appears stalled inside this component, not a cascade`;
              }
            }

            const sess = getInstallSession();
            const batchNum = slowBatch.batchIdx + 1;
            const mins = Math.round(elapsed / 60_000);
            const stdoutAgeStr = quiet
              ? "no output yet"
              : stdoutAgeMs < 60_000
                ? `${Math.round(stdoutAgeMs / 1000)}s ago`
                : `${Math.round(stdoutAgeMs / 60_000)}m ago`;
            const snippet = slowBatch.lastStdoutLine
              ? ` last: "${slowBatch.lastStdoutLine}"`
              : "";
            const healthStr =
              slowBatch.knownSlowReason ? "known-slow component, expected"
              : health === "scanning" ? "WeiDU silent (known-slow scanner, expected)"
              : health === "quiet" ? "WeiDU has produced no output"
              : health === "stalled" ? "WeiDU appears stalled"
              : "WeiDU is still producing output";
            guiLog.warn(
              "INSTALL",
              withTail(
                `Slow batch ${batchNum}/${slowBatch.totalBatches}: ${slowBatch.modName} (${slowBatch.modTp2}) running ${mins}m — ${healthStr}, last output ${stdoutAgeStr}, ${slowBatch.lastStdoutCount} lines this batch.${cascadeNote}${snippet}`,
                {
                  session: sess?.id,
                  elapsed_min: mins,
                  stdout_age_s: Math.round(stdoutAgeMs / 1000),
                  cascade: slowBatch.cascadeFlagged ? "true" : undefined,
                  known_slow: slowBatch.knownSlowReason ? "true" : undefined,
                },
              ),
            );
          }
        }

        // UI badge — update once we're past the visible-after threshold.
        if (elapsed >= BADGE_VISIBLE_AFTER_MS) {
          slowBatch.uiShown = true;
          setSlowBatchUi({
            elapsedMin: Math.round(elapsed / 60_000),
            health,
            stdoutAgeS: quiet ? null : Math.round(stdoutAgeMs / 1000),
            lastLine: slowBatch.lastStdoutLine,
            cascade: slowBatch.cascadeFlagged,
            modName: slowBatch.modName,
            knownSlowReason: slowBatch.knownSlowReason,
          });
        }
      }, 30_000);

      unlistenRefs.current = [
        unlistenStdout, unlistenStderr, unlistenProgress,
        unlistenBatchStart, unlistenBatchError, unlistenBatchDone, unlistenPause, unlistenResumed,
        unlistenPhase, unlistenInputNeeded, unlistenError, unlistenFatal, unlistenComplete,
        unlistenComponentDone,
        () => clearInterval(slowBatchTimer),
      ];

      // resolvedWeiduPath was resolved earlier, before startInstallSession,
      // so the session-start log line has the correct binary version string.

      // Launch native install
      const installArgs: NativeInstallArgs = {
        weiduPath: resolvedWeiduPath,
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
        maxBatchSize: config.max_batch_size ?? 25,
        heavyBatchSize: config.heavy_batch_size ?? 3,
        pausePoints: pausePointsProp || [],
        bcsScanner: config.bcs_scanner,
        autoSkipAfterRetry: config.auto_skip_after_retry,
        suppressReadmes: config.suppress_readmes,
        dataDirectory: config.data_directory,
        pauseOnGuard: config.pause_on_guard,
        overrideFastDrive: config.override_fast_drive,
        overrideFastDrivePath: config.override_fast_drive_path?.trim() || null,
        enableBiffDeleteOptimization: config.enable_biff_delete_optimization ?? true,
      };

      await startNativeInstall(installArgs);
    } catch (e) {
      const errMsg = String(e);
      addLine(`[Infinity Mod Runner] Failed to start: ${errMsg}`, "system");
      const sess0 = getInstallSession();
      guiLog.error("INSTALL", sess0 ? withTail(`Failed to start: ${errMsg}`, { session: sess0.id }) : `Failed to start: ${errMsg}`);
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
    // Dry run output is the artifact the user is here to read — don't
    // truncate it to the install-time 500-line ring. Clear any residual
    // install lines first so the plan printout isn't prefixed with
    // stale content from a prior install.
    logBuffer.current = [];
    logTotalCount.current = 0;
    pendingLines.current = [];
    setDisplayLines([]);
    setTotalLineCount(0);
    logBufferSizeRef.current = DRY_RUN_LOG_BUFFER_SIZE;
    setLogBufferSize(DRY_RUN_LOG_BUFFER_SIZE);
    addLine("[Infinity Mod Runner] Starting dry run...", "system");
    try {
      const eetLogFile = config.eet_log_path;
      const bgeeLogFile = config.bgee_log_path || null;
      if (!eetLogFile || !config.weidu_path) return;

      // Set up listeners for dry run output (same stdout stream as real install)
      const unlistenStdout = await listen<string>("install:stdout", (event) => {
        addLine(event.payload, "stdout");
      });
      const unlistenDryRunComplete = await listen<unknown>("install:dry_run_complete", (_event) => {
        // No confirmation line emitted here — the Rust-side report already
        // closes with its own "═══" divider, so echoing "Dry run report
        // received" below it just duplicates the signal.
        unlistenStdout();
        unlistenDryRunComplete();
      });

      // Dry run uses the same path resolver so the estimate reflects the
      // binary that WILL actually run when the user clicks "Start Installation".
      // Enabling Resilient WeiDU between Dry Run and Start would be surprising
      // otherwise — planning would still point at the configured binary.
      const resolvedWeiduPath = await weiduSwapResolvePath(
        config.weidu_path || "",
        !!config.use_experimental_weidu,
        config.data_directory ?? null,
      );

      const installArgs = {
        weiduPath: resolvedWeiduPath,
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
        maxBatchSize: config.max_batch_size ?? 25,
        heavyBatchSize: config.heavy_batch_size ?? 3,
        pausePoints: [] as { afterModIndex: number; message: string; phase: string }[],
        bcsScanner: false,
        autoSkipAfterRetry: false,
      };
      await startDryRun(installArgs);
    } catch (e) {
      addLine(`[Infinity Mod Runner] Dry run failed: ${String(e)}`, "system");
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
        addLine(`[Infinity Mod Runner] Failed to send input: ${e}`, "system");
      }
    }
  }

  const [abortPending, setAbortPending] = useState(false);

  async function abortInstall() {
    if (abortPending) return;
    setAbortPending(true);
    try {
      await abortNativeInstall();
      addLine("[Infinity Mod Runner] Abort signal sent — WeiDU will be stopped after current operation...", "system");
      {
        const sess = getInstallSession();
        guiLog.warn("INSTALL", sess ? withTail("Abort requested by user", { session: sess.id }) : "Abort requested by user");
      }
    } catch (e) {
      addLine(`[Infinity Mod Runner] Failed to abort: ${e}`, "system");
      setAbortPending(false);
    }
  }

  async function togglePause() {
    if (isPaused || pauseRequested) {
      // Resume. The backend will emit install:resumed once wait_if_paused
      // actually returns — that handler is what unfreezes the timer and
      // prints the confirmation line. We still flip local flags here for
      // instant button-label feedback, but we log an intent-only line so
      // the eventual "Install resumed" confirmation doesn't look like a
      // duplicate.
      try {
        await installResume();
        setIsPaused(false);
        setPauseRequested(false);
        addLine("[Infinity Mod Runner] Resume requested...", "system");
      } catch (e) {
        addLine(`[Infinity Mod Runner] Failed to resume: ${e}`, "system");
      }
    } else {
      // Pause at next batch boundary
      try {
        await installPause();
        setPauseRequested(true);
        addLine("[Infinity Mod Runner] Pause requested — will pause after current mod finishes.", "system");
      } catch (e) {
        addLine(`[Infinity Mod Runner] Failed to pause: ${e}`, "system");
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

  // ── Mods remaining — discrete count to pair with the ETA so the user
  //    has a second, orthogonal signal (time can wobble; mod-count only
  //    decreases). A mod counts as "done" once every one of its entries
  //    has a status recorded in installStatusRef. ──
  // progressCurrent in deps is the trigger — it increments on every
  // completion, which is also when installStatusRef has been updated.
  const modsRemaining = useMemo(() => {
    if (!parsedLog || !running) return null;
    const allEntries = [
      ...(parsedLog.bgeeEntries ?? []),
      ...parsedLog.entries,
    ];
    if (allEntries.length === 0) return null;
    const status = installStatusRef.current;
    const perMod = new Map<string, { total: number; done: number }>();
    for (const e of allEntries) {
      const bucket = perMod.get(e.mod_name) ?? { total: 0, done: 0 };
      bucket.total++;
      if (status.has(`${e.mod_name}:${e.component}`)) bucket.done++;
      perMod.set(e.mod_name, bucket);
    }
    let remaining = 0;
    // Collect pending heavy-class mods so the ETA tooltip can tell the
    // user *why* the remaining-time estimate looks much longer than a
    // linear projection from elapsed / fraction-done would predict. At
    // 46% done in 1h 22m, "≈ 7h remaining" with dw_talents + stratagems
    // + SCS still ahead is correct forecasting but counter-intuitive
    // without the explanation.
    const pendingHeavyMods: string[] = [];
    for (const [modName, { total, done }] of perMod.entries()) {
      if (done < total) {
        remaining++;
        if (inferHeavyClass(modName) === "heavy") {
          pendingHeavyMods.push(modName);
        }
      }
    }
    return { total: perMod.size, remaining, pendingHeavyMods };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedLog, running, progressCurrent]);

  const activePhase: "bg1" | "eet" | "done" | "starting" = (() => {
    if (isComplete) return "done";
    if (currentPhase === "bgee") return "bg1";
    if (currentPhase === "eet") return "eet";
    return "starting";
  })();

  // Memoize expensive computations — only recalculate when errorEntries changes
  const groupedIssues = useMemo(() => groupErrorEntries(errorEntries, issueSortMode), [errorEntries, issueSortMode]);

  /**
   * Per-group classification of raw WARNING lines against the fetched
   * known-issue catalog. Keyed by lowercase mod_name (same key the group
   * rows use). Each entry carries the flat list of ClassifiedWarnings for
   * rendering in the expanded view, plus an aggregate `summary` that the
   * collapsed row renders as a "3 cosmetic · 1 unknown" chip.
   *
   * Computed lazily via useMemo — re-runs when errorEntries OR the catalog
   * changes. Until the catalog loads (or if it fails), every warning
   * classifies as "unknown", which is safe and informative.
   */
  const groupClassifications = useMemo(() => {
    const out = new Map<string, { classified: ClassifiedWarning[][]; summary: WarningSummary }>();
    if (!knownIssueCatalog) return out;
    for (const group of groupedIssues) {
      const warnEntries = group.entries.filter(
        (e) => e.level === "WARN" && e.warnings && e.warnings.length > 0,
      );
      if (warnEntries.length === 0) continue;
      const result = classifyBatchWarnings(
        warnEntries.map((e) => ({ modName: e.mod_name, warnings: e.warnings || [] })),
        knownIssueCatalog,
      );
      out.set(group.mod_name.toLowerCase(), result);
    }
    return out;
  }, [groupedIssues, knownIssueCatalog]);

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

  // ── Unattempted mod list (for the "Unattempted" summary card drawer) ──
  // Build from parsedLog entries minus anything recorded in installStatusRef.
  // Runs lazily once the install is done so we don't churn during the live
  // install. Groups by tp_file so a mod with N unattempted components shows
  // as one row with an ×N count, matching the Issues panel style.
  const unattemptedMods = useMemo(() => {
    if (!isComplete || !parsedLog) return [] as { tp2: string; displayName: string; count: number; components: string[] }[];
    const status = installStatusRef.current;
    const all = [...(parsedLog.bgeeEntries || []), ...parsedLog.entries];
    const byMod = new Map<string, { tp2: string; displayName: string; count: number; components: string[] }>();
    for (const e of all) {
      const tp2 = e.tp_file;
      const key = `${tp2}:${e.component}`;
      if (status.has(key)) continue; // attempted (in any status)
      const k = tp2.toLowerCase();
      if (!byMod.has(k)) {
        const displayName = modDisplayNames.current.get(k) || tp2;
        byMod.set(k, { tp2, displayName, count: 0, components: [] });
      }
      const g = byMod.get(k)!;
      g.count++;
      if (g.components.length < 50) {
        g.components.push(e.component_name || `#${e.component}`);
      }
    }
    return [...byMod.values()].sort((a, b) => b.count - a.count);
  }, [isComplete, parsedLog, errorEntries.length, progressCurrent]);

  const [unattemptedExpanded, setUnattemptedExpanded] = useState(false);

  // ─── Pre-install view ───
  if (!running && !isComplete) {
    return (
      <div>
        {/* Header: clean heading + short description. Phase 19c moved the
         * three preference buttons (Save / Restore / Reset) out of this
         * row and into a dedicated section near the bottom-bar so the
         * only primary button in view is Start Installation. */}
        <div style={{ marginBottom: 20 }}>
          <h2 style={{ marginBottom: 4 }}>{t("install.heading", "Install Runner")}</h2>
          <p style={{ color: "var(--txd)", fontSize: 13, margin: 0 }}>
            {t("install.desc", "Execute your mod installation directly via WeiDU. Real-time progress streaming, per-batch error recovery, and pause points.")}
          </p>
        </div>

        {/* Confirmation modal for the destructive "Reset to program defaults".
         * Gated behind a click because unlike the other two buttons, this one
         * throws away the user's current settings with no one-click undo
         * (they'd have to have saved preferences first). The modal is
         * explicit about consequences so users don't click through and
         * realize afterward that e.g. their heavy_batch_size tuning is gone. */}
        {showResetConfirm && (
          <div className="modal-backdrop" onClick={() => setShowResetConfirm(false)}>
            <div className="modal" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
              <div className="modal-title" style={{ color: "var(--org)" }}>
                {t("install.prefs_reset_title", "Reset to program defaults?")}
              </div>
              <div className="modal-body" style={{ fontSize: 13, lineHeight: 1.5, textAlign: "left" }}>
                {t(
                  "install.prefs_reset_body",
                  "This will discard your current install options and revert them to the conservative program defaults. Any settings that don't exactly match the defaults will be overwritten.",
                )}
                {hasSavedPreferences && (
                  <div style={{ marginTop: 8, color: "var(--txd)", fontSize: 12 }}>
                    {t(
                      "install.prefs_reset_note_saved",
                      "Note: your saved preferences are untouched \u2014 you can click \"Restore my preferences\" to get them back anytime.",
                    )}
                  </div>
                )}
                {!hasSavedPreferences && (
                  <div style={{ marginTop: 8, color: "var(--tx-warn)", fontSize: 12 }}>
                    {t(
                      "install.prefs_reset_note_unsaved",
                      "You have no saved preferences, so this reset cannot be undone with one click. If you want your current settings back, cancel and click \"Save my preferences\" first.",
                    )}
                  </div>
                )}
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setShowResetConfirm(false)}>
                  {t("btn.cancel", "Cancel")}
                </button>
                <button className="btn btn-danger" onClick={resetToProgramDefaults}>
                  {t("install.prefs_reset_confirm", "Reset to defaults")}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Transition banner — "Ready Check just passed, you can install now."
         * Primary CTA points at Dry Run (conservative default for new users);
         * Start Install is still one click away in the sticky bar below. */}
        {showPreflightPassedBanner && config.weidu_path && parsedLog && onDismissPreflightPassedBanner && (
          <TransitionBanner
            headline={t("banner.preflight_passed_headline", "Checks passed.")}
            body={t("banner.preflight_passed_body", "You're ready to install. Want to preview the plan first?")}
            primary={{
              label: t("banner.try_dry_run", "Try Dry Run"),
              onClick: () => { onDismissPreflightPassedBanner(); runDryRun(); },
            }}
            onDismiss={onDismissPreflightPassedBanner}
          />
        )}

        {/* ── Install behavior ── */}
        <div className="settings-group">
          <div className="settings-group-title">{t("install.group_behavior", "Install behavior")}</div>
          <div className="settings-group-desc">{t("install.group_behavior_desc", "How the installer reacts to warnings, errors, and already-installed components.")}</div>
          <ToggleOption checked={config.skip_installed} onChange={(v) => updateOption("skip_installed", v)}
            label={t("install.skip_installed", "Skip already installed")} hint={t("install.skip_installed_hint", "Resume interrupted installs without repeating successful mods")} />
          <ToggleOption checked={config.never_abort} onChange={(v) => updateOption("never_abort", v)}
            label={t("install.never_abort", "Never abort past errors")} hint={t("install.never_abort_hint", "Recommended for large installs — keeps going and reports at the end")} />
          <ToggleOption checked={config.abort_on_warnings} onChange={(v) => updateOption("abort_on_warnings", v)}
            label={t("install.abort_warnings", "Abort on WeiDU warnings")} hint={t("install.abort_warnings_hint", "Stop the install on any warning, not just errors")} />
          <ToggleOption checked={config.auto_skip_after_retry} onChange={(v) => updateOption("auto_skip_after_retry", v)}
            label={t("install.auto_skip", "Auto-skip after retry")} hint={t("install.auto_skip_hint", "Automatically retry then skip errors — no interactive prompts")} />
        </div>

        {/* ── Diagnostics & safety ── */}
        <div className="settings-group">
          <div className="settings-group-title">{t("install.group_diag", "Diagnostics & safety")}</div>
          <div className="settings-group-desc">{t("install.group_diag_desc", "Detect corruption, surface hidden events, and avoid popup clutter during install.")}</div>
          <ToggleOption checked={config.bcs_scanner} onChange={(v) => updateOption("bcs_scanner", v)}
            label={t("install.bcs", "BCS corruption scanner")} hint={t("install.bcs_hint", "Detect and restore WeiDU round-trip corruption in script files")} />
          <ToggleOption checked={config.pause_on_guard} onChange={(v) => updateOption("pause_on_guard", v)}
            label={t("install.guard", "Surface file-guard events")} hint={t("install.guard_hint", "Notify when a mod silently overwrites another mod's files (auto-restored either way)")} />
          <ToggleOption checked={config.suppress_readmes} onChange={(v) => updateOption("suppress_readmes", v)}
            label={t("install.suppress", "Suppress readme popups")} hint={t("install.suppress_hint", "Prevent mods from opening documentation windows during install")} />
        </div>

        {/* ── Performance (advanced, collapsed by default) ── */}
        <div className="settings-group">
          <div className="log-toggle" onClick={() => setAdvancedOpen(!advancedOpen)} style={{ marginBottom: advancedOpen ? 12 : 0 }}>
            <span>
              <span className={"toggle-arrow" + (advancedOpen ? " open" : "")}>{"\u25B6"}</span>
              {" "}{t("install.group_perf", "Performance & advanced")}
            </span>
          </div>
          {advancedOpen && (
            <>
              <div className="settings-group-desc" style={{ marginTop: 4 }}>
                {t("install.group_perf_desc", "Timeouts, batch size, override-redirect, and WeiDU tuning. Leave defaults unless you know you need to change them.")}
              </div>
              <NumericOption
                value={config.timeout}
                onChange={(v) => updateOption("timeout", v)}
                label={t("install.timeout", "Timeout per mod")}
                hint={t("install.timeout_hint", "Kill a mod that stalls longer than this. Default 7200s = 2h.")}
                suffix={`sec (${Math.round(config.timeout / 60)}m)`}
                width={90}
                min={60}
              />
              <NumericOption
                value={config.max_batch_size ?? 25}
                onChange={(v) => onSaveConfig({ ...config, max_batch_size: v })}
                label={t("install.batch", "Normal batch size")}
                hint={t("install.batch_hint", "Components per WeiDU call for non-heavy mods. Heavy mods (dw_talents, stratagems, mih_*, trap_overhaul) use the Heavy batch size below instead. Lower values reduce blast radius on mid-batch failures.")}
                suffix="components"
                width={80}
                min={1}
                max={100}
              />
              <ConfirmableNumericOption
                value={config.heavy_batch_size ?? 3}
                onConfirm={(v) => onSaveConfig({ ...config, heavy_batch_size: v })}
                label={t("install.heavy_batch", "Heavy batch size")}
                hint={t("install.heavy_batch_hint", "⚠ Power-user setting. Components per WeiDU call for heavy mods (dw_talents, stratagems, mih_*, trap_overhaul). These segfault WeiDU's OCaml GC at larger batches — the default 3 has been reliably safe. Raising above ~10 is likely to trigger segfaults; the orchestrator auto-retries at size 3 so correctness isn't affected, but wall-clock suffers. Useful for probing the upper limit of a stack-patched WeiDU build. Click Confirm to save — the change takes effect on the next dry run or install.")}
                suffix={(draft: number) => draft > 5 ? "components \u26A0 above safe default" : "components"}
                width={80}
                min={1}
                max={25}
                dangerAbove={10}
              />
              <ToggleOption
                checked={config.override_fast_drive}
                onChange={(v) => updateOption("override_fast_drive", v)}
                label={t("install.fast_drive", "Redirect override/ to fast drive")}
                hint={t("install.fast_drive_hint", "Junction game's override/ to a faster volume (NVMe or RAM disk) for the install. Can cut SFO-heavy mod time 2-5\u00D7. Needs ~3\u00D7 override size free on target; target must be a different volume.")}
              />
              {config.override_fast_drive && (
                <TextOption
                  value={config.override_fast_drive_path}
                  onChange={(v) => onSaveConfig({ ...config, override_fast_drive_path: v })}
                  label={t("install.fast_drive_path", "Fast-drive target path")}
                  hint={t("install.fast_drive_path_hint", "Leave blank to use system temp. Path must be on a different volume than the game.")}
                  placeholder="e.g. R:\\"
                  width={240}
                />
              )}
              {/* Phase 22c: Windows-only auto-Defender-exclusion
               * toggle. Hidden on macOS/Linux (DefenderStatus is
               * not_applicable there) and hidden until status resolves
               * so the settings list doesn't flicker in on mount. The
               * hint mentions the UAC prompt so users aren't surprised.
               * When Defender is Inactive (third-party AV present),
               * the toggle is visible but dimmed with a distinct hint
               * — enabling it would do nothing useful. */}
              {defenderState && defenderState !== "not_applicable" && (
                <ToggleOption
                  checked={config.auto_defender_exclusion}
                  onChange={(v) => updateOption("auto_defender_exclusion", v)}
                  label={t("install.defender_exclusion", "Auto-exclude game dir from Windows Defender")}
                  hint={
                    defenderState === "inactive"
                      ? t("install.defender_exclusion_hint_inactive", "Defender's real-time protection is disabled \u2014 a third-party AV is likely scanning instead. Enabling this won't help unless Defender becomes active again.")
                      : defenderState === "unknown"
                        ? t("install.defender_exclusion_hint_unknown", "Defender status couldn't be determined. Enable only if you know Defender is active on this machine; triggers one UAC prompt at install start.")
                        : t("install.defender_exclusion_hint", "Speeds up SFO-heavy mods 2\u20135\u00D7 by skipping real-time scans. One UAC prompt at install start; the exclusion is permanent (remove via Windows Security if desired).")
                  }
                  disabled={defenderState === "inactive"}
                />
              )}
              <SelectOption
                value={config.language}
                onChange={(v) => onSaveConfig({ ...config, language: v })}
                label={t("install.language", "WeiDU language")}
                hint={t("install.language_hint", "Passed to WeiDU as --language. Choose Other… to enter a custom locale code.")}
                options={WEIDU_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
                allowCustom
                width={220}
              />
              <SelectOption
                value={config.language_fallback}
                onChange={(v) => onSaveConfig({ ...config, language_fallback: v })}
                label={t("install.language_fallback", "Fallback language")}
                hint={t("install.language_fallback_hint", "Used when a mod doesn't provide translations for the primary language. Defaults to en_US because every EET-compatible mod ships with English.")}
                options={WEIDU_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
                allowCustom
                width={220}
              />
              <TextOption
                value={config.weidu_log_mode}
                onChange={(v) => onSaveConfig({ ...config, weidu_log_mode: v })}
                label={t("install.log_mode", "WeiDU log mode")}
                hint={t("install.log_mode_hint", "Comma-separated WeiDU log flags.")}
                width={240}
              />
            </>
          )}
        </div>

        {startError && (
          <div className="alert err" style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("install.start_error", "Failed to start installation")}</div>
            <div style={{ fontSize: 12, wordBreak: "break-all" }}>{startError}</div>
          </div>
        )}

        {/* Dry run output log — expandable and resizable */}
        {displayLines.length > 0 && !running && (
          <div style={{ marginBottom: 16 }}>
            <div
              className="log-toggle"
              onClick={() => setLogExpanded(!logExpanded)}
              style={{ marginBottom: logExpanded ? 4 : 0 }}
            >
              <span>
                <span className={"toggle-arrow" + (logExpanded ? " open" : "")}>{"\u25B6"}</span>
                {" "}{t("install.dry_run_output", "Dry Run Output")} ({displayLines.length.toLocaleString()} {t("install.log_lines", "log lines")})
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {logExpanded && (
                  <>
                    <button
                      className="btn"
                      title={t("install.log_fit_hint", "Fit log to ~75% of the window")}
                      style={{ fontSize: 11, padding: "2px 10px", opacity: 0.7 }}
                      onClick={(e) => { e.stopPropagation(); setLogHeight(computeFitHeight()); }}
                    >
                      {t("install.log_fit", "Fit")}
                    </button>
                    <button
                      className="btn"
                      title={t("install.log_reset_hint", "Reset log height to the default")}
                      style={{ fontSize: 11, padding: "2px 10px", opacity: 0.7 }}
                      onClick={(e) => { e.stopPropagation(); setLogHeight(350); }}
                    >
                      {t("install.log_reset", "Reset")}
                    </button>
                    <button
                      className="btn"
                      style={{ fontSize: 11, padding: "2px 10px", opacity: 0.7, transition: "all 0.2s" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        const btn = e.currentTarget;
                        const text = displayLines.map(l => l.text).join("\n");
                        navigator.clipboard.writeText(text).then(() => {
                          btn.textContent = "\u2713 Copied";
                          btn.style.color = "var(--grn)";
                          btn.style.borderColor = "var(--grn)";
                          btn.style.opacity = "1";
                          setTimeout(() => {
                            btn.textContent = "Copy";
                            btn.style.color = "";
                            btn.style.borderColor = "";
                            btn.style.opacity = "0.7";
                          }, 2000);
                        });
                      }}
                    >
                      {t("btn.copy", "Copy")}
                    </button>
                  </>
                )}
                <span style={{ fontSize: 11, marginLeft: 4 }}>
                  {logExpanded ? t("install.click_collapse", "Click to collapse") : t("install.click_expand", "Click to expand")}
                </span>
              </span>
            </div>
            {logExpanded && (
              <ResizablePanel
                className="log-output"
                height={logHeight}
                onHeightChange={setLogHeight}
                minHeight={120}
              >
                {displayLines.map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.type === "stderr" ? "log-err"
                        : line.type === "system" ? "log-progress"
                        : ""
                    }
                    style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}
                  >
                    {line.text}
                  </div>
                ))}
              </ResizablePanel>
            )}
          </div>
        )}

        {/* ── Preconditions block ──
         * Surfaces ALL missing prerequisites at once (not just the first)
         * so a user who lands here from a bookmark or tab-click sees
         * everything they need to address before Start Install becomes
         * useful. Each row has a jump button into the relevant tab so
         * the user doesn't have to scan the tab bar themselves.
         *
         * Only rendered when at least one precondition is unmet. A fully
         * configured user with an imported log sees no banner — just the
         * compact "Ready to install" line in the bottom bar below. */}
        {(() => {
          const preconds: Array<{ msg: string; target?: "setup" | "mods" }> = [];
          if (!config.weidu_path) {
            preconds.push({
              msg: t("install.precond_weidu", "Configure the WeiDU binary in Setup"),
              target: "setup",
            });
          }
          if (!config.bg2_game_dir && !config.bg1_game_dir) {
            preconds.push({
              msg: t("install.precond_game_dir", "Configure BG2:EE (or BG1:EE) in Setup"),
              target: "setup",
            });
          }
          if (!parsedLog) {
            preconds.push({
              msg: t("install.precond_mod_list", "Import a mod list in the Mods tab"),
              target: "mods",
            });
          }
          if (preconds.length === 0) return null;
          return (
            <div className="msg info" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--tx)" }}>
                {t("install.precond_heading", "Before you can start:")}
              </div>
              {preconds.map((p, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    padding: "4px 0",
                    fontSize: 12,
                  }}
                >
                  <span style={{ color: "var(--tx)" }}>
                    <span style={{ color: "var(--txd)", marginRight: 6 }}>{"\u2022"}</span>
                    {p.msg}
                  </span>
                  {p.target && onGoToTab && (
                    <button
                      className="btn"
                      style={{ fontSize: 11, padding: "2px 10px" }}
                      onClick={() => onGoToTab(p.target!)}
                    >
                      {p.target === "setup"
                        ? t("install.precond_go_setup", "Go to Setup")
                        : t("install.precond_go_mods", "Go to Mods")}
                    </button>
                  )}
                </div>
              ))}
            </div>
          );
        })()}

        {/* ── Preferences bar (Phase 19c) ──
         * Save / Restore / Reset live here, directly above the sticky
         * action bar. Previously they sat in the page header competing
         * with Start Installation for the eye; now Start is the only
         * primary-styled button on this tab. All three are secondary
         * styling — the save-toast + inline hint line give feedback
         * without promoting one button over the others. */}
        <div style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: "10px 12px",
          marginTop: 12,
          marginBottom: 0,
          background: "var(--bg2)",
          border: "1px solid var(--brd)",
          borderRadius: "var(--radius)",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              <span style={{ fontWeight: 600, color: "var(--tx)" }}>
                {t("install.prefs_section_label", "Install preferences")}
              </span>
              {prefsToast && (
                <span style={{ fontSize: 11, color: "var(--grn)" }}>
                  {"\u2713"} {prefsToast}
                </span>
              )}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <button
                className="btn"
                onClick={savePreferences}
                title={t(
                  "install.prefs_save_hint",
                  "Snapshot these install options as your personal preferences. Stored in your config file; survives restart.",
                )}
                style={{ fontSize: 11, padding: "4px 10px" }}
              >
                {t("install.prefs_save", "Save my preferences")}
              </button>
              <button
                className="btn"
                onClick={restorePreferences}
                disabled={!hasSavedPreferences}
                title={
                  hasSavedPreferences
                    ? t("install.prefs_restore_hint", "Load the preferences you previously saved.")
                    : t("install.prefs_restore_disabled", "No preferences saved yet \u2014 click \"Save my preferences\" first.")
                }
                style={{ fontSize: 11, padding: "4px 10px" }}
              >
                {t("install.prefs_restore", "Restore my preferences")}
              </button>
              <button
                className="btn"
                onClick={() => setShowResetConfirm(true)}
                title={t(
                  "install.prefs_reset_hint",
                  "Discard current options and return to the conservative program defaults.",
                )}
                style={{ fontSize: 11, padding: "4px 10px", color: "var(--org)" }}
              >
                {t("install.prefs_reset", "Reset to program defaults")}
              </button>
            </div>
          </div>
          <div style={{ fontSize: 10, color: "var(--txd)", fontStyle: "italic" }}>
            {hasSavedPreferences
              ? t("install.prefs_hint_has_saved", "Your preferences are saved and will load on next launch.")
              : t("install.prefs_hint_unsaved", "Changes live in config \u2014 save as preferences to carry them across resets.")}
          </div>
        </div>

        {/* ── Sticky bottom action bar ── */}
        <div className="bottom-bar">
          <div className="bar-info">
            {!config.weidu_path ? (
              <span style={{ color: "var(--red)" }}>{t("install.no_weidu", "WeiDU path not configured. Set it in the Setup tab.")}</span>
            ) : !parsedLog ? (
              <span style={{ color: "var(--tx-warn)" }}>{t("install.no_log", "No log imported. Import a WeiDU.log first.")}</span>
            ) : (
              <span>{t("install.ready", "Ready to install")} — {parsedLog.modCount} {t("install.mods", "mods")}, {parsedLog.componentCount} {t("install.components", "components")}</span>
            )}
          </div>
          {/* In guided mode, Dry Run is the primary CTA — first-time users
           * should preview the plan before committing files. Start Install
           * demotes to a secondary button (still one click, just less
           * visually prominent). In free-nav mode the original ordering
           * is preserved so returning users aren't surprised. */}
          <div className="bar-actions">
            <button
              className={`btn${config.guided_mode ? " btn-primary" : ""}`}
              onClick={() => {
                // Phase 20a: clicking the sticky-bar Dry Run dismisses the
                // preflight-passed banner too. The banner's own CTA already
                // dismissed + ran dry run; now the "regular" button matches
                // that behavior so users who click past the banner don't
                // leave a stale "Try Dry Run?" suggestion above a running
                // Dry Run that they just launched.
                onDismissPreflightPassedBanner?.();
                runDryRun();
              }}
              disabled={!config.weidu_path || !parsedLog || running}
              title={config.guided_mode ? t("install.guided_dry_hint", "Recommended first step — previews the install plan without touching your game directory.") : undefined}
            >
              {config.guided_mode
                ? t("install.guided_dry_run", "Try Dry Run first")
                : t("install.dry_run", "Dry Run")}
            </button>
            <button
              className={`btn${config.guided_mode ? "" : " btn-primary"}`}
              onClick={() => {
                // attemptStart handles the full pre-install flow:
                // preflight-banner dismiss, Defender modal (if all
                // conditions hold), silent-opt-in exclusion apply
                // (if user already opted in), backup warning (if no
                // backup), then startInstall. See attemptStart's
                // comment block near line 1300 for the full sequence.
                attemptStart();
              }}
              disabled={!config.weidu_path || !parsedLog}
            >
              {t("install.start", "Start Installation")}
            </button>
          </div>
        </div>

        {/* Phase 22: Defender pre-install modal. Gated by attemptStart;
         * this just renders it when showDefenderModal is true. The
         * resolver applies config changes and resumes the install flow. */}
        {showDefenderModal && config.bg2_game_dir && (
          <DefenderModal gameDir={config.bg2_game_dir} onResolve={onDefenderResolve} />
        )}

        {/* Backup warning dialog */}
        {showBackupWarning && (
          <div className="modal-backdrop">
            <div className="modal" style={{ maxWidth: 480 }}>
              <div className="modal-title" style={{ color: "var(--gold)" }}>{t("install.no_backup_title", "No Backup Found")}</div>
              <div className="modal-body">
                It's recommended to create a backup before a multi-hour install.
                You can create one from the Ready Check tab, or continue without one.
              </div>
              <div className="modal-actions">
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
        <div className={`phase-banner ${activePhase === "bg1" ? "cyan" : "gold"}`} style={{ padding: "5px 0", marginBottom: 8, fontSize: 11 }}>
          {activePhase === "bg1" ? "PRE-EET" : "EET"}
        </div>
      )}

      {/* ── Status Dashboard ──
       * Hidden on terminal states (aborted/complete). The post-install
       * summary block below is the single source of truth at that point —
       * keeping this visible duplicates stats and (on abort) leaves a stale
       * "currentMod" banner that implies the install is still running. */}
      {!isComplete && (
      <div className="install-dashboard">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div>
              <div className="current-mod" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span>
                  {isPaused ? t("install.paused", "Paused")
                    : currentMod
                      ? currentMod
                      : isComplete ? t("install.complete", "Installation complete")
                        : pauseRequested ? t("install.pausing", "Pausing after current mod...")
                          : combinedCurrent > 0 ? t("install.installing", "Installing...")
                            : t("install.starting", "Starting...")}
                </span>
                {slowBatchUi && (() => {
                  // Color encodes health:
                  //   known-slow      = blue  (expected slow, don't abort)
                  //   stalled / quiet = red   (WeiDU silent, possibly hung)
                  //   cascade         = orange (SFO memory-pressure decay)
                  //   scanning        = blue  (known-slow mod in expected silent phase)
                  //   progressing     = gold  (slow but producing output)
                  // Known-slow takes precedence over stalled/quiet because
                  // WeiDU output bursts on these components can legitimately
                  // pause for >30s. Install #21 lesson: the user interpreted
                  // dw_talents cn:60200's legitimate 60-min walk as a hang and
                  // aborted; this badge now surfaces the "expected" signal.
                  const hasKnownSlow = !!slowBatchUi.knownSlowReason;
                  const color = hasKnownSlow
                    ? "var(--blu, #4a90c0)"
                    : slowBatchUi.health === "scanning" ? "var(--blu, #4a90c0)"
                    : slowBatchUi.health !== "progressing" ? "var(--red)"
                    : slowBatchUi.cascade ? "var(--org)"
                    : "var(--gold)";
                  const verb = hasKnownSlow
                    ? "expected-slow"
                    : slowBatchUi.health === "scanning" ? "scanning"
                    : slowBatchUi.health === "stalled" ? "stalled"
                    : slowBatchUi.health === "quiet" ? "silent"
                    : slowBatchUi.cascade ? "slowing"
                    : "slow";
                  const ageStr = slowBatchUi.stdoutAgeS === null
                    ? t("install.slow_no_output", "no WeiDU output yet")
                    : slowBatchUi.stdoutAgeS < 60
                      ? `${t("install.slow_last_output", "last WeiDU output")} ${slowBatchUi.stdoutAgeS}s ${t("install.slow_ago", "ago")}`
                      : `${t("install.slow_last_output", "last WeiDU output")} ${Math.round(slowBatchUi.stdoutAgeS / 60)}m ${t("install.slow_ago", "ago")}`;
                  const tipTitle = hasKnownSlow
                    ? t("install.slow_tip_known", "Known-slow component — do not abort")
                    : slowBatchUi.health === "scanning" ? t("install.slow_tip_scanning", "Scanning phase")
                    : slowBatchUi.health === "stalled" ? t("install.slow_tip_stalled", "Batch stalled")
                    : slowBatchUi.health === "quiet" ? t("install.slow_tip_quiet", "No WeiDU output")
                    : slowBatchUi.cascade ? t("install.slow_tip_cascade", "Throughput dropping")
                    : t("install.slow_tip_slow", "Slow batch");
                  const tipDesc = hasKnownSlow
                      ? (slowBatchUi.knownSlowReason as string)
                      : slowBatchUi.health === "scanning"
                      ? t("install.slow_tip_scanning_desc", "{mod} does large full-game file iterations — quiet phases are expected, not a hang.").replace("{mod}", slowBatchUi.modName)
                      : slowBatchUi.cascade
                        ? t("install.slow_tip_cascade_desc", "Per-minute line rate is falling across recent samples — typically SFO memory-pressure as override/ grows. Consider enabling Redirect override to fast drive.")
                        : t("install.slow_tip_slow_desc", "This batch has been running longer than the heuristic threshold. Not necessarily broken — some heavy mods legitimately take minutes.");
                  return (
                    <Tip content={
                      <>
                        <span className="tip-title">{tipTitle}</span>
                        <span className="tip-meta">
                          {slowBatchUi.modName} {"\u2014"} {slowBatchUi.elapsedMin}m elapsed {"\u2014"} {ageStr}
                        </span>
                        <span className="tip-desc">{tipDesc}</span>
                        {slowBatchUi.lastLine && (
                          <span className="tip-warn" style={{ fontFamily: "'Fira Code', monospace", fontWeight: 400, fontSize: 10 }}>
                            {t("install.slow_tip_last_line", "Last line:")} {slowBatchUi.lastLine}
                          </span>
                        )}
                      </>
                    }>
                      <span
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 4,
                          padding: "2px 8px",
                          border: `1px solid ${color}`,
                          borderRadius: 10,
                          color,
                          background: "rgba(0,0,0,0.15)",
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: 0.5,
                          cursor: "help",
                        }}
                      >
                        {verb} {"\u2022"} {slowBatchUi.elapsedMin}m
                        {slowBatchUi.cascade && <span style={{ fontSize: 11 }}>{" \u26A0"}</span>}
                      </span>
                    </Tip>
                  );
                })()}
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

        <div className="progress-bar">
          <div className="fill" style={{ width: `${pct}%` }} />
        </div>

        {/* Pause/Abort pending banners */}
        {pauseRequested && !isPaused && (
          <div className="msg warn" style={{ marginTop: 8, fontSize: 12 }}>
            ⏸ Pause requested — will pause after the current mod finishes installing. This may take several minutes for large mods.
          </div>
        )}
        {isPaused && (
          <div
            className="msg"
            style={{
              marginTop: 8,
              fontSize: 12,
              // Green to match the "Resume" button colour and signal a
              // settled state — distinguishes from the amber "Pause
              // requested" banner above.
              borderColor: "var(--grn)",
              color: "var(--grn)",
              background: "rgba(16, 185, 129, 0.08)",
            }}
          >
            ⏸ Paused — the install is stopped at a mod boundary. Click Resume to continue; the elapsed timer is frozen.
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
              {effectiveTotal > 0 && (
                <span style={{ marginLeft: 6, fontSize: 11 }}>
                  ({Math.round((combinedCurrent / effectiveTotal) * 100)}%)
                </span>
              )}
            </span>
          </div>
          <div className={`stat${errorCount === 0 ? " zero" : ""}`}>
            <span className="stat-num" style={{ color: errorCount > 0 ? "var(--red)" : "var(--txd)" }}>
              {errorCount}
            </span>
            <span style={{ color: "var(--txd)" }}>errors</span>
          </div>
          <div className={`stat${warnCount === 0 ? " zero" : ""}`}>
            <span className="stat-num" style={{ color: warnCount > 0 ? "var(--org)" : "var(--txd)" }}>
              {warnCount}
            </span>
            <span style={{ color: "var(--txd)" }}>warnings</span>
          </div>
          <div className={`stat${skipCount === 0 ? " zero" : ""}`}>
            <span className="stat-num" style={{ color: skipCount > 0 ? "var(--tx-warn)" : "var(--txd)" }}>
              {skipCount}
            </span>
            <span style={{ color: "var(--txd)" }}>skipped</span>
          </div>
          <div className="stat" style={{ marginLeft: "auto", textAlign: "right", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
            <div>
              <span style={{ color: "var(--txd)", fontSize: 11 }}>
                {formatElapsed(elapsed)}
              </span>
              {eta && running && (
                <Tip content={
                  <>
                    <span className="tip-title">
                      {slowBatchUi
                        ? t("install.eta_tip_frozen_title", "ETA frozen")
                        : t("install.eta_tip_title", "Install time estimate")}
                    </span>
                    <span className="tip-meta">
                      {slowBatchUi
                        ? t("install.eta_tip_meta_frozen", "Heavy mod in progress")
                        : t("install.eta_tip_meta_active", "Based on smoothed throughput")}
                    </span>
                    <span className="tip-desc">
                      {slowBatchUi
                        ? t("install.eta_unreliable", "Heavy mod in progress — ETA is frozen because current throughput isn't representative of the rest of the install")
                        : t("install.eta_tooltip", "Estimate based on smoothed throughput; heavy mods ahead can still shift this significantly")}
                    </span>
                    {modsRemaining && modsRemaining.remaining > 0 ? (
                      <span className="tip-warn">
                        {modsRemaining.remaining} / {modsRemaining.total} {t("install.mods_remaining", "mods remaining")}
                      </span>
                    ) : null}
                    {/* When heavy mods are still pending, surface which
                     * ones. This is the "why does 46% done + 1h 22m
                     * elapsed say 7h remaining" answer — it's not broken
                     * math, it's heavy mods (SCS, dw_talents, mih_*)
                     * ahead with much longer per-component baselines. */}
                    {modsRemaining && modsRemaining.pendingHeavyMods.length > 0 && (
                      <span className="tip-desc" style={{ color: "var(--org)", fontSize: 11 }}>
                        {t("install.eta_heavy_pending", "Heavy mods pending — ETA includes their longer baselines:")}
                        {" "}{modsRemaining.pendingHeavyMods.slice(0, 4).join(", ")}
                        {modsRemaining.pendingHeavyMods.length > 4 && ` +${modsRemaining.pendingHeavyMods.length - 4}`}
                      </span>
                    )}
                  </>
                }>
                  <span
                    style={{
                      color: slowBatchUi ? "var(--org)" : "var(--gold)",
                      fontSize: 11, marginLeft: 8,
                      textDecoration: slowBatchUi ? "underline dotted" : undefined,
                      cursor: "help",
                    }}
                  >
                    {eta} {t("install.eta_remaining", "remaining")}{slowBatchUi ? "*" : ""}
                  </span>
                </Tip>
              )}
            </div>
            {(modsRemaining && modsRemaining.remaining > 0) || bcsCacheCurrent ? (
              <span style={{ color: "var(--txd)", fontSize: 10, letterSpacing: 0.2, display: "inline-flex", alignItems: "center", gap: 6 }}>
                {modsRemaining && modsRemaining.remaining > 0 && (
                  <span>{modsRemaining.remaining} / {modsRemaining.total} {t("install.mods_remaining", "mods remaining")}</span>
                )}
                {/* BCS buffer-cache readout — relocated from the current-mod
                 * row (where it jumped horizontally with mod-name length) to
                 * this stable stats line. Color still encodes rate so a
                 * glance tells you "is the cache helping right now":
                 *   disabled/cold = dim gray (noise — no actionable signal)
                 *   <50%   = orange (miss-heavy; likely eviction pressure)
                 *   50–90% = gold   (working as intended)
                 *   ≥90%   = green  (very effective)
                 * Full breakdown lives in the tooltip, not on-screen, because
                 * per-batch hit rate is mostly useful as a "is this batch
                 * exercising the cache" signal rather than a live KPI. */}
                {bcsCacheCurrent && (() => {
                  const c = bcsCacheCurrent;
                  const total = c.hits + c.misses;
                  const cold = c.enabled && total === 0;
                  const color = !c.enabled || cold ? "var(--txd)"
                    : c.hitRatePct >= 90 ? "var(--grn)"
                    : c.hitRatePct >= 50 ? "var(--gold)"
                    : "var(--org)";
                  const label = !c.enabled ? t("install.bcs_badge_disabled", "BCS off")
                    : cold ? t("install.bcs_badge_cold", "BCS idle")
                    : `${t("install.bcs_badge_prefix", "BCS")} ${c.hitRatePct.toFixed(0)}%`;
                  const tipTitle = !c.enabled
                    ? t("install.bcs_tip_disabled", "BCS cache disabled")
                    : cold
                      ? t("install.bcs_tip_cold", "BCS cache idle")
                      : t("install.bcs_tip_active", "BCS buffer cache");
                  const tipDesc = !c.enabled
                    ? t("install.bcs_tip_disabled_desc", "WEIDU_BCS_CACHE_MB=0 \u2014 the patched cache is off for this run. Useful as an A/B baseline; otherwise consider enabling it for faster BCS-heavy installs.")
                    : cold
                      ? t("install.bcs_tip_cold_desc", "The last batch didn't touch any BCS resources, so the cache had nothing to serve. Expected on non-scripting mods.")
                      : t("install.bcs_tip_active_desc", "Per-process stats from the last batch's WeiDU exit. Higher hit rate = more reuse of parsed BCS between components.");
                  return (
                    <>
                      {modsRemaining && modsRemaining.remaining > 0 && (
                        <span style={{ color: "var(--txd)", opacity: 0.6 }}>{"\u00b7"}</span>
                      )}
                      <Tip content={
                        <>
                          <span className="tip-title">{tipTitle}</span>
                          <span className="tip-meta">
                            {c.modName} {"\u2014"} {t("install.bcs_tip_batch", "batch")} #{c.batchIdx + 1}
                          </span>
                          <span className="tip-desc">{tipDesc}</span>
                          {c.enabled && total > 0 && (
                            <span className="tip-desc" style={{ fontFamily: "'Fira Code', monospace", fontSize: 10 }}>
                              {c.hits.toLocaleString()} hits / {c.misses.toLocaleString()} misses
                              {c.evictions > 0 && ` \u2014 ${c.evictions.toLocaleString()} evictions`}
                            </span>
                          )}
                          {c.enabled && c.peakKb > 0 && (
                            <span className="tip-desc" style={{ fontFamily: "'Fira Code', monospace", fontSize: 10 }}>
                              {t("install.bcs_tip_peak", "peak")} {formatCacheKb(c.peakKb)}
                              {c.maxMb > 0 && ` / ${c.maxMb} MB ${t("install.bcs_tip_budget", "budget")}`}
                            </span>
                          )}
                        </>
                      }>
                        <span style={{ color, cursor: "help" }}>{label}</span>
                      </Tip>
                    </>
                  );
                })()}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      )}

      {/* ── Batch Error Recovery ── */}
      {batchError && (
        <div className="alert err" style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 14px", marginTop: 8,
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
              <div
                className="summary-card"
                onClick={() => unattemptedMods.length > 0 && setUnattemptedExpanded(v => !v)}
                style={{ cursor: unattemptedMods.length > 0 ? "pointer" : "default" }}
                title={unattemptedMods.length > 0 ? "Click to see which mods didn't run" : undefined}
              >
                <div className="number" style={{ color: "var(--txd)" }}>
                  {effectiveTotal - combinedCurrent}
                </div>
                <div className="label">
                  {t("install.card_unattempted", "Unattempted")}
                  {unattemptedMods.length > 0 && (
                    <span style={{ marginLeft: 4, fontSize: 10, color: "var(--txd)" }}>
                      {unattemptedExpanded ? "\u25BC" : "\u25B6"}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: "var(--txd)", marginTop: 4 }}>
                  {wasAborted ? "install was aborted" : "mod not found or skipped entirely"}
                </div>
              </div>
            )}
          </div>
          {/* BCS buffer-cache aggregate card. Rendered only when the patched
           * WeiDU emitted stats at least once this run (i.e. the count
           * tracker has a non-zero value). Aggregates across every batch:
           *   - total lookups → overall hit rate
           *   - max peak_kb → high-water memory across any single batch
           *   - worst hit-rate batch (with a non-trivial lookup count, so a
           *     single-lookup cold start can't win "worst")
           * If every observed batch had the cache disabled, we render a
           * slimmer "A/B baseline" card that makes the disabled state clear
           * rather than showing 0% hit rate as if it were a cache problem. */}
          {bcsCacheHistoryCount > 0 && (() => {
            const h = bcsCacheHistoryRef.current;
            const totalHits = h.reduce((s, e) => s + e.hits, 0);
            const totalMisses = h.reduce((s, e) => s + e.misses, 0);
            const totalLookups = totalHits + totalMisses;
            const overallHitRate = totalLookups > 0 ? (totalHits / totalLookups) * 100 : 0;
            const totalEvictions = h.reduce((s, e) => s + e.evictions, 0);
            const peakKb = h.reduce((m, e) => Math.max(m, e.peakKb), 0);
            const anyEnabled = h.some((e) => e.enabled);
            const enabledBatches = h.filter((e) => e.enabled).length;
            // "Worst" means the batch with the lowest hit rate, among batches
            // that actually did meaningful work (≥100 lookups) — otherwise a
            // tiny-lookup fluke dominates the card. Undefined when no batch
            // cleared the threshold; in that case we just don't show the row.
            const MIN_LOOKUPS_FOR_WORST = 100;
            let worst: typeof h[number] | null = null;
            for (const e of h) {
              if (!e.enabled) continue;
              if (e.hits + e.misses < MIN_LOOKUPS_FOR_WORST) continue;
              if (!worst || e.hitRatePct < worst.hitRatePct) worst = e;
            }
            const maxMb = h.find((e) => e.enabled)?.maxMb || 0;

            if (!anyEnabled) {
              // A/B baseline run — cache was off for every batch. Show a
              // compact card so the user can see "yes, this was the no-cache
              // run" at a glance when comparing reports later.
              return (
                <div style={{
                  margin: "0 0 12px",
                  padding: "10px 12px",
                  background: "var(--bg2)",
                  border: "1px solid var(--brd)",
                  borderRadius: 6,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--txd)" }}>
                    {t("install.bcs_card_disabled_title", "BCS cache disabled (A/B baseline)")}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--txd)" }}>
                    {t("install.bcs_card_disabled_desc", "WEIDU_BCS_CACHE_MB=0 \u2014 {n} batch(es) ran without the BCS buffer cache.").replace("{n}", String(h.length))}
                  </div>
                </div>
              );
            }

            const headlineColor = overallHitRate >= 90 ? "var(--grn)"
              : overallHitRate >= 50 ? "var(--gold)"
              : "var(--org)";

            return (
              <div style={{
                margin: "0 0 12px",
                padding: "10px 12px",
                background: "var(--bg2)",
                border: "1px solid var(--brd)",
                borderRadius: 6,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <div style={{ fontFamily: "Cinzel, serif", fontSize: 13, fontWeight: 600, color: "var(--gold)" }}>
                    {t("install.bcs_card_title", "BCS Buffer Cache")}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--txd)" }}>
                    {enabledBatches === h.length
                      ? t("install.bcs_card_scope_all", "across {n} batch(es)").replace("{n}", String(h.length))
                      : t("install.bcs_card_scope_partial", "{enabled}/{total} batch(es) enabled").replace("{enabled}", String(enabledBatches)).replace("{total}", String(h.length))}
                  </div>
                </div>
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                  gap: 10,
                }}>
                  {/* Overall hit rate */}
                  <div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: headlineColor, fontFamily: "'Fira Code', monospace" }}>
                      {overallHitRate.toFixed(1)}%
                    </div>
                    <div style={{ fontSize: 10, color: "var(--txd)" }}>
                      {t("install.bcs_card_hit_rate", "overall hit rate")}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--txd)", marginTop: 2 }}>
                      {totalHits.toLocaleString()} / {totalLookups.toLocaleString()} {t("install.bcs_card_lookups", "lookups")}
                    </div>
                  </div>
                  {/* Peak memory */}
                  <div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: "var(--tx)", fontFamily: "'Fira Code', monospace" }}>
                      {formatCacheKb(peakKb)}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--txd)" }}>
                      {t("install.bcs_card_peak_memory", "peak memory")}
                    </div>
                    {maxMb > 0 && (
                      <div style={{ fontSize: 10, color: "var(--txd)", marginTop: 2 }}>
                        {t("install.bcs_card_of_budget", "of {mb} MB budget").replace("{mb}", String(maxMb))}
                      </div>
                    )}
                  </div>
                  {/* Evictions */}
                  <div>
                    <div style={{
                      fontSize: 20, fontWeight: 700, fontFamily: "'Fira Code', monospace",
                      color: totalEvictions > 0 ? "var(--org)" : "var(--tx)",
                    }}>
                      {totalEvictions.toLocaleString()}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--txd)" }}>
                      {t("install.bcs_card_evictions", "evictions")}
                    </div>
                    {totalEvictions > 0 && (
                      <div style={{ fontSize: 10, color: "var(--txd)", marginTop: 2 }}>
                        {t("install.bcs_card_evictions_hint", "budget pressure \u2014 consider raising cache size")}
                      </div>
                    )}
                  </div>
                  {/* Worst batch */}
                  {worst && (
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--org)", fontFamily: "'Fira Code', monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {worst.hitRatePct.toFixed(0)}% {"\u2014"} {worst.modName}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--txd)" }}>
                        {t("install.bcs_card_worst_batch", "worst-rate batch")}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--txd)", marginTop: 2 }}>
                        {(worst.hits + worst.misses).toLocaleString()} {t("install.bcs_card_lookups", "lookups")}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
          {/* Unattempted mods drawer — shows WHICH mods never got their
           * components attempted. On abort, typically the tail of the install
           * plan; on non-abort completion, usually mods missing from the mod
           * directory or excluded. */}
          {unattemptedExpanded && unattemptedMods.length > 0 && (
            <div style={{
              margin: "0 0 12px",
              padding: "10px 12px",
              background: "var(--row-alt)",
              border: "1px solid var(--brd)",
              borderRadius: 6,
              maxHeight: 260,
              overflowY: "auto",
            }}>
              <div style={{ fontSize: 11, color: "var(--txd)", marginBottom: 6 }}>
                {unattemptedMods.length} {unattemptedMods.length === 1 ? "mod" : "mods"} didn't run
                {wasAborted ? " (install aborted before reaching them)" : ""}
              </div>
              {unattemptedMods.map((m) => (
                <div key={m.tp2} style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(150px,1fr) 44px minmax(0,2fr)",
                  gap: 8,
                  padding: "3px 0",
                  fontSize: 12,
                  color: "var(--tx)",
                  borderBottom: "1px dashed var(--row-separator)",
                }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.displayName}
                    {m.displayName !== m.tp2 && (
                      <span style={{ color: "var(--txd)", fontSize: 10, marginLeft: 4 }}>({m.tp2})</span>
                    )}
                  </span>
                  <span style={{ color: "var(--txd)", textAlign: "right" }}>×{m.count}</span>
                  <span style={{ color: "var(--txd)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.components.slice(0, 3).join(", ")}
                    {m.components.length > 3 && ` +${m.count - 3} more`}
                  </span>
                </div>
              ))}
            </div>
          )}
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
            {lastTrace && lastTrace.entries.length >= 30 && (
              <>
                <button
                  className="btn"
                  onClick={async () => {
                    try {
                      const dir = config.bg2_game_dir?.replace(/\\/g, "/");
                      if (!dir) throw new Error("BG2 game directory not configured");
                      const date = lastTrace.timestamp.substring(0, 10);
                      const id = lastTrace.id.substring(0, 8);
                      const filename = `install-trace-${date}-${id}.json`;
                      await saveInstallReport(serializeTrace(lastTrace), `${dir}/${filename}`);
                      guiLog.info("INSTALL", `Install trace saved: ${filename} (${lastTrace.entries.length} components)`);
                    } catch (e) {
                      guiLog.error("INSTALL", `Failed to save install trace: ${e}`);
                    }
                  }}
                  title={t("install.save_trace_hint", "Save per-component timing JSON next to the install report. Contributes to ETA accuracy improvements.")}
                >
                  {t("install.save_trace", "Save Trace")} ({traceEntryCount})
                </button>
                {config.telemetry_opt_in === true && (
                  <button
                    className="btn"
                    onClick={async () => {
                      const ok = await shareTraceOnGitHub(lastTrace);
                      if (ok) {
                        guiLog.info("INSTALL", "Trace copied to clipboard and GitHub opened");
                      }
                    }}
                    title={t("install.share_trace_hint", "Copies anonymized trace to clipboard and opens GitHub. Paste and submit to help improve ETA baselines.")}
                  >
                    {t("install.share_trace", "Share Trace")}
                  </button>
                )}
              </>
            )}
            {/* Phase 21c: open the per-game data folder — where
             * install.log, reports, checkpoint, and guard state live
             * for THIS game. Saves users from typing their data dir +
             * hash by hand when they want to inspect the install that
             * just finished. */}
            <button
              className="btn"
              onClick={async () => {
                try {
                  const lp = await getLogPaths(config);
                  const target = lp.paths.game_data_dir;
                  if (target) await openPath(target);
                } catch (e) {
                  guiLog.warn("INSTALL", `Open install folder failed: ${e}`);
                }
              }}
              title={t("install.open_install_folder_hint", "Open the per-game data folder (install.log, reports, checkpoint)")}
            >
              {t("install.open_install_folder", "Open install folder")}
            </button>
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
              // Reset the buffer cap to install default in case the previous
              // run was a dry run that uncapped it.
              logBufferSizeRef.current = INSTALL_LOG_BUFFER_SIZE;
              setLogBufferSize(INSTALL_LOG_BUFFER_SIZE);
              if (errorFlushTimer.current) { clearTimeout(errorFlushTimer.current); errorFlushTimer.current = null; }
              setExpandedGroups(new Set());
              setInputNeeded(null);
              setInputValue("");
              setLogExpanded(false);
              setLogStickToBottom(true);
              throughputSamples.current = [];
              smoothedRateRef.current = null;
                        traceRecorderRef.current = new TraceRecorder();
              setTraceEntryCount(0);
              setLastTrace(null);
              setReportState("idle");
              setLastReport(null);
              setEta(null);
              bcsCacheHistoryRef.current = [];
              setBcsCacheHistoryCount(0);
              setBcsCacheCurrent(null);
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
                {t("install.telemetry_desc", "Share anonymized install outcomes (mod IDs + pass/fail \u2014 no file paths or personal info) with the Infinity Engine community. Reports are submitted as GitHub Issues so you can see exactly what's shared.")}
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
      {errorEntries.length > 0 && (() => {
        // Filter chips at top right are toggles. Empty filter set = show all.
        // Active filter restricts to the chosen levels. Dim inactive chips so
        // the user can see what's available vs. what's currently shown.
        const anyFilter = issueFilters.size > 0;
        // With merged-by-mod grouping, a row matches a filter if any of its
        // entries' levels is in the active filter set. This keeps the filter
        // chips intuitive ("1 error" shows every mod that had an error, even
        // if that mod also has warnings/skips visible in the expanded view).
        const filteredGroups = anyFilter
          ? groupedIssues.filter((g) => {
              for (const lvl of g.levelsPresent) {
                if (issueFilters.has(lvl as "ERROR" | "WARN" | "SKIP" | "RETRY")) return true;
              }
              return false;
            })
          : groupedIssues;

        // Per-row summary helpers — single source of truth for row text.
        // Count is rendered separately in the col-count column, so the prose
        // here never repeats the count.
        const summarize = (group: typeof groupedIssues[number]): React.ReactNode => {
          // Single entry: show its message verbatim with a contextual tag.
          if (group.entries.length === 1) {
            const e = group.entries[0];
            if (e.level === "ERROR") {
              return (
                <>
                  {e.message}
                  <span style={{ color: exitCodeColor(categorizeExitCode(e.message)), marginLeft: 6, fontSize: 10 }}>
                    [{exitCodeLabel(categorizeExitCode(e.message))}]
                  </span>
                </>
              );
            }
            if (e.level === "SKIP" && categorizeSkip(e.message) === "missing-from-log") {
              return (
                <>
                  {e.message}
                  <span style={{ color: "var(--org)", marginLeft: 6, fontSize: 10 }}>
                    [Suspicious]
                  </span>
                </>
              );
            }
            return e.message;
          }
          // Multi-entry: summarize per-level counts (e.g. "1 error, 2 warnings").
          // Drops zero-count levels so the text stays tight.
          const parts: React.ReactNode[] = [];
          if (group.errorCount > 0) {
            parts.push(
              <span key="err">
                {group.errorCount} {group.errorCount === 1 ? "error" : "errors"}
                {group.crashCount > 0 && (
                  <span style={{ color: "var(--pur)", marginLeft: 4 }}>
                    ({group.crashCount} {group.crashCount === 1 ? "crash" : "crashes"})
                  </span>
                )}
              </span>
            );
          }
          if (group.warnCount > 0) {
            parts.push(
              <span key="warn">{group.warnCount} {group.warnCount === 1 ? "warning" : "warnings"}</span>
            );
          }
          if (group.skipCount > 0) {
            parts.push(
              <span key="skip">
                {group.skipCount} skipped
                {group.missingFromLogCount > 0 && (
                  <span style={{ color: "var(--org)", marginLeft: 4 }}>
                    ({group.missingFromLogCount} suspicious)
                  </span>
                )}
              </span>
            );
          }
          if (group.retryCount > 0) {
            parts.push(
              <span key="retry">{group.retryCount} {group.retryCount === 1 ? "retry" : "retries"}</span>
            );
          }
          // Interleave with commas
          const out: React.ReactNode[] = [];
          parts.forEach((p, i) => {
            if (i > 0) out.push(<span key={`sep-${i}`}>, </span>);
            out.push(p);
          });
          return <>{out}</>;
        };

        return (
          <div className="error-timeline">
            <div className="error-timeline-header">
              <h3>Issues</h3>
              <div className="badges">
                {/* "All" — clears the filter set so every group is shown.
                 * Highlighted when no other filter is active. Clicking it
                 * while no filter is active is a no-op (already showing all). */}
                <button
                  type="button"
                  className={`filter-btn all ${!anyFilter ? "active" : ""}`}
                  onClick={() => setIssueFilters(new Set())}
                  title={anyFilter ? "Clear filters — show all issues" : "Showing all issues"}
                >
                  All ({groupedIssues.length})
                </button>
                {errorCount > 0 && (
                  <button
                    type="button"
                    className={`filter-btn errors ${anyFilter && !issueFilters.has("ERROR") ? "dimmed" : ""}`}
                    onClick={() => toggleIssueFilter("ERROR")}
                    title="Toggle error filter"
                  >
                    {errorCount} errors
                    {totalCrashes > 0 && ` (${totalCrashes} crashes)`}
                  </button>
                )}
                {warnCount > 0 && (
                  <button
                    type="button"
                    className={`filter-btn warnings ${anyFilter && !issueFilters.has("WARN") ? "dimmed" : ""}`}
                    onClick={() => toggleIssueFilter("WARN")}
                    title="Toggle warning filter"
                  >
                    {warnCount} warnings
                  </button>
                )}
                {skipCount > 0 && (
                  <button
                    type="button"
                    className={`filter-btn skipped ${anyFilter && !issueFilters.has("SKIP") ? "dimmed" : ""}`}
                    onClick={() => toggleIssueFilter("SKIP")}
                    title="Toggle skip filter"
                  >
                    {skipCount} skipped
                    {suspiciousSkips > 0 && (
                      <span style={{ color: "var(--org)" }}> ({suspiciousSkips} suspicious)</span>
                    )}
                  </button>
                )}
                {/* Sort-mode toggle — a small segmented control on the right
                 * side of the header. Kept close to the filter chips
                 * visually so "how is this list ordered" is discoverable
                 * from the same scanning glance that lands on the filters. */}
                {groupedIssues.length > 1 && (
                  <div
                    className="segmented"
                    role="group"
                    aria-label={t("install.issue_sort_aria", "Sort Issues")}
                    style={{ marginLeft: 8, fontSize: 11 }}
                  >
                    <button
                      type="button"
                      className={`segmented-btn${issueSortMode === "newest" ? " ac" : ""}`}
                      onClick={() => setIssueSortMode("newest")}
                      title={t("install.issue_sort_newest_hint", "Show most recent activity first")}
                    >
                      {t("install.issue_sort_newest", "Newest")}
                    </button>
                    <button
                      type="button"
                      className={`segmented-btn${issueSortMode === "severity" ? " ac" : ""}`}
                      onClick={() => setIssueSortMode("severity")}
                      title={t("install.issue_sort_severity_hint", "Show highest severity first")}
                    >
                      {t("install.issue_sort_severity", "Severity")}
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="error-timeline-list" ref={errorTimelineRef}>
              {filteredGroups.map((group) => {
                // Key by mod_name alone — groups are now merged per-mod.
                const key = `mod:${group.mod_name.toLowerCase()}`;
                const isExpanded = expandedGroups.has(key);
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
                    <div
                      className={`issues-row level-${group.level.toLowerCase()}`}
                      onClick={toggleExpand}
                    >
                      <span className="col-time">
                        {formatTimestamp(group.firstTime, startTime)}
                      </span>
                      <span className="col-arrow">
                        {isExpanded ? "\u25BC" : "\u25B6"}
                      </span>
                      {(() => {
                        // Prefer the Forge display name over the raw tp2 ID,
                        // and append the tp2 in a small dim chip so users
                        // who know the mod by either name can find it.
                        const tp2 = group.mod_name;
                        const display = modDisplayNames.current.get(tp2.toLowerCase()) || tp2;
                        const showTp2 = display !== tp2;
                        return (
                          <span className="col-mod" title={showTp2 ? `${display} (${tp2}.tp2)` : tp2}>
                            {display}
                            {showTp2 && <span className="tp2">({tp2}.tp2)</span>}
                          </span>
                        );
                      })()}
                      <span className="col-msg">
                        <span className="msg-text">{summarize(group)}</span>
                        {/* Classification chip: renders only for WARN rows
                         * where the Rust runner captured WARNING: lines and
                         * the catalog classified them. Sits in a
                         * flex-shrink:0 slot so it never gets truncated by
                         * the ellipsis that trims long message text — the
                         * previous inline layout was eating the chip ("12
                         * cosmetic · 12 unk..."). Color reflects the worst
                         * category present; label shows the count
                         * breakdown. */}
                        {(() => {
                          const cls = groupClassifications.get(group.mod_name.toLowerCase());
                          if (!cls || cls.summary.total === 0) return null;
                          const colors = categoryColor(cls.summary.worstCategory);
                          return (
                            <span
                              className="msg-badge"
                              style={{
                                padding: "1px 7px",
                                borderRadius: 10,
                                fontSize: 10,
                                color: colors.fg,
                                background: colors.bg,
                                border: `1px solid ${colors.border}`,
                                whiteSpace: "nowrap",
                                verticalAlign: "baseline",
                              }}
                              title={`${cls.summary.total} WARNING line(s) captured. Expand for per-line classification.`}
                            >
                              {summaryText(cls.summary)}
                            </span>
                          );
                        })()}
                      </span>
                      <span className="col-tag">[{group.level}]</span>
                    </div>
                    {isExpanded && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 2, marginBottom: 4 }}>
                        {(() => {
                          // Build a per-component classification lookup we
                          // can render inline. `groupClassifications` is
                          // indexed by group (mod); we fan it back out to
                          // match entries 1:1 via filtering to WARN entries
                          // with captured warnings, same order as the
                          // classifier consumed.
                          const cls = groupClassifications.get(group.mod_name.toLowerCase());
                          const warnEntries = group.entries.filter(
                            (e) => e.level === "WARN" && e.warnings && e.warnings.length > 0,
                          );
                          const classifiedFor = new Map<number, ClassifiedWarning[]>();
                          if (cls) {
                            for (let idx = 0; idx < warnEntries.length; idx++) {
                              const entry = warnEntries[idx];
                              const entryIdxInGroup = group.entries.indexOf(entry);
                              classifiedFor.set(entryIdxInGroup, cls.classified[idx] || []);
                            }
                          }
                          return group.entries.map((entry, i) => (
                            <div key={i} className={`issues-child level-${entry.level.toLowerCase()}`}>
                              <span className="col-time">
                                {formatTimestamp(entry.timestamp, startTime)}
                              </span>
                              <span className="col-arrow"></span>
                              <span className="col-msg">
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
                                {/* Per-WARNING classification details: when the
                                 * Rust runner captured WARNING: lines and the
                                 * catalog classified them, show each line with
                                 * a category pill. Lines that didn't match any
                                 * catalog entry render as "unknown" — a signal
                                 * to the user (and future triage) that this
                                 * pattern deserves a `ki` entry. */}
                                {(classifiedFor.get(i) || []).length > 0 && (
                                  <div style={{ marginTop: 4, paddingLeft: 12, display: "flex", flexDirection: "column", gap: 2 }}>
                                    {(classifiedFor.get(i) || []).map((cw, j) => {
                                      const c = categoryColor(cw.category);
                                      return (
                                        <div key={j} style={{ fontSize: 10, display: "flex", alignItems: "baseline", gap: 6 }}>
                                          <span
                                            style={{
                                              padding: "0 6px",
                                              borderRadius: 8,
                                              color: c.fg,
                                              background: c.bg,
                                              border: `1px solid ${c.border}`,
                                              whiteSpace: "nowrap",
                                              fontWeight: 600,
                                            }}
                                          >
                                            {categoryLabel(cw.category)}
                                          </span>
                                          <span style={{ color: "var(--txd)", fontFamily: "monospace", fontSize: 10 }}>
                                            {cw.line.length > 160 ? cw.line.slice(0, 160) + "…" : cw.line}
                                          </span>
                                          {cw.match?.description && (
                                            <span
                                              style={{ color: "var(--tx2)", fontStyle: "italic", marginLeft: 4 }}
                                              title={cw.match.workaround || undefined}
                                            >
                                              — {cw.match.description.length > 80
                                                  ? cw.match.description.slice(0, 80) + "…"
                                                  : cw.match.description}
                                            </span>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </span>
                              <span className="col-tag">[{entry.level}]</span>
                            </div>
                          ));
                        })()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

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
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {logExpanded && (
            <>
              <button
                className="btn"
                title={t("install.log_fit_hint", "Fit log to ~75% of the window")}
                style={{ fontSize: 11, padding: "2px 10px", opacity: 0.7 }}
                onClick={(e) => { e.stopPropagation(); setLogHeight(computeFitHeight()); }}
              >
                {t("install.log_fit", "Fit")}
              </button>
              <button
                className="btn"
                title={t("install.log_reset_hint", "Reset log height to the default")}
                style={{ fontSize: 11, padding: "2px 10px", opacity: 0.7 }}
                onClick={(e) => { e.stopPropagation(); setLogHeight(350); }}
              >
                {t("install.log_reset", "Reset")}
              </button>
            </>
          )}
          <span style={{ fontSize: 11, marginLeft: 4 }}>
            {logExpanded ? t("install.click_collapse", "Click to collapse") : t("install.click_expand", "Click to expand")}
          </span>
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
          <ResizablePanel
            ref={logContainerRef}
            className="log-output"
            height={logHeight}
            onHeightChange={setLogHeight}
            minHeight={120}
            // No maxHeight — let the user drag as tall as they want.
            // ResizablePanel falls back to its internal 10000px sentinel; the
            // outer .panel container's own scrolling handles overflow when
            // the log grows beyond viewport.
            onScroll={handleLogScroll}
          >
            {totalLineCount > logBufferSize && !logSearch && (
              <div style={{ color: "var(--txd)", fontSize: 11, padding: "4px 0", borderBottom: "1px solid var(--brd)", marginBottom: 4 }}>
                ... {(totalLineCount - logBufferSize).toLocaleString()} earlier lines not shown
              </div>
            )}
            {(() => {
              // Log line rendering. Each LogLine already carries a `count`
              // field populated at ingestion time (see addLine) so consecutive
              // identical lines are a single entry with count=N — not N
              // duplicate entries needing render-time grouping. The ingestion
              // dedupe correctly reflects the full stream; the previous
              // render-time-only approach capped visible counts at 500
              // because it only saw the ring-buffer window.
              //
              // Search path shows every matching line verbatim (no count
              // chip) so the user can scan matches one-by-one.
              const rawLines = logSearch
                ? displayLines.filter((l) => l.text.toLowerCase().includes(logSearch.toLowerCase()))
                : displayLines;
              return rawLines.map((line, i) => (
                <div
                  key={i}
                  className={
                    line.type === "stderr" ? "log-err"
                      : line.type === "system" ? "log-progress"
                      : ""
                  }
                >
                  {line.text}
                  {!logSearch && line.count && line.count > 1 && (
                    <span style={{ color: "var(--txd)", marginLeft: 8, fontSize: 10 }}>
                      {" \u00D7"}{line.count.toLocaleString()}
                    </span>
                  )}
                </div>
              ));
            })()}
            <div ref={logEndRef} />
          </ResizablePanel>
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

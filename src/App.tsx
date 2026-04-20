import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { guiLog, installGlobalErrorHandlers, rotateGuiLog } from "./lib/gui-logger";
import { forgeDataAgeMs } from "./lib/forge-data";
import { I18nProvider, LanguageSelector, useI18n } from "./lib/i18n";
import { validateGameDir, checkGameFreshness, scanModDirectory, getBinaryVersion, readFileContents, type GameFreshness, type ModDirScan } from "./lib/tauri-bridge";
import { buildParsedLog } from "./lib/log-parser";
import SetupWizard from "./components/SetupWizard";
import ModsPanel from "./components/ModsPanel";
import ReadyCheck from "./components/ReadyCheck";
import InstallRunner from "./components/InstallRunner";
import DebugPanel from "./components/DebugPanel";
import Tip from "./components/Tip";

export interface AppConfig {
  bg2_game_dir: string | null;
  bg1_game_dir: string | null;
  /** IWD:EE install directory. Optional — only used for backup/restore
   * coverage when mods touch IWD (cross-game content, some tweaks). */
  iwd_game_dir: string | null;
  /** Icewind Dale II install directory. Optional — same role as iwd_game_dir. */
  iwd2_game_dir: string | null;
  /** Planescape: Torment EE install directory. Optional — same role as iwd_game_dir. */
  pst_game_dir: string | null;
  mod_directory: string | null;
  weidu_path: string | null;
  forge_data_url: string | null;
  last_log_path: string | null;
  // Persisted log paths (remembered across sessions)
  eet_log_path: string | null;
  bgee_log_path: string | null;
  // Install options — essential
  skip_installed: boolean;
  timeout: number;
  download_mods: boolean;
  abort_on_warnings: boolean;
  never_abort: boolean;
  bcs_scanner: boolean;
  auto_skip_after_retry: boolean;
  suppress_readmes: boolean;
  pause_on_guard: boolean;
  /** If true, orchestrator redirects game/override to a fast drive (SSD or
   * RAM disk) for the duration of the install, then restores it.
   * Can speed up SFO-heavy mods significantly when target is a RAM disk. */
  override_fast_drive: boolean;
  /** Target path for override redirect. Empty = system temp directory.
   * Should be a different volume than the game for any benefit. */
  override_fast_drive_path: string;
  /** Delete original files from override/ after the mid-install MAKE_BIFF
   * succeeds. Default true — without this, MAKE_BIFF is effectively a no-op
   * for performance because WeiDU's resource resolution hits override/ first
   * and loads from disk. With this on, override drops to a handful of files
   * post-BIFF and SFO-heavy mods run dramatically faster. Advanced users
   * can disable if they have a mod that iterates override/ directly. The
   * A/B test harness in `weidu_experimental/tools/` can override this via
   * `install_config.json::enable_biff_delete_optimization`. */
  enable_biff_delete_optimization: boolean;
  /** Experimental: when true, installer uses the bundled patched WeiDU
   * binary instead of the one at `weidu_path`. The orchestrator extracts
   * the bundled binary into the data directory and invokes that path. */
  use_experimental_weidu: boolean;
  /** Per-batch component ceiling passed to the orchestrator. Heavy mods
   * (dw_talents, stratagems, mih_*, trap_overhaul) are independently
   * capped at `heavy_batch_size` regardless of this value. Default 25. */
  max_batch_size: number;
  /** Per-batch cap for heavy mods (dw_talents, stratagems, mih_*,
   * trap_overhaul). These historically segfault WeiDU's OCaml GC with
   * large batches — default 3 has been reliably safe. Raising this is a
   * stress-test setting; segfaults above ~10 are likely and will trigger
   * the orchestrator's segfault-retry path. Clamped 1..=25 in UI. */
  heavy_batch_size: number;
  // Install options — advanced
  language: string;
  /** Fallback WeiDU language — used when a specific mod doesn't provide
   * translations for `language`. Defaults to `en_US`. Retry-on-fallback
   * logic in the Rust orchestrator is still TODO (tracked as Phase 6c). */
  language_fallback: string;
  depth: number;
  strict_matching: boolean;
  overwrite: boolean;
  check_last_installed: boolean;
  tick: number;
  lookback: number;
  weidu_log_mode: string;
  casefold: boolean;
  generic_weidu_args: string;
  telemetry_opt_in: boolean | null;
  backup_directory: string | null;
  /** Optional per-game backup directory overrides. When set, the panel
   * uses this path for that game instead of `backup_directory`. Useful
   * when games live on different drives and you want their backups
   * co-located. `null` (the default) means "use the global path". */
  backup_directory_bg1: string | null;
  backup_directory_bg2: string | null;
  backup_directory_iwd: string | null;
  backup_directory_iwd2: string | null;
  backup_directory_pst: string | null;
  data_directory: string | null;
  ui_language: string | null;
  /** First-run welcome-card dismissal timestamp (ISO8601). When null, the
   * card shows on launches where `bg2_game_dir` is also empty (i.e. fresh
   * install). Set to an ISO date when the user clicks "Got it, let's go"
   * or the card's × button. One-way door — we don't offer a "re-show"
   * affordance because a returning user seeing a welcome is worse than a
   * first-timer missing one. */
  welcome_dismissed_at: string | null;
  /** Opt-in guided mode: locks tabs in sequence and shows Next buttons.
   * Default false — toggled from Setup. Recommended for first-time
   * users; existing users leave it off for free navigation. */
  guided_mode: boolean;
  /** JSON-serialized snapshot of the user's preferred install-tab
   * settings. Written by "Save my preferences", read by "Restore my
   * preferences". Null when the user has never saved. The shape is
   * opaque to TS here because the frontend (InstallRunner) is the
   * authority on which keys go in; this is just the persistence hook. */
  saved_install_defaults: string | null;
  /** Phase 22: when true, the orchestrator adds the BG2 game directory
   * to Windows Defender's exclusion list before each install. Triggers
   * one UAC prompt on installs where the exclusion isn't already in
   * place. Default false; set by the first-run modal or toggled via
   * Install → Advanced. Non-Windows platforms ignore this entirely. */
  auto_defender_exclusion: boolean;
  /** Phase 22: sticky "Don't ask again" choice for the pre-install
   * Defender modal. Once true, the modal never re-appears; the
   * Advanced-tab checkbox remains the opt-in path. */
  defender_prompt_dismissed: boolean;
}

export interface ParsedLog {
  entries: LogEntry[];
  bgeeEntries: LogEntry[] | null;
  modCount: number;
  componentCount: number;
  raw: string;
  bgeeRaw: string | null;
  eetLogPath: string | null;
  bgeeLogPath: string | null;
  /** If loaded from a preset/community build, tracks the source */
  presetSource?: { name: string; type: "preset" | "build"; componentCount: number } | null;
}

export interface LogEntry {
  tp_file: string;
  mod_name: string;
  lang: string;
  component: string;
  component_name: string;
  sub_component: string;
  version: string;
}

/** Per-component install status — key is "mod_name:component" */
export type InstallStatusMap = Map<string, "success" | "warning" | "error" | "skipped" | "already">;

/** Per-component issue detail — key is "mod_name:component". Populated for
 * components that errored, warned, or were skipped; plain-success entries
 * are not stored here. Used by both the Install tab (Issues panel) and the
 * Mods tab (per-mod expand view) to show WHY something failed. */
export type InstallIssue = {
  level: "ERROR" | "WARN" | "SKIP";
  componentName: string;
  message?: string;
  timestamp: string;
  /** Raw `WARNING:` lines captured by the Rust runner during the component's
   * install. The Issues panel feeds these through `warning-classifier.ts` to
   * render a cosmetic-vs-unknown breakdown instead of treating every
   * "Installed with warnings" identically. Undefined/empty for components
   * that didn't emit any WARNING lines (the default). */
  warnings?: string[];
};
export type InstallIssueMap = Map<string, InstallIssue>;

export interface PreFlightResult {
  messages: { t: "err" | "warn" | "info" | "ok" | "action"; m: string; actionId?: string }[];
  passed: boolean;
  checkedAt: number;
  patchesAvailable: number;
  patchesApplied: boolean;
  backupExists: boolean;
  backupName?: string;
}

/** Summary of download readiness — reported by DownloadPanel, consumed by PreFlight */
export interface DownloadReadiness {
  totalMods: number;
  alreadyHave: number;
  missingNames: string[];  // mod names not on disk
  builtAt: number;         // timestamp when plan was built
}

/** Key for excluding a component: "mod_name:component_number" */
export type ExcludeKey = string;

export interface PausePoint {
  afterModIndex: number;  // index in the entries array after which to pause
  message: string;        // user-defined message shown at pause
  // "eet" names the BG2:EE+SoD merged install phase (driven by the EET mod).
  // It is NOT the Infinity Mod Runner tool name — do not rename as part of suite branding.
  phase: "bgee" | "eet";
}

export type Tab = "setup" | "mods" | "preflight" | "install" | "debug";

const TABS: { id: Tab; label: string; tKey: string }[] = [
  { id: "setup", label: "Setup", tKey: "tab.setup" },
  { id: "mods", label: "Mods", tKey: "tab.mods" },
  { id: "preflight", label: "Ready Check", tKey: "tab.ready_check" },
  { id: "install", label: "Install", tKey: "tab.install" },
  { id: "debug", label: "Debug", tKey: "tab.debug" },
];

export { DEFAULT_FORGE_URL } from "./constants/forge";
import { DEFAULT_FORGE_URL } from "./constants/forge";
import { APP_VERSION } from "./constants/version";
import { DEFAULT_INSTALL_TIMEOUT_S, DEFAULT_MAX_BATCH, DEFAULT_HEAVY_BATCH, DEFAULT_POLL_TICK_MS, DEFAULT_LOOKBACK, DEFAULT_DEPTH, DEFAULT_WEIDU_LOG_MODE, DEFAULT_WEIDU_LANGUAGE } from "./constants/installer";
import { FORGE_STALE_MS, FORGE_WEB_URL } from "./constants/forge";
import { FOOTER_AGE_TICK_MS, SPLASH_LOGO_PX, SPLASH_PROGRESS_WIDTH_PX } from "./constants/ui";

const defaultConfig: AppConfig = {
  bg2_game_dir: null,
  bg1_game_dir: null,
  iwd_game_dir: null,
  iwd2_game_dir: null,
  pst_game_dir: null,
  mod_directory: null,
  weidu_path: null,
  forge_data_url: DEFAULT_FORGE_URL,
  last_log_path: null,
  eet_log_path: null,
  bgee_log_path: null,
  skip_installed: true,
  timeout: DEFAULT_INSTALL_TIMEOUT_S,
  download_mods: false,
  abort_on_warnings: false,
  never_abort: false,
  bcs_scanner: false,
  auto_skip_after_retry: false,
  suppress_readmes: true,
  pause_on_guard: false,
  override_fast_drive: false,
  override_fast_drive_path: "",
  enable_biff_delete_optimization: true,
  use_experimental_weidu: false,
  max_batch_size: DEFAULT_MAX_BATCH,
  heavy_batch_size: DEFAULT_HEAVY_BATCH,
  language: DEFAULT_WEIDU_LANGUAGE,
  language_fallback: DEFAULT_WEIDU_LANGUAGE,
  depth: DEFAULT_DEPTH,
  strict_matching: false,
  overwrite: false,
  check_last_installed: true,
  tick: DEFAULT_POLL_TICK_MS,
  lookback: DEFAULT_LOOKBACK,
  weidu_log_mode: DEFAULT_WEIDU_LOG_MODE,
  casefold: false,
  generic_weidu_args: "",
  telemetry_opt_in: null,
  backup_directory: null,
  backup_directory_bg1: null,
  backup_directory_bg2: null,
  backup_directory_iwd: null,
  backup_directory_iwd2: null,
  backup_directory_pst: null,
  data_directory: null,
  ui_language: null,
  welcome_dismissed_at: null,
  guided_mode: false,
  saved_install_defaults: null,
  auto_defender_exclusion: false,
  defender_prompt_dismissed: false,
};

type TabStatus = "pending" | "done" | "warn" | "err" | "active";

const TAB_STATUS_DESC: Record<TabStatus, string> = {
  pending: "Not yet started or incomplete",
  done: "Ready to move on",
  warn: "Completed with warnings — review before installing",
  err: "Errors reported — check the details in this tab",
  active: "Currently running",
};

function TabBar({ tab, setTab, canInstall, installRunning, statuses, guidedMode, guidedLocks }: {
  tab: Tab;
  setTab: (t: Tab) => void;
  canInstall: boolean;
  installRunning: boolean;
  statuses: Record<Tab, TabStatus>;
  /** Phase 14: when true, downstream tabs are gated on prerequisites. */
  guidedMode: boolean;
  /** Per-tab lock reason in guided mode. Missing entry = unlocked.
   * Value is the user-facing explanation ("Finish Setup first", etc.)
   * used in the hover tooltip and the toast when they click a locked tab. */
  guidedLocks: Partial<Record<Tab, string>>;
}) {
  const { t } = useI18n();
  const [lockToast, setLockToast] = useState<string | null>(null);
  return (
    <div className="tab-bar">
      {TABS.map(({ id, label, tKey }) => {
        const status = statuses[id];
        const displayLabel = t(tKey, label);
        // Phase 14: guided-mode lock is a soft gate — clicking shows a
        // toast rather than silently doing nothing. The existing
        // canInstall/installRunning gate on the install tab still
        // applies as a hard gate regardless of guided mode.
        const guidedLockReason = guidedMode ? guidedLocks[id] : undefined;
        const hardDisabled = id === "install" && !canInstall && !installRunning;
        const visuallyLocked = !!guidedLockReason || hardDisabled;
        return (
          <button
            key={id}
            className={[
              tab === id ? "active" : "",
              visuallyLocked ? "disabled" : "",
            ].filter(Boolean).join(" ")}
            onClick={() => {
              if (hardDisabled) return;
              if (guidedLockReason) {
                setLockToast(guidedLockReason);
                setTimeout(() => setLockToast(null), 2400);
                return;
              }
              if (id !== tab) guiLog.debug("UI", `Tab: ${displayLabel}`, { writeToFile: false });
              setTab(id);
            }}
          >
            <Tip content={
              <>
                <span className="tip-title">{displayLabel}</span>
                <span className="tip-meta">
                  {guidedLockReason
                    ? t("tab.status.locked", "LOCKED")
                    : t(`tab.status.${status}`, status.toUpperCase())}
                </span>
                <span className="tip-desc">
                  {guidedLockReason ?? t(`tab.status_desc.${status}`, TAB_STATUS_DESC[status])}
                </span>
              </>
            }>
              <span
                className={`tab-dot ${guidedLockReason ? "locked" : status}`}
                aria-hidden="true"
              />
            </Tip>
            <span>{displayLabel}</span>
          </button>
        );
      })}
      {lockToast && (
        <div
          role="alert"
          style={{
            position: "absolute",
            top: "100%",
            left: "50%",
            transform: "translateX(-50%)",
            marginTop: 6,
            padding: "6px 12px",
            background: "var(--bg-warn)",
            border: "1px solid var(--org)",
            borderRadius: 4,
            fontSize: 12,
            color: "var(--tx-warn)",
            zIndex: 100,
            animation: "fi 0.2s ease",
            pointerEvents: "none",
          }}
        >
          {lockToast}
        </div>
      )}
      <div className="tab-bar-lang">
        <LanguageSelector />
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>("setup");
  const [config, setConfig] = useState<AppConfig>(defaultConfig);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [parsedLog, setParsedLog] = useState<ParsedLog | null>(null);
  const [preFlight, setPreFlight] = useState<PreFlightResult | null>(null);
  const [installRunning, setInstallRunning] = useState(false);
  const [forgeOnline, setForgeOnline] = useState<boolean | null>(null);
  const [downloadReadiness, setDownloadReadiness] = useState<DownloadReadiness | null>(null);
  const [excludedComponents, setExcludedComponents] = useState<Set<ExcludeKey>>(new Set());
  const [pausePoints, setPausePoints] = useState<PausePoint[]>([]);
  const [installStatus, setInstallStatus] = useState<InstallStatusMap>(new Map());
  const [installIssues, setInstallIssues] = useState<InstallIssueMap>(new Map());
  // Forge data freshness — driven from the footer indicator. Increment
  // `forgeRefreshCounter` to ask ModsPanel to re-fetch with bustCache.
  // ModsPanel calls `onForgeRefreshComplete` when the fetch settles so the
  // footer's spinner state can reset.
  const [forgeRefreshCounter, setForgeRefreshCounter] = useState(0);
  const [forgeRefreshing, setForgeRefreshing] = useState(false);
  // Tick the footer once a minute so the "X min ago" label stays current
  // without re-rendering the whole tree on every state change.
  const [, setForgeAgeTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setForgeAgeTick((x) => x + 1), FOOTER_AGE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Splash screen state
  const [splashDone, setSplashDone] = useState(false);
  const [splashStep, setSplashStep] = useState("Starting...");

  // Auto-update state
  const [updateAvailable, setUpdateAvailable] = useState<{ version: string; body: string; update: unknown } | null>(null);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [updateSkipped, setUpdateSkipped] = useState(false);

  // Pre-loaded setup data (populated during splash)
  const [preloadedSetup, setPreloadedSetup] = useState<{
    bg1Valid: boolean | null;
    bg2Valid: boolean | null;
    bg1Freshness: GameFreshness | null;
    bg2Freshness: GameFreshness | null;
    modDirScan: ModDirScan | null;
    weiduVersion: string | null;
  }>({
    bg1Valid: null, bg2Valid: null,
    bg1Freshness: null, bg2Freshness: null,
    modDirScan: null, weiduVersion: null,
  });

  // Unified init sequence — runs all startup tasks and tracks progress
  useEffect(() => {
    installGlobalErrorHandlers();
    // Rotate gui.log on startup before we write anything (version bump / size cap).
    // Fire-and-forget — if rotation fails (backend not ready yet), entries are still
    // buffered in the logger and will land in whichever file exists.
    rotateGuiLog(APP_VERSION).then((r) => {
      if (r.rotated) {
        guiLog.info("APP", `gui.log rotated (${r.reason})${r.prev_file ? ` → ${r.prev_file}` : ""}`);
      }
      // Surface health observations from the pre-rotation state. Each warning
      // documents a symptom of a previous session misbehaving — e.g. oversized
      // log because a prior frontend crash skipped rotation. Written as WARN
      // so it's searchable (grep "gui.log health") and shows up in any issue
      // report. If these ever start appearing repeatedly, that's our signal
      // to put a safety rail back in the write path.
      for (const w of r.health_warnings || []) {
        guiLog.warn("APP", `gui.log health: ${w}`);
      }
    }).catch(() => { /* rotation is best-effort */ });
    guiLog.info("APP", `─── SESSION-START ─── version=${APP_VERSION}`);

    async function init() {
      // Step 1: Load config
      setSplashStep("Loading configuration...");
      await new Promise((r) => setTimeout(r, 50));
      let cfg = defaultConfig;
      try {
        const loaded = await invoke<AppConfig>("load_config");
        cfg = { ...defaultConfig, ...loaded };
        // Dedup: only write the full paths line to gui.log if the paths changed
        // since the last launch. Otherwise a short "unchanged" marker is enough.
        const currentPaths = `${cfg.bg2_game_dir || ""}|${cfg.bg1_game_dir || ""}`;
        const prevPaths = (() => { try { return localStorage.getItem("eetmr.prevConfigPaths") || ""; } catch { return ""; } })();
        if (currentPaths !== prevPaths) {
          guiLog.info("CONFIG", `Config loaded: bg2=${cfg.bg2_game_dir || "unset"}, bg1=${cfg.bg1_game_dir || "unset"}`);
          try { localStorage.setItem("eetmr.prevConfigPaths", currentPaths); } catch { /* private mode */ }
        } else {
          guiLog.info("CONFIG", "Config loaded (unchanged)");
        }
      } catch (e) {
        guiLog.warn("CONFIG", `Config load failed: ${e}`);
      }
      // One-time migration: v1.0.0-beta stored the Install-tab "saved
      // defaults" snapshot in localStorage. WebView2 silently wiped it
      // under some profile states, so v1.0.2+ moved the snapshot into
      // `config.saved_install_defaults` (round-trips through confy).
      // This block copies any surviving legacy value into the config
      // BEFORE setConfig fires, so the app never renders with the old
      // state active. Runs here (not in InstallRunner) because
      // InstallRunner's first mount happens during splash when its
      // config prop is still defaultConfig — migrating from there would
      // race with the TOML load and overwrite user data.
      if (!cfg.saved_install_defaults) {
        const LEGACY_KEY = "eetmr:install_saved_defaults_v1";
        const legacy = (() => {
          try { return localStorage.getItem(LEGACY_KEY); }
          catch { return null; }
        })();
        if (legacy) {
          try {
            const parsed = JSON.parse(legacy);
            if (typeof parsed === "object" && parsed !== null) {
              cfg = { ...cfg, saved_install_defaults: legacy };
              try { await invoke("save_config", { config: cfg }); } catch { /* will retry next saveConfig */ }
              try { localStorage.removeItem(LEGACY_KEY); } catch { /* private mode */ }
              guiLog.info("CONFIG", "Migrated install preferences from localStorage to config.toml");
            }
          } catch (err) {
            guiLog.warn("CONFIG", `Legacy install preferences unparseable, skipping migration: ${err}`);
          }
        }
      }
      setConfig(cfg);
      setConfigLoaded(true);

      // Phase 21f: emit a one-time session header to gui.log listing
      // every other log path we know about. Lets someone handed just
      // gui.log find install.log / reports / guard without needing
      // the source code's per-game hash math. Best-effort — failure
      // here shouldn't abort startup.
      try {
        const { getLogPaths } = await import("./lib/tauri-bridge");
        const lp = await getLogPaths(cfg);
        const rows: string[] = [
          `  gui.log:      ${lp.paths.gui_log}`,
          `  config.toml:  ${lp.paths.config_toml}`,
          `  app config:   ${lp.paths.app_config_root}`,
        ];
        if (lp.paths.data_root) rows.push(`  data root:    ${lp.paths.data_root}`);
        else rows.push(`  data root:    <pending first install>`);
        if (lp.paths.game_data_dir) rows.push(`  game data:    ${lp.paths.game_data_dir}`);
        if (lp.paths.install_log) rows.push(`  install.log:  ${lp.paths.install_log}`);
        if (lp.paths.reports_dir) rows.push(`  reports:      ${lp.paths.reports_dir}`);
        if (lp.paths.guard_report) rows.push(`  guard:        ${lp.paths.guard_report}`);
        if (lp.paths.checkpoint) rows.push(`  checkpoint:   ${lp.paths.checkpoint}`);
        guiLog.info("APP", `Log paths for this session:\n${rows.join("\n")}`);
      } catch (e) {
        guiLog.warn("APP", `Could not resolve log paths for session header: ${e}`);
      }

      await new Promise((r) => setTimeout(r, 500));

      // Step 1b: Check for updates
      setSplashStep("Checking for updates...");
      await new Promise((r) => setTimeout(r, 50));
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (update) {
          guiLog.info("APP", `Update available: ${update.version}`);
          setUpdateAvailable({ version: update.version, body: update.body || "", update });
          // Splash will pause here — user clicks Update or Skip
          // Wait until user makes a choice (updateSkipped becomes true or app restarts)
          await new Promise<void>((resolve) => {
            const interval = setInterval(() => {
              // Check if user skipped (we set a flag on the window for cross-scope access)
              if ((window as unknown as Record<string, boolean>).__eetmr_update_skipped) {
                clearInterval(interval);
                resolve();
              }
            }, 100);
          });
        }
      } catch {
        // Updater not configured, offline, or error — continue silently
      }

      // Step 2: Check forge connectivity
      setSplashStep("Connecting to Forge...");
      await new Promise((r) => setTimeout(r, 50));
      const url = cfg.forge_data_url || DEFAULT_FORGE_URL;
      try {
        const r = await fetch(`${url}/data/known_issues.json`, { method: "HEAD" });
        setForgeOnline(r.ok);
        guiLog.info("APP", `Forge: ${r.ok ? "connected" : "unreachable"} (${url})`);
      } catch {
        setForgeOnline(false);
        guiLog.info("APP", `Forge: offline (${url})`);
      }

      // Step 3: Pre-load setup data so the UI is ready immediately
      setSplashStep("Checking game directories...");
      // Force a repaint so the splash step text updates before heavy work
      await new Promise((r) => setTimeout(r, 50));
      const setup: typeof preloadedSetup = {
        bg1Valid: null, bg2Valid: null,
        bg1Freshness: null, bg2Freshness: null,
        modDirScan: null, weiduVersion: null,
      };
      try {
        const promises: Promise<void>[] = [];
        if (cfg.bg1_game_dir) {
          promises.push(
            validateGameDir(cfg.bg1_game_dir).then((v) => { setup.bg1Valid = v; }),
            checkGameFreshness(cfg.bg1_game_dir).then((f) => { setup.bg1Freshness = f; }).catch(() => {}),
          );
        }
        if (cfg.bg2_game_dir) {
          promises.push(
            validateGameDir(cfg.bg2_game_dir).then((v) => { setup.bg2Valid = v; }),
            checkGameFreshness(cfg.bg2_game_dir).then((f) => { setup.bg2Freshness = f; }).catch(() => {}),
          );
        }
        if (cfg.mod_directory) {
          promises.push(
            scanModDirectory(cfg.mod_directory).then((s) => { setup.modDirScan = s; }).catch(() => {}),
          );
        }
        if (cfg.weidu_path) {
          promises.push(
            getBinaryVersion(cfg.weidu_path).then((v) => { setup.weiduVersion = v; }).catch(() => {}),
          );
        }
        await Promise.all(promises);
      } catch {}
      setPreloadedSetup(setup);

      // Step 4: Pre-load saved WeiDU logs if paths exist in config
      if (cfg.eet_log_path || cfg.bgee_log_path) {
        setSplashStep("Loading saved install logs...");
        await new Promise((r) => setTimeout(r, 50));
        try {
          let eetRaw: string | null = null;
          let bgeeRaw: string | null = null;
          if (cfg.eet_log_path) {
            try { eetRaw = await readFileContents(cfg.eet_log_path); } catch {}
          }
          if (cfg.bgee_log_path) {
            try { bgeeRaw = await readFileContents(cfg.bgee_log_path); } catch {}
          }
          if (eetRaw || bgeeRaw) {
            const parsed = buildParsedLog(
              eetRaw || "", bgeeRaw || null,
              cfg.eet_log_path, cfg.bgee_log_path,
            );
            if (parsed.entries.length > 0 || (parsed.bgeeEntries && parsed.bgeeEntries.length > 0)) {
              setParsedLog(parsed);
            }
          }
        } catch {}
      }

      setSplashStep("Ready");
      await new Promise((r) => setTimeout(r, 400));

      setSplashDone(true);
    }

    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-check forge when URL changes (after initial load)
  useEffect(() => {
    if (!splashDone) return;
    const url = config.forge_data_url || DEFAULT_FORGE_URL;
    fetch(`${url}/data/known_issues.json`, { method: "HEAD" })
      .then((r) => setForgeOnline(r.ok))
      .catch(() => setForgeOnline(false));
  }, [config.forge_data_url, splashDone]);

  // Config-save event listeners — backend emits these on every save so that
  // persistence failures (which used to vanish into console.error) become
  // visible in gui.log. The first successful save after app launch also
  // logs the resolved config path once, which is useful for diagnosing
  // "why isn't my setting sticking" class bugs.
  const loggedConfigPathRef = useRef(false);
  // Phase 21c: surface config save failures as a dismissible banner
  // with an "Open config folder" action. Previously only logged to
  // gui.log where nobody would see it — silent persistence failures
  // had caused "my settings aren't saving" bug reports in the wild.
  const [configSaveError, setConfigSaveError] = useState<string | null>(null);
  useEffect(() => {
    let unlistenSaved: (() => void) | null = null;
    let unlistenFailed: (() => void) | null = null;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenSaved = await listen<{ path: string }>("app:config-saved", (e) => {
        if (!loggedConfigPathRef.current) {
          loggedConfigPathRef.current = true;
          guiLog.info("CONFIG", `Config persisted to ${e.payload.path}`);
        }
        // A successful save clears any prior error banner.
        setConfigSaveError(null);
      });
      unlistenFailed = await listen<{ error: string }>("app:config-save-failed", (e) => {
        guiLog.error("CONFIG", `Backend save_config error: ${e.payload.error}`);
        setConfigSaveError(e.payload.error);
      });
    })();
    return () => {
      unlistenSaved?.();
      unlistenFailed?.();
    };
  }, []);

  const saveConfig = useCallback(
    async (updated: AppConfig) => {
      setConfig(updated);
      try {
        await invoke("save_config", { config: updated });
      } catch (e) {
        // Persistence failure: surface to gui.log so it's visible in
        // session diagnostics. Historically this only hit console.error and
        // was invisible to the user — we had a 2-week stretch where the
        // config file silently stopped updating and nobody noticed until
        // an install used the wrong batch size.
        const msg = String(e);
        console.error("Failed to save config:", msg);
        try {
          guiLog.error("CONFIG", `save_config failed: ${msg}`);
        } catch { /* logger may not be ready during early init */ }
      }
    },
    [],
  );

  const setupValid =
    !!config.bg2_game_dir && !!config.bg1_game_dir && !!config.mod_directory;

  const canInstall = setupValid && !!parsedLog && preFlight?.passed !== false;

  // ── Guided-mode tab locks (Phase 14) ──
  // Only populated when `config.guided_mode` is true. Each entry is the
  // user-facing reason the tab is locked; absence means unlocked. Setup
  // is never locked (it's the entry point); Debug is never locked (it's
  // useful even pre-install). Mods unlocks after Setup is valid; Ready
  // Check unlocks after a log is imported; Install unlocks after the
  // preflight passes (same as the hard gate).
  const guidedLocks: Partial<Record<Tab, string>> = config.guided_mode
    ? {
      ...(setupValid ? {} : { mods: "Finish Setup first." }),
      ...(setupValid && parsedLog ? {} : { preflight: "Import a mod list in Mods first." }),
      ...(setupValid && parsedLog && preFlight?.passed === true
        ? {}
        : { install: "Pass the Ready Check first." }),
    }
    : {};

  // ── Transition banners (Phase 13) ──
  // Per-session (not persisted): fire when a prerequisite transitions
  // false → true, so a returning user with an already-valid pipeline
  // sees nothing on launch, but a new user walking the flow sees a
  // "you just finished X, next step is Y" banner on each downstream tab.
  // Each slot is one of:
  //   "shown"      — banner visible
  //   "dismissed"  — user clicked × this session; stays hidden even if
  //                  the trigger re-fires (prevents spam when conditions
  //                  wobble back and forth)
  //   undefined    — never fired (or already consumed)
  // Phase 19a: `mods_imported` banner slot was removed because the Ready
  // Check tab's standalone Run button is sufficient — the banner duplicated
  // the CTA without adding information. Remaining banner slots still fire
  // (Setup→Mods, Ready Check→Install).
  type BannerKey = "setup_done" | "preflight_passed";
  type BannerState = "shown" | "dismissed";
  const [banners, setBanners] = useState<Record<BannerKey, BannerState | undefined>>({
    setup_done: undefined,
    preflight_passed: undefined,
  });
  // Prior-value refs so we only fire on the edge (false → true), not
  // every render where the predicate is true. Initialized from current
  // values so a splash-loaded-already-valid config doesn't emit banners.
  const prevSetupValid = useRef(setupValid);
  const prevPreflightPassed = useRef(preFlight?.passed === true);
  useEffect(() => {
    if (!splashDone) return;
    // Functional setState reads the latest `banners` without needing it in
    // deps — avoids re-running the effect after each setBanners call, and
    // sidesteps a stale-closure read if React batches these.
    // Setup: false → true edge.
    if (!prevSetupValid.current && setupValid) {
      setBanners((b) => (b.setup_done === undefined ? { ...b, setup_done: "shown" } : b));
    }
    prevSetupValid.current = setupValid;
    // Ready Check: !passed → passed edge.
    const passed = preFlight?.passed === true;
    if (!prevPreflightPassed.current && passed) {
      setBanners((b) => (b.preflight_passed === undefined ? { ...b, preflight_passed: "shown" } : b));
    }
    prevPreflightPassed.current = passed;
  }, [setupValid, preFlight?.passed, splashDone]);
  const dismissBanner = useCallback((key: BannerKey) => {
    setBanners((b) => ({ ...b, [key]: "dismissed" }));
  }, []);

  // ── Per-tab status dots (Forge-style progress indicator) ──
  const hasInstallErrors = [...installIssues.values()].some((i) => i.level === "ERROR");
  const hasInstallWarns = [...installIssues.values()].some((i) => i.level === "WARN");
  const installFinished = !installRunning && installStatus.size > 0;
  const tabStatuses: Record<Tab, TabStatus> = {
    setup: setupValid ? "done" : "pending",
    mods: parsedLog ? "done" : "pending",
    preflight: preFlight?.passed === true ? "done" : preFlight?.passed === false ? "warn" : "pending",
    install: installRunning ? "active"
      : installFinished && hasInstallErrors ? "err"
      : installFinished && hasInstallWarns ? "warn"
      : installFinished ? "done"
      : "pending",
    debug: "pending",
  };

  return (
    <I18nProvider
      lang={config.ui_language || "en"}
      onLangChange={(lang) => saveConfig({ ...config, ui_language: lang })}
    >
    <>
    {/* Splash overlay — covers everything until init completes.
        The main app renders underneath (hidden) so all components mount
        and build their DOM during the splash. */}
    {!splashDone && (
      <div style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        gap: 16,
      }}>
        <img src="logo.svg" alt="" style={{ width: SPLASH_LOGO_PX, height: SPLASH_LOGO_PX, opacity: 0.9 }} />
        <div className="splash-title" style={{ color: "var(--goldb)", fontSize: 28, fontWeight: 700 }}>
          Infinity Mod Runner
        </div>
        {/* Tagline — sets expectation in the first second of launch before
         * any tab has rendered. Anyone who never reads the README at least
         * sees the one-sentence product pitch. Hardcoded English (like
         * "Update Available" / "Starting..." above) because the splash
         * runs outside the I18nProvider — the provider's language is
         * read from config, which hasn't finished loading yet when the
         * splash first paints. */}
        <div style={{
          color: "var(--txd)",
          fontSize: 13,
          marginTop: -8,
          fontFamily: "'Source Sans 3', -apple-system, sans-serif",
          fontStyle: "italic",
          letterSpacing: 0.2,
        }}>
          Install Infinity Engine mods from a Forge-exported list
        </div>
        {/* Update available — pause splash and show update UI */}
        {updateAvailable && !updateSkipped ? (
          <>
            <div className="phase-banner green" style={{ padding: "12px 24px", borderRadius: 8, maxWidth: 360, letterSpacing: 0, textTransform: "none", fontWeight: 400 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--grn)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
                Update Available
              </div>
              <div style={{ fontSize: 14, color: "var(--tx)", marginBottom: 4 }}>
                v{APP_VERSION} {"\u2192"} v{updateAvailable.version}
              </div>
              {updateAvailable.body && (
                <div style={{ fontSize: 11, color: "var(--txd)", lineHeight: 1.4, maxHeight: 60, overflow: "hidden", marginBottom: 8 }}>
                  {updateAvailable.body.slice(0, 200)}
                </div>
              )}
              {updateProgress !== null ? (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 11, color: "var(--txd)", marginBottom: 4 }}>
                    Downloading update... {updateProgress}%
                  </div>
                  <div className="progress-bar" style={{ width: SPLASH_PROGRESS_WIDTH_PX, height: 4 }}>
                    <div className="fill" style={{ width: `${updateProgress}%`, transition: "width 0.3s ease" }} />
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 8 }}>
                  <button className="btn btn-primary" style={{ fontSize: 12, padding: "6px 16px" }}
                    onClick={async () => {
                      try {
                        const upd = updateAvailable.update as { downloadAndInstall: (cb: (e: { event: string; data: { contentLength?: number; chunkLength?: number } }) => void) => Promise<void> };
                        let downloaded = 0;
                        let total = 0;
                        await upd.downloadAndInstall((event) => {
                          if (event.event === "Started" && event.data.contentLength) {
                            total = event.data.contentLength;
                          } else if (event.event === "Progress" && event.data.chunkLength) {
                            downloaded += event.data.chunkLength;
                            if (total > 0) setUpdateProgress(Math.round((downloaded / total) * 100));
                          } else if (event.event === "Finished") {
                            setUpdateProgress(100);
                          }
                        });
                        // Restart after install
                        const { relaunch } = await import("@tauri-apps/plugin-process");
                        await relaunch();
                      } catch (e) {
                        guiLog.error("APP", `Update failed: ${e}`);
                        setUpdateAvailable(null);
                      }
                    }}>
                    Update Now
                  </button>
                  <button className="btn" style={{ fontSize: 12, padding: "6px 16px" }}
                    onClick={() => {
                      setUpdateSkipped(true);
                      (window as unknown as Record<string, boolean>).__eetmr_update_skipped = true;
                    }}>
                    Skip
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div style={{ color: "var(--txd)", fontSize: 13, marginTop: 4 }}>
              {splashStep}
            </div>
            <div className="progress-bar" style={{ width: SPLASH_PROGRESS_WIDTH_PX, height: 4, marginTop: 12 }}>
              <div className="fill" style={{
                width: splashStep === "Ready" ? "100%"
                  : splashStep.includes("logs") ? "90%"
                  : splashStep.includes("game") ? "70%"
                  : splashStep.includes("Forge") ? "45%"
                  : splashStep.includes("update") ? "30%"
                  : "20%",
                transition: "width 0.3s ease",
              }} />
            </div>
          </>
        )}
        <div style={{ color: "var(--txd)", fontSize: 10, marginTop: 16, opacity: 0.5 }}>
          v{APP_VERSION}
        </div>
      </div>
    )}
    {/* Main app — renders underneath splash so DOM is pre-built */}
    <div style={{ visibility: splashDone ? "visible" : "hidden", height: "100vh", display: "flex", flexDirection: "column" as const }}>
      <TabBar
        tab={tab}
        setTab={setTab}
        canInstall={canInstall}
        installRunning={installRunning}
        statuses={tabStatuses}
        guidedMode={config.guided_mode}
        guidedLocks={guidedLocks}
      />

      {/* Phase 21c: config-save-failure banner. Surfaces the error
       * visibly (was gui.log-only → silent for users) with an Open
       * config folder action so the user can inspect config.toml
       * permissions / lock state / disk pressure without hunting. */}
      {configSaveError && (
        <div
          className="alert err"
          style={{
            margin: "8px 12px",
            padding: "8px 12px",
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span style={{ flex: 1 }}>
            <strong>Config save failed.</strong> {configSaveError}
          </span>
          <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button
              className="btn"
              style={{ fontSize: 11, padding: "2px 10px" }}
              onClick={async () => {
                try {
                  const { getLogPaths, openPath } = await import("./lib/tauri-bridge");
                  const lp = await getLogPaths(config);
                  // Open the app-config folder (always resolvable),
                  // not config_toml itself — Windows Explorer's
                  // /select behavior highlights the file while
                  // showing the parent, giving the user a one-click
                  // jump to where config lives.
                  await openPath(lp.paths.config_toml);
                } catch (err) {
                  guiLog.warn("UI", `Open config folder failed: ${err}`);
                }
              }}
            >
              Open config folder
            </button>
            <button
              className="btn"
              style={{ fontSize: 11, padding: "2px 10px" }}
              onClick={() => setConfigSaveError(null)}
            >
              Dismiss
            </button>
          </span>
        </div>
      )}

      <div className="panel">
        {/* All tabs stay mounted with display:none when inactive, so in-flight
            work (backup progress, ready-check scan, patch apply, etc.) continues
            visibly when the user tabs away. Components that need to react to
            tab visibility can inspect their own layout. */}
        <div style={{ display: tab === "setup" ? "block" : "none", height: "100%" }}>
          <SetupWizard
            config={config}
            onSave={saveConfig}
            configLoaded={configLoaded}
            preloaded={preloadedSetup}
            installRunning={installRunning}
            onGoToMods={() => setTab("mods")}
          />
        </div>
        {/* ModsPanel — combines Import, Order, and Download */}
        <div style={{ display: tab === "mods" ? "block" : "none", height: "100%" }}>
          <ModsPanel
            config={config}
            parsedLog={parsedLog}
            onImport={setParsedLog}
            onSaveConfig={saveConfig}
            excludedComponents={excludedComponents}
            onExcludedChange={setExcludedComponents}
            pausePoints={pausePoints}
            onPausePointsChange={setPausePoints}
            forgeOnline={forgeOnline}
            onReadinessChange={setDownloadReadiness}
            installRunning={installRunning}
            installStatus={installStatus}
            installIssues={installIssues}
            forgeRefreshTrigger={forgeRefreshCounter}
            onForgeRefreshComplete={() => setForgeRefreshing(false)}
            onGoToTab={setTab}
            showSetupDoneBanner={banners.setup_done === "shown"}
            onDismissSetupDoneBanner={() => dismissBanner("setup_done")}
            guidedMode={config.guided_mode}
          />
        </div>
        <div style={{ display: tab === "preflight" ? "block" : "none", height: "100%" }}>
          <ReadyCheck
            config={config}
            onSaveConfig={saveConfig}
            parsedLog={parsedLog}
            result={preFlight}
            onResult={setPreFlight}
            forgeOnline={forgeOnline}
            downloadReadiness={downloadReadiness}
            installRunning={installRunning}
            onGoToTab={setTab}
            guidedMode={config.guided_mode}
          />
        </div>
        {/* InstallRunner stays mounted (hidden) so state survives tab switches */}
        <div style={{ display: tab === "install" ? "block" : "none", height: "100%" }}>
          <InstallRunner
            config={config}
            parsedLog={parsedLog}
            running={installRunning}
            onRunningChange={setInstallRunning}
            onSaveConfig={saveConfig}
            weiduVersion={preloadedSetup.weiduVersion}
            excludedComponents={excludedComponents}
            pausePoints={pausePoints.map((p) => ({ afterModIndex: p.afterModIndex, message: p.message, phase: p.phase }))}
            backupExists={preFlight?.backupExists ?? false}
            onInstallStatus={setInstallStatus}
            onInstallIssues={setInstallIssues}
            onGoToTab={setTab}
            showPreflightPassedBanner={banners.preflight_passed === "shown"}
            onDismissPreflightPassedBanner={() => dismissBanner("preflight_passed")}
          />
        </div>
        {/* DebugPanel stays mounted so parsed results survive tab switches */}
        <div style={{ display: tab === "debug" ? "block" : "none", height: "100%" }}>
          <DebugPanel config={config} forgeOnline={forgeOnline} parsedLog={parsedLog} installRunning={installRunning} />
        </div>
      </div>

      <div className="status-bar">
        {/* Forge status item wrapped in Tip so hovering teaches first-timers
         * what "Forge Data" means. The status-item itself keeps its
         * existing click target (refresh button) — the Tip only covers
         * the dot + label, not the interactive child elements, by setting
         * style={{ display: "contents" }} so child layout is unchanged. */}
        <Tip
          style={{ display: "contents" }}
          content={
            <>
              <span className="tip-title">Infinity Mod Forge</span>
              <span className="tip-meta">The web-based mod-list builder</span>
              <span className="tip-desc">
                Runner fetches mod metadata, install order, categories, and
                known issues from a hosted Forge data bundle at launch.
                Without it, Runner still installs — but Ready Check and
                patch scanning lose some smarts.
              </span>
              <span className="tip-desc" style={{ color: "var(--cyan)", fontSize: 11 }}>
                Click the refresh icon to re-fetch. Click here to open Forge →
              </span>
            </>
          }
        >
        <div
          className="status-item"
          style={{ display: "flex", alignItems: "center", gap: 6, cursor: "help" }}
          onClick={(e) => {
            // Only open Forge when clicking dead space on the item itself
            // (dot / label). Clicking the refresh button is handled by its
            // own onClick and shouldn't also open a browser tab.
            if ((e.target as HTMLElement).closest("button")) return;
            import("@tauri-apps/plugin-opener").then(({ openUrl }) => {
              openUrl(FORGE_WEB_URL).catch(() => {});
            });
          }}
        >
          <span
            className={`dot ${forgeOnline === true ? "online" : forgeOnline === false ? "offline" : ""}`}
          />
          Forge Data:{" "}
          {forgeOnline === true
            ? "Connected"
            : forgeOnline === false
              ? "Offline"
              : "Checking..."}
          {forgeOnline === true && (() => {
            const ageMs = forgeDataAgeMs();
            if (ageMs === null) return null;
            const ageLabel = ageMs < 60_000 ? "just now"
              : ageMs < 3_600_000 ? `${Math.round(ageMs / 60_000)} min ago`
              : `${(ageMs / 3_600_000).toFixed(1)}h ago`;
            const stale = ageMs > FORGE_STALE_MS;
            return (
              <>
                <span style={{ color: "var(--txd)" }}>—</span>
                <span style={{ color: stale ? "var(--org)" : "var(--txd)" }}>{ageLabel}</span>
                <button
                  onClick={() => {
                    if (forgeRefreshing || installRunning) return;
                    setForgeRefreshing(true);
                    setForgeRefreshCounter((c) => c + 1);
                  }}
                  disabled={forgeRefreshing || installRunning}
                  title={installRunning
                    ? "Forge data is locked while an install is running"
                    : "Re-fetch mod index and release cache from Forge"}
                  style={{
                    background: "transparent", border: "none", padding: 0, marginLeft: 2,
                    color: "var(--txd)",
                    cursor: (forgeRefreshing || installRunning) ? "not-allowed" : "pointer",
                    fontSize: 12, lineHeight: 1,
                    opacity: (forgeRefreshing || installRunning) ? 0.5 : 1,
                  }}
                  aria-label="Refresh Forge data"
                >
                  {forgeRefreshing ? "\u29D7" : "\u21BB"}
                </button>
              </>
            );
          })()}
        </div>
        </Tip>
        <div className="status-item">
          {parsedLog
            ? `${parsedLog.modCount} mods / ${parsedLog.componentCount} components loaded`
            : "No log imported"}
        </div>
        {updateAvailable && updateSkipped && !installRunning && (
          <button
            className="status-item"
            style={{ cursor: "pointer", color: "var(--grn)", border: "none", background: "none", fontSize: 11, padding: 0 }}
            onClick={async () => {
              try {
                const upd = updateAvailable.update as { downloadAndInstall: (cb: (e: { event: string; data: { contentLength?: number; chunkLength?: number } }) => void) => Promise<void> };
                await upd.downloadAndInstall(() => {});
                const { relaunch } = await import("@tauri-apps/plugin-process");
                await relaunch();
              } catch (e) {
                guiLog.error("APP", `Update failed: ${e}`);
              }
            }}
            title={`Update to v${updateAvailable.version}`}
          >
            {"\uD83D\uDD04"} Update v{updateAvailable.version}
          </button>
        )}
        <div className="status-item">Infinity Mod Runner v{APP_VERSION}</div>
      </div>
    </div>
    </>
    </I18nProvider>
  );
}

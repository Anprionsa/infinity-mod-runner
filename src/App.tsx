import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { guiLog, installGlobalErrorHandlers } from "./lib/gui-logger";
import { validateGameDir, checkGameFreshness, scanModDirectory, getBinaryVersion, readFileContents, type GameFreshness, type ModDirScan } from "./lib/tauri-bridge";
import { buildParsedLog } from "./lib/log-parser";
import SetupWizard from "./components/SetupWizard";
import ImportPanel from "./components/ImportPanel";
import PreFlight from "./components/PreFlight";
import InstallRunner from "./components/InstallRunner";
import DownloadPanel from "./components/DownloadPanel";
import DebugPanel from "./components/DebugPanel";

export interface AppConfig {
  bg2_game_dir: string | null;
  bg1_game_dir: string | null;
  mod_directory: string | null;
  weidu_path: string | null;
  mod_installer_path: string | null;
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
  // Install options — advanced
  language: string;
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

export interface PreFlightResult {
  messages: { t: "err" | "warn" | "info" | "ok"; m: string }[];
  passed: boolean;
  checkedAt: number;
}

/** Summary of download readiness — reported by DownloadPanel, consumed by PreFlight */
export interface DownloadReadiness {
  totalMods: number;
  alreadyHave: number;
  missingNames: string[];  // mod names not on disk
  builtAt: number;         // timestamp when plan was built
}

type Tab = "setup" | "import" | "download" | "preflight" | "install" | "debug";

const TABS: { id: Tab; label: string }[] = [
  { id: "setup", label: "Setup" },
  { id: "import", label: "Import" },
  { id: "download", label: "Download" },
  { id: "preflight", label: "Pre-Flight" },
  { id: "install", label: "Install" },
  { id: "debug", label: "Debug" },
];

const DEFAULT_FORGE_URL = "https://anprionsa.github.io/eet-mod-forge";

const defaultConfig: AppConfig = {
  bg2_game_dir: null,
  bg1_game_dir: null,
  mod_directory: null,
  weidu_path: null,
  mod_installer_path: null,
  forge_data_url: DEFAULT_FORGE_URL,
  last_log_path: null,
  eet_log_path: null,
  bgee_log_path: null,
  skip_installed: true,
  timeout: 7200,
  download_mods: false,
  abort_on_warnings: false,
  never_abort: false,
  language: "en_US",
  depth: 5,
  strict_matching: false,
  overwrite: false,
  check_last_installed: true,
  tick: 500,
  lookback: 10,
  weidu_log_mode: "autolog,logapp,log-extern",
  casefold: false,
  generic_weidu_args: "",
  telemetry_opt_in: null,
};

export default function App() {
  const [tab, setTab] = useState<Tab>("setup");
  const [config, setConfig] = useState<AppConfig>(defaultConfig);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [parsedLog, setParsedLog] = useState<ParsedLog | null>(null);
  const [preFlight, setPreFlight] = useState<PreFlightResult | null>(null);
  const [installRunning, setInstallRunning] = useState(false);
  const [forgeOnline, setForgeOnline] = useState<boolean | null>(null);
  const [downloadReadiness, setDownloadReadiness] = useState<DownloadReadiness | null>(null);

  // Splash screen state
  const [splashDone, setSplashDone] = useState(false);
  const [splashStep, setSplashStep] = useState("Starting...");

  // Pre-loaded setup data (populated during splash)
  const [preloadedSetup, setPreloadedSetup] = useState<{
    bg1Valid: boolean | null;
    bg2Valid: boolean | null;
    bg1Freshness: GameFreshness | null;
    bg2Freshness: GameFreshness | null;
    modDirScan: ModDirScan | null;
    weiduVersion: string | null;
    modInstallerVersion: string | null;
  }>({
    bg1Valid: null, bg2Valid: null,
    bg1Freshness: null, bg2Freshness: null,
    modDirScan: null, weiduVersion: null, modInstallerVersion: null,
  });

  // Unified init sequence — runs all startup tasks and tracks progress
  useEffect(() => {
    guiLog.info("APP", "EET Mod Runner v0.8.0 launched");
    installGlobalErrorHandlers();

    async function init() {
      // Step 1: Load config
      setSplashStep("Loading configuration...");
      await new Promise((r) => setTimeout(r, 50));
      let cfg = defaultConfig;
      try {
        const loaded = await invoke<AppConfig>("load_config");
        cfg = { ...defaultConfig, ...loaded };
        guiLog.info("CONFIG", `Config loaded: bg2=${cfg.bg2_game_dir || "unset"}, bg1=${cfg.bg1_game_dir || "unset"}`);
      } catch (e) {
        guiLog.warn("CONFIG", `Config load failed: ${e}`);
      }
      setConfig(cfg);
      setConfigLoaded(true);
      await new Promise((r) => setTimeout(r, 1500));

      // Step 2: Check forge connectivity
      setSplashStep("Connecting to Forge...");
      await new Promise((r) => setTimeout(r, 50));
      const url = cfg.forge_data_url || DEFAULT_FORGE_URL;
      try {
        const r = await fetch(`${url}/data/known_issues.json`, { method: "HEAD" });
        setForgeOnline(r.ok);
      } catch {
        setForgeOnline(false);
      }

      // Step 3: Pre-load setup data so the UI is ready immediately
      setSplashStep("Checking game directories...");
      // Force a repaint so the splash step text updates before heavy work
      await new Promise((r) => setTimeout(r, 50));
      const setup: typeof preloadedSetup = {
        bg1Valid: null, bg2Valid: null,
        bg1Freshness: null, bg2Freshness: null,
        modDirScan: null, weiduVersion: null, modInstallerVersion: null,
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
        if (cfg.mod_installer_path) {
          promises.push(
            getBinaryVersion(cfg.mod_installer_path).then((v) => { setup.modInstallerVersion = v; }).catch(() => {}),
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

  const saveConfig = useCallback(
    async (updated: AppConfig) => {
      setConfig(updated);
      try {
        await invoke("save_config", { config: updated });
      } catch (e) {
        console.error("Failed to save config:", e);
      }
    },
    [],
  );

  const setupValid =
    !!config.bg2_game_dir && !!config.bg1_game_dir && !!config.mod_directory;

  const canInstall = setupValid && !!parsedLog && preFlight?.passed !== false;

  return (
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
        <img src="logo.svg" alt="" style={{ width: 120, height: 120, opacity: 0.9 }} />
        <div style={{ color: "var(--goldb)", fontSize: 24, fontWeight: 700, letterSpacing: "0.5px" }}>
          EET Mod Runner
        </div>
        <div style={{ color: "var(--txd)", fontSize: 13, marginTop: 4 }}>
          {splashStep}
        </div>
        <div className="progress-bar" style={{ width: 240, height: 4, marginTop: 12 }}>
          <div className="fill" style={{
            width: splashStep === "Ready" ? "100%" : splashStep.includes("logs") ? "90%" : splashStep.includes("game") ? "70%" : splashStep.includes("Forge") ? "45%" : "20%",
            transition: "width 0.3s ease",
          }} />
        </div>
        <div style={{ color: "var(--txd)", fontSize: 10, marginTop: 16, opacity: 0.5 }}>
          v0.8.0
        </div>
      </div>
    )}
    {/* Main app — renders underneath splash so DOM is pre-built */}
    <div style={{ visibility: splashDone ? "visible" : "hidden", height: "100vh", display: "flex", flexDirection: "column" as const }}>
      <div className="tab-bar">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            className={[
              tab === id ? "active" : "",
              id === "install" && !canInstall && !installRunning
                ? "disabled"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => {
              if (id === "install" && !canInstall && !installRunning) return;
              guiLog.debug("UI", `Tab switch: ${id}`);
              setTab(id);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="panel">
        {tab === "setup" && (
          <SetupWizard
            config={config}
            onSave={saveConfig}
            configLoaded={configLoaded}
            preloaded={preloadedSetup}
          />
        )}
        {/* ImportPanel stays mounted so mod list doesn't re-render on tab switch */}
        <div style={{ display: tab === "import" ? "block" : "none", height: "100%" }}>
          <ImportPanel
            config={config}
            parsedLog={parsedLog}
            onImport={setParsedLog}
            onSaveConfig={saveConfig}
          />
        </div>
        {/* DownloadPanel stays mounted */}
        <div style={{ display: tab === "download" ? "block" : "none", height: "100%" }}>
          <DownloadPanel config={config} parsedLog={parsedLog} forgeOnline={forgeOnline} onReadinessChange={setDownloadReadiness} />
        </div>
        {tab === "preflight" && (
          <PreFlight
            config={config}
            parsedLog={parsedLog}
            result={preFlight}
            onResult={setPreFlight}
            forgeOnline={forgeOnline}
            downloadReadiness={downloadReadiness}
          />
        )}
        {/* InstallRunner stays mounted (hidden) so state survives tab switches */}
        <div style={{ display: tab === "install" ? "block" : "none", height: "100%" }}>
          <InstallRunner
            config={config}
            parsedLog={parsedLog}
            running={installRunning}
            onRunningChange={setInstallRunning}
            onSaveConfig={saveConfig}
            weiduVersion={preloadedSetup.weiduVersion}
          />
        </div>
        {/* DebugPanel stays mounted so parsed results survive tab switches */}
        <div style={{ display: tab === "debug" ? "block" : "none", height: "100%" }}>
          <DebugPanel config={config} forgeOnline={forgeOnline} parsedLog={parsedLog} />
        </div>
      </div>

      <div className="status-bar">
        <div className="status-item">
          <span
            className={`dot ${forgeOnline === true ? "online" : forgeOnline === false ? "offline" : ""}`}
          />
          Forge Data:{" "}
          {forgeOnline === true
            ? "Connected"
            : forgeOnline === false
              ? "Offline"
              : "Checking..."}
        </div>
        <div className="status-item">
          {parsedLog
            ? `${parsedLog.modCount} mods / ${parsedLog.componentCount} components loaded`
            : "No log imported"}
        </div>
        <div className="status-item">EET Mod Runner v0.8.0</div>
      </div>
    </div>
    </>
  );
}

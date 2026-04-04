import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { guiLog, installGlobalErrorHandlers } from "./lib/gui-logger";
import SetupWizard from "./components/SetupWizard";
import ImportPanel from "./components/ImportPanel";
import PreFlight from "./components/PreFlight";
import InstallRunner from "./components/InstallRunner";
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

type Tab = "setup" | "import" | "preflight" | "install" | "debug";

const TABS: { id: Tab; label: string }[] = [
  { id: "setup", label: "Setup" },
  { id: "import", label: "Import" },
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
};

export default function App() {
  const [tab, setTab] = useState<Tab>("setup");
  const [config, setConfig] = useState<AppConfig>(defaultConfig);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [parsedLog, setParsedLog] = useState<ParsedLog | null>(null);
  const [preFlight, setPreFlight] = useState<PreFlightResult | null>(null);
  const [installRunning, setInstallRunning] = useState(false);
  const [forgeOnline, setForgeOnline] = useState<boolean | null>(null);

  // App launch — log version and install global error handlers
  useEffect(() => {
    guiLog.info("APP", "EET Mod Runner v0.6.0 launched");
    installGlobalErrorHandlers();
  }, []);

  // Load config on mount
  useEffect(() => {
    invoke<AppConfig>("load_config")
      .then((cfg) => {
        setConfig({ ...defaultConfig, ...cfg });
        setConfigLoaded(true);
        guiLog.info("CONFIG", `Config loaded: bg2=${cfg.bg2_game_dir || "unset"}, bg1=${cfg.bg1_game_dir || "unset"}`);
      })
      .catch((e) => {
        setConfigLoaded(true);
        guiLog.warn("CONFIG", `Config load failed: ${e}`);
      });
  }, []);

  // Check forge connectivity
  useEffect(() => {
    const url = config.forge_data_url || DEFAULT_FORGE_URL;
    fetch(`${url}/data/known_issues.json`, { method: "HEAD" })
      .then((r) => setForgeOnline(r.ok))
      .catch(() => setForgeOnline(false));
  }, [config.forge_data_url]);

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
          />
        )}
        {tab === "import" && (
          <ImportPanel
            config={config}
            parsedLog={parsedLog}
            onImport={setParsedLog}
            onSaveConfig={saveConfig}
          />
        )}
        {tab === "preflight" && (
          <PreFlight
            config={config}
            parsedLog={parsedLog}
            result={preFlight}
            onResult={setPreFlight}
            forgeOnline={forgeOnline}
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
        <div className="status-item">EET Mod Runner v0.6.0</div>
      </div>
    </>
  );
}

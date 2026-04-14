import { useState, useEffect } from "react";
import type { AppConfig } from "../App";
import { useI18n } from "../lib/i18n";
import {
  pickDirectory,
  pickFile,
  validateGameDir,
  detectWeidu,
  getBinaryVersion,
  checkGameFreshness,
  scanModDirectory,
  type ModDirScan,
  type GameFreshness,
} from "../lib/tauri-bridge";

interface Props {
  config: AppConfig;
  onSave: (config: AppConfig) => void;
  configLoaded: boolean;
  preloaded?: {
    bg1Valid: boolean | null;
    bg2Valid: boolean | null;
    bg1Freshness: GameFreshness | null;
    bg2Freshness: GameFreshness | null;
    modDirScan: ModDirScan | null;
    weiduVersion: string | null;
    modInstallerVersion: string | null;
  };
  installRunning?: boolean;
}

interface Validation {
  bg2: boolean | null;
  bg1: boolean | null;
}

export default function SetupWizard({ config, onSave, configLoaded, preloaded, installRunning }: Props) {
  const { t } = useI18n();
  const locked = !!installRunning;
  const [validation, setValidation] = useState<Validation>({
    bg2: preloaded?.bg2Valid ?? null,
    bg1: preloaded?.bg1Valid ?? null,
  });
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [weiduVersion, setWeiduVersion] = useState<string | null>(preloaded?.weiduVersion ?? null);
  const [modDirInfo, setModDirInfo] = useState<ModDirScan | null>(preloaded?.modDirScan ?? null);
  // mod_installer removed — native installer calls WeiDU directly
  const [freshness, setFreshness] = useState<{
    bg1: GameFreshness | null;
    bg2: GameFreshness | null;
  }>({ bg1: preloaded?.bg1Freshness ?? null, bg2: preloaded?.bg2Freshness ?? null });

  // Auto-detect WeiDU and mod_installer on first load if not set
  useEffect(() => {
    if (!configLoaded) return;
    if (!config.weidu_path) {
      handleAutoDetect();
    }
  }, [configLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch binary versions when paths change
  useEffect(() => {
    if (config.weidu_path) {
      getBinaryVersion(config.weidu_path)
        .then(setWeiduVersion)
        .catch(() => setWeiduVersion(null));
    } else {
      setWeiduVersion(null);
    }
  }, [config.weidu_path]);

  // mod_installer version detection removed

  // Validate game dirs and check freshness when they change
  useEffect(() => {
    if (config.bg2_game_dir) {
      validateGameDir(config.bg2_game_dir).then((v) =>
        setValidation((prev) => ({ ...prev, bg2: v })),
      );
      checkGameFreshness(config.bg2_game_dir)
        .then((f) => setFreshness((prev) => ({ ...prev, bg2: f })))
        .catch(() => setFreshness((prev) => ({ ...prev, bg2: null })));
    } else {
      setValidation((prev) => ({ ...prev, bg2: null }));
      setFreshness((prev) => ({ ...prev, bg2: null }));
    }
  }, [config.bg2_game_dir]);

  useEffect(() => {
    if (config.bg1_game_dir) {
      validateGameDir(config.bg1_game_dir).then((v) =>
        setValidation((prev) => ({ ...prev, bg1: v })),
      );
      checkGameFreshness(config.bg1_game_dir)
        .then((f) => setFreshness((prev) => ({ ...prev, bg1: f })))
        .catch(() => setFreshness((prev) => ({ ...prev, bg1: null })));
    } else {
      setValidation((prev) => ({ ...prev, bg1: null }));
      setFreshness((prev) => ({ ...prev, bg1: null }));
    }
  }, [config.bg1_game_dir]);

  // Scan mod directory when it changes
  useEffect(() => {
    if (config.mod_directory) {
      scanModDirectory(config.mod_directory)
        .then(setModDirInfo)
        .catch(() => setModDirInfo(null));
    } else {
      setModDirInfo(null);
    }
  }, [config.mod_directory]);

  async function handleAutoDetect() {
    setAutoDetecting(true);
    try {
      const weidu = config.weidu_path
        ? config.weidu_path
        : await detectWeidu();
      onSave({
        ...config,
        weidu_path: weidu || config.weidu_path,
      });
    } finally {
      setAutoDetecting(false);
    }
  }

  async function browse(
    field: keyof AppConfig,
    type: "dir" | "file",
    title: string,
  ) {
    const result =
      type === "dir"
        ? await pickDirectory(title)
        : await pickFile(title, [
            { name: "Executables", extensions: ["exe", ""] },
          ]);
    if (result) {
      onSave({ ...config, [field]: result });
    }
  }

  function update(field: keyof AppConfig, value: string) {
    onSave({ ...config, [field]: value || null });
  }

  function FreshnessInfo({ data }: { data: GameFreshness | null }) {
    if (!data) return null;
    const fmt = (s: string, vars: Record<string, string | number>) =>
      Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), s);
    return (
      <div style={{ marginTop: 6 }}>
        {data.is_fresh ? (
          <div className="msg ok" style={{ fontSize: 11, padding: "6px 10px" }}>
            {fmt(
              t("setup.fresh_install_detail",
                "Fresh install — dialog.tlk {mb} MB, override/ has {count} files"),
              { mb: data.dialog_tlk_mb, count: data.override_count })}
          </div>
        ) : (
          <div className="msg warn" style={{ fontSize: 11, padding: "6px 10px" }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{t("setup.modified_game", "Modified game detected")}</div>
            {data.has_weidu_log && (
              <div>{fmt(
                t("setup.freshness.weidu_log_found",
                  "weidu.log found with {count} mod entries — this game has been modded"),
                { count: data.weidu_log_entries })}</div>
            )}
            {data.override_count >= 50 && (
              <div>{fmt(
                t("setup.freshness.override_count_high",
                  "override/ contains {count} files (fresh installs have very few)"),
                { count: data.override_count })}</div>
            )}
            {data.has_setup_scripts && (
              <div>{t("setup.freshness.setup_scripts_found",
                "Setup-*.exe files found — mod installers have been run here")}</div>
            )}
            <div style={{ marginTop: 4, color: "var(--txd)" }}>
              {fmt(
                t("setup.modified_stats", "dialog.tlk {mb} MB | override/ {count} files"),
                { mb: data.dialog_tlk_mb, count: data.override_count })}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (!configLoaded) {
    return <div className="panel">Loading configuration...</div>;
  }

  return (
    <div>
      <h2>{t("setup.heading", "Setup")}</h2>
      <p style={{ color: "var(--txd)", marginBottom: 20, fontSize: 13 }}>
        {t("setup.desc", "Configure your game directories and tool paths. These are saved automatically.")}
      </p>

      {locked && (
        <div style={{
          textAlign: "center", padding: "8px 0", marginBottom: 16, borderRadius: 6,
          background: "linear-gradient(90deg, transparent, rgba(255,180,40,0.12), transparent)",
          borderTop: "1px solid rgba(255,180,40,0.3)", borderBottom: "1px solid rgba(255,180,40,0.3)",
          fontSize: 12, fontWeight: 600, color: "var(--gold)",
        }}>
          {t("setup.locked", "Settings are locked while an install is running")}
        </div>
      )}

      <div style={locked ? { opacity: 0.5, pointerEvents: "none" } : undefined}>

      <h3>{t("setup.game_dirs", "Game Directories")}</h3>

      <div className="field">
        <label>{t("setup.bg1_label", "BG1:EE Game Directory")}</label>
        <div className="row">
          <input
            type="text"
            value={config.bg1_game_dir || ""}
            onChange={(e) => update("bg1_game_dir", e.target.value)}
            placeholder="C:\Games\Baldur's Gate Enhanced Edition"
          />
          <button
            className="btn"
            onClick={() =>
              browse("bg1_game_dir", "dir", "Select BG1:EE Directory")
            }
          >
            {t("btn.browse", "Browse")}
          </button>
        </div>
        {validation.bg1 === true && (
          <div className="hint valid">{t("setup.chitin_found", "chitin.key found")}</div>
        )}
        {validation.bg1 === false && (
          <div className="hint invalid">
            {t("setup.chitin_not_found", "chitin.key not found — is this the right directory?")}
          </div>
        )}
        <FreshnessInfo data={freshness.bg1} />
      </div>

      <div className="field">
        <label>{t("setup.bg2_label", "BG2:EE Game Directory")}</label>
        <div className="row">
          <input
            type="text"
            value={config.bg2_game_dir || ""}
            onChange={(e) => update("bg2_game_dir", e.target.value)}
            placeholder="C:\Games\Baldur's Gate II Enhanced Edition"
          />
          <button
            className="btn"
            onClick={() =>
              browse("bg2_game_dir", "dir", "Select BG2:EE Directory")
            }
          >
            {t("btn.browse", "Browse")}
          </button>
        </div>
        {validation.bg2 === true && (
          <div className="hint valid">{t("setup.chitin_found", "chitin.key found")}</div>
        )}
        {validation.bg2 === false && (
          <div className="hint invalid">
            {t("setup.chitin_not_found", "chitin.key not found — is this the right directory?")}
          </div>
        )}
        <FreshnessInfo data={freshness.bg2} />
      </div>

      <div className="field">
        <label>{t("setup.mod_dir_label", "Mod Directory")}</label>
        <div className="row">
          <input
            type="text"
            value={config.mod_directory || ""}
            onChange={(e) => update("mod_directory", e.target.value)}
            placeholder="C:\BGMods\Extracted"
          />
          <button
            className="btn"
            onClick={() =>
              browse("mod_directory", "dir", "Select Mod Directory")
            }
          >
            {t("btn.browse", "Browse")}
          </button>
        </div>
        <div className="hint">
          {t("setup.mod_dir_hint", "Directory containing extracted mod folders (each with a .tp2 file)")}
        </div>
        {config.mod_directory && !modDirInfo && (
          <div className="hint" style={{ color: "var(--txd)" }}>{t("setup.mod_dir_scanning", "Scanning mod directory...")}</div>
        )}
        {modDirInfo && modDirInfo.mod_count > 0 && (
          <div className="hint valid">
            {t("setup.mod_dir_scan_result", "{count} mod folders found ({tp2} .tp2 files)")
              .replace("{count}", String(modDirInfo.mod_count))
              .replace("{tp2}", String(modDirInfo.tp2_count))}
          </div>
        )}
        {modDirInfo && modDirInfo.mod_count === 0 && modDirInfo.exists && (
          <div className="hint invalid">
            {t("setup.no_mods_found", "No mods found. Mods must be extracted (unzipped) here, each in its own subfolder.")}
          </div>
        )}
        {modDirInfo && !modDirInfo.exists && (
          <div className="hint invalid">{t("setup.mod_dir_not_exist", "Directory does not exist")}</div>
        )}
      </div>

      <h3>{t("setup.tool_paths", "Tool Paths")}</h3>

      <div className="field">
        <label>{t("setup.weidu_label", "WeiDU Binary")}</label>
        <div className="row">
          <input
            type="text"
            value={config.weidu_path || ""}
            onChange={(e) => update("weidu_path", e.target.value)}
            placeholder="Auto-detected from PATH"
          />
          <button
            className="btn"
            onClick={() => browse("weidu_path", "file", "Select WeiDU Binary")}
          >
            {t("btn.browse", "Browse")}
          </button>
          <button
            className="btn"
            onClick={handleAutoDetect}
            disabled={autoDetecting}
          >
            {autoDetecting ? t("btn.detecting", "Detecting...") : t("btn.auto_detect", "Auto-Detect")}
          </button>
        </div>
        {config.weidu_path && (
          <div className="hint valid">
            {weiduVersion || "Found"}
          </div>
        )}
        {!config.weidu_path && (
          <div className="hint">{t("setup.weidu_not_detected", "Not detected — browse to select manually")}</div>
        )}
      </div>

      {/* mod_installer removed — native installer calls WeiDU directly */}

      <h3>{t("setup.advanced", "Advanced")}</h3>

      <div className="field">
        <label>{t("setup.forge_url_label", "Forge Data URL")}</label>
        <div className="row">
          <input
            type="text"
            value={config.forge_data_url || ""}
            onChange={(e) => update("forge_data_url", e.target.value)}
            placeholder="https://anprionsa.github.io/eet-mod-forge"
          />
        </div>
        <div className="hint">
          {t("setup.forge_url_hint", "URL where EET Mod Forge is hosted. Used for pre-flight checks and debug matching.")}
        </div>
      </div>

      <div className="field">
        <label>{t("setup.data_dir_label", "Data Directory")}</label>
        <div className="row">
          <input
            type="text"
            value={config.data_directory || ""}
            onChange={(e) => update("data_directory", e.target.value)}
            placeholder="(default: next to exe)"
          />
          <button
            className="btn"
            onClick={() => browse("data_directory", "dir", "Select Data Directory")}
          >
            {t("btn.browse", "Browse")}
          </button>
        </div>
        <div className="hint">
          {t("setup.data_dir_hint", "Where EET Mod Runner stores install logs, checkpoints, and backups. Leave empty to use the default (next to the exe).")}
        </div>
      </div>
      </div>{/* end locked wrapper */}
    </div>
  );
}

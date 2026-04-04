import { useState, useEffect } from "react";
import type { AppConfig } from "../App";
import {
  pickDirectory,
  pickFile,
  validateGameDir,
  detectWeidu,
  detectModInstaller,
  getBinaryVersion,
  checkGameFreshness,
  type GameFreshness,
} from "../lib/tauri-bridge";

interface Props {
  config: AppConfig;
  onSave: (config: AppConfig) => void;
  configLoaded: boolean;
}

interface Validation {
  bg2: boolean | null;
  bg1: boolean | null;
}

export default function SetupWizard({ config, onSave, configLoaded }: Props) {
  const [validation, setValidation] = useState<Validation>({
    bg2: null,
    bg1: null,
  });
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [weiduVersion, setWeiduVersion] = useState<string | null>(null);
  const [modInstallerVersion, setModInstallerVersion] = useState<string | null>(null);
  const [freshness, setFreshness] = useState<{
    bg1: GameFreshness | null;
    bg2: GameFreshness | null;
  }>({ bg1: null, bg2: null });

  // Auto-detect WeiDU and mod_installer on first load if not set
  useEffect(() => {
    if (!configLoaded) return;
    if (!config.weidu_path || !config.mod_installer_path) {
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

  useEffect(() => {
    if (config.mod_installer_path) {
      getBinaryVersion(config.mod_installer_path)
        .then(setModInstallerVersion)
        .catch(() => setModInstallerVersion(null));
    } else {
      setModInstallerVersion(null);
    }
  }, [config.mod_installer_path]);

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

  async function handleAutoDetect() {
    setAutoDetecting(true);
    try {
      const [weidu, modInst] = await Promise.all([
        config.weidu_path ? Promise.resolve(config.weidu_path) : detectWeidu(),
        config.mod_installer_path
          ? Promise.resolve(config.mod_installer_path)
          : detectModInstaller(),
      ]);
      onSave({
        ...config,
        weidu_path: weidu || config.weidu_path,
        mod_installer_path: modInst || config.mod_installer_path,
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
    return (
      <div style={{ marginTop: 6 }}>
        {data.is_fresh ? (
          <div className="msg ok" style={{ fontSize: 11, padding: "6px 10px" }}>
            Fresh install — dialog.tlk {data.dialog_tlk_mb} MB, override/ has {data.override_count} files
          </div>
        ) : (
          <div className="msg warn" style={{ fontSize: 11, padding: "6px 10px" }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Modified game detected</div>
            {data.warnings.map((w, i) => (
              <div key={i}>{w}</div>
            ))}
            <div style={{ marginTop: 4, color: "var(--txd)" }}>
              dialog.tlk {data.dialog_tlk_mb} MB | override/ {data.override_count} files
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
      <h2>Setup</h2>
      <p style={{ color: "var(--txd)", marginBottom: 20, fontSize: 13 }}>
        Configure your game directories and tool paths. These are saved
        automatically.
      </p>

      <h3>Game Directories</h3>

      <div className="field">
        <label>BG1:EE Game Directory</label>
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
            Browse
          </button>
        </div>
        {validation.bg1 === true && (
          <div className="hint valid">chitin.key found</div>
        )}
        {validation.bg1 === false && (
          <div className="hint invalid">
            chitin.key not found — is this the right directory?
          </div>
        )}
        <FreshnessInfo data={freshness.bg1} />
      </div>

      <div className="field">
        <label>BG2:EE Game Directory</label>
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
            Browse
          </button>
        </div>
        {validation.bg2 === true && (
          <div className="hint valid">chitin.key found</div>
        )}
        {validation.bg2 === false && (
          <div className="hint invalid">
            chitin.key not found — is this the right directory?
          </div>
        )}
        <FreshnessInfo data={freshness.bg2} />
      </div>

      <div className="field">
        <label>Mod Directory</label>
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
            Browse
          </button>
        </div>
        <div className="hint">
          Directory containing extracted mod folders (each with a .tp2 file)
        </div>
      </div>

      <h3>Tool Paths</h3>

      <div className="field">
        <label>WeiDU Binary</label>
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
            Browse
          </button>
          <button
            className="btn"
            onClick={handleAutoDetect}
            disabled={autoDetecting}
          >
            {autoDetecting ? "Detecting..." : "Auto-Detect"}
          </button>
        </div>
        {config.weidu_path && (
          <div className="hint valid">
            {weiduVersion || "Found"}
          </div>
        )}
        {!config.weidu_path && (
          <div className="hint">Not detected — browse to select manually</div>
        )}
      </div>

      <div className="field">
        <label>mod_installer Binary</label>
        <div className="row">
          <input
            type="text"
            value={config.mod_installer_path || ""}
            onChange={(e) => update("mod_installer_path", e.target.value)}
            placeholder="Auto-detected from PATH"
          />
          <button
            className="btn"
            onClick={() =>
              browse(
                "mod_installer_path",
                "file",
                "Select mod_installer Binary",
              )
            }
          >
            Browse
          </button>
        </div>
        {config.mod_installer_path && (
          <div className="hint valid">
            {modInstallerVersion || "Found"}
          </div>
        )}
        {!config.mod_installer_path && (
          <div className="hint">Not detected — browse to select manually</div>
        )}
      </div>

      <h3>Advanced</h3>

      <div className="field">
        <label>Forge Data URL</label>
        <div className="row">
          <input
            type="text"
            value={config.forge_data_url || ""}
            onChange={(e) => update("forge_data_url", e.target.value)}
            placeholder="https://anprionsa.github.io/eet-mod-forge"
          />
        </div>
        <div className="hint">
          URL where EET Mod Forge is hosted. Used for pre-flight checks and
          debug matching.
        </div>
      </div>
    </div>
  );
}

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
  getLogPaths,
  openPath,
  type ModDirScan,
  type GameFreshness,
} from "../lib/tauri-bridge";
import { guiLog } from "../lib/gui-logger";
import WelcomeCard from "./WelcomeCard";

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
  };
  installRunning?: boolean;
  /** Phase 14: guided-mode "Next" button at the bottom of the panel.
   * Callback jumps to the next step (Mods). Only rendered when
   * `config.guided_mode && setupValid`. */
  onGoToMods?: () => void;
}

interface Validation {
  bg2: boolean | null;
  bg1: boolean | null;
  iwd: boolean | null;
  iwd2: boolean | null;
  pst: boolean | null;
}

export default function SetupWizard({ config, onSave, configLoaded, preloaded, installRunning, onGoToMods }: Props) {
  const { t } = useI18n();
  const locked = !!installRunning;
  const [validation, setValidation] = useState<Validation>({
    bg2: preloaded?.bg2Valid ?? null,
    bg1: preloaded?.bg1Valid ?? null,
    iwd: null,
    iwd2: null,
    pst: null,
  });
  // "Additional games" section collapses by default unless any optional
  // game path is already set — users who don't care about non-BG targets
  // never see the clutter.
  const [additionalGamesOpen, setAdditionalGamesOpen] = useState<boolean>(
    !!(config.iwd_game_dir || config.iwd2_game_dir || config.pst_game_dir),
  );
  // Phase 19k: "Advanced" section (Forge Data URL, Data Directory) now
  // collapsible to match the Install tab's "Performance & advanced"
  // pattern. Open by default when either field is non-default, so a
  // user who previously overrode those values doesn't have to remember
  // they're there. Fresh configs with both fields blank see it collapsed.
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(
    !!(config.forge_data_url || config.data_directory),
  );
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [weiduVersion, setWeiduVersion] = useState<string | null>(preloaded?.weiduVersion ?? null);
  const [modDirInfo, setModDirInfo] = useState<ModDirScan | null>(preloaded?.modDirScan ?? null);
  const [freshness, setFreshness] = useState<{
    bg1: GameFreshness | null;
    bg2: GameFreshness | null;
  }>({ bg1: preloaded?.bg1Freshness ?? null, bg2: preloaded?.bg2Freshness ?? null });

  // Auto-detect WeiDU on first load if not set
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

  // Optional games (IWD/IWD2/PST) — validate the path but don't bother
  // with freshness checks. These exist purely for backup/restore coverage.
  useEffect(() => {
    if (config.iwd_game_dir) {
      validateGameDir(config.iwd_game_dir).then((v) =>
        setValidation((prev) => ({ ...prev, iwd: v })),
      ).catch(() => setValidation((prev) => ({ ...prev, iwd: false })));
    } else {
      setValidation((prev) => ({ ...prev, iwd: null }));
    }
  }, [config.iwd_game_dir]);
  useEffect(() => {
    if (config.iwd2_game_dir) {
      validateGameDir(config.iwd2_game_dir).then((v) =>
        setValidation((prev) => ({ ...prev, iwd2: v })),
      ).catch(() => setValidation((prev) => ({ ...prev, iwd2: false })));
    } else {
      setValidation((prev) => ({ ...prev, iwd2: null }));
    }
  }, [config.iwd2_game_dir]);
  useEffect(() => {
    if (config.pst_game_dir) {
      validateGameDir(config.pst_game_dir).then((v) =>
        setValidation((prev) => ({ ...prev, pst: v })),
      ).catch(() => setValidation((prev) => ({ ...prev, pst: false })));
    } else {
      setValidation((prev) => ({ ...prev, pst: null }));
    }
  }, [config.pst_game_dir]);

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
      // Always run detection when the user clicks the button — the
      // first-load effect already gates on `!config.weidu_path`, so
      // this path is the explicit "re-detect / correct a stale value"
      // entry point. Previously we short-circuited when weidu_path was
      // truthy, which made the button a no-op once any value was saved.
      const detected = await detectWeidu();
      onSave({
        ...config,
        // Detection miss falls back to the current value rather than
        // clearing it — user-entered paths shouldn't be wiped just
        // because WeiDU isn't on PATH.
        weidu_path: detected || config.weidu_path,
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

      {/* First-run welcome card — visible only on truly-fresh configs
       * (no bg2_game_dir, not yet dismissed). Returning users never see it. */}
      <WelcomeCard config={config} onSave={onSave} />

      {locked && (
        <div className="phase-banner gold" style={{ letterSpacing: 0, textTransform: "none", fontSize: 12 }}>
          {t("setup.locked", "Settings are locked while an install is running")}
        </div>
      )}

      <div style={locked ? { opacity: 0.5, pointerEvents: "none" } : undefined}>

      {/* ── Guided mode toggle (Phase 14, relocated in 19j) ──
       * Moved from the bottom of the tab to just above Game Directories
       * so first-time users see it BEFORE they start filling paths —
       * otherwise the target audience (newcomers) scrolled past it or
       * finished Setup without ever knowing it existed. Compact layout:
       * single row, inline description. Returning users with it off
       * already know what it is and can skim past. */}
      <div style={{
        marginBottom: 16,
        padding: "8px 12px",
        background: "var(--bg2)",
        border: "1px solid var(--brd)",
        borderRadius: 4,
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}>
        <input
          type="checkbox"
          className="checkbox"
          id="guided-mode-toggle"
          checked={config.guided_mode}
          onChange={(e) => onSave({ ...config, guided_mode: e.target.checked })}
        />
        <label htmlFor="guided-mode-toggle" style={{ fontSize: 12, color: "var(--tx)", cursor: "pointer", flex: 1 }}>
          <span style={{ fontWeight: 600 }}>
            {t("setup.guided_mode_label", "Guided mode")}
          </span>
          <span style={{ color: "var(--txd)", marginLeft: 8 }}>
            {t(
              "setup.guided_mode_desc",
              "Locks tabs in order and adds \u201cNext\u201d buttons at the bottom of each step. Recommended if this is your first install — turn off any time to switch to free navigation.",
            )}
          </span>
        </label>
      </div>

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

      {/* ── Additional games (IWD/IWD2/PST) ── */}
      <div style={{ marginBottom: 12 }}>
        <div
          className="log-toggle"
          onClick={() => setAdditionalGamesOpen((v) => !v)}
          style={{ marginBottom: additionalGamesOpen ? 8 : 0 }}
        >
          <span>
            <span className={"toggle-arrow" + (additionalGamesOpen ? " open" : "")}>{"\u25B6"}</span>
            {" "}{t("setup.additional_games", "Additional games (optional)")}
          </span>
          <span style={{ fontSize: 11 }}>
            {t("setup.additional_games_hint", "For cross-game mods — backup / restore coverage only")}
          </span>
        </div>
        {additionalGamesOpen && (
          <>
            {(["iwd", "iwd2", "pst"] as const).map((kind) => {
              const key = `${kind}_game_dir` as const;
              const labelMap = {
                iwd:  t("setup.iwd_label",  "IWD:EE Game Directory"),
                iwd2: t("setup.iwd2_label", "Icewind Dale II Game Directory"),
                pst:  t("setup.pst_label",  "Planescape: Torment EE Game Directory"),
              };
              const placeholderMap = {
                iwd:  "C:\\Games\\Icewind Dale Enhanced Edition",
                iwd2: "C:\\Games\\Icewind Dale II",
                pst:  "C:\\Games\\Planescape Torment Enhanced Edition",
              };
              const v = validation[kind];
              return (
                <div className="field" key={kind}>
                  <label>{labelMap[kind]}</label>
                  <div className="row">
                    <input
                      type="text"
                      value={config[key] || ""}
                      onChange={(e) => update(key, e.target.value)}
                      placeholder={placeholderMap[kind]}
                    />
                    <button
                      className="btn"
                      onClick={() => browse(key, "dir", `Select ${labelMap[kind]}`)}
                    >
                      {t("btn.browse", "Browse")}
                    </button>
                  </div>
                  {v === true && (
                    <div className="hint valid">{t("setup.chitin_found", "chitin.key found")}</div>
                  )}
                  {v === false && (
                    <div className="hint invalid">
                      {t("setup.chitin_not_found", "chitin.key not found — is this the right directory?")}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Phase 19g: renamed "Tool Paths" → "Paths" and moved Mod Directory
       * into this section. The previous layout had "Tool Paths" as a
       * section heading for a single field (WeiDU Binary), while Mod
       * Directory floated between the Game Directories section and the
       * Tool Paths section with no heading of its own. Now both paths
       * live under one "Paths" heading with consistent structure. */}
      <h3>{t("setup.paths_section", "Paths")}</h3>

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
        {/* Forge explainer — gated on the same flag as the welcome card so
         * returning users never see it. Shows below the mod-directory
         * field because that's the point where a new user most likely
         * realizes "I have mods on disk, what's next?" The answer is
         * Forge, which Runner otherwise never introduces. */}
        {!config.welcome_dismissed_at && (
          <div className="hint" style={{ color: "var(--txd)", fontStyle: "italic", marginTop: 6 }}>
            {t(
              "setup.forge_explainer",
              "Not sure where to start? Build your mod list in Infinity Mod Forge and export a WeiDU.log \u2014 that's what Runner imports next.",
            )}
          </div>
        )}
      </div>

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

      {/* ── Advanced (Phase 19k: now collapsible) ──
       * Fresh installs don't need to touch Forge URL or Data Directory,
       * so collapse by default. If either field has a non-default value
       * we open it on mount so returning users don't have to hunt for
       * their override. Matches the Install tab's "Performance & advanced"
       * pattern and the "Additional games (optional)" section above. */}
      <div
        className="log-toggle"
        onClick={() => setAdvancedOpen((v) => !v)}
        style={{ marginBottom: advancedOpen ? 8 : 0 }}
      >
        <span>
          <span className={"toggle-arrow" + (advancedOpen ? " open" : "")}>{"\u25B6"}</span>
          {" "}{t("setup.advanced", "Advanced")}
        </span>
        <span style={{ fontSize: 11, color: "var(--txd)" }}>
          {t("setup.advanced_hint", "Forge URL override and data directory")}
        </span>
      </div>
      {advancedOpen && (<>

      <div className="field">
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {t("setup.forge_url_label", "Forge Data URL")}
          {/* Phase 19e: when the field is blank we're using the program's
           * default URL — this tag makes that state visible instead of
           * letting a technical user wonder whether the placeholder is
           * active or just a suggestion. Disappears the moment they type
           * or paste any override. */}
          {!config.forge_data_url && (
            <span style={{
              fontSize: 10,
              fontWeight: 600,
              color: "var(--cyn)",
              background: "rgba(0,200,255,0.12)",
              border: "1px solid rgba(0,200,255,0.35)",
              borderRadius: 10,
              padding: "1px 8px",
              textTransform: "uppercase",
              letterSpacing: 0.4,
            }}>
              {t("setup.using_default", "using default")}
            </span>
          )}
        </label>
        <div className="row">
          <input
            type="text"
            value={config.forge_data_url || ""}
            onChange={(e) => update("forge_data_url", e.target.value)}
            placeholder="https://anprionsa.github.io/infinity-mod-forge"
          />
        </div>
        <div className="hint">
          {t("setup.forge_url_hint", "URL where Infinity Mod Forge is hosted. Used for pre-flight checks and debug matching.")}
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
          {/* Phase 21c: open the resolved data directory in the OS file
           * manager. Useful when a user wants to clean out old logs or
           * inspect install.log without hunting through the filesystem.
           * Disabled when we can't resolve a path (fresh install with
           * no exe dir — rare but possible on portable builds). */}
          <button
            className="btn"
            onClick={async () => {
              try {
                const lp = await getLogPaths(config);
                const target = lp.paths.data_root;
                if (target) await openPath(target);
              } catch (e) {
                guiLog.warn("UI", `Open data folder failed: ${e}`);
              }
            }}
            title={t("setup.data_dir_open_hint", "Open the resolved data directory in the OS file manager")}
          >
            {t("btn.open", "Open")}
          </button>
        </div>
        <div className="hint">
          {t("setup.data_dir_hint", "Where Infinity Mod Runner stores install logs, checkpoints, and backups. Leave empty to use the default (next to the exe).")}
        </div>
      </div>

      </>)}{/* end Advanced collapsible */}

      {/* ── Guided mode: Next button (Phase 14) ──
       * Only shown when guided_mode is on AND Setup is valid (BG2+BG1+mod
       * dir all configured). Jumps to the Mods tab. Returning users in
       * free-nav mode see the transition banner instead (see Phase 13). */}
      {config.guided_mode && !!config.bg2_game_dir && !!config.bg1_game_dir && !!config.mod_directory && onGoToMods && (
        <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
          <button className="btn btn-primary" onClick={onGoToMods} style={{ fontSize: 13, padding: "6px 18px" }}>
            {t("setup.guided_next", "Next: Import mods")} {"\u2192"}
          </button>
        </div>
      )}

      </div>{/* end locked wrapper */}
    </div>
  );
}

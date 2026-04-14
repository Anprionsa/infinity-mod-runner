import { useState, useCallback, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { guiLog } from "../lib/gui-logger";
import { useI18n } from "../lib/i18n";
import BackupPanel from "./BackupPanel";
import { DEFAULT_FORGE_URL } from "../App";
import type { AppConfig, ParsedLog, PreFlightResult, DownloadReadiness } from "../App";
import {
  verifyWeidu,
  scanModDirectory,
  scanPatches,
  applyPatches,
  listBackups,
  createBackup,
  checkWeiduUpdate,
  type PatchStatus,
  type PatchResult,
  type BackupProgress,
} from "../lib/tauri-bridge";
import {
  fetchKnownIssues,
  fetchCompat,
  fetchResourceUsage,
  checkKitLimit,
  type KnownIssue,
  type CompatData,
} from "../lib/forge-data";

interface Props {
  config: AppConfig;
  onSaveConfig: (config: AppConfig) => void;
  parsedLog: ParsedLog | null;
  result: PreFlightResult | null;
  onResult: (result: PreFlightResult) => void;
  forgeOnline: boolean | null;
  downloadReadiness: DownloadReadiness | null;
  installRunning?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export default function ReadyCheck({
  config, onSaveConfig, parsedLog, result, onResult,
  forgeOnline, downloadReadiness, installRunning,
}: Props) {
  const { t } = useI18n();
  const [running, setRunning] = useState(false);
  const [checkStep, setCheckStep] = useState("");
  const [checkProgress, setCheckProgress] = useState(0);

  // Patch state
  const [patches, setPatches] = useState<PatchStatus[]>([]);
  const [patchApplying, setPatchApplying] = useState(false);
  const [patchResults, setPatchResults] = useState<PatchResult[]>([]);
  const [patchDetailExpanded, setPatchDetailExpanded] = useState(false);

  // WeiDU update state
  const [weiduDownloadUrl, setWeiduDownloadUrl] = useState<string | null>(null);

  // Forge data status (shown as banner, not in checklist)
  const [forgeStatus, setForgeStatus] = useState<string | null>(null);

  // Backup state
  const [backupCreating, setBackupCreating] = useState(false);
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null);
  const [backupManagementExpanded, setBackupManagementExpanded] = useState(false);
  const backupListeners = useRef<UnlistenFn[]>([]);

  // ── Unified Ready Check ──
  const runReadyCheck = useCallback(async () => {
    if (!parsedLog) return;
    setRunning(true);
    setPatchResults([]);
    setCheckStep(t("ready.step_paths", "Validating paths..."));
    setCheckProgress(5);

    const messages: PreFlightResult["messages"] = [];
    const baseUrl = config.forge_data_url || DEFAULT_FORGE_URL;

    // ═══ CONFIG VALIDATION ═══

    // 1. Path validation
    if (!config.bg2_game_dir) messages.push({ t: "err", m: "BG2:EE game directory not set. Go to Setup tab." });
    if (!config.bg1_game_dir) messages.push({ t: "err", m: "BG1:EE game directory not set. Go to Setup tab." });
    if (!config.mod_directory) messages.push({ t: "err", m: "Mod directory not set. Go to Setup tab." });
    if (!config.weidu_path) messages.push({ t: "err", m: "WeiDU path not set. Go to Setup tab." });

    // 2. WeiDU verification + update check
    setCheckStep(t("ready.step_weidu", "Verifying WeiDU..."));
    setCheckProgress(12);
    let weiduVersionStr = "";
    if (config.weidu_path) {
      try {
        const w = await verifyWeidu(config.weidu_path);
        if (w.success) {
          weiduVersionStr = w.version || "";
          messages.push({ t: "ok", m: `WeiDU verified: ${weiduVersionStr}` });
        } else {
          messages.push({ t: "err", m: `WeiDU cannot execute: ${w.error || "Unknown error"}. Check antivirus.` });
        }
      } catch (e) {
        messages.push({ t: "err", m: `WeiDU verification failed: ${e}` });
      }
    }

    // 2b. WeiDU update check (non-blocking — don't fail ready check on network error)
    if (weiduVersionStr) {
      setCheckStep(t("ready.step_weidu_update", "Checking for WeiDU updates..."));
      setCheckProgress(18);
      try {
        const update = await checkWeiduUpdate(weiduVersionStr);
        if (update.isNightly) {
          messages.push({ t: "info", m: `WeiDU ${update.localVersionStr} (development build). Latest stable: ${update.latestVersionStr}` });
        } else if (update.updateAvailable) {
          messages.push({
            t: "action",
            m: `WeiDU update available: ${update.localVersionStr} → ${update.latestVersionStr}`,
            actionId: "weidu-update",
          });
          setWeiduDownloadUrl(update.downloadUrl);
        } else {
          messages.push({ t: "ok", m: `WeiDU ${update.localVersionStr} is up to date` });
        }
      } catch {
        // Network error — skip silently, not critical
      }
    }

    // 3. Mod directory scan
    setCheckStep(t("ready.step_mod_dir", "Scanning mod directory..."));
    setCheckProgress(25);
    if (config.mod_directory) {
      try {
        const s = await scanModDirectory(config.mod_directory);
        if (!s.exists) messages.push({ t: "err", m: "Mod directory does not exist." });
        else if (s.mod_count === 0) messages.push({ t: "err", m: "No mods found in mod directory." });
        else messages.push({ t: "ok", m: `Mod directory: ${s.mod_count} mod folders (${s.tp2_count} .tp2 files)` });
      } catch (e) {
        messages.push({ t: "warn", m: `Could not scan mod directory: ${e}` });
      }
    }

    // 4. Mods on disk
    setCheckStep(t("ready.step_mod_ready", "Checking mod readiness..."));
    setCheckProgress(35);
    if (downloadReadiness) {
      const { totalMods, alreadyHave, missingNames } = downloadReadiness;
      if (missingNames.length === 0) {
        messages.push({ t: "ok", m: `All ${alreadyHave} of ${totalMods} mods are on disk` });
      } else {
        const sev = missingNames.length >= 5 ? "err" : "warn";
        const show = missingNames.slice(0, 10).map(n => `"${n}"`).join(", ");
        const extra = missingNames.length > 10 ? ` and ${missingNames.length - 10} more` : "";
        messages.push({ t: sev as "err" | "warn", m: `${missingNames.length} of ${totalMods} mods not found on disk: ${show}${extra}` });
      }
    } else {
      messages.push({ t: "warn", m: "Mod download status not available. Check the Mods tab." });
    }

    // 5. Essential mods
    setCheckStep(t("ready.step_essentials", "Checking essential mods..."));
    setCheckProgress(45);
    const eetModNames = new Set(parsedLog.entries.map(e => e.mod_name));
    const bgeeModNames = new Set((parsedLog.bgeeEntries || []).map(e => e.mod_name));
    const allModNames = new Set([...eetModNames, ...bgeeModNames]);
    const essentials: { names: string[]; log: "eet" | "all"; severity: "err" | "warn"; message: string }[] = [
      { names: ["eet"], log: "eet", severity: "err", message: "EET core mod not found in EET log" },
      { names: ["eet_end"], log: "eet", severity: "err", message: "EET_End not found in EET log" },
      { names: ["eefixpack", "ee_fixpack"], log: "all", severity: "err", message: "EE Fixpack not found" },
      { names: ["dlcmerger", "dlc_merger"], log: "all", severity: "warn", message: "DLC Merger not found" },
    ];
    for (const c of essentials) {
      const searchIn = c.log === "eet" ? eetModNames : allModNames;
      if (!c.names.some(n => searchIn.has(n))) messages.push({ t: c.severity, m: c.message });
    }

    // 6. Forge data
    setCheckStep(t("ready.step_forge", "Fetching Forge data..."));
    setCheckProgress(55);
    let knownIssues: KnownIssue[] = [];
    let compat: CompatData = {};
    if (forgeOnline) {
      try { knownIssues = await fetchKnownIssues(baseUrl); } catch { /* optional */ }
      try { compat = await fetchCompat(baseUrl); } catch { /* optional */ }
      const parts = [];
      if (knownIssues.length > 0) parts.push(`${knownIssues.length} known issues`);
      if (Object.keys(compat).length > 0) parts.push(`${Object.keys(compat).length} compat entries`);
      setForgeStatus(parts.length > 0 ? `Loaded ${parts.join(" and ")} from Forge` : "Forge connected");
    } else {
      setForgeStatus(null);
      messages.push({ t: "warn", m: "Forge data offline — skipping remote checks" });
    }

    // 7. Compat DB
    setCheckStep(t("ready.step_compat", "Checking compatibility..."));
    setCheckProgress(65);
    for (const [modKey, entry] of Object.entries(compat)) {
      const nk = modKey.toLowerCase().replace(/\s+/g, "");
      const found = [...allModNames].some(m => m.replace(/[_\s-]/g, "") === nk);
      if (entry.ver === "required" && !found) {
        messages.push({ t: "warn", m: `Compat: "${modKey}" required but not found` });
      }
    }

    // 8. Resource limits
    if (forgeOnline) {
      setCheckStep(t("ready.step_resources", "Checking resource limits..."));
      setCheckProgress(72);
      try {
        const modComponentMap = new Map<string, string[]>();
        for (const entry of [...(parsedLog.bgeeEntries || []), ...parsedLog.entries]) {
          const existing = modComponentMap.get(entry.mod_name) || [];
          existing.push(entry.component);
          modComponentMap.set(entry.mod_name, existing);
        }
        const resources = await fetchResourceUsage(baseUrl, modComponentMap);
        const kitCheck = checkKitLimit(resources.totalKits);
        if (resources.totalKits > 0) {
          messages.push({ t: kitCheck.severity, m: kitCheck.message });
        }
        if (resources.spellWarnings.length > 0) {
          for (const w of resources.spellWarnings) {
            const sev = w.count >= w.cap ? "err" : "warn";
            messages.push({ t: sev as "err" | "warn", m: `${w.type} level ${w.level}: ${w.count} spells (cap: ${w.cap})` });
          }
        } else if (resources.totalSpells > 0) {
          messages.push({ t: "ok", m: `Spells: ${resources.totalSpells} new spells. No levels near cap.` });
        }
      } catch (e) {
        messages.push({ t: "warn", m: `Resource limit check failed: ${e}` });
      }
    }

    // 9. Platform
    const platform = typeof navigator !== "undefined" ? navigator.platform : "";
    if (!platform.startsWith("Win")) {
      messages.push({ t: "info", m: `Running on ${platform} — ensure WeiDU matches platform` });
    }

    // ═══ PATCH SCAN ═══
    setCheckStep(t("ready.step_patches", "Scanning for patches..."));
    setCheckProgress(82);
    let patchCount = 0;
    let patchesAllApplied = false;
    if (config.mod_directory && config.bg2_game_dir) {
      try {
        const scanned = await scanPatches(config.mod_directory, config.bg2_game_dir);
        setPatches(scanned);
        const applicable = scanned.filter(p => p.status === "applicable");
        const alreadyPatched = scanned.filter(p => p.status === "already_patched");
        patchCount = applicable.length;
        patchesAllApplied = applicable.length === 0;
        if (applicable.length > 0) {
          messages.push({
            t: "action", m: `${applicable.length} patches available (${alreadyPatched.length} already applied)`,
            actionId: "patches",
          });
        } else if (alreadyPatched.length > 0) {
          messages.push({ t: "ok", m: `Patches: all ${alreadyPatched.length} applied` });
        } else {
          messages.push({ t: "ok", m: "Patches: none needed for this mod list" });
        }
      } catch (e) {
        messages.push({ t: "warn", m: `Patch scan failed: ${e}` });
      }
    }

    // ═══ BACKUP STATUS ═══
    setCheckStep(t("ready.step_backup", "Checking backup status..."));
    setCheckProgress(92);
    let hasBackup = false;
    let latestBackupName: string | undefined;
    const backupDir = config.backup_directory
      || (config.bg2_game_dir ? config.bg2_game_dir.replace(/[/\\][^/\\]+$/, "/eet-mod-runner-backups") : "");
    if (backupDir) {
      try {
        const backups = await listBackups(backupDir);
        const completed = backups.filter(b => b.completed);
        if (completed.length > 0) {
          hasBackup = true;
          latestBackupName = completed[0].name;
          const b = completed[0];
          messages.push({ t: "ok", m: `Backup: "${b.name}" (${b.mode}, ${formatBytes(b.totalBytes)})` });
        } else {
          messages.push({
            t: "action", m: "No backup found. Recommended before a multi-hour install.",
            actionId: "backup",
          });
        }
      } catch {
        messages.push({
          t: "action", m: "No backup found. Recommended before a multi-hour install.",
          actionId: "backup",
        });
      }
    }

    // ═══ SUMMARY ═══
    setCheckStep(t("ready.step_done", "Done"));
    setCheckProgress(100);

    const errCount = messages.filter(m => m.t === "err").length;
    const warnCount = messages.filter(m => m.t === "warn").length;
    const actionCount = messages.filter(m => m.t === "action").length;

    if (errCount === 0 && actionCount === 0 && warnCount === 0) {
      messages.push({ t: "ok", m: "All checks passed. Ready to install." });
    } else if (errCount === 0 && actionCount === 0) {
      messages.push({ t: "ok", m: `Ready to install with ${warnCount} warning(s).` });
    }

    const passed = errCount === 0;
    guiLog.info("READYCHECK", `Complete: ${errCount} errors, ${warnCount} warnings, ${actionCount} actions, patches=${patchCount}, backup=${hasBackup ? "yes" : "no"}`);
    onResult({
      messages, passed, checkedAt: Date.now(),
      patchesAvailable: patchCount,
      patchesApplied: patchesAllApplied,
      backupExists: hasBackup,
      backupName: latestBackupName,
    });
    setRunning(false);
  }, [parsedLog, config, forgeOnline, onResult, downloadReadiness, t]);

  // ── Apply all applicable patches ──
  const handleApplyPatches = useCallback(async () => {
    if (!config.mod_directory || !config.bg2_game_dir) return;
    const applicable = patches.filter(p => p.status === "applicable").map(p => p.id);
    if (applicable.length === 0) return;
    setPatchApplying(true);
    try {
      const results = await applyPatches(config.mod_directory, config.bg2_game_dir, applicable);
      const applied = results.filter(r => r.status === "applied").length;
      const failed = results.filter(r => r.status === "failed").length;
      guiLog.info("READYCHECK", `Patches applied: ${applied} success, ${failed} failed of ${applicable.length}`);
      setPatchResults(results);
      // Re-scan and update result
      const updated = await scanPatches(config.mod_directory, config.bg2_game_dir);
      setPatches(updated);
      const stillApplicable = updated.filter(p => p.status === "applicable").length;
      if (result) {
        const newMessages = result.messages.map(msg =>
          msg.actionId === "patches"
            ? stillApplicable > 0
              ? { ...msg, m: `${stillApplicable} patches still available` }
              : { t: "ok" as const, m: `Patches: all applied successfully` }
            : msg
        );
        onResult({ ...result, messages: newMessages, patchesAvailable: stillApplicable, patchesApplied: stillApplicable === 0 });
      }
    } catch (e) {
      setPatchResults([{ id: -1, name: "Error", status: "failed", error: `${e}` }]);
    } finally {
      setPatchApplying(false);
    }
  }, [config.mod_directory, config.bg2_game_dir, patches, result, onResult]);

  // ── Create quick backup (selective, default name) ──
  const handleQuickBackup = useCallback(async () => {
    if (!config.bg2_game_dir) return;
    const backupDir = config.backup_directory
      || config.bg2_game_dir.replace(/[/\\][^/\\]+$/, "/eet-mod-runner-backups");
    const d = new Date();
    const name = `before-install-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    setBackupCreating(true);
    setBackupProgress(null);

    // Clean up any previous listeners
    backupListeners.current.forEach(fn => fn());
    backupListeners.current = [];

    const cleanup = () => {
      backupListeners.current.forEach(fn => fn());
      backupListeners.current = [];
    };

    try {
      const unsubs: UnlistenFn[] = [];
      unsubs.push(await listen<BackupProgress>("backup:progress", e => setBackupProgress(e.payload)));
      unsubs.push(await listen("backup:complete", () => {
        setBackupCreating(false);
        setBackupProgress(null);
        cleanup();
        if (result) {
          const newMessages = result.messages.map(msg =>
            msg.actionId === "backup"
              ? { t: "ok" as const, m: `Backup: "${name}" (selective, just created)` }
              : msg
          );
          onResult({ ...result, messages: newMessages, backupExists: true, backupName: name });
        }
      }));
      unsubs.push(await listen<string>("backup:error", () => {
        setBackupCreating(false);
        setBackupProgress(null);
        cleanup();
      }));
      backupListeners.current = unsubs;

      guiLog.info("BACKUP", `Creating selective backup: "${name}" to ${backupDir}`);
      await createBackup(config.bg2_game_dir, backupDir, name, "selective");
    } catch (e) {
      setBackupCreating(false);
      setBackupProgress(null);
      cleanup();
    }
  }, [config.bg2_game_dir, config.backup_directory, result, onResult]);

  // ── Banner state ──
  const bannerState = (() => {
    if (!result) return null;
    const hasErrors = result.messages.some(m => m.t === "err");
    const hasActions = result.messages.some(m => m.t === "action");
    if (hasErrors) return "blocked";
    if (hasActions) return "action";
    return "ready";
  })();

  const locked = !!installRunning;

  // ── Render ──
  return (
    <div>
      <h2>{t("ready.heading", "Ready Check")}</h2>
      <p style={{ color: "var(--txd)", marginBottom: 20, fontSize: 13 }}>
        {t("ready.desc", "Validates configuration, scans for patches, and checks backup status before installing.")}
      </p>

      {locked && (
        <div style={{
          textAlign: "center", padding: "8px 0", marginBottom: 16, borderRadius: 6,
          background: "linear-gradient(90deg, transparent, rgba(255,180,40,0.12), transparent)",
          borderTop: "1px solid rgba(255,180,40,0.3)", borderBottom: "1px solid rgba(255,180,40,0.3)",
          fontSize: 12, fontWeight: 600, color: "var(--gold)",
        }}>
          {t("ready.locked", "Install in progress — checks are paused")}
        </div>
      )}

      {!parsedLog && (
        <div style={{
          display: "flex", alignItems: "flex-start", gap: 10, padding: "6px 10px",
          borderRadius: 4, fontSize: 12, color: "var(--tx)",
          background: "var(--bg2)", borderLeft: "3px solid var(--gold)",
        }}>
          <span style={{ color: "var(--gold)", fontWeight: 700, fontSize: 13, width: 14, textAlign: "center" }}>!</span>
          <span>{t("ready.import_first", "Import a WeiDU.log first (Mods tab) before running the ready check.")}</span>
        </div>
      )}

      {parsedLog && !running && (
        <button className="btn btn-primary" onClick={runReadyCheck} style={{ marginBottom: 16 }} disabled={locked}>
          {result ? t("ready.rerun", "Re-run Ready Check") : t("ready.run", "Run Ready Check")}
        </button>
      )}

      {/* ── Running indicator ── */}
      {running && (
        <div className="install-dashboard" style={{ textAlign: "center", padding: 24, marginBottom: 16 }}>
          <div style={{ color: "var(--gold)", fontWeight: 600, marginBottom: 8 }}>{t("ready.running", "Running ready check...")}</div>
          <div style={{ color: "var(--txd)", fontSize: 12, marginBottom: 12 }}>{checkStep}</div>
          <div className="progress-bar" style={{ width: 320, height: 4, margin: "0 auto" }}>
            <div className="fill" style={{ width: `${checkProgress}%`, transition: "width 0.3s ease" }} />
          </div>
        </div>
      )}

      {/* ── Results ── */}
      {result && !running && (
        <>
          {/* Summary Banner */}
          <div style={{
            textAlign: "center", padding: "10px 0", marginBottom: 16, borderRadius: 6,
            background: bannerState === "ready"
              ? "linear-gradient(90deg, transparent, rgba(40,220,100,0.1), transparent)"
              : bannerState === "action"
                ? "linear-gradient(90deg, transparent, rgba(255,180,40,0.1), transparent)"
                : "linear-gradient(90deg, transparent, rgba(255,60,60,0.1), transparent)",
            borderTop: `1px solid ${bannerState === "ready" ? "rgba(40,220,100,0.3)" : bannerState === "action" ? "rgba(255,180,40,0.3)" : "rgba(255,60,60,0.3)"}`,
            borderBottom: `1px solid ${bannerState === "ready" ? "rgba(40,220,100,0.3)" : bannerState === "action" ? "rgba(255,180,40,0.3)" : "rgba(255,60,60,0.3)"}`,
          }}>
            <div style={{
              fontSize: 13, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase",
              color: bannerState === "ready" ? "var(--grn)" : bannerState === "action" ? "var(--gold)" : "var(--red)",
            }}>
              {bannerState === "ready" ? t("ready.banner_ready", "Ready to Install") : bannerState === "action" ? t("ready.banner_action", "Action Needed") : t("ready.banner_blocked", "Blocked")}
            </div>
            {bannerState === "blocked" && (
              <div style={{ fontSize: 11, color: "var(--txd)", marginTop: 6 }}>
                <label style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <input type="checkbox" checked={result.passed} onChange={(e) => { if (e.target.checked) onResult({ ...result, passed: true }); }} />
                  {t("ready.override_risks", "I understand the risks and want to proceed anyway")}
                </label>
              </div>
            )}
          </div>

          {/* Forge data banner */}
          {forgeStatus && (
            <div style={{
              fontSize: 11, color: "var(--cyn)", padding: "4px 10px", marginBottom: 8,
              background: "rgba(0,200,255,0.05)", borderRadius: 4,
              borderLeft: "3px solid rgba(0,200,255,0.3)",
            }}>
              {forgeStatus}
            </div>
          )}

          {/* Checklist */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {result.messages.map((msg, i) => {
              const icon = msg.t === "ok" ? "\u2713" : msg.t === "err" ? "\u2717" : msg.t === "warn" ? "!" : msg.t === "action" ? "\u2699" : "\u2022";
              const color = msg.t === "ok" ? "var(--grn)" : msg.t === "err" ? "var(--red)" : msg.t === "warn" ? "var(--gold)" : msg.t === "action" ? "var(--cyn)" : "var(--cyn)";

              return (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "6px 10px",
                  borderRadius: 4, fontSize: 12, color: "var(--tx)",
                  background: "var(--bg2)", borderLeft: `3px solid ${color}`,
                }}>
                  <span style={{ color, fontWeight: 700, fontSize: 13, flexShrink: 0, width: 14, textAlign: "center" }}>
                    {icon}
                  </span>
                  <span style={{ flex: 1, lineHeight: "18px" }}>{msg.m}</span>

                  {/* Inline action buttons */}
                  {msg.actionId === "patches" && !patchApplying && (
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <button className="btn" onClick={handleApplyPatches}
                        style={{ fontSize: 11, padding: "2px 10px" }}>
                        {t("ready.apply_patches", "Apply Patches")}
                      </button>
                      <button className="btn" onClick={() => setPatchDetailExpanded(!patchDetailExpanded)}
                        style={{ fontSize: 11, padding: "2px 8px" }}>
                        {patchDetailExpanded ? t("btn.hide", "Hide") : t("btn.details", "Details")}
                      </button>
                    </div>
                  )}
                  {msg.actionId === "patches" && patchApplying && (
                    <span style={{ fontSize: 11, color: "var(--gold)", flexShrink: 0 }}>{t("ready.applying", "Applying...")}</span>
                  )}

                  {msg.actionId === "weidu-update" && weiduDownloadUrl && (
                    <button className="btn" onClick={() => { openUrl(weiduDownloadUrl).catch(() => {}); }}
                      style={{ fontSize: 11, padding: "2px 10px" }}>
                      {t("btn.download", "Download")}
                    </button>
                  )}

                  {msg.actionId === "backup" && !backupCreating && (
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <button className="btn" onClick={handleQuickBackup}
                        style={{ fontSize: 11, padding: "2px 10px" }}>
                        {t("ready.create_backup", "Create Backup")}
                      </button>
                      <button className="btn" onClick={() => setBackupManagementExpanded(!backupManagementExpanded)}
                        style={{ fontSize: 11, padding: "2px 8px" }}>
                        {t("btn.settings", "Settings")}
                      </button>
                    </div>
                  )}
                  {msg.actionId === "backup" && backupCreating && (
                    <span style={{ fontSize: 11, color: "var(--gold)", flexShrink: 0 }}>
                      {backupProgress ? `${backupProgress.filesCopied} files...` : t("ready.starting", "Starting...")}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Patch detail expand */}
          {patchDetailExpanded && patches.length > 0 && (
            <div style={{ marginTop: 8, padding: 12, background: "var(--bg2)", borderRadius: 6, border: "1px solid var(--brd)" }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--txd)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
                {t("ready.patch_details", "Patch Details")}
              </div>
              <div style={{ maxHeight: 200, overflowY: "auto" }}>
                {patches.filter(p => p.status !== "not_needed").map(p => (
                  <div key={p.id} style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "3px 0",
                    fontSize: 11, opacity: p.status === "already_patched" ? 0.6 : 1,
                  }}>
                    <span style={{ color: p.status === "applicable" ? "var(--cyn)" : "var(--grn)", width: 14, textAlign: "center" }}>
                      {p.status === "applicable" ? "\u2699" : "\u2713"}
                    </span>
                    <span style={{ flex: 1, color: "var(--gold)" }}>{p.name}</span>
                    <span style={{ fontSize: 10, color: "var(--txd)" }}>
                      {p.status === "applicable" ? t("ready.patch_ready", "Ready") : t("ready.patch_applied", "Applied")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Patch apply results */}
          {patchResults.length > 0 && (
            <div style={{ marginTop: 8, padding: 8, background: "var(--bg2)", borderRadius: 4, border: "1px solid var(--brd)" }}>
              {patchResults.map((r, i) => (
                <div key={i} style={{ fontSize: 11, padding: "2px 0", color: r.status === "applied" ? "var(--grn)" : r.status === "already_patched" ? "var(--txd)" : "var(--red)" }}>
                  {r.status === "applied" ? "\u2713" : r.status === "already_patched" ? "\u2713" : "\u2717"} {r.name}
                  {r.status === "failed" && ` — ${r.error}`}
                </div>
              ))}
            </div>
          )}

          {/* Backup progress bar */}
          {backupCreating && backupProgress && backupProgress.totalBytes > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--txd)", marginBottom: 4 }}>
                <span>{backupProgress.filesCopied.toLocaleString()} / {backupProgress.totalFiles.toLocaleString()} files</span>
                <span>{formatBytes(backupProgress.bytesCopied)} / {formatBytes(backupProgress.totalBytes)}</span>
              </div>
              <div style={{ width: "100%", height: 4, background: "#333", borderRadius: 2 }}>
                <div style={{
                  width: `${Math.min(100, (backupProgress.bytesCopied / backupProgress.totalBytes) * 100)}%`,
                  height: "100%", background: "var(--grn)", borderRadius: 2, transition: "width 0.3s",
                }} />
              </div>
            </div>
          )}

          <div style={{ color: "var(--txd)", fontSize: 11, marginTop: 10 }}>
            {t("ready.checked_at", "Checked at")} {new Date(result.checkedAt).toLocaleTimeString()}
          </div>
        </>
      )}

      {/* ── Backup Management (collapsible) ── */}
      {config.bg2_game_dir && (
        <div style={{ marginTop: 24, borderTop: "1px solid var(--brd)", paddingTop: 16 }}>
          <h3
            style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 8, margin: 0 }}
            onClick={() => setBackupManagementExpanded(!backupManagementExpanded)}
          >
            <span style={{ transform: backupManagementExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s", display: "inline-block" }}>
              {"\u25B6"}
            </span>
            {t("ready.backup_mgmt", "Backup Management")}
          </h3>
          {backupManagementExpanded && (
            <div style={{ marginTop: 12 }}>
              <BackupPanel config={config} onSaveConfig={onSaveConfig} installRunning={installRunning} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

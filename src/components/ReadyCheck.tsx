import { useState, useCallback, useRef, useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { guiLog } from "../lib/gui-logger";
import { useI18n } from "../lib/i18n";
import BackupPanel from "./BackupPanel";
import { DEFAULT_FORGE_URL } from "../App";
import type { AppConfig, ParsedLog, PreFlightResult, DownloadReadiness, Tab } from "../App";
import EmptyState from "./EmptyState";
import {
  verifyWeidu,
  scanModDirectory,
  testJunctionCapability,
  checkDiskSpaces,
  scanPatches,
  applyPatches,
  listBackups,
  createBackup,
  checkWeiduUpdate,
  scanOrphanBackups,
  cleanOrphanBackups,
  weiduSwapStatus,
  weiduSwapExtract,
  weiduSwapClearCache,
  type PatchStatus,
  type PatchCategory,
  type PatchResult,
  type BackupProgress,
  type OrphanBackup,
  type WeiduSwapStatus,
} from "../lib/tauri-bridge";
import ExperimentalWeiduModal from "./ExperimentalWeiduPanel";
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
  /** Cross-tab navigation for empty-state "Go to Mods tab" action. */
  onGoToTab?: (tab: Tab) => void;
  /** Phase 14: guided-mode Next button at panel bottom. */
  guidedMode?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export default function ReadyCheck({
  config, onSaveConfig, parsedLog, result, onResult,
  forgeOnline, downloadReadiness, installRunning,
  onGoToTab,
  guidedMode,
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
  // Per-patch selection. Defaulted from `recommended` field on scan; user toggles
  // via checkboxes in the patch details panel. ID-based so it survives re-scans.
  const [selectedPatchIds, setSelectedPatchIds] = useState<Set<number>>(new Set());

  // Orphan mod-local WeiDU backup/ dirs (state drift from prior failed installs
  // or game-dir restores that leave per-mod backup metadata pointing at
  // phantom components; see scan_orphan_backups in commands.rs)
  const [orphans, setOrphans] = useState<OrphanBackup[]>([]);
  const [orphanCleaning, setOrphanCleaning] = useState(false);
  const [orphanRescanning, setOrphanRescanning] = useState(false);

  // WeiDU update state
  const [weiduDownloadUrl, setWeiduDownloadUrl] = useState<string | null>(null);

  // Forge data status (shown as banner, not in checklist)
  const [forgeStatus, setForgeStatus] = useState<string | null>(null);

  // Backup state
  const [backupCreating, setBackupCreating] = useState(false);
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null);
  const [backupManagementExpanded, setBackupManagementExpanded] = useState(false);
  const backupListeners = useRef<UnlistenFn[]>([]);

  // Experimental WeiDU state — scanned at ready-check time, toggled via modal.
  // The `useExperimentalWeidu` user preference lives in config and is mutated
  // via onSaveConfig(); the swap status itself is pulled from the backend.
  const [weiduSwap, setWeiduSwap] = useState<WeiduSwapStatus | null>(null);
  const [weiduSwapBusy, setWeiduSwapBusy] = useState(false);
  const [weiduSwapModal, setWeiduSwapModal] = useState<"enable" | "disable" | null>(null);

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

    // 4b. Environment capability: junction/symlink + disk space
    // These moved here from Dry Run. Rationale: they're environment checks
    // (can the OS do what WeiDU needs, is there room) — not install-plan
    // simulation. Dry Run now focuses purely on what WeiDU will do.
    setCheckStep(t("ready.step_system", "Checking system..."));
    setCheckProgress(40);
    if (config.bg2_game_dir) {
      try {
        const j = await testJunctionCapability(config.bg2_game_dir);
        if (j.ok) {
          messages.push({ t: "ok", m: "Junction/symlink: OK" });
        } else {
          // WeiDU uses junctions for tlk acceleration and the mod folder
          // staging. A failure here usually means an antivirus or a
          // filesystem that doesn't support it — blocking, not warning.
          messages.push({
            t: "err",
            m: `Junction/symlink creation failed: ${j.error || "unknown"}. Required for install.`,
          });
        }
      } catch (e) {
        messages.push({ t: "warn", m: `Junction test failed to run: ${e}` });
      }
    }
    if (config.bg2_game_dir && config.mod_directory) {
      try {
        const disk = await checkDiskSpaces(
          config.bg2_game_dir,
          config.data_directory || config.bg2_game_dir,
          config.mod_directory,
        );
        // Rough footprint estimate: 2 MB per EET component. Ready Check
        // doesn't parse batches, so use mod component count as a proxy.
        const compCount = (parsedLog.entries.length + (parsedLog.bgeeEntries?.length || 0));
        const estBytes = compCount * 2 * 1024 * 1024;
        const recommend = estBytes * 2; // 2x footprint for WeiDU work area
        const fmt = (n: number) => {
          if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
          if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
          return `${(n / 1024).toFixed(0)} KB`;
        };
        if (disk.gameFree > 0 && disk.gameFree < recommend) {
          messages.push({
            t: "warn",
            m: `Game dir has ${fmt(disk.gameFree)} free — recommended: ${fmt(recommend)} for this install`,
          });
        } else if (disk.gameFree > 0) {
          messages.push({ t: "ok", m: `Disk space: ${fmt(disk.gameFree)} free on game drive` });
        }
        if (disk.dataFree > 0 && disk.dataFree < 2 * 1024 ** 3) {
          messages.push({
            t: "warn",
            m: `Data dir has ${fmt(disk.dataFree)} free — 2 GB recommended for backups/debug logs`,
          });
        }
      } catch (e) {
        messages.push({ t: "warn", m: `Disk space check failed: ${e}` });
      }
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
        // Default selection: all applicable + recommended + required patches checked.
        // Required patches are ALWAYS included — they're install-critical.
        // Preserve any explicit user toggles from prior scan (so re-running readycheck
        // doesn't reset their choices).
        setSelectedPatchIds(prev => {
          const next = new Set(prev);
          for (const p of scanned) {
            if (p.status === "applicable") {
              // Required patches are force-selected, period.
              if (p.category === "required") {
                next.add(p.id);
                continue;
              }
              if (!prev.has(p.id) && !Array.from(prev).some(x => x === -1) && p.recommended) {
                next.add(p.id);
              } else if (!p.recommended && !prev.has(p.id)) {
                // ensure non-recommended stay off unless user opted in
                next.delete(p.id);
              }
            } else {
              // not_needed or already_patched — drop from selection
              next.delete(p.id);
            }
          }
          // First-ever scan: prev is empty; take recommended + required applicables
          if (prev.size === 0) {
            return new Set(scanned
              .filter(p => p.status === "applicable" && (p.recommended || p.category === "required"))
              .map(p => p.id));
          }
          return next;
        });
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

    // ═══ EXPERIMENTAL WEIDU SCAN ═══
    // Read the bundled binary's meta + cache validity. Surfaces one row with
    // either "enabled" (ok) or "available" (action) depending on config. The
    // row sits alongside the patches row — both modify install-time behaviour,
    // the patches by altering mod TP2 files, this by swapping the WeiDU binary
    // the installer invokes.
    try {
      const swap = await weiduSwapStatus(config.data_directory ?? null);
      setWeiduSwap(swap);
      if (swap.supported) {
        if (config.use_experimental_weidu) {
          messages.push({
            t: "ok",
            m: `Resilient WeiDU: enabled (${swap.meta?.base_weidu_version ?? "?"} + patch rev ${swap.meta?.patch_revision ?? "?"})`,
            actionId: "weidu_exp_enabled",
          });
        } else {
          messages.push({
            t: "action",
            m: `Resilient WeiDU available — catches BCS round-trip failures at engine level (experimental)`,
            actionId: "weidu_exp_disabled",
          });
        }
      }
    } catch (e) {
      // Non-fatal: if meta.json is missing in a dev build, just don't offer the feature.
      guiLog.debug("EXPERIMENTAL", `Swap status unavailable: ${e}`);
    }

    // ═══ ORPHAN MOD BACKUP SCAN ═══
    // Mod-local WeiDU backup/ dirs that outlived the game-dir state they described.
    // Typically created when a game restore wipes WeiDU.log but per-mod backups survive.
    // We surface them as an "action" row (same pattern as patches) so users can clean them
    // explicitly; auto-clean only happens inside restore_backup itself.
    if (config.mod_directory) {
      try {
        const found = await scanOrphanBackups(config.mod_directory);
        setOrphans(found);
        if (found.length > 0) {
          const totalMb = found.reduce((a, b) => a + b.sizeBytes, 0) / 1_048_576;
          messages.push({
            t: "action",
            m: `${found.length} orphaned mod backup${found.length === 1 ? "" : "s"} (${totalMb.toFixed(1)} MB) — stale per-mod state from prior installs`,
            actionId: "orphan_backups",
          });
        }
      } catch (e) {
        messages.push({ t: "warn", m: `Orphan backup scan failed: ${e}` });
      }
    }

    // ═══ BACKUP STATUS ═══
    setCheckStep(t("ready.step_backup", "Checking backup status..."));
    setCheckProgress(92);
    let hasBackup = false;
    let latestBackupName: string | undefined;
    const backupDir = config.backup_directory
      || (config.bg2_game_dir ? config.bg2_game_dir.replace(/[/\\][^/\\]+$/, "/infinity-mod-runner-backups") : "");
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
    const actionMsgs = messages.filter(m => m.t === "action");
    const actionCount = actionMsgs.length;
    // Extract a short label (first 3–4 words) from each action message for the log tail.
    const actionLabels = actionMsgs.map(m =>
      String(m.m).split(/\s+/).slice(0, 4).join(" ").replace(/[^\w\s\-]/g, "").trim()
    ).filter(Boolean);

    if (errCount === 0 && actionCount === 0 && warnCount === 0) {
      messages.push({ t: "ok", m: "All checks passed. Ready to install." });
    } else if (errCount === 0 && actionCount === 0) {
      messages.push({ t: "ok", m: `Ready to install with ${warnCount} warning(s).` });
    }

    const passed = errCount === 0;
    const actionsList = actionLabels.length ? `[${actionLabels.join(", ")}]` : "none";
    guiLog.info("READYCHECK", `Complete: ${errCount} errors, ${warnCount} warnings, ${actionCount} actions — actions=${actionsList}, patches=${patchCount}, backup=${hasBackup ? "yes" : "no"}`);
    onResult({
      messages, passed, checkedAt: Date.now(),
      patchesAvailable: patchCount,
      patchesApplied: patchesAllApplied,
      backupExists: hasBackup,
      backupName: latestBackupName,
    });
    setRunning(false);
  }, [parsedLog, config, forgeOnline, onResult, downloadReadiness, t]);

  // ── Apply selected patches ──
  // Selection is per-patch via the checkbox grid in the details panel.
  // Only applicable+selected IDs are sent — backend silently no-ops anything that's
  // already marker-detected as patched, but we filter here to keep the UX honest.
  const handleApplyPatches = useCallback(async () => {
    if (!config.mod_directory || !config.bg2_game_dir) return;
    const toApply = patches
      .filter(p => p.status === "applicable" && selectedPatchIds.has(p.id))
      .map(p => p.id);
    if (toApply.length === 0) return;
    setPatchApplying(true);
    try {
      const results = await applyPatches(config.mod_directory, config.bg2_game_dir, toApply);
      const applied = results.filter(r => r.status === "applied").length;
      const failed = results.filter(r => r.status === "failed").length;
      guiLog.info("READYCHECK", `Patches applied: ${applied} success, ${failed} failed of ${toApply.length}`);
      setPatchResults(results);
      // Re-scan and update result
      const updated = await scanPatches(config.mod_directory, config.bg2_game_dir);
      setPatches(updated);
      // Prune selection: drop IDs whose post-apply status is no longer
      // "applicable" (mostly the ones we just successfully patched). Without
      // this, `selectedPatchIds` lingers with stale IDs and the Apply button
      // count mis-renders until the user re-runs Ready Check.
      const stillApplicableIds = new Set(
        updated.filter(p => p.status === "applicable").map(p => p.id)
      );
      setSelectedPatchIds(prev => {
        const next = new Set<number>();
        for (const id of prev) {
          if (stillApplicableIds.has(id)) next.add(id);
        }
        return next;
      });
      const stillApplicable = stillApplicableIds.size;
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
  }, [config.mod_directory, config.bg2_game_dir, patches, selectedPatchIds, result, onResult]);

  // Toggle a single patch in the selection set.
  const togglePatchSelection = useCallback((id: number) => {
    setSelectedPatchIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // ── Orphaned mod-local WeiDU backups: rescan ──
  // Phase 19d: previously the orphan count only refreshed on a full
  // Ready Check re-run. That was inconsistent with patches (which refresh
  // on apply), and the count silently went stale after a game restore
  // blew away WeiDU.log but left per-mod backup dirs behind. This handler
  // is also wired to the `restore:complete` event (see below) so the
  // orphan row auto-updates whenever a restore happens elsewhere in the
  // app, plus exposed as a button on the row for manual refresh.
  const handleRescanOrphans = useCallback(async () => {
    if (!config.mod_directory) return;
    setOrphanRescanning(true);
    try {
      const updated = await scanOrphanBackups(config.mod_directory);
      setOrphans(updated);
      if (result) {
        const totalMb = updated.reduce((a, b) => a + b.sizeBytes, 0) / 1_048_576;
        const newMessages = result.messages.map(msg => {
          if (msg.actionId !== "orphan_backups") return msg;
          if (updated.length === 0) {
            return { t: "ok" as const, m: "Orphan backups: none remaining" };
          }
          return {
            ...msg,
            m: `${updated.length} orphaned mod backup${updated.length === 1 ? "" : "s"} (${totalMb.toFixed(1)} MB) — stale per-mod state from prior installs`,
          };
        });
        // If no orphan row existed (rare: orphans appeared post-check)
        // AND the current scan found some, inject a new action row so the
        // count becomes visible without a full re-scan.
        const hasOrphanRow = newMessages.some(m => m.actionId === "orphan_backups");
        if (!hasOrphanRow && updated.length > 0) {
          newMessages.push({
            t: "action",
            m: `${updated.length} orphaned mod backup${updated.length === 1 ? "" : "s"} (${totalMb.toFixed(1)} MB) — stale per-mod state from prior installs`,
            actionId: "orphan_backups",
          });
        }
        onResult({ ...result, messages: newMessages });
      }
      guiLog.info("READYCHECK", `Orphan rescan: ${updated.length} remaining`);
    } catch (e) {
      guiLog.warn("READYCHECK", `Orphan rescan failed: ${e}`);
    } finally {
      setOrphanRescanning(false);
    }
  }, [config.mod_directory, result, onResult]);

  // Auto-rescan orphans whenever a backup restore finishes anywhere in
  // the app. Without this, a user who restores a game backup via the
  // Backup Management panel keeps seeing the pre-restore orphan count
  // (or a missing orphan row) until they re-run the full Ready Check.
  // Patches already have a parallel refresh path via scanPatches on apply.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        const u: UnlistenFn = await listen("restore:complete", () => {
          // Don't re-run if Ready Check hasn't been run yet — nothing to
          // update in that case (orphan state is only tracked as part of
          // a ready-check result).
          if (!result || !config.mod_directory) return;
          handleRescanOrphans();
        });
        if (cancelled) { u(); return; }
        unlisten = u;
      } catch (e) {
        guiLog.warn("READYCHECK", `restore:complete listener setup failed: ${e}`);
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [result, config.mod_directory, handleRescanOrphans]);

  // ── Clean orphaned mod-local WeiDU backups ──
  const handleCleanOrphans = useCallback(async () => {
    if (orphans.length === 0) return;
    setOrphanCleaning(true);
    try {
      const paths = orphans.map(o => o.path);
      const cleaned = await cleanOrphanBackups(paths);
      guiLog.info("READYCHECK", `Cleaned ${cleaned.length} orphan mod backup dirs`);
      // Re-scan
      if (config.mod_directory) {
        const updated = await scanOrphanBackups(config.mod_directory);
        setOrphans(updated);
        if (result) {
          const newMessages = result.messages.map(msg =>
            msg.actionId === "orphan_backups"
              ? updated.length > 0
                ? { ...msg, m: `${updated.length} orphaned mod backups remaining` }
                : { t: "ok" as const, m: `Orphan backups: all ${cleaned.length} cleaned` }
              : msg
          );
          onResult({ ...result, messages: newMessages });
        }
      }
    } catch (e) {
      guiLog.error("READYCHECK", `Orphan cleanup failed: ${e}`);
    } finally {
      setOrphanCleaning(false);
    }
  }, [orphans, config.mod_directory, result, onResult]);

  // ── Experimental WeiDU toggle handlers ──
  // Enable = extract the bundled binary to the cache, then flip the config
  // bit. Extraction happens synchronously so a failure (unsupported platform,
  // corrupt zip) is visible BEFORE we claim the feature is enabled.
  const handleEnableWeidu = useCallback(async () => {
    setWeiduSwapModal(null);
    setWeiduSwapBusy(true);
    try {
      const swap = await weiduSwapExtract(config.data_directory ?? null);
      setWeiduSwap(swap);
      onSaveConfig({ ...config, use_experimental_weidu: true });
      guiLog.info(
        "EXPERIMENTAL",
        `Resilient WeiDU enabled — cache at ${swap.cachePath ?? "?"}`
      );
      // Rewrite the row in-place so UI reflects the new state without a
      // full ready-check re-run.
      if (result) {
        const newMessages = result.messages.map(msg =>
          msg.actionId === "weidu_exp_disabled"
            ? {
                t: "ok" as const,
                m: `Resilient WeiDU: enabled (${swap.meta?.base_weidu_version ?? "?"} + patch rev ${swap.meta?.patch_revision ?? "?"})`,
                actionId: "weidu_exp_enabled",
              }
            : msg
        );
        onResult({ ...result, messages: newMessages });
      }
    } catch (e) {
      guiLog.error("EXPERIMENTAL", `Enable failed: ${e}`);
      alert(`Could not enable Resilient WeiDU: ${e}`);
    } finally {
      setWeiduSwapBusy(false);
    }
  }, [config, onSaveConfig, result, onResult]);

  const handleDisableWeidu = useCallback(async () => {
    setWeiduSwapModal(null);
    setWeiduSwapBusy(true);
    try {
      // Keep the cache file by default — it's tiny and lets re-enable be
      // instant. User can wipe it manually by deleting the data dir.
      onSaveConfig({ ...config, use_experimental_weidu: false });
      guiLog.info("EXPERIMENTAL", "Resilient WeiDU disabled");
      if (result) {
        const newMessages = result.messages.map(msg =>
          msg.actionId === "weidu_exp_enabled"
            ? {
                t: "action" as const,
                m: `Resilient WeiDU available — catches BCS round-trip failures at engine level (experimental)`,
                actionId: "weidu_exp_disabled",
              }
            : msg
        );
        onResult({ ...result, messages: newMessages });
      }
    } finally {
      setWeiduSwapBusy(false);
    }
  }, [config, onSaveConfig, result, onResult]);

  // Explicit cache wipe — rare; exposed only in case the cache gets corrupted.
  // Currently unused in UI, kept for future "clear cache" button if needed.
  const handleClearWeiduCache = useCallback(async () => {
    try {
      const swap = await weiduSwapClearCache(config.data_directory ?? null);
      setWeiduSwap(swap);
      guiLog.info("EXPERIMENTAL", "Cleared cached patched WeiDU binary");
    } catch (e) {
      guiLog.error("EXPERIMENTAL", `Cache clear failed: ${e}`);
    }
  }, [config.data_directory]);
  void handleClearWeiduCache; // silence unused warning until wired to a button

  // ── Create quick backup (selective, default name) ──
  const handleQuickBackup = useCallback(async () => {
    if (!config.bg2_game_dir) return;
    const backupDir = config.backup_directory
      || config.bg2_game_dir.replace(/[/\\][^/\\]+$/, "/infinity-mod-runner-backups");
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
      // EET pre-install backup is always BG2 — the install primarily writes
      // to BG2:EE (with a transient touch on BG1:EE for pre-EET mods).
      // Multi-game backups for IWD/IWD2/PST live in the BackupPanel under
      // Ready Check → Backup Management.
      await createBackup(config.bg2_game_dir, backupDir, name, "selective", "bg2");
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
        <div className="phase-banner gold" style={{ letterSpacing: 0, textTransform: "none", fontSize: 12 }}>
          {t("ready.locked", "Install in progress — checks are paused")}
        </div>
      )}

      {/* Note: the "Mod list imported" transition banner was removed in
       * Phase 19a. The standalone Run Ready Check button below already
       * signals what to do; the banner was a visual duplicate. The
       * banner-state wiring is retained (as a no-op) for symmetry with
       * the other transition-banner slots in App.tsx. */}

      {!parsedLog && !locked && (
        <EmptyState
          title={t("ready.empty_title", "Nothing to check yet")}
          body={t(
            "ready.empty_body",
            "Import a mod list in the Mods tab first. Once you have one, this tab will validate mod presence, engine limits, known issues, and scan for applicable patches.",
          )}
          actions={
            onGoToTab
              ? [{ label: t("ready.empty_go_mods", "Go to Mods tab"), onClick: () => onGoToTab("mods"), primary: true }]
              : undefined
          }
        />
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
          {(() => {
            // Phase 19b: the banner used to read "ACTION NEEDED" whenever
            // any single row needed action, which implied the entire
            // results block needed attention — confusing when 11 of 13
            // rows had passed. Compute the actual breakdown and show it
            // in the subtitle so users can see "most of this is fine,
            // here's what you need to look at."
            const okCount = result.messages.filter((m) => m.t === "ok").length;
            const actionCount = result.messages.filter((m) => m.t === "action").length;
            const errCount = result.messages.filter((m) => m.t === "err").length;
            const warnCount = result.messages.filter((m) => m.t === "warn").length;
            const subtitle: string =
              bannerState === "ready"
                ? t("ready.banner_ready_sub", "{ok} passed \u2014 ready to install")
                    .replace("{ok}", String(okCount))
                : bannerState === "action"
                  ? t(
                      "ready.banner_action_sub",
                      "{ok} passed, {action} need your attention",
                    )
                      .replace("{ok}", String(okCount))
                      .replace("{action}", String(actionCount + warnCount))
                  : t(
                      "ready.banner_blocked_sub",
                      "{err} blocking, {ok} passed \u2014 resolve errors before proceeding",
                    )
                      .replace("{err}", String(errCount))
                      .replace("{ok}", String(okCount));
            return (
              <div
                className={`phase-banner ${bannerState === "ready" ? "green" : bannerState === "action" ? "gold" : "red"}`}
                style={{ padding: "10px 0", marginBottom: 16, fontSize: 13, letterSpacing: 1 }}
              >
                <div>
                  {bannerState === "ready"
                    ? t("ready.banner_ready", "Results \u2014 Ready to Install")
                    : bannerState === "action"
                      ? t("ready.banner_action", "Results")
                      : t("ready.banner_blocked", "Results \u2014 Blocked")}
                </div>
                <div style={{ fontSize: 11, color: "var(--txd)", marginTop: 4, textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>
                  {subtitle}
                </div>
                {bannerState === "blocked" && (
                  <div style={{ fontSize: 11, color: "var(--txd)", marginTop: 6 }}>
                    <label style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <input className="checkbox" type="checkbox" checked={result.passed} onChange={(e) => { if (e.target.checked) onResult({ ...result, passed: true }); }} />
                      {t("ready.override_risks", "I understand the risks and want to proceed anyway")}
                    </label>
                  </div>
                )}
              </div>
            );
          })()}

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
              // Phase 19d: elevate the orphan-backups row when the total
              // stale size crosses 1 GB. A few hundred MB is fine to leave
              // alone; multi-GB accumulations should draw the eye because
              // (a) it's real disk pressure, and (b) if the user restored
              // recently those backups are almost certainly safe to clean.
              const ORPHAN_ELEVATED_BYTES_THRESHOLD = 1_073_741_824; // 1 GB
              const orphanTotalBytes = orphans.reduce((a, b) => a + b.sizeBytes, 0);
              const isLargeOrphan =
                msg.actionId === "orphan_backups" &&
                orphanTotalBytes >= ORPHAN_ELEVATED_BYTES_THRESHOLD;

              const icon = msg.t === "ok" ? "\u2713"
                : msg.t === "err" ? "\u2717"
                : msg.t === "warn" ? "!"
                : msg.t === "action" ? (isLargeOrphan ? "\u26A0" : "\u2699")
                : "\u2022";
              // Phase 19b: "action" rows were rendering in cyan which made
              // them visually indistinguishable from a generic "info" row.
              // Promoting to amber/gold puts them in the same visual
              // weight as `warn` rows — the user's eye lands on them
              // among a sea of green ✓ passes, which is the whole point
              // of the Results banner saying "2 need your attention."
              const color = msg.t === "ok" ? "var(--grn)"
                : msg.t === "err" ? "var(--red)"
                : msg.t === "warn" ? "var(--gold)"
                : msg.t === "action" ? (isLargeOrphan ? "var(--org)" : "var(--gold)")
                : "var(--cyn)";
              // Amber wash on the background for action/warn rows so they
              // read as "this one" instead of blending with the passing
              // rows. Subtle — 8% opacity — not alarming, just visible.
              // Large-orphan rows get a slightly stronger orange wash so
              // "you have 6 GB of stale backup data" doesn't look like
              // just another gentle nudge.
              const tint = isLargeOrphan
                ? "rgba(255, 140, 40, 0.14)"
                : (msg.t === "action" || msg.t === "warn")
                  ? "rgba(255, 180, 40, 0.08)"
                  : "var(--bg2)";

              return (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "6px 10px",
                  borderRadius: 4, fontSize: 12, color: "var(--tx)",
                  background: tint, borderLeft: `3px solid ${color}`,
                }}>
                  <span style={{ color, fontWeight: 700, fontSize: 13, flexShrink: 0, width: 14, textAlign: "center" }}>
                    {icon}
                  </span>
                  <span style={{ flex: 1, lineHeight: "18px" }}>{msg.m}</span>

                  {/* Inline action buttons.
                   * IMPORTANT: the count shown must be applicable+selected
                   * (not raw selection size). `selectedPatchIds` persists
                   * IDs across re-scans, so after a successful apply it
                   * still contains the IDs for patches that became
                   * "already_patched". Showing the raw size led to confusing
                   * output like "Apply Selected (7)" under a banner that
                   * correctly said "2 patches still available". */}
                  {msg.actionId === "patches" && !patchApplying && (() => {
                    const applicableSelected = patches.filter(
                      p => p.status === "applicable" && selectedPatchIds.has(p.id)
                    ).length;
                    return (
                    <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
                      <button className="btn" onClick={handleApplyPatches}
                        disabled={applicableSelected === 0}
                        style={{ fontSize: 11, padding: "2px 10px",
                                 opacity: applicableSelected === 0 ? 0.5 : 1,
                                 cursor: applicableSelected === 0 ? "not-allowed" : "pointer" }}>
                        {t("ready.apply_selected", "Apply Selected")} ({applicableSelected})
                      </button>
                      <button className="btn" onClick={() => setPatchDetailExpanded(!patchDetailExpanded)}
                        style={{ fontSize: 11, padding: "2px 8px" }}>
                        {patchDetailExpanded ? t("btn.hide", "Hide") : t("btn.details", "Details")}
                      </button>
                    </div>
                    );
                  })()}
                  {msg.actionId === "patches" && patchApplying && (
                    <span style={{ fontSize: 11, color: "var(--gold)", flexShrink: 0 }}>{t("ready.applying", "Applying...")}</span>
                  )}

                  {msg.actionId === "orphan_backups" && !orphanCleaning && !orphanRescanning && (
                    <>
                      <button className="btn" onClick={handleRescanOrphans}
                        title={t("ready.rescan_orphans_hint", "Refresh the orphan count without re-running the full Ready Check. Useful after a backup restore.")}
                        style={{ fontSize: 11, padding: "2px 10px", flexShrink: 0 }}>
                        {t("ready.rescan_orphans", "Rescan")}
                      </button>
                      <button className="btn" onClick={handleCleanOrphans}
                        style={{ fontSize: 11, padding: "2px 10px", flexShrink: 0 }}>
                        {t("ready.clean_orphans", "Clean")}
                      </button>
                    </>
                  )}
                  {msg.actionId === "orphan_backups" && orphanCleaning && (
                    <span style={{ fontSize: 11, color: "var(--gold)", flexShrink: 0 }}>{t("ready.cleaning", "Cleaning...")}</span>
                  )}
                  {msg.actionId === "orphan_backups" && orphanRescanning && !orphanCleaning && (
                    <span style={{ fontSize: 11, color: "var(--gold)", flexShrink: 0 }}>{t("ready.rescanning", "Rescanning...")}</span>
                  )}

                  {msg.actionId === "weidu-update" && weiduDownloadUrl && (
                    <button className="btn" onClick={() => { openUrl(weiduDownloadUrl).catch(() => {}); }}
                      style={{ fontSize: 11, padding: "2px 10px" }}>
                      {t("btn.download", "Download")}
                    </button>
                  )}

                  {msg.actionId === "weidu_exp_disabled" && !weiduSwapBusy && (
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <button className="btn" onClick={() => setWeiduSwapModal("enable")}
                        style={{ fontSize: 11, padding: "2px 10px" }}>
                        {t("ready.weidu_exp_enable", "Enable")}
                      </button>
                    </div>
                  )}
                  {msg.actionId === "weidu_exp_enabled" && !weiduSwapBusy && (
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <button className="btn btn-secondary" onClick={() => setWeiduSwapModal("disable")}
                        style={{ fontSize: 11, padding: "2px 10px" }}>
                        {t("ready.weidu_exp_disable", "Disable")}
                      </button>
                    </div>
                  )}
                  {(msg.actionId === "weidu_exp_disabled" || msg.actionId === "weidu_exp_enabled") && weiduSwapBusy && (
                    <span style={{ fontSize: 11, color: "var(--gold)", flexShrink: 0 }}>{t("ready.weidu_exp_working", "Working...")}</span>
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
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--txd)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                  {t("ready.patch_details", "Patch Details")}
                </div>
                {(() => {
                  const applicable = patches.filter(p => p.status === "applicable");
                  const recommended = applicable.filter(p => p.recommended);
                  const required = applicable.filter(p => p.category === "required");
                  const selectedAppl = applicable.filter(p => selectedPatchIds.has(p.id));
                  const allSelected = selectedAppl.length === applicable.length && applicable.length > 0;
                  // "None" never clears required patches — they stay sticky.
                  const noneSelected = selectedAppl.length === required.length &&
                    required.every(p => selectedPatchIds.has(p.id));
                  const recSelected = selectedAppl.length === recommended.length && selectedAppl.every(p => p.recommended);
                  const active: "all" | "none" | "recommended" | null =
                    allSelected ? "all" :
                    recSelected && recommended.length > 0 ? "recommended" :
                    noneSelected && required.length > 0 ? "none" :
                    selectedAppl.length === 0 ? "none" :
                    null;
                  return (
                    <div className="segmented" role="group" aria-label="Patch selection">
                      <button
                        type="button"
                        className={"segmented-btn" + (active === "all" ? " ac" : "")}
                        onClick={() => setSelectedPatchIds(new Set(applicable.map(p => p.id)))}
                        style={{ fontSize: 10, padding: "2px 10px" }}
                      >
                        {t("ready.select_all", "All")}
                      </button>
                      <button
                        type="button"
                        className={"segmented-btn" + (active === "recommended" ? " ac" : "")}
                        onClick={() => setSelectedPatchIds(new Set(recommended.map(p => p.id)))}
                        disabled={recommended.length === 0}
                        style={{ fontSize: 10, padding: "2px 10px" }}
                      >
                        {t("ready.select_recommended", "Recommended")}
                      </button>
                      <button
                        type="button"
                        className={"segmented-btn" + (active === "none" ? " ac" : "")}
                        onClick={() => setSelectedPatchIds(new Set(required.map(p => p.id)))}
                        title={required.length > 0 ? t("ready.select_none_sticky_hint", "'None' leaves required patches selected — they can't be bulk-deselected.") : undefined}
                        style={{ fontSize: 10, padding: "2px 10px" }}
                      >
                        {t("ready.select_none", "None")}
                      </button>
                    </div>
                  );
                })()}
              </div>
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                {(() => {
                  // Render patches grouped by category. Order:
                  // required → bugfix → compat → performance → cosmetic.
                  // Empty categories are hidden. `not_needed` patches are
                  // still filtered out (same as before).
                  const CATEGORY_ORDER: PatchCategory[] = ["required", "bugfix", "compat", "performance", "cosmetic"];
                  const CATEGORY_LABELS: Record<PatchCategory, string> = {
                    required:    t("ready.cat_required",    "Required"),
                    bugfix:      t("ready.cat_bugfix",      "Bug fixes"),
                    compat:      t("ready.cat_compat",      "Compatibility"),
                    performance: t("ready.cat_performance", "Performance"),
                    cosmetic:    t("ready.cat_cosmetic",    "Cosmetic"),
                  };
                  const visible = patches.filter(p => p.status !== "not_needed");
                  const byCat = new Map<PatchCategory, PatchStatus[]>();
                  for (const p of visible) {
                    const c = (p.category || "bugfix") as PatchCategory;
                    if (!byCat.has(c)) byCat.set(c, []);
                    byCat.get(c)!.push(p);
                  }
                  return CATEGORY_ORDER.flatMap((cat) => {
                    const group = byCat.get(cat);
                    if (!group || group.length === 0) return [];
                    const appl = group.filter(p => p.status === "applicable");
                    const selCount = appl.filter(p => selectedPatchIds.has(p.id)).length;
                    return [
                      <div key={`hdr-${cat}`} style={{
                        display: "flex", alignItems: "center", gap: 6,
                        padding: "6px 4px 4px", fontSize: 10, fontWeight: 700,
                        color: "var(--gold)", borderBottom: "1px solid var(--brd2)",
                        marginTop: 4, letterSpacing: 0.4, textTransform: "uppercase",
                      }}>
                        <span className={`badge cat-${cat}`}>{CATEGORY_LABELS[cat]}</span>
                        <span style={{ color: "var(--txd)", fontWeight: 400, letterSpacing: 0, textTransform: "none" }}>
                          {appl.length > 0
                            ? `${selCount}/${appl.length} ${t("ready.patches_applicable", "applicable")}`
                            : `${group.length} ${t("ready.patch_applied", "Applied")}`}
                        </span>
                      </div>,
                      ...group.map(p => {
                        const isApplicable = p.status === "applicable";
                        const isAlready = p.status === "already_patched";
                        const isChecked = selectedPatchIds.has(p.id);
                        const isRequired = p.category === "required";
                        return (
                          <label key={p.id} style={{
                            display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 4px",
                            fontSize: 11, opacity: isAlready ? 0.55 : 1,
                            cursor: isApplicable ? "pointer" : "default",
                            borderBottom: "1px solid var(--row-separator)",
                          }}>
                            {isApplicable ? (
                              <input
                                className="checkbox"
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => togglePatchSelection(p.id)}
                                style={{ marginTop: 2 }}
                              />
                            ) : (
                              <span style={{ color: "var(--grn)", width: 16, textAlign: "center", lineHeight: "16px" }}>{"\u2713"}</span>
                            )}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ color: "var(--gold)", fontWeight: 600 }}>{p.name}</span>
                                {isRequired && (
                                  <span className="badge cat-required" title={t("ready.required_hint", "Install-critical — cannot be bulk-deselected via 'None'")}>
                                    {t("ready.required_label", "REQUIRED")}
                                  </span>
                                )}
                                {!p.recommended && isApplicable && !isRequired && (
                                  <span className="badge neutral">opt-in</span>
                                )}
                              </div>
                              {p.description && (
                                <div style={{ fontSize: 10, color: "var(--txd)", marginTop: 2, lineHeight: 1.3 }}>
                                  {p.description}
                                </div>
                              )}
                            </div>
                            <span className={"badge " + (isApplicable ? "info" : "success")} style={{ flexShrink: 0, alignSelf: "center" }}>
                              {isApplicable ? t("ready.patch_ready", "Ready") : t("ready.patch_applied", "Applied")}
                            </span>
                          </label>
                        );
                      }),
                    ];
                  });
                })()}
              </div>
              {(() => {
                // Summary line: applicable-selected / total-applicable,
                // plus per-category breakdown of applicable counts so the
                // user sees the mix at a glance.
                const applicable = patches.filter(p => p.status === "applicable");
                const applicableSelected = applicable.filter(p => selectedPatchIds.has(p.id)).length;
                const staleSelected = selectedPatchIds.size - applicableSelected;
                const CATEGORY_ORDER: PatchCategory[] = ["required", "bugfix", "compat", "performance", "cosmetic"];
                const CATEGORY_SHORT: Record<PatchCategory, string> = {
                  required:    t("ready.cat_short_required",    "req"),
                  bugfix:      t("ready.cat_short_bugfix",      "fix"),
                  compat:      t("ready.cat_short_compat",      "compat"),
                  performance: t("ready.cat_short_performance", "perf"),
                  cosmetic:    t("ready.cat_short_cosmetic",    "cosm"),
                };
                const breakdown = CATEGORY_ORDER
                  .map((c) => ({ c, n: applicable.filter(p => (p.category as PatchCategory) === c).length }))
                  .filter(x => x.n > 0)
                  .map(x => `${x.n} ${CATEGORY_SHORT[x.c]}`)
                  .join(" · ");
                return (
                  <div style={{ fontSize: 10, color: "var(--txd)", marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ opacity: 0.85 }}>{breakdown}</span>
                    <span>
                      {applicableSelected} / {applicable.length} {t("ready.patches_applicable", "applicable")} {t("ready.patches_selected", "selected")}
                      {staleSelected > 0 && (
                        <span title="Selected but already applied — Apply Selected ignores these"
                              style={{ marginLeft: 6, color: "var(--txd)", opacity: 0.7 }}>
                          (+{staleSelected} already applied)
                        </span>
                      )}
                    </span>
                  </div>
                );
              })()}
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
              <div style={{ width: "100%", height: 4, background: "var(--brd)", borderRadius: 2 }}>
                <div style={{
                  width: `${Math.min(100, (backupProgress.bytesCopied / backupProgress.totalBytes) * 100)}%`,
                  height: "100%", background: "var(--grn)", borderRadius: 2, transition: "width 0.3s",
                }} />
              </div>
            </div>
          )}

          <div style={{ color: "var(--txd)", fontSize: 11, marginTop: 10 }}>
            {(() => {
              // Phase 19h: "Checked at 7:17:59 AM" alone loses meaning on
              // cross-day sessions (user returns the morning after a
              // late-night check and sees "Checked at 11:43 PM" with no
              // date cue). Same-day shows just the time for brevity;
              // previous days get the date prefixed.
              const checked = new Date(result.checkedAt);
              const now = new Date();
              const sameDay =
                checked.getFullYear() === now.getFullYear() &&
                checked.getMonth() === now.getMonth() &&
                checked.getDate() === now.getDate();
              const timeStr = checked.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
              if (sameDay) {
                return `${t("ready.checked_at", "Checked at")} ${timeStr}`;
              }
              const dateStr = checked.toLocaleDateString([], { year: "numeric", month: "2-digit", day: "2-digit" });
              return `${t("ready.checked_at", "Checked at")} ${dateStr} ${timeStr}`;
            })()}
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

      {weiduSwapModal !== null && (
        <ExperimentalWeiduModal
          mode={weiduSwapModal}
          meta={weiduSwap?.meta ?? null}
          onCancel={() => setWeiduSwapModal(null)}
          onConfirm={weiduSwapModal === "enable" ? handleEnableWeidu : handleDisableWeidu}
        />
      )}

      {/* Guided-mode Next button (Phase 14) — Ready Check passed → Install. */}
      {guidedMode && result?.passed === true && onGoToTab && (
        <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
          <button
            className="btn btn-primary"
            onClick={() => onGoToTab("install")}
            style={{ fontSize: 13, padding: "6px 18px" }}
          >
            {t("ready.guided_next", "Next: Install")} {"\u2192"}
          </button>
        </div>
      )}
    </div>
  );
}

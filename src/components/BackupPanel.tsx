import { useState, useEffect, useCallback, useMemo } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { guiLog } from "../lib/gui-logger";
import { useI18n } from "../lib/i18n";
import type { AppConfig } from "../App";
import {
  listBackups,
  restoreBackup,
  deleteBackup,
  createBackup,
  estimateBackup,
  verifyBackup,
  type BackupInfo,
  type BackupEstimate,
  type BackupProgress,
  type VerifyResult,
} from "../lib/tauri-bridge";
import { GAME_KINDS, GAME_LABELS, GAME_CONFIG_KEYS, GAME_BACKUP_DIR_KEYS, type GameKind } from "../constants/games";

/** Special pseudo-kind for orphaned backups whose game is no longer
 * configured. Rendered as a dedicated tab only when orphans exist. */
const ORPHANED = "__orphaned__" as const;
type TabKind = GameKind | typeof ORPHANED;

interface Props {
  config: AppConfig;
  onSaveConfig: (config: AppConfig) => void;
  installRunning?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatDate(ts: string): string {
  return ts.replace(/_/g, " ").replace(/-/g, (m, offset) => (offset > 9 ? ":" : m));
}

/** Parse a backup timestamp (`YYYY-MM-DD_HH-MM-SS`) into a Date. */
function parseBackupTs(ts: string): Date | null {
  // Input: "2026-04-18_12-30-00". Split date + time, convert time dashes to colons.
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Relative time string like "just now", "3 min ago", "2 days ago". Same
 * vocabulary as the Forge data age indicator in the status bar. */
function formatRelativeTime(ts: string): string {
  const d = parseBackupTs(ts);
  if (!d) return formatDate(ts);
  const ageMs = Date.now() - d.getTime();
  if (ageMs < 0) return formatDate(ts);
  const min = ageMs / 60_000;
  if (min < 1) return "just now";
  if (min < 60) return `${Math.round(min)} min ago`;
  const hr = min / 60;
  if (hr < 24) return `${Math.round(hr)}h ago`;
  const days = hr / 24;
  if (days < 7) return `${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"} ago`;
  const weeks = days / 7;
  if (weeks < 5) return `${Math.round(weeks)}w ago`;
  return d.toLocaleDateString();
}

type SortBy = "newest" | "oldest" | "largest";
type ModeFilter = "all" | "selective" | "full";

/** Default backup directory: sibling of the first configured game dir,
 * named `infinity-mod-runner-backups`. Users can override via `config.backup_directory`. */
function defaultBackupDir(config: AppConfig): string {
  const anyGameDir =
    config.bg2_game_dir ||
    config.bg1_game_dir ||
    config.iwd_game_dir ||
    config.iwd2_game_dir ||
    config.pst_game_dir;
  if (!anyGameDir) return "";
  return anyGameDir.replace(/[/\\][^/\\]+$/, "/infinity-mod-runner-backups");
}

/** Resolve the effective backup directory for a given game: the per-game
 * override if set, otherwise the global `backup_directory`, otherwise the
 * derived default sibling path. */
function effectiveBackupDir(config: AppConfig, kind: GameKind): string {
  const override = config[GAME_BACKUP_DIR_KEYS[kind]];
  if (override) return override;
  return config.backup_directory || defaultBackupDir(config);
}

export default function BackupPanel({ config, onSaveConfig, installRunning }: Props) {
  const { t } = useI18n();
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [creating, setCreating] = useState<GameKind | null>(null);
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState<BackupInfo | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>("newest");
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");

  // ── Create Backup modal state ──
  // Opens when user clicks the Create button; gathers name + mode and
  // pulls an estimateBackup preview so the user can see how much space
  // the backup will consume before committing.
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createMode, setCreateMode] = useState<"selective" | "full">("selective");
  const [estimate, setEstimate] = useState<BackupEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);

  // Per-backup verify results, keyed by backup path. `undefined` means
  // "never verified", `null` means "in flight". Stays in memory for the
  // session; users re-verify on demand.
  const [verifyResults, setVerifyResults] = useState<Record<string, VerifyResult | null>>({});

  const handleVerify = async (path: string) => {
    setVerifyResults((prev) => ({ ...prev, [path]: null }));
    try {
      const r = await verifyBackup(path);
      setVerifyResults((prev) => ({ ...prev, [path]: r }));
    } catch (e) {
      setVerifyResults((prev) => ({
        ...prev,
        [path]: {
          ok: false,
          manifestFileCount: 0, manifestTotalBytes: 0,
          actualFileCount: 0, actualTotalBytes: 0,
          issues: [`Verify failed: ${e}`],
        },
      }));
    }
  };

  // Games the user has configured a path for — we only show tabs for these.
  // If only BG2 is set, behaves exactly like the pre-9b single-game panel.
  const configuredGames: GameKind[] = useMemo(() => {
    return GAME_KINDS.filter((k) => !!config[GAME_CONFIG_KEYS[k]]);
  }, [config]);

  const [activeTab, setActiveTab] = useState<TabKind>(() => {
    // Prefer BG2 if configured (most common case); otherwise first available.
    if (config.bg2_game_dir) return "bg2";
    return configuredGames[0] || "bg2";
  });
  // Narrow tab to a real GameKind where needed — orphan tab has no
  // writable target and is read-only.
  const activeGame: GameKind = activeTab === ORPHANED ? (configuredGames[0] || "bg2") : (activeTab as GameKind);

  // Keep activeTab valid when configured set changes (e.g. user removes a path).
  useEffect(() => {
    if (activeTab === ORPHANED) return;
    if (configuredGames.length > 0 && !configuredGames.includes(activeTab as GameKind)) {
      setActiveTab(configuredGames[0]);
    }
  }, [configuredGames, activeTab]);

  const modDir = config.mod_directory;
  // For display + create-time flows, use the effective dir of the active tab.
  const backupDir = activeTab === ORPHANED
    ? (config.backup_directory || defaultBackupDir(config))
    : effectiveBackupDir(config, activeTab as GameKind);
  const activeGameDir = activeTab === ORPHANED ? null : config[GAME_CONFIG_KEYS[activeTab as GameKind]];

  // Event listeners — restore AND create share progress/complete/error events.
  // Refresh on either completion so the list always reflects disk state.
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    listen<BackupProgress>("restore:progress", (e) => setProgress(e.payload)).then((u) => unlisteners.push(u));
    listen("restore:complete", () => { setRestoring(false); setProgress(null); refreshBackups(); guiLog.info("BACKUP", "Restore completed successfully"); }).then((u) => unlisteners.push(u));
    listen<string>("restore:error", (e) => { setError(e.payload); setRestoring(false); setProgress(null); guiLog.error("BACKUP", `Restore failed: ${e.payload}`); }).then((u) => unlisteners.push(u));
    listen<BackupProgress>("backup:progress", (e) => setProgress(e.payload)).then((u) => unlisteners.push(u));
    listen("backup:complete", () => { setCreating(null); setProgress(null); refreshBackups(); guiLog.info("BACKUP", "Backup completed successfully"); }).then((u) => unlisteners.push(u));
    listen<string>("backup:error", (e) => { setError(e.payload); setCreating(null); setProgress(null); guiLog.error("BACKUP", `Backup failed: ${e.payload}`); }).then((u) => unlisteners.push(u));
    return () => { unlisteners.forEach((fn) => fn()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh reads from every unique effective backup directory across all
  // configured games, then merges results. Backups whose gameKind isn't
  // in configuredGames are still surfaced — they become "orphans" in the
  // dedicated tab below so users can delete or re-configure a game to
  // reach them.
  const refreshBackups = useCallback(() => {
    const dirs = new Set<string>();
    for (const kind of GAME_KINDS) {
      const d = effectiveBackupDir(config, kind);
      if (d) dirs.add(d);
    }
    // Always include the global path too, so orphan backups from removed
    // game configurations still appear.
    const global = config.backup_directory || defaultBackupDir(config);
    if (global) dirs.add(global);

    if (dirs.size === 0) {
      setBackups([]);
      return;
    }
    setLoading(true);
    Promise.allSettled([...dirs].map((d) => listBackups(d)))
      .then((results) => {
        const all: BackupInfo[] = [];
        const seen = new Set<string>();
        for (const r of results) {
          if (r.status !== "fulfilled") continue;
          for (const b of r.value) {
            if (seen.has(b.path)) continue;
            seen.add(b.path);
            all.push(b);
          }
        }
        setBackups(all);
      })
      .catch(() => setBackups([]))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    config.backup_directory,
    config.backup_directory_bg1,
    config.backup_directory_bg2,
    config.backup_directory_iwd,
    config.backup_directory_iwd2,
    config.backup_directory_pst,
    config.bg1_game_dir,
    config.bg2_game_dir,
    config.iwd_game_dir,
    config.iwd2_game_dir,
    config.pst_game_dir,
  ]);

  useEffect(() => {
    refreshBackups();
  }, [refreshBackups]);

  const handleRestore = async (b: BackupInfo) => {
    const targetDir = config[GAME_CONFIG_KEYS[b.gameKind as GameKind]];
    if (!targetDir) {
      setError(`Cannot restore ${b.gameKind} backup — ${GAME_LABELS[b.gameKind as GameKind] || b.gameKind} directory not configured.`);
      setRestoreConfirm(null);
      return;
    }
    setRestoreConfirm(null);
    setRestoring(true);
    setError(null);
    setProgress(null);
    try {
      guiLog.info("BACKUP", `Restoring ${b.gameKind} backup from: ${b.path.replace(/\//g, "\\")} → ${targetDir}`);
      await restoreBackup(b.path, targetDir, modDir ?? undefined);
    } catch (e) {
      setError(`Restore failed: ${e}`);
      setRestoring(false);
    }
  };

  // Open the Create modal, pre-filling the default name. Size estimate
  // is fetched on open and re-fetched whenever the user flips the mode
  // picker — so the space-required figure is always current.
  const openCreateModal = (kind: GameKind) => {
    const ts = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
    setCreateName(`manual-${kind}-${ts}`);
    setCreateMode("selective");
    setEstimate(null);
    setCreateModalOpen(true);
  };

  // Refresh the estimate whenever the modal opens or mode changes.
  useEffect(() => {
    if (!createModalOpen || !activeGameDir || !backupDir) return;
    let cancelled = false;
    setEstimating(true);
    estimateBackup(activeGameDir, backupDir, createMode)
      .then((e) => { if (!cancelled) setEstimate(e); })
      .catch(() => { if (!cancelled) setEstimate(null); })
      .finally(() => { if (!cancelled) setEstimating(false); });
    return () => { cancelled = true; };
  }, [createModalOpen, createMode, activeGameDir, backupDir]);

  const commitCreate = async () => {
    if (!activeGameDir || !backupDir) return;
    const name = createName.trim() || `manual-${activeGame}-${Date.now()}`;
    setCreateModalOpen(false);
    setCreating(activeGame);
    setError(null);
    setProgress(null);
    try {
      guiLog.info("BACKUP", `Creating ${createMode} ${activeGame} backup: "${name}" to ${backupDir}`);
      await createBackup(activeGameDir, backupDir, name, createMode, activeGame);
    } catch (e) {
      setError(`Backup failed: ${e}`);
      setCreating(null);
    }
  };

  const handleDelete = async (path: string) => {
    setDeleteConfirm(null);
    try {
      await deleteBackup(path);
      refreshBackups();
    } catch (e) {
      setError(`Delete failed: ${e}`);
    }
  };

  const handleBrowseDir = async () => {
    const selected = await open({ directory: true, title: "Select Global Backup Directory" });
    if (selected) {
      onSaveConfig({ ...config, backup_directory: selected as string });
    }
  };

  /** Set a per-game backup directory override. Pass `null` to clear
   * the override and fall back to the global path. */
  const handleSetGameOverride = async (kind: GameKind, clear?: boolean) => {
    if (clear) {
      onSaveConfig({ ...config, [GAME_BACKUP_DIR_KEYS[kind]]: null });
      return;
    }
    const selected = await open({ directory: true, title: `Select Backup Directory for ${GAME_LABELS[kind]}` });
    if (selected) {
      onSaveConfig({ ...config, [GAME_BACKUP_DIR_KEYS[kind]]: selected as string });
    }
  };

  const busy = restoring || !!creating || !!installRunning;

  // Per-tab totals computed once; used in tab labels and the last-backup callout.
  const gameStats = useMemo(() => {
    const m = new Map<GameKind, { count: number; bytes: number; newest: BackupInfo | null }>();
    for (const kind of GAME_KINDS) m.set(kind, { count: 0, bytes: 0, newest: null });
    for (const b of backups) {
      const k = b.gameKind as GameKind;
      if (!m.has(k)) continue;
      const s = m.get(k)!;
      s.count++;
      s.bytes += b.totalBytes;
      if (!s.newest || b.timestamp.localeCompare(s.newest.timestamp) > 0) s.newest = b;
    }
    return m;
  }, [backups]);

  // Newest-across-all for the top callout.
  const newestOverall = useMemo(() => {
    let winner: BackupInfo | null = null;
    for (const b of backups) {
      if (!winner || b.timestamp.localeCompare(winner.timestamp) > 0) winner = b;
    }
    return winner;
  }, [backups]);

  // Orphans: backups whose gameKind isn't one of the user's currently
  // configured games. Surfaced in a dedicated tab so users can clean
  // them up or reconfigure the game to re-adopt them.
  const orphanedBackups = useMemo(() => {
    const configured = new Set(configuredGames);
    return backups.filter((b) => !configured.has(b.gameKind as GameKind));
  }, [backups, configuredGames]);

  // Filtered + sorted visible list for the active tab.
  const visibleBackups = useMemo(() => {
    let list: BackupInfo[];
    if (activeTab === ORPHANED) {
      list = orphanedBackups;
    } else {
      list = backups.filter((b) => (b.gameKind as GameKind) === activeTab);
    }
    if (modeFilter !== "all") list = list.filter((b) => b.mode === modeFilter);
    if (sortBy === "oldest") {
      list = [...list].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    } else if (sortBy === "largest") {
      list = [...list].sort((a, b) => b.totalBytes - a.totalBytes);
    } else {
      list = [...list].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }
    return list;
  }, [backups, orphanedBackups, activeTab, modeFilter, sortBy]);

  // Mode mix for the active tab (drives the mode filter visibility).
  const activeModes = useMemo(() => {
    const tabBackups = activeTab === ORPHANED
      ? orphanedBackups
      : backups.filter((b) => (b.gameKind as GameKind) === activeTab);
    return {
      selective: tabBackups.filter((b) => b.mode === "selective").length,
      full: tabBackups.filter((b) => b.mode === "full").length,
    };
  }, [backups, orphanedBackups, activeTab]);

  return (
    <div>
      {/* Backup Location — global + optional per-game override */}
      {(() => {
        const globalDir = config.backup_directory || defaultBackupDir(config);
        const perGameOverride = activeTab !== ORPHANED
          ? config[GAME_BACKUP_DIR_KEYS[activeTab as GameKind]]
          : null;
        return (
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, color: "var(--txd)" }}>
              {t("backup.location_global", "Backup Location (global default)")}
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
              <input
                readOnly value={globalDir}
                style={{ flex: 1, padding: "4px 8px", background: "var(--bg2)", border: "1px solid var(--brd)", borderRadius: 4, color: "var(--tx)", fontSize: 12 }}
              />
              <button onClick={handleBrowseDir} style={btnStyle}>{t("btn.change", "Change")}</button>
            </div>
            {activeTab !== ORPHANED && (
              <div style={{ marginTop: 6, fontSize: 11, color: "var(--txd)", display: "flex", gap: 6, alignItems: "center" }}>
                {perGameOverride ? (
                  <>
                    <span>{t("backup.location_override_using", "Custom for {game}:").replace("{game}", GAME_LABELS[activeTab as GameKind])}</span>
                    <code style={{ color: "var(--tx)", background: "var(--bg2)", padding: "1px 6px", borderRadius: 3, fontFamily: "'Fira Code', monospace", fontSize: 10 }}>{perGameOverride}</code>
                    <button onClick={() => handleSetGameOverride(activeTab as GameKind)} style={{ ...btnStyle, fontSize: 10, padding: "1px 8px" }}>{t("btn.change", "Change")}</button>
                    <button onClick={() => handleSetGameOverride(activeTab as GameKind, true)} style={{ ...btnStyle, fontSize: 10, padding: "1px 8px" }}>{t("backup.reset_override", "Reset to global")}</button>
                  </>
                ) : (
                  <>
                    <span>{t("backup.location_using_global", "Using global for {game}.").replace("{game}", GAME_LABELS[activeTab as GameKind])}</span>
                    <button onClick={() => handleSetGameOverride(activeTab as GameKind)} style={{ ...btnStyle, fontSize: 10, padding: "1px 8px" }}>{t("backup.set_override", "Set custom location")}</button>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Last-backup callout — one-liner "you're protected" summary across
          all games, so users don't have to scan the list to see freshness. */}
      {newestOverall && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "6px 10px", marginBottom: 10, borderRadius: 4,
          background: "var(--bg2)", border: "1px solid var(--brd)",
          fontSize: 11, color: "var(--txd)",
        }}>
          <span style={{ color: "var(--goldb)", fontWeight: 600 }}>
            {t("backup.last", "Last backup:")}
          </span>
          <span style={{ color: "var(--tx)" }}>
            {formatRelativeTime(newestOverall.timestamp)}
          </span>
          <span>·</span>
          <span>{GAME_LABELS[newestOverall.gameKind as GameKind] || newestOverall.gameKind}</span>
          <span>·</span>
          <span>{newestOverall.mode}</span>
          <span>·</span>
          <span>{formatBytes(newestOverall.totalBytes)}</span>
        </div>
      )}

      {/* Game tabs — one per configured game, plus an optional Orphaned
          tab surfaced only when backups exist for a game the user no
          longer has configured. */}
      {(configuredGames.length > 1 || orphanedBackups.length > 0) && (
        <div className="segmented" role="group" aria-label="Backup game selector" style={{ marginBottom: 10 }}>
          {configuredGames.map((kind) => {
            const s = gameStats.get(kind) ?? { count: 0, bytes: 0, newest: null };
            return (
              <button
                key={kind}
                type="button"
                className={"segmented-btn" + (activeTab === kind ? " ac" : "")}
                onClick={() => setActiveTab(kind)}
                style={{ fontSize: 11, padding: "4px 12px" }}
                title={s.count > 0
                  ? `${s.count} backup${s.count === 1 ? "" : "s"} · ${formatBytes(s.bytes)} total`
                  : "No backups yet"}
              >
                {GAME_LABELS[kind]}
                {s.count > 0 && (
                  <span style={{ marginLeft: 4, opacity: 0.75 }}>
                    ({s.count} · {formatBytes(s.bytes)})
                  </span>
                )}
              </button>
            );
          })}
          {orphanedBackups.length > 0 && (
            <button
              type="button"
              className={"segmented-btn" + (activeTab === ORPHANED ? " ac" : "")}
              onClick={() => setActiveTab(ORPHANED)}
              style={{ fontSize: 11, padding: "4px 12px", color: activeTab === ORPHANED ? undefined : "var(--tx-warn)" }}
              title={t("backup.orphaned_tooltip", "Backups for games you haven't configured. Can be deleted but not restored until you add the matching game to Setup.")}
            >
              {"\u26A0 "}{t("backup.orphaned_tab", "Orphaned")}
              <span style={{ marginLeft: 4, opacity: 0.75 }}>
                ({orphanedBackups.length} · {formatBytes(orphanedBackups.reduce((sum, b) => sum + b.totalBytes, 0))})
              </span>
            </button>
          )}
        </div>
      )}

      {/* Orphan warning banner when the orphan tab is active */}
      {activeTab === ORPHANED && orphanedBackups.length > 0 && (
        <div className="alert warn" style={{ marginBottom: 8, fontSize: 11 }}>
          {t("backup.orphaned_warn", "These backups reference games not currently in your Setup. Add the matching game path to Setup before restoring, or delete them to reclaim space.")}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="alert err" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>{error}</span>
          <button onClick={() => setError(null)} style={{ marginLeft: 8, cursor: "pointer", background: "none", border: "none", color: "var(--red)" }}>{t("btn.dismiss", "dismiss")}</button>
        </div>
      )}

      {/* Create Backup + Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>
          {t("backup.existing", "Existing Backups")}
          <span style={{ marginLeft: 8, color: "var(--txd)", fontWeight: 400, fontSize: 11 }}>
            {GAME_LABELS[activeGame]}
          </span>
        </span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortBy)}
            style={{
              background: "var(--bg2)", border: "1px solid var(--brd)",
              color: "var(--txd)", fontSize: 10, padding: "2px 6px",
              borderRadius: 4, fontFamily: "inherit",
            }}
            title={t("backup.sort_hint", "Change backup list ordering")}
          >
            <option value="newest">{t("backup.sort_newest", "Newest first")}</option>
            <option value="oldest">{t("backup.sort_oldest", "Oldest first")}</option>
            <option value="largest">{t("backup.sort_largest", "Largest first")}</option>
          </select>
          {activeGameDir && (
            <button
              className="btn btn-primary"
              onClick={() => openCreateModal(activeGame)}
              disabled={busy}
              style={{ fontSize: 11, padding: "3px 12px" }}
              title={t("backup.create_hint", "Create a selective backup of the current game directory")}
            >
              {creating === activeGame ? t("btn.creating", "Creating...") : t("btn.create_backup", "Create Backup")}
            </button>
          )}
          <button onClick={refreshBackups} disabled={loading} style={{ ...btnStyle, fontSize: 11, padding: "2px 8px" }}>
            {loading ? t("btn.loading", "Loading...") : t("btn.refresh", "Refresh")}
          </button>
        </div>
      </div>

      {/* Mode filter — only rendered if the active tab has a mix of
          selective + full. Otherwise a single-bucket filter is visual noise. */}
      {activeModes.selective > 0 && activeModes.full > 0 && (
        <div className="segmented" role="group" aria-label="Filter by backup mode" style={{ marginBottom: 8 }}>
          <button
            type="button"
            className={"segmented-btn" + (modeFilter === "all" ? " ac" : "")}
            onClick={() => setModeFilter("all")}
            style={{ fontSize: 10, padding: "2px 10px" }}
          >
            {t("backup.filter_all", "All")} ({activeModes.selective + activeModes.full})
          </button>
          <button
            type="button"
            className={"segmented-btn" + (modeFilter === "selective" ? " ac" : "")}
            onClick={() => setModeFilter("selective")}
            style={{ fontSize: 10, padding: "2px 10px" }}
          >
            {t("backup.filter_selective", "Selective")} ({activeModes.selective})
          </button>
          <button
            type="button"
            className={"segmented-btn" + (modeFilter === "full" ? " ac" : "")}
            onClick={() => setModeFilter("full")}
            style={{ fontSize: 10, padding: "2px 10px" }}
          >
            {t("backup.filter_full", "Full")} ({activeModes.full})
          </button>
        </div>
      )}

      {!activeGameDir && (
        <div style={{ color: "var(--txd)", fontSize: 12, fontStyle: "italic" }}>
          {t("backup.no_game_dir", "No game directory configured for {game}. Set it in Setup.").replace("{game}", GAME_LABELS[activeGame])}
        </div>
      )}

      {/* Prominent empty state — replaces the old italic "No backups found".
          When the active game has no backups yet, surface the CTA here
          instead of forcing the user to find it in the header. */}
      {visibleBackups.length === 0 && !loading && activeGameDir && (
        <div style={{
          textAlign: "center", padding: "32px 16px", marginTop: 4,
          border: "1px dashed var(--brd2)", borderRadius: 6,
          background: "var(--row-alt)",
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--gold)", marginBottom: 4 }}>
            {t("backup.empty_title", "No backups yet")}
          </div>
          <div style={{ fontSize: 12, color: "var(--txd)", marginBottom: 12, maxWidth: 440, margin: "0 auto 12px" }}>
            {t("backup.empty_desc", "A backup snapshots the current game state so you can roll back. Selective backups skip install side-folders to save space.")}
          </div>
          <button
            className="btn btn-primary"
            onClick={() => openCreateModal(activeGame)}
            disabled={busy}
            style={{ fontSize: 12, padding: "6px 18px" }}
          >
            {creating === activeGame
              ? t("btn.creating", "Creating...")
              : t("backup.create_first", "Create First Backup")}
          </button>
        </div>
      )}

      {visibleBackups.map((b) => {
        const vr = verifyResults[b.path];
        const verifying = vr === null;
        return (
          <div key={b.path} style={{ padding: 8, marginBottom: 6, background: "var(--bg2)", borderRadius: 4, border: "1px solid var(--brd)", fontSize: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <strong>{b.name}</strong>
                <span className={`badge ${b.mode === "full" ? "info" : "success"}`} style={{ marginLeft: 8 }}>
                  {b.mode}
                </span>
                {!b.completed && (
                  <span className="badge warn" style={{ marginLeft: 6 }}>{t("backup.incomplete", "incomplete")}</span>
                )}
                {vr && vr.ok && (
                  <span className="badge success" style={{ marginLeft: 6 }}>{t("backup.verified_ok", "verified")}</span>
                )}
                {vr && !vr.ok && (
                  <span className="badge err" style={{ marginLeft: 6 }} title={vr.issues.join("\n")}>{t("backup.verified_bad", "issues found")}</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={() => handleVerify(b.path)}
                  disabled={busy || verifying}
                  style={{ ...btnStyle, fontSize: 11, padding: "2px 8px" }}
                  title={t("backup.verify_hint", "Compare manifest file count + size against what's actually on disk. Catches truncated or partially-deleted backups before you try to restore.")}
                >
                  {verifying ? t("backup.verifying", "Verifying...") : t("btn.verify", "Verify")}
                </button>
                {b.completed && !!config[GAME_CONFIG_KEYS[b.gameKind as GameKind]] && (
                  <button onClick={() => setRestoreConfirm(b)} disabled={busy}
                    style={{ ...btnStyle, fontSize: 11, padding: "2px 8px", background: "var(--org)", color: "var(--bg)" }}>
                    {t("btn.restore", "Restore")}
                  </button>
                )}
                <button onClick={() => setDeleteConfirm(b.path)} disabled={busy}
                  style={{ ...btnStyle, fontSize: 11, padding: "2px 8px", background: "var(--bg-err)", color: "var(--red)", borderColor: "var(--red)" }}>
                  {t("btn.delete", "Delete")}
                </button>
              </div>
            </div>
            <div style={{ fontSize: 10, color: "var(--txd)", marginTop: 2 }}>
              <span title={formatDate(b.timestamp)}>{formatRelativeTime(b.timestamp)}</span>
              &nbsp;&mdash; {formatBytes(b.totalBytes)}, {b.fileCount.toLocaleString()} files
            </div>
            {vr && !vr.ok && vr.issues.length > 0 && (
              <div style={{ marginTop: 6, padding: "4px 8px", background: "var(--bg-err)", borderRadius: 3, fontSize: 10, color: "var(--red)" }}>
                {vr.issues.map((issue, i) => (
                  <div key={i}>{"\u26A0 "}{issue}</div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Shared progress — covers both restore and create */}
      {(restoring || creating) && progress && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, color: "var(--txd)", marginBottom: 4 }}>
            {progress.phase === "cleaning"
              ? <span style={{ color: "var(--gold)" }}>{t("backup.cleaning", "Cleaning game directory...")} {progress.currentFile}</span>
              : <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>{progress.filesCopied.toLocaleString()} / {progress.totalFiles.toLocaleString()} files</span>
                  <span>{formatBytes(progress.bytesCopied)} / {formatBytes(progress.totalBytes)}</span>
                </div>
            }
          </div>
          {progress.totalBytes > 0 && (
            <div className="progress-bar" style={{ height: 4, margin: 0 }}>
              <div className="fill" style={{
                width: `${Math.min(100, (progress.bytesCopied / progress.totalBytes) * 100)}%`,
              }} />
            </div>
          )}
        </div>
      )}

      {/* Restore Confirmation */}
      {restoreConfirm && (() => {
        const targetDir = config[GAME_CONFIG_KEYS[restoreConfirm.gameKind as GameKind]];
        return (
          <div className="modal-backdrop">
            <div className="modal">
              <div className="modal-title">
                {t("backup.restore_title_game", "Restore {game} Backup?").replace(
                  "{game}",
                  GAME_LABELS[restoreConfirm.gameKind as GameKind] || restoreConfirm.gameKind,
                )}
              </div>
              <div className="modal-body">
                <div>
                  {t("backup.restore_desc", "This will overwrite files in your current game directory. Changes since the backup was created will be lost.")}
                </div>
                <div style={{
                  marginTop: 12, padding: "8px 10px", background: "var(--bg)",
                  border: "1px solid var(--brd)", borderRadius: 4,
                  fontSize: 11, textAlign: "left",
                }}>
                  <div style={{ color: "var(--txd)", marginBottom: 2 }}>{t("backup.restore_target", "Restoring to:")}</div>
                  <div style={{ color: "var(--tx)", fontFamily: "'Fira Code', monospace", wordBreak: "break-all" }}>
                    {targetDir || "(directory not configured)"}
                  </div>
                  <div style={{ color: "var(--txd)", marginTop: 6, marginBottom: 2 }}>{t("backup.restore_from", "From backup:")}</div>
                  <div style={{ color: "var(--tx)" }}>
                    {restoreConfirm.name} · <span style={{ opacity: 0.7 }}>{formatRelativeTime(restoreConfirm.timestamp)} · {formatBytes(restoreConfirm.totalBytes)}</span>
                  </div>
                </div>
              </div>
              <div className="modal-actions">
                <button onClick={() => handleRestore(restoreConfirm)} style={{ ...btnStyle, background: "var(--org)", color: "var(--bg)", padding: "6px 20px" }}>{t("btn.restore", "Restore")}</button>
                <button onClick={() => setRestoreConfirm(null)} style={{ ...btnStyle, padding: "6px 20px" }}>{t("btn.cancel", "Cancel")}</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Create Backup Modal */}
      {createModalOpen && (() => {
        const tight = estimate
          ? estimate.availableSpace > 0 && estimate.availableSpace < estimate.totalBytes + (estimate.totalBytes / 10)
          : false;
        const blocked = estimate ? !estimate.hasEnoughSpace : false;
        return (
          <div className="modal-backdrop">
            <div className="modal" style={{ maxWidth: 520 }}>
              <div className="modal-title">
                {t("backup.create_title", "Create {game} Backup").replace("{game}", GAME_LABELS[activeGame])}
              </div>
              <div className="modal-body" style={{ textAlign: "left" }}>
                {/* Name */}
                <label style={{ fontSize: 11, color: "var(--txd)", display: "block", marginBottom: 4 }}>
                  {t("backup.create_name_label", "Backup name")}
                </label>
                <input
                  type="text"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder={`manual-${activeGame}-...`}
                  style={{
                    width: "100%", padding: "6px 8px", marginBottom: 12,
                    background: "var(--bg)", border: "1px solid var(--brd)",
                    color: "var(--tx)", borderRadius: 4, fontSize: 12, fontFamily: "inherit",
                  }}
                />

                {/* Mode picker */}
                <label style={{ fontSize: 11, color: "var(--txd)", display: "block", marginBottom: 4 }}>
                  {t("backup.create_mode_label", "Backup mode")}
                </label>
                <div className="segmented" role="group" aria-label="Backup mode" style={{ marginBottom: 8 }}>
                  <button
                    type="button"
                    className={"segmented-btn" + (createMode === "selective" ? " ac" : "")}
                    onClick={() => setCreateMode("selective")}
                    style={{ fontSize: 11, padding: "4px 14px" }}
                  >
                    {t("backup.mode_selective", "Selective")}
                  </button>
                  <button
                    type="button"
                    className={"segmented-btn" + (createMode === "full" ? " ac" : "")}
                    onClick={() => setCreateMode("full")}
                    style={{ fontSize: 11, padding: "4px 14px" }}
                  >
                    {t("backup.mode_full", "Full")}
                  </button>
                </div>
                <div style={{ fontSize: 11, color: "var(--txd)", marginBottom: 14, lineHeight: 1.4 }}>
                  {createMode === "selective"
                    ? t("backup.mode_selective_desc", "Backs up chitin.key, override/, and top-level IDS/BCS files. Skips mod side-folders that get installed fresh. Fast; restore rolls back install damage without touching mod source.")
                    : t("backup.mode_full_desc", "Copies the entire game directory verbatim. Slow and large, but captures everything — use when you've made manual edits you want to preserve across installs.")}
                </div>

                {/* Size estimate */}
                <div style={{
                  padding: "10px 12px", borderRadius: 4,
                  background: blocked ? "var(--bg-err)" : tight ? "var(--bg-warn)" : "var(--bg)",
                  border: `1px solid ${blocked ? "var(--red)" : tight ? "var(--org)" : "var(--brd)"}`,
                  fontSize: 11,
                }}>
                  {estimating && (
                    <div style={{ color: "var(--txd)" }}>{t("backup.estimating", "Estimating size...")}</div>
                  )}
                  {!estimating && !estimate && (
                    <div style={{ color: "var(--txd)" }}>{t("backup.estimate_failed", "Couldn't estimate size — check backup location.")}</div>
                  )}
                  {estimate && (
                    <>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ color: "var(--txd)" }}>{t("backup.size_required", "Size required")}</span>
                        <span style={{ color: "var(--tx)", fontWeight: 600 }}>
                          {formatBytes(estimate.totalBytes)} ({estimate.fileCount.toLocaleString()} files)
                        </span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                        <span style={{ color: "var(--txd)" }}>{t("backup.space_available", "Free on backup drive")}</span>
                        <span style={{ color: blocked ? "var(--red)" : tight ? "var(--tx-warn)" : "var(--tx)" }}>
                          {formatBytes(estimate.availableSpace)}
                        </span>
                      </div>
                      {blocked && (
                        <div style={{ marginTop: 6, color: "var(--red)", fontWeight: 600 }}>
                          {t("backup.not_enough_space", "Not enough free space — pick a different backup location or free some up.")}
                        </div>
                      )}
                      {tight && !blocked && (
                        <div style={{ marginTop: 6, color: "var(--tx-warn)" }}>
                          {t("backup.tight_space", "Barely fits — less than 10% margin. Consider freeing space first.")}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
              <div className="modal-actions">
                <button
                  className="btn btn-primary"
                  onClick={commitCreate}
                  disabled={blocked || estimating}
                  style={{ padding: "6px 20px" }}
                >
                  {t("btn.create_backup", "Create Backup")}
                </button>
                <button onClick={() => setCreateModalOpen(false)} style={{ ...btnStyle, padding: "6px 20px" }}>
                  {t("btn.cancel", "Cancel")}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Delete Confirmation */}
      {deleteConfirm && (
        <div className="modal-backdrop">
          <div className="modal narrow">
            <div className="modal-title">{t("backup.delete_title", "Delete Backup?")}</div>
            <div className="modal-body">{t("backup.delete_desc", "This cannot be undone.")}</div>
            <div className="modal-actions">
              <button onClick={() => handleDelete(deleteConfirm)} className="btn btn-danger" style={{ padding: "6px 20px" }}>{t("btn.delete", "Delete")}</button>
              <button onClick={() => setDeleteConfirm(null)} style={{ ...btnStyle, padding: "6px 20px" }}>{t("btn.cancel", "Cancel")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "4px 12px",
  background: "var(--bg3)",
  color: "var(--txb)",
  border: "1px solid var(--brd2)",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
};

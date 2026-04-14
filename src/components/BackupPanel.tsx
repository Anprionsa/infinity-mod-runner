import { useState, useEffect, useCallback } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { guiLog } from "../lib/gui-logger";
import { useI18n } from "../lib/i18n";
import type { AppConfig } from "../App";
import {
  listBackups,
  restoreBackup,
  deleteBackup,
  type BackupInfo,
  type BackupProgress,
} from "../lib/tauri-bridge";

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

export default function BackupPanel({ config, onSaveConfig, installRunning }: Props) {
  const { t } = useI18n();
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const gameDir = config.bg2_game_dir;
  const backupDir = config.backup_directory || (gameDir ? gameDir.replace(/[/\\][^/\\]+$/, "/eet-mod-runner-backups") : "");

  // Event listeners
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    listen<BackupProgress>("restore:progress", (e) => setProgress(e.payload)).then((u) => unlisteners.push(u));
    listen("restore:complete", () => { setRestoring(false); setProgress(null); refreshBackups(); guiLog.info("BACKUP", "Restore completed successfully"); }).then((u) => unlisteners.push(u));
    listen<string>("restore:error", (e) => { setError(e.payload); setRestoring(false); setProgress(null); guiLog.error("BACKUP", `Restore failed: ${e.payload}`); }).then((u) => unlisteners.push(u));
    return () => { unlisteners.forEach((fn) => fn()); };
  }, []);

  const refreshBackups = useCallback(() => {
    if (!backupDir) return;
    setLoading(true);
    listBackups(backupDir)
      .then(setBackups)
      .catch(() => setBackups([]))
      .finally(() => setLoading(false));
  }, [backupDir]);

  // Load on mount
  useEffect(() => {
    if (backupDir) refreshBackups();
  }, [backupDir, refreshBackups]);

  const handleRestore = async (path: string) => {
    if (!gameDir) return;
    setRestoreConfirm(null);
    setRestoring(true);
    setError(null);
    setProgress(null);
    try {
      guiLog.info("BACKUP", `Restoring backup from: ${path}`);
      await restoreBackup(path, gameDir);
    } catch (e) {
      setError(`Restore failed: ${e}`);
      setRestoring(false);
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
    const selected = await open({ directory: true, title: "Select Backup Directory" });
    if (selected) {
      onSaveConfig({ ...config, backup_directory: selected as string });
    }
  };

  const busy = restoring || !!installRunning;

  return (
    <div>
      {/* Backup Location */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 12, color: "var(--txd)" }}>{t("backup.location", "Backup Location")}</label>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
          <input
            readOnly value={backupDir}
            style={{ flex: 1, padding: "4px 8px", background: "var(--bg1)", border: "1px solid var(--brd)", borderRadius: 4, color: "#ccc", fontSize: 12 }}
          />
          <button onClick={handleBrowseDir} style={btnStyle}>{t("btn.change", "Change")}</button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ color: "var(--red)", fontSize: 12, marginBottom: 12, padding: 8, background: "#1a0a0a", borderRadius: 4, border: "1px solid #a33" }}>
          {error}
          <button onClick={() => setError(null)} style={{ marginLeft: 8, cursor: "pointer", background: "none", border: "none", color: "#f88" }}>{t("btn.dismiss", "dismiss")}</button>
        </div>
      )}

      {/* Existing Backups */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{t("backup.existing", "Existing Backups")}</span>
        <button onClick={refreshBackups} disabled={loading} style={{ ...btnStyle, fontSize: 11, padding: "2px 8px" }}>
          {loading ? t("btn.loading", "Loading...") : t("btn.refresh", "Refresh")}
        </button>
      </div>

      {backups.length === 0 && !loading && (
        <div style={{ color: "var(--txd)", fontSize: 12, fontStyle: "italic" }}>{t("backup.no_backups", "No backups found")}</div>
      )}

      {backups.map((b) => (
        <div key={b.path} style={{ padding: 8, marginBottom: 6, background: "var(--bg2)", borderRadius: 4, border: "1px solid var(--brd)", fontSize: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <strong>{b.name}</strong>
              <span style={{ marginLeft: 8, padding: "1px 6px", borderRadius: 3, fontSize: 10, background: b.mode === "full" ? "#335" : "#353", color: "#ddd" }}>
                {b.mode}
              </span>
              {!b.completed && (
                <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 3, fontSize: 10, background: "#533", color: "#faa" }}>{t("backup.incomplete", "incomplete")}</span>
              )}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {b.completed && (
                <button onClick={() => setRestoreConfirm(b.path)} disabled={busy}
                  style={{ ...btnStyle, fontSize: 11, padding: "2px 8px", background: "#e90", color: "#000" }}>
                  {t("btn.restore", "Restore")}
                </button>
              )}
              <button onClick={() => setDeleteConfirm(b.path)} disabled={busy}
                style={{ ...btnStyle, fontSize: 11, padding: "2px 8px", background: "#a33" }}>
                {t("btn.delete", "Delete")}
              </button>
            </div>
          </div>
          <div style={{ fontSize: 10, color: "var(--txd)", marginTop: 2 }}>
            {formatDate(b.timestamp)} &mdash; {formatBytes(b.totalBytes)}, {b.fileCount.toLocaleString()} files
          </div>
        </div>
      ))}

      {/* Restore progress */}
      {restoring && progress && (
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
            <div style={{ width: "100%", height: 4, background: "#333", borderRadius: 2 }}>
              <div style={{
                width: `${Math.min(100, (progress.bytesCopied / progress.totalBytes) * 100)}%`,
                height: "100%", background: "#e90", borderRadius: 2, transition: "width 0.3s",
              }} />
            </div>
          )}
        </div>
      )}

      {/* Restore Confirmation */}
      {restoreConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "#1a1a2e", border: "1px solid #555", borderRadius: 8, padding: 24, maxWidth: 450, textAlign: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>{t("backup.restore_title", "Restore Backup?")}</div>
            <div style={{ fontSize: 13, color: "#ccc", marginBottom: 16 }}>
              {t("backup.restore_desc", "This will overwrite files in your current game directory. Changes since the backup was created will be lost.")}
            </div>
            <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
              <button onClick={() => handleRestore(restoreConfirm)} style={{ ...btnStyle, background: "#e90", color: "#000", padding: "6px 20px" }}>{t("btn.restore", "Restore")}</button>
              <button onClick={() => setRestoreConfirm(null)} style={{ ...btnStyle, padding: "6px 20px" }}>{t("btn.cancel", "Cancel")}</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "#1a1a2e", border: "1px solid #555", borderRadius: 8, padding: 24, maxWidth: 400, textAlign: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>{t("backup.delete_title", "Delete Backup?")}</div>
            <div style={{ fontSize: 13, color: "#ccc", marginBottom: 16 }}>{t("backup.delete_desc", "This cannot be undone.")}</div>
            <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
              <button onClick={() => handleDelete(deleteConfirm)} style={{ ...btnStyle, background: "#a33", padding: "6px 20px" }}>{t("btn.delete", "Delete")}</button>
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
  background: "#335",
  color: "#eee",
  border: "1px solid #555",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
};

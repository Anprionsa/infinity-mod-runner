import { useState, useEffect, useCallback } from "react";
import {
  getLogPaths,
  openPath,
  createDiagnosticBundle,
  pickSaveLocation,
  type LogPathsWithMeta,
  type FileMeta,
  type BundleSummary,
} from "../lib/tauri-bridge";
import { guiLog } from "../lib/gui-logger";
import { useI18n } from "../lib/i18n";
import type { AppConfig } from "../App";

/** How often the panel re-queries the backend while visible. Fast
 * enough that mid-install log-size updates feel live; slow enough
 * to not burn battery on an idle Debug tab. */
const POLL_INTERVAL_MS = 30_000;

/** Row config — maps each FileMeta `key` (stable identifier returned
 * by the Rust command) to a display title, a one-line description,
 * and an icon glyph. Order here is display order in the panel. */
interface RowConfig {
  key: string;
  /** i18n key for the row title. */
  titleKey: string;
  /** Fallback title string if the i18n key is absent. */
  titleFallback: string;
  /** i18n key for the one-line description. */
  descKey: string;
  descFallback: string;
  /** Emoji glyph. Lightweight; can upgrade to proper SVG later. */
  icon: string;
}

const ROWS: RowConfig[] = [
  {
    key: "gui_log",
    titleKey: "logs.gui_log_title",
    titleFallback: "GUI log",
    descKey: "logs.gui_log_desc",
    descFallback: "App lifecycle, config saves, errors, telemetry submissions. Spans sessions.",
    icon: "\u{1F4C4}",  // 📄
  },
  {
    key: "install_log",
    titleKey: "logs.install_log_title",
    titleFallback: "Install log",
    descKey: "logs.install_log_desc",
    descFallback: "Per-install events \u2014 batches, errors, warnings, skips, BCS cache stats, PREBIFF markers. Appended per install.",
    icon: "\u{1F4C4}",
  },
  {
    key: "config_toml",
    titleKey: "logs.config_toml_title",
    titleFallback: "Config",
    descKey: "logs.config_toml_desc",
    descFallback: "User configuration (game paths, install options, saved preferences). Written on every Save.",
    icon: "\u{2699}",  // ⚙
  },
  {
    key: "reports_dir",
    titleKey: "logs.reports_dir_title",
    titleFallback: "Install reports",
    descKey: "logs.reports_dir_desc",
    descFallback: "Structured post-install reports (install_report_*.json). Generated on demand via Save Report.",
    icon: "\u{1F4C1}",  // 📁
  },
  {
    key: "guard_report",
    titleKey: "logs.guard_report_title",
    titleFallback: "File Guard report",
    descKey: "logs.guard_report_desc",
    descFallback: "Cross-mod file-corruption incidents, when File Guard fires during an install. Only present if a guard event occurred.",
    icon: "\u{1F4C4}",
  },
  {
    key: "checkpoint",
    titleKey: "logs.checkpoint_title",
    titleFallback: "Install checkpoint",
    descKey: "logs.checkpoint_desc",
    descFallback: "Resume state for interrupted installs. Cleared automatically on a successful complete.",
    icon: "\u{1F4C4}",
  },
  {
    key: "game_data_dir",
    titleKey: "logs.game_data_dir_title",
    titleFallback: "Per-game data folder",
    descKey: "logs.game_data_dir_desc",
    descFallback: "Folder holding install.log, reports, checkpoint, guard state, and other per-game artifacts. Hashed from your BG2 game path.",
    icon: "\u{1F4C1}",
  },
  {
    key: "app_config_root",
    titleKey: "logs.app_config_root_title",
    titleFallback: "App config folder",
    descKey: "logs.app_config_root_desc",
    descFallback: "Tauri-standard config directory: gui.log, config.toml, and any rotated gui.log.* siblings.",
    icon: "\u{1F4C1}",
  },
];

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

function formatRelativeTime(modifiedMs: number): string {
  if (modifiedMs === 0) return "";
  const elapsedMs = Date.now() - modifiedMs;
  if (elapsedMs < 0) return "just now";
  if (elapsedMs < 60_000) return "just now";
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)} min ago`;
  if (elapsedMs < 86_400_000) return `${Math.floor(elapsedMs / 3_600_000)} hr ago`;
  return `${Math.floor(elapsedMs / 86_400_000)} days ago`;
}

interface Props {
  config: AppConfig;
}

/** Centralized log-location surface (Phase 21b).
 *
 * Lists every log / report / state path the app writes, with
 * Open / Open folder / Copy path affordances on each row. Polls
 * every 30s while visible so sizes update live mid-install.
 *
 * Mounted at the top of DebugPanel.tsx as a collapsible section
 * (see 21b plan). Auto-opens on first mount; user collapse is
 * persistent within the session.
 *
 * Phase 21d adds the Share Diagnostics Bundle button to this same
 * panel (bottom-right of the header).
 */
export default function LogsPanel({ config }: Props) {
  const { t } = useI18n();
  const [data, setData] = useState<LogPathsWithMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  // Bundle state — null when idle, "creating" while the zip writes,
  // a BundleSummary when done (shown as a result card with Open /
  // Copy path / Dismiss actions).
  const [bundleState, setBundleState] = useState<"idle" | "creating">("idle");
  const [bundleResult, setBundleResult] = useState<BundleSummary | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);

  // Refresh on mount + every POLL_INTERVAL_MS while the panel is
  // expanded. When collapsed we stop polling — the user isn't
  // looking at sizes, no reason to spend the IPC.
  const refresh = useCallback(async () => {
    try {
      const d = await getLogPaths(config);
      setData(d);
      setError(null);
    } catch (e) {
      setError(String(e));
      guiLog.warn("UI", `Failed to resolve log paths: ${e}`);
    }
  }, [config]);

  useEffect(() => {
    if (!expanded) return;
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [expanded, refresh]);

  const copyPath = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopyFeedback(path);
      setTimeout(() => setCopyFeedback(null), 1500);
    } catch (e) {
      guiLog.warn("UI", `Clipboard copy failed: ${e}`);
    }
  }, []);

  const open = useCallback(async (path: string) => {
    try {
      await openPath(path);
    } catch (e) {
      guiLog.warn("UI", `Open path failed for ${path}: ${e}`);
    }
  }, []);

  const createBundle = useCallback(async () => {
    // Compose the default filename with a locally-stable timestamp —
    // yyyy-mm-dd-HHMM so alphabetical sort matches chronological.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    const defaultName = `infinity-mod-runner-diagnostics-${stamp}.zip`;
    const chosen = await pickSaveLocation(
      "Save Diagnostic Bundle",
      defaultName,
      [{ name: "Zip", extensions: ["zip"] }],
    );
    if (!chosen) return; // User cancelled; no UI state change.
    setBundleState("creating");
    setBundleError(null);
    setBundleResult(null);
    try {
      const summary = await createDiagnosticBundle(config, chosen);
      setBundleResult(summary);
      guiLog.info("UI", `Diagnostic bundle created: ${summary.bundle_path} (${summary.entries.length} files, ${summary.bundle_size} bytes)`);
    } catch (e) {
      setBundleError(String(e));
      guiLog.error("UI", `Diagnostic bundle failed: ${e}`);
    } finally {
      setBundleState("idle");
    }
  }, [config]);

  // Build a lookup from key → FileMeta so the ROWS array drives
  // rendering order regardless of what order the backend returned.
  const metaByKey = new Map<string, FileMeta>();
  if (data) {
    for (const f of data.files) metaByKey.set(f.key, f);
  }

  const rotatedGuiLogs = data?.paths.gui_log_rotated ?? [];

  return (
    <div
      style={{
        marginBottom: 16,
        border: "1px solid var(--brd)",
        borderRadius: 4,
        background: "var(--bg2)",
      }}
    >
      {/* Collapsible header */}
      <div
        className="log-toggle"
        onClick={() => setExpanded((v) => !v)}
        style={{ margin: 0, padding: "10px 14px", borderBottom: expanded ? "1px solid var(--brd)" : "none" }}
      >
        <span>
          <span className={"toggle-arrow" + (expanded ? " open" : "")}>{"\u25B6"}</span>
          {" "}{t("logs.panel_title", "Logs & Diagnostics")}
        </span>
        <span style={{ fontSize: 11, color: "var(--txd)" }}>
          {t("logs.panel_hint", "Find, open, or share every log the app writes")}
        </span>
      </div>

      {expanded && (
        <div style={{ padding: "10px 14px" }}>
          {error && (
            <div className="msg err" style={{ fontSize: 12, marginBottom: 10 }}>
              {t("logs.resolve_failed", "Couldn't resolve log paths:")} {error}
            </div>
          )}

          {copyFeedback && (
            <div
              role="status"
              style={{
                fontSize: 11,
                color: "var(--grn)",
                marginBottom: 8,
                padding: "4px 8px",
                background: "rgba(16, 185, 129, 0.08)",
                borderRadius: 3,
                border: "1px solid rgba(16, 185, 129, 0.25)",
              }}
            >
              {"\u2713"} {t("logs.copied", "Copied to clipboard:")}{" "}
              <code style={{ fontFamily: "'Fira Code', monospace", fontSize: 10 }}>{copyFeedback}</code>
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {ROWS.map((row) => {
              const meta = metaByKey.get(row.key);
              const resolved = meta?.path;
              const exists = meta?.exists ?? false;
              const size = meta?.size ?? 0;
              const mtime = meta?.modified_ms ?? 0;

              return (
                <div
                  key={row.key}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 4,
                    background: "var(--bg)",
                    border: `1px solid ${exists ? "var(--brd)" : "transparent"}`,
                    opacity: exists ? 1 : 0.55,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <span style={{ fontSize: 14, flexShrink: 0, lineHeight: "16px" }}>{row.icon}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tx)" }}>
                        {t(row.titleKey, row.titleFallback)}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--txd)", lineHeight: 1.4, marginTop: 2 }}>
                        {t(row.descKey, row.descFallback)}
                      </div>
                      {resolved ? (
                        <div style={{
                          fontSize: 10,
                          color: "var(--txd)",
                          fontFamily: "'Fira Code', monospace",
                          marginTop: 4,
                          wordBreak: "break-all",
                        }}>
                          {resolved}
                        </div>
                      ) : (
                        <div style={{ fontSize: 10, color: "var(--txd)", fontStyle: "italic", marginTop: 4 }}>
                          {t("logs.not_yet_present", "not present \u2014 will be created when needed")}
                        </div>
                      )}
                      {exists && (
                        <div style={{ fontSize: 10, color: "var(--txd)", marginTop: 2 }}>
                          {formatBytes(size)}
                          {mtime > 0 && ` \u00b7 ${formatRelativeTime(mtime)}`}
                        </div>
                      )}
                    </div>
                    {resolved && (
                      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                        <button
                          className="btn"
                          onClick={() => open(resolved)}
                          disabled={!exists}
                          title={t("logs.open_hint", "Open in the OS file manager")}
                          style={{ fontSize: 10, padding: "2px 8px" }}
                        >
                          {t("logs.open", "Open")}
                        </button>
                        <button
                          className="btn"
                          onClick={() => copyPath(resolved)}
                          title={t("logs.copy_hint", "Copy the full path to the clipboard")}
                          style={{ fontSize: 10, padding: "2px 8px" }}
                        >
                          {t("logs.copy", "Copy")}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Condensed row for rotated gui.logs — shown as a count,
             * not individual rows, because there can be up to 4 of
             * them (gui.log.1–3 + gui.log.prev-<version>) and users
             * rarely need to open them individually. Open Folder on
             * the app-config row above gets them all at once. */}
            {rotatedGuiLogs.length > 0 && (
              <div
                style={{
                  padding: "6px 10px",
                  fontSize: 11,
                  color: "var(--txd)",
                  fontStyle: "italic",
                }}
              >
                {t("logs.rotated_count", "+ {n} rotated gui.log file(s) in the app config folder")
                  .replace("{n}", String(rotatedGuiLogs.length))}
              </div>
            )}
          </div>

          {/* Phase 21d: Share Diagnostics Bundle. Packages the
           * current log set + redacted config into a single zip
           * the user can attach to a help chat or forum post.
           * Strictly local — no network upload. */}
          <div style={{
            marginTop: 14,
            paddingTop: 12,
            borderTop: "1px solid var(--brd)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
          }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--txd)", lineHeight: 1.4 }}>
              {t(
                "logs.share_bundle_hint",
                "Package gui.log + install.log + reports + redacted config into a local zip, ready to attach to a forum post or help chat. No network upload.",
              )}
            </div>
            <button
              className="btn btn-primary"
              disabled={bundleState === "creating"}
              onClick={createBundle}
              style={{ fontSize: 11, padding: "4px 12px", flexShrink: 0 }}
            >
              {bundleState === "creating"
                ? t("logs.bundle_creating", "Building bundle\u2026")
                : t("logs.share_bundle", "Create Diagnostic Bundle\u2026")}
            </button>
          </div>

          {bundleError && (
            <div className="msg err" style={{ fontSize: 11, marginTop: 10 }}>
              {bundleError}
            </div>
          )}

          {bundleResult && (
            <div
              style={{
                marginTop: 10,
                padding: "10px 12px",
                borderRadius: 4,
                background: "var(--bg-ok)",
                border: "1px solid var(--grn)",
                fontSize: 11,
                color: "var(--tx)",
              }}
            >
              <div style={{ fontWeight: 600, color: "var(--grn)", marginBottom: 4 }}>
                {"\u2713"} {t("logs.bundle_done_title", "Bundle created")}
              </div>
              <div style={{ fontFamily: "'Fira Code', monospace", fontSize: 10, color: "var(--txd)", wordBreak: "break-all", marginBottom: 6 }}>
                {bundleResult.bundle_path}
              </div>
              <div style={{ color: "var(--txd)", marginBottom: 4 }}>
                {bundleResult.entries.length} files \u00b7 {formatBytes(bundleResult.bundle_size)}
              </div>
              <div style={{ fontSize: 10, color: "var(--txd)", fontStyle: "italic", marginBottom: 8 }}>
                {t(
                  "logs.bundle_redacted",
                  "Redacted: game directory paths, mod directory, WeiDU binary, custom data directory, backup directories, override fast-drive path",
                )}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  className="btn"
                  onClick={() => open(bundleResult.bundle_path)}
                  style={{ fontSize: 11, padding: "3px 10px" }}
                >
                  {t("logs.bundle_open_folder", "Open folder")}
                </button>
                <button
                  className="btn"
                  onClick={() => copyPath(bundleResult.bundle_path)}
                  style={{ fontSize: 11, padding: "3px 10px" }}
                >
                  {t("logs.copy", "Copy")}
                </button>
                <button
                  className="btn"
                  onClick={() => setBundleResult(null)}
                  style={{ fontSize: 11, padding: "3px 10px" }}
                >
                  {t("btn.dismiss", "Dismiss")}
                </button>
              </div>
            </div>
          )}

          <div style={{ marginTop: 10, fontSize: 10, color: "var(--txd)" }}>
            <a
              href="https://github.com/Anprionsa/infinity-mod-runner/blob/main/docs/LOGS.md"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--cyn)", textDecoration: "underline" }}
              onClick={(e) => {
                e.preventDefault();
                openPath("https://github.com/Anprionsa/infinity-mod-runner/blob/main/docs/LOGS.md").catch(() => {});
              }}
            >
              {t("logs.docs_link", "What are these? \u2192 docs/LOGS.md")}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

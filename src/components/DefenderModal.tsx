import { useState } from "react";
import { useI18n } from "../lib/i18n";
import { defenderAddExclusion } from "../lib/tauri-bridge";
import { guiLog } from "../lib/gui-logger";

/** Three resolutions of the pre-install Defender modal:
 *
 *  - "add"   — user clicked "Add exclusion & continue"; UAC fired; we
 *              attempted the exclusion. Success = true; UAC-cancel =
 *              false. The caller proceeds with the install either way.
 *  - "skip"  — user clicked "Skip this time". No exclusion added.
 *              Modal may re-fire on a future install.
 *  - "never" — user clicked "Don't ask again". Sticky — sets the
 *              `defender_prompt_dismissed` config flag so the modal
 *              never appears again. The Advanced checkbox stays
 *              available as the opt-in path if they change their mind.
 */
export type DefenderModalResolution =
  | { kind: "add"; succeeded: boolean }
  | { kind: "skip" }
  | { kind: "never" };

interface Props {
  /** Path to add as the exclusion — the BG2 game directory. */
  gameDir: string;
  /** Resolution callback. Caller applies the appropriate config
   * mutations (`auto_defender_exclusion`, `defender_prompt_dismissed`)
   * and decides whether to proceed with the install. */
  onResolve: (result: DefenderModalResolution) => void;
}

/** Pre-install "offer Defender exclusion" modal (Phase 22b).
 *
 * Fires once at install start when all of these are true:
 *   - Defender reports Active (realtime protection on)
 *   - `gameDir` is not already excluded
 *   - `override_fast_drive` is off (fast-drive bypasses the file-close
 *     scan overhead by writing elsewhere)
 *   - `auto_defender_exclusion` is off (user hasn't already opted in)
 *   - `defender_prompt_dismissed` is off (user hasn't said "never")
 *
 * Gating is done by the caller (InstallRunner). This component only
 * renders the UI and reports back via `onResolve`.
 */
export default function DefenderModal({ gameDir, onResolve }: Props) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  const handleAdd = async () => {
    setBusy(true);
    try {
      const succeeded = await defenderAddExclusion(gameDir);
      guiLog.info("DEFENDER", `Exclusion request for ${gameDir}: ${succeeded ? "added" : "cancelled/failed"}`);
      onResolve({ kind: "add", succeeded });
    } catch (e) {
      // True error path (PowerShell couldn't run, Defender policy
      // block, etc.). Treat as "cancelled" from the flow's perspective
      // — we don't want the install to abort because a perf
      // optimization failed.
      guiLog.warn("DEFENDER", `add_exclusion error for ${gameDir}: ${e}`);
      onResolve({ kind: "add", succeeded: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !busy && onResolve({ kind: "skip" })}>
      <div
        className="modal"
        style={{ maxWidth: 520 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-title" style={{ color: "var(--gold)" }}>
          {t("defender.modal_title", "Speed up this install with a Defender exclusion?")}
        </div>
        <div className="modal-body" style={{ fontSize: 13, lineHeight: 1.5, textAlign: "left" }}>
          <p style={{ marginTop: 0 }}>
            {t(
              "defender.modal_body_p1",
              "Windows Defender's real-time scan runs on every file close \u2014 adding roughly 20 ms per operation. SFO-heavy mods (dw_talents, stratagems, mih_tweaks) run thousands of file ops per component, so Defender adds hours to big installs.",
            )}
          </p>
          <p>
            {t(
              "defender.modal_body_p2",
              "Adding your game directory to Defender's exclusion list typically speeds those mods up 2\u20135\u00d7. The exclusion is permanent \u2014 we won't remove it afterward, so you only need to approve the UAC prompt once.",
            )}
          </p>
          <div
            style={{
              marginTop: 10,
              padding: "8px 10px",
              background: "var(--bg2)",
              border: "1px solid var(--brd)",
              borderRadius: 4,
              fontSize: 11,
              fontFamily: "'Fira Code', monospace",
              color: "var(--txd)",
              wordBreak: "break-all",
            }}
          >
            {gameDir}
          </div>
          <p style={{ marginTop: 10, marginBottom: 0, color: "var(--txd)", fontSize: 12 }}>
            {t(
              "defender.modal_body_uac",
              "You'll see one UAC prompt from Windows to authorize the change. You can remove the exclusion later via Windows Security \u2192 Virus & threat protection \u2192 Manage settings \u2192 Exclusions.",
            )}
          </p>
        </div>
        <div className="modal-actions" style={{ flexWrap: "wrap" }}>
          <button
            className="btn"
            onClick={() => onResolve({ kind: "never" })}
            disabled={busy}
            title={t(
              "defender.never_hint",
              "Never show this prompt again. You can still enable auto-exclusion manually from Install \u2192 Advanced.",
            )}
          >
            {t("defender.never", "Don't ask again")}
          </button>
          <button
            className="btn"
            onClick={() => onResolve({ kind: "skip" })}
            disabled={busy}
          >
            {t("defender.skip", "Skip this time")}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleAdd}
            disabled={busy}
          >
            {busy
              ? t("defender.adding", "Waiting for UAC\u2026")
              : t("defender.add", "Add exclusion & continue")}
          </button>
        </div>
      </div>
    </div>
  );
}

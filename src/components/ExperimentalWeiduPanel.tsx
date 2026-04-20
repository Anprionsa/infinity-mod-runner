import { useState } from "react";
import { useI18n } from "../lib/i18n";
import type { WeiduExperimentalMeta } from "../lib/tauri-bridge";

/**
 * Extract an `href`-usable URL from `meta.upstream_source`.
 *
 * The field has two historical shapes depending on the meta.json generator:
 *   1. Old: a bare URL (`"https://github.com/WeiDUorg/weidu"`) — whole string
 *      works as href.
 *   2. New: descriptive text that starts with a URL followed by em-dash +
 *      commentary (`"https://github.com/WeiDUorg/weidu — vendored from …"`).
 *      The whole string is not a valid href; we need just the URL prefix.
 *
 * We detect the URL prefix with a simple regex and fall back to the whole
 * string if nothing matches. This keeps the panel working across both
 * formats instead of the link silently breaking after a meta.json rev.
 */
function extractUpstreamUrl(raw: string): string {
  const match = raw.match(/^(https?:\/\/\S+)/);
  return match ? match[1].replace(/[.,;]+$/, "") : raw;
}

/**
 * Modal for opting into / out of the experimental patched WeiDU.
 *
 * Design notes:
 * - The feature is a pure config toggle. Enabling doesn't modify any game
 *   files — the install orchestrator resolves the weidu path at install start
 *   and invokes the bundled patched binary instead of the user's configured
 *   `weidu_path`. Disabling is a no-op: the next install uses the configured
 *   path again.
 * - The modal is presented from ReadyCheck (alongside the patches scan row)
 *   and shows description / risks / explicit acknowledgement before flipping
 *   the config bit.
 */

interface Props {
  mode: "enable" | "disable";
  meta: WeiduExperimentalMeta | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function ExperimentalWeiduModal({
  mode,
  meta,
  onCancel,
  onConfirm,
}: Props) {
  const { t } = useI18n();
  const [acknowledged, setAcknowledged] = useState(false);

  const title =
    mode === "enable"
      ? t("exp_weidu.modal_enable_title", "Use the patched WeiDU for installs?")
      : t("exp_weidu.modal_disable_title", "Switch back to your configured WeiDU?");

  const confirmLabel =
    mode === "enable"
      ? t("exp_weidu.modal_confirm_enable", "Enable for this install")
      : t("exp_weidu.modal_confirm_disable", "Disable");

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--modal-backdrop-soft)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg2)",
          color: "var(--tx)",
          padding: 20,
          borderRadius: 8,
          maxWidth: 640,
          maxHeight: "80vh",
          overflow: "auto",
          border: "1px solid var(--brd2)",
        }}
      >
        <h2 style={{ margin: "0 0 12px 0" }}>
          {mode === "enable" ? "\u26A0 " : ""}
          {title}
        </h2>

        {mode === "enable" && meta && (
          <>
            <p style={{ fontSize: "0.95em" }}>{meta.description}</p>

            <h3 style={{ marginTop: 12, marginBottom: 6, fontSize: "1em" }}>
              {t("exp_weidu.modal_what", "What this changes")}
            </h3>
            <ul style={{ fontSize: "0.9em", paddingLeft: 20, margin: 0 }}>
              {meta.what_it_changes.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>

            <h3
              style={{
                marginTop: 12,
                marginBottom: 6,
                fontSize: "1em",
                color: "var(--tx-warn)",
              }}
            >
              {t("exp_weidu.modal_risks", "Risks")}
            </h3>
            <ul style={{ fontSize: "0.9em", paddingLeft: 20, margin: 0 }}>
              {meta.risks.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>

            {meta.complementary && (
              <p
                style={{
                  fontSize: "0.85em",
                  marginTop: 10,
                  color: "var(--txd)",
                }}
              >
                <em>{meta.complementary}</em>
              </p>
            )}

            <p
              style={{
                fontSize: "0.85em",
                marginTop: 10,
                color: "var(--txd)",
              }}
            >
              {t("exp_weidu.modal_based_on", "Based on")}{" "}
              <a
                href={extractUpstreamUrl(meta.upstream_source)}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "inherit" }}
              >
                {t("exp_weidu.modal_upstream", "upstream WeiDU")}
              </a>
              {" — "}
              {t("exp_weidu.modal_version_short", "v")}
              {meta.base_weidu_version} + patch rev {meta.patch_revision}
            </p>

            <h3 style={{ marginTop: 12, marginBottom: 6, fontSize: "1em" }}>
              {t("exp_weidu.modal_how_it_works", "How it works")}
            </h3>
            <p style={{ fontSize: "0.9em", margin: 0 }}>
              {t(
                "exp_weidu.modal_how_text",
                "Enabling this only flips a setting. At install start, Infinity Mod Runner extracts the bundled patched binary into its own data directory and invokes that path instead of your configured weidu_path. Your game directory is not modified, and your configured WeiDU binary is untouched. Disabling returns the next install to using your configured binary."
              )}
            </p>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 16,
                fontSize: "0.9em",
              }}
            >
              <input
                className="checkbox"
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              {t(
                "exp_weidu.modal_ack",
                "I understand this is experimental, replaces the WeiDU binary used by the installer, and is not supported by WeiDU authors."
              )}
            </label>
          </>
        )}

        {mode === "disable" && (
          <>
            <p style={{ fontSize: "0.95em" }}>
              {t(
                "exp_weidu.modal_disable_text",
                "Your next install will use the WeiDU binary configured in Setup. The cached patched binary can be re-enabled at any time — no reinstall of Infinity Mod Runner needed."
              )}
            </p>
            <p
              style={{
                fontSize: "0.85em",
                marginTop: 10,
                color: "var(--txd)",
              }}
            >
              {t(
                "exp_weidu.modal_disable_caveat",
                "If you have an install in progress, it will keep using whichever binary it started with — the switch only affects the NEXT install."
              )}
            </p>
          </>
        )}

        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 16,
          }}
        >
          <button className="btn btn-secondary" onClick={onCancel}>
            {t("btn.cancel", "Cancel")}
          </button>
          <button
            className="btn"
            disabled={mode === "enable" && !acknowledged}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

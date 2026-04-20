import { openUrl } from "@tauri-apps/plugin-opener";
import type { AppConfig } from "../App";
import { useI18n } from "../lib/i18n";
import { guiLog } from "../lib/gui-logger";
import { FORGE_WEB_URL } from "../constants/forge";

const README_URL = "https://github.com/Anprionsa/infinity-mod-runner#readme";

interface Props {
  config: AppConfig;
  onSave: (config: AppConfig) => void;
}

/** First-run orientation card, pinned at the top of the Setup tab.
 *
 * Shown only when **all** of these are true:
 *   - `config.bg2_game_dir` is falsy (never configured) — returning users
 *     with a filled config never see the card
 *   - `config.welcome_dismissed_at` is null — user hasn't explicitly
 *     dismissed it
 *
 * Dismissal writes an ISO8601 timestamp to config and is a one-way door:
 * there's no "re-show welcome" toggle by design. A returning user
 * seeing a welcome card they already read is worse than a first-timer
 * never seeing one.
 */
export default function WelcomeCard({ config, onSave }: Props) {
  const { t } = useI18n();

  // Gating — both conditions must hold. We intentionally check
  // `bg2_game_dir` (not a generic setupValid flag) because a user
  // halfway through their first Setup shouldn't have the card pop back
  // in and out as they fill fields.
  const shouldShow = !config.bg2_game_dir && !config.welcome_dismissed_at;
  if (!shouldShow) return null;

  const dismiss = () => {
    onSave({ ...config, welcome_dismissed_at: new Date().toISOString() });
    guiLog.info("UI", "Welcome card dismissed");
  };

  const openForge = async () => {
    try { await openUrl(FORGE_WEB_URL); }
    catch (e) { guiLog.warn("UI", `Failed to open Forge: ${e}`); }
  };
  const openReadme = async () => {
    try { await openUrl(README_URL); }
    catch (e) { guiLog.warn("UI", `Failed to open README: ${e}`); }
  };

  return (
    <div
      className="phase-banner gold"
      style={{
        marginBottom: 16,
        padding: "16px 20px",
        letterSpacing: 0,
        textTransform: "none",
        fontWeight: 400,
        position: "relative",
      }}
    >
      {/* Close (×) — ghost button in the top-right. Matches the modal
       * close-button style so it reads consistently with the rest of the
       * app's dismissible surfaces. */}
      <button
        onClick={dismiss}
        title={t("welcome.dismiss_title", "Dismiss")}
        aria-label={t("welcome.dismiss_aria", "Dismiss welcome card")}
        style={{
          position: "absolute",
          top: 10,
          right: 12,
          background: "transparent",
          border: "none",
          color: "var(--txd)",
          fontSize: 18,
          lineHeight: 1,
          cursor: "pointer",
          padding: 4,
        }}
      >
        {"\u00d7"}
      </button>

      <div
        style={{
          fontFamily: "Cinzel, serif",
          fontSize: 16,
          fontWeight: 600,
          color: "var(--gold)",
          marginBottom: 6,
        }}
      >
        {t("welcome.title", "Welcome to Infinity Mod Runner")}
      </div>

      <div style={{ fontSize: 13, color: "var(--tx)", lineHeight: 1.5, marginBottom: 10 }}>
        {t(
          "welcome.intro",
          "This tool installs Baldur's Gate, Icewind Dale, and Planescape Torment mods from a list you build in Infinity Mod Forge (the web app). Runner doesn't pick mods for you \u2014 it drives WeiDU through a plan Forge exported.",
        )}
      </div>

      <div style={{ fontSize: 12, color: "var(--txd)", marginBottom: 4, fontWeight: 600 }}>
        {t("welcome.needs_heading", "What you'll need:")}
      </div>
      <ul
        style={{
          margin: "0 0 12px 0",
          paddingLeft: 22,
          fontSize: 12,
          color: "var(--tx)",
          lineHeight: 1.7,
        }}
      >
        <li>{t("welcome.need_game_dir", "Your game directory (BG1:EE or BG2:EE, minimum)")}</li>
        <li>{t("welcome.need_mod_dir", "A folder of extracted mods (each in its own subfolder, containing a .tp2 file)")}</li>
        <li>{t("welcome.need_weidu_log", "A WeiDU.log exported from Infinity Mod Forge")}</li>
      </ul>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "var(--txd)", marginRight: 4 }}>
          {t("welcome.new_to_this", "New to this?")}
        </span>
        <button
          className="btn"
          style={{ fontSize: 12, padding: "4px 12px" }}
          onClick={openForge}
        >
          {t("welcome.open_forge", "Open Infinity Mod Forge")} {"\u2192"}
        </button>
        <button
          className="btn"
          style={{ fontSize: 12, padding: "4px 12px" }}
          onClick={openReadme}
        >
          {t("welcome.read_readme", "Read the README")} {"\u2192"}
        </button>
        <div style={{ flex: 1 }} />
        <button
          className="btn btn-primary"
          style={{ fontSize: 12, padding: "4px 14px" }}
          onClick={dismiss}
        >
          {t("welcome.got_it", "Got it, let's go")}
        </button>
      </div>
    </div>
  );
}

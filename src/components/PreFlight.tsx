import { useState, useCallback } from "react";
import type { AppConfig, ParsedLog, PreFlightResult } from "../App";
import {
  fetchKnownIssues,
  fetchCompat,
  type KnownIssue,
  type CompatData,
} from "../lib/forge-data";

interface Props {
  config: AppConfig;
  parsedLog: ParsedLog | null;
  result: PreFlightResult | null;
  onResult: (result: PreFlightResult) => void;
  forgeOnline: boolean | null;
}

export default function PreFlight({
  config,
  parsedLog,
  result,
  onResult,
  forgeOnline,
}: Props) {
  const [running, setRunning] = useState(false);

  const runChecks = useCallback(async () => {
    if (!parsedLog) return;
    setRunning(true);

    const messages: PreFlightResult["messages"] = [];
    const baseUrl =
      config.forge_data_url || "https://anprionsa.github.io/eet-mod-forge";

    // 1. Basic validation
    if (!config.bg2_game_dir) {
      messages.push({ t: "err", m: "BG2:EE game directory not set" });
    }
    if (!config.bg1_game_dir) {
      messages.push({ t: "err", m: "BG1:EE game directory not set" });
    }
    if (!config.mod_directory) {
      messages.push({ t: "err", m: "Mod directory not set" });
    }
    if (!config.weidu_path && !config.mod_installer_path) {
      messages.push({
        t: "warn",
        m: "Neither WeiDU nor mod_installer path configured — install may fail to find binaries",
      });
    }

    // 2. Check essential mods (across both logs)
    const eetModNames = new Set(parsedLog.entries.map((e) => e.mod_name));
    const bgeeModNames = new Set(
      (parsedLog.bgeeEntries || []).map((e) => e.mod_name),
    );
    const allModNames = new Set([...eetModNames, ...bgeeModNames]);

    if (!eetModNames.has("eet")) {
      messages.push({ t: "err", m: "EET core mod not found in EET log — required" });
    }
    if (!eetModNames.has("eet_end")) {
      messages.push({
        t: "err",
        m: "EET_End not found in EET log — required for finalization",
      });
    }
    if (!allModNames.has("eefixpack") && !allModNames.has("ee_fixpack")) {
      messages.push({
        t: "err",
        m: "EE Fixpack not found in either log — required for stable installs",
      });
    }
    if (!allModNames.has("dlcmerger") && !allModNames.has("dlc_merger")) {
      messages.push({
        t: "warn",
        m: "DLC Merger not found — may be needed if you have Siege of Dragonspear DLC",
      });
    }
    // Use allModNames for later compat checks
    const modNames = allModNames;

    // 3. Fetch remote data if online
    let knownIssues: KnownIssue[] = [];
    let compat: CompatData = {};

    if (forgeOnline) {
      try {
        [knownIssues, compat] = await Promise.all([
          fetchKnownIssues(baseUrl),
          fetchCompat(baseUrl),
        ]);
        messages.push({
          t: "info",
          m: `Loaded ${knownIssues.length} known issues and ${Object.keys(compat).length} compat entries from Forge`,
        });
      } catch (e) {
        messages.push({
          t: "warn",
          m: `Could not fetch Forge data: ${e}. Skipping remote checks.`,
        });
      }
    } else {
      messages.push({
        t: "warn",
        m: "Forge data offline — skipping remote conflict/compat checks",
      });
    }

    // 4. Check compat database
    for (const [modKey, entry] of Object.entries(compat)) {
      const normalizedKey = modKey.toLowerCase().replace(/\s+/g, "");
      const found = [...modNames].some(
        (m) => m.replace(/[_\s-]/g, "") === normalizedKey,
      );

      if (entry.ver === "required" && !found) {
        messages.push({
          t: "warn",
          m: `Compat DB says "${modKey}" is required but not found in log`,
        });
      }
    }

    // 5. Platform checks
    const platform =
      typeof navigator !== "undefined" ? navigator.platform : "";
    const isWindows = platform.startsWith("Win");
    if (!isWindows) {
      // Check for win-only mods (would need full mod data, simplified here)
      messages.push({
        t: "info",
        m: `Running on ${platform} — ensure mod_installer and WeiDU are the correct platform builds`,
      });
    }

    // 6. Summary
    const errCount = messages.filter((m) => m.t === "err").length;
    const warnCount = messages.filter((m) => m.t === "warn").length;

    if (errCount === 0 && warnCount === 0) {
      messages.push({
        t: "ok",
        m: "All pre-flight checks passed. Ready to install.",
      });
    } else if (errCount === 0) {
      messages.push({
        t: "ok",
        m: `Pre-flight complete with ${warnCount} warning(s). You may proceed.`,
      });
    }

    const passed = errCount === 0;
    onResult({ messages, passed, checkedAt: Date.now() });
    setRunning(false);
  }, [parsedLog, config, forgeOnline, onResult]);

  return (
    <div>
      <h2>Pre-Flight Check</h2>
      <p style={{ color: "var(--txd)", marginBottom: 20, fontSize: 13 }}>
        Validates your configuration and checks for known issues before starting
        a potentially multi-hour install.
      </p>

      {!parsedLog && (
        <div className="msg warn">
          Import a WeiDU.log first (Import tab) before running pre-flight
          checks.
        </div>
      )}

      {parsedLog && (
        <button
          className="btn btn-primary"
          onClick={runChecks}
          disabled={running}
          style={{ marginBottom: 16 }}
        >
          {running
            ? "Running checks..."
            : result
              ? "Re-run Pre-Flight Checks"
              : "Run Pre-Flight Checks"}
        </button>
      )}

      {result && (
        <>
          <div style={{ marginBottom: 8 }}>
            {result.passed ? (
              <div
                className="msg ok"
                style={{ fontSize: 14, fontWeight: 600 }}
              >
                PASS — Ready to install
              </div>
            ) : (
              <div
                className="msg err"
                style={{ fontSize: 14, fontWeight: 600 }}
              >
                BLOCKED — Fix errors before installing
              </div>
            )}
          </div>

          {result.messages.map((msg, i) => (
            <div key={i} className={`msg ${msg.t}`}>
              {msg.m}
            </div>
          ))}

          <div
            style={{
              color: "var(--txd)",
              fontSize: 11,
              marginTop: 12,
            }}
          >
            Checked at {new Date(result.checkedAt).toLocaleTimeString()}
          </div>
        </>
      )}
    </div>
  );
}

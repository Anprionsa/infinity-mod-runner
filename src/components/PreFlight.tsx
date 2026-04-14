import { useState, useCallback } from "react";
import type { AppConfig, ParsedLog, PreFlightResult, DownloadReadiness } from "../App";
import {
  verifyWeidu,
  scanModDirectory,
  scanPatches,
  applyPatches,
  type PatchStatus,
  type PatchResult,
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
  parsedLog: ParsedLog | null;
  result: PreFlightResult | null;
  onResult: (result: PreFlightResult) => void;
  forgeOnline: boolean | null;
  downloadReadiness: DownloadReadiness | null;
}

export default function PreFlight({
  config,
  parsedLog,
  result,
  onResult,
  forgeOnline,
  downloadReadiness,
}: Props) {
  const [running, setRunning] = useState(false);
  const [checkStep, setCheckStep] = useState("");
  const [checkProgress, setCheckProgress] = useState(0);

  // Patcher state
  const [patches, setPatches] = useState<PatchStatus[]>([]);
  const [patchesScanned, setPatchesScanned] = useState(false);
  const [patchScanning, setPatchScanning] = useState(false);
  const [patchSelected, setPatchSelected] = useState<Set<number>>(new Set());
  const [patching, setPatching] = useState(false);
  const [patchResults, setPatchResults] = useState<PatchResult[]>([]);
  const [patchStep, setPatchStep] = useState("");
  const [patchProgress, setPatchProgress] = useState(0);

  // Scan for applicable patches
  const runPatchScan = useCallback(async () => {
    if (!config.mod_directory || !config.bg2_game_dir) return;
    setPatchScanning(true);
    setPatchStep("Scanning for applicable patches...");
    setPatchProgress(30);
    try {
      const results = await scanPatches(config.mod_directory, config.bg2_game_dir);
      setPatches(results);
      setPatchesScanned(true);
      const applicable = new Set(results.filter((p) => p.status === "applicable").map((p) => p.id));
      setPatchSelected(applicable);
      setPatchStep("");
      setPatchProgress(100);
    } catch (e) {
      setPatchStep(`Scan failed: ${e}`);
    } finally {
      setPatchScanning(false);
    }
  }, [config.mod_directory, config.bg2_game_dir]);

  // Apply selected patches
  const runPatchApply = useCallback(async () => {
    if (!config.mod_directory || !config.bg2_game_dir || patchSelected.size === 0) return;
    setPatching(true);
    setPatchResults([]);
    setPatchStep("Applying patches...");
    setPatchProgress(10);
    try {
      const ids = [...patchSelected];
      const results = await applyPatches(config.mod_directory, config.bg2_game_dir, ids);
      setPatchResults(results);
      setPatchProgress(100);
      setPatchStep("Done");
      // Re-scan to update statuses
      const updated = await scanPatches(config.mod_directory, config.bg2_game_dir);
      setPatches(updated);
      setPatchSelected(new Set());
    } catch (e) {
      setPatchStep(`Apply failed: ${e}`);
    } finally {
      setPatching(false);
    }
  }, [config.mod_directory, config.bg2_game_dir, patchSelected]);

  const togglePatch = useCallback((id: number) => {
    setPatchSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const runChecks = useCallback(async () => {
    if (!parsedLog) return;
    setRunning(true);
    setCheckStep("Validating paths...");
    setCheckProgress(10);
    await new Promise((r) => setTimeout(r, 50));

    const messages: PreFlightResult["messages"] = [];
    const baseUrl =
      config.forge_data_url || "https://anprionsa.github.io/eet-mod-forge";

    // ═══ MANDATORY INFRASTRUCTURE CHECKS ═══

    // 1. Basic path validation
    if (!config.bg2_game_dir) {
      messages.push({ t: "err", m: "BG2:EE game directory not set. Go to Setup tab and select your BG2:EE install folder." });
    }
    if (!config.bg1_game_dir) {
      messages.push({ t: "err", m: "BG1:EE game directory not set. Go to Setup tab and select your BG1:EE install folder." });
    }
    if (!config.mod_directory) {
      messages.push({ t: "err", m: "Mod directory not set. This is the folder where your extracted mods live (each mod in its own subfolder with a .tp2 file)." });
    }
    if (!config.mod_installer_path) {
      messages.push({ t: "err", m: "mod_installer binary not set. Go to Setup tab and browse to mod_installer.exe." });
    }

    // 2. Verify WeiDU can execute
    setCheckStep("Verifying WeiDU...");
    setCheckProgress(25);
    await new Promise((r) => setTimeout(r, 50));

    if (config.weidu_path) {
      try {
        const weiduCheck = await verifyWeidu(config.weidu_path);
        if (weiduCheck.success) {
          messages.push({ t: "ok", m: `WeiDU verified: ${weiduCheck.version || "OK"}` });
        } else {
          messages.push({
            t: "err",
            m: `WeiDU cannot execute: ${weiduCheck.error || "Unknown error"}. This will cause every component to fail. Check that weidu.exe is not blocked by antivirus (Windows Defender often quarantines it).`,
          });
        }
      } catch (e) {
        messages.push({
          t: "err",
          m: `WeiDU verification failed: ${e}. The install cannot proceed without a working WeiDU binary.`,
        });
      }
    } else {
      messages.push({
        t: "warn",
        m: "WeiDU path not set. mod_installer will try to find it automatically, but setting it explicitly in Setup is recommended.",
      });
    }

    // 3. Scan mod directory for actual mods
    setCheckStep("Scanning mod directory...");
    setCheckProgress(40);
    await new Promise((r) => setTimeout(r, 50));

    if (config.mod_directory) {
      try {
        const modScan = await scanModDirectory(config.mod_directory);
        if (!modScan.exists) {
          messages.push({
            t: "err",
            m: "Mod directory does not exist. Check the path in Setup.",
          });
        } else if (modScan.mod_count === 0) {
          messages.push({
            t: "err",
            m: `No mods found in ${config.mod_directory}. Mods must be extracted (unzipped) into this directory — each mod in its own subfolder containing a .tp2 file. Downloaded .zip or .rar files must be extracted first.`,
          });
        } else {
          messages.push({
            t: "ok",
            m: `Mod directory: ${modScan.mod_count} mod folders found (${modScan.tp2_count} .tp2 files)`,
          });
        }
      } catch (e) {
        messages.push({ t: "warn", m: `Could not scan mod directory: ${e}` });
      }
    }

    // 4. Check if all mods are downloaded — uses Download tab data (no re-scan)
    setCheckStep("Checking mod readiness...");
    setCheckProgress(55);
    await new Promise((r) => setTimeout(r, 50));

    if (downloadReadiness) {
      const { totalMods, alreadyHave, missingNames } = downloadReadiness;
      const missingCount = missingNames.length;
      if (missingCount === 0) {
        messages.push({
          t: "ok",
          m: `All ${alreadyHave} of ${totalMods} mods are on disk`,
        });
      } else {
        const severity = missingCount >= 5 ? "err" : "warn";
        const showCount = Math.min(missingCount, 10);
        const modList = missingNames.slice(0, showCount).map((n) => `"${n}"`).join(", ");
        const extra = missingCount > showCount ? ` and ${missingCount - showCount} more` : "";
        messages.push({
          t: severity as "err" | "warn",
          m: `${missingCount} of ${totalMods} mods not found on disk: ${modList}${extra}. Go to the Download tab to get them.`,
        });
      }
    } else {
      messages.push({
        t: "warn",
        m: "Download plan not built yet. Go to the Download tab and click \"Build Download Plan\" first to check which mods are on disk.",
      });
    }

    // 5. Check essential mods
    setCheckStep("Checking essential mods...");
    setCheckProgress(65);
    await new Promise((r) => setTimeout(r, 50));

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
    const modNames = allModNames;

    // 6. Fetch remote data if online
    setCheckStep("Fetching Forge data...");
    setCheckProgress(65);
    await new Promise((r) => setTimeout(r, 50));

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

    // 7. Check compat database
    setCheckStep("Checking compatibility...");
    setCheckProgress(75);
    await new Promise((r) => setTimeout(r, 50));

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

    // 8. Check engine resource limits (kits, spells per level)
    if (forgeOnline) {
      setCheckStep("Checking resource limits (kits, spells)...");
      setCheckProgress(82);
      await new Promise((r) => setTimeout(r, 50));

      try {
        // Build mod → components map from the import
        const modComponentMap = new Map<string, string[]>();
        for (const entry of [...(parsedLog.bgeeEntries || []), ...parsedLog.entries]) {
          const existing = modComponentMap.get(entry.mod_name) || [];
          existing.push(entry.component);
          modComponentMap.set(entry.mod_name, existing);
        }

        const resources = await fetchResourceUsage(baseUrl, modComponentMap);

        // Kit limit check
        const kitCheck = checkKitLimit(resources.totalKits);
        if (resources.totalKits > 0) {
          messages.push({ t: kitCheck.severity, m: kitCheck.message });
          if (resources.topKitMods.length > 0 && kitCheck.severity !== "ok") {
            const top = resources.topKitMods.map((m) => `${m.mod} (${m.count})`).join(", ");
            messages.push({ t: "info", m: `Top kit contributors: ${top}` });
          }
        } else {
          messages.push({ t: "info", m: "Kit data not available from Forge (pending deployment). Kit limit check skipped." });
        }

        // Spell level cap checks
        if (resources.spellWarnings.length > 0) {
          for (const w of resources.spellWarnings) {
            const sev = w.count >= w.cap ? "err" : "warn";
            messages.push({
              t: sev as "err" | "warn",
              m: `${w.type} level ${w.level}: ${w.count} new spells (engine cap: ${w.cap} per level). ${w.count >= w.cap ? "Spells will be silently dropped." : "Approaching the limit."}`,
            });
          }
        } else if (resources.totalSpells > 0) {
          messages.push({
            t: "ok",
            m: `Spells: ${resources.totalSpells} new spells added. No levels near the per-level cap of 50.`,
          });
        }
      } catch (e) {
        messages.push({ t: "warn", m: `Resource limit check failed: ${e}` });
      }
    }

    // 10. Platform checks
    setCheckProgress(95);
    const platform =
      typeof navigator !== "undefined" ? navigator.platform : "";
    const isWindows = platform.startsWith("Win");
    if (!isWindows) {
      messages.push({
        t: "info",
        m: `Running on ${platform} — ensure mod_installer and WeiDU are the correct platform builds`,
      });
    }

    // Done
    setCheckStep("Done");
    setCheckProgress(100);

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
  }, [parsedLog, config, forgeOnline, onResult, downloadReadiness]);

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

      {parsedLog && !running && (
        <button
          className="btn btn-primary"
          onClick={runChecks}
          style={{ marginBottom: 16 }}
        >
          {result
            ? "Re-run Pre-Flight Checks"
            : "Run Pre-Flight Checks"}
        </button>
      )}

      {running && (
        <div className="install-dashboard" style={{ textAlign: "center", padding: 24, marginBottom: 16 }}>
          <div style={{ color: "var(--gold)", fontWeight: 600, marginBottom: 8 }}>Running pre-flight checks...</div>
          <div style={{ color: "var(--txd)", fontSize: 12, marginBottom: 12 }}>{checkStep}</div>
          <div className="progress-bar" style={{ width: 320, height: 4, margin: "0 auto" }}>
            <div className="fill" style={{
              width: `${checkProgress}%`,
              transition: "width 0.3s ease",
            }} />
          </div>
        </div>
      )}

      {result && !running && (
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
              <div className="msg err" style={{ fontSize: 14, fontWeight: 600 }}>
                <div>BLOCKED — Fix errors before installing</div>
                <div style={{ fontSize: 11, fontWeight: 400, marginTop: 8 }}>
                  <label style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={result.passed}
                      onChange={(e) => {
                        if (e.target.checked) {
                          onResult({ ...result, passed: true });
                        }
                      }}
                    />
                    I understand the risks and want to proceed anyway
                  </label>
                </div>
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

      {/* ── Pre-Install Patches ── */}
      {config.mod_directory && config.bg2_game_dir && (
        <>
          <h3 style={{ marginTop: 24, borderTop: "1px solid var(--brd)", paddingTop: 16 }}>
            Pre-Install Patches
          </h3>
          <p style={{ color: "var(--txd)", marginBottom: 12, fontSize: 12 }}>
            Fixes known mod bugs in the Extracted source before mod_installer runs.
            Safe to apply multiple times.
          </p>

          {!patchesScanned && !patching && (
            <button className="btn btn-primary" onClick={runPatchScan} style={{ marginBottom: 12 }}>
              Scan for Patches
            </button>
          )}

          {patchScanning && (
            <div className="install-dashboard" style={{ textAlign: "center", padding: 16, marginBottom: 12 }}>
              <div style={{ color: "var(--gold)", fontSize: 12 }}>{patchStep}</div>
              <div className="progress-bar" style={{ width: 240, height: 4, margin: "8px auto 0" }}>
                <div className="fill" style={{ width: `${patchProgress}%`, transition: "width 0.3s ease" }} />
              </div>
            </div>
          )}

          {patchesScanned && (
            <>
              {/* Summary */}
              {(() => {
                const applicable = patches.filter((p) => p.status === "applicable").length;
                const already = patches.filter((p) => p.status === "already_patched").length;
                const notNeeded = patches.filter((p) => p.status === "not_needed").length;
                return (
                  <div style={{ fontSize: 12, color: "var(--txd)", marginBottom: 12 }}>
                    {applicable > 0 && <span style={{ color: "var(--blu)", marginRight: 12 }}>{applicable} ready to apply</span>}
                    {already > 0 && <span style={{ color: "var(--grn)", marginRight: 12 }}>{already} already patched</span>}
                    {notNeeded > 0 && <span>{notNeeded} not needed</span>}
                  </div>
                );
              })()}

              {/* Patch checklist */}
              <div style={{ maxHeight: 300, overflowY: "auto", marginBottom: 12 }}>
                {patches
                  .filter((p) => p.status !== "not_needed")
                  .map((p) => (
                    <div
                      key={p.id}
                      style={{
                        display: "flex", alignItems: "center", gap: 8,
                        padding: "4px 8px", fontSize: 12,
                        borderBottom: "1px solid var(--brd)",
                        opacity: p.status === "already_patched" ? 0.6 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={patchSelected.has(p.id)}
                        disabled={p.status === "already_patched" || patching}
                        onChange={() => togglePatch(p.id)}
                      />
                      <div style={{ flex: 1 }}>
                        <div style={{ color: "var(--gold)" }}>{p.name}</div>
                        <div style={{ color: "var(--txd)", fontSize: 10 }}>{p.description}</div>
                      </div>
                      <span style={{
                        fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 10,
                        background: p.status === "applicable" ? "var(--bg-info)" : "var(--bg-ok)",
                        color: p.status === "applicable" ? "var(--blu)" : "var(--grn)",
                      }}>
                        {p.status === "applicable" ? "Ready" : "Patched"}
                      </span>
                    </div>
                  ))}
              </div>

              {/* Apply button */}
              {patchSelected.size > 0 && !patching && (
                <button className="btn btn-primary" onClick={runPatchApply} style={{ marginBottom: 12 }}>
                  Apply Selected Patches ({patchSelected.size})
                </button>
              )}

              {/* Re-scan button */}
              {!patching && (
                <button className="btn" onClick={runPatchScan} style={{ marginLeft: patchSelected.size > 0 ? 8 : 0, marginBottom: 12 }}>
                  Re-scan
                </button>
              )}

              {/* Patching progress */}
              {patching && (
                <div className="install-dashboard" style={{ textAlign: "center", padding: 16, marginBottom: 12 }}>
                  <div style={{ color: "var(--gold)", fontWeight: 600, marginBottom: 8 }}>Applying patches...</div>
                  <div style={{ color: "var(--txd)", fontSize: 12 }}>{patchStep}</div>
                  <div className="progress-bar" style={{ width: 240, height: 4, margin: "8px auto 0" }}>
                    <div className="fill" style={{ width: `${patchProgress}%`, transition: "width 0.3s ease" }} />
                  </div>
                </div>
              )}

              {/* Results */}
              {patchResults.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  {patchResults.map((r) => (
                    <div key={r.id} className={`msg ${r.status === "applied" ? "ok" : r.status === "already_patched" ? "info" : "err"}`}
                      style={{ fontSize: 12, marginBottom: 4 }}>
                      {r.status === "applied" ? "✅" : r.status === "already_patched" ? "✅" : "❌"} {r.name}
                      {r.status === "applied" && " — Applied"}
                      {r.status === "already_patched" && " — Already patched"}
                      {r.status === "failed" && ` — Failed: ${r.error || "unknown error"}`}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

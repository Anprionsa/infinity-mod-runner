import { useState, useCallback, useEffect } from "react";
import type { AppConfig, ParsedLog, LogEntry } from "../App";
import { pickFile, readFileContents } from "../lib/tauri-bridge";
import { buildParsedLog, parseWeiduLog } from "../lib/log-parser";
import ResizablePanel from "./ResizablePanel";

interface Props {
  config: AppConfig;
  parsedLog: ParsedLog | null;
  onImport: (log: ParsedLog) => void;
  onSaveConfig: (config: AppConfig) => void;
}

/** Check if entries look like they're in the wrong slot. */
function validateLogSlot(
  entries: LogEntry[],
  slot: "eet" | "bgee",
): string | null {
  const modNames = new Set(entries.map((e) => e.mod_name));
  const hasEet = modNames.has("eet");
  const hasEetEnd = modNames.has("eet_end");
  const hasEeFixpack = modNames.has("eefixpack") || modNames.has("ee_fixpack");

  if (slot === "bgee") {
    // BGEE slot should NOT have EET core or EET_End
    if (hasEet || hasEetEnd) {
      return "This looks like the main EET log (contains EET core). Did you mean to put this in the BG2:EE / EET slot instead?";
    }
    // BGEE log with lots of entries is suspicious
    if (entries.length > 20) {
      return `This log has ${entries.length} entries — BGEE logs typically have very few (just EE Fixpack and similar). Are you sure this isn't the main EET log?`;
    }
  }

  if (slot === "eet") {
    // EET slot should have EET core for a proper EET install
    if (!hasEet && entries.length > 0) {
      if (hasEeFixpack && entries.length < 10) {
        return "This looks like the BGEE log (no EET core, only a few BG1 mods). Did you mean to put this in the BG1:EE slot instead?";
      }
      // Not necessarily wrong — could be a non-EET install, just warn
      return "EET core mod not found in this log. For EET installs, the main WeiDU.log should contain the EET mod.";
    }
  }

  return null;
}

export default function ImportPanel({ config, parsedLog, onImport, onSaveConfig }: Props) {
  const [loading, setLoading] = useState<"eet" | "bgee" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slotWarning, setSlotWarning] = useState<{
    eet: string | null;
    bgee: string | null;
  }>({ eet: null, bgee: null });
  const [modListHeight, setModListHeight] = useState(300);

  // Auto-load from saved config paths on mount (if no log loaded yet)
  useEffect(() => {
    if (parsedLog) return; // Already loaded
    const loadSaved = async () => {
      let eetRaw: string | null = null;
      let bgeeRaw: string | null = null;
      try {
        if (config.eet_log_path) eetRaw = await readFileContents(config.eet_log_path);
      } catch { /* file may have moved */ }
      try {
        if (config.bgee_log_path) bgeeRaw = await readFileContents(config.bgee_log_path);
      } catch { /* file may have moved */ }

      if (eetRaw || bgeeRaw) {
        const parsed = buildParsedLog(
          eetRaw || "",
          bgeeRaw || null,
          config.eet_log_path,
          config.bgee_log_path,
        );
        if (parsed.entries.length > 0 || (parsed.bgeeEntries && parsed.bgeeEntries.length > 0)) {
          onImport(parsed);
        }
      }
    };
    loadSaved();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const importLog = useCallback(
    async (type: "eet" | "bgee") => {
      const title =
        type === "eet" ? "Select WeiDU.log" : "Select WeiDU-BGEE.log";
      const path = await pickFile(title, [
        { name: "WeiDU Log", extensions: ["log", "LOG"] },
      ]);
      if (!path) return;

      setLoading(type);
      setError(null);
      try {
        const raw = await readFileContents(path);
        const entries = parseWeiduLog(raw);

        // Validate the log is in the right slot
        const warning = validateLogSlot(entries, type);
        setSlotWarning((prev) => ({ ...prev, [type]: warning }));

        // Also check filename as a hint
        const filename = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() || "";
        if (type === "eet" && filename.includes("bgee")) {
          setSlotWarning((prev) => ({
            ...prev,
            eet: (prev.eet ? prev.eet + " " : "") +
              `Filename "${filename}" suggests this is a BGEE log.`,
          }));
        }
        if (type === "bgee" && !filename.includes("bgee") && filename === "weidu.log") {
          setSlotWarning((prev) => ({
            ...prev,
            bgee: (prev.bgee ? prev.bgee + " " : "") +
              `Filename "WeiDU.log" is typically the main EET log, not the BGEE log.`,
          }));
        }

        let parsed: ParsedLog;
        if (type === "eet") {
          parsed = buildParsedLog(raw, parsedLog?.bgeeRaw, path, parsedLog?.bgeeLogPath);
        } else {
          parsed = buildParsedLog(parsedLog?.raw || "", raw, parsedLog?.eetLogPath, path);
        }

        if (type === "eet" && parsed.entries.length === 0) {
          setError(
            "No valid entries found. Expected format: ~mod\\file.tp2~ #lang #comp // name",
          );
          return;
        }

        onImport(parsed);

        // Persist log path to config so it's remembered across sessions
        if (type === "eet") {
          onSaveConfig({ ...config, eet_log_path: path });
        } else {
          onSaveConfig({ ...config, bgee_log_path: path });
        }
      } catch (e) {
        setError(`Failed to read file: ${e}`);
      } finally {
        setLoading(null);
      }
    },
    [onImport, onSaveConfig, config, parsedLog?.bgeeRaw, parsedLog?.raw],
  );

  const eetLoaded = !!parsedLog && parsedLog.entries.length > 0;
  const bgeeLoaded = !!parsedLog?.bgeeEntries && parsedLog.bgeeEntries.length > 0;

  // Group entries by mod+source for display.
  // Dual-install mods (e.g., eefixpack) get TWO entries: one BGEE, one EET.
  type TaggedEntry = LogEntry & { source: "eet" | "bgee" };
  const bgeeEntries: TaggedEntry[] = [];
  const eetEntries: TaggedEntry[] = [];
  if (parsedLog) {
    parsedLog.bgeeEntries?.forEach((e) => bgeeEntries.push({ ...e, source: "bgee" }));
    parsedLog.entries.forEach((e) => eetEntries.push({ ...e, source: "eet" }));
  }

  // Build groups keyed by "modname|source" to keep BGEE and EET entries separate
  function groupByMod(entries: TaggedEntry[]): [string, TaggedEntry[]][] {
    const map: Record<string, TaggedEntry[]> = {};
    for (const e of entries) {
      if (!map[e.mod_name]) map[e.mod_name] = [];
      map[e.mod_name].push(e);
    }
    // Preserve log order (Object.entries keeps insertion order)
    return Object.entries(map);
  }

  const bgeeGroups = groupByMod(bgeeEntries);
  const eetGroups = groupByMod(eetEntries);
  // BGEE mods first (install order), then EET mods
  const modGroups = [...bgeeGroups, ...eetGroups];
  const allEntries = [...bgeeEntries, ...eetEntries];

  return (
    <div>
      <h2>Import Forge Export</h2>
      <p style={{ color: "var(--txd)", marginBottom: 20, fontSize: 13 }}>
        EET installs require two log files exported from EET Mod Forge. Both are
        needed before installation can begin.
      </p>

      {/* Two side-by-side drop zones — BG1 first (install order) */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <div
          className={`drop-zone ${bgeeLoaded ? "loaded" : ""}`}
          onClick={() => importLog("bgee")}
          style={bgeeLoaded ? {
            borderColor: "var(--grn)",
            borderStyle: "solid",
            background: "rgba(74, 222, 128, 0.03)",
          } : undefined}
        >
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.5px", color: "var(--gold)", marginBottom: 8, fontWeight: 600 }}>
            BG1:EE Phase
          </div>
          {!bgeeLoaded ? (
            <>
              <div className="icon">{loading === "bgee" ? "..." : "\u2B07"}</div>
              <div>WeiDU-BGEE.log</div>
              <div style={{ fontSize: 11, marginTop: 4, color: "var(--txd)" }}>
                BG1 mods (EE Fixpack, etc.)
              </div>
            </>
          ) : (
            <>
              <div style={{ color: "var(--grn)", fontSize: 24, marginBottom: 4 }}>
                {parsedLog!.bgeeEntries!.length}
              </div>
              <div style={{ fontSize: 12 }}>components loaded</div>
              <div style={{ fontSize: 11, color: "var(--txd)", marginTop: 4 }}>
                Click to re-import
              </div>
            </>
          )}
        </div>

        <div
          className={`drop-zone ${eetLoaded ? "loaded" : ""}`}
          onClick={() => importLog("eet")}
          style={eetLoaded ? {
            borderColor: "var(--grn)",
            borderStyle: "solid",
            background: "rgba(74, 222, 128, 0.03)",
          } : undefined}
        >
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.5px", color: "var(--gold)", marginBottom: 8, fontWeight: 600 }}>
            BG2:EE / EET Phase
          </div>
          {!eetLoaded ? (
            <>
              <div className="icon">{loading === "eet" ? "..." : "\u2B07"}</div>
              <div>WeiDU.log</div>
              <div style={{ fontSize: 11, marginTop: 4, color: "var(--txd)" }}>
                Main install log (most mods)
              </div>
            </>
          ) : (
            <>
              <div style={{ color: "var(--grn)", fontSize: 24, marginBottom: 4 }}>
                {parsedLog!.entries.length}
              </div>
              <div style={{ fontSize: 12 }}>components loaded</div>
              <div style={{ fontSize: 11, color: "var(--txd)", marginTop: 4 }}>
                Click to re-import
              </div>
            </>
          )}
        </div>
      </div>

      {slotWarning.bgee && (
        <div className="msg warn" style={{ fontSize: 12 }}>
          <strong>BG1:EE log:</strong> {slotWarning.bgee}
        </div>
      )}

      {slotWarning.eet && (
        <div className="msg warn" style={{ fontSize: 12 }}>
          <strong>BG2:EE / EET log:</strong> {slotWarning.eet}
        </div>
      )}

      {!bgeeLoaded && eetLoaded && (
        <div className="msg warn">
          WeiDU-BGEE.log not imported yet. EET installs typically need both logs.
          If your Forge export only produced one log, you can skip this.
        </div>
      )}

      {error && <div className="msg err">{error}</div>}

      {parsedLog && (eetLoaded || bgeeLoaded) && (
        <>
          <div className="summary-grid">
            <div className="summary-card">
              <div className="number">{parsedLog.modCount}</div>
              <div className="label">Total Mods</div>
            </div>
            <div className="summary-card">
              <div className="number">{parsedLog.componentCount}</div>
              <div className="label">Total Components</div>
            </div>
            <div className="summary-card">
              <div className="number">{parsedLog.entries.length}</div>
              <div className="label">EET Log</div>
            </div>
            <div className="summary-card">
              <div className="number">
                {parsedLog.bgeeEntries?.length || 0}
              </div>
              <div className="label">BGEE Log</div>
            </div>
          </div>

          <h3>
            Mod List ({modGroups.length} mods, {allEntries.length}{" "}
            components)
          </h3>
          <ResizablePanel height={modListHeight} onHeightChange={setModListHeight} minHeight={100} maxHeight={600} className="log-output" style={{ fontSize: 11 }}>
            {modGroups.map(([mod, entries], groupIdx) => {
              const source = entries[0]?.source;
              return (
                <div key={`${mod}-${source}-${groupIdx}`} style={{ marginBottom: 4 }}>
                  <span style={{ color: "var(--gold)" }}>{mod}</span>
                  <span style={{ color: "var(--txd)" }}>
                    {" "}
                    ({entries.length} component
                    {entries.length !== 1 ? "s" : ""})
                  </span>
                  {source === "bgee" && (
                    <span style={{ color: "var(--cyn)", fontSize: 10, marginLeft: 6 }}>
                      BGEE
                    </span>
                  )}
                  {source === "eet" && (
                    <span style={{ color: "var(--pur)", fontSize: 10, marginLeft: 6 }}>
                      EET
                    </span>
                  )}
                  {entries.map((e, i) => (
                    <div
                      key={i}
                      style={{ paddingLeft: 16, color: "var(--txd)" }}
                    >
                      #{e.component} {e.component_name}
                      {e.version && (
                        <span style={{ opacity: 0.6 }}>
                          {" "}
                          v{e.version}
                        </span>
                      )}
                      {source === "bgee" && (
                        <span style={{ color: "var(--cyn)", fontSize: 9, marginLeft: 4, opacity: 0.7 }}>
                          BG1
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </ResizablePanel>
        </>
      )}
    </div>
  );
}

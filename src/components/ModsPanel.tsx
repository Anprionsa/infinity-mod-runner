import { useState, useMemo, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import PresetBrowser from "./PresetBrowser";
import { DEFAULT_FORGE_URL } from "../App";
import type { AppConfig, ParsedLog, LogEntry, ExcludeKey, PausePoint, DownloadReadiness, InstallStatusMap } from "../App";
import { pickFile, readFileContents } from "../lib/tauri-bridge";
import { buildParsedLog, parseWeiduLog } from "../lib/log-parser";
import { fetchModIndex, type ModIndexEntry } from "../lib/forge-data";
import { guiLog } from "../lib/gui-logger";
import { useI18n } from "../lib/i18n";

interface Props {
  config: AppConfig;
  parsedLog: ParsedLog | null;
  onImport: (log: ParsedLog) => void;
  onSaveConfig: (config: AppConfig) => void;
  excludedComponents: Set<ExcludeKey>;
  onExcludedChange: (excluded: Set<ExcludeKey>) => void;
  pausePoints: PausePoint[];
  onPausePointsChange: (points: PausePoint[]) => void;
  forgeOnline: boolean | null;
  onReadinessChange?: (readiness: DownloadReadiness) => void;
  installRunning?: boolean;
  installStatus?: InstallStatusMap;
}

function makeKey(entry: LogEntry): ExcludeKey {
  return `${entry.mod_name}:${entry.component}`;
}

// ─── Enrichment types ───

interface ComponentInfo { cn: number; name: string; description: string }

interface ModEnrichment {
  displayName: string;
  author: string;
  category: string;
  url: string;
  components: Map<number, ComponentInfo>;
}

interface ModGroup {
  modName: string;
  entries: LogEntry[];
  firstIndex: number;
  category: string;
  onDisk: boolean;
}

interface CategorySection {
  name: string;
  groups: ModGroup[];
}

function groupByMod(entries: LogEntry[], enrichment: Map<string, ModEnrichment>, modExistence?: Map<string, boolean>): ModGroup[] {
  const groups: ModGroup[] = [];
  const map = new Map<string, ModGroup>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    let group = map.get(e.mod_name);
    if (!group) {
      const info = enrichment.get(e.mod_name);
      group = {
        modName: e.mod_name, entries: [], firstIndex: i,
        category: info?.category || "OTHER",
        onDisk: modExistence ? (modExistence.get(e.mod_name) ?? true) : true,
      };
      map.set(e.mod_name, group);
      groups.push(group);
    }
    group.entries.push(e);
  }
  return groups;
}

/** Defined category install order — matches Forge's categories.json */
const CATEGORY_DISPLAY_ORDER: string[] = [
  "PRE EET BGEE MODS", "EET STARTS HERE", "ENGINE", "INTERFACE",
  "GRAPHICAL AND SOUND OVERWRITE MODS", "RESTORATIONS",
  "QUEST MODS BG1", "QUEST MODS BG2", "QUEST MODS ToB",
  "NEW NPC MODS", "NPC EXPANSIONS", "NPC CROSSMOD", "CREATURE MODS",
  "ITEM ADDITION MODS", "SPELL MODS", "KIT & CLASS MODS",
  "PRE-TACTICAL TWEAKS", "TACTICAL MODS", "POST-TACTICAL TWEAKS",
  "NPC CUSTOMIZATION", "POST-TACTICAL QUESTS",
  "MUSIC & AUDIO", "PORTRAITS", "EET FINALIZATION", "POST EET",
];
const CATEGORY_ORDER_MAP = new Map(CATEGORY_DISPLAY_ORDER.map((c, i) => [c, i]));

function groupByCategory(groups: ModGroup[]): CategorySection[] {
  const map = new Map<string, CategorySection>();
  for (const g of groups) {
    let section = map.get(g.category);
    if (!section) {
      section = { name: g.category, groups: [] };
      map.set(g.category, section);
    }
    section.groups.push(g);
  }
  // Sort by defined category order
  const sections = [...map.values()];
  sections.sort((a, b) => {
    const ai = CATEGORY_ORDER_MAP.get(a.name) ?? 999;
    const bi = CATEGORY_ORDER_MAP.get(b.name) ?? 999;
    return ai - bi;
  });
  return sections;
}

// ─── Main Component ───

export default function ModsPanel({
  config, parsedLog, onImport, onSaveConfig,
  excludedComponents, onExcludedChange,
  pausePoints, onPausePointsChange,
  forgeOnline, onReadinessChange,
  installRunning, installStatus,
}: Props) {
  const { t } = useI18n();
  const locked = !!installRunning;
  // ── Import state ──
  const [importLoading, setImportLoading] = useState<"eet" | "bgee" | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // ── Enrichment state ──
  const [enrichment, setEnrichment] = useState<Map<string, ModEnrichment>>(new Map());
  const [enrichmentLoaded, setEnrichmentLoaded] = useState(false);
  const [enrichmentStep, setEnrichmentStep] = useState("");

  // ── Preset browser state ──
  const [presetBrowserOpen, setPresetBrowserOpen] = useState(false);

  // ── UI state ──
  const [expandedMods, setExpandedMods] = useState<Set<string>>(new Set());
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [filterMode, setFilterMode] = useState<"all" | "disabled" | "enabled">("all");

  // ── Mod existence check (are mods on disk?) ──
  const [modExistence, setModExistence] = useState<Map<string, boolean>>(new Map());

  // Check mod existence after parsedLog changes
  useEffect(() => {
    if (!parsedLog || !config.mod_directory || !config.bg2_game_dir) return;
    const allEntries = [...(parsedLog.bgeeEntries || []), ...parsedLog.entries];
    const tp2Paths = [...new Set(allEntries.map((e) => `${e.mod_name}/${e.tp_file}`))];
    if (tp2Paths.length === 0) return;

    invoke<Record<string, boolean>>("batch_check_mods_exist", {
      modDir: config.mod_directory,
      gameDir: config.bg2_game_dir,
      tp2Paths,
    }).then((existsMap) => {
      const map = new Map<string, boolean>();
      for (const entry of allEntries) {
        const key = `${entry.mod_name}/${entry.tp_file}`;
        map.set(entry.mod_name, existsMap[key] ?? false);
      }
      setModExistence(map);
    }).catch(() => {});
  }, [parsedLog, config.mod_directory, config.bg2_game_dir]);

  // ── Preset load handler ──
  const handlePresetLoad = useCallback((preset: ParsedLog, mode: "replace" | "merge") => {
    if (mode === "replace" || !parsedLog) {
      onImport(preset);
    } else {
      // Merge: append new entries from preset, dedup by tp_file+component
      const existing = new Set(
        [...parsedLog.entries, ...(parsedLog.bgeeEntries || [])].map(e => `${e.tp_file}:${e.component}`)
      );
      // Filter preset raw lines to only include new (non-duplicate) entries
      const filterNewLines = (rawText: string) => {
        return rawText.split("\n").filter(line => {
          if (!line.startsWith("~")) return false; // keep only log lines
          const match = line.match(/^~([^~]+)~\s+#\d+\s+#(\d+)/);
          if (!match) return false;
          const parts = match[1].replace(/\\/g, "/").split("/");
          const tp = parts[parts.length - 1];
          return !existing.has(`${tp}:${match[2]}`);
        }).join("\n");
      };
      const newEetRaw = filterNewLines(preset.raw);
      const newBgeeRaw = preset.bgeeRaw ? filterNewLines(preset.bgeeRaw) : null;

      const mergedEetRaw = newEetRaw ? parsedLog.raw + "\n" + newEetRaw : parsedLog.raw;
      const mergedBgeeRaw = newBgeeRaw
        ? (parsedLog.bgeeRaw || "") + "\n" + newBgeeRaw
        : parsedLog.bgeeRaw;

      const merged = buildParsedLog(mergedEetRaw, mergedBgeeRaw, parsedLog.eetLogPath, parsedLog.bgeeLogPath);
      onImport(merged);
    }
    setPresetBrowserOpen(false);
  }, [parsedLog, onImport]);

  // ── Import handlers ──
  const importLog = useCallback(async (type: "eet" | "bgee") => {
    const title = type === "eet" ? "Select WeiDU.log (EET)" : "Select WeiDU-BGEE.log";
    const path = await pickFile(title, [
      { name: "WeiDU Log", extensions: ["log", "LOG"] },
    ]);
    if (!path) return;
    setImportLoading(type);
    setImportError(null);
    try {
      const raw = await readFileContents(path);
      const entries = parseWeiduLog(raw);
      if (type === "eet" && entries.length === 0) {
        setImportError("No valid entries found in the log file.");
        return;
      }
      let parsed: ParsedLog;
      if (type === "eet") {
        parsed = buildParsedLog(raw, parsedLog?.bgeeRaw, path, parsedLog?.bgeeLogPath);
      } else {
        parsed = buildParsedLog(parsedLog?.raw || "", raw, parsedLog?.eetLogPath, path);
      }
      guiLog.info("IMPORT", `Loaded ${type.toUpperCase()} log: ${parsed.modCount} mods, ${parsed.componentCount} components from ${path}`);
      onImport(parsed);
      if (type === "eet") onSaveConfig({ ...config, eet_log_path: path });
      else onSaveConfig({ ...config, bgee_log_path: path });
    } catch (e) {
      setImportError(`Failed to read file: ${e}`);
    } finally {
      setImportLoading(null);
    }
  }, [onImport, onSaveConfig, config, parsedLog]);

  // ── Enrichment fetch ──
  const loadEnrichment = useCallback(async () => {
    if (!forgeOnline || !parsedLog) return;
    const baseUrl = config.forge_data_url || DEFAULT_FORGE_URL;
    setEnrichmentStep("Loading mod data from Forge...");
    try {
      const modIndex = await fetchModIndex(baseUrl);
      const indexArr = Array.isArray(modIndex) ? modIndex : Object.values(modIndex);
      const map = new Map<string, ModEnrichment>();

      // Fetch catalog for detail files
      let catalog: Record<string, string> = {};
      try {
        const catResp = await fetch(`${baseUrl}/data/mods/_catalog.json`);
        if (catResp.ok) catalog = await catResp.json();
      } catch { /* optional */ }

      const nameToModId = new Map<string, string>();

      for (const entry of indexArr) {
        const e = entry as ModIndexEntry & Record<string, unknown>;
        const tp2Name = ((e.t || "") as string).toLowerCase();
        const modId = String((e as { i?: number }).i || "");
        if (!tp2Name) continue;

        const enrichData: ModEnrichment = {
          displayName: (e.n || e.t || "") as string,
          author: (e.a || "") as string,
          category: (e.c || "") as string,
          url: (e.u || "") as string,
          components: new Map(),
        };
        map.set(tp2Name, enrichData);
        nameToModId.set(tp2Name, modId);

        // Also index by coWF (WeiDU folder names that match log mod_name)
        const coWF = ((e.coWF || []) as (string | null)[]).filter((v): v is string => v != null);
        const seen = new Set<string>([tp2Name]);
        for (const wf of coWF) {
          const wfLower = wf.toLowerCase();
          if (!seen.has(wfLower)) {
            seen.add(wfLower);
            map.set(wfLower, enrichData);
            nameToModId.set(wfLower, modId);
          }
        }
      }

      // Fetch per-mod detail files for component names (batched)
      const modsInInstall = new Set<string>();
      for (const e of [...(parsedLog.bgeeEntries || []), ...parsedLog.entries]) {
        modsInInstall.add(e.mod_name);
      }

      const toFetch: { tp2: string; file: string }[] = [];
      const fetchedIds = new Set<string>();
      for (const tp2 of modsInInstall) {
        const modId = nameToModId.get(tp2);
        if (modId && catalog[modId] && !fetchedIds.has(modId)) {
          fetchedIds.add(modId);
          toFetch.push({ tp2, file: catalog[modId] });
        }
      }

      const BATCH = 20;
      for (let i = 0; i < toFetch.length; i += BATCH) {
        const batch = toFetch.slice(i, i + BATCH);
        setEnrichmentStep(`Loading component details (${Math.min(i + BATCH, toFetch.length)}/${toFetch.length})...`);
        const results = await Promise.allSettled(
          batch.map(async ({ tp2, file }) => {
            const resp = await fetch(`${baseUrl}/data/mods/${encodeURIComponent(file)}`);
            if (!resp.ok) return null;
            return { tp2, data: await resp.json() };
          }),
        );
        for (const r of results) {
          if (r.status !== "fulfilled" || !r.value) continue;
          const { tp2, data } = r.value;
          const existing = map.get(tp2);
          if (!existing) continue;
          const co = (data.co || []) as { cn?: number; n?: string; no?: string }[];
          for (const comp of co) {
            if (comp.cn !== undefined) {
              existing.components.set(comp.cn, { cn: comp.cn, name: comp.n || "", description: comp.no || "" });
            }
          }
        }
      }

      setEnrichment(map);
      setEnrichmentLoaded(true);
      setEnrichmentStep("");
      guiLog.info("UI", `Enrichment loaded: ${map.size} entries from Forge`);
    } catch (e) {
      setEnrichmentStep(`Failed: ${e}`);
      guiLog.error("UI", `Enrichment failed: ${e}`);
    }
  }, [forgeOnline, parsedLog, config.forge_data_url]);

  // Auto-fetch enrichment
  useEffect(() => {
    if (forgeOnline && parsedLog && !enrichmentLoaded) {
      loadEnrichment();
    }
  }, [forgeOnline, parsedLog, enrichmentLoaded, loadEnrichment]);

  // ── Grouped data ──
  const bgeeGroups = useMemo(() => groupByMod(parsedLog?.bgeeEntries || [], enrichment, modExistence), [parsedLog?.bgeeEntries, enrichment, modExistence]);
  const eetGroups = useMemo(() => groupByMod(parsedLog?.entries || [], enrichment, modExistence), [parsedLog?.entries, enrichment, modExistence]);

  const totalComponents = (parsedLog?.bgeeEntries?.length || 0) + (parsedLog?.entries?.length || 0);
  const excludedCount = excludedComponents.size;
  const enabledCount = totalComponents - excludedCount;

  // ── Report readiness ──
  useEffect(() => {
    if (!onReadinessChange || !parsedLog) return;
    const allGroups = [...bgeeGroups, ...eetGroups];
    const missing = allGroups.filter((g) => !g.onDisk).map((g) => {
      const info = enrichment.get(g.modName);
      return info?.displayName || g.modName;
    });
    onReadinessChange({
      totalMods: allGroups.length,
      alreadyHave: allGroups.length - missing.length,
      missingNames: missing,
      builtAt: Date.now(),
    });
  }, [bgeeGroups, eetGroups, enrichment, onReadinessChange, parsedLog]);

  // ── Mod list interactions ──
  const toggleComponent = useCallback((entry: LogEntry) => {
    const key = makeKey(entry);
    const next = new Set(excludedComponents);
    if (next.has(key)) next.delete(key); else next.add(key);
    onExcludedChange(next);
  }, [excludedComponents, onExcludedChange]);

  const toggleMod = useCallback((group: ModGroup) => {
    const keys = group.entries.map(makeKey);
    const allExcluded = keys.every((k) => excludedComponents.has(k));
    const next = new Set(excludedComponents);
    if (allExcluded) keys.forEach((k) => next.delete(k));
    else keys.forEach((k) => next.add(k));
    onExcludedChange(next);
  }, [excludedComponents, onExcludedChange]);

  const toggleExpand = useCallback((modName: string) => {
    setExpandedMods((prev) => {
      const next = new Set(prev);
      if (next.has(modName)) next.delete(modName); else next.add(modName);
      return next;
    });
  }, []);

  const toggleCategory = useCallback((name: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  const expandCategories = useCallback(() => {
    setCollapsedCategories(new Set());
  }, []);

  const collapseCategories = useCallback(() => {
    const allCats = new Set<string>();
    for (const g of [...bgeeGroups, ...eetGroups]) allCats.add(g.category);
    setCollapsedCategories(allCats);
  }, [bgeeGroups, eetGroups]);

  const expandAll = useCallback(() => {
    setExpandedMods(new Set([...bgeeGroups, ...eetGroups].map((g) => g.modName)));
    setCollapsedCategories(new Set());
  }, [bgeeGroups, eetGroups]);

  const collapseAll = useCallback(() => {
    setExpandedMods(new Set());
    const allCats = new Set<string>();
    for (const g of [...bgeeGroups, ...eetGroups]) allCats.add(g.category);
    setCollapsedCategories(allCats);
  }, [bgeeGroups, eetGroups]);

  const togglePause = useCallback((globalIdx: number, phase: "bgee" | "eet") => {
    const existing = pausePoints.find((p) => p.afterModIndex === globalIdx && p.phase === phase);
    if (existing) {
      onPausePointsChange(pausePoints.filter((p) => !(p.afterModIndex === globalIdx && p.phase === phase)));
    } else {
      onPausePointsChange([...pausePoints, { afterModIndex: globalIdx, message: "", phase }]);
    }
  }, [pausePoints, onPausePointsChange]);

  const updatePauseMessage = useCallback((globalIdx: number, phase: "bgee" | "eet", message: string) => {
    onPausePointsChange(
      pausePoints.map((p) =>
        p.afterModIndex === globalIdx && p.phase === phase ? { ...p, message } : p,
      ),
    );
  }, [pausePoints, onPausePointsChange]);

  // Per-mod download (used when download buttons are added per-mod)
  // const downloadSingleMod = useCallback(...);

  // ── Filter ──
  const filterGroups = useCallback((groups: ModGroup[]) => {
    return groups.filter((group) => {
      if (search) {
        const q = search.toLowerCase();
        const info = enrichment.get(group.modName);
        const searchable = [group.modName, info?.displayName || "", info?.author || "",
          ...group.entries.map((e) => e.component_name)].join(" ").toLowerCase();
        if (!searchable.includes(q)) return false;
      }
      if (filterMode === "disabled") return group.entries.some((e) => excludedComponents.has(makeKey(e)));
      if (filterMode === "enabled") return group.entries.some((e) => !excludedComponents.has(makeKey(e)));
      return true;
    });
  }, [search, filterMode, enrichment, excludedComponents]);

  // ── Render ──
  const eetLoaded = !!parsedLog && parsedLog.entries.length > 0;
  const bgeeLoaded = !!parsedLog?.bgeeEntries && parsedLog.bgeeEntries.length > 0;

  return (
    <div>
      <h2>{t("mods.heading", "Mods")}</h2>

      {locked && (
        <div style={{
          textAlign: "center", padding: "8px 0", marginBottom: 16, borderRadius: 6,
          background: "linear-gradient(90deg, transparent, rgba(255,180,40,0.12), transparent)",
          borderTop: "1px solid rgba(255,180,40,0.3)", borderBottom: "1px solid rgba(255,180,40,0.3)",
          fontSize: 12, fontWeight: 600, color: "var(--gold)",
        }}>
          {t("mods.locked", "Install in progress — mod list is locked")}
        </div>
      )}

      {/* ── Import bar ── */}
      <div style={locked ? { pointerEvents: "none", opacity: 0.5 } : undefined}>
      <p style={{ color: "var(--txd)", marginBottom: 8, fontSize: 12 }}>
        {t("mods.import_desc", "Import the WeiDU.log files exported from EET Mod Forge. The EET log is required. The BG1:EE log is optional (only needed if your install has a BG1 phase).")}
      </p>
      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 10, color: "var(--txd)", width: 80, textTransform: "uppercase" }}>{t("mods.eet_log", "EET Log")}</span>
            <button className="btn" style={{ fontSize: 11, padding: "3px 10px" }}
              onClick={() => importLog("eet")} disabled={importLoading !== null}>
              {importLoading === "eet" ? t("btn.loading", "Loading...") : t("btn.browse", "Browse")}
            </button>
            {eetLoaded ? (
              <span style={{ fontSize: 11, color: "var(--grn)" }}>
                {parsedLog!.entries.length} {t("mods.components_loaded", "components loaded")}
              </span>
            ) : (
              <span style={{ fontSize: 11, color: "var(--txd)" }}>{t("mods.not_loaded", "Not loaded")}</span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10, color: "var(--txd)", width: 80, textTransform: "uppercase" }}>{t("mods.bgee_log", "BG1:EE Log")}</span>
            <button className="btn" style={{ fontSize: 11, padding: "3px 10px" }}
              onClick={() => importLog("bgee")} disabled={importLoading !== null}>
              {importLoading === "bgee" ? t("btn.loading", "Loading...") : t("btn.browse", "Browse")}
            </button>
            {bgeeLoaded ? (
              <span style={{ fontSize: 11, color: "var(--grn)" }}>
                {parsedLog!.bgeeEntries!.length} {t("mods.components_loaded", "components loaded")}
              </span>
            ) : (
              <span style={{ fontSize: 11, color: "var(--txd)" }}>{t("mods.not_loaded_optional", "Not loaded (optional)")}</span>
            )}
          </div>
        </div>
        {/* Browse Presets button */}
        <button className="btn" onClick={() => setPresetBrowserOpen(true)}
          disabled={!forgeOnline}
          title={forgeOnline ? "Browse presets and community builds from Forge" : "Forge data not available"}
          style={{ alignSelf: "center", fontSize: 11, padding: "6px 14px", whiteSpace: "nowrap" }}>
          {t("mods.browse_presets", "Browse Presets")}
        </button>
      </div>
      {importError && <div className="msg err" style={{ marginBottom: 8, fontSize: 12 }}>{importError}</div>}
      {enrichmentStep && <div style={{ fontSize: 11, color: "var(--txd)", marginBottom: 8 }}>{enrichmentStep}</div>}
      </div>{/* end import lock wrapper */}

      {!parsedLog && (
        <div className="msg warn">{t("mods.import_first", "Import WeiDU logs above to see your mod list.")}</div>
      )}

      {parsedLog && (
        <>
          {/* ── Preset source banner ── */}
          {parsedLog.presetSource && (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              padding: "6px 12px", marginBottom: 8, borderRadius: 6,
              background: "linear-gradient(90deg, transparent, rgba(160,120,255,0.1), transparent)",
              borderTop: "1px solid rgba(160,120,255,0.25)", borderBottom: "1px solid rgba(160,120,255,0.25)",
              fontSize: 12, color: "var(--tx)",
            }}>
              <span style={{ color: "rgba(160,120,255,0.8)", fontWeight: 600 }}>
                {parsedLog.presetSource.type === "build" ? t("mods.build_label", "Community Build:") : t("mods.preset_label", "Preset:")}
              </span>
              <span style={{ fontWeight: 500 }}>{parsedLog.presetSource.name}</span>
              <span style={{ color: "var(--txd)", fontSize: 11 }}>
                ({parsedLog.presetSource.componentCount} components)
              </span>
              {excludedComponents.size > 0 && (
                <span style={{ color: "var(--org)", fontSize: 11, fontStyle: "italic" }}>
                  {t("mods.modified", "— modified")}
                </span>
              )}
            </div>
          )}

          {/* ── Summary + controls ── */}
          <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 8, fontSize: 12 }}>
            <span style={{ color: "var(--goldb)", fontWeight: 600 }}>
              {bgeeGroups.length + eetGroups.length} mods, {enabledCount} components
            </span>
            {excludedCount > 0 && <span style={{ color: "var(--red)" }}>{excludedCount} excluded</span>}
            {pausePoints.length > 0 && (
              <span style={{ color: "var(--cyn)" }}>{pausePoints.length} pause{pausePoints.length > 1 ? "s" : ""}</span>
            )}
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button className="btn" onClick={expandCategories} style={{ fontSize: 10, padding: "2px 8px" }} title="Show all category sections">{t("mods.show_categories", "Show Categories")}</button>
              <button className="btn" onClick={collapseCategories} style={{ fontSize: 10, padding: "2px 8px" }} title="Hide all category sections">{t("mods.hide_categories", "Hide Categories")}</button>
              <button className="btn" onClick={expandAll} style={{ fontSize: 10, padding: "2px 8px" }} title="Expand everything including mod components">{t("mods.expand_all", "Expand All")}</button>
              <button className="btn" onClick={collapseAll} style={{ fontSize: 10, padding: "2px 8px" }} title="Collapse everything">{t("mods.collapse_all", "Collapse All")}</button>
            </div>
          </div>

          {/* ── Search + filter ── */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input type="text" placeholder={t("mods.search", "Search mods...")} value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: 1, background: "var(--bg2)", border: "1px solid var(--brd)", color: "var(--tx)", padding: "6px 10px", borderRadius: 4, fontSize: 12, outline: "none" }}
            />
            <select value={filterMode} onChange={(e) => setFilterMode(e.target.value as typeof filterMode)}
              style={{ background: "var(--bg2)", border: "1px solid var(--brd)", color: "var(--tx)", padding: "6px 10px", borderRadius: 4, fontSize: 12 }}>
              <option value="all">{t("mods.filter_all", "All")}</option>
              <option value="enabled">{t("mods.filter_enabled", "Enabled")}</option>
              <option value="disabled">{t("mods.filter_disabled", "Disabled")}</option>
            </select>
          </div>

          {/* ── Column headers ── */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", fontSize: 10, fontWeight: 700, color: "var(--txb)", textTransform: "uppercase", letterSpacing: "1px", background: "var(--bg2)", borderBottom: "2px solid var(--brd)", marginBottom: 4, borderRadius: "4px 4px 0 0" }}>
            <span style={{ width: 20 }}></span>
            <span style={{ width: 32 }}>#</span>
            <span style={{ flex: 1 }}>{t("mods.col_mod", "Mod")}</span>
            <span style={{ width: 44, textAlign: "center" }}>{t("mods.col_comps", "Comps")}</span>
            <span style={{ width: 44, textAlign: "center" }}>{t("mods.col_pause", "Pause")}</span>
            {installStatus && installStatus.size > 0 && (
              <span style={{ width: 60, textAlign: "center" }}>{t("mods.col_status", "Status")}</span>
            )}
            <span style={{ width: 20 }}></span>
          </div>

          {/* ── BG1:EE Phase ── */}
          {bgeeGroups.length > 0 && (
            <PhaseView
              phase="bgee"
              sections={groupByCategory(filterGroups(bgeeGroups))}
              allGroups={bgeeGroups}
              excludedComponents={excludedComponents} expandedMods={expandedMods}
              collapsedCategories={collapsedCategories}
              enrichment={enrichment} pausePoints={pausePoints}
              onToggleComponent={toggleComponent} onToggleMod={toggleMod}
              onToggleExpand={toggleExpand} onToggleCategory={toggleCategory}
              onTogglePause={togglePause} onUpdatePauseMessage={updatePauseMessage}
              installStatus={installStatus}
              locked={locked}
            />
          )}

          {/* ── EET Phase ── */}
          {eetGroups.length > 0 && (
            <PhaseView
              phase="eet"
              sections={groupByCategory(filterGroups(eetGroups))}
              allGroups={eetGroups}
              excludedComponents={excludedComponents} expandedMods={expandedMods}
              collapsedCategories={collapsedCategories}
              enrichment={enrichment} pausePoints={pausePoints}
              onToggleComponent={toggleComponent} onToggleMod={toggleMod}
              onToggleExpand={toggleExpand} onToggleCategory={toggleCategory}
              onTogglePause={togglePause} onUpdatePauseMessage={updatePauseMessage}
              installStatus={installStatus}
              locked={locked}
            />
          )}
        </>
      )}

      {/* ── Preset Browser Modal ── */}
      <PresetBrowser
        open={presetBrowserOpen}
        onClose={() => setPresetBrowserOpen(false)}
        onLoad={handlePresetLoad}
        forgeUrl={config.forge_data_url || DEFAULT_FORGE_URL}
        language={config.language || "en"}
        hasParsedLog={!!parsedLog}
      />
    </div>
  );
}

// ─── Phase View ───

interface PhaseViewProps {
  phase: "bgee" | "eet";
  sections: CategorySection[];
  allGroups: ModGroup[];
  excludedComponents: Set<ExcludeKey>;
  expandedMods: Set<string>;
  collapsedCategories: Set<string>;
  enrichment: Map<string, ModEnrichment>;
  pausePoints: PausePoint[];
  onToggleComponent: (entry: LogEntry) => void;
  onToggleMod: (group: ModGroup) => void;
  onToggleExpand: (modName: string) => void;
  onToggleCategory: (name: string) => void;
  onTogglePause: (globalIdx: number, phase: "bgee" | "eet") => void;
  onUpdatePauseMessage: (globalIdx: number, phase: "bgee" | "eet", message: string) => void;
  installStatus?: InstallStatusMap;
  locked?: boolean;
}

function PhaseView({
  phase, sections, allGroups, excludedComponents, expandedMods,
  collapsedCategories, enrichment, pausePoints,
  onToggleComponent, onToggleMod, onToggleExpand, onToggleCategory,
  onTogglePause, onUpdatePauseMessage, installStatus, locked,
}: PhaseViewProps) {
  const { t } = useI18n();
  const totalComponents = allGroups.reduce((sum, g) => sum + g.entries.length, 0);
  const globalIdxMap = useMemo(() => {
    const map = new Map<string, number>();
    allGroups.forEach((g, i) => map.set(g.modName, i));
    return map;
  }, [allGroups]);

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        textAlign: "center", padding: "6px 0", margin: "8px 0", borderRadius: 6,
        fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase",
        background: phase === "bgee"
          ? "linear-gradient(90deg, transparent, rgba(0,200,255,0.12), transparent)"
          : "linear-gradient(90deg, transparent, rgba(255,180,40,0.12), transparent)",
        color: phase === "bgee" ? "var(--cyn)" : "var(--gold)",
        borderTop: `1px solid ${phase === "bgee" ? "rgba(0,200,255,0.3)" : "rgba(255,180,40,0.3)"}`,
        borderBottom: `1px solid ${phase === "bgee" ? "rgba(0,200,255,0.3)" : "rgba(255,180,40,0.3)"}`,
      }}>
        <div>{phase === "bgee" ? t("mods.phase_pre_eet", "PRE-EET") : t("mods.phase_eet", "EET")}</div>
        <div style={{ fontSize: 10, fontWeight: 400, letterSpacing: 0, textTransform: "none", color: "var(--txd)", marginTop: 2 }}>
          {allGroups.length} mods, {totalComponents} components
        </div>
      </div>

      {sections.map((section) => {
        const isCollapsed = collapsedCategories.has(section.name);
        return (
          <div key={section.name} style={{ marginBottom: 4 }}>
            {/* Category header — clickable to collapse */}
            <div
              style={{
                padding: "6px 8px", fontSize: 11, fontWeight: 600, color: "var(--goldb)",
                background: "var(--bg2)", borderLeft: "3px solid var(--goldd)",
                letterSpacing: "0.3px", cursor: "pointer", display: "flex", alignItems: "center",
                userSelect: "none",
              }}
              onClick={() => onToggleCategory(section.name)}
            >
              <span style={{ marginRight: 8, fontSize: 10 }}>{isCollapsed ? "\u25B6" : "\u25BC"}</span>
              {section.name || "UNCATEGORIZED"}
              <span style={{ color: "var(--txd)", fontWeight: 400, marginLeft: 8 }}>({section.groups.length})</span>
            </div>

            {/* Mods — hidden when category is collapsed */}
            {!isCollapsed && section.groups.map((group) => {
              const info = enrichment.get(group.modName);
              const allExcluded = group.entries.every((e) => excludedComponents.has(makeKey(e)));
              const someExcluded = group.entries.some((e) => excludedComponents.has(makeKey(e)));
              const isExpanded = expandedMods.has(group.modName);
              const globalIdx = globalIdxMap.get(group.modName) ?? 0;
              const hasPause = pausePoints.some((p) => p.afterModIndex === globalIdx && p.phase === phase);
              const pausePoint = pausePoints.find((p) => p.afterModIndex === globalIdx && p.phase === phase);

              return (
                <div key={`${phase}-${group.modName}`}>
                  {/* Mod row */}
                  <div
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "5px 8px", cursor: "pointer",
                      opacity: allExcluded ? 0.4 : 1,
                      borderLeft: `3px solid ${allExcluded ? "var(--brd)" : someExcluded ? "var(--org)" : "transparent"}`,
                      borderBottom: "1px solid var(--brd)",
                    }}
                    onClick={() => onToggleExpand(group.modName)}
                  >
                    <input type="checkbox" checked={!allExcluded}
                      ref={(el) => { if (el) el.indeterminate = someExcluded && !allExcluded; }}
                      onChange={() => onToggleMod(group)}
                      onClick={(e) => e.stopPropagation()}
                      disabled={locked}
                      style={{ width: 14, height: 14, flexShrink: 0 }}
                    />
                    <span style={{ color: "var(--txd)", fontSize: 10, width: 32, textAlign: "right", flexShrink: 0 }}>
                      #{globalIdx + 1}
                    </span>
                    <span style={{
                      flex: 1, color: "var(--gold)", fontWeight: 500, fontSize: 13,
                      textDecoration: allExcluded ? "line-through" : "none",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {info?.displayName || group.modName}
                      {!group.onDisk && (
                        <span style={{ color: "var(--red)", fontSize: 10, marginLeft: 6, fontWeight: 400 }}>
                          {t("mods.not_found", "(not found)")}
                        </span>
                      )}
                    </span>
                    <span style={{ width: 44, textAlign: "center", color: "var(--txd)", fontSize: 11, flexShrink: 0 }}>
                      {group.entries.length}
                    </span>
                    <span style={{ width: 44, textAlign: "center", flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={hasPause}
                        onChange={() => onTogglePause(globalIdx, phase)}
                        disabled={locked}
                        title={t("mods.pause_tooltip", "Pause after this mod")} style={{ width: 14, height: 14 }}
                      />
                    </span>
                    {installStatus && installStatus.size > 0 && (() => {
                      // Compute mod-level status from component statuses
                      const statuses = group.entries.map(e => installStatus.get(`${e.mod_name}:${e.component}`));
                      const hasAny = statuses.some(s => s !== undefined);
                      const allDone = statuses.every(s => s !== undefined);
                      const hasError = statuses.some(s => s === "error");
                      const hasWarn = statuses.some(s => s === "warning");
                      const hasSkip = statuses.some(s => s === "skipped");
                      const color = hasError ? "var(--red)" : hasWarn ? "var(--org)" : hasSkip ? "var(--txd)" : allDone ? "var(--grn)" : hasAny ? "var(--gold)" : "var(--txd)";
                      const label = !hasAny ? "\u2014"
                        : hasError ? `${statuses.filter(s => s === "error").length} err`
                        : hasWarn ? `${statuses.filter(s => s === "warning").length} warn`
                        : hasSkip ? "skip"
                        : allDone ? "\u2713"
                        : `${statuses.filter(s => s).length}/${statuses.length}`;
                      return (
                        <span style={{ width: 60, textAlign: "center", color, fontSize: 10, fontWeight: 600, flexShrink: 0 }}>
                          {label}
                        </span>
                      );
                    })()}
                    <span style={{ width: 20, textAlign: "center", color: "var(--txd)", fontSize: 10, flexShrink: 0 }}>
                      {isExpanded ? "\u25BC" : "\u25B6"}
                    </span>
                  </div>

                  {/* Pause message */}
                  {pausePoint && (
                    <div style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "4px 8px 4px 52px",
                      background: "rgba(103, 232, 249, 0.06)",
                      borderLeft: "3px solid var(--cyn)", borderBottom: "1px solid var(--brd)", fontSize: 11,
                    }}>
                      <span style={{ color: "var(--cyn)", fontWeight: 600, fontSize: 10 }}>{t("mods.pause", "PAUSE")}</span>
                      <input type="text" placeholder={t("mods.pause_msg", "Optional message...")}
                        value={pausePoint.message}
                        onChange={(e) => onUpdatePauseMessage(globalIdx, phase, e.target.value)}
                        style={{ flex: 1, background: "var(--bg2)", border: "1px solid var(--brd)", color: "var(--tx)", padding: "2px 8px", borderRadius: 3, fontSize: 11, outline: "none" }}
                      />
                    </div>
                  )}

                  {/* Expanded components */}
                  {isExpanded && (
                    <div style={{ borderLeft: "3px solid var(--brd)", borderBottom: "1px solid var(--brd)" }}>
                      {group.entries.map((entry) => {
                        const key = makeKey(entry);
                        const excluded = excludedComponents.has(key);
                        const forgeComp = info?.components.get(Number(entry.component));
                        return (
                          <div key={key} style={{
                            display: "flex", alignItems: "center", gap: 8,
                            padding: "3px 8px 3px 52px", fontSize: 12, opacity: excluded ? 0.4 : 1,
                          }}>
                            <input type="checkbox" checked={!excluded}
                              onChange={() => onToggleComponent(entry)} disabled={locked} style={{ width: 13, height: 13 }}
                            />
                            <span style={{ color: "var(--txd)", fontSize: 10, minWidth: 32 }}>#{entry.component}</span>
                            <span style={{ color: "var(--tx)", textDecoration: excluded ? "line-through" : "none", flex: 1 }}>
                              {forgeComp?.name || entry.component_name || `Component ${entry.component}`}
                            </span>
                            {entry.version && (
                              <span style={{ color: "var(--txd)", fontSize: 10 }}>
                                {entry.version.startsWith("v") ? entry.version : `v${entry.version}`}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

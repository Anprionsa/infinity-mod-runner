import { useState, useEffect, useCallback, useMemo } from "react";
import { useI18n } from "../lib/i18n";
import { guiLog } from "../lib/gui-logger";
import {
  fetchPresets,
  fetchCommunityBuildIndex,
  fetchCommunityBuild,
  resolvePresetToLog,
  FOCUS_LABELS,
  type ForgePreset,
  type CommunityBuildMeta,
} from "../lib/forge-data";
import { buildParsedLog } from "../lib/log-parser";
import type { ParsedLog } from "../App";

interface Props {
  open: boolean;
  onClose: () => void;
  onLoad: (parsed: ParsedLog, mode: "replace" | "merge") => void;
  forgeUrl: string;
  language: string;
  hasParsedLog: boolean; // whether a log is already loaded (enables merge option)
}

type SelectedItem = {
  type: "preset" | "build";
  id: string;
  name: string;
  desc: string;
  keys: string[];
  icon: string;
  color: string;
  componentCount: number;
  tier?: number;
  difficulty?: string;
  schemaVersion?: number;
};


/** Safe emoji fallback — maps preset IDs to reliable emoji that render in WebView2 */
const PRESET_ICONS: Record<string, string> = {
  "first-adventure": "\uD83C\uDF31",     // 🌱
  "seasoned-adventurer": "\u2694\uFE0F",  // ⚔️
  "veterans-challenge": "\uD83D\uDD25",   // 🔥
  "minimal": "\uD83D\uDEE1\uFE0F",       // 🛡️
  "enhanced": "\u2728",                    // ✨
  "story": "\uD83D\uDCD6",               // 📖
  "full": "\uD83D\uDCE6",                // 📦
  "tactical": "\uD83C\uDFF9",            // 🏹
  "xplat": "\uD83D\uDDA5\uFE0F",         // 🖥️
  "xplat-story": "\uD83C\uDF0D",         // 🌍
  "infinity-insanity": "\uD83C\uDF00",   // 🌀 (legacy)
  "mod-forge-ultimate": "\uD83C\uDF00", // 🌀
};

function getIcon(id: string, fallbackIcon: string): string {
  return PRESET_ICONS[id] || fallbackIcon;
}

export default function PresetBrowser({ open, onClose, onLoad, forgeUrl, language, hasParsedLog }: Props) {
  const { t } = useI18n();
  const [presets, setPresets] = useState<ForgePreset[]>([]);
  const [builds, setBuilds] = useState<CommunityBuildMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Selection & confirmation
  const [selected, setSelected] = useState<SelectedItem | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  // Community build filters
  const [searchQuery, setSearchQuery] = useState("");
  const [focusFilter, setFocusFilter] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<"newest" | "components">("newest");

  // Versions of community builds the user has previously loaded (id -> version).
  // Stored in localStorage so update detection works across app restarts.
  // Initialized lazily and refreshed when a build is loaded.
  const [loadedBuildVersions, setLoadedBuildVersions] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem("runner_loaded_build_versions");
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const markBuildLoaded = useCallback((id: string, version?: string) => {
    if (!version) return;
    setLoadedBuildVersions(prev => {
      if (prev[id] === version) return prev;
      const next = { ...prev, [id]: version };
      try { localStorage.setItem("runner_loaded_build_versions", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const loadData = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetchPresets(forgeUrl).catch(() => [] as ForgePreset[]),
      fetchCommunityBuildIndex().catch(() => [] as CommunityBuildMeta[]),
    ]).then(([p, b]) => {
      setPresets(p);
      setBuilds(b);
    }).catch(e => {
      setError(`Failed to load: ${e}`);
    }).finally(() => setLoading(false));
  }, [forgeUrl]);

  // Fetch data on open
  useEffect(() => {
    if (!open) return;
    loadData();
  }, [open, forgeUrl]);

  // Filtered + sorted community builds
  const filteredBuilds = useMemo(() => {
    let result = builds;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(b =>
        b.name.toLowerCase().includes(q) || b.desc.toLowerCase().includes(q) || b.author.toLowerCase().includes(q)
      );
    }
    if (focusFilter.size > 0) {
      result = result.filter(b => b.focus.some(f => focusFilter.has(f)));
    }
    if (sortBy === "newest") {
      result = [...result].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } else {
      result = [...result].sort((a, b) => b.componentCount - a.componentCount);
    }
    return result;
  }, [builds, searchQuery, focusFilter, sortBy]);

  const toggleFocus = (tag: string) => {
    setFocusFilter(prev => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  };

  // Handle load (replace or merge)
  const handleLoad = async (mode: "replace" | "merge") => {
    if (!selected) return;
    setResolving(true);
    setResolveError(null);
    try {
      const { eetLog, bgeeLog, skipped } = await resolvePresetToLog(forgeUrl, selected.keys, language, selected.schemaVersion ?? 1);
      const parsed = buildParsedLog(eetLog, bgeeLog || null, null, null);
      parsed.presetSource = { name: selected.name, type: selected.type, componentCount: selected.keys.length };
      guiLog.info("PRESET", `Loaded "${selected.name}" (${selected.type}, ${selected.keys.length} keys, mode=${mode}, skipped=${skipped})`);
      if (skipped > 0) {
        guiLog.warn("PRESET", `${skipped} components skipped (mods not in Forge index)`);
      }
      onLoad(parsed, mode);
      setSelected(null);
      onClose();
    } catch (e) {
      setResolveError(`Failed to resolve preset: ${e}`);
    } finally {
      setResolving(false);
    }
  };

  if (!open) return null;

  const tierColors: Record<number, string> = { 1: "var(--grn)", 2: "var(--tx-warn)", 3: "var(--red)" };
  const tierLabels: Record<number, string> = { 1: t("tier.beginner", "Beginner"), 2: t("tier.intermediate", "Intermediate"), 3: t("tier.expert", "Expert") };

  // Split presets into guided (have tier) and themed (no tier)
  const guidedPresets = presets.filter(p => p.tier);
  const themedPresets = presets.filter(p => !p.tier);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "var(--bg)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000,
    }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: "var(--bg)", border: "1px solid var(--brd2)",
        borderRadius: 10, width: "92%", maxWidth: 820, maxHeight: "90vh",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "16px 20px", borderBottom: "1px solid var(--brd)",
        }}>
          <h3 style={{ margin: 0 }}>{t("preset.title", "Browse Presets & Community Builds")}</h3>
          <button onClick={onClose} style={{
            background: "none", border: "none", color: "var(--txd)", fontSize: 20, cursor: "pointer",
          }}>X</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
          {loading && (
            <div style={{ textAlign: "center", padding: 40, color: "var(--txd)" }}>{t("btn.loading", "Loading...")}</div>
          )}
          {error && (
            <div className="alert err" style={{ padding: 12, marginBottom: 16 }}>
              {error}
            </div>
          )}

          {!loading && !error && (
            <>
              {/* ── Guided Presets ── */}
              {guidedPresets.length > 0 && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--txd)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
                    {t("preset.guided", "Guided Presets")}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 20 }}>
                    {guidedPresets.map(p => (
                      <PresetCard key={p.id} preset={p} tierColors={tierColors} tierLabels={tierLabels}
                        resolvedIcon={getIcon(p.id, p.icon)}
                        onClick={() => setSelected({
                          type: "preset", id: p.id, name: p.name, desc: p.desc, keys: p.keys,
                          icon: p.icon, color: p.color, componentCount: p.keys.length,
                          tier: p.tier, difficulty: p.difficulty,
                          schemaVersion: p.schemaVersion,
                        })} />
                    ))}
                  </div>
                </>
              )}

              {/* ── Themed Presets ── */}
              {themedPresets.length > 0 && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--txd)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
                    {t("preset.themed", "Themed Presets")}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 8, marginBottom: 20 }}>
                    {themedPresets.map(p => (
                      <PresetCard key={p.id} preset={p} tierColors={tierColors} tierLabels={tierLabels}
                        resolvedIcon={getIcon(p.id, p.icon)}
                        onClick={() => setSelected({
                          type: "preset", id: p.id, name: p.name, desc: p.desc, keys: p.keys,
                          icon: p.icon, color: p.color, componentCount: p.keys.length,
                          schemaVersion: p.schemaVersion,
                        })} />
                    ))}
                  </div>
                </>
              )}

              {/* ── Community Builds ── */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--txd)", textTransform: "uppercase", letterSpacing: 1 }}>
                  {t("preset.community", "Community Builds")}
                </span>
                <button className="btn" onClick={loadData} disabled={loading}
                  style={{ fontSize: 10, padding: "2px 8px" }}>
                  {loading ? t("btn.loading", "Loading...") : t("btn.refresh", "Refresh")}
                </button>
              </div>

              {/* Filters */}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
                <input
                  type="text" placeholder={t("preset.search", "Search builds...")}
                  value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                  style={{
                    padding: "4px 10px", background: "var(--bg2)", border: "1px solid var(--brd)",
                    borderRadius: 4, color: "var(--tx)", fontSize: 12, width: 200,
                  }}
                />
                {Object.entries(FOCUS_LABELS).map(([tag, label]) => (
                  <button key={tag} onClick={() => toggleFocus(tag)} style={{
                    padding: "2px 8px", fontSize: 10, borderRadius: 10, cursor: "pointer",
                    background: focusFilter.has(tag) ? "var(--bg3)" : "transparent",
                    color: focusFilter.has(tag) ? "var(--tx)" : "var(--txd)",
                    border: `1px solid ${focusFilter.has(tag) ? "var(--brd2)" : "var(--brd)"}`,
                  }}>
                    {label}
                  </button>
                ))}
                <select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)} style={{
                  padding: "3px 8px", fontSize: 11, background: "var(--bg2)", border: "1px solid var(--brd)",
                  borderRadius: 4, color: "var(--tx)", marginLeft: "auto",
                }}>
                  <option value="newest">{t("preset.sort_newest", "Newest")}</option>
                  <option value="components">{t("preset.sort_components", "Most Components")}</option>
                </select>
              </div>

              {filteredBuilds.length === 0 && (
                <div style={{ color: "var(--txd)", fontSize: 12, fontStyle: "italic", padding: 20, textAlign: "center" }}>
                  {builds.length === 0
                    ? t("preset.no_builds", "No community builds yet. Create one in Infinity Mod Forge!")
                    : t("preset.no_match", "No builds match your filters.")}
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {filteredBuilds.map(b => (
                  <BuildCard key={b.id} build={b} tierColors={tierColors} tierLabels={tierLabels}
                    loadedVersion={loadedBuildVersions[b.id]}
                    onClick={async () => {
                      setResolving(true);
                      setResolveError(null);
                      try {
                        const full = await fetchCommunityBuild(b.id);
                        if (!full) throw new Error("Build not found");
                        setSelected({
                          type: "build", id: full.id, name: full.name, desc: full.desc, keys: full.keys,
                          icon: full.icon, color: full.color, componentCount: full.componentCount,
                          tier: full.tier, difficulty: full.difficulty,
                          schemaVersion: full.schemaVersion,
                        });
                        // Record that we've loaded this version so we can flag future updates.
                        markBuildLoaded(full.id, full.version);
                      } catch (e) {
                        setResolveError(`Failed to load build: ${e}`);
                      } finally {
                        setResolving(false);
                      }
                    }} />
                ))}
              </div>
            </>
          )}
        </div>

        {/* ── Confirmation Dialog ── */}
        {selected && (
          <div style={{
            position: "absolute", inset: 0, background: "var(--modal-backdrop)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2001,
          }}>
            <div style={{
              background: "var(--bg)", border: "1px solid var(--brd2)", borderRadius: 8,
              padding: 24, maxWidth: 420, textAlign: "center",
            }}>
              <div style={{ fontSize: 18, marginBottom: 4, fontFamily: "'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif" }}>{getIcon(selected.id, selected.icon)}</div>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
                Load "{selected.name}"?
              </div>
              <div style={{ fontSize: 12, color: "var(--txd)", marginBottom: 4 }}>
                {selected.componentCount} components
                {selected.tier && (
                  <span style={{ marginLeft: 8, color: tierColors[selected.tier] }}>
                    {tierLabels[selected.tier]}
                  </span>
                )}
              </div>
              {selected.desc && (
                <div style={{ fontSize: 11, color: "var(--txd)", marginBottom: 16, lineHeight: 1.4, maxHeight: 60, overflow: "hidden" }}>
                  {selected.desc}
                </div>
              )}

              {resolveError && (
                <div style={{ color: "var(--red)", fontSize: 11, marginBottom: 12 }}>{resolveError}</div>
              )}

              <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                <button className="btn btn-primary" onClick={() => handleLoad("replace")} disabled={resolving}>
                  {resolving ? t("preset.resolving", "Loading...") : t("preset.replace", "Replace List")}
                </button>
                {hasParsedLog && (
                  <button className="btn" onClick={() => handleLoad("merge")} disabled={resolving}>
                    {t("preset.merge", "Merge")}
                  </button>
                )}
                <button className="btn" onClick={() => { setSelected(null); setResolveError(null); }}>
                  {t("btn.cancel", "Cancel")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ──

function PresetCard({ preset, tierColors, tierLabels, resolvedIcon, onClick }: {
  preset: ForgePreset;
  tierColors: Record<number, string>;
  tierLabels: Record<number, string>;
  resolvedIcon: string;
  onClick: () => void;
}) {
  return (
    <div onClick={onClick} style={{
      padding: "12px 14px", background: "var(--bg2)", borderRadius: 6,
      border: `1px solid ${preset.color}33`, cursor: "pointer",
      transition: "border-color 0.15s, background 0.15s",
    }}
      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.borderColor = preset.color; (e.currentTarget as HTMLDivElement).style.background = "var(--bg3)"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor = `${preset.color}33`; (e.currentTarget as HTMLDivElement).style.background = "var(--bg2)"; }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 18, fontFamily: "'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif" }}>{resolvedIcon}</span>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{preset.name}</span>
      </div>
      <div style={{ fontSize: 11, color: "var(--txd)", marginBottom: 6, lineHeight: 1.3, maxHeight: 42, overflow: "hidden" }}>
        {preset.desc}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10 }}>
        <span style={{ color: "var(--txd)" }}>{preset.keys.length} components</span>
        {preset.tier && (
          <span style={{
            padding: "1px 6px", borderRadius: 8, fontSize: 9, fontWeight: 600,
            background: `${tierColors[preset.tier]}22`, color: tierColors[preset.tier],
            border: `1px solid ${tierColors[preset.tier]}44`,
          }}>
            {tierLabels[preset.tier]}
          </span>
        )}
      </div>
    </div>
  );
}

function BuildCard({ build, tierColors, tierLabels, loadedVersion, onClick }: {
  build: CommunityBuildMeta;
  tierColors: Record<number, string>;
  tierLabels: Record<number, string>;
  /** Version the user previously loaded for this build id, if any — used to flag updates. */
  loadedVersion?: string;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const relativeDate = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const days = Math.floor(diff / 86400000);
    if (days < 1) return "today";
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    return `${Math.floor(days / 30)}mo ago`;
  };
  const updateAvailable = !!(build.version && loadedVersion && build.version !== loadedVersion);

  return (
    <div onClick={onClick} style={{
      padding: "10px 14px", background: "var(--bg2)", borderRadius: 6,
      border: "1px solid var(--brd)", cursor: "pointer",
      transition: "border-color 0.15s",
    }}
      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.borderColor = "var(--brd2)"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor = "var(--brd)"; }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16, fontFamily: "'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif" }}>{build.icon}</span>
          <div>
            <span style={{ fontWeight: 600, fontSize: 13 }}>{build.name}</span>
            <span style={{ fontSize: 11, color: "var(--txd)", marginLeft: 8 }}>{t("preset.by_author", "by")} {build.author}</span>
            {build.version && <span style={{ fontSize: 10, color: "var(--txd)", marginLeft: 6, fontFamily: "monospace" }}>v{build.version}</span>}
            {updateAvailable && (
              <span style={{
                marginLeft: 6, padding: "1px 6px", borderRadius: 8, fontSize: 9, fontWeight: 700,
                background: "var(--grn)", color: "var(--bg)",
              }} title={`Installed: v${loadedVersion} - Available: v${build.version}`}>
                {t("preset.update_available", "UPDATE")}
              </span>
            )}
          </div>
        </div>
        <div style={{ fontSize: 10, color: "var(--txd)" }}>{relativeDate(build.updatedAt || build.createdAt)}</div>
      </div>
      <div style={{ fontSize: 11, color: "var(--txd)", marginTop: 4, lineHeight: 1.3, maxHeight: 32, overflow: "hidden" }}>
        {build.desc}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, color: "var(--txd)" }}>{build.componentCount} components</span>
        {build.tier && (
          <span style={{
            padding: "1px 6px", borderRadius: 8, fontSize: 9, fontWeight: 600,
            background: `${tierColors[build.tier]}22`, color: tierColors[build.tier],
            border: `1px solid ${tierColors[build.tier]}44`,
          }}>
            {tierLabels[build.tier]}
          </span>
        )}
        {build.focus.map(f => (
          <span key={f} style={{
            padding: "1px 6px", borderRadius: 8, fontSize: 9,
            background: "var(--bg3)", color: "var(--txd)", border: "1px solid var(--brd)",
          }}>
            {FOCUS_LABELS[f] || f}
          </span>
        ))}
      </div>
    </div>
  );
}

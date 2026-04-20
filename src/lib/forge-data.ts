/// Fetch JSON data from the hosted Forge.

import { FALLBACK_CATEGORY_DISPLAY_ORDER } from "../constants/categories";
import {
  FALLBACK_ACCELERATOR_COEFFICIENTS,
  type AcceleratorCoefficients,
  type HeavyClass,
} from "../constants/install-baselines";

/** Per-component install-duration profile from Forge. Populated for mods
 * that have been measured (hand-seeded + telemetry-aggregated). Absent
 * entries fall back to the heavyClass default via `inferHeavyClass`. */
export interface InstallProfileEntry {
  baselineSec: number;
  heavyClass: HeavyClass;
  sampleCount: number;
  updatedAt?: string;
  notes?: string;
}

/** Keyed lookup: `"<tp2_name_lc>:<cn>"` → baseline info. */
export type InstallProfileMap = Map<string, InstallProfileEntry>;

/** Fetch install-duration baselines for a set of mods from Forge.
 *
 * Reads the same per-mod detail files used by the enrichment path, filters
 * the `installProfile` field out of each component. Returns a map keyed
 * `"<tp2_name_lc>:<cn>"` → entry. Missing entries mean "no data; use
 * heavyClass default". */
export async function fetchInstallProfiles(
  baseUrl: string,
  modNames: string[],
): Promise<InstallProfileMap> {
  const result: InstallProfileMap = new Map();
  if (modNames.length === 0) return result;

  let catalog: Record<string, string>;
  let modIndex: unknown;
  try {
    const [catResp, idxResp] = await Promise.all([
      fetch(`${baseUrl}/data/mods/_catalog.json`),
      fetch(`${baseUrl}/data/mods-index.json`),
    ]);
    if (!catResp.ok || !idxResp.ok) return result;
    catalog = await catResp.json();
    modIndex = await idxResp.json();
  } catch {
    return result;
  }

  const indexArr = Array.isArray(modIndex)
    ? modIndex
    : Object.values(modIndex as Record<string, unknown>);
  const nameToFile = new Map<string, string>();
  for (const info of indexArr) {
    const e = info as { t?: string; i?: number };
    const tp2Name = (e.t || "").toLowerCase();
    const modId = String(e.i || "");
    const filename = catalog[modId];
    if (tp2Name && filename) nameToFile.set(tp2Name, filename);
  }

  const toFetch = modNames
    .map((n) => ({ name: n, file: nameToFile.get(n.toLowerCase()) }))
    .filter((x): x is { name: string; file: string } => !!x.file);

  const BATCH = 20;
  for (let i = 0; i < toFetch.length; i += BATCH) {
    const batch = toFetch.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async ({ name, file }) => {
        const resp = await fetch(`${baseUrl}/data/mods/${encodeURIComponent(file)}`);
        if (!resp.ok) return null;
        const data = (await resp.json()) as {
          co?: Array<{ cn?: number; installProfile?: InstallProfileEntry }>;
        };
        return { name, co: data.co || [] };
      }),
    );
    for (const r of results) {
      if (r.status !== "fulfilled" || !r.value) continue;
      const { name, co } = r.value;
      const nameLc = name.toLowerCase();
      for (const comp of co) {
        if (comp.cn === undefined || !comp.installProfile) continue;
        result.set(`${nameLc}:${comp.cn}`, comp.installProfile);
      }
    }
  }

  return result;
}

/** Fetch the accelerator discount coefficients from Forge. Falls back to
 * the local defaults when the file is missing or malformed so a broken
 * Forge deploy doesn't wreck ETA. */
export async function fetchAcceleratorCoefficients(
  baseUrl: string,
): Promise<AcceleratorCoefficients> {
  try {
    const resp = await fetch(`${baseUrl}/data/accelerator-profile-ref.json`);
    if (!resp.ok) return FALLBACK_ACCELERATOR_COEFFICIENTS;
    const data = (await resp.json()) as {
      coefficients?: Partial<AcceleratorCoefficients>;
    };
    const c = data.coefficients;
    if (!c) return FALLBACK_ACCELERATOR_COEFFICIENTS;
    return {
      overrideFastDrive: c.overrideFastDrive || FALLBACK_ACCELERATOR_COEFFICIENTS.overrideFastDrive,
      experimentalWeidu: c.experimentalWeidu || FALLBACK_ACCELERATOR_COEFFICIENTS.experimentalWeidu,
      batchSizePenaltyPerStepBelow25:
        typeof c.batchSizePenaltyPerStepBelow25 === "number"
          ? c.batchSizePenaltyPerStepBelow25
          : FALLBACK_ACCELERATOR_COEFFICIENTS.batchSizePenaltyPerStepBelow25,
    };
  } catch {
    return FALLBACK_ACCELERATOR_COEFFICIENTS;
  }
}

/** Fetch the canonical category install order from Forge.
 *
 * Source: `/data/categories.json` on the hosted Forge (shipped in v4.0.0+).
 * If the fetch fails or the response is missing categories, returns the
 * local `FALLBACK_CATEGORY_DISPLAY_ORDER` so the Runner keeps working
 * against older Forge deployments. */
export async function fetchCategories(baseUrl: string): Promise<string[]> {
  try {
    const resp = await fetch(`${baseUrl}/data/categories.json`);
    if (!resp.ok) return FALLBACK_CATEGORY_DISPLAY_ORDER;
    const data = await resp.json();
    const cats = data?.categories;
    if (cats && typeof cats === "object") {
      const names = Object.keys(cats);
      if (names.length > 0) return names;
    }
    return FALLBACK_CATEGORY_DISPLAY_ORDER;
  } catch {
    return FALLBACK_CATEGORY_DISPLAY_ORDER;
  }
}

/** Player-visible impact — orthogonal to `severity`. See Forge README
 * "Adding known issues" section for the full rubric. */
export type KnownIssueCategory =
  | "cosmetic"       // zero player-visible impact
  | "likely-benign"  // usually fine, keep an eye out
  | "caution"        // might indicate a real issue
  | "concerning";    // likely a real problem

/** Short action hint the UI uses to decide what affordance to render. */
export type KnownIssueUserAction =
  | "none"
  | "retry"
  | "apply-patches"
  | "check-docs"
  | "contact-author";

export interface KnownIssue {
  pattern: string;
  mod: string;
  severity: "critical" | "error" | "warning" | "info";
  /** Optional — present on classified entries, undefined on legacy ones.
   * Entries without a category render as "unknown" in the live issues
   * panel (a signal that this pattern hasn't been triaged yet). */
  category?: KnownIssueCategory;
  known: boolean;
  description: string;
  workaround: string;
  user_action?: KnownIssueUserAction;
  forum?: string;
}

export interface CompatEntry {
  ver: string;
  place: "pre" | "post";
  notes?: string;
}

export type CompatData = Record<string, CompatEntry>;

export async function fetchKnownIssues(
  baseUrl: string,
): Promise<KnownIssue[]> {
  const resp = await fetch(`${baseUrl}/data/known_issues.json`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function fetchCompat(baseUrl: string): Promise<CompatData> {
  const resp = await fetch(`${baseUrl}/data/compat.json`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/** Per-mod known issue from the `ki` field */
export interface ModKnownIssue {
  pattern: string;
  severity: string;
  category?: KnownIssueCategory;
  description: string;
  workaround: string;
  user_action?: KnownIssueUserAction;
  components?: number[];
  forum?: string;
}

/** Fetch the mod catalog (maps mod IDs to filenames) */
export async function fetchModCatalog(
  baseUrl: string,
): Promise<Record<string, string>> {
  const resp = await fetch(`${baseUrl}/data/mods/_catalog.json`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/** Fetch a single mod's JSON and extract its `ki` field */
export async function fetchModKnownIssues(
  baseUrl: string,
  filename: string,
): Promise<{ modName: string; issues: ModKnownIssue[] }> {
  const resp = await fetch(`${baseUrl}/data/mods/${encodeURIComponent(filename)}`);
  if (!resp.ok) return { modName: "", issues: [] };
  const data = await resp.json();
  return {
    modName: data.n || data.t || "",
    issues: data.ki || [],
  };
}

/**
 * Fetch per-mod known issues for a set of mod names.
 * Looks up each mod name in the catalog, fetches its JSON, extracts `ki`.
 * Returns all issues as KnownIssue[] (converted to match global format).
 */
export async function fetchAllModKnownIssues(
  baseUrl: string,
  modNames: string[],
): Promise<KnownIssue[]> {
  if (modNames.length === 0) return [];

  // Fetch catalog
  let catalog: Record<string, string>;
  try {
    catalog = await fetchModCatalog(baseUrl);
  } catch {
    return [];
  }

  // Build a map of lowercase mod name → catalog filename
  // The catalog maps mod IDs to filenames, but we need to search by mod name (tp2 name)
  // Fetch the index to map names to IDs
  let modIndex: Record<string, { t?: string; n?: string }>;
  try {
    const resp = await fetch(`${baseUrl}/data/mods-index.json`);
    if (!resp.ok) return [];
    modIndex = await resp.json();
  } catch {
    return [];
  }

  // Build lookup: lowercase tp2 name → filename
  // modIndex is an array — use each entry's `i` field as the catalog key
  const nameToFile = new Map<string, string>();
  const indexList = Array.isArray(modIndex) ? modIndex : Object.values(modIndex);
  for (const info of indexList) {
    const tp2Name = ((info as { t?: string }).t || "").toLowerCase();
    const modId = String((info as { i?: number }).i || "");
    const filename = catalog[modId];
    if (tp2Name && filename) {
      nameToFile.set(tp2Name, filename);
    }
  }

  // Fetch per-mod ki for matching mod names (cap at 30 fetches to avoid flooding)
  const toFetch = modNames
    .map((n) => ({ name: n, file: nameToFile.get(n.toLowerCase()) }))
    .filter((x) => x.file)
    .slice(0, 30);

  const results = await Promise.allSettled(
    toFetch.map(({ name, file }) =>
      fetchModKnownIssues(baseUrl, file!).then((r) => ({ name, ...r })),
    ),
  );

  const allIssues: KnownIssue[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.issues.length > 0) {
      for (const ki of r.value.issues) {
        allIssues.push({
          pattern: ki.pattern,
          mod: r.value.name,
          severity: ki.severity as KnownIssue["severity"],
          category: ki.category,
          known: true,
          description: ki.description,
          workaround: ki.workaround,
          user_action: ki.user_action,
          forum: ki.forum,
        });
      }
    }
  }

  return allIssues;
}

// ─── Resource Limit Checking ───

/** Aggregated resource usage across all mods in the install */
export interface ResourceUsage {
  /** Total new kits added by all mods */
  totalKits: number;
  /** Kit details: [modName, kitName, className] */
  kitDetails: { mod: string; name: string; cls: string }[];
  /** New spells per type per level: spellsByLevel.wizard[1] = count of new wizard level 1 spells */
  spellsByLevel: {
    wizard: Record<number, number>;
    priest: Record<number, number>;
    innate: Record<number, number>;
  };
  /** Total new spells added */
  totalSpells: number;
  /** Spell level details for levels near/over cap */
  spellWarnings: { type: string; level: number; count: number; cap: number }[];
  /** Mods that contribute the most kits */
  topKitMods: { mod: string; count: number }[];
  /** Mods that contribute the most spells */
  topSpellMods: { mod: string; count: number }[];
}

/** Known engine hard limits */
const KIT_LIMIT = 256;       // Total kit slots in KITLIST.2DA
const SPELL_LEVEL_CAP = 50;  // Max spells per level per type in SPELL.IDS
let VANILLA_KITS = 37;       // Loaded from kits-vanilla.json at runtime

/** Fetch the vanilla kit count from Forge data. */
async function loadVanillaKitCount(baseUrl: string): Promise<void> {
  try {
    const resp = await fetch(`${baseUrl}/data/kits-vanilla.json`);
    if (resp.ok) {
      const data = await resp.json();
      VANILLA_KITS = typeof data === "object" && !Array.isArray(data)
        ? Object.keys(data).length
        : Array.isArray(data) ? data.length : 37;
    }
  } catch { /* use default */ }
}

/**
 * Fetch mod detail files and aggregate resource usage (kits, spells)
 * for all mods/components in the install list.
 *
 * @param modComponents Map of mod tp2 name → array of component numbers being installed
 */
export async function fetchResourceUsage(
  baseUrl: string,
  modComponents: Map<string, string[]>,
): Promise<ResourceUsage> {
  // Load vanilla kit count from Forge if not already loaded
  await loadVanillaKitCount(baseUrl);

  const result: ResourceUsage = {
    totalKits: 0,
    kitDetails: [],
    spellsByLevel: { wizard: {}, priest: {}, innate: {} },
    totalSpells: 0,
    spellWarnings: [],
    topKitMods: [],
    topSpellMods: [],
  };

  if (modComponents.size === 0) return result;

  // Fetch catalog and index
  let catalog: Record<string, string>;
  let modIndex: Record<string, { t?: string; n?: string }>;
  try {
    const [catResp, idxResp] = await Promise.all([
      fetch(`${baseUrl}/data/mods/_catalog.json`),
      fetch(`${baseUrl}/data/mods-index.json`),
    ]);
    if (!catResp.ok || !idxResp.ok) return result;
    catalog = await catResp.json();
    modIndex = await idxResp.json();
  } catch {
    return result;
  }

  // Build lookup: lowercase tp2 name → { filename, displayName }
  // modIndex is an array — use each entry's `i` field as the catalog key
  const nameToInfo = new Map<string, { file: string; display: string }>();
  const indexArr = Array.isArray(modIndex) ? modIndex : Object.values(modIndex);
  for (const info of indexArr) {
    const tp2Name = ((info as { t?: string }).t || "").toLowerCase();
    const modId = String((info as { i?: number }).i || "");
    const filename = catalog[modId];
    if (tp2Name && filename) {
      nameToInfo.set(tp2Name, { file: filename, display: (info as { n?: string }).n || tp2Name });
    }
  }

  // Match mods from install list against Forge index
  const toFetch: { modName: string; display: string; file: string; components: string[] }[] = [];
  let matchCount = 0;
  let missCount = 0;
  for (const [modName, components] of modComponents) {
    const info = nameToInfo.get(modName.toLowerCase());
    if (info) {
      toFetch.push({ modName, display: info.display, file: info.file, components });
      matchCount++;
    } else {
      missCount++;
    }
  }
  console.log(`[RESOURCE] ${matchCount} mods matched Forge index, ${missCount} not found. Fetching ${toFetch.length} detail files...`);

  // Fetch all mod detail files in batches of 20 to avoid hammering the CDN
  const BATCH_SIZE = 20;
  const fetchedMods: { modName: string; display: string; file: string; components: string[]; data: Record<string, unknown> }[] = [];
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async (entry) => {
        const resp = await fetch(`${baseUrl}/data/mods/${encodeURIComponent(entry.file)}`);
        if (!resp.ok) return null;
        const data = await resp.json();
        return { ...entry, data };
      }),
    );
    for (const r of batchResults) {
      if (r.status === "fulfilled" && r.value) {
        fetchedMods.push(r.value);
      }
    }
  }

  const kitModCounts = new Map<string, number>();
  const spellModCounts = new Map<string, number>();

  for (const mod of fetchedMods) {
    const { display, components, data } = mod;
    const co: { cn?: number }[] = (data.co as { cn?: number }[]) || [];

    // Build cn → index map for this mod
    const cnToIdx = new Map<number, number>();
    for (let i = 0; i < co.length; i++) {
      if (co[i].cn !== undefined) cnToIdx.set(co[i].cn!, i);
    }

    // Get indices of installed components
    const installedIndices = new Set<string>();
    for (const cn of components) {
      const idx = cnToIdx.get(Number(cn));
      if (idx !== undefined) installedIndices.add(String(idx));
    }

    // Count kits from installed components
    const kits = (data.kits || {}) as Record<string, { new?: string[][] }>;
    let modKitCount = 0;
    // Debug: log mods that have kits data but no matching components
    if (Object.keys(kits).length > 0 && installedIndices.size === 0) {
      console.warn(`[RESOURCE] ${display}: has ${Object.keys(kits).length} kit entries but 0 installed indices. Components from log: ${components.slice(0, 5).join(",")}. co has ${co.length} entries.`);
    }
    for (const [idx, kitData] of Object.entries(kits)) {
      if (!installedIndices.has(idx)) continue;
      const newKits = (kitData as { new?: string[][] }).new || [];
      for (const kit of newKits) {
        result.totalKits++;
        modKitCount++;
        result.kitDetails.push({
          mod: display,
          name: kit[2] || kit[0] || "?",
          cls: kit[1] || "?",
        });
      }
    }
    if (modKitCount > 0) kitModCounts.set(display, modKitCount);

    // Count spells from installed components
    const spl = data.spl || {};
    let modSpellCount = 0;
    for (const [idx, splData] of Object.entries(spl)) {
      if (!installedIndices.has(idx)) continue;
      const newSpells = (splData as { new?: (string | number)[][] }).new || [];
      for (const spell of newSpells) {
        // Format: [id, type, level, school, name, description]
        const type = String(spell[1] || "").toLowerCase();
        const level = Number(spell[2]) || 0;
        if (type === "wizard" || type === "priest" || type === "innate") {
          const bucket = result.spellsByLevel[type as keyof typeof result.spellsByLevel];
          bucket[level] = (bucket[level] || 0) + 1;
        }
        result.totalSpells++;
        modSpellCount++;
      }
    }
    if (modSpellCount > 0) spellModCounts.set(display, modSpellCount);
  }

  // Check spell level caps
  for (const [type, levels] of Object.entries(result.spellsByLevel)) {
    for (const [lvl, count] of Object.entries(levels)) {
      if (count > SPELL_LEVEL_CAP * 0.7) { // Warn at 70%
        result.spellWarnings.push({
          type,
          level: Number(lvl),
          count,
          cap: SPELL_LEVEL_CAP,
        });
      }
    }
  }

  // Sort top contributors
  result.topKitMods = [...kitModCounts.entries()]
    .map(([mod, count]) => ({ mod, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  result.topSpellMods = [...spellModCounts.entries()]
    .map(([mod, count]) => ({ mod, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return result;
}

/** Check if kit count is approaching or exceeding the engine limit */
export function checkKitLimit(totalKits: number): { severity: "ok" | "warn" | "err"; message: string } {
  const estimated = VANILLA_KITS + totalKits;
  if (estimated >= KIT_LIMIT) {
    return { severity: "err", message: `Kit limit exceeded: ${estimated} kits (${VANILLA_KITS} vanilla + ${totalKits} from mods). Engine limit is ${KIT_LIMIT}. Some kits will silently fail to register.` };
  }
  if (estimated >= KIT_LIMIT * 0.85) {
    return { severity: "warn", message: `Kit count is high: ${estimated} kits (${VANILLA_KITS} vanilla + ${totalKits} from mods). Engine limit is ${KIT_LIMIT}. Close to the limit.` };
  }
  return { severity: "ok", message: `Kits: ${estimated} total (${VANILLA_KITS} vanilla + ${totalKits} from mods). Well within the ${KIT_LIMIT} limit.` };
}

// ─── Download Manager Data ───

/** Mod index entry with URL and basic info.
 *
 * Download override fields (optional) let the Forge correct link problems
 * without requiring a Runner release:
 *   - `dl`      full download URL, takes precedence over all construction
 *   - `branch`  GitHub default-branch override (e.g. "master") for mods
 *               without a release tag; builds `/archive/refs/heads/<branch>.zip`
 *   - `src`     force a specific DownloadSource (e.g. "manual") bypassing
 *               auto-detection, when the host check gets something wrong
 */
export interface ModIndexEntry {
  i: number;
  t: string;    // tp2 folder name
  n: string;    // display name
  u?: string;   // upstream page URL
  dl?: string;  // explicit download URL override (Forge-controlled)
  branch?: string; // GitHub branch override for no-release-tag mods
  src?: "github_release" | "github_archive" | "direct" | "manual" | "none"; // source override
  [key: string]: unknown;
}

// GitHubMod interface removed — github_mods.json deleted, data absorbed into per-mod gh field

/** Version cache entry from version_cache.json */
export interface VersionCacheEntry {
  stars?: number;
  pushed?: string;
  archived?: boolean;
  tag?: string;
  release_name?: string;
  release_date?: string;
  release_url?: string;
  mod_id?: number;
}

export type VersionCache = Record<string, VersionCacheEntry>;

// ─── Forge data freshness tracking ───
//
// The Runner caches Forge data in memory after startup. When the Forge
// repo is updated (link fix, new release tag, new mod), users won't see
// the change until the app restarts UNLESS we explicitly re-fetch.
// `forgeDataAgeMs()` lets the UI show data age; `refreshForgeData()`
// forces a bypass of any HTTP cache so a manual or pre-download refresh
// actually hits the origin.
let lastFetchAt: number | null = null;

/** Milliseconds since the last successful Forge fetch, or null if never. */
export function forgeDataAgeMs(): number | null {
  return lastFetchAt === null ? null : Date.now() - lastFetchAt;
}

/** Internal: fetch with cache-bust when requested. */
async function fetchJson<T>(url: string, bustCache: boolean): Promise<T> {
  const finalUrl = bustCache ? `${url}?t=${Date.now()}` : url;
  const resp = await fetch(finalUrl, bustCache ? { cache: "no-store" } : undefined);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/** Fetch the full mod index */
export async function fetchModIndex(
  baseUrl: string,
  opts?: { bustCache?: boolean },
): Promise<Record<string, ModIndexEntry>> {
  const data = await fetchJson<Record<string, ModIndexEntry>>(
    `${baseUrl}/data/mods-index.json`,
    opts?.bustCache ?? false,
  );
  lastFetchAt = Date.now();
  return data;
}

// fetchGitHubMods removed — github_mods.json deleted, data in per-mod gh field

/** Fetch version cache (GitHub release info) */
export async function fetchVersionCache(
  baseUrl: string,
  opts?: { bustCache?: boolean },
): Promise<VersionCache> {
  const data = await fetchJson<VersionCache>(
    `${baseUrl}/data/version_cache.json`,
    opts?.bustCache ?? false,
  );
  lastFetchAt = Date.now();
  return data;
}

/** Download source categorization */
export type DownloadSource = "github_release" | "github_archive" | "direct" | "manual" | "none";

export interface DownloadInfo {
  modName: string;       // tp2 folder name
  displayName: string;   // human readable
  url: string | null;    // download URL (constructed or direct)
  sourceUrl: string | null; // original mod page URL
  source: DownloadSource;
  owner?: string;        // GitHub owner
  repo?: string;         // GitHub repo
  tag?: string;          // release tag
  siteName: string;      // "GitHub", "Weasel Mods", etc.
}

/** Build download info for a mod given Forge data.
 *
 * Resolution order:
 *   1. `dl` override on the mod entry — full URL, used verbatim
 *   2. `src` override forces a DownloadSource (e.g. "manual")
 *   3. GitHub URL detection from `u`, with `branch` override for the
 *      no-release-tag fallback (default "main")
 *   4. Host-based detection (Weasel Mods, etc.)
 *   5. Fallback: manual
 */
export function buildDownloadInfo(
  tp2Name: string,
  displayName: string,
  modIndex: Record<string, ModIndexEntry>,
  versionCache: VersionCache,
): DownloadInfo {
  // Find the mod in the index by tp2 name
  let entry: ModIndexEntry | undefined;
  let modUrl: string | null = null;
  for (const e of Object.values(modIndex)) {
    if (e.t && e.t.toLowerCase() === tp2Name.toLowerCase()) {
      entry = e;
      modUrl = (e.u as string) || null;
      displayName = e.n || displayName;
      break;
    }
  }

  // Tier 1a override #1: explicit `dl` URL takes precedence over construction.
  // This is the Forge-controlled escape hatch — any URL the runner can't
  // construct correctly (master-branch fallback, weird hosts, archive
  // redirects, etc.) can be hand-corrected without a Runner release.
  if (entry?.dl) {
    return {
      modName: tp2Name, displayName, url: entry.dl, sourceUrl: modUrl,
      source: entry.src || "direct",
      siteName: entry.src === "manual" ? "Manual" : "Forge override",
    };
  }

  // Tier 1a override #2: explicit `src` of "manual" forces manual flow even
  // when we have a URL we'd otherwise auto-download.
  if (entry?.src === "manual") {
    return {
      modName: tp2Name, displayName, url: null, sourceUrl: modUrl,
      source: "manual", siteName: "Manual",
    };
  }

  if (!modUrl) {
    return { modName: tp2Name, displayName, url: null, sourceUrl: null, source: "none", siteName: "Unknown" };
  }

  // Check if GitHub
  const ghMatch = modUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (ghMatch) {
    const owner = ghMatch[1];
    const repo = ghMatch[2].replace(/\.git$/, "");
    const cacheKey = `${owner}/${repo}`;

    // Check version cache for release info
    const cached = versionCache[cacheKey];
    if (cached?.tag) {
      // Has a known release tag — use source archive URL (always works, no API needed)
      const archiveUrl = `https://github.com/${owner}/${repo}/archive/refs/tags/${cached.tag}.zip`;
      return {
        modName: tp2Name, displayName, url: archiveUrl, sourceUrl: modUrl,
        source: "github_release", owner, repo, tag: cached.tag, siteName: "GitHub",
      };
    }

    // No release — download default branch as zip. Tier 1a override #3:
    // Forge can specify `branch: "master"` for repos that haven't migrated.
    const branch = entry?.branch || "main";
    const archiveUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.zip`;
    return {
      modName: tp2Name, displayName, url: archiveUrl, sourceUrl: modUrl,
      source: "github_archive", owner, repo, siteName: "GitHub",
    };
  }

  // Check for direct-downloadable sites
  let host: string;
  try {
    host = new URL(modUrl).hostname.toLowerCase();
  } catch {
    // Malformed URL — treat as manual
    return { modName: tp2Name, displayName, url: null, sourceUrl: modUrl, source: "manual", siteName: "Unknown" };
  }

  // Weasel Mods URLs are download pages (HTML), not direct file links
  if (host.includes("weaselmods.net")) {
    return {
      modName: tp2Name, displayName, url: null, sourceUrl: modUrl,
      source: "manual", siteName: "Weasel Mods",
    };
  }

  // Everything else: manual download with browser link
  const siteNames: Record<string, string> = {
    "gibberlings3.net": "Gibberlings Three",
    "www.gibberlings3.net": "Gibberlings Three",
    "forums.beamdog.com": "Beamdog Forums",
    "www.shsforums.net": "Spellhold Studios",
    "spellholdstudios.net": "Spellhold Studios",
    "www.nexusmods.com": "Nexus Mods",
    "artisans-corner.com": "Artisan's Corner",
    "www.pocketplane.net": "Pocket Plane Group",
    "gitlab.com": "GitLab",
  };
  const siteName = siteNames[host] || host;

  return {
    modName: tp2Name, displayName, url: null, sourceUrl: modUrl,
    source: "manual", siteName,
  };
}

// ─── Presets & Community Builds ───

export const TELEMETRY_BASE_URL = "https://anprionsa.github.io/infinity-mod-telemetry";

export interface ForgePreset {
  id: string;
  name: string;
  desc: string;
  icon: string;
  color: string;
  keys: string[];
  tier?: number;
  difficulty?: string;
  hash?: string;
  /** Key format version: 1 = idx-based (legacy), 2 = wc-based (stable). Absent = 1. */
  schemaVersion?: number;
}

export interface CommunityBuildMeta {
  id: string;
  name: string;
  desc: string;
  author: string;
  icon: string;
  color: string;
  tier: number;
  difficulty: string;
  focus: string[];
  modCount: number;
  componentCount: number;
  forgeVersion: string;
  createdAt: string;
  /** Key format version: 1 = idx-based (legacy), 2 = wc-based (stable). Absent = 1. */
  schemaVersion?: number;
  /** Build-specific semver-ish version; bumped when the author publishes an update. Defaults "1.0.0". */
  version?: string;
  /** ISO timestamp of the last update. Defaults to createdAt. */
  updatedAt?: string;
  /** GitHub username of the original author; used by the aggregator to authorize updates. */
  authorGitHub?: string;
}

export interface CommunityBuild extends CommunityBuildMeta {
  keys: string[];
}

export async function fetchPresets(baseUrl: string): Promise<ForgePreset[]> {
  const resp = await fetch(`${baseUrl}/data/presets.json`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function fetchCommunityBuildIndex(telemetryUrl?: string): Promise<CommunityBuildMeta[]> {
  const base = telemetryUrl || TELEMETRY_BASE_URL;
  const urls = [
    `${base}/data/builds/_index.json`,
    "https://raw.githubusercontent.com/Anprionsa/infinity-mod-telemetry/main/data/builds/_index.json",
  ];
  for (const url of urls) {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const text = await resp.text();
        if (text.startsWith("[") || text.startsWith("{")) return JSON.parse(text);
      }
    } catch { /* try next */ }
  }
  return [];
}

export async function fetchCommunityBuild(id: string, telemetryUrl?: string): Promise<CommunityBuild | null> {
  const base = telemetryUrl || TELEMETRY_BASE_URL;
  const urls = [
    `${base}/data/builds/${id}.json`,
    `https://raw.githubusercontent.com/Anprionsa/infinity-mod-telemetry/main/data/builds/${id}.json`,
  ];
  for (const url of urls) {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const text = await resp.text();
        if (text.startsWith("{")) return JSON.parse(text);
      }
    } catch { /* try next */ }
  }
  return null;
}

/** BG1:EE phase categories — mods in these categories go to the bgee log */
const BGEE_CATEGORIES = new Set(["PRE EET BGEE MODS"]);

/**
 * Resolve preset/build keys into WeiDU.log text.
 * Keys are either:
 *   - schemaVersion 1 (or absent): "modId-compIdx" — array index into mod.co (legacy, volatile)
 *   - schemaVersion 2: "modId-wc" — WeiDU component number (stable across mod updates)
 * Returns separate EET and BG1:EE logs.
 */
export async function resolvePresetToLog(
  baseUrl: string,
  keys: string[],
  language: string,
  schemaVersion: number = 1,
): Promise<{ eetLog: string; bgeeLog: string | null; modCount: number; skipped: number }> {
  // Fetch mod index
  const indexResp = await fetch(`${baseUrl}/data/mods-index.json`);
  if (!indexResp.ok) throw new Error(`Failed to fetch mod index: ${indexResp.status}`);
  const indexArr: Record<string, unknown>[] = await indexResp.json();

  // Build id → mod lookup
  const modsById = new Map<number, Record<string, unknown>>();
  for (const entry of indexArr) {
    const id = entry.i as number;
    if (id !== undefined) modsById.set(id, entry);
  }

  // Category install order: Forge-hosted when available, local fallback otherwise
  const categoryNames = await fetchCategories(baseUrl);
  const categoryOrder = new Map<string, number>();
  categoryNames.forEach((name, idx) => categoryOrder.set(name, idx));

  // Collect all resolved components with their sort order
  interface ResolvedComp {
    line: string;
    isBgee: boolean;
    catOrder: number; // category position in install order
    ord: number;      // mod order within category
    compIdx: number;  // component index within mod (for stable sort)
  }
  const resolved: ResolvedComp[] = [];
  let skipped = 0;
  const seenMods = new Set<string>();

  for (const key of keys) {
    const dashIdx = key.indexOf("-");
    if (dashIdx < 0) { skipped++; continue; }
    const modId = parseInt(key.substring(0, dashIdx), 10);
    const secondPart = parseInt(key.substring(dashIdx + 1), 10);
    if (isNaN(modId) || isNaN(secondPart)) { skipped++; continue; }

    const mod = modsById.get(modId);
    if (!mod) { skipped++; continue; }

    const tp2Name = (mod.t as string) || "";
    const coWC = (mod.coWC as number[]) || [];
    const coWF = (mod.coWF as (string | null)[]) || [];
    const coNames = (mod.coNames as string[]) || [];
    const langs = (mod.langs as Record<string, number>) || {};
    const category = (mod.c as string) || "";
    const ord = (mod.ord as number) ?? 9999;

    // Derive (compIdx, weiduComp) from key based on schemaVersion.
    // v1: secondPart is compIdx; weiduComp = coWC[compIdx]
    // v2: secondPart is wc;      compIdx = coWC.indexOf(wc)
    let compIdx: number;
    let weiduComp: number;
    if (schemaVersion >= 2) {
      compIdx = coWC.indexOf(secondPart);
      if (compIdx < 0) { skipped++; continue; }
      weiduComp = secondPart;
    } else {
      if (secondPart >= coWC.length) { skipped++; continue; }
      compIdx = secondPart;
      weiduComp = coWC[compIdx];
    }

    const rawFolder = compIdx < coWF.length ? coWF[compIdx] : null;
    const folder = (rawFolder != null && rawFolder !== "") ? rawFolder : tp2Name;
    const compName = (compIdx < coNames.length && coNames[compIdx]) ? coNames[compIdx] : `Component ${weiduComp}`;
    const langIdx = langs[language] ?? langs["en"] ?? 0;

    // Build WeiDU log line — use folder name for both path parts
    // WeiDU resolves "folder\folder.tp2" or "folder\setup-folder.tp2" automatically
    const tp2Path = `${folder}\\${folder}.TP2`;
    const line = `~${tp2Path}~ #${langIdx} #${weiduComp} // ${compName}`;

    seenMods.add(tp2Name.toLowerCase());
    const catOrder = categoryOrder.get(category) ?? 999;
    resolved.push({ line, isBgee: BGEE_CATEGORIES.has(category), catOrder, ord, compIdx });
  }

  // Sort by category order, then by mod order within category, then by component index
  resolved.sort((a, b) => a.catOrder - b.catOrder || a.ord - b.ord || a.compIdx - b.compIdx);

  const header = "// Log of Currently Installed WeiDU Mods";
  const eetLines = [header, "// Generated by Infinity Mod Runner from Forge preset"];
  const bgeeLines = [header, "// Generated by Infinity Mod Runner from Forge preset (BG1:EE phase)"];

  for (const r of resolved) {
    if (r.isBgee) bgeeLines.push(r.line);
    else eetLines.push(r.line);
  }

  return {
    eetLog: eetLines.join("\n"),
    bgeeLog: bgeeLines.length > 2 ? bgeeLines.join("\n") : null,
    modCount: seenMods.size,
    skipped,
  };
}

/** Focus tag display labels */
export const FOCUS_LABELS: Record<string, string> = {
  story: "Story & Quests",
  npc: "Companions & NPCs",
  tactical: "Smarter Enemies",
  visual: "Visual & Audio",
  qol: "Quality of Life",
  romance: "Romance",
  class: "Classes & Kits",
  tweak: "Tweaks",
};

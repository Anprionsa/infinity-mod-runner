/// Fetch JSON data from the hosted Forge.

export interface KnownIssue {
  pattern: string;
  mod: string;
  severity: "critical" | "error" | "warning" | "info";
  known: boolean;
  description: string;
  workaround: string;
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
  description: string;
  workaround: string;
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
          known: true,
          description: ki.description,
          workaround: ki.workaround,
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
const VANILLA_KITS = 55;     // Approximate vanilla kit count

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

/** Mod index entry with URL and basic info */
export interface ModIndexEntry {
  i: number;
  t: string;  // tp2 folder name
  n: string;  // display name
  u?: string; // URL
  [key: string]: unknown;
}

/** GitHub mod metadata from github_mods.json */
export interface GitHubMod {
  i: number;  // mod ID
  o: string;  // owner
  r: string;  // repo
  pushed?: string;
  stars?: number;
  archived?: boolean;
}

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

/** Fetch the full mod index */
export async function fetchModIndex(
  baseUrl: string,
): Promise<Record<string, ModIndexEntry>> {
  const resp = await fetch(`${baseUrl}/data/mods-index.json`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/** Fetch GitHub mod metadata */
export async function fetchGitHubMods(
  baseUrl: string,
): Promise<GitHubMod[]> {
  const resp = await fetch(`${baseUrl}/data/github_mods.json`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/** Fetch version cache (GitHub release info) */
export async function fetchVersionCache(
  baseUrl: string,
): Promise<VersionCache> {
  const resp = await fetch(`${baseUrl}/data/version_cache.json`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
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

/** Build download info for a mod given Forge data */
export function buildDownloadInfo(
  tp2Name: string,
  displayName: string,
  modIndex: Record<string, ModIndexEntry>,
  _githubMods: GitHubMod[],
  versionCache: VersionCache,
): DownloadInfo {
  // Find the mod in the index by tp2 name
  let modUrl: string | null = null;
  for (const entry of Object.values(modIndex)) {
    if (entry.t && entry.t.toLowerCase() === tp2Name.toLowerCase()) {
      modUrl = (entry.u as string) || null;
      displayName = entry.n || displayName;
      break;
    }
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

    // No release — download default branch as zip
    const archiveUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/main.zip`;
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

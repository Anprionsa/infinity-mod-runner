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
  const nameToFile = new Map<string, string>();
  for (const [id, info] of Object.entries(modIndex)) {
    const tp2Name = (info.t || "").toLowerCase();
    const filename = catalog[id];
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

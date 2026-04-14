import type { LogEntry, ParsedLog } from "../App";

/**
 * Parse a WeiDU.log file into structured entries.
 * Format: ~MOD_NAME\MOD_TP_FILE.TP2~ #LANG #COMPONENT // COMPONENT_NAME [-> SUB_COMPONENT] [: VERSION]
 */
export function parseWeiduLog(raw: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    // Match: ~path/to/file.tp2~ #lang #comp // name
    const match = trimmed.match(
      /^~([^~]+)~\s+#(\d+)\s+#(\d+)\s*(?:\/\/\s*(.*))?$/,
    );
    if (!match) continue;

    const fullPath = match[1];
    const lang = match[2];
    const component = match[3];
    const comment = match[4] || "";

    // Extract mod name and tp_file from path
    // Use tp2 filename (without extension) as mod_name — more reliable than folder name
    // Strip common "SETUP-" prefix: "SETUP-EEFIXPACK.TP2" → "eefixpack"
    // e.g. "eet\EET_end\EET_end.tp2" → mod_name "eet_end", tp_file "EET_end.tp2"
    const pathParts = fullPath.replace(/\\/g, "/").split("/");
    const tp_file = pathParts[pathParts.length - 1];
    const mod_name = tp_file
      .replace(/\.tp2$/i, "")
      .replace(/^setup-/i, "")
      .toLowerCase();

    // Parse comment: "Component Name -> Sub Component : Version"
    let component_name = comment;
    let sub_component = "";
    let version = "";

    // Version is after the last colon, but only if it looks like a version string
    // (e.g., "1.0", "v2.3.1", "35.21", "Beta 4"). Avoid splitting on colons
    // that are part of the component name (e.g., "Imoen 4 Ever in SoD: Imoen Returns...")
    const versionIdx = comment.lastIndexOf(":");
    if (versionIdx > 0) {
      const candidate = comment.slice(versionIdx + 1).trim();
      // Only treat as version if it's short and starts with a digit or 'v'
      if (candidate.length <= 20 && /^[v\d]/.test(candidate)) {
        version = candidate;
        component_name = comment.slice(0, versionIdx).trim();
      }
    }

    const subIdx = component_name.indexOf("->");
    if (subIdx > 0) {
      sub_component = component_name.slice(subIdx + 2).trim();
      component_name = component_name.slice(0, subIdx).trim();
    }

    entries.push({
      tp_file,
      mod_name: mod_name.toLowerCase(),
      lang,
      component,
      component_name,
      sub_component,
      version,
    });
  }
  return entries;
}

/**
 * Build a full ParsedLog from raw WeiDU.log text (and optional BGEE log).
 */
export function buildParsedLog(
  raw: string,
  bgeeRaw?: string | null,
  eetLogPath?: string | null,
  bgeeLogPath?: string | null,
): ParsedLog {
  const entries = parseWeiduLog(raw);
  const bgeeEntries = bgeeRaw ? parseWeiduLog(bgeeRaw) : null;

  const uniqueMods = new Set(entries.map((e) => e.mod_name));
  if (bgeeEntries) {
    bgeeEntries.forEach((e) => uniqueMods.add(e.mod_name));
  }

  return {
    entries,
    bgeeEntries,
    modCount: uniqueMods.size,
    componentCount: entries.length + (bgeeEntries?.length || 0),
    raw,
    bgeeRaw: bgeeRaw || null,
    eetLogPath: eetLogPath || null,
    bgeeLogPath: bgeeLogPath || null,
  };
}

/**
 * Filter raw WeiDU.log text, removing lines whose mod_name:component
 * key is in the excluded set. Returns the filtered raw text.
 */
export function filterLogText(raw: string, excluded: Set<string>): string {
  if (excluded.size === 0) return raw;
  return raw
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) return true; // Keep comments/blanks
      const match = trimmed.match(/^~([^~]+)~\s+#(\d+)\s+#(\d+)/);
      if (!match) return true; // Keep unrecognized lines
      const fullPath = match[1];
      const component = match[3];
      const pathParts = fullPath.replace(/\\/g, "/").split("/");
      const tp_file = pathParts[pathParts.length - 1];
      const mod_name = tp_file
        .replace(/\.tp2$/i, "")
        .replace(/^setup-/i, "")
        .toLowerCase();
      const key = `${mod_name}:${component}`;
      return !excluded.has(key);
    })
    .join("\n");
}

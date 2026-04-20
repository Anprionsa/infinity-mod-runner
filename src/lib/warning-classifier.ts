/**
 * Warning classification engine.
 *
 * Takes raw `WARNING:` stdout lines captured by the Rust runner (one
 * `warnings: string[]` per `ComponentResult`) and resolves each line to a
 * known-issue entry — either a per-mod `ki` pattern from the Forge or a
 * global pattern from `known_issues.json` with `mod: "*"`.
 *
 * The runner ships raw lines rather than pre-classified metadata so the
 * catalog can be updated via a Forge CDN refresh without requiring a
 * Rust rebuild. Classification happens in the frontend where the forge
 * data is already cached.
 *
 * Matching priority:
 *   1. Per-mod `ki` patterns for the batch's mod (most specific)
 *   2. Global `known_issues.json` patterns with `mod: "*"`
 *   3. No match → "unknown" category (user signal to triage)
 *
 * Regex engine: JavaScript's built-in. Patterns in the Forge data use
 * ripgrep-compatible syntax, which is a superset of what JS RegExp
 * accepts for the shapes we use (alternation, character classes,
 * quantifiers, escaped literals). Pre-compiled and cached per pattern
 * string to avoid re-parsing during render.
 */

import type {
  KnownIssue,
  KnownIssueCategory,
  KnownIssueUserAction,
} from "./forge-data";

/** The classification result for a single raw warning line. */
export interface ClassifiedWarning {
  /** The raw WeiDU output line as captured. */
  line: string;
  /** The matched catalog entry, if any. Undefined when no pattern matched. */
  match: KnownIssue | undefined;
  /** Effective category — `match.category` when classified, else `"unknown"`. */
  category: KnownIssueCategory | "unknown";
  /** Effective user action — `match.user_action` when classified, else `undefined`. */
  userAction: KnownIssueUserAction | undefined;
}

/** Aggregate breakdown for a list of classified warnings. Used to render
 * the header badge (`6 cosmetic · 1 unknown`). */
export interface WarningSummary {
  total: number;
  byCategory: Record<KnownIssueCategory | "unknown", number>;
  /** Highest-concern category present, in strict order:
   *  concerning > caution > likely-benign > cosmetic > unknown (if nothing classified).
   *  Drives the header color. */
  worstCategory: KnownIssueCategory | "unknown";
}

// ── Pattern cache ──────────────────────────────────────────────────────────
// Compiling a regex is not free; a batch with 50 warnings × 36 global patterns
// + per-mod would be 1800+ compilations if we didn't cache. Cache is keyed by
// the literal pattern string — catalog reloads invalidate by replacing the
// map reference, not by mutation.
const regexCache = new Map<string, RegExp | null>();

function compilePattern(pattern: string): RegExp | null {
  if (regexCache.has(pattern)) return regexCache.get(pattern)!;
  try {
    // Case-insensitive matching is safer — WeiDU's output casing varies
    // (lowercase from older mods, TitleCase from newer ones, SCREAMING in
    // SFO's custom message functions). All our catalog patterns are
    // written case-insensitive already.
    const re = new RegExp(pattern, "i");
    regexCache.set(pattern, re);
    return re;
  } catch (e) {
    // A malformed pattern disables that entry without killing classification
    // of the rest. Log once so the catalog author can find and fix it.
    if (typeof console !== "undefined") {
      console.warn(`warning-classifier: bad regex ${JSON.stringify(pattern)}: ${String(e)}`);
    }
    regexCache.set(pattern, null);
    return null;
  }
}

/**
 * Classify a single warning line against the catalog.
 *
 * `modName` should be the mod's tp2 name (lowercase, e.g. "stratagems") —
 * per-mod matches come from the same mod field that WeiDU stamps on its
 * INSTALLED lines, so batch → mod lookup is unambiguous.
 */
export function classifyWarning(
  line: string,
  modName: string,
  catalog: KnownIssue[],
): ClassifiedWarning {
  const modLc = modName.toLowerCase();

  // Two-pass: per-mod first (pattern specificity wins), then global
  // ("mod: *" entries) so a generic TRA-tag pattern doesn't override a
  // mod-specific "this TRA tag means X for THIS mod".
  for (const entry of catalog) {
    if (entry.mod === "*" || entry.mod.toLowerCase() !== modLc) continue;
    const re = compilePattern(entry.pattern);
    if (re && re.test(line)) {
      return {
        line,
        match: entry,
        category: entry.category ?? "unknown",
        userAction: entry.user_action,
      };
    }
  }
  for (const entry of catalog) {
    if (entry.mod !== "*") continue;
    const re = compilePattern(entry.pattern);
    if (re && re.test(line)) {
      return {
        line,
        match: entry,
        category: entry.category ?? "unknown",
        userAction: entry.user_action,
      };
    }
  }

  return { line, match: undefined, category: "unknown", userAction: undefined };
}

/**
 * Classify all warnings for a batch of components. Returns per-line
 * classifications plus an aggregate summary suitable for rendering a
 * breakdown badge in the Issues panel.
 */
export function classifyBatchWarnings(
  warningsByComponent: Array<{ modName: string; warnings: string[] }>,
  catalog: KnownIssue[],
): { classified: ClassifiedWarning[][]; summary: WarningSummary } {
  const classified: ClassifiedWarning[][] = warningsByComponent.map(
    ({ modName, warnings }) =>
      warnings.map((line) => classifyWarning(line, modName, catalog)),
  );

  const byCategory: Record<KnownIssueCategory | "unknown", number> = {
    cosmetic: 0,
    "likely-benign": 0,
    caution: 0,
    concerning: 0,
    unknown: 0,
  };
  let total = 0;
  for (const lines of classified) {
    for (const c of lines) {
      byCategory[c.category] += 1;
      total += 1;
    }
  }

  // worstCategory ordering: concerning > caution > likely-benign > cosmetic.
  // Unknown is weaker than concerning but stronger than cosmetic because
  // "we haven't triaged this" deserves more attention than "we know it's
  // fine", but less than "we know it's a real problem."
  const priority: Array<KnownIssueCategory | "unknown"> = [
    "concerning",
    "caution",
    "unknown",
    "likely-benign",
    "cosmetic",
  ];
  const worstCategory = priority.find((c) => byCategory[c] > 0) ?? "cosmetic";

  return { classified, summary: { total, byCategory, worstCategory } };
}

/** Short, user-readable label for a category — used in chips and summary
 * breakdowns. Intentionally not i18n-keyed yet; this surface is still
 * trialing and the vocabulary may shift. */
export function categoryLabel(category: KnownIssueCategory | "unknown"): string {
  switch (category) {
    case "cosmetic": return "cosmetic";
    case "likely-benign": return "likely benign";
    case "caution": return "caution";
    case "concerning": return "concerning";
    case "unknown": return "unknown";
  }
}

/** CSS color for a category chip/badge. Mirrors the Forge README rubric
 * and matches the existing --grn/--org/--red tokens where sensible. */
export function categoryColor(category: KnownIssueCategory | "unknown"): {
  fg: string;
  bg: string;
  border: string;
} {
  switch (category) {
    case "cosmetic":
      return { fg: "#9ca3af", bg: "rgba(156,163,175,0.12)", border: "#4b5563" };
    case "likely-benign":
      return { fg: "#60a5fa", bg: "rgba(96,165,250,0.12)", border: "#2563eb" };
    case "caution":
      return { fg: "#fbbf24", bg: "rgba(251,191,36,0.15)", border: "#d97706" };
    case "concerning":
      return { fg: "#f87171", bg: "rgba(248,113,113,0.15)", border: "#dc2626" };
    case "unknown":
      return { fg: "#a78bfa", bg: "rgba(167,139,250,0.12)", border: "#7c3aed" };
  }
}

/** Build a human-readable summary string:
 *   "7 warnings · 5 cosmetic · 1 caution · 1 unknown"
 * Empty categories are omitted. When total is 0, returns "no warnings". */
export function summaryText(summary: WarningSummary): string {
  if (summary.total === 0) return "no warnings";
  const parts: string[] = [`${summary.total} ${summary.total === 1 ? "warning" : "warnings"}`];
  const order: Array<KnownIssueCategory | "unknown"> = [
    "concerning", "caution", "unknown", "likely-benign", "cosmetic",
  ];
  for (const c of order) {
    const n = summary.byCategory[c];
    if (n > 0) parts.push(`${n} ${categoryLabel(c)}`);
  }
  return parts.join(" · ");
}

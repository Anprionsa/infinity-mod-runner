/**
 * Install Report — anonymized structured summary of an install run.
 * Schema v1: per-component outcomes, no file paths, no usernames.
 */

import type { ParsedLog, LogEntry } from "../App";
import type { ErrorLogEntry } from "./tauri-bridge";
import type { KnownIssue, ModKnownIssue } from "./forge-data";

// ─── Schema ───

export interface InstallReport {
  schema: 1;
  id: string;
  timestamp: string;

  // Environment (anonymized — no paths)
  os: "windows" | "linux" | "macos";
  weiduVersion: string;
  runnerVersion: string;
  forgeDataDate: string;

  // Selection summary
  presetId: string | null;
  totalMods: number;
  totalComponents: number;

  // Per-component outcomes
  components: ComponentOutcome[];

  // Aggregates
  durationSeconds: number;
  engineLimits: { kits: number; splstates: number } | null;
}

export interface ComponentOutcome {
  modId: number;       // Forge mod ID (-1 if unmatched)
  ci: number;          // Component index in Forge's co[] array (-1 if unmatched)
  cn: number;          // WeiDU component number
  tp2: string;         // tp2 folder name (e.g. "stratagems")
  outcome: "ok" | "err" | "skip" | "crash";
  errorPattern: string | null;
}

// ─── Forge index types (lightweight, fetched at runtime) ───

export interface ForgeModIndex {
  i: number;
  t: string;   // tp2 folder name
  co: { cn: number }[];
}

// ─── Generation ───

function detectOS(): "windows" | "linux" | "macos" {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("win")) return "windows";
  if (ua.includes("mac")) return "macos";
  return "linux";
}

/**
 * Match a WeiDU log entry to a Forge mod index entry.
 * Returns { modId, ci } or null.
 */
function matchToForge(
  entry: LogEntry,
  tp2ToMod: Map<string, ForgeModIndex>,
): { modId: number; ci: number } | null {
  const mod = tp2ToMod.get(entry.mod_name);
  if (!mod) return null;

  const cn = parseInt(entry.component, 10);
  const ci = mod.co.findIndex((c) => c.cn === cn);
  return { modId: mod.i, ci: ci >= 0 ? ci : -1 };
}

/**
 * Match an error message against known issue patterns.
 * Returns the first matching pattern string, or null.
 */
function matchErrorPattern(
  message: string,
  globalKI: KnownIssue[],
  modKI: ModKnownIssue[],
): string | null {
  for (const ki of modKI) {
    try {
      if (new RegExp(ki.pattern, "i").test(message)) return ki.pattern;
    } catch { /* skip bad regex */ }
  }
  for (const ki of globalKI) {
    try {
      if (new RegExp(ki.pattern, "i").test(message)) return ki.pattern;
    } catch { /* skip bad regex */ }
  }
  return null;
}

/**
 * Categorize an error entry's severity into an outcome.
 */
function errorToOutcome(entry: ErrorLogEntry): "err" | "crash" | "skip" {
  const level = entry.level.toUpperCase();
  if (level === "SKIP") return "skip";
  const msg = entry.message.toLowerCase();
  if (msg.includes("fatal") || msg.includes("segfault") || msg.includes("access violation")) {
    return "crash";
  }
  return "err";
}

/**
 * Generate an InstallReport from the completed install state.
 */
export function generateReport(opts: {
  parsedLog: ParsedLog;
  errorEntries: ErrorLogEntry[];
  bg1Status: unknown | null;
  bg2Status: unknown | null;
  exitCode: number;
  elapsedMs: number;
  weiduVersion: string;
  forgeIndex: ForgeModIndex[];
  globalKI: KnownIssue[];
  modKIByTp2: Map<string, ModKnownIssue[]>;
  resourceUsage: { kits: number; splstates: number } | null;
}): InstallReport {
  const {
    parsedLog, errorEntries, elapsedMs,
    weiduVersion, forgeIndex, globalKI, modKIByTp2, resourceUsage,
  } = opts;

  // Build tp2 name → Forge mod lookup
  const tp2ToMod = new Map<string, ForgeModIndex>();
  for (const mod of forgeIndex) {
    tp2ToMod.set(mod.t.toLowerCase(), mod);
  }

  // Build error lookup: "tp2:cn" → ErrorLogEntry[]
  const errorsByKey = new Map<string, ErrorLogEntry[]>();
  for (const e of errorEntries) {
    // Error log entries have mod_name which is the tp2 folder
    // and message which may contain component number
    const key = e.mod_name.toLowerCase();
    const existing = errorsByKey.get(key) || [];
    existing.push(e);
    errorsByKey.set(key, existing);
  }

  // Map all log entries (EET + BGEE) to component outcomes
  const allEntries = [
    ...parsedLog.entries,
    ...(parsedLog.bgeeEntries || []),
  ];

  // Track which error entries we've consumed
  const consumedErrors = new Set<ErrorLogEntry>();

  const components: ComponentOutcome[] = allEntries.map((entry) => {
    const forge = matchToForge(entry, tp2ToMod);
    const cn = parseInt(entry.component, 10);
    const tp2 = entry.mod_name;

    // Check if there's an error for this mod
    const modErrors = errorsByKey.get(tp2.toLowerCase()) || [];
    const matchedError = modErrors.find((e) => {
      if (consumedErrors.has(e)) return false;
      // Error log entries contain component number in the message or mod_name field
      // Match by mod name — component-level matching is best-effort
      const cnStr = `#${cn}`;
      return e.message.includes(cnStr) || e.message.includes(entry.component_name);
    });

    // If no component-specific match, check for any unconsumed error/skip for this mod
    const anyModError = matchedError || modErrors.find((e) => !consumedErrors.has(e) && (e.level === "ERROR" || e.level === "SKIP"));

    let outcome: ComponentOutcome["outcome"] = "ok";
    let errorPattern: string | null = null;

    if (anyModError) {
      consumedErrors.add(anyModError);
      outcome = errorToOutcome(anyModError);
      const modKI = modKIByTp2.get(tp2.toLowerCase()) || [];
      errorPattern = matchErrorPattern(anyModError.message, globalKI, modKI);
    }

    return {
      modId: forge?.modId ?? -1,
      ci: forge?.ci ?? -1,
      cn,
      tp2,
      outcome,
      errorPattern,
    };
  });

  // Count unique mods
  const uniqueMods = new Set(allEntries.map((e) => e.mod_name));

  return {
    schema: 1,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    os: detectOS(),
    weiduVersion: weiduVersion || "unknown",
    runnerVersion: __APP_VERSION__,
    forgeDataDate: new Date().toISOString().substring(0, 10),
    presetId: null, // Will be set by caller if known
    totalMods: uniqueMods.size,
    totalComponents: allEntries.length,
    components,
    durationSeconds: Math.round(elapsedMs / 1000),
    engineLimits: resourceUsage,
  };
}

// ─── High-level builder (fetches Forge data, generates report) ───

/**
 * Build a complete InstallReport by fetching Forge data and mapping outcomes.
 * Self-contained: only needs the install state and a forge base URL.
 */
export async function buildReport(opts: {
  parsedLog: ParsedLog;
  errorEntries: ErrorLogEntry[];
  bg1Status: unknown | null;
  bg2Status: unknown | null;
  exitCode: number;
  elapsedMs: number;
  weiduVersion: string;
  forgeBaseUrl: string;
}): Promise<InstallReport> {
  const { forgeBaseUrl, ...rest } = opts;

  // Fetch mods-index for tp2 name → mod ID mapping
  let forgeIndex: ForgeModIndex[] = [];
  try {
    const resp = await fetch(`${forgeBaseUrl}/data/mods-index.json`);
    if (resp.ok) {
      const raw = await resp.json();
      forgeIndex = (Array.isArray(raw) ? raw : []).map((m: Record<string, unknown>) => ({
        i: (m.i as number) || 0,
        t: ((m.t as string) || "").toLowerCase(),
        co: Array.isArray(m.co) ? m.co.map((c: Record<string, unknown>) => ({ cn: (c.cn as number) ?? 0 })) : [],
      }));
    }
  } catch { /* offline — report will have modId: -1 for all components */ }

  // Fetch global known issues
  let globalKI: KnownIssue[] = [];
  try {
    const resp = await fetch(`${forgeBaseUrl}/data/known_issues.json`);
    if (resp.ok) globalKI = await resp.json();
  } catch { /* offline */ }

  return generateReport({
    ...rest,
    forgeIndex,
    globalKI,
    modKIByTp2: new Map(), // Per-mod ki requires per-file fetches; skip for v1
    resourceUsage: null,   // Engine limits not tracked during install yet
  });
}

// Injected by Vite from package.json
declare const __APP_VERSION__: string;

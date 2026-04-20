/** Per-component baseline duration classes (seconds, on the reference rig
 * with no accelerators). Used by the ETA calculator when a component's
 * Forge entry lacks an explicit `installProfile.baselineSec`.
 *
 * These defaults are intentionally generous on the heavy end — a heavy
 * component's real duration varies from ~60s to ~15min, and picking
 * a middle value means the ETA won't swing as much when the user's rig
 * differs from the reference. The EWMA reality-factor catches rig drift. */
export type HeavyClass = "light" | "medium" | "heavy";

export const CLASS_DEFAULT_BASELINE_SEC: Record<HeavyClass, number> = {
  light: 5,
  medium: 60,
  heavy: 300,
};

/** Mods whose components are ALWAYS treated as heavy regardless of Forge
 * profile data. Mirrors `FORCE_SMALL_BATCH_MODS` in
 * `src-tauri/src/installer/mod.rs` — these mods get batch size 3 on the
 * backend, and their components are uniformly expensive on the frontend
 * ETA too. Lowercase for case-insensitive matching against `mod_name`. */
export const FORCE_HEAVY_MODS: readonly string[] = [
  "mih_eq",
  "mih_ip",
  "mih_tweaks",
  "trap_overhaul",
  "dw_talents",
  "stratagems",
];

/** Mods that are known to have medium-weight components when no profile
 * data is available. Used as a broad bucket above the "light default"
 * for typical content/tweak mods. */
export const FORCE_MEDIUM_MODS: readonly string[] = [
  "ascension",
  "item_rev",
  "spell_rev",
  "iwdification",
  "tdd",
  "tdds",
  "tddz",
  "bg1npc",
  "eefixpack",
  "cdtweaks",
  "eetweaks",
  "tweaks_anthology",
  "eet",
  "eet_end",
  "eet_tweaks",
];

/** Classify a mod (by tp2 name, case-insensitive) into a default heavyClass
 * when component-level profile data isn't available. */
export function inferHeavyClass(modName: string): HeavyClass {
  const lc = modName.toLowerCase();
  if (FORCE_HEAVY_MODS.includes(lc)) return "heavy";
  if (FORCE_MEDIUM_MODS.includes(lc)) return "medium";
  return "light";
}

/** Accelerator coefficients used when the Forge-hosted
 * `accelerator-profile-ref.json` can't be fetched (offline, old Forge).
 * Values are intentionally conservative so an unknown rig state doesn't
 * over-discount. */
export const FALLBACK_ACCELERATOR_COEFFICIENTS = {
  overrideFastDrive: { light: 1.0, medium: 0.75, heavy: 0.35 },
  experimentalWeidu: { light: 0.92, medium: 0.90, heavy: 0.88 },
  batchSizePenaltyPerStepBelow25: 0.006,
} as const;

export type AcceleratorCoefficients = typeof FALLBACK_ACCELERATOR_COEFFICIENTS;

export interface AcceleratorProfile {
  overrideFastDrive: boolean;
  experimentalWeidu: boolean;
  batchSize: number;
}

/** Multiplier applied to a component's baseline duration given the
 * accelerator configuration. `1.0` = no change; `< 1.0` = discount. */
export function discountCoefficient(
  p: AcceleratorProfile,
  cls: HeavyClass,
  coeffs: AcceleratorCoefficients = FALLBACK_ACCELERATOR_COEFFICIENTS,
): number {
  let d = 1.0;
  if (p.overrideFastDrive) d *= coeffs.overrideFastDrive[cls];
  if (p.experimentalWeidu) d *= coeffs.experimentalWeidu[cls];
  if (p.batchSize < 25 && cls === "light") {
    d *= 1 + (25 - p.batchSize) * coeffs.batchSizePenaltyPerStepBelow25;
  }
  return d;
}

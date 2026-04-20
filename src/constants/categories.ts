/** Fallback category display order, used when the hosted Forge data doesn't
 * expose a categories list (pre-v4.0.0 schema) or when the fetch fails.
 *
 * Source of truth is `categories.json` in the hosted Forge once v4.0.0 ships.
 * See `fetchCategories` in `lib/forge-data.ts`. */
export const FALLBACK_CATEGORY_DISPLAY_ORDER: string[] = [
  "PRE EET BGEE MODS", "EET STARTS HERE", "ENGINE", "INTERFACE",
  "GRAPHICS", "RESTORATIONS",
  "QUEST MODS BG1", "QUEST MODS BG2", "QUEST MODS ToB",
  "NEW NPC MODS", "NPC EXPANSIONS", "NPC CROSSMOD", "CREATURE MODS",
  "ITEM ADDITION MODS", "SPELL MODS", "KIT & CLASS MODS",
  "PRE-TACTICAL TWEAKS", "TACTICAL MODS", "POST-TACTICAL TWEAKS",
  "NPC CUSTOMIZATION", "POST-TACTICAL QUESTS",
  "MUSIC & AUDIO", "PORTRAITS", "EET FINALIZATION", "POST EET",
];

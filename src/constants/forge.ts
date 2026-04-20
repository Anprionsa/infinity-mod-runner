/** Threshold after which cached Forge data is considered stale and the
 * footer "X min ago" label switches to the warning color (30 minutes). */
export const FORGE_STALE_MS = 30 * 60_000;

/** Default hosted Forge base URL. Users can override via config.forge_data_url. */
export const DEFAULT_FORGE_URL = "https://anprionsa.github.io/infinity-mod-forge";

/** Public-facing Forge web-app URL — what we link to from onboarding
 * surfaces (welcome card, empty-state buttons, status-bar Forge tooltip).
 * Shares the same GitHub Pages deployment as DEFAULT_FORGE_URL; kept as
 * a named constant so "open Forge in the user's browser" is a single
 * source of truth, not re-hardcoded in every component that links to it. */
export const FORGE_WEB_URL = "https://anprionsa.github.io/infinity-mod-forge/";

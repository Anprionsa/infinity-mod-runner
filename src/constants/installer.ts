/** Default install timeout per mod, in seconds (2 hours). */
export const DEFAULT_INSTALL_TIMEOUT_S = 7200;

/** Default ceiling on components per WeiDU batch for non-heavy mods.
 * Heavy mods (dw_talents, stratagems, mih_*, trap_overhaul) use
 * `DEFAULT_HEAVY_BATCH` instead. Range 1-100. */
export const DEFAULT_MAX_BATCH = 25;

/** Per-batch cap for heavy mods that segfault WeiDU's OCaml GC at larger
 * batches. 3 has been reliably safe; raising it is a stress-test setting
 * that typically requires a stack-patched WeiDU build. Clamped 1..=25 in UI. */
export const DEFAULT_HEAVY_BATCH = 3;

/** Default poll interval (ms) for the orchestrator event loop. */
export const DEFAULT_POLL_TICK_MS = 500;

/** Default lookback depth (lines) for WeiDU error correlation. */
export const DEFAULT_LOOKBACK = 10;

/** Default directory traversal depth for mod scans. */
export const DEFAULT_DEPTH = 5;

/** Default WeiDU log mode flags. */
export const DEFAULT_WEIDU_LOG_MODE = "autolog,logapp,log-extern";

/** Default user interface language passed to WeiDU. */
export const DEFAULT_WEIDU_LANGUAGE = "en_US";

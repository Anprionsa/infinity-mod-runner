# Infinity Mod Runner — Logs & Diagnostics

Where the app writes things, what each file is for, and how to use them
when troubleshooting.

## Overview

The app writes seven log-like artifacts across three root locations.
They don't live in one folder by design — each location is load-bearing:

- **Tauri app-config dir** (`%APPDATA%\com.infinitymodforge.runner\` on
  Windows, `~/Library/Application Support/com.infinitymodforge.runner/`
  on macOS, `~/.config/com.infinitymodforge.runner/` on Linux): holds
  `gui.log` and `config.toml`. This is the OS-standard location for app
  configuration; moving out of it breaks the "Windows Settings → Apps →
  clear data" UX.
- **Data dir** (user-configurable via Setup → Data Directory, or
  `<exe-dir>\data\` by default): holds per-game subfolders, hashed from
  the BG2 game path. Each subfolder has its own `install.log`,
  `reports/`, `checkpoint.json`, `guard_report.json`. The per-game
  hash is what lets multiple game installs coexist on one machine
  without their logs getting mixed.
- **Game directory**: holds `WSETUP.DEBUG`, which WeiDU writes
  directly. Not managed by Runner — the Debug tab can parse it but
  doesn't move it.

The Debug tab's **Logs & Diagnostics** panel lists every file with
Open / Copy-path buttons — that's the canonical surface for finding
anything locally. The **Create Diagnostic Bundle** button on the same
panel packages everything into a single redacted zip ready for help
chats or bug reports.

## File reference

### `gui.log`

**Location:** `%APPDATA%\com.infinitymodforge.runner\gui.log` (Windows).

**Content:** App lifecycle events — launch, shutdown, config load/save,
tab switches, config-save failures, error-handler catches, telemetry
submissions, splash-step timings. Prefixed with `[TAG]` category markers
(`[APP]`, `[CONFIG]`, `[INSTALL]`, `[UI]`, etc.) plus a timestamp.

**Lifetime:** Spans multiple sessions. Each app launch writes a
`── SESSION START ──` divider.

**Rotation:** On launch, if the current `gui.log` is > 5 MB, the app
rotates it:
- `gui.log.3` → deleted
- `gui.log.2` → `gui.log.3`
- `gui.log.1` → `gui.log.2`
- `gui.log` → `gui.log.1`
- New empty `gui.log` starts

Additionally, on first launch after an app version bump, the previous
version's `gui.log` is renamed to `gui.log.prev-<version>` to preserve
it separately from the numbered rotation.

**Privacy:** May contain paths (game dir, mod dir, WeiDU path, etc.)
in log event messages. Eyeball before sharing publicly, or use the
Diagnostic Bundle which includes a manifest describing what's inside.
Currently **not** auto-redacted in bundles because paths appear too
pervasively to scrub safely.

### `install.log`

**Location:** `<data_dir>\<game-hash>\install.log`.

**Content:** Per-install event stream written by the Rust orchestrator
during the install. Format: one event per line, tagged with
`[EVENT_KIND]`. Every WeiDU sub-process, every batch, every component
outcome, every BCS cache dump, every PREBIFF step leaves a marker.

**Lifetime:** Appended forever. Each install session starts with:
```
================================================================================
Infinity Mod Runner Install Session — 2026-04-20 14:32:05 UTC
================================================================================
```

**Rotation:** None. Users manage manually (or via the Debug tab's
Diagnostic Bundle which only pulls the current file).

**Event types:**

| Tag | Meaning |
|---|---|
| `BATCH_START` | A new WeiDU sub-process is about to spawn with N components |
| `BATCH_DONE` | WeiDU finished; per-component outcomes follow |
| `ERROR` | A component failed outright (WeiDU exit code ≠ 0, or the orchestrator classified it an error) |
| `WARN` | A component installed with warnings. The raw WARNING: lines are captured alongside |
| `SKIP` | A component was skipped (already installed, or cascade-skipped after an earlier error) |
| `FATAL_SKIP` | WeiDU failed to start entirely (missing binary, bad tp2 path, etc.) — the batch's components are marked skipped with this reason |
| `USER_ABORT` | User clicked the Abort button |
| `ABORT_SKIP` | Components skipped as a cascade from a user abort (distinct from `FATAL_SKIP` — no WeiDU failure involved) |
| `RETRY` | Auto-retry fired on a failed batch |
| `PREBIFF` | Pre-install MAKE_BIFF step marker (memorializes whether `enable_biff_delete_optimization` was on/off and records the BIFF operation) |
| `PREBIFF_CHECK` | Pre-BIFF validation step (IDS files found, delete candidates, etc.) |
| `BCS_CACHE_STATS_JSON` | Machine-readable cache stats emitted by the patched WeiDU's `at_exit`. Parsed by Runner's analysis scripts |
| `CASCADE_START` / `CASCADE_END` | Bookends around a heavy-mod cascade (SFO memory-pressure warning band) |

**Privacy:** Paths appear in some error messages (e.g., "failed to
copy file <path>"). Component names and WeiDU output are included
verbatim. Eyeball before sharing sensitive installs.

### `config.toml`

**Location:** `%APPDATA%\com.infinitymodforge.runner\config.toml` (via
the confy crate).

**Content:** User configuration — game paths, install options, saved
preferences, telemetry opt-in state, welcome-card dismissal timestamps,
guided-mode flag, etc. TOML format, human-editable.

**Lifetime:** Written on every config save.

**Rotation:** None. If confy fails a write, the app shows an
"Config save failed" banner with an "Open config folder" action.

**Privacy:** Contains every path you've configured. The Diagnostic
Bundle's `config-redacted.toml` replaces path fields with sentinels
like `<redacted-bg2_game_dir>`; everything else (booleans, numbers,
language codes, saved preferences JSON) is kept intact.

### `install_report_*.json`

**Location:** `<data_dir>\<game-hash>\reports\install_report_<timestamp>.json`.

**Content:** Structured post-install summary — per-component outcomes,
errors, warnings, skipped counts, elapsed time, engine resource usage
(kit count, spell-per-level counts), backup info. Anonymized:
mod IDs rather than tp2 paths, no usernames, no file paths.

**Lifetime:** User-triggered via "Save Report" on the post-install
summary. Never auto-generated.

**Rotation:** None. Accumulates; the Diagnostic Bundle only includes
the latest 3.

**Privacy:** Safe to share publicly. This is the format consumed by
the Runner's anonymized telemetry submission when the user opts in.

### `guard_report.json`

**Location:** `<data_dir>\<game-hash>\guard_report.json`.

**Content:** Cross-mod file-corruption incidents detected by File Guard
during an install. Each entry: filename, md5-before, md5-after, the mod
that originally wrote it, the mod that overwrote it, and whether the
overwrite was silently restored or paused the install.

**Lifetime:** Written only when the guard fires during an install. Does
not exist for installs where no corruption was detected (the happy case).

**Rotation:** None; overwritten by each install.

**Privacy:** File paths within the game directory. Safe to share.

### `checkpoint.json`

**Location:** `<data_dir>\<game-hash>\checkpoint.json`.

**Content:** Resume state for interrupted installs — which mods
completed, which component the install was on when interrupted, the
install options used.

**Lifetime:** Cleared automatically on a successful complete. Persists
across app restarts so an abort + app-close + relaunch can pick up.

**Privacy:** Mod names and configured paths. Small file; not usually
needed for troubleshooting unless the issue is "resume failed."

### `WSETUP.DEBUG`

**Location:** Game directory root.

**Content:** WeiDU's own stdout/stderr dump from the most recent install.
Written by WeiDU itself, not by Runner.

**Lifetime:** Overwritten on each WeiDU run.

**Rotation:** WeiDU rotates within the file (keeps last N lines); no
external rotation.

**Privacy:** Contains game paths, mod names, tp2 contents. The Debug
tab's "Load" button parses this file locally — nothing is sent outside.

## Common troubleshooting flows

### "My install failed — where do I look?"

1. **Install tab's Issues panel** during/after the install: top-level
   rollup by mod. Click any row to expand the per-component detail.
2. **`install.log`** for the raw event stream: search for `[ERROR]`
   or `[FATAL_SKIP]`.
3. **`WSETUP.DEBUG`** for WeiDU's side of the story, especially if
   `install.log` shows `[FATAL_SKIP] WeiDU failed to start`.

### "My config isn't saving"

1. **`gui.log`** → search for `Backend save_config error`. The first
   match will include the OS error (disk full, permissions, read-only
   filesystem).
2. The "Config save failed" banner (top of the app, when this happens)
   has an **Open config folder** action to inspect `config.toml`
   permissions directly.

### "A specific mod keeps failing — is this a known issue?"

1. **Ready Check tab** — the pre-install validation consults Forge's
   known-issues catalog and surfaces any matches.
2. **`install.log`** — the error message will be captured verbatim;
   paste it into the Debug tab's "Load" button on your `WSETUP.DEBUG`
   afterward for cross-reference.

### "I want someone else to analyze my install"

Use the **Debug tab → Logs & Diagnostics → Create Diagnostic Bundle**
button. Outputs a zip that's safe to attach to a forum post or help
chat. Contents are described in the bundle's `BUNDLE_INFO.txt`.

## Privacy & sharing

### Safe to share publicly
- `install_report_*.json` — anonymized by design
- `guard_report.json` — no user paths (only in-game relative paths)
- The **Diagnostic Bundle's** `config-redacted.toml`

### Needs eyeballing first
- `gui.log` — may contain configured paths in event prose
- `install.log` — may contain paths in error messages
- Raw `config.toml` — has every configured path

### Sensitive
- `WSETUP.DEBUG` — WeiDU may print absolute paths. Review before
  sharing.

## Manual disk-space reclaim

If the app's on-disk footprint has grown past what you want to keep:

- **`gui.log.*`** rotated siblings can all be deleted; the app re-rotates
  cleanly on next launch.
- **`install.log`** can be moved / archived; a fresh one will be created
  on the next install. Existing analyses against it obviously break.
- **`reports/`** directory can be emptied; reports don't affect
  install correctness.
- **`checkpoint.json`** should only be deleted when the install it
  references is definitely finished or abandoned; otherwise you lose
  resume capability.
- **Backups directory** (in the user-configured `backup_directory`, not
  covered by this doc's "logs" framing) is the largest footprint; use
  the Backup Panel's delete affordance instead of manual filesystem
  operations.

Don't delete `config.toml` unless you want to start fresh (the
migration shim in the app can restore a prior-version config, but only
if you have the old file around).

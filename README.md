# EET Mod Runner

**Cross-platform desktop GUI for installing Baldur's Gate: Enhanced Edition Trilogy mods**

A Tauri v2 app with a **native Rust WeiDU driver** — drives WeiDU directly (no subprocess wrapper), with real-time progress monitoring, per-batch error recovery, backups, and auto-update. Designed as a companion to [EET Mod Forge](https://github.com/Anprionsa/eet-mod-forge) — configure your mod selection in the Forge, export the logs, and run the install here.

## Features

- **Setup wizard** — Configure BG1:EE and BG2:EE game directories with `chitin.key` validation (case-insensitive on Linux), game freshness detection, WeiDU auto-detection with version display

- **Mods panel** — Unified surface for importing Forge export logs, downloading missing mods, and browsing local state. GitHub mods download automatically via Forge's cached release data (no API key). Manual links for non-GitHub sources. Wrong-log-slot detection. Paths persisted across sessions

- **Preset browser** — Load and save complete install configurations (mod list + install options) as reusable presets

- **Ready Check** — Consolidated pre-install validation: essential mods present, all mods downloaded (batch tp2 scan), resource limits (kits, spells per level), known issues / compat data from Forge, patch applicability. Progress bar during checks; blocks install on critical errors

- **Pre-install patcher** — 35+ bundled patches fix known mod bugs in the Extracted source before WeiDU runs. Scans for applicable patches, shows checklist, applies with one click. Idempotent marker detection. Handles double-nested and arbitrarily-named mod directories via tp2-based discovery. Runtime-configurable via `patches/install_config.json` (READLN defaults, sibling dirs, force-small-batch list, OCaml GC)

- **Backup system** — Estimate/create/restore/delete snapshots of the game directory before an install. Progress events during long operations; abortable. Multiple named backups per game

- **Install runner** — Native WeiDU driver with real-time dashboard. Per-batch error recovery (Retry / Skip / Stop). Triple-source progress tracking (install log + stdout counter + weidu.log ground truth). Activity indicator, graceful abort (Ctrl+C with 10s fallback), pause/resume with user-facing banner, checkpoint on interrupt. EET two-phase support. Dry-run mode

- **Issues panel** — Errors grouped by mod with expandable details. Exit-code categorization (WeiDU Crash / Install Failed / Unknown). Skip-reason distinction (expected vs suspicious). Sorted by severity

- **Debug analysis** — Parses 500 MB+ WSETUP.DEBUG files in the Rust backend. Collapsible sections for errors, known issues, warnings, unmatched issues, and installed components. Grouped by type with occurrence counts. Copy buttons on every section. Per-mod `ki` known issues fetched from Forge

- **Install comparison** — Compare Forge export against installed WeiDU.log. Shows exactly which mods are completely missing vs partially installed. Uses imported log paths automatically

- **Install report** — Export a structured post-install report (JSON) summarizing outcomes, errors, skipped components, and elapsed time

- **Auto-update** — Signed releases via Tauri updater (minisign). Checks GitHub `latest.json` and applies updates in place

- **Internationalization** — UI available in English, German, French, and Polish (`src/lang/`)

- **GUI logger** — `gui.log` for diagnosing GUI-only issues, separate from WeiDU output

- **Forge color scheme** — Dark backgrounds with gold accents matching EET Mod Forge

## Architecture

```
Frontend (React 18 + TypeScript + Vite)
  |
  |-- invoke() ──> Rust backend (Tauri v2)
  |                  |-- installer/ ──> Native WeiDU driver
  |                  |      (orchestrator, runner, batch/dry-run, debug_mgr,
  |                  |       pe_patch, tlk_accel, install_log/log_diff, tracker, copy)
  |                  |-- backup.rs ──> Game-dir snapshot system
  |                  |-- Patch scanner/applier (patches/*)
  |                  |-- HTTP downloads (reqwest) ──> GitHub archives, direct URLs
  |                  |-- Config persistence (confy)
  |                  |-- Tauri updater (minisign)
  |
  |-- fetch() ───> Hosted Forge data (mods-index, version_cache, github_mods, ki)
```

- **Native WeiDU driver** replaces the old mod_installer subprocess — WeiDU is invoked directly with piped I/O, per-batch Retry/Skip/Stop error recovery, checkpoints, pause/resume, EET two-phase support (~4300 lines across 13 modules in `src-tauri/src/installer/`)
- **Per-game data dir** — WeiDU process lockfile, install log, checkpoint, and backups are stored in a FNV-1a-hashed subfolder so multiple game installs don't collide
- **Runtime-configurable** — `patches/install_config.json` tunes READLN auto-answers, sibling directories, force-small-batch mods, OCaml GC, PE stack reserve — without rebuilding
- **Forge data** is fetched at runtime — no database shipped with the GUI
- **Process management** entirely in Rust — spawn, stdout/stderr streaming via events, stdin pipe, process tree kill, force-kill on app close

## Building

### Prerequisites

- [Rust](https://rustup.rs/) (stable toolchain)
- [Node.js](https://nodejs.org/) 18+
- Platform-specific dependencies — see [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)

### Development

```bash
npm install
npm run tauri dev
```

### Release Build

```bash
npm run tauri build
```

**Windows (GNU toolchain):** Ensure MSYS2 MinGW-w64 binutils are in PATH:
```bash
export PATH="/c/msys64/mingw64/bin:$PATH"
npm run tauri build
```

**Windows (MSVC):** Use a Developer Command Prompt or install Visual Studio Build Tools.

**macOS:** Requires Xcode Command Line Tools.

**Linux:** Requires `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, and other packages. See Tauri docs.

## Related Projects

- [EET Mod Forge](https://github.com/Anprionsa/eet-mod-forge) — Web-based mod selection and configuration tool
- [mod_installer](https://github.com/dark0dave/mod_installer) — Rust CLI for automated WeiDU mod installation
- [WeiDU](https://github.com/WeiDUorg/weidu) — The universal Infinity Engine mod tool

## License

[MIT](LICENSE)

## Changelog

### v0.9.0 (2026-04-13)
- **Native WeiDU installer** — Replaced the `mod_installer` subprocess with a native Rust WeiDU driver (`src-tauri/src/installer/`, ~4300 lines across 13 modules: orchestrator, runner, batch, engine, dry_run, debug_mgr, pe_patch, tlk_accel, install_log, log_diff, tracker, copy). WeiDU is invoked directly with piped I/O; no more `mod_installer` dependency
- **Per-batch error recovery** — When a batch fails, user can Retry, Skip the batch, or Stop the install. Auto-retry-once-then-skip mode available
- **Install checkpoints** — Progress is persisted per game so interrupted installs can report where they left off
- **Dry-run mode** — Walk the plan without writing anything, surfacing issues (missing tp2, bad paths, READLN prompts) before a real install
- **Backup system** — Estimate, create, list, restore, delete, and abort backups of the game directory. Progress events during long operations (`src-tauri/src/backup.rs`, 800 lines; `BackupPanel.tsx`)
- **Auto-update** — Tauri updater plugin with minisign signing. `latest.json` generated in CI; client checks GitHub releases and installs updates in place
- **Preset browser** — Load/save complete install configurations (`PresetBrowser.tsx`)
- **Ready Check panel** — Consolidates old Pre-Flight + download checks + patch scan + resource limits into one surface (`ReadyCheck.tsx`)
- **Mods panel** — Unified import + download + browse UI (`ModsPanel.tsx`); replaces separate Import and Download tabs
- **Install report export** — Structured post-install JSON (`src/lib/install-report.ts`)
- **Internationalization** — UI strings moved to `src/lang/{en,de,fr,pl}.json` via `src/lib/i18n.tsx`
- **Telemetry** — Optional, opt-in reporting (`src/lib/telemetry.ts`)
- **Runtime-configurable install params** — `patches/install_config.json` controls READLN defaults per mod, fallback answer, READLN timeout, sibling directories (for mods that need junctioned peers), force-small-batch mods, OCaml GC tuning, PE stack reserve — editable without rebuilding
- **Per-game data dir** — WeiDU lockfile, install log, checkpoint, and backups live in a FNV-1a-hashed subfolder based on game path, so multiple game installs don't collide
- **Force-kill on close** — `on_window_event` terminates WeiDU immediately on app quit; avoids orphaned processes holding file locks
- **New bundled patches** — `bristlelick`, `walahnan`; patch manifest expanded
- **CI signing + release manifest** — Workflow signs artifacts with `TAURI_SIGNING_PRIVATE_KEY`, collects `.sig` files, and emits `latest.json` pointing at real platform URLs (Windows `.exe`, Linux `.AppImage`, macOS `.app.tar.gz`)
- **Dependencies** — Added `indexmap`, `fs2`, `tauri-plugin-updater`, `tauri-plugin-process`

### v0.8.0 (2026-04-08)
- **Pre-install patcher** — 35 bundled patches for known mod bugs. Scans Extracted directory by tp2 filename (handles any folder naming). Patch types: file copy, text replace, file rename, mkdir, game dir copy, game dir append, game dir write. Marker-based idempotence. Checklist UI in Pre-Flight tab with scan/apply/re-scan flow
- **Async Rust commands** — All heavy I/O commands (14 total) now use `spawn_blocking`, keeping the UI responsive during splash, download plan builds, and install monitoring. Fixes "not responding" on Windows
- **WeiDU.log ground truth counter** — Reads the game's weidu.log directly every 2.5s as a third progress source. Bypasses mod_installer's install_status.json which stops updating during long components like EET
- **Stdout fallback counter** — Independently counts SUCCESSFULLY INSTALLED / INSTALLED WITH WARNINGS / SKIPPING lines from WeiDU output
- **Activity indicator** — Green pulsing dot, log line count, and "last update Xs ago" shown during install. "Large component in progress" label when counter is stuck but install is alive
- **Graceful abort** — Sends CTRL_BREAK_EVENT (Windows) / SIGINT (Unix) first, waits 10s, then force-kills. Abort pending banner. Disabled button prevents double-clicks
- **Pause banner** — "Will pause after current mod finishes" message shown when pause is requested
- **Resource limit checks** — Counts new kits and spells per level across all mods in the install. Warns when approaching engine limits (256 kits, 50 spells per level). Fetches all mod detail files in batches
- **Download plan caching** — Persists to disk across sessions. No re-scan needed on app restart
- **View links** — Per-mod "view" links open source pages in default browser via tauri-plugin-opener
- **Windows file share mode** — Explicit FILE_SHARE_READ/WRITE/DELETE when reading install_status.json for concurrent access
- **Verbose poll diagnostics** — Logs raw BG2 status values for first 20 polls and every 50th for debugging
- **Patcher patches include** — SFO library fixes (SCS, ToF, IWDification, MiH), ALWAYS block guards (Angelo, BuTcHeRy), BCS decompile guards (Bardic Wonders, TB#Tweaks, 5E Spellcasting), IDS pre-population (ACTION.IDS, TRIGGER.IDS), mih_metamod cleanup (EET.flag + IDS + BCS preservation), and 20+ more
- **Mod location discovery** — tp2-based recursive scan builds mod folder map. Works with any directory structure (double-nested, human-readable names, GitHub archive extractions)

### v0.7.0 (2026-04-05)
- **Download Manager** — New Download tab auto-downloads GitHub mods using Forge's `version_cache.json` (no API key or PAT required). Constructs download URLs from cached release tags. Batch download with progress. Per-mod "view" links open source pages in the default browser via `tauri-plugin-opener`. Manual download section with "Open in Browser" for non-GitHub mods (Beamdog forums, Nexus, Weasel Mods, etc.)
- **Batch mod existence check** — Single Rust command indexes all tp2 files once and checks 400+ mods against the index, replacing 400+ individual filesystem calls
- **Pre-flight mod download check** — Pre-flight now verifies ALL mods from the import are present on disk (not just the first 5). Directs users to the Download tab for missing mods. Progress bar during checks with step-by-step status
- **Progress bar accuracy** — Download progress percentage only shows 100% when all mods are truly ready (no rounding up from 99.x%)
- **Splash screen** — Loading overlay with progress bar during startup. Pre-loads config, Forge connectivity, game directory validation, and saved logs. App renders hidden underneath for instant display
- **Centered tab bar** — Tabs are now centered in the tab bar for a cleaner look
- **Performance** — Download plan builds via explicit button instead of auto-running on mount (was causing 2-3 min freeze). Loading step indicators during plan building
- **reqwest + zip fix** — Switched to `rustls-tls` (from `native-tls`) and `deflate`-only zip to eliminate `liblzma-5.dll` missing error on Windows

### v0.6.0 (2026-04-03)
- **Install comparison** — Compare Forge export WeiDU.log against installed WeiDU.log. Shows completely missing mods and partially installed mods with component-level detail. Uses imported log paths from Import tab automatically, or file picker as fallback
- **Collapsible debug sections** — Errors, Known Issues, Warnings, Unmatched Issues, and Installed sections all start collapsed with expand/collapse toggle. Color-coded left borders. Copy button on every section
- **Grouped warnings** — Warnings grouped by similarity (like known issues). Expandable with occurrence counts instead of 500 individual entries
- **Grouped known issues** — Known Issues grouped by description with occurrence count badges. Expandable to see individual files
- **Installed count fix** — Now counts both `SUCCESSFULLY INSTALLED` and `INSTALLED WITH WARNINGS`. Separate `installed_with_warnings` counter distinguishes clean installs from warning installs
- **Debug panel persistence** — Stays mounted across tab switches (no more losing parsed results)
- **dialog.tlk detection** — Searches `lang/en_US/dialog.tlk` and other language folders (was showing 0 MB)
- **Invoke naming fix** — All 17 Tauri invoke calls corrected: command names use snake_case, parameters use camelCase. Fixes GUI log, debug file parsing, install status polling, and all other Rust commands
- **Recursive polling** — Replaced `setInterval` with recursive `setTimeout`. Each poll schedules the next after completion. Cannot silently die
- **CSS resize for log** — Log panel uses native `resize: vertical` with `maxHeight: 80vh` instead of custom ResizablePanel
- **Status timestamp** — Dashboard shows status file timestamp next to component name for staleness detection
- **GitHub Actions CI** — Cross-platform builds for Windows, macOS, and Linux on push and release tags

### v0.5.0 (2026-04-03)
- **App icon** — Steel anvil with gold bow arrow, all platform sizes
- **GUI logger** — `gui.log` in app config directory for diagnosing GUI issues
- **Pause/Resume** — File-based IPC between GUI and mod_installer
- **ETA calculation** — Rolling 5-minute throughput window
- **Performance overhaul** — Ring buffer log (500 lines max), throttled rendering, memoized computations. Constant memory usage
- **Debug panel rewrite** — 500MB+ files parsed in Rust backend. Error deduplication, warning noise filtering, per-mod `ki` known issues from Forge
- **Install options** — All mod_installer CLI flags exposed with collapsible Advanced section
- **Cross-platform** — libc dependency, Unix paths, case-insensitive chitin.key, safe process kill
- **Stability** — Tab persistence, double-click guard, event listener cleanup, mutex safety

### v0.2.0 (2026-04-02)
- **Real-time install monitoring** — Polls `install_status.json` from both game directories
- **Status dashboard** — Progress bar, error/warning/skipped counters, elapsed time
- **Process management in Rust** — Subprocess spawning, stdout/stderr streaming, stdin pipe, process tree kill
- **Install options** — Skip installed, never abort, timeout, download mods
- **Game freshness detection** — Warns if game directory has been modded
- **Wrong log slot detection** — Warns if logs are swapped
- **Mod list** — BGEE mods first, dual-install mods show separately, SETUP- prefix stripped

### v0.1.0 (2026-04-02)
- **Initial release** — Tauri v2 + React 18 + TypeScript
- Five-tab layout: Setup, Import, Pre-Flight, Install, Debug
- Forge color scheme, config persistence, game directory validation

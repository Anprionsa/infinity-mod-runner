# EET Mod Runner

**Cross-platform desktop GUI for installing Baldur's Gate: Enhanced Edition Trilogy mods**

A Tauri v2 app that wraps [mod_installer](https://github.com/dark0dave/mod_installer) with real-time progress monitoring, error categorization, and pre-flight validation. Designed as a companion to [EET Mod Forge](https://github.com/Anprionsa/eet-mod-forge) — configure your mod selection in the Forge, export the logs, and run the install here.

## Features

- **Setup wizard** — Configure BG1:EE and BG2:EE game directories with `chitin.key` validation (case-insensitive on Linux), game freshness detection, WeiDU and mod_installer auto-detection with version display

- **Dual log import** — Side-by-side import for WeiDU-BGEE.log and WeiDU.log. Wrong-slot detection warns if you swap the logs. Mod list grouped by phase (BGEE first, then EET). Paths persisted across sessions

- **Pre-flight checks** — Validates essential mods (EET, EET_End, EE Fixpack, DLC Merger), fetches known issues and compat data from the hosted Forge. Blocks install on critical errors

- **Install runner** — Real-time dashboard powered by `install_status.json` polling. Combined BG1 + EET progress. Phase indicator badge. ETA calculation. Pause/Resume support. All mod_installer CLI flags exposed

- **Issues panel** — Errors grouped by mod with expandable details. Exit code categorization (WeiDU Crash / Install Failed / Unknown). Skip reason distinction (expected vs suspicious). Sorted by severity

- **Debug analysis** — Parses 500MB+ WSETUP.DEBUG files in the Rust backend. Collapsible sections for errors, known issues, warnings, unmatched issues, and installed components. Grouped by type with occurrence counts. Copy buttons on every section. Per-mod `ki` known issues fetched from Forge

- **Install comparison** — Compare Forge export against installed WeiDU.log. Shows exactly which mods are completely missing vs partially installed. Uses imported log paths automatically

- **GUI logger** — `gui.log` for diagnosing GUI-only issues, separate from WeiDU/mod_installer output

- **Forge color scheme** — Dark backgrounds with gold accents matching EET Mod Forge

## Architecture

```
Frontend (React 18 + TypeScript + Vite)
  |
  |-- invoke() ──> Rust backend (Tauri v2)
  |                  |-- std::process::Command ──> mod_installer
  |                  |-- File I/O (install_status.json, install_errors.log)
  |                  |-- Config persistence (confy)
  |
  |-- fetch() ───> Hosted Forge data (known_issues.json, compat.json, per-mod ki)
```

- **mod_installer** is invoked as a subprocess — no library coupling
- **Forge data** is fetched at runtime — no database shipped with the GUI
- **Process management** entirely in Rust — spawn, stdout/stderr streaming via events, stdin pipe, process tree kill

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

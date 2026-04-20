# Infinity Mod Runner

**Cross-platform desktop GUI for installing Baldur's Gate: Enhanced Edition Trilogy mods**

A Tauri v2 app with a **native Rust WeiDU driver** — drives WeiDU directly (no subprocess wrapper), with real-time progress monitoring, per-batch error recovery, backups, and auto-update. Designed as a companion to [Infinity Mod Forge](https://github.com/Anprionsa/infinity-mod-forge) — configure your mod selection in the Forge, export the logs, and run the install here.

> **Beta.** The current `1.0.2-beta` release is feature-complete — proven end-to-end by a 12.2h / 1675-component megainstall (1600 ok, 0 err, 0 cascade-skips) on 2026-04-20 — but still under active real-world testing. Please back up your game directory before installing, and report issues on GitHub.

## Features

- **Setup wizard** — Configure BG1:EE and BG2:EE game directories with `chitin.key` validation (case-insensitive on Linux), game freshness detection, WeiDU auto-detection with version display. Optional IWD:EE, IWD2, and PST:EE slots (collapsed by default) let the runner cover non-BG targets for backup/restore

- **Mods panel** — Unified surface for importing Forge export logs, downloading missing mods, and browsing local state. GitHub mods download automatically via Forge's cached release data (no API key). Manual links for non-GitHub sources. Wrong-log-slot detection. Paths persisted across sessions

- **Preset browser** — Load and save complete install configurations (mod list + install options) as reusable presets

- **Ready Check** — Consolidated pre-install validation: essential mods present, all mods downloaded (batch tp2 scan), resource limits (kits, spells per level), known issues / compat data from Forge, patch applicability. Progress bar during checks; blocks install on critical errors

- **Pre-install patcher** — 60+ bundled patches fix known mod bugs in the Extracted source before WeiDU runs. Scans for applicable patches, shows checklist, applies with one click. Idempotent marker detection (md5 / text / file-exists, with `invert` for "apply when absent"). Op types: `copy`, `replace` (find/replace text, byte-safe for non-UTF-8 tp2s), `copy_if_missing`, `rename_if_exists`, `delete_if_exists`, `mkdir`, `copy_to_game`. Handles double-nested and arbitrarily-named mod directories via tp2-based discovery. Runtime-configurable via `patches/install_config.json` (READLN defaults, sibling dirs, force-small-batch list, per-mod timeouts, single-cn sharding, OCaml GC)

- **Backup system** — Estimate/create/restore/delete snapshots of the game directory before an install. Progress events during long operations; abortable. Multiple named backups per game. **Multi-game aware** — BG1:EE, BG2:EE, IWD:EE, IWD2, PST:EE each get their own backup tab, with per-game override directories, orphaned-backup detection, and a verify command that re-checksums a snapshot on demand

- **Install runner** — Native WeiDU driver with real-time dashboard. Per-batch error recovery (Retry / Skip / Stop). Triple-source progress tracking (install log + stdout counter + weidu.log ground truth). Activity indicator, graceful abort (Ctrl+C with 10s fallback), pause/resume with user-facing banner, checkpoint on interrupt. EET two-phase support. Dry-run mode. **Per-mod timeout overrides** (default 2h, bumped to 6h for known-slow mods like `dw_talents` HLAs on megainstalls) and **single-component batch sharding** for specific slow `cn` values — a timeout on one hard component no longer AUTO_SKIPs its batch-mates. Install log self-documents user aborts with `[USER_ABORT]` / `[ABORT_SKIP]` events (separate from real `[FATAL_SKIP]` subprocess failures). **BCS buffer-cache telemetry** — when the patched WeiDU is in use, each batch emits hit/miss/peak-memory stats that surface as a live color-coded badge next to the current mod and an aggregate card in the post-install summary (overall hit rate, peak memory, evictions, worst-rate batch)

- **File Guard** — Detects silent cross-mod file corruption between batches. Post-batch md5 snapshots of override files flag unexpected drift against a shipped allowlist of legitimate multi-writer files (`guard_allowlist.json`). On suspicious drift, auto-restores from snapshot or pauses the install; writes a `guard_report.json` for diagnosis

- **Override acceleration** — Optional symlink / Windows junction pooling so multiple game installs share read-only override state without duplicating gigabytes (`override_accel.rs`)

- **Resilient WeiDU (experimental, opt-in)** — Bundles a patched WeiDU binary per platform in `src-tauri/weidu_experimental/`. Users can opt in from a dedicated panel to swap the game's WeiDU for the bundled build for a single install run. Binaries are extracted on demand; the original is restored afterward. The bundled build currently carries two engine-level patches — **resilient DECOMPILE_AND_PATCH** (round-trip failures become warnings, not aborts) and an **experimental BCS buffer cache** (see Experimental WeiDU section). Transparent about risk — see `src-tauri/weidu_experimental/README.md` for the build & maintenance workflow

- **Issues panel** — Errors grouped by mod with expandable details. Exit-code categorization (WeiDU Crash / Install Failed / Unknown). Skip-reason distinction (expected vs suspicious). Sorted by severity. **Silent-skip detection** reconciles WeiDU exit-code against `weidu.log` after every batch: components that exited "successfully" but were never logged become `Skipped` (with NO_LOG_RECORD awareness so mods that legitimately skip the log aren't false-flagged). **Sys_error detection** promotes those skips to hard `Error` when the underlying cause was WeiDU's `FATAL ERROR: Sys_error` at startup (wrong tp2 path, unreadable file). **Warning classifier** runs every captured `WARNING:` line through a Forge-sourced pattern catalog and renders severity chips — *cosmetic*, *likely-benign*, *caution*, *concerning*, or *unknown* — so the scary-looking "Installed with warnings" count is broken down into what actually needs attention

- **Debug analysis** — Parses 500 MB+ WSETUP.DEBUG files in the Rust backend. Collapsible sections for errors, known issues, warnings, unmatched issues, and installed components. Grouped by type with occurrence counts. Copy buttons on every section. Per-mod `ki` known issues fetched from Forge

- **Install comparison** — Compare Forge export against installed WeiDU.log. Shows exactly which mods are completely missing vs partially installed. Uses imported log paths automatically

- **Install report** — Export a structured post-install report (JSON) summarizing outcomes, errors, skipped components, and elapsed time

- **Auto-update** — Signed releases via Tauri updater (minisign). Checks GitHub `latest.json` and applies updates in place

- **Internationalization** — UI available in English, German, French, and Polish (`src/lang/`)

- **GUI logger** — `gui.log` for diagnosing GUI-only issues, separate from WeiDU output

- **Diagnostic bundle** — One-click "generate bundle" action zips `gui.log`, the active `install.log`, the most recent guard/install reports, and a redacted copy of `config.toml` (path fields stripped) for attaching to a bug report. The bundle includes a short `README.md` explaining what each file is

- **First-run UX** — A dismissible welcome card greets fresh installs; an opt-in **Guided mode** locks the tabs into sequence (Setup → Mods → Ready Check → Install) and surfaces explicit "Next" buttons for first-time users. Returning users leave it off for free navigation. The Install tab's **Save my preferences** action captures your install-tab settings so a future run restores them without clicking back through advanced options

- **Forge color scheme** — Dark backgrounds with gold accents matching Infinity Mod Forge

## Architecture

```
Frontend (React 18 + TypeScript + Vite)
  |
  |-- invoke() ──> Rust backend (Tauri v2)
  |                  |-- installer/ ──> Native WeiDU driver
  |                  |      (orchestrator, runner, batch/dry-run, debug_mgr,
  |                  |       pe_patch, tlk_accel, install_log/log_diff, tracker, copy,
  |                  |       file_guard, override_accel, cache_stats)
  |                  |-- backup.rs       ──> Game-dir snapshot system
  |                  |-- paths.rs        ──> Log-path resolver + diagnostic bundle
  |                  |-- weidu_swap.rs   ──> Bundled patched-WeiDU orchestration (opt-in)
  |                  |-- Patch scanner/applier (patches/*)
  |                  |-- HTTP downloads (reqwest) ──> GitHub archives, direct URLs
  |                  |-- Config persistence (confy)
  |                  |-- Tauri updater (minisign)
  |
  |-- fetch() ───> Hosted Forge data (mods-index, version_cache, github_mods, ki)
```

- **Native WeiDU driver** replaces the old mod_installer subprocess — WeiDU is invoked directly with piped I/O, per-batch Retry/Skip/Stop error recovery, checkpoints, pause/resume, EET two-phase support (see `src-tauri/src/installer/`)
- **Per-game data dir** — WeiDU process lockfile, install log, checkpoint, and backups are stored in a FNV-1a-hashed subfolder so multiple game installs don't collide
- **Runtime-configurable** — `patches/install_config.json` tunes READLN auto-answers, sibling directories, force-small-batch mods, OCaml GC, PE stack reserve — without rebuilding
- **Forge data** is fetched at runtime — no database shipped with the GUI
- **Process management** entirely in Rust — spawn, stdout/stderr streaming via events, stdin pipe, process tree kill, force-kill on app close

## Experimental WeiDU

Infinity Mod Runner ships a **vendored, lightly modified WeiDU source tree** at
[`src-tauri/weidu_experimental/weidu_src/`](src-tauri/weidu_experimental/weidu_src/),
based on WeiDU 251 from [WeiDUorg/weidu](https://github.com/WeiDUorg/weidu).
All modifications are tracked in this repo's git log — not as out-of-tree
patches against a moving upstream. The patched binaries are **opt-in per
install** via the Settings panel; the user's configured WeiDU is untouched
unless they toggle the experimental bundle on.

**Current modifications** (see [`src-tauri/weidu_experimental/README.md`](src-tauri/weidu_experimental/README.md) for the full list + maintenance workflow):

- **Resilient DECOMPILE_AND_PATCH** (`src/tppatch.ml`) — catches BCS round-trip
  exceptions inside `DECOMPILE_AND_PATCH` blocks (usually IDS-state drift
  in large mod stacks) and logs a warning instead of aborting the install.
  Targets Ajantis NPC (`C#AJAN.bcs`), Golem Construction (`a7#dron3.bcs`,
  `a7#abs.bcs`), and SoD companion scripts (`BD*.bcs`).

- **BCS buffer cache** (`src/bcs_buffer_cache.ml`) — LRU cache at
  `Load.load_resource` that memoizes BCS/BAF buffers across repeated
  `COPY_EXISTING_REGEXP` scans (the hot loop in SFO-library mods like
  `dw_talents`, `stratagems`, `mih_tweaks`). Default 256 MB cap;
  configurable via the `WEIDU_BCS_CACHE_MB` environment variable
  (`0` disables the cache for A/B baselines). Invalidation hooks cover
  `open_for_writing`, `TP_Delete`, `TP_Move`, and full-clear on KEY
  reloads (`TP_Biff`, `TP_DecompressBiff`). An exit-time
  `BCS_CACHE_STATS_JSON` line on stderr feeds the per-batch hit-rate
  badge and post-install aggregate card in the install dashboard.

**CI builds from the vendored tree directly** — no upstream clone or
`git apply` dance. The [`weidu-rebuild.yml`](.github/workflows/weidu-rebuild.yml)
workflow cross-compiles for Windows/macOS/Linux, then gates a headless
smoke-test job (good-syntax / bad-syntax / no-game subset of
`weidu_src/test/`) before committing refreshed binaries + `meta.json`
SHA256s. Broken binaries never land on main.

**For testers and maintainers:**
- [`tools/TESTING.md`](src-tauri/weidu_experimental/tools/TESTING.md) — A/B test procedure, operational checklist, red-flag inventory.
- [`tools/smoke_test.sh`](src-tauri/weidu_experimental/tools/smoke_test.sh) — headless compile tests + cache-integration gate against a built binary.
- [`tools/analyze_install_log.py`](src-tauri/weidu_experimental/tools/analyze_install_log.py) — parses `install.log` into a per-batch cache/timing summary; `--ab` diffs two runs side-by-side.

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

- [Infinity Mod Forge](https://github.com/Anprionsa/infinity-mod-forge) — Web-based mod selection and configuration tool
- [mod_installer](https://github.com/dark0dave/mod_installer) — Rust CLI for automated WeiDU mod installation
- [WeiDU](https://github.com/WeiDUorg/weidu) — The universal Infinity Engine mod tool

## First-launch warnings

The current `1.0.x-beta` releases are **unsigned on Windows** and **unnotarized on macOS**. Code signing is in progress (SignPath.io OSS program application is out; once approved, releases will be signed automatically through CI). Until then, both OSes show a one-time warning on first launch and need a quick user bypass.

### Windows SmartScreen

When you run the installer `.exe` for the first time, Windows SmartScreen may show **"Windows protected your PC"** with a "Don't run" button. To proceed:

1. Click **More info**
2. Click **Run anyway**

Windows remembers the approval; subsequent launches skip the warning. The installer contents are unchanged by signing status — the app is the same binary either way. If you want to verify integrity, the auto-updater enforces a minisign signature (published alongside each release) on every update payload.

### macOS Gatekeeper

The macOS build isn't Apple-notarized (maintaining a $99/yr Apple Developer account isn't justified for a niche tool). On first launch macOS will say **"Infinity Mod Runner.app cannot be opened because Apple cannot check it for malicious software"**. To proceed:

1. Open **Applications** in Finder
2. Right-click **Infinity Mod Runner.app**
3. Click **Open**
4. Confirm in the prompt that appears

macOS remembers the approval per machine. The DMG's background window displays this same hint at mount time so you don't have to find these instructions mid-install.

## Credits

This project stands on a lot of other people's shoulders.

- **[mod_installer](https://github.com/dark0dave/mod_installer)** by **dark0dave** — the direct basis for how this runner drives WeiDU. Earlier versions of Infinity Mod Runner invoked `mod_installer` as a subprocess; the native Rust driver in `src-tauri/src/installer/` replaces that subprocess but carries the same core ideas forward: log-based install replay, batching, progress reporting, and the CLI-flag surface. If you're looking for a lean command-line version of this workflow, go use it directly.

- **[BWS-NG (Big World Setup — Next Generation)](https://github.com/Selphira/BigWorldSetup-Next-Generation/)** — provided the UI blueprint we borrowed most heavily from. The layout, pacing, and how install state is surfaced to the user all owe a debt to BWS-NG. The rest of what BWS-NG does (mod catalog, conflict resolution, install-order curation) lives on the [Infinity Mod Forge](https://github.com/Anprionsa/infinity-mod-forge) side of this project.

- **[Project Infinity](https://forums.beamdog.com/discussion/74335)** by **AL|EN** — the installer that the community has leaned on for the better part of a decade, and the reason this project exists at all. Infinity Mod Runner is an attempt to carry that tradition forward in a new stack, with the same respect for the user's time and game directory.

- **[EET](https://github.com/Gibberlings3/EET)** — **K4thos** and the [Gibberlings Three](https://www.gibberlings3.net/) community — the mod that makes the whole continuous BG1+SoD+BG2+ToB experience possible.

- **[WeiDU](https://github.com/WeiDUorg/weidu)** — the universal Infinity Engine mod tool. None of this works without it.

- **Mod authors** — the hundreds of people across [Gibberlings3](https://www.gibberlings3.net/), [Beamdog Forums](https://forums.beamdog.com/), [Spellhold Studios](https://www.shsforums.net/), [Weaselmods](https://www.weaselmods.net/), [Artisan's Corner](https://artisans-corner.com/), and [Pocket Plane Group](https://www.pocketplane.net/) who build and maintain the mods this runner exists to install.

## License

[MIT](LICENSE)

## Changelog

### v1.0.3-beta (in development)

Targeted at the next megainstall's wall-clock; written and compile-clean but **not yet shipped in a tested binary**. The 12.2h v1.0.2-beta run diagnosed `dw_talents` cn:60200 as a single 4.9h component (40% of total install time) walking all 122k files in override/. The root cause — MAKE_BIFF leaving originals in place — is what this version attacks.

- **BIFF-delete optimization** — `run_prebiff_optimization` now snapshots the file list BEFORE calling `MAKE_BIFF`, verifies the resulting biff is non-trivially sized (>1KB) afterwards, then deletes the snapshotted originals from override/. Before: WeiDU wrote ~122k files into `data/eetmr_prebiff.bif` on a megainstall, then left all 122k still in override/ where WeiDU's resource resolution loads them from disk anyway — the biff sat unused. After: override/ drops to ~60 files post-BIFF (IDS + loose non-biffable extras); SFO-heavy mods iterating the resource namespace walk the biff index instead of a 122k-directory scan. Expected impact on `dw_talents` cn:60200: 4.9h → sub-30min if cost is proportional to file count (the 127k `Copying and patching 1 file ...` stdout lines from the v1.0.2 run strongly suggest it is). Same pipeline win for stratagems cn:6000 and mih_tweaks bulk-patch batches. Safety nets: only deletes files snapshotted before MAKE_BIFF (so any aux outputs MAKE_BIFF itself generates are untouched); requires biff exists + >1KB before deleting (catches silent MAKE_BIFF failures); file_guard's `pre_batch` snapshot is taken AFTER cleanup, so the bulk deletion isn't mistaken for inter-mod drift

- **`enable_biff_delete_optimization` config toggle (A/B harness)** — Single canonical flag name used end-to-end: `InstallConfig.enable_biff_delete_optimization` in Rust, `AppConfig.enable_biff_delete_optimization` in confy/TS, `NativeInstallArgs.enableBiffDeleteOptimization` over IPC. **Precedence**: `install_config.json::enable_biff_delete_optimization` (optional bool) wins over the UI setting when present, so the weidu_experimental A/B test harness can pin variants from JSON alone — no UI toggling between runs. Applied identically in `start_native_install` AND `start_dry_run` so plan previews match reality. Documented with a `_enable_biff_delete_optimization_doc` stub in the shipped `install_config.json` showing the three variant configurations (baseline_A / biff_only_C / combined_D)

- **Structured `[PREBIFF]` log line for `analyze_install_log.py`** — Single `install.log` line per run, key=value format, anchored on `[PREBIFF]`:
  ```
  [PREBIFF] delete_optimization=<true|false> reason=<ran|biff_missing|disabled> biffed=N deleted=N delete_errors=N override_before=N override_after=N biff_file_size=bytes
  ```
  `reason` is a bounded enum — `ran` (cleanup fired), `biff_missing` (MAKE_BIFF exited 0 but produced an empty/missing biff), `disabled` (flag was off). Key ordering is pinned — future additions go at the END of the list, never reordered. Matches the regex the A/B harness analyzer uses to confirm which variant executed

- **`MAKE_BIFF` syntax fix** — The first v1.0.3 test run aborted after the `[PREBIFF]` line reported `reason=biff_missing biff_file_size=0` — the BIFF-delete safety net correctly refused to delete from override because `MAKE_BIFF` had produced a zero-byte biff. Root cause: the orchestrator emitted `MAKE_BIFF eetmr_prebiff BEGIN override END`, which WeiDU's TP2 parser interpreted as a zero-pair list (iterate nothing, write nothing). Verified against `tpaction.ml:463 TP_Biff` and a real mod using the feature (`HQ_SoundClips_BG2EE.tp2`). Correct syntax is `MAKE_BIFF ~biffname~ BEGIN ~directory~ ~regex~ END` with an explicit `~^.*$~` regex to match all files. Orchestrator now uses the verified form; an inline comment documents the parser-semantics gotcha so nobody repeats it

- **Profile-driven bottleneck reassessment (third pass)** — Stats.time data from the v1.0.2 run already showed "saving files" consuming 0.016 seconds of user CPU for a 10-component dw_talents batch that took many minutes wall clock. That 200,000× wall-clock-to-user-CPU ratio for writes is the tell: **the ~4-5h cn:60200 outlier is NTFS per-file-write-bound, not read-bound or iteration-bound**. With Windows Defender active and override fully materialized, sequential file writes on NTFS run ~25ms/op in kernel/IO-wait space; ~130k writes for cn:60200 ≈ ~54min just in raw kernel time, and the wall-clock inflation beyond that comes from the same cost multiplied across the component's multiple passes. Consequence: the BCS buffer cache (v1.0.2) and delete-after-BIFF (v1.0.3) together address the read/iteration fraction, which Stats.time proves is a tiny sliver of total time. **The dominant lever is redirecting `override/` to a fast volume (RAM disk or NVMe)** — existing `override_fast_drive` feature — which cuts per-write cost to ~1ms on a RAM disk for a 10-50× speedup on write-heavy SFO components. Documented in `src-tauri/weidu_experimental/tools/AB_PLAN.md` as the prerequisite for valid cache × BIFF A/B testing

- **Dry-run + install-start performance-lever advisory** — New block in `dry_run.rs`'s PERFORMANCE ADVISORY section fires on `config.override_fast_drive`: when **on**, reassures users the biggest write-cost lever is engaged; when **off**, warns that dw_talents cn:60200 runs ~130k writes on NTFS+Defender at ~37 writes/sec ≈ ~4-5h and recommends enabling fast-drive in Install → Advanced with a RAM disk target. `orchestrator.rs` also emits an always-on structured diagnostic at install start — `Performance levers: biff_delete=<on|off>, override_fast_drive=<on|off>` — so post-mortem analysis can confirm which levers were engaged per run without grepping UI state. A stdout-panel ⚠ banner fires at install start if `override_fast_drive=off` AND the plan contains `dw_talents` / `stratagems` / `mih_tweaks`, so the warning isn't buried in scrollback. `analyze_install_log.py` parses the `Performance levers:` line, surfaces it in per-run summaries + the `--ab` variant label, and emits a ⚠ through comparison output when `fast_drive=off`

- **Documentation propagation** — Inline comments in `orchestrator.rs` reference the A/B harness by name so future maintainers know the log format has downstream consumers; `install_config.json` carries three commented variant examples as an operator cheat-sheet; `config.rs` cross-references the JSON precedence rule; `AB_PLAN.md` rewritten around a three-lever model (cache, BIFF, fast-drive) with fast-drive declared as a prerequisite for valid A/B runs

- **Patch #61 (EPS PATCH_TRY wrap)** — Wraps the `LPF DELETE_EFFECT` + `LPF CLONE_EFFECT` calls in `enhanced-powergaming-scripts/lib/ds/ds.tph::ds_add_detectable_data` with `PATCH_TRY ... WITH DEFAULT ... END` so corrupted items (broken ability-header offsets) emit a `PATCH_PRINT` warning and are skipped instead of aborting the entire "Accelerated Pre-Buffing Speed" component. Supersedes patch #60 (now `recommended: false`), which was a whack-a-mole POTN18-only fix: v1.0.2 Test #38 crashed on POTN18, Test #39 crashed on POTN45 (from a different inline 2da). The PATCH_TRY wrap covers the walker call site itself, so ALL future corrupted-potion crashes become warnings

- **Patch #60 marker tightened** — Was `{ text: "POTN18", invert: true }`, matched any "POTN18" substring in `ds.tph`. Patch #61's explanatory comment mentions POTN18, so after #61 applied, #60's marker false-triggered as "not yet applied" and showed as perpetually pending in Ready Check. Now uses the full 3-line broken-state sequence `"POTN02\nPOTN18\nPOTN22"`, which only the pre-#60 state contains — no collision with #61's comment

- **`scan_patches` diagnostic trace (opt-in)** — `PATCH_TRACE=1` env var emits a per-patch scan line to stderr (`gui.log`) showing the resolved marker JSON and the `already_patched` outcome, plus `mod_dir` / `game_dir` headers. Useful when Ready Check's banner disagrees with the visible patch-list state — the trace shows exactly what the backend's `check_marker` returned vs what the frontend rendered. Off by default

- **Generalized ds.tph STATS.IDS cleanup** (`orchestrator.rs::ensure_ds_ids_cleanup_all`) — fixes the `WARNING: error parsing STATS.IDS: Parsing.Parse_error` class observed across dw_talents, stratagems, and every other script-writing mod in the late install. Root cause: the SFO2e/DS helper library's `ds_sort_ids` function mis-parses headerless IDS files, emitting duplicate-index entries (same stat number with two names), same-name-at-different-index entries, and cumulatively — null bytes at stale header positions. STATS.IDS in the megainstall override/ was confirmed corrupted with all three patterns. v1.0.2 patched 6 of 22 ds.tph copies via per-mod manifest entries; the other 9 that call `ds_sort_ids` on stats (Ascension, aTweaks, Crucible, D0Quest Pack, DW Opcodes, EE Fixpack, Enhanced Powergaming Scripts, Kiara Zaiya, Tactics Remix) kept re-corrupting STATS.IDS every time their `ds_sort_ids` ran. v1.0.3 moves the fix into the runner: at install start (right after the AT_ hook staging step), the runner recursively scans every mod's ds.tph in the game dir for the canonical `LAF ds_sort_ids STR_VAR ids=stats END` call site (all 15 observed occurrences use identical whitespace — confirmed via Python audit) and injects the cleanup block right after. Idempotent via the `_eetmr_ids_cleanup` text marker — files already patched by the legacy manifest entries are detected and skipped. Each patch logged as `[DS_CLEANUP] patched <file> (mod=X)`. Supersedes the ds.tph replace ops previously embedded in manifest patches #1/#4/#6/#7/#8/#9 (those ops removed, their other SFO library copy ops intact). Audit over real mod set: 22 ds.tph scanned → 9 patched by runner, 6 already marked (skipped), 7 no-op (don't call `ds_sort_ids` on stats).

- **Patch #62 (Imnesvale cold-resistance spell fix)** — All 18 BAF scripts in `imnesvale/scripts/{easy,hard,impossible}/` called `ReallyForceSpell(Myself,CLERIC_RESIST_COLD)`, but that symbol doesn't exist in BG2EE's `SPELL.IDS` — the mod was written for pre-EE BG2. WeiDU silently dropped each line at BCS compile time (10 `PARSE ERROR at line X column 16-58` messages in WSETUP.DEBUG), so Imnesvale creatures (duArim, duAyrus, duCleric, duDruid, duJug, duMaia) never cast cold resistance in combat — a minor but persistent gameplay bug invisible from the install side. Replaces every occurrence with `CLERIC_ENDURE_HEAT_COLD` (spell 1115), the closest real BG2EE cleric spell. 18 `replace` ops, one per BAF, covering all difficulty tiers with `required: false` so the patch no-ops cleanly on already-patched installs

- **Generalized AT_ hook script staging** (`orchestrator.rs::ensure_at_interactive_exit_scripts`) — new install-loop step that audits every mod's tp2 for `AT_INTERACTIVE_EXIT` / `AT_EXIT` / `AT_NOW` / `AT_INSTALL` / `AT_UNINSTALL` hooks referencing executable scripts (`.bat`/`.exe`/`.cmd`/`.sh`/`.py`), resolves each against the mod's source tree, and copies the script into the game dir if it's not already there. Fixes a class of silent in-game bugs affecting **8 confirmed megainstall mods** (Secret Of Bone Hill `bonehillv275/BHAreas.bat`, Sheena `Setup-SheenaAudioInstall.bat`, The Darkest Day `TDD/TDD-TISBIFF.bat`, Fields Of The Dead `FotD\FotD-setup.bat`, Alassa NPC `d0alassaaudio.bat`, Improved Asylum `asyinstall.bat` TIZ→TIS tileset extraction, Yoshimo Romance `YRAudioInstall.bat` + `YRAudioUninstall.bat`). Mod authors typically ship these scripts at the mod's parent directory or with path prefixes that don't match the mod-folder name, so the runner's normal mod-copy step doesn't put them where WeiDU's shell-out expects them. Previously: `'foo.bat' is not recognized`, audio stays as OGG (cosmetic on BG2EE), tilesets stay as TIZ (breaks custom maps). Now: staged right after `suppress_readmes`, invocation succeeds, asset conversion completes. Hardened against the full edge-case set:
  - **Path traversal defense** — canonicalizes target's parent and rejects refs that escape the game dir (`../../../etc/foo.bat`), logs as `[AT_EXIT_HOOK] skip MOD: ref X escapes game dir`
  - **Quoted paths with spaces** — first-token extractor respects `"..."`/`'...'` quoting so `"my folder/foo.bat"` doesn't get split at the space
  - **WeiDU variables** (`%MOD_FOLDER%/foo.bat`) — detected and skipped with log; 28 real refs in the current mod set fall into this branch (`%tileconv%`, `%tisunpack%`, `%os_slash%`, etc.) instead of wasting a hunt
  - **Alternative string delimiters** — accepts `"X"` / `'X'` in addition to `~X~` for the literal payload (WeiDU grammar allows all three)
  - **Cross-mod dedup** — if two mods reference the same target path, only the first stages; HashSet keyed on absolute target path
  - **Post-install cleanup** — new `cleanup_at_exit_staged_scripts` removes everything we staged once the phase's batch loop completes, keeping the game dir clean across reinstalls. Missing files are fine (WeiDU's own bat may have self-deleted), unlink failures log `[AT_EXIT_HOOK] cleanup failed`
  - **No race** — staging runs before any batch spawns WeiDU, so scripts are in place by the time the first AT_ hook fires
  - Unresolvable refs (mod author forgot to ship the script, e.g. Fade's `fadeaudio.bat` or Varshoon's `VarIA.bat`) log as `[AT_EXIT_HOOK] skip … not found in mod source` — we can't fix those, but they stop being silent failures

  Each copy + cleanup logged as `[AT_EXIT_HOOK]` in install.log for forensics. `extract_first_path_token` and `extract_weidu_string_literal` helpers have 11 unit tests in `at_hook_tests`. No per-mod manifest patch needed — the runner handles this class of bug systemically, and the mechanism auto-covers any future mod with the same pattern.

- **Debug-capture coverage fixes (4-part)** — Install #21 aborted on `dw_talents` batch 384 cn:60200 Revised HLAs after 60+ min of active output. Post-abort audit revealed three gaps in the runner's diagnostic capture: (a) `preserve_error_debug_files` only fired on `Error` or silent-skip — every "N ok, 1 warn" batch in the 465-batch run left zero preserved debug, so darian/iwditempack/aranw etc. were undiagnosable; (b) no in-flight capture — the abort path fired `preserve_error_debug_files` in-process, so force-closing the runner (Tauri app kill) bypassed it entirely; (c) all copy failures were `let _ = std::fs::copy(...)` — when a copy silently failed (stale handle, disk, etc.) the preserved file was stale from a prior install with no log signal. A fourth gap: (d) the Slow Batch UI showed generic "slow batch" copy for cn:60200, contributing to the user's abort decision since there was no signal that 30–90min was the expected duration. Addressed end-to-end:
  - **Fix 1 — Preserve on warnings** (`orchestrator.rs` else-branch at ~line 2160) — in the "WeiDU exited 0" path, also call `preserve_error_debug_files` when any refined component has `ComponentStatus::Warning`. Now every "N ok, M warn" batch leaves a `WSETUP-{mod}.DEBUG` in `data/debug_logs/` regardless of whether WeiDU's exit was non-zero. Pairs cleanly with the inflight cleanup on true-success paths so the debug listing still only reflects batches with issues.
  - **Fix 2 — In-flight rolling snapshots** (new `installer/debug_snapshot.rs`) — `SnapshotGuard::start(game_dir, data_dir, mod_name, logger, interval_secs)` spawns a background thread that copies `WSETUP.DEBUG` + `setup-{mod}.DEBUG` to `data/debug_logs/WSETUP-{mod}-inflight.DEBUG` every `DEFAULT_INTERVAL_SECS` (300 = 5 min). Started right before `run_batch`; stops on guard Drop at end-of-iteration (RAII). Poll cadence is 1s, snapshot fires at the interval — short batches never take a snapshot, long batches yield ~12 captures/hour. For install #21's 60-min cn:60200 stall we would have had the last ~5-min window on disk even after the force-close. `cleanup_inflight()` method removes `-inflight` files on clean-success paths so the preserved listing stays tidy. 5 unit tests covering copy success, case-variant fallback, missing-source no-op, cleanup targeting, and guard lifecycle.
  - **Fix 3 — Log copy failures** (`orchestrator.rs::preserve_error_debug_files` refactor) — returns a new `PreservationReport { preserved, failures }` and logs each I/O error as a `[DEBUG_PRESERVE_FAIL]` event to `install.log` with `source → dest: reason`. Missing source files are NOT treated as failures (the common case — most mods don't produce a `setup-MOD.DEBUG` on success). Callers use `let _ = preserve_error_debug_files(...)` — the report is there for anyone who wants to act on it, but the logging happens inside regardless. Same pattern in `debug_snapshot::take_snapshot` via `[DEBUG_SNAPSHOT_FAIL]` events.
  - **Fix 4 — Known-slow UI signal** (`installer/mod.rs::known_slow_reason`, `tracker.rs::emit_batch_start_with_hints`, `InstallRunner.tsx`) — new `known_slow_reason(mod_name_lower, cn) -> Option<&'static str>` returns targeted plain-English copy for 3 components with repeated test-cycle evidence of being slow-but-legitimate: `dw_talents` cn:60200 Revised HLAs (30–90min on megainstalls), cn:60300 Leveller (similar), `stratagems` cn:6000 SCS AI (20+ min). Orchestrator pipes it through the `install:batch_start` event's `known_slow_reason` field; frontend stores it on `slowBatch.knownSlowReason` and threads it into `slowBatchUi`. When set, the Slow Batch pill goes blue with verb "expected-slow" and the tooltip replaces the generic timeout copy with "Revised HLAs — a full override-dir walk that normally takes 30–90 minutes on megainstalls. WeiDU is not stalled; let it run unless output has been frozen for >10 minutes." The gui.log warn line also carries `known_slow=true` for post-mortem filtering. Conservative list on purpose — ambiguous cases fall through to the existing health-based messaging.

  No per-mod manifest patches involved. The machinery auto-covers any future mod added to `known_slow_reason`'s match arms, and the preservation improvements apply to every batch regardless of which mod triggers them.

- **Windows Defender exclusion, opt-in** — New pre-install flow for the ~20ms-per-file-close cost Defender adds to every override write. `src-tauri/src/defender.rs` wraps `Get-MpComputerStatus` + `Add-MpPreference` behind a `#[tauri::command]` surface (`defender_status`, `defender_is_path_excluded`, `defender_add_exclusion`, `defender_remove_exclusion`), with `Start-Process -Verb RunAs` handling the single UAC elevation. `DefenderModal.tsx` fires once per fresh config when Defender is Active AND `bg2_game_dir` isn't excluded AND `override_fast_drive` is off — three buttons: **Add exclusion & continue** (flips `auto_defender_exclusion=true` on UAC success), **Skip this time** (no state change; re-fires next install), **Don't ask again** (sticky `defender_prompt_dismissed=true`). UAC cancel is treated as `Ok(false)` — install proceeds either way, the perf optimization is best-effort. Two new `AppConfig` fields (`auto_defender_exclusion`, `defender_prompt_dismissed`), both default false. Install → Advanced carries a matching checkbox with state-aware hint text (active / inactive / unknown) so users who dismissed the modal can still opt in later. Exclusion is **permanent by design** — no auto-remove on install end, no cleanup UAC. Users who want it gone remove it manually via Windows Security → Virus & threat protection → Manage settings → Exclusions. Expected speedup on SFO-heavy mods: 2–5×, complementary to `override_fast_drive` (which bypasses the scan entirely by writing elsewhere).

_Bundled WeiDU: **inherits `patch_revision: 2` from v1.0.2** (BCS buffer cache + resilient DECOMPILE_AND_PATCH, built 2026-04-19). Bump to rev 3 only if this cycle touches `src-tauri/weidu_experimental/weidu_src/**` — orchestrator-side changes (Rust, frontend, `install_config.json`) do NOT require a rebuild and do NOT bump `patch_revision`._

### v1.0.2-beta

Shipped in the 12.2h megainstall run on 2026-04-20 (1675 components, 1600 ok, 0 err, 46 warn, 3 skip — the first install to complete with **zero cascade-skipped components**). Contains the patch and installer-side lessons from two successive end-to-end megainstall runs (the 11.6h session a0d99ad3 that cascade-skipped 14 dw_talents components at the 2h global timeout, and the 12.2h session 1169f4cc that proved the fixes below — trading 0.6h wall-clock for 30 more components installed and 26 fewer skips):

- **`cleanup_override.tpa` v6 — BIFF 4GB wraparound fix** — MiH Meta-Mod's `MAKE_BIFF` on a saturated override/ produced a 6.2 GB `mh#clean.bif` on megainstalls. BIFF V1 uses 32-bit offset fields, so ~49,000 resources past the 4 GB boundary silently read garbage (observed: `BG0100.ARE` corruption, stray `OggS` bytes in unrelated SPLs). Fix moves large binary types (`.tis`, `.mos`, `.pvrz`, `.bam`, `.bmp`, `.wav`, `.are`, `.wed`) into `weidu_external/_eetmr_preserve/` before `MAKE_BIFF`, then restores them — the resulting BIFF comes in at ~268 MB. Documented in `docs/LARGE_INSTALL_FIXES.md`

- **`delete_if_exists` patch op** — New op that just removes a file. Fixes patches whose goal is "ensure this marker doesn't exist" (e.g. imoen_forever's stale do-once marker) that were previously shoehorned into `rename_if_exists` with swapped src/dest, which silently no-ops when src exists (wrong semantics for the disable-a-file use case)

- **`check_marker` invert-flag bug** — The bare file-exists marker branch was dropping the `invert: true` flag, so patches that needed "apply when file is present / skip when file is absent" semantics incorrectly appeared as already-applied. Same bug also hit the markerless `check_dir` / `check_game_file` / `check_game_dir` / `check_game_file_contains` branches. All four now honor invert

- **Per-component `observed` status survives batch-failure reclassification** — When a batch exited non-zero because one component failed, the runner previously blanket-marked ALL batch components as `Error`, then `refine_results_from_log` downgraded the successful siblings to `Warning` ("Installed with errors (found in weidu.log)") — a false classification. Now `runner.rs::build_results_from_observed` trusts WeiDU's per-component stdout (`SUCCESSFULLY INSTALLED` → Success, regardless of batch exit code)

- **User-abort surfacing** — `install.log` now emits a `[USER_ABORT]` event the moment the GUI abort button is clicked, and any pending batches that the abort intercepted emit `[ABORT_SKIP]` (not the misleading `[FATAL_SKIP] WeiDU failed to start`). `install_log::log_active_event` routes external callers (e.g. `abort_native_install` Tauri command) through a global `OnceLock`-protected logger handle so events from outside the orchestrator thread land in the right session log

- **Per-mod timeout override + single-`cn` batch sharding** — `InstallConfig::per_mod_timeout_secs` and `force_single_cn_mods` maps, loaded from `install_config.json`. Seeds `dw_talents` with 6h timeout (up from the 2h global default) and splits cn:60200 (Revised HLAs) + cn:60300 (Leveller) into their own single-component batches, so a timeout on one slow SFO graph-walk no longer drags two siblings into AUTO_SKIP. Resolves a real Test #38 failure where three components got AUTO_SKIPPED after the retry also hit the 2h cap. **Material install-quality win on megainstalls**: the 11.6h run prior to this change had dw_talents at 74% installed (14 of 53 components cascade-skipped when cn:60200 hit the 2h timeout and orphaned the downstream batches); with the timeout raised to 6h + cn:60200 sharded, the same install completed dw_talents 100% (cn:60200 took 4.9h and ran to completion instead of dying at 2h)

- **BIFF-then-delete optimization** — `run_prebiff_optimization` now deletes the originals from override/ after `MAKE_BIFF` succeeds, gated behind the new `aggressive_biff_cleanup` config (default on). Background: WeiDU's `MAKE_BIFF` copies files into a biff but doesn't remove them from override/ — the orchestrator's pre-biff step was running MAKE_BIFF on 122k files, the biff was created fine, but override/ stayed at 122k files. WeiDU's resource resolution checks override/ first, found the files still there, and loaded from disk on every lookup. The biff was effectively unused. With cleanup enabled, override/ drops from 122k → ~60 files after the pre-biff step. Expected impact on the next megainstall: dw_talents cn:60200 (the 4.9h EMPOWERED_MONSTER_SUMMONING graph walk) iterates ~60 override files instead of 122k — worst case we drop from 4.9h to under 30min on that single component. Safety nets: (1) only deletes files we snapshotted BEFORE MAKE_BIFF, so auxiliary biff outputs are left alone; (2) verifies the biff file exists and is >1KB before deleting, to rule out silent MAKE_BIFF failures; (3) disabled by default for the one-off `check_install_checkpoint` entry point which doesn't actually run MAKE_BIFF

- **WeiDU `Sys_error` promotion** — `refine_results_from_log` now reads `WSETUP.DEBUG` and promotes a Success→Skipped candidate to a hard `Error` when WeiDU fatal-errored at startup (`FATAL ERROR: Sys_error(...)` — typically a missing/wrong tp2 path). Previously those failures looked like silent-skips because WeiDU still exited 0; Test #38 had 11 `klatu` components disappear this way before the fix

- **`NO_LOG_RECORD` awareness in silent-skip detection** — Components whose tp2 declares `NO_LOG_RECORD` legitimately don't appear in `weidu.log`; those no longer get false-flagged as silent-skipped. Per-mod cached tp2 scan stripping `//` comments

- **BIFF manifest `rename` → proper move** — `rename_if_exists` and `rename` ops documented carefully; the "rename" op actually copies (safe on Windows case-insensitive filesystem for case-only renames like `O!Tal.cre` → `O!TAL.cre`), while `rename_if_exists` is strictly the "restore pre-MOVE state" primitive. New `delete_if_exists` covers the remaining "remove a file" case

- **Patch #60 (EPS POTN18)** — Drops `POTN18` from the `BUFF_PRO_DAMAGE` detectable-spells table in Enhanced Powergaming Scripts. Some upstream mod leaves `POTN18.itm` with inconsistent ability-header offsets, triggering WeiDU's `CLONE_EFFECT` walker to crash with "cannot convert abil_num to an integer" and rollback the whole "Accelerated Pre-Buffing Speed" component. Losing POTN18 from DS tracking loses one buff-detection entry; the component installs

- **Forge wp-path audit script** — `scripts/audit_wp_paths.py` in Infinity Mod Forge walks all `data/mods/*.json` and flags any component `wp` (WeiDU path) that doesn't match an actual tp2 on disk. Found 60 wrong entries in `klatu.json` (pointing to non-existent `klatu\klatu.tp2` when the file is `klatu\setup-klatu.tp2`) plus 11 more across 7 mods (`1sylm`, `ANIMALCOMPANIONS`, `DarkHorizons`, `ISHLILKAMOD`, `iwdification`, `semi_multi_clerics`, `tb#tweaks`). `--fix` mode auto-corrects. The `klatu` case was the most visible: 11 components silently skipped in Test #38 because WeiDU fatal-errored on the wrong filename but still exited 0 (now caught by Sys_error promotion above)

- **Heavy batch size setting + confirmable input** — Exposed the per-heavy-mod batch ceiling (previously hardcoded to 3) as a user setting in Install → Advanced Options. Uses a new `ConfirmableNumericOption` component that holds changes as a draft and only persists on explicit Confirm click (Enter also commits). Button states: gray **Saved** when clean, amber **Confirm** when dirty, red **Confirm** above the 10-component safety threshold, and a green **✓ Saved** flash after commit. Motivated by a session where a user set `=10` in the UI but the installer silently ran with `=3` — two contributing bugs below

- **User-initiated pause emits events + timer freezes** — The orchestrator now emits `install:pause` and `install:resumed` at batch boundaries for user pauses (previously only pre-configured `PausePoint` markers fired these — user pauses just flipped an atomic and busy-waited silently). The UI transitions Pausing… → Paused with a distinct green banner, freezes the elapsed-time counter for the duration of the pause (accumulator folds the paused delta back in on resume), and logs a confirmation line. Previously the "Pause requested" banner stayed up forever and the clock ran through the pause, throwing off ETA and reality-factor math

- **`save_config` persistence visibility** — `save_config` now emits `app:config-saved` / `app:config-save-failed` Tauri events on every call, and the frontend routes both to `gui.log`. Previously a disk-write failure hit only `console.error` in the dev panel — discovered during this install that `config.toml` hadn't been written in 2+ weeks (legacy `mod_installer_path` field still present, new fields like `heavy_batch_size` never persisted). First successful save after launch logs the resolved config path once, so "where is my setting going" is answerable at a glance on the next launch

- **`INSTALL_OPTION_KEYS` scope fix** — The snapshot list backing Save Defaults / Restore Defaults was missing `heavy_batch_size` and `language_fallback`. Restoring defaults silently left these fields untouched, so a user-saved value could revert to the struct default on the next restore cycle. This is the second half of the "heavy=10 didn't take effect" story — the saved-defaults path was filtered-ignored, and the save-to-disk path was silently failing. List now covers every user-visible install-tab option with a stay-in-sync comment

- **Cascade-skipped batch log format** — Batches pre-skipped because an upstream batch in the same mod failed used to log as `Batch N/M done in ?: mod — 0 ok, 3 skip`, which read as "we lost the timing." Now logged as `Batch N/M cascade-skipped: mod — 0 ok, 3 skip`, matching the `skipped (N primary, M cascade)` split already used in the completion line. Detection: no `batch_start` was recorded AND all components are skips

- **Install-start batch-size diagnostic** — New `gui.log` line at install start: `Batch sizes: normal=25, heavy=3 (heavy applies to dw_talents, stratagems, mih_*, trap_overhaul)`. Makes "my setting didn't take effect" class bugs visible immediately in post-install diagnostics instead of requiring forensic batch-count analysis (53 dw_talents components ÷ 18 batches = 3 components/batch → heavy=3 regardless of what the UI showed)

- **Heavy batch size precedence fix (the real cause of "heavy=10 doesn't work")** — `RuntimeConfig::load(…)` was unconditionally overwriting `config.force_small_batch_size` with the `install_config.json` default (3) AFTER the UI value had been set from `args.heavy_batch_size`. The UI → IPC → struct wiring was correct; the RuntimeConfig copy block just clobbered the user choice. Gated both the native install and the dry run: `if args.heavy_batch_size.is_none() { config.force_small_batch_size = rt.force_small_batch_size; }`. With heavy=10 now actually taking effect: dw_talents 53c shrinks 19b → 8b, stratagems 92c shrinks 31b → 10b, plan estimate drops 10.8h → 6.7h (before the 1.07× reality factor)

- **Warning classification pipeline (end-to-end)** — The Issues panel previously grouped every "Installed with warnings" into an undifferentiated count, which reads as scary to non-expert users even though 80–90% of BG-modding warnings are cosmetic (TRA tag fallbacks, kit-id shuffles, IDS collisions, BCS decompile noise already caught by our patches). Full pipeline now lands:
  - **Backend** — `ComponentTimer` captures raw `WARNING:` stdout lines per component (capped at 50/component with a truncation marker to bound IPC payload) and attaches them to the `ComponentResult` shipped in `install:batch_done`. `ComponentResult` gets a new `warnings: Vec<String>` field with `#[serde(default, skip_serializing_if = "Vec::is_empty")]` so clean components don't bloat the payload (`src-tauri/src/installer/runner.rs` — `ComponentTimer.warnings`, `is_warning_line`, `capture_warning`)
  - **Frontend classifier** — New `src/lib/warning-classifier.ts` compiles Forge patterns into JS RegExps (cached), runs per-mod entries first then global `mod: "*"` entries (so specific wins over generic), and returns per-line `ClassifiedWarning` + aggregate `WarningSummary`. Categories: `cosmetic`, `likely-benign`, `caution`, `concerning`, plus `unknown` for unmatched lines (a signal to triage). User actions: `none`, `retry`, `apply-patches`, `check-docs`, `contact-author`
  - **Issues panel UI** — Collapsed group row now renders a severity-coloured chip ("3 cosmetic · 1 unknown") next to the message, colored by the worst category present. Expanded row lists each WARNING line verbatim with a category pill, the catalog's description inline, and the workaround as a hover tooltip. Falls back to the pre-feature UX when the catalog fails to load (chip just doesn't render)
  - **Schema docs + Forge README** — Added `category` and `user_action` fields to `ki` entries + a classification rubric table to the "Adding known issues" section. All 52 pre-existing `ki` entries across 35 mods got back-classified via `scripts/classify_ki.py` (keyword heuristics over severity + description/workaround/pattern), same for the 27 global entries in `data/known_issues.json` via `scripts/classify_global_ki.py`. Expanded the global catalog with 10 new patterns covering TRA tag fallbacks, resource-missing, kit-index shuffle, IDS-append idempotency, REPLACE_TEXTUALLY zero-match, item ability mismatches

- **Pre-existing `InstallConfig` initializer drift** — Three `InstallConfig { … }` initializers in `commands.rs` (native install, dry run, checkpoint read) were missing the `force_single_cn_mods` and `per_mod_timeout_secs` fields added elsewhere. Code only compiled because incremental builds weren't re-checking those files. Now consistent; duplicate assignment in the dry-run `RuntimeConfig`-copy block also removed

- **`ComponentResult` and `ComponentStatus` now derive `Default`** — `ComponentStatus::Success` is the `#[default]` variant, making 17 constructor sites idiomatically handle the new `warnings: Vec<String>` field without a full audit (they still do, because Rust's exhaustive-struct-init rule forbids partial `..Default::default()` without it; but future field additions won't force the same wave of manual edits)

- **Documentation** — Two new docs targeting maintainers and power users: `docs/UNSOLVABLE_ISSUES.md` (b3-reducesavecompression binary signature drift, SPPR111 corruption of unknown source, SPLSTATE.IDS 256 engine cap) and `docs/LARGE_INSTALL_FIXES.md` (BIFF wraparound, STATS.IDS sort bug, SFO alter_script, cross-mod CRE, imoen marker persistence, silent-skip detection, slow-scanner UX)

#### v1.0.2-beta — WeiDU fork & engine instrumentation

Also shipped in the 12.2h binary. Out-of-tree patched-WeiDU companion changes:

- **WeiDU source internalized** — Retired the out-of-tree `F:/BGMods/weidu_fork/` build workspace. The full WeiDU 251 source tree now lives at `src-tauri/weidu_experimental/weidu_src/` (276 files, ~3 MB), directly editable in this repo with changes tracked in git log. CI rewritten to build from the vendored tree instead of cloning upstream and applying patches. A new headless smoke-test job (`weidu_src/test/good-syntax/`, `bad-syntax/`, `no-game/` plus a `BCS_CACHE_STATS_JSON` line presence check) gates `commit-binaries` — broken binaries never land on main. Deleted the `patches/01-resilient-decompile.patch` unified diff; rationale now lives as inline OCaml comments in `tppatch.ml`. `meta.json` gains a `source_tree` field and bumps `patch_revision` to 2
- **BCS buffer cache (engine level)** — New `bcs_buffer_cache.ml` module that memoizes loaded BCS/BAF buffers at `Load.load_resource`, eliminating redundant zlib decompression on repeated biff reads. LRU with a 256 MB default cap (configurable via `WEIDU_BCS_CACHE_MB`; `0` = fully disabled, for A/B baselines). Scope-gated to BCS+BAF only; defensive `String.copy` on insert + lookup because the build uses `default-unsafe-string` and several callers mutate buffers in place (e.g. `tpaction.ml:791`). Invalidation hooks at `Util.open_for_writing_internal` (covers COPY / EXTEND / COMPILE_BAF_TO_BCS), `TP_Delete`, `TP_Move`, plus full `clear()` on KEY reloads (`TP_Biff`, `TP_DecompressBiff`). Pinned `Hashtblinit` (OCaml 4.03 API) forced the `try Hashtbl.find … with Not_found` idiom instead of `find_opt`. **Measured end-to-end impact:** 69% hit rate on dw_talents (173k lookups, 120k hits), 92.9% on the single slowest batch, peak 185 MB well under the cap, zero evictions across a full 1649-component install. Wall-clock reduction is modest on today's workload because filesystem enumeration — not biff decompression — is the dominant cost when override contains 122k+ files; the cache becomes load-bearing once override is shrunk by the delete-after-BIFF orchestrator optimization (landing separately). See `tools/AB_PLAN.md` for the four-point measurement procedure once both levers are in place
- **Profile-driven bottleneck reassessment** — First end-to-end install with the cache produced a diagnostic surprise: dw_talents batch 384 took 4h52m wall-clock with **~1-2 seconds of user CPU** (extracted from `WSETUP-dw_talents.DEBUG`'s built-in `Stats.time` table — WeiDU has 33 pre-existing instrumentation categories we discovered rather than added). User CPU ÷ wall clock ≈ 0.01%, meaning nearly all time is in syscalls and I/O wait, not OCaml execution. The original research that motivated the cache (biff decompression as hot path) held up in isolation but was dwarfed by NTFS enumeration overhead on a saturated override. Documented in `tools/AB_PLAN.md` as the reason future perf work at the OCaml layer is gated on measuring the post-BIFF-fix workload first — engine-level caching can't help with costs that never enter OCaml. Meta-principle added: **if wall-clock is >10× the estimated CPU cost of a change, measure before you build.**
- **BCS buffer-cache telemetry** — Patched WeiDU emits `BCS_CACHE_STATS_JSON {…}` on stderr from its `at_exit` handler; emission is always-on (fires even when disabled or cold) so a missing line definitively signals a hard WeiDU exit (segfault/abort) rather than silent zeros. Rust parses it with tolerant deserialization (new fields via `#[serde(default)]`, optional `current_kb` / `max_mb`) in `cache_stats.rs`. Three-state result: `None` = not a cache line, `Some(Ok)` emits `install:bcs_cache_stats`, `Some(Err)` emits `install:bcs_cache_stats_parse_error` so format drift surfaces as a diagnostic instead of being dropped. `install_log::log_stderr` now captures both `BCS_CACHE_STATS_JSON` and human-readable cache lines to disk (previously filtered out because they don't contain error/warning/fatal) so post-install analysis can run against `install.log` alone
- **Per-batch cache badge** — Install dashboard renders a live hit-rate badge next to the current mod, color-coded (≥90% green, 50–90% gold, <50% orange, dimmed for disabled/cold). Tooltip (via the portal-rendered `Tip` component) breaks down hits / misses / evictions and peak memory against budget
- **Post-install cache card** — New aggregate card in the run summary: overall hit rate, peak memory across any batch, total evictions, and "worst-rate batch" (gated on ≥100 lookups so single-lookup cold starts can't dominate the metric). Renders a distinct compact variant when every batch had the cache off (A/B baseline run)
- **Build-system portability (Windows `mingw32-make`)** — Moved the dep-line Perl normalizer out of `Makefile.ocaml` into a standalone `scripts/fixdepend.pl`: the original one-liner's character class `[/\\]` got its backslashes mangled by `mingw32-make` on Windows, silently corrupting every `.depend` file and leaving modules in wrong build order. Added `-I +str -I +unix` to the 5 `ocaml str.cma unix.cma` invocations in `Depends` so builds work against both opam layouts (cma at stdlib root) and MSYS2 layouts (cma in `lib/ocaml/str/` subdirs). No regression on the Linux/macOS CI paths
- **Dev tooling for experimental WeiDU** — New `src-tauri/weidu_experimental/tools/`: `analyze_install_log.py` (per-batch cache + timing summary with `--ab` two-log diff mode), `smoke_test.sh` (headless syntax + cache-integration gate against a built binary, exit-coded for CI), `TESTING.md` (build + single-run sanity checklist, red-flag inventory), and `AB_PLAN.md` (four-point factorial test procedure for cache × delete-after-BIFF, with prediction table, run-ordering strategy for page-cache hygiene, and interpretation playbook for each outcome combination). Python-stdlib-only analyzer; bash smoke test with scratch-dir isolation
- **Multi-game backup** — Backup system extended beyond BG1:EE/BG2:EE to include IWD:EE, IWD2, and PST:EE. Segmented game-tab picker; per-game override directories in the config; orphaned-backup detection for snapshots whose original game dir is gone; a new `verify_backup` Rust command re-checksums a snapshot on demand
- **A/B comparison plan** — Phase 11c (`infinity-mod-runner-phase11c-bcs-ab.md`) scopes the next step: persisted per-run cache data keyed by a mod-list hash, a Debug-tab picker for paired runs, and a diff view surfacing time/hit-rate deltas

### v1.0.0-beta
- **File Guard** — Post-batch md5 snapshots of override files detect silent cross-mod corruption between batches. A shipped `guard_allowlist.json` encodes legitimate multi-writer files; unexpected drift is auto-restored from snapshot or pauses the install, and a `guard_report.json` is written for diagnosis (`src-tauri/src/installer/file_guard.rs`)
- **Resilient WeiDU (opt-in experimental)** — Bundled patched WeiDU binaries per platform in `src-tauri/weidu_experimental/`. New `ExperimentalWeiduPanel` lets users swap the game's WeiDU for the bundled build for a single install run; the original is restored afterward (`src-tauri/src/weidu_swap.rs`). Meta + maintenance workflow documented alongside the binaries
- **Override acceleration** — Optional symlink / Windows junction pooling so multiple game installs share read-only override state without duplicating gigabytes (`src-tauri/src/installer/override_accel.rs`)
- **Expanded patch library** — Patch manifest grown from 35+ to 50+; includes new kit patches (`bristlelick`, `walahnan`, `c#anotherfinehell`) plus fixes across `dw_talents`, `iwdification`, `mih_*`, and `stratagems`
- **Constants refactor** — Frontend configuration extracted into `src/constants/` (`forge`, `installer`, `ui`, `version`) for easier tuning
- **Bundled-binary CI** — New `weidu-rebuild.yml` workflow builds and caches the experimental WeiDU binaries per platform

### v0.9.0
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

### v0.8.0
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

### v0.7.0
- **Download Manager** — New Download tab auto-downloads GitHub mods using Forge's `version_cache.json` (no API key or PAT required). Constructs download URLs from cached release tags. Batch download with progress. Per-mod "view" links open source pages in the default browser via `tauri-plugin-opener`. Manual download section with "Open in Browser" for non-GitHub mods (Beamdog forums, Nexus, Weasel Mods, etc.)
- **Batch mod existence check** — Single Rust command indexes all tp2 files once and checks 400+ mods against the index, replacing 400+ individual filesystem calls
- **Pre-flight mod download check** — Pre-flight now verifies ALL mods from the import are present on disk (not just the first 5). Directs users to the Download tab for missing mods. Progress bar during checks with step-by-step status
- **Progress bar accuracy** — Download progress percentage only shows 100% when all mods are truly ready (no rounding up from 99.x%)
- **Splash screen** — Loading overlay with progress bar during startup. Pre-loads config, Forge connectivity, game directory validation, and saved logs. App renders hidden underneath for instant display
- **Centered tab bar** — Tabs are now centered in the tab bar for a cleaner look
- **Performance** — Download plan builds via explicit button instead of auto-running on mount (was causing 2-3 min freeze). Loading step indicators during plan building
- **reqwest + zip fix** — Switched to `rustls-tls` (from `native-tls`) and `deflate`-only zip to eliminate `liblzma-5.dll` missing error on Windows

### v0.6.0
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

### v0.5.0
- **App icon** — Steel anvil with gold bow arrow, all platform sizes
- **GUI logger** — `gui.log` in app config directory for diagnosing GUI issues
- **Pause/Resume** — File-based IPC between GUI and mod_installer
- **ETA calculation** — Rolling 5-minute throughput window
- **Performance overhaul** — Ring buffer log (500 lines max), throttled rendering, memoized computations. Constant memory usage
- **Debug panel rewrite** — 500MB+ files parsed in Rust backend. Error deduplication, warning noise filtering, per-mod `ki` known issues from Forge
- **Install options** — All mod_installer CLI flags exposed with collapsible Advanced section
- **Cross-platform** — libc dependency, Unix paths, case-insensitive chitin.key, safe process kill
- **Stability** — Tab persistence, double-click guard, event listener cleanup, mutex safety

### v0.2.0
- **Real-time install monitoring** — Polls `install_status.json` from both game directories
- **Status dashboard** — Progress bar, error/warning/skipped counters, elapsed time
- **Process management in Rust** — Subprocess spawning, stdout/stderr streaming, stdin pipe, process tree kill
- **Install options** — Skip installed, never abort, timeout, download mods
- **Game freshness detection** — Warns if game directory has been modded
- **Wrong log slot detection** — Warns if logs are swapped
- **Mod list** — BGEE mods first, dual-install mods show separately, SETUP- prefix stripped

### v0.1.0
- **Initial release** — Tauri v2 + React 18 + TypeScript
- Five-tab layout: Setup, Import, Pre-Flight, Install, Debug
- Forge color scheme, config persistence, game directory validation

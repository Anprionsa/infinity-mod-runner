# BCS Buffer Cache — Test Procedure

Operational checklist for running the first install with the BCS buffer cache
enabled. Ordered so each step gates on the previous passing.

## Stage 0 — Build (one-time per source change)

**Prerequisites** (one-time per machine):

- [opam 2.5+ for Windows](https://opam.ocaml.org/doc/Install.html) (via `winget install OCaml.opam`). `opam init --bare --auto-setup` once.
- An opam switch with OCaml 4.14.2 + default-unsafe-string (matches CI):
  ```bash
  opam switch create weidu --packages=ocaml-variants.4.14.2+options,ocaml-option-default-unsafe-string
  ```
- MSYS2 MinGW64 for `mingw32-make`, `gcc`, `windres`, and POSIX tools (`sed`, `cp`, `find`).
- Elkhound 1.0.3 at `weidu_src/bin/elkhound.exe` — download from [The-Mod-Elephant/elkhound releases](https://github.com/The-Mod-Elephant/elkhound/releases/download/1.0.3/elkhound.exe).

**Build** (Windows / MSYS2 bash):

```bash
# opam on Windows uses Cygwin-style paths in its env output, which MSYS2 bash
# can't resolve — `opam exec` sidesteps that by running the command inside
# opam's env and letting us append MSYS2's /c/msys64/mingw64/bin for the tools
# opam doesn't provide (make, gcc, windres).
opam exec --switch=weidu -- bash -c '
  export PATH="$PATH:/c/msys64/mingw64/bin:/c/msys64/usr/bin:$PWD/bin"
  cd src-tauri/weidu_experimental/weidu_src
  mingw32-make
'
```

Output: `weidu.asm.exe` at `weidu_src/` root (native-code build naming; it's a
real `.exe`). Rename or copy to `weidu.exe` for convenience:

```bash
cp src-tauri/weidu_experimental/weidu_src/weidu.asm.exe \
   src-tauri/weidu_experimental/weidu_src/weidu.exe
```

Full rebuild after source changes: `mingw32-make clean && mingw32-make`.

**On Linux / macOS** — CI builds clean with opam's default layout (cma files
in stdlib root), so the portable tweaks in this repo's `Depends` (`-I +str
-I +unix`) and `scripts/fixdepend.pl` (Perl extracted from the Makefile) are
no-ops. Just `opam exec --switch=<your-switch> -- make` from `weidu_src/`.

## Stage 1 — Smoke test (seconds)

```bash
opam exec --switch=weidu -- bash \
  src-tauri/weidu_experimental/tools/smoke_test.sh \
  src-tauri/weidu_experimental/weidu_src/weidu.exe
```

What it checks:
- `--version` exits 0 and reports `25201`.
- 10 `good-syntax/*.d` files compile with `--nogame`.
- 3 `bad-syntax/*.d` files produce `PARSE ERROR` / `FATAL ERROR` / `syntax error` in output. (WeiDU exits 0 even on parse errors in CLI compile mode, so exit-code-based detection doesn't work — grep the output.)
- 1 `no-game/*.d` file compiles.
- stderr contains a `BCS_CACHE_STATS_JSON` line (confirms cache module is wired in).

Exit codes: `0` pass; `1-4` different failure categories; `5` usage error.

**Gate:** don't proceed to Stage 2 if smoke tests fail. Cheaper to fix here
than after burning hours on a real install.

## Stage 2 — Mod runner configuration

Point mod runner at the newly-built binary. Two ways:

- **Option A (recommended for this test):** in mod runner Settings, set the
  WeiDU path to the absolute path of your fresh `weidu.exe`. Direct swap,
  no repackaging.

- **Option B:** repackage into `src-tauri/weidu_experimental/binaries/windows-x86_64.zip`
  and let the Resilient WeiDU toggle pick it up. Requires updating `meta.json`
  SHA256 — more work, reserve until you're ready to ship.

## Stage 3 — Measurement

> **Update:** the original cache-on-vs-off two-way A/B is superseded.
> Profile data from the first end-to-end run (dw_talents batch 384:
> 4h52m wall clock, ~1-2s user CPU, 92.9% cache hit rate) showed the
> dominant bottleneck is **filesystem enumeration on a saturated override/**,
> not the I/O + zlib decompression that the BCS buffer cache targets. The
> cache still helps — it eliminates biff-read decompression — but only
> once the FS-enumeration cost is attacked (via the orchestrator's
> delete-after-BIFF optimization, shipping separately).
>
> The correct measurement is a **four-point factorial** across `{cache
> off, cache on} × {BIFF fix off, BIFF fix on}`. See
> [AB_PLAN.md](AB_PLAN.md) for the procedure once both levers are in
> place.

### Quick single-run sanity (no A/B)

Still useful for confirming the cache is wired correctly before committing to a full A/B. One install, cache defaults on. Verify from `install.log`:

- Every batch has a `[STDERR] BCS_CACHE_STATS_JSON {...}` line. Missing on a batch = WeiDU died before `at_exit`.
- SFO-heavy batches (dw_talents, stratagems) show `enabled:true` + non-zero hits.
- `peak_kb` stays under 262144 (256 MB cap) with `evictions` near zero.
- No `install:bcs_cache_stats_parse_error` events anywhere.

Then run:
```bash
python3 analyze_install_log.py /path/to/install.log
```

For the per-mod cache-stats breakdown, pipe to the ad-hoc script in AB_PLAN.md
or write a small grep over `[STDERR] BCS_CACHE_STATS_JSON` lines. The
`analyze_install_log.py` top-slowest-batches table is most useful; the
`--ab` mode is designed for two matched runs (see AB_PLAN.md).

### How to force `WEIDU_BCS_CACHE_MB=0` for a disable run

`engine.rs` only plumbs `OCAMLRUNPARAM` explicitly; other env vars inherit
from the shell that launched mod runner. Set it before launching:

```powershell
# PowerShell
$env:WEIDU_BCS_CACHE_MB = 0
# then launch mod runner from the same shell
```

```bash
# bash
export WEIDU_BCS_CACHE_MB=0
# then launch mod runner from the same shell
```

Confirm disable took effect: first batch's `BCS_CACHE_STATS_JSON` line in
`install.log` must have `"enabled":false` and `"max_mb":0`.

## Red flags

- No `BCS_CACHE_STATS_JSON` lines at all → patched binary isn't being used, OR
  WeiDU crashed before `at_exit` (check for segfault in stderr).
- `install:bcs_cache_stats_parse_error` events in the Tauri bus → emitter
  format drifted; run `analyze_install_log.py --json` to see the raw body and
  update the parser/emitter.
- `weidu.log` byte-differs from a known-good baseline → cache broke correctness.
  Diff the two `weidu.log`s; look for missing component lines or reordering.
- `[SILENT_SKIP]` event count in the cached run > baseline → cache may be
  skipping a patch's intended write. Escalate before wider testing.
- `peak_kb` at 262144 AND `evictions` in the thousands on an **SFO-target**
  batch (dw_talents, stratagems, cdtweaks, mih_tweaks) → cap is undersized
  for this workload; bump `WEIDU_BCS_CACHE_MB` to 384 or 512. (Saturation on
  non-SFO mods like eet_end is expected — see below.)

**Not a red flag** (expected based on the first end-to-end install):
- **Low hit rate (0-5%) on any single-pass workload.** The cache only helps
  when the same buffer is loaded multiple times. Mods doing one sweeping
  pass over thousands of resources — EET infrastructure mods like `eet_end`
  and `eet_tweaks` running final fixups, `metweaks` doing its one-shot
  patches, small mods with one or two components — will show 0-5% hit rates,
  high miss counts, and (for large ones) heavy eviction with peak_kb=262144.
  Measured example from the first end-to-end run: `eet_end` had 1 hit out of
  20,003 lookups with 9,964 evictions. That's the workload shape, not a
  cache defect. The <5% SFO threshold in the AB_PLAN discard table applies
  **only** to dw_talents / stratagems / cdtweaks / mih_tweaks batches.
- High hit rates that don't translate to big wall-clock reductions in a
  `BIFF-fix-off` run — the cache saves biff-decompression cost, which is
  small relative to FS-enumeration cost on a saturated override. The cache
  becomes load-bearing only after override is shrunk. See [AB_PLAN.md](AB_PLAN.md).

## Rolling back

If the cached run corrupts the install:
1. Kill any running WeiDU process.
2. Restore the pre-install game backup.
3. Set mod runner's WeiDU path back to the stock binary.
4. Save the broken `install.log` for later analysis; do **not** overwrite.

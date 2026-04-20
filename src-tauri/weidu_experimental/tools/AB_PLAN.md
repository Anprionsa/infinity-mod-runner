# Four-Point A/B Plan — BCS Cache × Delete-After-BIFF

Measurement procedure for quantifying each optimization's contribution
separately. Applies **once all three levers are in place**: the BCS buffer
cache (in the bundled WeiDU), the delete-after-BIFF optimization
(orchestrator-side, v1.0.3), and the override fast-drive redirect
(existing feature, must be explicitly enabled by the user).

## Three levers, one dominant

Post-v1.0.2 measurements and a v1.0.3 aborted-run profile together
revealed the actual cost structure for SFO-heavy workloads:

| Lever | What it addresses | Order of magnitude |
|---|---|---|
| **`override_fast_drive`** (RAM disk / NVMe) | Per-file **write** cost on NTFS + Defender | **10-50× speedup** on write-heavy components. Dominant lever. |
| **`enable_biff_delete_optimization`** | Per-file **read / iteration / stat** cost on a saturated override | Modest; eliminates a few minutes to a few tens of minutes per SFO batch |
| **`WEIDU_BCS_CACHE_MB` / BCS buffer cache** | Zlib decompression on repeated biff reads | Modest; ~15-30 min saved aggregate across an install |

**Where the original 2-lever framing went wrong:** we assumed the
dw_talents cn:60200 4h52m outlier was I/O-read-bound (hence the cache)
or enumeration-bound (hence delete-after-BIFF). Both were real but small.
The actual dominant cost is the **~130,000 sequential file writes per
slow SFO component**, where each write on NTFS with Windows Defender
active runs ~25ms in kernel/IO-wait time. That's the shape of the
~4-5h figure, and it lives in a layer none of the OCaml-side levers can
touch. See the `v1.0.3-beta` changelog notes in README for the profile
evidence.

**Consequence for A/B design:** the 4-point `cache × BIFF` matrix
measures **residual contribution on top of a fast-drive-ON baseline**.
Running any of the four points with `override_fast_drive=off` is a
separate measurement answering a different question ("how bad is NTFS
without fast-drive?") and should not be mixed with the cache/BIFF
factorial — the write-cost delta will swamp everything else.

## Why four points, not two (for cache × BIFF)

The original cache-on-vs-off A/B gave a misleading picture: dw_talents
batch 384 measured 92.9% cache hit rate and still took **4h52m wall
clock with ~1-2s user CPU**. The cache works as designed — it eliminates
biff-read decompression — but the dominant cost in that workload was
filesystem enumeration over a saturated override (122k files), not
anything the cache can cache. And *that* turned out to be a second-tier
cost relative to per-file write overhead. A two-way A/B on the cache
alone made the cache look marginal in a world where the *real* lever is
the one we hadn't measured.

A four-point factorial decomposes total wall-clock gain into three
meaningful attributions:

```
        cache OFF      cache ON
      ┌────────────┬────────────┐
BIFF  │   [A]      │    [B]     │   Cache contribution on saturated override
OFF   │  baseline  │  cache only │   (expected: small, matches our measured data)
      ├────────────┼────────────┤
BIFF  │   [C]      │    [D]     │   BIFF contribution standalone (expected: 10x)
ON    │  BIFF only │  combined  │   + cache contribution after override-shrink
      └────────────┴────────────┘   (the interesting number for 1.1)
```

Key deltas:
- **`[A] − [C]`** — how much does delete-after-BIFF alone buy us
- **`[A] − [B]`** — how much does the BCS cache alone buy us on today's workload
- **`[C] − [D]`** — **how much does the BCS cache buy us *after* the BIFF fix** — this is the question we can't answer any other way
- **Non-additivity**: if `(A − B) + (A − C) ≠ (A − D)`, there's interaction; the interpretation is that one lever reveals / hides the other's ceiling

## Test workload selection

Four full-preset installs at ~6-10h each is not practical (~30h of machine time). Use a **targeted subset** that contains the known hot batches:

### Option 1 — Single slow component (fastest iteration, ~30m-5h per run)

Target: `dw_talents` `cn:60200` (Revised HLAs). The known 4h52m outlier.

- **Prereq:** a game backup taken at the point where `dw_talents` is the next mod to install, with all prior mods (all ~350 of them) already installed and the override at full saturation.
- **Run:** restore from backup, set the config for this point, invoke WeiDU directly:
  ```
  weidu.exe dw_talents/dw_talents.tp2 --force-install 60200 \
      --use-lang en_US --language 0 --no-exit-pause \
      --noautoupdate --quick-log --autolog --logapp --log-extern
  ```
- **Cost per run:** 30m (BIFF-on) to 5h (BIFF-off baseline). Four runs: ~6-10h total.
- **Good for:** pinning down the exact magnitude of each lever on the worst case.
- **Caveat:** single component doesn't exercise the full cache warm-up pattern across a batch.

### Option 2 — SFO stretch only (~2-8h per run)

Target: `dw_talents` + `stratagems` + `mih_tweaks`, skip everything else.

- **Prereq:** backup at "just before the SFO stretch" — i.e., after the main BG2/ToB mods but before dw_talents.
- **Run:** preset containing only those three mods, let mod runner drive the install as normal.
- **Cost per run:** 2h (both on) to 8h (both off). Four runs: ~15-30h total.
- **Good for:** realistic scaling, includes auto-BIFF orchestration, shows cache warm-up across a batch stream.
- **Caveat:** the longest total runtime, but closest to real user experience.

**Recommendation: start with Option 1 for the headline number, escalate to Option 2 only if the combined-run data has surprises.**

## Four runs, same starting state each time

The discipline is: restore from the same backup before every run. Anything that drifts between runs (extra files in override, cached page data, AV scan state) contaminates the delta.

**Prerequisite: `override_fast_drive: true` for ALL four runs**, pointed at a RAM disk or NVMe. Without this, the NTFS per-file-write cost swamps every other signal. The four-point matrix below varies only the cache and BIFF levers, holding fast-drive constant. Set this in mod runner Settings → Install → Advanced → "Redirect override/ to fast drive" and confirm the install-start `Performance levers:` line reads `override_fast_drive=on`.

| Run | Cache state | BIFF-fix state | Fast-drive | Env var | `install_config.json` |
|---|---|---|---|---|---|
| **[A] Baseline** | OFF | OFF | **ON** (prereq) | `WEIDU_BCS_CACHE_MB=0` | `"enable_biff_delete_optimization": false` |
| **[B] Cache only** | ON (256 MB) | OFF | **ON** (prereq) | unset (default) | `"enable_biff_delete_optimization": false` |
| **[C] BIFF only** | OFF | ON | **ON** (prereq) | `WEIDU_BCS_CACHE_MB=0` | `"enable_biff_delete_optimization": true` |
| **[D] Combined** | ON (256 MB) | ON | **ON** (prereq) | unset (default) | `"enable_biff_delete_optimization": true` |

**Config source of truth:** `install_config.json::enable_biff_delete_optimization`. When set there, it overrides the UI default. Applied by both `start_native_install` and `start_dry_run`, so dry-run batch-count previews match reality.

**Optional fifth run — the "is fast-drive worth it" baseline:** a separate one-shot with all three levers OFF, compared against any of `[A]`–`[D]`, quantifies the fast-drive contribution in isolation. Not part of the cache × BIFF matrix; run only if you want that number in the report. Expect this to be the biggest single delta of any comparison — predicted ~10-50× on the write-heavy SFO components.

Between runs:
1. Restore the game from the backup taken before the first run.
2. Toggle `WEIDU_BCS_CACHE_MB` and/or edit `install_config.json` to match the next run's row. **Do not touch fast-drive** — it stays on across all four.
3. Run a **dry-run preview** before the real install to confirm the intended settings took effect.
4. Verify the install-start `Performance levers:` line in `install.log` reads `biff_delete=<expected>, override_fast_drive=on`. (`analyze_install_log.py` surfaces this; an `override_fast_drive=off` run will carry a ⚠ warning through the analysis.)
5. Verify the first `BCS_CACHE_STATS_JSON` line matches the intended cache state (`enabled:true/false`, correct `max_mb`).
6. Verify the `[PREBIFF]` log line matches the intended BIFF state — see the "Validating a run" section below.
7. Save `install.log` as `install.{A,B,C,D}.log`.

## Validating a run — the PREBIFF log line

The orchestrator emits exactly one structured line per BIFF pass. Contract (from the orchestrator chat):

```
[HH:MM:SS] [PREBIFF] delete_optimization=<bool> reason=<enum> biffed=<N> deleted=<N> delete_errors=<N> override_before=<N> override_after=<N> biff_file_size=<bytes>
```

- **Key order is pinned.** Future fields append at the end, so a `key=value` regex anchored on `[PREBIFF]` is forward-stable.
- **`reason` enum**:
  - `ran` — cleanup fired; `deleted` files removed from override/. **This is what a valid [C] or [D] run must show.**
  - `biff_missing` — MAKE_BIFF exited 0 but produced no / <1KB biff. Cleanup skipped for safety. **Despite `delete_optimization=true`, the workload is effectively the same as BIFF-off. A run that lands `biff_missing` is NOT a valid `[C]` or `[D]` data point — re-run after fixing the MAKE_BIFF source.**
  - `disabled` — `enable_biff_delete_optimization` was false. Expected for `[A]` and `[B]`.

Expected `[PREBIFF]` lines per run:

```
# [A] and [B]
[HH:MM:SS] [PREBIFF] delete_optimization=false reason=disabled biffed=N deleted=0 delete_errors=0 override_before=N override_after=N biff_file_size=...

# [C] and [D] — MUST have reason=ran to be valid
[HH:MM:SS] [PREBIFF] delete_optimization=true reason=ran biffed=N deleted=N delete_errors=0 override_before=122196 override_after=57 biff_file_size=487235072
```

`analyze_install_log.py` flags a run with `reason=biff_missing` as invalid in both single-run and `--ab` output, so you don't accidentally build conclusions on top of it.

## Metrics to extract per run

From each `install.log`:

| Metric | Extraction | Why |
|---|---|---|
| **Wall clock on the hot batches** | `grep BATCH_START install.log` → subtract adjacent timestamps for dw_talents / stratagems / mih_tweaks | Headline number |
| **Per-component timing on cn:60200** | `install:component_done` events, or first/last `[STDERR]` line of that batch | Isolates the single slowest known case |
| **Cache hits / misses / peak** | `grep BCS_CACHE_STATS_JSON install.log` → JSON parse | Confirms cache engaged; shows hit rate shift between BIFF-off (lots of override reads, some misses) and BIFF-on (mostly biff reads, higher hit rate expected) |
| **Override file count before/after** | `override_before` and `override_after` from the `[PREBIFF]` log line | Confirms BIFF delete actually ran. Expect ~122k → ~dozens for a valid `[C]`/`[D]` run. Any other ratio = re-check the config |
| **Stats table from `WSETUP-dw_talents.DEBUG`** | `grep -A 40 "WeiDU Timings"` at the last block of the file | User CPU breakdown — validates that reduction is coming from the right place |

## Interpreting results

### Predicted outcomes (rough, based on profile data)

Predicted outcomes assume fast-drive=ON (per the prereq above):

| Run | Expected cn:60200 wall clock | Mechanism |
|---|---|---|
| **[A] Baseline** (fast-drive only) | ~5-10 min | Fast-drive alone eliminates the ~130k × 25ms write dominator — 4h52m pre-fast-drive becomes 5-10 min at ~1ms/op on RAM disk |
| **[B] Cache only** | ~5-9 min | Small additional save from biff-decompression avoidance |
| **[C] BIFF only** | ~3-6 min | FS-iteration cost on the post-BIFF override is near-zero anyway; delta over [A] is smaller than it looked pre-fast-drive |
| **[D] Combined** | ~2-5 min | All levers stacked; close to the floor of what cn:60200 can possibly achieve |

Note on absolute numbers: these assume the original cn:60200 spent ~4-5h on writes (dominant) + ~30m on FS-iteration + ~15m on biff-decompression. Fast-drive either kills or multiplies out all three. The residual cache × BIFF deltas measured here are on the order of minutes, not hours.

**Reference run for context** (not part of the four-point matrix): with all three levers OFF — the pre-v1.0.2 configuration — cn:60200 measured **4h52m wall / ~1-2s user CPU**. That's the baseline the community has been living with.

### Outcomes that would change our 1.1 planning

| Observation | What it tells us |
|---|---|
| `[C] ≈ [D]` (cache adds nothing after BIFF fix) | The cache is deprecatable in 1.1. Ship for 1.0, plan removal once BIFF fix is universal. |
| `[D]` significantly below `[C]` (cache still contributes after BIFF) | The cache is load-bearing. Keep it, and parse-cache-v2 is worth considering. |
| `[A] − [C]` disappointing (BIFF fix only buys 2-3×, not 10×) | Something else is also gating the wall clock. Profile further — maybe AV scanning, maybe dialog.tlk, maybe something we haven't seen. |
| `[B] ≈ [A]` (cache helps zero on BIFF-off) | Our measured 15-30m estimate was optimistic; even the I/O fraction isn't as big as we thought. Doesn't invalidate the cache for BIFF-on runs. |
| `[D] > [C]` (cache makes things WORSE after BIFF) | Unexpected. Possible cause: cache's defensive `String.copy` overhead exceeds the savings when the workload is all biff-reads of already-hot files. Action: investigate, possibly make the cache opt-in with `WEIDU_BCS_CACHE_MB=0` as the default. |

### Runs to discard and re-run

Any of these conditions make a run invalid — drop the `install.log` and redo from a fresh backup:

| Signal in `install.log` | Problem |
|---|---|
| `reason=biff_missing` in a `[C]` or `[D]` run | MAKE_BIFF produced no/tiny biff, so override wasn't shrunk despite `enable_biff_delete_optimization=true`. Run's workload matches BIFF-off, not BIFF-on. |
| `delete_errors > 0` in a `[PREBIFF]` line | Filesystem rejected some deletions (permissions, file locks). Override was partially shrunk, creating a hybrid workload not comparable to either `[C]`/`[D]` or `[A]`/`[B]`. |
| `reason=disabled` when the run was supposed to be `[C]` or `[D]` | Config wasn't picked up — either `install_config.json` wasn't saved, or UI override won out. Check precedence path. |
| Missing any `BCS_CACHE_STATS_JSON` lines on cache-on runs | Cache module didn't ship in the binary, or WeiDU segfaulted before `at_exit`. Verify binary SHA matches `meta.json` and check stderr for segfault traces. |
| `cache_enabled=true` in `[B]`/`[D]` but hit rate <5% on an **SFO-target** batch (dw_talents, stratagems, cdtweaks, mih_tweaks) | Cache was invalidated aggressively by an unexpected write path. Spot-check the mod's TP2 for direct file ops that bypass `open_for_writing`. Note: this threshold applies **only** to the four SFO-target mods. `eet_end`, `eet_tweaks`, `metweaks`, `ua`, and similar non-SFO mods with large single-pass workloads (tens of thousands of unique file lookups, no revisits) are **expected** to show 0-5% hit rates with thousands of evictions — that's the workload shape, not a defect. |
| `Performance levers:` line shows `override_fast_drive=off` on any of `[A]`–`[D]` | Fast-drive is a prerequisite for the cache × BIFF A/B to be meaningful. With fast-drive off, per-file NTFS write overhead dominates every batch in the SFO range and masks cache/BIFF deltas. Re-enable fast-drive in Settings and re-run. (Mod runner also emits a ⚠ stdout banner at install start if dw_talents/stratagems are in the plan and fast-drive is off — don't ignore it.) |

### Non-outcomes to ignore

- Small wall-clock noise on fast batches — only the slow batches decide the story.
- Hit-rate differences between runs with ON cache — both should converge to similar rates on the same workload; small differences are probably OCaml GC variability.
- Cache peak memory differences between `[B]` and `[D]` — after BIFF fix, fewer distinct files get touched, so peak may be lower in `[D]`. That's fine.

## Run-order strategy

Order matters because warm caches / page caches persist across runs until the machine sleeps:

1. **`[A] Baseline` first** — cold disk state, most representative of a real user's worst case.
2. **`[C] BIFF only`** after `[A]` — shares a similar "cold" starting profile (no cache), but with the delete-after-BIFF applied. Gives us the biggest delta cleanly.
3. **`[B] Cache only`** — different run, so revert BIFF fix.
4. **`[D] Combined`** — last, as a confirmation.

Between runs, if the machine has been sitting warm, drop OS page cache before each run to reduce variance:

```powershell
# PowerShell (Administrator)
Clear-RecycleBin -Force  # not required, just a cache-relevant hygiene step
# Page cache — Windows doesn't expose a direct flush, but the game directory
# is big enough that sequential I/O from another app will evict it
```

On Linux, `sync && echo 3 > /proc/sys/vm/drop_caches` works. On Windows,
the cleanest option is to **reboot between runs** if you need tight
comparability. More pragmatic: accept some variance and make sure the
deltas are big enough to dominate it.

## Reporting template

After all four runs complete, produce a one-page summary:

```
┌─ Run [A] Baseline ────────────────────────────────────┐
│ cn:60200 wall clock:   [H:MM:SS]                     │
│ Levers at start:       biff_delete=off, fast_drive=on │
│ Override files at run: [N]                            │
│ Cache:                  disabled                      │
│ Notes:                                                │
└───────────────────────────────────────────────────────┘
┌─ Run [B] Cache only ──────────────────────────────────┐
│ cn:60200 wall clock:   [H:MM:SS]  (Δ [+/-%] vs A)    │
│ Levers at start:       biff_delete=off, fast_drive=on │
│ Cache hit rate:         [%] ([hits]/[total])          │
│ Cache peak memory:      [MB]                          │
│ Notes:                                                │
└───────────────────────────────────────────────────────┘
┌─ Run [C] BIFF only ───────────────────────────────────┐
│ cn:60200 wall clock:   [H:MM:SS]  (Δ [+/-%] vs A)    │
│ Levers at start:       biff_delete=on, fast_drive=on  │
│ PREBIFF reason:         [ran / biff_missing]  ← MUST be ran │
│ override_before:        [N]                           │
│ override_after:         [N]  ([ratio]× reduction)    │
│ deleted / biffed:       [N] / [N]                     │
│ Notes:                                                │
└───────────────────────────────────────────────────────┘
┌─ Run [D] Combined ────────────────────────────────────┐
│ cn:60200 wall clock:   [H:MM:SS]  (Δ vs A, C)        │
│ Levers at start:       biff_delete=on, fast_drive=on  │
│ PREBIFF reason:         [ran / biff_missing]  ← MUST be ran │
│ Cache hit rate:         [%]                           │
│ override_before:        [N]                           │
│ override_after:         [N]                           │
│ Notes:                                                │
└───────────────────────────────────────────────────────┘

Attribution:
  Cache alone contribution (A−B):    [minutes saved]
  BIFF alone contribution (A−C):     [minutes saved]
  Cache contribution after BIFF (C−D): [minutes saved]
  Non-linearity (A−D) vs (A−B)+(A−C):  [minutes]  → [additive / subadditive / superadditive]

Recommendation: [keep / deprecate / iterate] BCS buffer cache for 1.1
```

## When not to run this

- **If the BIFF fix hasn't landed yet.** The plan assumes both levers exist. Running just `[A]` and `[B]` is the old two-way A/B we already know is misleading.
- **If you don't have a backup at the exact "just-before-SFO" game state.** Reproducibility collapses without it; the runs won't be comparable.
- **Before 1.0 ships.** This is a 1.1 decision tool. Shipping 1.0 with the cache as-is is defensible regardless of A/B outcome; the A/B tells us whether to keep investing, not whether to ship what's built.

## Known calibration issues — don't use these as A/B inputs

- **The dry-run time estimate is skewed low on large installs.** On the
  first end-to-end run with our full preset, the dry-run predicted
  ~402 minutes (6.7h) and the actual install took 729 minutes (12.2h) —
  off by **~1.8×**. The estimator's per-batch rates in
  [`dry_run.rs`](../../src/installer/dry_run.rs) were calibrated against
  earlier sessions that didn't have the current 122k-file override
  saturation pattern driving the cn:60200-class outliers. Don't use the
  dry-run number as the `[A]` baseline — use the actual `install.log`
  wall-clock from run `[A]`. Flagged for the dry-run maintainer to
  recalibrate once we have four-point data; low priority, cosmetic
  impact on the pre-install preview.

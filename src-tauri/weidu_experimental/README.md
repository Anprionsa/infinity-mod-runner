# weidu_experimental — Opt-in engine-level WeiDU build

**Status: experimental — off by default, user opts in via Settings.**

This directory holds a **vendored WeiDU source tree** (`weidu_src/`) with
mod-runner-specific modifications, plus pre-built platform binaries for
users who opt in. CI builds directly from `weidu_src/` — no upstream
clone, no patch files to apply.

## Layout

- `weidu_src/` — vendored WeiDU OCaml source, directly editable. All
  mod-runner customizations live here, tracked by this repo's git log.
  Originally forked from `WeiDUorg/weidu` at the `devel` branch (WeiDU
  251). See `meta.json` for the exact snapshot reference.
- `binaries/` — pre-built zipped WeiDU distributions for each supported
  platform, produced by CI from `weidu_src/`.
- `meta.json` — manifest the Rust backend reads to locate binaries and
  verify their SHA256 hashes at apply time.

## How the feature works at runtime

1. User toggles "Resilient WeiDU (experimental)" in Settings.
2. A confirmation modal explains the risks and shows a change summary.
3. On confirm, the Rust backend (`weidu_swap.rs`):
   - Extracts the platform-appropriate zip from this directory.
   - Verifies the weidu binary's SHA256 against `meta.json`.
   - Caches the binary to `<data_dir>/.weidu_cache/weidu{.exe}`.
   - Installer resolves to this cached binary for subsequent installs.
   - User's originally configured WeiDU is never modified.

## Maintenance workflow

### Modifying the source

Edit `weidu_src/` directly. No patch files, no rebase dance. Commit
changes through the normal mod-runner PR flow. Each source commit should
explain *why* the change was made (mod-runner-specific rationale), since
those reasons aren't obvious from upstream context alone.

CI automatically rebuilds binaries on any push that touches
`weidu_src/**` — no manual trigger needed.

### Bumping to a newer upstream

When WeiDU upstream releases a new version:

1. Check out a fresh clone of `WeiDUorg/weidu` at the desired ref.
2. Diff it against our `weidu_src/`. Anything we've added must be
   re-applied to the new upstream (use `git log weidu_src/` in this
   repo as the authoritative list of mod-runner changes).
3. Replace `weidu_src/` contents with the new upstream + our deltas.
4. Update `base_weidu_version` and bump `patch_revision` in `meta.json`.
5. Push. CI builds fresh binaries and updates hashes in `meta.json`.

### Versioning in meta.json

- `base_weidu_version` — the upstream WeiDU version we forked from. Change only when we sync with a new upstream release.
- `patch_revision` — the mod-runner revision number. Bump every time `weidu_src/` gets semantic changes. Included in the runtime display so users can see which experimental build they're running.
- `build_version` — the version string reported by `weidu --version`, typically `<base><patch_revision>` (e.g. `25201` for WeiDU 251 + revision 1). Injected by the Makefile from `src/version.ml`.

## CI overview

`.github/workflows/weidu-rebuild.yml`:

1. **resolve** — reads `base_weidu_version` from `meta.json` for logging.
2. **build-{windows,linux,macos}** — each platform checks out the repo,
   fetches elkhound (pinned to `The-Mod-Elephant/elkhound` release
   1.0.3), sets up OCaml via `ocaml/setup-ocaml`, then `cd weidu_src &&
   make && make {platform}_zip`.
3. **smoke-test** (gate) — downloads the Linux artifact and runs the
   headless test subset (`test/good-syntax/`, `test/bad-syntax/`,
   `test/no-game/`) against the built binary using `--nogame`. Fails the
   workflow if any test diverges from expected exit code.
4. **commit-binaries** — only runs if all three builds *and* the smoke
   test pass. Stages the zips, computes SHA256s, updates `meta.json`,
   commits and pushes back to the triggering branch.

## Tests that stay local (not in CI)

- `weidu_src/test/auto-test/` — 2700-DLG round-trip, requires real
  `Dialog.bif` (copyrighted game content). Run locally before committing
  semantic engine changes.
- `weidu_src/test/tp2/tp2_regression_tests/` — full TP2 feature suite,
  installs as a WeiDU mod against a real game.
- `weidu_src/test/traify/` — needs an IE game directory. See
  `weidu_src/test/traify/README`.

Future: could be moved into CI with a stripped-down synthetic game
fixture, but that's a separate investment.

## Why this is NOT a traditional fork

- No parallel git repo to sync — the source lives alongside the Rust
  code that uses it. Changes land in the same commit stream as the
  mod-runner features that motivated them.
- Users never see the word "fork" — they see "experimental engine
  build" from Infinity Mod Runner.
- Clear framing: "Infinity Mod Runner experimental feature", not "alternate
  WeiDU distribution".
- Easy to drop: delete this directory + the Rust module + the UI
  section. No cleanup of external references needed.

## Current modifications (as of patch_revision 2)

### Resilient DECOMPILE_AND_PATCH

`weidu_src/src/tppatch.ml` — adds a `decompile_and_patch_context` flag
and catches BCS round-trip exceptions inside `DECOMPILE_AND_PATCH`
blocks. When a script can't cleanly decompile + recompile (often caused
by IDS state changes in large mod stacks), WeiDU logs a warning and
returns the original buffer unchanged instead of aborting the install.

Targets failures in mods like Ajantis NPC (`C#AJAN.bcs`), Golem
Construction (`a7#dron3.bcs`, `a7#abs.bcs`), and SoD companion scripts
(`BD*.bcs`) that don't cleanly round-trip after other mods have modified
the IDS state.

Complementary to the TP2-level `PATCH_TRY` patches in
`src-tauri/patches/files/{dw_talents,stratagems,...}/alter_script.tph`
which cover the `ALTER_SCRIPT_BLOCK` path that doesn't go through
`DECOMPILE_AND_PATCH`.

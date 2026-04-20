#!/usr/bin/env bash
# Smoke-test a built WeiDU binary against the headless-runnable subset of
# weidu_src/test/. Catches compile-level breakage and confirms the BCS
# buffer cache module is wired in, BEFORE committing to a multi-hour real install.
#
# Usage:
#   ./smoke_test.sh /path/to/weidu.exe
#   WEIDU_BCS_CACHE_MB=0 ./smoke_test.sh /path/to/weidu.exe   # test disabled path
#
# Exit codes:
#   0  — all tests pass, cache stats line observed
#   1  — a good-syntax/no-game file failed to compile
#   2  — a bad-syntax file compiled (should have failed)
#   3  — version check failed
#   4  — cache stats line not observed (cache module not integrated)
#   5  — usage error

set -u

# ──────────────────────────────────────────────────────────────
# Locate test dir relative to this script.
# ──────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DIR="$HERE/../weidu_src/test"

if [ "$#" -lt 1 ]; then
    echo "usage: $0 /path/to/weidu[.exe]" >&2
    exit 5
fi

WEIDU_BIN="$1"
if [ ! -x "$WEIDU_BIN" ] && [ ! -f "$WEIDU_BIN" ]; then
    echo "ERROR: binary not found or not executable: $WEIDU_BIN" >&2
    exit 5
fi

if [ ! -d "$TEST_DIR" ]; then
    echo "ERROR: test dir not found: $TEST_DIR" >&2
    exit 5
fi

# ──────────────────────────────────────────────────────────────
# Use a scratch dir so we don't pollute the test tree with generated
# DLG/BCS/etc. files.
# ──────────────────────────────────────────────────────────────
SCRATCH="$(mktemp -d -t weidu_smoke.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

# Stderr capture for cache-stats detection.
STDERR_LOG="$SCRATCH/stderr.log"
: > "$STDERR_LOG"

run_weidu() {
    # Call weidu with --nogame so tests don't need a Dialog.bif.
    # Accumulate stderr across all calls into STDERR_LOG.
    (cd "$SCRATCH" && "$WEIDU_BIN" --nogame "$@") 2>>"$STDERR_LOG"
}

# ──────────────────────────────────────────────────────────────
# Test 1: version
# ──────────────────────────────────────────────────────────────
echo "== Version check =="
if ! VERSION_OUT=$(run_weidu --version 2>&1); then
    echo "FAIL: --version returned non-zero"
    exit 3
fi
echo "  $VERSION_OUT" | head -3
# Expected: "Weidu 25201" or similar. The 25201 value comes from meta.json's
# build_version field and src/version.ml.
if ! echo "$VERSION_OUT" | grep -q "25201"; then
    echo "WARN: version output doesn't mention 25201 (expected from meta.json build_version)"
fi

# ──────────────────────────────────────────────────────────────
# Test 2: good-syntax (expect compile success)
# ──────────────────────────────────────────────────────────────
echo ""
echo "== good-syntax — expect success =="
good_fail=0
for f in "$TEST_DIR"/good-syntax/*.d; do
    name=$(basename "$f")
    # Copy into scratch so generated DLG files go there
    cp "$f" "$SCRATCH/$name"
    if run_weidu "$name" > /dev/null; then
        echo "  OK   $name"
    else
        echo "  FAIL $name"
        good_fail=$((good_fail + 1))
    fi
done

# ──────────────────────────────────────────────────────────────
# Test 3: bad-syntax (expect compile failure)
# ──────────────────────────────────────────────────────────────
echo ""
echo "== bad-syntax — expect PARSE/FATAL ERROR in output =="
# NOTE: WeiDU exits 0 even on parse errors in CLI compile mode, so we can't
# use exit code. Check the output for its error markers instead.
bad_fail=0
for f in "$TEST_DIR"/bad-syntax/*.d; do
    name=$(basename "$f")
    cp "$f" "$SCRATCH/$name"
    out=$(run_weidu "$name" 2>&1)
    if echo "$out" | grep -qE "(FATAL ERROR|PARSE ERROR|syntax error)"; then
        echo "  OK   $name (errored as expected)"
    else
        echo "  FAIL $name (no error marker in output)"
        bad_fail=$((bad_fail + 1))
    fi
done

# ──────────────────────────────────────────────────────────────
# Test 4: no-game (expect compile success)
# ──────────────────────────────────────────────────────────────
echo ""
echo "== no-game — expect success =="
nogame_fail=0
for f in "$TEST_DIR"/no-game/*.d; do
    name=$(basename "$f")
    cp "$f" "$SCRATCH/$name"
    if run_weidu "$name" > /dev/null; then
        echo "  OK   $name"
    else
        echo "  FAIL $name"
        nogame_fail=$((nogame_fail + 1))
    fi
done

# ──────────────────────────────────────────────────────────────
# Test 5: cache stats line present (confirms bcs_buffer_cache module is in)
# ──────────────────────────────────────────────────────────────
echo ""
echo "== cache module integration =="
if grep -q "^BCS_CACHE_STATS_JSON " "$STDERR_LOG"; then
    echo "  OK   stats line observed"
    # Show last line for quick human check
    grep "^BCS_CACHE_STATS_JSON " "$STDERR_LOG" | tail -1 | sed 's/^/       /'
    cache_integration=0
else
    echo "  FAIL no BCS_CACHE_STATS_JSON line in stderr"
    echo "       → bcs_buffer_cache.ml not integrated, or at_exit didn't run."
    echo "       → raw stderr dump:"
    tail -10 "$STDERR_LOG" | sed 's/^/         /'
    cache_integration=1
fi

# ──────────────────────────────────────────────────────────────
# Summary + exit code
# ──────────────────────────────────────────────────────────────
echo ""
echo "== Summary =="
echo "  good-syntax failures: $good_fail"
echo "  bad-syntax failures:  $bad_fail"
echo "  no-game failures:     $nogame_fail"
echo "  cache integration:    $([ $cache_integration -eq 0 ] && echo OK || echo FAIL)"

if [ $good_fail -gt 0 ] || [ $nogame_fail -gt 0 ]; then
    exit 1
fi
if [ $bad_fail -gt 0 ]; then
    exit 2
fi
if [ $cache_integration -ne 0 ]; then
    exit 4
fi
echo "ALL OK — ready for real install test."
exit 0

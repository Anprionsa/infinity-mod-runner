#!/usr/bin/env python3
"""Analyze an Infinity Mod Runner install.log for BCS buffer cache A/B testing.

Extracts:
  - Session timestamps → total wall-clock duration
  - BATCH_START events → per-batch timing (via adjacent timestamp deltas)
  - BCS_CACHE_STATS_JSON events → per-batch cache stats
  - STDERR error/warning/fatal counts
  - SILENT_SKIP, AUTO_RETRY, AUTO_SKIP events

Produces a human-readable summary plus optional JSON output for further
scripting. Supports A/B mode that diffs two logs side-by-side.

Usage:
    python3 analyze_install_log.py <install.log>
    python3 analyze_install_log.py <install.log> --json
    python3 analyze_install_log.py <baseline.log> <cached.log> --ab

The script is dependency-free (stdlib only) so it runs against any Python
3.8+ install on Windows/Linux/Mac.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional


# ──────────────────────────────────────────────────────────────
# Line parsers
# ──────────────────────────────────────────────────────────────

TS_RE = re.compile(r"^\[(\d{2}):(\d{2}):(\d{2})\]\s+(.*)$")
BATCH_START_RE = re.compile(
    r"\[BATCH_START\]\s+(\d+)/(\d+)\s+'([^']+)'\s+\((\d+)\s+components\)"
)
CACHE_STATS_PREFIX = "[STDERR] BCS_CACHE_STATS_JSON "
HUMAN_CACHE_PREFIX = "[STDERR] BCS buffer cache:"
PROGRESS_RE = re.compile(
    r"\[PROGRESS\]\s+(\d+)/(\d+)\s+\(success:(\d+)\s+errors:(\d+)\s+skipped:(\d+)\)"
)
SILENT_SKIP_RE = re.compile(r"\[SILENT_SKIP\]")
STDERR_RE = re.compile(r"\[STDERR\]\s+(.*)$")
SESSION_HDR_RE = re.compile(r"Infinity Mod Runner Install Session — (.+)$")

# The delete-after-BIFF orchestrator pass emits one line per invocation.
# Contract (from the orchestrator chat): key order is pinned, new fields
# append at the end, so this regex is forward-stable. See AB_PLAN.md.
PREBIFF_RE = re.compile(
    r"\[PREBIFF\] delete_optimization=(?P<enabled>\w+) "
    r"reason=(?P<reason>\w+) "
    r"biffed=(?P<biffed>\d+) "
    r"deleted=(?P<deleted>\d+) "
    r"delete_errors=(?P<delete_errors>\d+) "
    r"override_before=(?P<override_before>\d+) "
    r"override_after=(?P<override_after>\d+) "
    r"biff_file_size=(?P<biff_file_size>\d+)"
)

# Install-start lever-state diagnostic. Emitted once per session by the
# orchestrator right after batch-size logging. Captures which
# performance levers were active at T+0 so post-mortem analysis can
# confirm each A/B run had the intended configuration. Tolerant of
# leading stdout prefix + timestamp.
PERF_LEVERS_RE = re.compile(
    r"Performance levers:\s+"
    r"biff_delete=(?P<biff_delete>\w+)"
    r",\s+override_fast_drive=(?P<fast_drive>\w+)"
)


@dataclass
class Batch:
    """A single batch's timing + stats."""
    index: int
    total: int
    mod_name: str
    component_count: int
    start_secs: int  # seconds-of-day; needs day-boundary handling
    duration_secs: Optional[int] = None  # filled when next batch starts
    cache_stats: Optional[dict] = None  # parsed JSON from BCS_CACHE_STATS_JSON
    human_cache_line: Optional[str] = None


@dataclass
class PrebiffEvent:
    """One orchestrator-emitted delete-after-BIFF pass.

    A log has zero, one, or more of these per install. `reason` discriminates
    the three observable states:
      - "ran"          optimization fired, override shrunk
      - "biff_missing" optimization was enabled but skipped because MAKE_BIFF
                       produced no / tiny biff — this run's workload is
                       effectively the same as BIFF-off (critical for A/B
                       validity — see AB_PLAN.md)
      - "disabled"     feature flag off
    """
    time_secs: int
    enabled: bool
    reason: str
    biffed: int
    deleted: int
    delete_errors: int
    override_before: int
    override_after: int
    biff_file_size: int

    def is_active(self) -> bool:
        """True if this pass actually shrunk override. A biff_missing or
        disabled event means the run's workload matches BIFF-off."""
        return self.enabled and self.reason == "ran"


@dataclass
class Summary:
    log_path: str
    session_start: Optional[str] = None
    first_ts_secs: Optional[int] = None
    last_ts_secs: Optional[int] = None
    batches: list = field(default_factory=list)
    prebiff_events: list = field(default_factory=list)
    # Performance-lever state captured at install start (v1.0.3+). None on
    # pre-v1.0.3 logs (didn't emit this line); informational, not an error.
    biff_delete_state: Optional[str] = None      # "on" | "off" | None
    fast_drive_state: Optional[str] = None       # "on" | "off" | None
    stderr_errors: int = 0
    stderr_warnings: int = 0
    silent_skips: int = 0
    auto_retries: int = 0
    auto_skips: int = 0
    final_progress: Optional[dict] = None


# ──────────────────────────────────────────────────────────────
# Parser
# ──────────────────────────────────────────────────────────────

def parse_ts(line: str) -> Optional[tuple[int, str]]:
    """Return (seconds_of_day, remainder) or None if no timestamp."""
    m = TS_RE.match(line)
    if not m:
        return None
    h, mn, s, rest = m.groups()
    secs = int(h) * 3600 + int(mn) * 60 + int(s)
    return secs, rest


def parse_log(path: Path) -> Summary:
    summary = Summary(log_path=str(path))
    current_batch: Optional[Batch] = None
    # Track day rollover so 23:59 → 00:00 doesn't produce negative durations.
    last_secs: Optional[int] = None
    day_offset = 0

    with path.open("r", encoding="utf-8", errors="replace") as f:
        for raw in f:
            line = raw.rstrip("\n")

            # Session header doesn't have a per-line timestamp, just grep it.
            m = SESSION_HDR_RE.search(line)
            if m:
                summary.session_start = m.group(1).strip()
                continue

            parsed = parse_ts(line)
            if not parsed:
                continue
            secs, body = parsed

            # Day-rollover detection: if the new timestamp is more than
            # 6 hours earlier than the last one, assume a midnight crossed.
            if last_secs is not None and secs + 6 * 3600 < last_secs:
                day_offset += 86400
            last_secs = secs
            abs_secs = secs + day_offset

            if summary.first_ts_secs is None:
                summary.first_ts_secs = abs_secs
            summary.last_ts_secs = abs_secs

            # BATCH_START — close out previous batch, open new one.
            m = BATCH_START_RE.search(body)
            if m:
                idx, total, mod_name, cc = m.groups()
                if current_batch is not None and current_batch.duration_secs is None:
                    current_batch.duration_secs = abs_secs - current_batch.start_secs
                current_batch = Batch(
                    index=int(idx),
                    total=int(total),
                    mod_name=mod_name,
                    component_count=int(cc),
                    start_secs=abs_secs,
                )
                summary.batches.append(current_batch)
                continue

            # BCS cache stats (JSON line) — attribute to current batch.
            if CACHE_STATS_PREFIX in body:
                payload_start = body.index(CACHE_STATS_PREFIX) + len(CACHE_STATS_PREFIX)
                payload = body[payload_start:].strip()
                try:
                    stats = json.loads(payload)
                    if current_batch is not None:
                        current_batch.cache_stats = stats
                except json.JSONDecodeError:
                    # Malformed — still record so A/B analysis notices.
                    if current_batch is not None:
                        current_batch.cache_stats = {"_parse_error": payload}
                continue

            # Human-readable cache line — capture raw for reference.
            if HUMAN_CACHE_PREFIX in body:
                if current_batch is not None:
                    current_batch.human_cache_line = body.strip()
                continue

            # Install-start performance-lever diagnostic.
            m = PERF_LEVERS_RE.search(body)
            if m:
                summary.biff_delete_state = m.group("biff_delete")
                summary.fast_drive_state = m.group("fast_drive")
                continue

            # Delete-after-BIFF orchestrator pass.
            m = PREBIFF_RE.search(body)
            if m:
                d = m.groupdict()
                summary.prebiff_events.append(PrebiffEvent(
                    time_secs=abs_secs,
                    enabled=(d["enabled"] == "true"),
                    reason=d["reason"],
                    biffed=int(d["biffed"]),
                    deleted=int(d["deleted"]),
                    delete_errors=int(d["delete_errors"]),
                    override_before=int(d["override_before"]),
                    override_after=int(d["override_after"]),
                    biff_file_size=int(d["biff_file_size"]),
                ))
                continue

            # Progress snapshot — keep the last one seen as the "final".
            m = PROGRESS_RE.search(body)
            if m:
                cur, tot, succ, err, skip = (int(x) for x in m.groups())
                summary.final_progress = {
                    "current": cur, "total": tot,
                    "success": succ, "errors": err, "skipped": skip,
                }
                continue

            # Event counters.
            if "[SILENT_SKIP]" in body:
                summary.silent_skips += 1
            if "[AUTO_RETRY]" in body:
                summary.auto_retries += 1
            if "[AUTO_SKIP]" in body:
                summary.auto_skips += 1

            # STDERR classifications (from log_stderr: error/fatal/warning).
            m = STDERR_RE.search(body)
            if m:
                tail = m.group(1).lower()
                if "error" in tail or "fatal" in tail:
                    summary.stderr_errors += 1
                elif "warning" in tail:
                    summary.stderr_warnings += 1

    # Close last batch — we don't know its true end, use last_ts as proxy.
    if current_batch is not None and current_batch.duration_secs is None:
        if summary.last_ts_secs is not None:
            current_batch.duration_secs = summary.last_ts_secs - current_batch.start_secs

    return summary


# ──────────────────────────────────────────────────────────────
# Formatting
# ──────────────────────────────────────────────────────────────

def fmt_duration(secs: Optional[int]) -> str:
    if secs is None:
        return "—"
    h, r = divmod(secs, 3600)
    m, s = divmod(r, 60)
    if h > 0:
        return f"{h}h{m:02d}m{s:02d}s"
    return f"{m}m{s:02d}s"


def render_summary(s: Summary, top_n: int = 15) -> str:
    lines: list[str] = []
    lines.append(f"═══ {s.log_path} ═══")
    lines.append(f"Session start: {s.session_start or '—'}")
    total = None
    if s.first_ts_secs is not None and s.last_ts_secs is not None:
        total = s.last_ts_secs - s.first_ts_secs
    lines.append(f"Total duration: {fmt_duration(total)}")
    lines.append(f"Batches: {len(s.batches)}")
    if s.final_progress:
        p = s.final_progress
        lines.append(
            f"Final progress: {p['current']}/{p['total']} components "
            f"(success={p['success']} errors={p['errors']} skipped={p['skipped']})"
        )
    lines.append(f"stderr: {s.stderr_errors} errors, {s.stderr_warnings} warnings")
    lines.append(f"Events: {s.silent_skips} silent skips, "
                 f"{s.auto_retries} auto-retries, {s.auto_skips} auto-skips")

    # Performance-lever state captured at install start. Shown before the
    # PREBIFF block so the reader sees INTENDED state before OBSERVED.
    if s.biff_delete_state is not None or s.fast_drive_state is not None:
        lines.append("")
        lines.append("── Performance levers at install start ──")
        bd = s.biff_delete_state or "?"
        fd = s.fast_drive_state or "?"
        lines.append(f"  biff_delete:          {bd}")
        lines.append(f"  override_fast_drive:  {fd}")
        if fd == "off":
            lines.append(
                "  ⚠ override_fast_drive=off — write-heavy SFO components"
                " (dw_talents cn:60200 etc.) will be bound by NTFS + AV"
                " per-file write cost (~25ms/op × ~130k writes ≈ hours)."
                " Enable fast-drive for 10-50× speedup."
            )

    # Delete-after-BIFF passes — one of the two main levers we're measuring.
    if s.prebiff_events:
        lines.append("")
        lines.append(f"── Delete-after-BIFF passes ({len(s.prebiff_events)}) ──")
        for ev in s.prebiff_events:
            active_marker = "✓ ACTIVE" if ev.is_active() else "  skipped"
            ratio = (f"{ev.override_before}→{ev.override_after}"
                     f" ({ev.override_before/max(ev.override_after,1):.0f}× reduction)") \
                    if ev.is_active() else f"{ev.override_before} (unchanged)"
            lines.append(
                f"  {active_marker}  reason={ev.reason:<13} "
                f"biffed={ev.biffed:,}  override {ratio}"
            )
            if ev.delete_errors > 0:
                lines.append(f"    ⚠ {ev.delete_errors} delete errors — investigate")
            if ev.reason == "biff_missing":
                lines.append(
                    "    ⚠ biff_missing means MAKE_BIFF produced no/tiny biff; "
                    "this run's workload matches BIFF-off (A/B invalid for [C]/[D])"
                )

    # Aggregate cache stats
    with_stats = [b for b in s.batches if b.cache_stats and "_parse_error" not in b.cache_stats]
    if with_stats:
        enabled_runs = [b for b in with_stats if b.cache_stats.get("enabled")]
        total_hits = sum(b.cache_stats.get("hits", 0) for b in enabled_runs)
        total_misses = sum(b.cache_stats.get("misses", 0) for b in enabled_runs)
        total_evictions = sum(b.cache_stats.get("evictions", 0) for b in enabled_runs)
        peak_kb = max((b.cache_stats.get("peak_kb", 0) for b in enabled_runs), default=0)
        lookups = total_hits + total_misses
        avg_hit = 100.0 * total_hits / lookups if lookups else 0.0
        lines.append("")
        lines.append(f"── BCS cache (over {len(enabled_runs)} enabled batches) ──")
        lines.append(f"  Total lookups: {lookups:,}")
        lines.append(f"  Total hits:    {total_hits:,}  ({avg_hit:.1f}% aggregate hit rate)")
        lines.append(f"  Total misses:  {total_misses:,}")
        lines.append(f"  Evictions:     {total_evictions:,}")
        lines.append(f"  Peak memory:   {peak_kb:,} KB ({peak_kb / 1024:.1f} MB)")
        disabled = [b for b in with_stats if not b.cache_stats.get("enabled")]
        if disabled:
            lines.append(f"  Disabled batches: {len(disabled)} (cache off runs)")
    else:
        lines.append("")
        lines.append("── BCS cache: no stats lines observed ──")
        lines.append("  Either: (a) patched binary not in use, (b) cache module not registered,")
        lines.append("  (c) WeiDU died before at_exit, or (d) no BCS/BAF resources loaded.")

    # Top slowest batches
    sorted_batches = sorted(
        (b for b in s.batches if b.duration_secs is not None),
        key=lambda b: -b.duration_secs,
    )
    if sorted_batches:
        lines.append("")
        lines.append(f"── Top {min(top_n, len(sorted_batches))} slowest batches ──")
        lines.append(f"  {'dur':>10}  {'batch':>5}  {'comps':>5}  {'hit%':>6}  {'peakMB':>6}  mod")
        for b in sorted_batches[:top_n]:
            hit_pct = "—"
            peak_mb = "—"
            if b.cache_stats and "_parse_error" not in b.cache_stats:
                if b.cache_stats.get("enabled"):
                    hr = b.cache_stats.get("hit_rate_pct")
                    hit_pct = f"{hr:.1f}" if hr is not None else "—"
                    pk = b.cache_stats.get("peak_kb", 0)
                    peak_mb = f"{pk / 1024:.1f}"
                else:
                    hit_pct = "off"
            lines.append(
                f"  {fmt_duration(b.duration_secs):>10}  {b.index:>5}  "
                f"{b.component_count:>5}  {hit_pct:>6}  {peak_mb:>6}  {b.mod_name}"
            )

    return "\n".join(lines)


def _variant_label(s: Summary) -> str:
    """Classify a run by its three-lever state. Returns a terse
    three-axis label. Fast-drive is the dominant lever for write-heavy
    SFO workloads — see AB_PLAN.md — so valid A/B runs should have it ON."""
    # Cache axis — look at any enabled stats line; a single non-cold
    # enabled:true line is enough.
    cache_on = any(
        b.cache_stats and b.cache_stats.get("enabled") is True
        for b in s.batches if b.cache_stats
    )
    cache_disabled_seen = any(
        b.cache_stats and b.cache_stats.get("enabled") is False
        for b in s.batches if b.cache_stats
    )
    if cache_on:
        cache = "cache=ON"
    elif cache_disabled_seen:
        cache = "cache=OFF"
    else:
        cache = "cache=?"

    # BIFF axis — did any PREBIFF pass actually fire?
    if not s.prebiff_events:
        biff = "biff=NO-PASS"  # feature didn't even get to try
    elif any(e.is_active() for e in s.prebiff_events):
        biff = "biff=ACTIVE"
    elif any(e.reason == "biff_missing" for e in s.prebiff_events):
        biff = "biff=MISSING"  # intended on but skipped — invalid data for [C]/[D]
    else:
        biff = "biff=OFF"

    # Fast-drive axis — pulled from the install-start lever diagnostic.
    # Pre-v1.0.3 logs won't have it; emit "unknown" rather than guess.
    if s.fast_drive_state == "on":
        fd = "fast_drive=ON"
    elif s.fast_drive_state == "off":
        fd = "fast_drive=OFF"
    else:
        fd = "fast_drive=?"

    return f"{cache}, {biff}, {fd}"


def render_ab(baseline: Summary, cached: Summary) -> str:
    lines: list[str] = []
    lines.append("═══ A/B comparison ═══")
    lines.append(f"Baseline: {baseline.log_path}")
    lines.append(f"          variant: {_variant_label(baseline)}")
    lines.append(f"Cached:   {cached.log_path}")
    lines.append(f"          variant: {_variant_label(cached)}")

    # Validity checks — call out known invalidating conditions for
    # either run. See AB_PLAN.md "Runs to discard and re-run."
    for name, s in (("baseline", baseline), ("cached", cached)):
        for ev in s.prebiff_events:
            if ev.reason == "biff_missing":
                lines.append(
                    f"  ⚠ {name} has reason=biff_missing — override wasn't shrunk "
                    f"despite enable_biff_delete_optimization=true. A/B invalid "
                    f"for this point; re-run after fixing the MAKE_BIFF source."
                )
                break
        # Fast-drive is the dominant lever for write-heavy SFO workloads.
        # An A/B run with fast-drive off is measuring cache/BIFF under a
        # bottleneck neither lever addresses, so the deltas will be
        # dwarfed by NTFS per-file-write cost.
        if s.fast_drive_state == "off":
            lines.append(
                f"  ⚠ {name} ran with override_fast_drive=off — the NTFS "
                f"per-file-write cost dominates SFO-heavy batches under "
                f"this configuration. Cache + BIFF deltas will look small "
                f"because the workload is write-bound, not read-bound. "
                f"Consider re-running with fast-drive=on for clearer "
                f"attribution."
            )
    lines.append("")

    def total(s: Summary) -> Optional[int]:
        if s.first_ts_secs is None or s.last_ts_secs is None:
            return None
        return s.last_ts_secs - s.first_ts_secs

    tb, tc = total(baseline), total(cached)
    if tb is not None and tc is not None and tb > 0:
        delta = tc - tb
        pct = 100.0 * delta / tb
        lines.append(f"Total duration: baseline {fmt_duration(tb)} → "
                     f"cached {fmt_duration(tc)} ({pct:+.1f}%, {delta:+d}s)")
    else:
        lines.append(f"Total duration: baseline={fmt_duration(tb)}, cached={fmt_duration(tc)}")

    # Per-mod comparison (keyed by mod_name + index).
    b_by_key = {(b.index, b.mod_name): b for b in baseline.batches}
    c_by_key = {(b.index, b.mod_name): b for b in cached.batches}
    common = sorted(set(b_by_key.keys()) & set(c_by_key.keys()))

    if common:
        # Rank by biggest absolute time delta.
        diffs = []
        for key in common:
            bb, cc = b_by_key[key], c_by_key[key]
            if bb.duration_secs is None or cc.duration_secs is None:
                continue
            diffs.append((bb.duration_secs - cc.duration_secs, bb, cc))
        diffs.sort(key=lambda t: -t[0])

        lines.append("")
        lines.append("── Biggest per-batch time deltas (baseline − cached) ──")
        lines.append(f"  {'saved':>10}  {'baseline':>10}  {'cached':>10}  {'hit%':>6}  mod  (batch)")
        for saved, bb, cc in diffs[:20]:
            hit = "—"
            if cc.cache_stats and cc.cache_stats.get("enabled"):
                hr = cc.cache_stats.get("hit_rate_pct")
                hit = f"{hr:.1f}" if hr is not None else "—"
            lines.append(
                f"  {fmt_duration(saved):>10}  {fmt_duration(bb.duration_secs):>10}  "
                f"{fmt_duration(cc.duration_secs):>10}  {hit:>6}  {bb.mod_name} "
                f"(batch {bb.index})"
            )

    return "\n".join(lines)


# ──────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("logs", nargs="+", type=Path, help="install.log path(s)")
    ap.add_argument("--json", action="store_true",
                    help="Emit structured JSON instead of text summary")
    ap.add_argument("--ab", action="store_true",
                    help="A/B mode: expect two logs (baseline, cached)")
    ap.add_argument("--top", type=int, default=15,
                    help="How many slowest batches to show (default 15)")
    args = ap.parse_args()

    summaries = [parse_log(p) for p in args.logs]

    if args.json:
        out = [
            {
                **asdict(s),
                "batches": [asdict(b) for b in s.batches],
            }
            for s in summaries
        ]
        print(json.dumps(out, indent=2))
        return

    for s in summaries:
        print(render_summary(s, top_n=args.top))
        print()

    if args.ab:
        if len(summaries) != 2:
            print("ERROR: --ab expects exactly two logs (baseline first, cached second)",
                  file=sys.stderr)
            sys.exit(2)
        print(render_ab(summaries[0], summaries[1]))


if __name__ == "__main__":
    main()
